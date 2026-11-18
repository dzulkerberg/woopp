import {
  BatchExportManifest,
  PlateStlExportInputPlate,
  StlBedProfile,
  StlExportProgressEvent,
  StlExportValidationResult,
  StlMeshBounds,
  StlModelAssetEntry,
} from '../types';
import {
  BatchZipExportParams,
  exportBatchPlatesZip,
  exportSinglePlateStl,
  SinglePlateStlExportParams,
} from '../utils/stlExportEngine';
import type { StlWorkerRequest, StlWorkerResponse } from '../workers/stlExport.worker';

export interface SinglePlateWorkerOutput {
  fileName: string;
  plateCode: string;
  stlBytes: Uint8Array;
  plateNumber: number;
  keycapCount: number;
  triangleCount: number;
  bounds: StlMeshBounds;
  letterBreakdown: Record<string, number>;
  validation: StlExportValidationResult;
  modelRevision: string;
}

export interface BatchZipWorkerOutput {
  zipFileName: string;
  folderName: string;
  zipBytes: Uint8Array;
  manifest: BatchExportManifest;
  warnings: string[];
}

function executeInWorker<T>(
  request: StlWorkerRequest,
  onProgress?: (event: StlExportProgressEvent) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    let worker: Worker | null = null;
    try {
      worker = new Worker(
        new URL('../workers/stlExport.worker.ts', import.meta.url),
        { type: 'module' }
      );
    } catch (initErr) {
      reject(initErr);
      return;
    }

    const cleanup = () => {
      if (worker) {
        worker.terminate();
        worker = null;
      }
    };

    worker.onmessage = (ev: MessageEvent<StlWorkerResponse>) => {
      const data = ev.data;
      if (!data || data.id !== request.id) return;

      if (data.type === 'progress') {
        onProgress?.(data.event);
        return;
      }
      if (data.type === 'error') {
        cleanup();
        reject(new Error(data.error));
        return;
      }
      if (data.type === 'single_plate_result' || data.type === 'batch_zip_result') {
        cleanup();
        resolve(data.result as T);
      }
    };

    worker.onerror = (err) => {
      cleanup();
      reject(new Error(err.message || 'STL export worker encountered an unexpected error.'));
    };

    // Clone buffers via structured clone (never transfer persisted source buffers out of main thread cache)
    worker.postMessage(request);
  });
}

/**
 * Generates ONE complete binary STL for a single plate using a dedicated Web Worker
 * in browsers (non-blocking UI) with direct async fallback in headless test environments.
 */
export async function runSinglePlateStlExport(
  params: SinglePlateStlExportParams
): Promise<SinglePlateWorkerOutput> {
  if (typeof Worker !== 'undefined') {
    const id = `stl-single-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    return executeInWorker<SinglePlateWorkerOutput>(
      {
        id,
        kind: 'single_plate',
        plate: params.plate,
        assetsByLetter: params.assetsByLetter,
        bedProfile: params.bedProfile,
      },
      params.onProgress
    );
  }

  const direct = await exportSinglePlateStl(params);
  return {
    fileName: direct.fileName,
    plateCode: direct.plateCode,
    stlBytes: direct.stlBytes,
    plateNumber: direct.plateNumber,
    keycapCount: direct.keycapCount,
    triangleCount: direct.triangleCount,
    bounds: direct.bounds,
    letterBreakdown: direct.letterBreakdown,
    validation: direct.validation,
    modelRevision: direct.modelRevision,
  };
}

/**
 * Generates ALL complete plate STLs + `manifest.json` inside ONE batch ZIP archive
 * using a dedicated Web Worker in browsers with direct async fallback in tests.
 */
export async function runBatchZipStlExport(
  params: BatchZipExportParams
): Promise<BatchZipWorkerOutput> {
  if (typeof Worker !== 'undefined') {
    const id = `stl-zip-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    return executeInWorker<BatchZipWorkerOutput>(
      {
        id,
        kind: 'batch_zip',
        batchId: params.batchId,
        productionDate: params.productionDate,
        projectId: params.projectId,
        projectName: params.projectName,
        productName: params.productName,
        baseColour: params.baseColour,
        letterColourNote: params.letterColourNote,
        plates: params.plates,
        assetsByLetter: params.assetsByLetter,
        bedProfile: params.bedProfile,
      },
      params.onProgress
    );
  }

  const direct = await exportBatchPlatesZip(params);
  return {
    zipFileName: direct.zipFileName,
    folderName: direct.folderName,
    zipBytes: direct.zipBytes,
    manifest: direct.manifest,
    warnings: direct.warnings,
  };
}

/**
 * Triggers a clean browser file download for a binary `Uint8Array` blob.
 */
export function triggerBinaryFileDownload(
  bytes: Uint8Array,
  fileName: string,
  mimeType: string
): void {
  const safeCopy = new Uint8Array(bytes.byteLength);
  safeCopy.set(bytes);
  const blob = new Blob([safeCopy.buffer], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/**
 * Extracts raw assets map for only the letters needed by a batch of plates.
 */
export async function loadRequiredStlAssetsMap(params: {
  getAssetsByLetters: (letters: readonly string[]) => Promise<Record<string, StlModelAssetEntry>>;
  plates: readonly PlateStlExportInputPlate[];
  bedProfile?: StlBedProfile;
}): Promise<Record<string, StlModelAssetEntry>> {
  const needed = new Set<string>();
  for (const plate of params.plates) {
    for (const [k, rawQty] of Object.entries(plate.letters)) {
      if (Math.floor(Number(rawQty || 0)) > 0) {
        needed.add(k.trim().toUpperCase());
      }
    }
  }
  return params.getAssetsByLetters(Array.from(needed).sort());
}
