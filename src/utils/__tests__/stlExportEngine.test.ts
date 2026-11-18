import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import {
  computeLibraryModelRevision,
  createInMemoryStlLibraryRepository,
  matchLetterFromStlFileName,
  validateAndPrepareStlAsset,
} from '../../services/stlLibraryStorage';
import {
  runBatchZipStlExport,
  runSinglePlateStlExport,
} from '../../services/stlExportWorkerClient';
import { ColorOption, ProductionWorkspaceV5, StlModelAssetEntry } from '../../types';
import { generateIndependentKeycapBatchPreviews } from '../catalogPlannerEngine';
import { commitGeneratedPlatesToWorkspace } from '../productionEngine';
import { buildPlateLetterPlacements } from '../plateStlLayout';
import * as stlBinaryEngine from '../stlBinaryEngine';
import { parseAndValidateStlBuffer } from '../stlBinaryEngine';
import { exportBatchPlatesZip } from '../stlExportEngine';

function appendBoxTriangles(
  out: number[],
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  minZ: number,
  maxZ: number
) {
  const pushTri = (
    nx: number,
    ny: number,
    nz: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number
  ) => {
    out.push(nx, ny, nz, ax, ay, az, bx, by, bz, cx, cy, cz);
  };

  // Bottom (z = minZ, normal -Z)
  pushTri(0, 0, -1, minX, minY, minZ, maxX, maxY, minZ, maxX, minY, minZ);
  pushTri(0, 0, -1, minX, minY, minZ, minX, maxY, minZ, maxX, maxY, minZ);
  // Top (z = maxZ, normal +Z)
  pushTri(0, 0, 1, minX, minY, maxZ, maxX, minY, maxZ, maxX, maxY, maxZ);
  pushTri(0, 0, 1, minX, minY, maxZ, maxX, maxY, maxZ, minX, maxY, maxZ);
  // Front (y = minY, normal -Y)
  pushTri(0, -1, 0, minX, minY, minZ, maxX, minY, minZ, maxX, minY, maxZ);
  pushTri(0, -1, 0, minX, minY, minZ, maxX, minY, maxZ, minX, minY, maxZ);
  // Back (y = maxY, normal +Y)
  pushTri(0, 1, 0, minX, maxY, minZ, maxX, maxY, maxZ, maxX, maxY, minZ);
  pushTri(0, 1, 0, minX, maxY, minZ, minX, maxY, maxZ, maxX, maxY, maxZ);
  // Left (x = minX, normal -X)
  pushTri(-1, 0, 0, minX, minY, minZ, minX, minY, maxZ, minX, maxY, maxZ);
  pushTri(-1, 0, 0, minX, minY, minZ, minX, maxY, maxZ, minX, maxY, minZ);
  // Right (x = maxX, normal +X)
  pushTri(1, 0, 0, maxX, minY, minZ, maxX, maxY, maxZ, maxX, minY, maxZ);
  pushTri(1, 0, 0, maxX, minY, minZ, maxX, maxY, minZ, maxX, maxY, maxZ);
}

/**
 * Builds an authentic binary STL keycap fixture:
 * - Keycap base body (18.0 x 18.0 x 7.5 mm, Z: [0.0 .. 7.5])
 * - Raised embossed letter relief (8.0 x 10.0 x 1.3 mm, Z: [7.5 .. 8.8])
 * Stored together in ONE unified keycap STL mesh (24 triangles = 1,284 bytes).
 */
function createAuthenticKeycapBinaryStlBuffer(options?: {
  widthMm?: number;
  depthMm?: number;
  baseHeightMm?: number;
  letterHeightMm?: number;
}): ArrayBuffer {
  const widthMm = options?.widthMm ?? 18.0;
  const depthMm = options?.depthMm ?? 18.0;
  const baseHeightMm = options?.baseHeightMm ?? 7.5;
  const letterHeightMm = options?.letterHeightMm ?? 1.3;

  const tris: number[] = [];
  appendBoxTriangles(
    tris,
    -widthMm / 2,
    widthMm / 2,
    -depthMm / 2,
    depthMm / 2,
    0,
    baseHeightMm
  );
  appendBoxTriangles(
    tris,
    -4.0,
    4.0,
    -5.0,
    5.0,
    baseHeightMm,
    baseHeightMm + letterHeightMm
  );

  const triCount = tris.length / 12;
  const bytes = new Uint8Array(84 + triCount * 50);
  const view = new DataView(bytes.buffer);
  const hdr = 'Authentic Keycap Master Fixture';
  for (let i = 0; i < hdr.length; i += 1) {
    bytes[i] = hdr.charCodeAt(i);
  }
  view.setUint32(80, triCount, true);

  let offset = 84;
  for (let t = 0; t < triCount; t += 1) {
    const i = t * 12;
    for (let f = 0; f < 12; f += 1) {
      view.setFloat32(offset + f * 4, tris[i + f], true);
    }
    view.setUint16(offset + 48, 0, true);
    offset += 50;
  }
  return bytes.buffer;
}

function buildTestWorkspaceWithMatcha(): {
  workspace: ProductionWorkspaceV5;
  projectId: string;
  matchaColorId: string;
} {
  const matcha: ColorOption = {
    id: 'col-matcha',
    name: 'Matcha',
    hex: '#a7c957',
  };
  const nowIso = '2026-11-17T08:00:00.000Z';
  const ws: ProductionWorkspaceV5 = {
    schemaVersion: 5,
    ownerId: 'admin-owner',
    migratedFromV1: false,
    colors: [matcha],
    machines: [],
    projects: [
      {
        id: 'proj-test-stl',
        name: 'Klebang Batch Test',
        salesChannel: 'Klebang Walk',
        priority: 'Normal',
        deadline: '',
        productType: '3D Clicker Keycap',
        plateCapacity: 138,
        assignedColorIds: [matcha.id],
        targetsByColor: {},
        carryForwardByColor: {},
        allocatedStockByColor: {},
        status: 'Active',
        notes: '',
        createdIso: nowIso,
        updatedIso: nowIso,
      },
    ],
    jobs: [],
    presets: [],
    inventory: {
      physicalByColor: {},
      wastageByColor: {},
      movements: [],
    },
    log: [],
    settings: {
      defaultPlateCapacity: 138,
      defaultProductType: '3D Clicker Keycap',
      theme: 'light',
    },
    updatedIso: nowIso,
  };
  return { workspace: ws, projectId: 'proj-test-stl', matchaColorId: matcha.id };
}

describe('Fast STL Export Engine & Admin STL Model Library', () => {
  it('validates and persists authentic keycap-char-A..Z.stl models cleanly without modifying original geometry', async () => {
    const bufferP = createAuthenticKeycapBinaryStlBuffer();
    const prep = await validateAndPrepareStlAsset({
      fileName: 'keycap-char-P.stl',
      buffer: bufferP,
      uploadedBy: 'hellodzul@gmail.com',
      uploadedAt: '2026-11-17T09:00:00.000Z',
    });
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;

    expect(prep.entry.record.letter).toBe('P');
    expect(prep.entry.record.triangleCount).toBe(24);
    expect(prep.entry.record.format).toBe('binary');
    expect(prep.entry.record.bounds.widthMm).toBeCloseTo(18.0, 2);
    expect(prep.entry.record.bounds.depthMm).toBeCloseTo(18.0, 2);
    expect(prep.entry.record.bounds.heightMm).toBeCloseTo(8.8, 2);
    // Top face of base body sits at Z=7.5 mm where raised letter relief begins
    expect(prep.entry.record.bounds.estimatedLetterStartZMm).toBeCloseTo(7.5, 2);

    // Persistence round-trip
    const repo = createInMemoryStlLibraryRepository();
    await repo.putAsset('admin-owner', prep.entry);
    const loaded = await repo.getByOwnerAndLetters('admin-owner', ['P']);
    expect(loaded.P).toBeDefined();
    expect(loaded.P.buffer.byteLength).toBe(bufferP.byteLength);
    expect(loaded.P.record.sha256).toBe(prep.entry.record.sha256);

    // Filename matching helper checks
    expect(matchLetterFromStlFileName('keycap-char-A.stl')).toBe('A');
    expect(matchLetterFromStlFileName('KEYCAP-CHAR-z.STL')).toBe('Z');
    expect(matchLetterFromStlFileName('random-keycap.stl')).toBeNull();
  });

  it('rejects corrupt, truncated, or non-STL uploads with clear errors', async () => {
    const nonStl = await validateAndPrepareStlAsset({
      fileName: 'keycap-char-P.obj',
      buffer: new ArrayBuffer(128),
    });
    expect(nonStl.ok).toBe(false);

    const emptyStl = await validateAndPrepareStlAsset({
      fileName: 'keycap-char-P.stl',
      buffer: new ArrayBuffer(0),
    });
    expect(emptyStl.ok).toBe(false);

    const truncatedStl = await validateAndPrepareStlAsset({
      fileName: 'keycap-char-P.stl',
      buffer: new ArrayBuffer(40),
    });
    expect(truncatedStl.ok).toBe(false);
  });

  it('exports 138 copies of keycap-char-P.stl into ONE complete parseable unified STL file', async () => {
    const { workspace, projectId, matchaColorId } = buildTestWorkspaceWithMatcha();
    const batchPreview = generateIndependentKeycapBatchPreviews({
      existingJobs: workspace.jobs,
      projectId,
      mode: 'alphabet_only',
      batchLetters: { P: 138 },
      capacity: 138,
      defaultMinutesPerPlate: 195,
    });

    expect(batchPreview.fullPlates).toHaveLength(1);
    expect(batchPreview.remainderCount).toBe(0);

    const bufferP = createAuthenticKeycapBinaryStlBuffer();
    const prepP = await validateAndPrepareStlAsset({
      fileName: 'keycap-char-P.stl',
      buffer: bufferP,
    });
    if (!prepP.ok) throw new Error(prepP.error);

    const result = await runSinglePlateStlExport({
      plate: {
        plateNumber: batchPreview.fullPlates[0].plateNumber,
        plateCode: 'K7M2Q',
        capacity: 138,
        letters: batchPreview.fullPlates[0].letters,
        colorId: matchaColorId,
        colorName: 'Matcha',
        colorHex: '#a7c957',
      },
      assetsByLetter: { P: prepP.entry },
    });

    expect(result.fileName).toBe('WP-K7M2Q.stl');
    expect(result.plateCode).toBe('K7M2Q');
    expect(result.keycapCount).toBe(138);
    expect(result.triangleCount).toBe(138 * 24);
    expect(result.validation.valid).toBe(true);
    // 138-keycap dense bed layout warns operator about tight prime tower clearance
    expect(result.validation.warnings.length).toBeGreaterThan(0);

    // Re-parse exported STL output cleanly using STLLoader validator
    const reparsedBytes = new Uint8Array(result.stlBytes.byteLength);
    reparsedBytes.set(result.stlBytes);
    const reparsed = parseAndValidateStlBuffer({
      buffer: reparsedBytes.buffer,
      letter: 'PLATE',
      fileName: result.fileName,
    });

    expect(reparsed.format).toBe('binary');
    expect(reparsed.triangleCount).toBe(138 * 24);
    expect(reparsed.bounds.minZ).toBeCloseTo(0, 2);
    expect(reparsed.bounds.maxZ).toBeCloseTo(8.8, 2);
    expect(reparsed.bounds.minX).toBeGreaterThanOrEqual(0);
    expect(reparsed.bounds.maxX).toBeLessThanOrEqual(256);
    expect(reparsed.bounds.minY).toBeGreaterThanOrEqual(0);
    expect(reparsed.bounds.maxY).toBeLessThanOrEqual(256);
  });

  it('keeps 1 batch ID across 3 plates (414 keycaps) and exports valid ZIP with manifest.json and 3 parseable plate STLs', async () => {
    const { workspace, projectId, matchaColorId } = buildTestWorkspaceWithMatcha();

    // 414 keycaps = exactly 3 plates of 138 keycaps each
    const requestedLetters = { P: 200, A: 114, E: 100 };
    const batchPreview = generateIndependentKeycapBatchPreviews({
      existingJobs: workspace.jobs,
      projectId,
      mode: 'alphabet_only',
      batchLetters: requestedLetters,
      capacity: 138,
      defaultMinutesPerPlate: 195,
    });

    expect(batchPreview.fullPlates).toHaveLength(3);
    expect(batchPreview.remainderCount).toBe(0);

    const plateCodes = ['K7M2Q', 'R4T9P', 'X2N6V'];
    const commitRes = commitGeneratedPlatesToWorkspace(workspace, {
      projectId,
      colorId: matchaColorId,
      plateCapacity: 138,
      mode: 'alphabet_only',
      targetLetters: requestedLetters,
      targetCharms: {},
      carryForwardLetters: {},
      carryForwardCharms: {},
      requestedBatchLetters: requestedLetters,
      confirmedPlates: batchPreview.fullPlates.map((p, idx) => ({
        ...p,
        plateCode: plateCodes[idx],
      })),
      preserveQueuedPlates: true,
      nowMs: 1731840000000,
    });

    expect(commitRes.error).toBeUndefined();
    expect(commitRes.createdJobs).toHaveLength(3);
    const createdJobs = commitRes.createdJobs!;

    // CRITICAL BUSINESS RULE: 414 keycaps across 3 plates MUST share 1 single Batch ID (never 3 batches)
    const distinctBatchIds = new Set(createdJobs.map((j) => j.batchId));
    expect(distinctBatchIds.size).toBe(1);
    const batchId = createdJobs[0].batchId!;

    const assetsByLetter: Record<string, StlModelAssetEntry> = {};
    for (const ch of ['A', 'E', 'P']) {
      const prep = await validateAndPrepareStlAsset({
        fileName: `keycap-char-${ch}.stl`,
        buffer: createAuthenticKeycapBinaryStlBuffer(),
      });
      if (!prep.ok) throw new Error(prep.error);
      assetsByLetter[ch] = prep.entry;
    }

    // Verify each unique letter asset STL is parsed only ONCE across all 3 plates
    const parseSpy = vi.spyOn(stlBinaryEngine, 'parseAndValidateStlBuffer');

    const zipOut = await runBatchZipStlExport({
      batchId,
      productionDate: '2026-11-17',
      projectId,
      projectName: 'Klebang Batch Test',
      productName: '3D Clicker Keycap',
      baseColour: {
        id: matchaColorId,
        name: 'Matcha',
        hex: '#a7c957',
      },
      plates: createdJobs.map((j) => ({
        plateNumber: j.plateNumber,
        plateCode: j.plateCode,
        capacity: j.plateCapacity,
        letters: j.letters,
        colorId: matchaColorId,
        colorName: 'Matcha',
        colorHex: '#a7c957',
      })),
      assetsByLetter,
    });

    // Only A, E, P = 3 unique calls to parseAndValidateStlBuffer across 414 total keycaps!
    expect(parseSpy).toHaveBeenCalledTimes(3);
    parseSpy.mockRestore();

    expect(zipOut.zipFileName).toBe('batch-414-matcha.zip');
    expect(zipOut.folderName).toBe('batch-414-matcha');

    // Load binary ZIP back with JSZip and validate every file inside
    const loadedZip = await JSZip.loadAsync(zipOut.zipBytes);
    const expectedFiles = [
      'batch-414-matcha/WP-K7M2Q.stl',
      'batch-414-matcha/WP-R4T9P.stl',
      'batch-414-matcha/WP-X2N6V.stl',
      'batch-414-matcha/manifest.json',
    ];
    for (const filePath of expectedFiles) {
      expect(loadedZip.file(filePath)).not.toBeNull();
    }

    // Validate manifest.json contents
    const manifestJson = await loadedZip
      .file('batch-414-matcha/manifest.json')!
      .async('string');
    const parsedManifest = JSON.parse(manifestJson);
    expect(parsedManifest.batchId).toBe(batchId);
    expect(parsedManifest.productionDate).toBe('2026-11-17');
    expect(parsedManifest.baseColour.name).toBe('Matcha');
    expect(parsedManifest.letterColour).toContain('STL does not encode AMS colour');
    expect(parsedManifest.plateNumbers).toEqual([1, 2, 3]);
    expect(parsedManifest.plateCount).toBe(3);
    expect(parsedManifest.totalKeycapCount).toBe(414);
    expect(parsedManifest.letterBreakdown).toEqual({ P: 200, A: 114, E: 100 });
    expect(parsedManifest.modelRevision).toBe(
      computeLibraryModelRevision(Object.values(assetsByLetter).map((a) => a.record))
    );

    // Re-parse every binary plate STL extracted from the ZIP
    for (const plateFile of [
      'batch-414-matcha/WP-K7M2Q.stl',
      'batch-414-matcha/WP-R4T9P.stl',
      'batch-414-matcha/WP-X2N6V.stl',
    ]) {
      const ab = await loadedZip.file(plateFile)!.async('arraybuffer');
      const parsedPlate = parseAndValidateStlBuffer({
        buffer: ab,
        letter: 'PLATE',
        fileName: plateFile,
      });
      expect(parsedPlate.triangleCount).toBe(138 * 24);
      expect(parsedPlate.bounds.minZ).toBeCloseTo(0, 2);
      expect(parsedPlate.bounds.maxZ).toBeCloseTo(8.8, 2);
    }
  });

  it('rejects export cleanly when any required letter STL is missing or when keycap XY footprint collides', async () => {
    const prepA = await validateAndPrepareStlAsset({
      fileName: 'keycap-char-A.stl',
      buffer: createAuthenticKeycapBinaryStlBuffer(),
    });
    if (!prepA.ok) throw new Error(prepA.error);

    // Missing letter Z
    await expect(
      exportBatchPlatesZip({
        batchId: 'batch-missing-test',
        productionDate: '2026-11-17',
        projectId: 'p1',
        projectName: 'Proj',
        productName: 'Keycap',
        baseColour: { id: 'c1', name: 'Matcha', hex: '#a7c957' },
        plates: [
          {
            plateNumber: 1,
            plateCode: 'K7M2Q',
            capacity: 138,
            letters: { A: 5, Z: 2 },
          },
        ],
        assetsByLetter: { A: prepA.entry },
      })
    ).rejects.toThrow(/keycap-char-Z\.stl/i);

    // Missing Plate ID MUST be rejected cleanly instead of falling back to plate-01-complete.stl
    await expect(
      runSinglePlateStlExport({
        plate: {
          plateNumber: 1,
          capacity: 138,
          letters: { A: 4 },
        },
        assetsByLetter: { A: prepA.entry },
      })
    ).rejects.toThrow(/Plate ID/i);

    // Oversized keycap (22mm x 22mm on 19.2mm pitch) MUST fail overlap validation instead of silently rearranging
    const oversizedPrep = await validateAndPrepareStlAsset({
      fileName: 'keycap-char-O.stl',
      buffer: createAuthenticKeycapBinaryStlBuffer({ widthMm: 22.0, depthMm: 22.0 }),
    });
    if (!oversizedPrep.ok) throw new Error(oversizedPrep.error);

    const placements = buildPlateLetterPlacements({ O: 4 });
    expect(placements).toHaveLength(4);

    await expect(
      runSinglePlateStlExport({
        plate: {
          plateNumber: 1,
          plateCode: 'H8V3C',
          capacity: 138,
          letters: { O: 4 },
          placements,
        },
        assetsByLetter: { O: oversizedPrep.entry },
      })
    ).rejects.toThrow(/collision|overlap/i);
  });
});
