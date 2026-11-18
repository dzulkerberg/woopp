import { Bambu3mfExportProgressEvent, StlBedProfile } from '../types';
import {
  BatchPlates3mfExportResult,
  exportBatchPlates3mf,
  exportSinglePlate3mf,
  Plate3mfInputPlate,
  SinglePlate3mfExportResult,
} from '../utils/bambu3mfEngine';

export type Bambu3mfWorkerRequest =
  | {
      id: string;
      kind: 'single_plate_3mf';
      plate: Plate3mfInputPlate;
      master3mfBuffer: ArrayBuffer;
      projectName?: string;
      bedProfile?: StlBedProfile;
    }
  | {
      id: string;
      kind: 'batch_plates_3mf';
      batchId: string;
      plates: Plate3mfInputPlate[];
      master3mfBuffer: ArrayBuffer;
      projectName?: string;
      bedProfile?: StlBedProfile;
    };

export type Bambu3mfWorkerResponse =
  | {
      id: string;
      type: 'progress';
      event: Bambu3mfExportProgressEvent;
    }
  | {
      id: string;
      type: 'single_plate_3mf_result';
      result: SinglePlate3mfExportResult;
    }
  | {
      id: string;
      type: 'batch_plates_3mf_result';
      result: BatchPlates3mfExportResult;
    }
  | {
      id: string;
      type: 'error';
      error: string;
    };

if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = async (ev: MessageEvent<Bambu3mfWorkerRequest>) => {
    const req = ev.data;
    if (!req || !req.id) return;

    const emitProgress = (event: Bambu3mfExportProgressEvent) => {
      const msg: Bambu3mfWorkerResponse = { id: req.id, type: 'progress', event };
      self.postMessage(msg);
    };

    try {
      if (req.kind === 'single_plate_3mf') {
        const result = await exportSinglePlate3mf({
          plate: req.plate,
          master3mfBuffer: req.master3mfBuffer,
          projectName: req.projectName,
          bedProfile: req.bedProfile,
          onProgress: emitProgress,
        });
        const okMsg: Bambu3mfWorkerResponse = {
          id: req.id,
          type: 'single_plate_3mf_result',
          result,
        };
        (self as unknown as { postMessage: (m: unknown, transfer?: Transferable[]) => void }).postMessage(
          okMsg,
          [result.threeMfBytes.buffer]
        );
        return;
      }

      if (req.kind === 'batch_plates_3mf') {
        const result = await exportBatchPlates3mf({
          batchId: req.batchId,
          plates: req.plates,
          master3mfBuffer: req.master3mfBuffer,
          projectName: req.projectName,
          bedProfile: req.bedProfile,
          onProgress: emitProgress,
        });
        const okMsg: Bambu3mfWorkerResponse = {
          id: req.id,
          type: 'batch_plates_3mf_result',
          result,
        };
        (self as unknown as { postMessage: (m: unknown, transfer?: Transferable[]) => void }).postMessage(
          okMsg,
          [result.threeMfBytes.buffer]
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errMsg: Bambu3mfWorkerResponse = {
        id: req.id,
        type: 'error',
        error: message,
      };
      self.postMessage(errMsg);
    }
  };
}
