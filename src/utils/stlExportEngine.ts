import JSZip from 'jszip';
import { ABC, compactLettersMap, countLetters, sumAlphabetMaps } from '../constants';
import { computeLibraryModelRevision } from '../services/stlLibraryStorage';
import {
  BatchExportManifest,
  BatchExportManifestPlateEntry,
  LettersMap,
  PlateStlExportInputPlate,
  StlBedProfile,
  StlExportProgressEvent,
  StlExportValidationResult,
  StlMeshBounds,
  StlModelAssetEntry,
} from '../types';
import {
  buildPlateLetterPlacements,
  DEFAULT_BAMBU_BED_PROFILE,
} from './plateStlLayout';
import {
  formatWpPlateStlFilename,
  normalizePlateCode,
} from './plateIdGenerator';
import {
  buildUnifiedPlateBinaryStl,
  ParsedStlMesh,
  parseAndValidateStlBuffer,
  validatePlatePlacementGeometry,
} from './stlBinaryEngine';

export interface SinglePlateStlExportParams {
  plate: PlateStlExportInputPlate;
  assetsByLetter: Record<string, StlModelAssetEntry>;
  bedProfile?: StlBedProfile;
  meshCache?: Map<string, ParsedStlMesh>;
  onProgress?: (event: StlExportProgressEvent) => void;
}

export interface SinglePlateStlExportResult {
  fileName: string;
  plateCode: string;
  stlBytes: Uint8Array;
  plateNumber: number;
  keycapCount: number;
  triangleCount: number;
  bounds: StlMeshBounds;
  letterBreakdown: LettersMap;
  validation: StlExportValidationResult;
  modelRevision: string;
}

export interface BatchZipExportParams {
  batchId: string;
  productionDate: string;
  projectId: string;
  projectName: string;
  productName: string;
  baseColour: {
    id: string | null;
    name: string;
    hex: string | null;
  };
  letterColourNote?: string;
  plates: readonly PlateStlExportInputPlate[];
  assetsByLetter: Record<string, StlModelAssetEntry>;
  bedProfile?: StlBedProfile;
  onProgress?: (event: StlExportProgressEvent) => void;
}

export interface BatchZipExportResult {
  zipFileName: string;
  folderName: string;
  zipBytes: Uint8Array;
  manifest: BatchExportManifest;
  plateResults: SinglePlateStlExportResult[];
  warnings: string[];
}

export function sanitizeExportSlug(raw: string, fallback = 'batch'): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

export function formatPlateCompleteStlFilename(
  plateNumber: number,
  plateCode?: string | null
): string {
  const cleanCode = normalizePlateCode(plateCode);
  if (cleanCode) {
    return formatWpPlateStlFilename(cleanCode);
  }
  const padded = String(Math.max(1, Math.floor(plateNumber))).padStart(2, '0');
  return `plate-${padded}-complete.stl`;
}

export function resolveRequiredPlateStlFilename(plate: {
  plateNumber: number;
  plateCode?: string | null;
}): { plateCode: string; fileName: string } {
  const cleanCode = normalizePlateCode(plate.plateCode);
  if (!cleanCode) {
    throw new Error(
      `Plate ${plate.plateNumber} requires a reserved 5-character Plate ID before STL export.`
    );
  }
  return {
    plateCode: cleanCode,
    fileName: formatWpPlateStlFilename(cleanCode),
  };
}

export function formatBatchArchiveBaseName(params: {
  totalKeycapCount: number;
  baseColorName?: string | null;
}): string {
  const qty = Math.max(0, Math.floor(params.totalKeycapCount));
  const colorSlug = sanitizeExportSlug(params.baseColorName || 'unassigned', 'color');
  return `batch-${qty}-${colorSlug}`;
}

/**
 * Parses all required unique letter STL assets once into a shared Map cache so exporting
 * 138 or 414+ keycaps never re-parses any letter mesh more than once.
 */
export function hydrateMeshCacheForPlates(
  plates: readonly PlateStlExportInputPlate[],
  assetsByLetter: Record<string, StlModelAssetEntry>,
  existingCache?: Map<string, ParsedStlMesh>
): {
  meshCache: Map<string, ParsedStlMesh>;
  missingLetters: string[];
} {
  const meshCache = existingCache || new Map<string, ParsedStlMesh>();
  const neededLetters = new Set<string>();

  for (const plate of plates) {
    for (const [k, rawQty] of Object.entries(plate.letters)) {
      if (Math.floor(Number(rawQty || 0)) > 0) {
        neededLetters.add(k.trim().toUpperCase());
      }
    }
    if (plate.placements) {
      for (const pl of plate.placements) {
        neededLetters.add(pl.letter.trim().toUpperCase());
      }
    }
  }

  const missingLetters: string[] = [];
  const sortedLetters = Array.from(neededLetters).sort();

  for (const letter of sortedLetters) {
    if (meshCache.has(letter)) continue;
    const asset = assetsByLetter[letter];
    if (!asset || !asset.buffer || asset.buffer.byteLength === 0) {
      missingLetters.push(letter);
      continue;
    }
    const parsed = parseAndValidateStlBuffer({
      buffer: asset.buffer,
      letter,
      fileName: asset.record.fileName,
    });
    meshCache.set(letter, parsed);
  }

  return { meshCache, missingLetters };
}

/**
 * Generates ONE complete binary STL file for a single Auto Plate Planner plate.
 */
export async function exportSinglePlateStl(
  params: SinglePlateStlExportParams
): Promise<SinglePlateStlExportResult> {
  const bedProfile = params.bedProfile || DEFAULT_BAMBU_BED_PROFILE;
  const { plate, assetsByLetter, onProgress } = params;
  const { plateCode, fileName } = resolveRequiredPlateStlFilename(plate);

  onProgress?.({
    phase: 'parsing_meshes',
    completedPlates: 0,
    totalPlates: 1,
    currentPlateNumber: plate.plateNumber,
    percent: 15,
    message: `Caching STL geometries for WP-${plateCode}...`,
  });

  const { meshCache, missingLetters } = hydrateMeshCacheForPlates(
    [plate],
    assetsByLetter,
    params.meshCache
  );

  if (missingLetters.length > 0) {
    const missingNames = missingLetters.map((l) => `keycap-char-${l}.stl`).join(', ');
    throw new Error(
      `Cannot generate STL for Plate ${plate.plateNumber}: missing authentic STL model(s) in STL Model Library (${missingNames}).`
    );
  }

  onProgress?.({
    phase: 'validating',
    completedPlates: 0,
    totalPlates: 1,
    currentPlateNumber: plate.plateNumber,
    percent: 45,
    message: `Validating ${countLetters(plate.letters)} keycap placements on Plate ${plate.plateNumber}...`,
  });

  // Always preserve exact Auto Plate Planner composition & coordinates (never rearrange silently)
  const placements =
    plate.placements && plate.placements.length > 0
      ? plate.placements
      : buildPlateLetterPlacements(plate.letters, bedProfile);

  const validation = validatePlatePlacementGeometry({
    plateNumber: plate.plateNumber,
    letters: plate.letters,
    placements,
    meshesByLetter: meshCache,
    bedProfile,
  });

  if (!validation.valid) {
    throw new Error(validation.errors.join(' '));
  }

  onProgress?.({
    phase: 'building_stl',
    completedPlates: 0,
    totalPlates: 1,
    currentPlateNumber: plate.plateNumber,
    percent: 75,
    message: `Concatenating ${placements.length} complete keycaps into ONE binary STL for Plate ${plate.plateNumber}...`,
  });

  const built = buildUnifiedPlateBinaryStl({
    plateNumber: plate.plateNumber,
    headerComment: `WOOPP WP-${plateCode} Plate ${String(plate.plateNumber).padStart(2, '0')} (${placements.length} pcs)`,
    placements,
    meshesByLetter: meshCache,
  });

  // Post-build integrity check: exact binary byte size and triangle count
  const expectedByteSize = 84 + built.triangleCount * 50;
  if (built.stlBytes.byteLength !== expectedByteSize) {
    throw new Error(
      `Post-build binary STL verification failed on WP-${plateCode}: expected ${expectedByteSize} bytes, got ${built.stlBytes.byteLength}.`
    );
  }

  const usedRecords = Array.from(meshCache.keys())
    .map((letter) => assetsByLetter[letter]?.record)
    .filter((r): r is NonNullable<typeof r> => Boolean(r));
  const modelRevision = computeLibraryModelRevision(usedRecords);

  const cleanBreakdown: LettersMap = {};
  for (const letter of ABC) {
    const qty = Math.floor(Number(plate.letters[letter] || 0));
    if (qty > 0) cleanBreakdown[letter] = qty;
  }

  onProgress?.({
    phase: 'complete',
    completedPlates: 1,
    totalPlates: 1,
    currentPlateNumber: plate.plateNumber,
    percent: 100,
    message: `Generated ${fileName} (${placements.length} keycaps, ${built.triangleCount.toLocaleString()} triangles).`,
  });

  return {
    fileName,
    plateCode,
    stlBytes: built.stlBytes,
    plateNumber: plate.plateNumber,
    keycapCount: placements.length,
    triangleCount: built.triangleCount,
    bounds: built.bounds,
    letterBreakdown: cleanBreakdown,
    validation,
    modelRevision,
  };
}

/**
 * Generates ALL complete plate STL files + `manifest.json` under ONE unified Production Batch
 * folder inside a downloadable ZIP archive. Never treats any plate as a separate batch.
 */
export async function exportBatchPlatesZip(
  params: BatchZipExportParams
): Promise<BatchZipExportResult> {
  const bedProfile = params.bedProfile || DEFAULT_BAMBU_BED_PROFILE;
  const { plates, assetsByLetter, onProgress } = params;

  if (!params.batchId || !params.batchId.trim()) {
    throw new Error('Production Batch ID is required to generate batch STL archive.');
  }
  if (!plates || plates.length === 0) {
    throw new Error('No plates provided for batch STL ZIP export.');
  }

  const totalPlates = plates.length;
  const sharedMeshCache = new Map<string, ParsedStlMesh>();

  onProgress?.({
    phase: 'parsing_meshes',
    completedPlates: 0,
    totalPlates,
    percent: 10,
    message: `Parsing and caching authentic keycap STL models for ${totalPlates} plate(s)...`,
  });

  const { missingLetters } = hydrateMeshCacheForPlates(
    plates,
    assetsByLetter,
    sharedMeshCache
  );
  if (missingLetters.length > 0) {
    const missingNames = missingLetters.map((l) => `keycap-char-${l}.stl`).join(', ');
    throw new Error(
      `Cannot generate batch ZIP: missing authentic STL model(s) in STL Model Library (${missingNames}).`
    );
  }

  const plateResults: SinglePlateStlExportResult[] = [];
  const allWarnings = new Set<string>();

  for (let idx = 0; idx < totalPlates; idx += 1) {
    const plate = plates[idx];
    const platePct = 15 + Math.round(((idx + 0.5) / totalPlates) * 65);
    onProgress?.({
      phase: 'building_stl',
      completedPlates: idx,
      totalPlates,
      currentPlateNumber: plate.plateNumber,
      percent: platePct,
      message: `Building Plate ${plate.plateNumber} (${idx + 1} of ${totalPlates})...`,
    });

    const res = await exportSinglePlateStl({
      plate,
      assetsByLetter,
      bedProfile,
      meshCache: sharedMeshCache,
    });
    plateResults.push(res);
    for (const w of res.validation.warnings) {
      allWarnings.add(w);
    }
  }

  const totalKeycapCount = plateResults.reduce((sum, p) => sum + p.keycapCount, 0);
  const folderName = formatBatchArchiveBaseName({
    totalKeycapCount,
    baseColorName: params.baseColour.name,
  });

  const combinedLetterBreakdown = compactLettersMap(
    sumAlphabetMaps(plateResults.map((p) => p.letterBreakdown))
  );
  const usedRecords = Array.from(sharedMeshCache.keys())
    .map((letter) => assetsByLetter[letter]?.record)
    .filter((r): r is NonNullable<typeof r> => Boolean(r));
  const modelRevision = computeLibraryModelRevision(usedRecords);

  const notices: string[] = [
    'Binary STL files do not store AMS filament colour assignments. Set base filament colour and manual Z-height/layer pause for raised letters directly in Bambu Studio.',
    ...Array.from(allWarnings),
  ];

  const manifestPlates: BatchExportManifestPlateEntry[] = plateResults.map((p) => ({
    plateNumber: p.plateNumber,
    plateCode: p.plateCode,
    fileName: p.fileName,
    keycapCount: p.keycapCount,
    triangleCount: p.triangleCount,
    letterBreakdown: p.letterBreakdown,
    bounds: p.bounds,
  }));

  const manifest: BatchExportManifest = {
    schemaVersion: 1,
    batchId: params.batchId.trim(),
    productionDate: params.productionDate,
    projectId: params.projectId,
    projectName: params.projectName,
    productName: params.productName,
    baseColour: {
      id: params.baseColour.id,
      name: params.baseColour.name,
      hex: params.baseColour.hex,
    },
    letterColour:
      params.letterColourNote ||
      'Manual 2-colour filament swap (STL does not encode AMS colour)',
    plateNumbers: plateResults.map((p) => p.plateNumber),
    plateCount: plateResults.length,
    totalKeycapCount,
    letterBreakdown: combinedLetterBreakdown,
    modelRevision,
    bedProfile: {
      name: bedProfile.name,
      widthMm: bedProfile.widthMm,
      depthMm: bedProfile.depthMm,
      maxHeightMm: bedProfile.maxHeightMm,
    },
    plates: manifestPlates,
    notices,
  };

  onProgress?.({
    phase: 'packaging_zip',
    completedPlates: totalPlates,
    totalPlates,
    percent: 88,
    message: `Packaging ${totalPlates} complete STL plate(s) and manifest.json into ZIP...`,
  });

  const zip = new JSZip();
  const rootFolder = zip.folder(folderName);
  if (!rootFolder) {
    throw new Error(`Failed to initialize ZIP folder "${folderName}".`);
  }

  for (const res of plateResults) {
    rootFolder.file(res.fileName, res.stlBytes, { binary: true });
  }
  rootFolder.file('manifest.json', JSON.stringify(manifest, null, 2));

  const zipBytes = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 3 }, // Fast compression suitable for dense float32 binary STL data
  });

  onProgress?.({
    phase: 'complete',
    completedPlates: totalPlates,
    totalPlates,
    percent: 100,
    message: `Exported ${folderName}.zip (${totalPlates} plates, ${totalKeycapCount} keycaps).`,
  });

  return {
    zipFileName: `${folderName}.zip`,
    folderName,
    zipBytes,
    manifest,
    plateResults,
    warnings: Array.from(allWarnings),
  };
}
