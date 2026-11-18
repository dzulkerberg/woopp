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

export type StlWorkerRequest =
  | {
      id: string;
      kind: 'single_plate';
      plate: PlateStlExportInputPlate;
      assetsByLetter: Record<string, StlModelAssetEntry>;
      bedProfile?: StlBedProfile;
    }
  | {
      id: string;
      kind: 'batch_zip';
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
    };

export type StlWorkerResponse =
  | {
      id: string;
      type: 'progress';
      event: StlExportProgressEvent;
    }
  | {
      id: string;
      type: 'single_plate_result';
      result: {
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
      };
    }
  | {
      id: string;
      type: 'batch_zip_result';
      result: {
        zipFileName: string;
        folderName: string;
        zipBytes: Uint8Array;
        manifest: BatchExportManifest;
        warnings: string[];
      };
    }
  | {
      id: string;
      type: 'error';
      error: string;
    };

const ctx = globalThis as unknown as {
  onmessage: ((ev: MessageEvent<StlWorkerRequest>) => void) | null;
  postMessage: (message: StlWorkerResponse, transfer?: Transferable[]) => void;
};

ctx.onmessage = async (ev: MessageEvent<StlWorkerRequest>) => {
  const msg = ev.data;
  if (!msg || !msg.id) return;

  const onProgress = (event: StlExportProgressEvent) => {
    ctx.postMessage({
      id: msg.id,
      type: 'progress',
      event,
    });
  };

  try {
    if (msg.kind === 'single_plate') {
      const params: SinglePlateStlExportParams = {
        plate: msg.plate,
        assetsByLetter: msg.assetsByLetter,
        bedProfile: msg.bedProfile,
        onProgress,
      };
      const res = await exportSinglePlateStl(params);
      ctx.postMessage(
        {
          id: msg.id,
          type: 'single_plate_result',
          result: {
            fileName: res.fileName,
            plateCode: res.plateCode,
            stlBytes: res.stlBytes,
            plateNumber: res.plateNumber,
            keycapCount: res.keycapCount,
            triangleCount: res.triangleCount,
            bounds: res.bounds,
            letterBreakdown: res.letterBreakdown,
            validation: res.validation,
            modelRevision: res.modelRevision,
          },
        },
        [res.stlBytes.buffer]
      );
      return;
    }

    if (msg.kind === 'batch_zip') {
      const params: BatchZipExportParams = {
        batchId: msg.batchId,
        productionDate: msg.productionDate,
        projectId: msg.projectId,
        projectName: msg.projectName,
        productName: msg.productName,
        baseColour: msg.baseColour,
        letterColourNote: msg.letterColourNote,
        plates: msg.plates,
        assetsByLetter: msg.assetsByLetter,
        bedProfile: msg.bedProfile,
        onProgress,
      };
      const res = await exportBatchPlatesZip(params);
      ctx.postMessage(
        {
          id: msg.id,
          type: 'batch_zip_result',
          result: {
            zipFileName: res.zipFileName,
            folderName: res.folderName,
            zipBytes: res.zipBytes,
            manifest: res.manifest,
            warnings: res.warnings,
          },
        },
        [res.zipBytes.buffer]
      );
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    ctx.postMessage({
      id: msg.id,
      type: 'error',
      error: errorMsg,
    });
  }
};
