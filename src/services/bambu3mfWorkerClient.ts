import { Bambu3mfExportProgressEvent, StlBedProfile } from '../types';
import {
  BatchPlates3mfExportResult,
  exportBatchPlates3mf,
  exportSinglePlate3mf,
  Plate3mfInputPlate,
  SinglePlate3mfExportResult,
} from '../utils/bambu3mfEngine';
import type {
  Bambu3mfWorkerRequest,
  Bambu3mfWorkerResponse,
} from '../workers/bambu3mfExport.worker';

function execute3mfWorker<T>(
  request: Bambu3mfWorkerRequest,
  onProgress?: (event: Bambu3mfExportProgressEvent) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    let worker: Worker | null = null;
    try {
      worker = new Worker(
        new URL('../workers/bambu3mfExport.worker.ts', import.meta.url),
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

    worker.onmessage = (ev: MessageEvent<Bambu3mfWorkerResponse>) => {
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
      if (
        data.type === 'single_plate_3mf_result' ||
        data.type === 'batch_plates_3mf_result'
      ) {
        cleanup();
        resolve(data.result as T);
      }
    };

    worker.onerror = (err) => {
      cleanup();
      reject(
        new Error(err.message || 'Bambu Studio 3MF worker encountered an unexpected error.')
      );
    };

    // Clone via structured clone so stored Master 3MF source buffer remains intact
    worker.postMessage(request);
  });
}

export async function runSinglePlate3mfExport(params: {
  plate: Plate3mfInputPlate;
  master3mfBuffer: ArrayBuffer;
  projectName?: string;
  bedProfile?: StlBedProfile;
  onProgress?: (event: Bambu3mfExportProgressEvent) => void;
}): Promise<SinglePlate3mfExportResult> {
  if (typeof Worker !== 'undefined') {
    const id = `3mf-single-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    return execute3mfWorker<SinglePlate3mfExportResult>(
      {
        id,
        kind: 'single_plate_3mf',
        plate: params.plate,
        master3mfBuffer: params.master3mfBuffer.slice(0),
        projectName: params.projectName,
        bedProfile: params.bedProfile,
      },
      params.onProgress
    );
  }

  return exportSinglePlate3mf(params);
}

export async function runBatchPlates3mfExport(params: {
  batchId: string;
  plates: readonly Plate3mfInputPlate[];
  master3mfBuffer: ArrayBuffer;
  projectName?: string;
  bedProfile?: StlBedProfile;
  onProgress?: (event: Bambu3mfExportProgressEvent) => void;
}): Promise<BatchPlates3mfExportResult> {
  if (typeof Worker !== 'undefined') {
    const id = `3mf-batch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    return execute3mfWorker<BatchPlates3mfExportResult>(
      {
        id,
        kind: 'batch_plates_3mf',
        batchId: params.batchId,
        plates: [...params.plates],
        master3mfBuffer: params.master3mfBuffer.slice(0),
        projectName: params.projectName,
        bedProfile: params.bedProfile,
      },
      params.onProgress
    );
  }

  return exportBatchPlates3mf(params);
}
