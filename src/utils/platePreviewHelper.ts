import { compactLettersMap, countLetters } from '../constants';
import {
  runBatchPlates3mfExport,
  runSinglePlate3mfExport,
} from '../services/bambu3mfWorkerClient';
import {
  loadRequiredStlAssetsMap,
  runSinglePlateStlExport,
  triggerBinaryFileDownload,
} from '../services/stlExportWorkerClient';
import {
  Bambu3mfExportProgressEvent,
  CharmsMap,
  JobCatalogItemSnapshot,
  LettersMap,
  Master3mfTemplateAsset,
  StlModelAssetEntry,
  StlModelAssetRecord,
} from '../types';
import { normalizePlateCode } from './plateIdGenerator';
import { ToastVariant } from '../components/ToastStack';

/**
 * Computes a deterministic composition signature for a staged preview plate.
 * Intentionally excludes mutable colour and verification flags so picking/changing
 * filament colour or toggling Bambu verification keeps the same reserved Plate ID.
 */
export function buildStagedPlateSignature(params: {
  projectId: string;
  slotIndex: number;
  plateNumber: number;
  capacity: number | null;
  letters?: LettersMap;
  charms?: CharmsMap;
  items?: readonly JobCatalogItemSnapshot[];
  generationNonce?: string;
}): string {
  const parts: string[] = [
    params.generationNonce || 'preview',
    params.projectId,
    String(params.slotIndex),
    String(params.plateNumber),
    String(params.capacity ?? 'unbounded'),
  ];

  if (params.letters) {
    const compacted = compactLettersMap(params.letters);
    const letterPairs = Object.entries(compacted)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`);
    if (letterPairs.length > 0) {
      parts.push(`L(${letterPairs.join(',')})`);
    }
  }

  if (params.charms) {
    const charmPairs = Object.entries(params.charms)
      .filter(([, v]) => Number(v) > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${Math.floor(Number(v))}`);
    if (charmPairs.length > 0) {
      parts.push(`C(${charmPairs.join(',')})`);
    }
  }

  if (params.items && params.items.length > 0) {
    const itemPairs = params.items
      .filter((it) => Math.floor(Number(it.quantity || 0)) > 0)
      .map(
        (it) =>
          `${it.productId}:${it.variantId || it.variantLabel || 'base'}:${Math.floor(Number(it.quantity))}`
      )
      .sort();
    if (itemPairs.length > 0) {
      parts.push(`I(${itemPairs.join(',')})`);
    }
  }

  return parts.join('|');
}

export async function exportSinglePreviewPlateStl(params: {
  plateNumber: number;
  plateCode: string | null | undefined;
  capacity: number;
  letters: LettersMap;
  colorId?: string | null;
  colorName?: string | null;
  colorHex?: string | null;
  productName?: string | null;
  recordsByLetter?: Record<string, StlModelAssetRecord>;
  getAssetsByLetters?: (
    letters: readonly string[]
  ) => Promise<Record<string, StlModelAssetEntry>>;
  ensurePlateCode?: () => Promise<string>;
  onToast?: (variant: ToastVariant, message: string) => void;
}): Promise<void> {
  const totalLetters = countLetters(params.letters);
  if (totalLetters <= 0) {
    params.onToast?.(
      'error',
      `Plate ${params.plateNumber} has no keycap letters (A–Z) to export.`
    );
    return;
  }

  if (!params.getAssetsByLetters) {
    params.onToast?.(
      'error',
      'STL Model Library is unavailable. Open Settings to configure keycap STL files.'
    );
    return;
  }

  const neededLetters = Object.entries(params.letters)
    .filter(([, v]) => Math.floor(Number(v || 0)) > 0)
    .map(([k]) => k.trim().toUpperCase())
    .sort();

  if (params.recordsByLetter) {
    const missingFromIndex = neededLetters.filter(
      (l) => !params.recordsByLetter?.[l]?.isValid
    );
    if (missingFromIndex.length > 0) {
      params.onToast?.(
        'error',
        `Missing STL model(s): ${missingFromIndex
          .map((l) => `keycap-char-${l}.stl`)
          .join(', ')}. Upload in Settings.`
      );
      return;
    }
  }

  try {
    let resolvedCode = normalizePlateCode(params.plateCode);
    if (!resolvedCode && params.ensurePlateCode) {
      resolvedCode = normalizePlateCode(await params.ensurePlateCode());
    }
    if (!resolvedCode) {
      params.onToast?.(
        'error',
        `Unable to reserve a unique Plate ID for Plate ${params.plateNumber}. Please try again.`
      );
      return;
    }

    const plateInput = {
      plateNumber: params.plateNumber,
      plateCode: resolvedCode,
      capacity: Math.max(1, params.capacity || totalLetters),
      letters: compactLettersMap(params.letters),
      colorId: params.colorId ?? null,
      colorName: params.colorName ?? null,
      colorHex: params.colorHex ?? null,
      productName: params.productName ?? null,
    };

    const assetsByLetter = await loadRequiredStlAssetsMap({
      getAssetsByLetters: params.getAssetsByLetters,
      plates: [plateInput],
    });

    const result = await runSinglePlateStlExport({
      plate: plateInput,
      assetsByLetter,
    });

    triggerBinaryFileDownload(result.stlBytes, result.fileName, 'model/stl');

    params.onToast?.(
      'success',
      `Exported ${result.fileName} (${result.keycapCount} keycaps · ${result.triangleCount.toLocaleString()} triangles).`
    );

    if (result.validation.warnings.length > 0) {
      for (const warningMsg of result.validation.warnings) {
        params.onToast?.('warning', `WP-${result.plateCode}: ${warningMsg}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    params.onToast?.('error', msg);
  }
}

export async function exportSinglePlate3mfAction(params: {
  plateNumber: number;
  plateCode: string | null | undefined;
  capacity: number;
  letters: LettersMap;
  colorId?: string | null;
  colorName?: string | null;
  colorHex?: string | null;
  productName?: string | null;
  projectName?: string;
  master3mfAsset?: Master3mfTemplateAsset | null;
  getMaster3mfAsset?: () => Promise<Master3mfTemplateAsset | null>;
  ensurePlateCode?: () => Promise<string>;
  onProgress?: (event: Bambu3mfExportProgressEvent) => void;
  onToast?: (variant: ToastVariant, message: string) => void;
}): Promise<void> {
  const totalLetters = countLetters(params.letters);
  if (totalLetters <= 0) {
    params.onToast?.(
      'error',
      `Plate ${params.plateNumber} has no keycap letters (A–Z) for .3MF export.`
    );
    return;
  }

  try {
    const asset =
      params.master3mfAsset ||
      (params.getMaster3mfAsset ? await params.getMaster3mfAsset() : null);

    if (!asset || !asset.buffer || asset.buffer.byteLength === 0) {
      params.onToast?.(
        'error',
        'No Bambu Studio Master .3MF template uploaded. Open Settings to upload your Master .3MF first.'
      );
      return;
    }

    let resolvedCode = normalizePlateCode(params.plateCode);
    if (!resolvedCode && params.ensurePlateCode) {
      resolvedCode = normalizePlateCode(await params.ensurePlateCode());
    }
    if (!resolvedCode) {
      params.onToast?.(
        'error',
        `Unable to preserve/reserve Plate ID for Plate ${params.plateNumber}. Please try again.`
      );
      return;
    }

    const result = await runSinglePlate3mfExport({
      plate: {
        plateNumber: params.plateNumber,
        plateCode: resolvedCode,
        capacity: Math.max(1, params.capacity || totalLetters),
        letters: compactLettersMap(params.letters),
        colorId: params.colorId ?? null,
        colorName: params.colorName ?? null,
        colorHex: params.colorHex ?? null,
        productName: params.productName ?? null,
      },
      master3mfBuffer: asset.buffer,
      projectName: params.projectName,
      onProgress: params.onProgress,
    });

    if (
      !result.audit?.valid ||
      !result.threeMfBytes ||
      result.threeMfBytes.byteLength === 0
    ) {
      const reason =
        result.audit?.errors?.join(' ') ||
        'Exported .3MF archive failed internal structural validation.';
      params.onToast?.('error', reason);
      return;
    }

    triggerBinaryFileDownload(
      result.threeMfBytes,
      result.fileName,
      'application/vnd.ms-package.3dmanufacturing-3dmodel+xml'
    );

    params.onToast?.(
      'success',
      `Exported ${result.fileName} (${result.plateSummary.keycapCount} keycaps).`
    );

    for (const w of result.warnings) {
      params.onToast?.('warning', `WP-${result.plateCode}: ${w}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    params.onToast?.('error', msg);
  }
}

export async function exportBatchPlates3mfAction(params: {
  batchId: string | null | undefined;
  plates: readonly {
    tempId?: string;
    plateNumber: number;
    plateCode?: string | null;
    capacity: number;
    letters: LettersMap;
    colorId?: string | null;
    colorName?: string | null;
    colorHex?: string | null;
    productName?: string | null;
  }[];
  projectName?: string;
  master3mfAsset?: Master3mfTemplateAsset | null;
  getMaster3mfAsset?: () => Promise<Master3mfTemplateAsset | null>;
  ensureAllPlateCodes?: () => Promise<Record<string, string>>;
  onProgress?: (event: Bambu3mfExportProgressEvent) => void;
  onToast?: (variant: ToastVariant, message: string) => void;
}): Promise<void> {
  const cleanBatchId = (params.batchId || '').trim();
  if (!cleanBatchId) {
    params.onToast?.('error', 'Batch ID is missing for multi-plate .3MF export.');
    return;
  }
  if (!params.plates || params.plates.length === 0) {
    params.onToast?.('error', 'Generate at least 1 plate before exporting .3MF.');
    return;
  }

  try {
    const asset =
      params.master3mfAsset ||
      (params.getMaster3mfAsset ? await params.getMaster3mfAsset() : null);

    if (!asset || !asset.buffer || asset.buffer.byteLength === 0) {
      params.onToast?.(
        'error',
        'No Bambu Studio Master .3MF template uploaded. Open Settings to upload your Master .3MF first.'
      );
      return;
    }

    let resolvedCodeMap: Record<string, string> = {};
    if (
      params.plates.some((p) => !normalizePlateCode(p.plateCode)) &&
      params.ensureAllPlateCodes
    ) {
      resolvedCodeMap = await params.ensureAllPlateCodes();
    }

    const inputPlates = params.plates.map((p) => {
      const total = countLetters(p.letters);
      if (total <= 0) {
        throw new Error(
          `Plate ${p.plateNumber} has no keycap letters (A–Z) for .3MF export.`
        );
      }
      const code =
        normalizePlateCode(p.plateCode) ||
        (p.tempId ? normalizePlateCode(resolvedCodeMap[p.tempId]) : null);
      if (!code) {
        throw new Error(
          `Plate ${p.plateNumber} is missing a unique Plate ID (WP-XXXXX).`
        );
      }
      return {
        plateNumber: p.plateNumber,
        plateCode: code,
        capacity: Math.max(1, p.capacity || total),
        letters: compactLettersMap(p.letters),
        colorId: p.colorId ?? null,
        colorName: p.colorName ?? null,
        colorHex: p.colorHex ?? null,
        productName: p.productName ?? null,
      };
    });

    const result = await runBatchPlates3mfExport({
      batchId: cleanBatchId,
      plates: inputPlates,
      master3mfBuffer: asset.buffer,
      projectName: params.projectName,
      onProgress: params.onProgress,
    });

    if (
      !result.audit?.valid ||
      !result.threeMfBytes ||
      result.threeMfBytes.byteLength === 0
    ) {
      const reason =
        result.audit?.errors?.join(' ') ||
        'Exported multi-plate .3MF archive failed internal structural validation.';
      params.onToast?.('error', reason);
      return;
    }

    triggerBinaryFileDownload(
      result.threeMfBytes,
      result.fileName,
      'application/vnd.ms-package.3dmanufacturing-3dmodel+xml'
    );

    params.onToast?.(
      'success',
      `Exported ${result.fileName} (${result.plateCount} plates · ${result.totalKeycapCount} keycaps).`
    );

    for (const w of result.warnings) {
      params.onToast?.('warning', w);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    params.onToast?.('error', msg);
  }
}

