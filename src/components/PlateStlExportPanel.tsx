import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileArchive,
  Info,
  Layers,
} from 'lucide-react';
import { ABC, countLetters } from '../constants';
import {
  loadRequiredStlAssetsMap,
  runBatchZipStlExport,
  runSinglePlateStlExport,
  triggerBinaryFileDownload,
} from '../services/stlExportWorkerClient';
import {
  PlateStlExportInputPlate,
  StlExportProgressEvent,
  StlModelAssetEntry,
  StlModelAssetRecord,
} from '../types';
import { DEFAULT_BAMBU_BED_PROFILE } from '../utils/plateStlLayout';
import {
  formatBatchArchiveBaseName,
  formatPlateCompleteStlFilename,
} from '../utils/stlExportEngine';

export interface PlateStlExportPanelProps {
  projectId: string;
  projectName: string;
  productName: string;
  batchId?: string | null;
  productionDateIso?: string;
  plates: readonly PlateStlExportInputPlate[];
  recordsByLetter: Record<string, StlModelAssetRecord>;
  getAssetsByLetters: (
    letters: readonly string[]
  ) => Promise<Record<string, StlModelAssetEntry>>;
  onOpenStlLibrary?: () => void;
}

export const PlateStlExportPanel: React.FC<PlateStlExportPanelProps> = ({
  projectId,
  projectName,
  productName,
  batchId,
  productionDateIso,
  plates,
  recordsByLetter,
  getAssetsByLetters,
  onOpenStlLibrary,
}) => {
  const [selectedPlateNumber, setSelectedPlateNumber] = useState<number>(
    plates[0]?.plateNumber ?? 1
  );
  const [layerHeightMm, setLayerHeightMm] = useState<number>(0.2);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [progress, setProgress] = useState<StlExportProgressEvent | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [completionSummary, setCompletionSummary] = useState<{
    mode: 'single' | 'zip';
    fileName: string;
    plateCount: number;
    keycapCount: number;
    triangleCount: number;
    warnings: string[];
  } | null>(null);

  useEffect(() => {
    if (plates.length > 0 && !plates.some((p) => p.plateNumber === selectedPlateNumber)) {
      setSelectedPlateNumber(plates[0].plateNumber);
    }
  }, [plates, selectedPlateNumber]);

  const activePlate = useMemo(
    () => plates.find((p) => p.plateNumber === selectedPlateNumber) || plates[0] || null,
    [plates, selectedPlateNumber]
  );

  // Gather all letters needed across the staged plates
  const requiredLetters = useMemo(() => {
    const needed = new Set<string>();
    for (const plate of plates) {
      for (const l of ABC) {
        if (Math.floor(Number(plate.letters[l] || 0)) > 0) {
          needed.add(l);
        }
      }
    }
    return Array.from(needed).sort();
  }, [plates]);

  const missingStlLetters = useMemo(
    () => requiredLetters.filter((l) => !recordsByLetter[l]?.isValid),
    [requiredLetters, recordsByLetter]
  );

  // Batch color check: one batch must share one physical base colour for full Batch ZIP
  const distinctColors = useMemo(() => {
    const map = new Map<string, { id: string; name: string; hex: string | null }>();
    for (const plate of plates) {
      const cid = (plate.colorId || '').trim();
      if (cid) {
        map.set(cid, {
          id: cid,
          name: plate.colorName || cid,
          hex: plate.colorHex || null,
        });
      }
    }
    return Array.from(map.values());
  }, [plates]);

  const hasColorConflict = distinctColors.length > 1;
  const resolvedBaseColor =
    distinctColors.length === 1
      ? distinctColors[0]
      : { id: null, name: 'Unassigned Base Colour', hex: null };

  const totalBatchKeycaps = useMemo(
    () => plates.reduce((sum, p) => sum + countLetters(p.letters), 0),
    [plates]
  );

  const hasDensePlate = useMemo(
    () => plates.some((p) => countLetters(p.letters) >= 120),
    [plates]
  );

  // Raised letter Z-height swap helper calculated strictly from uploaded STL metrics
  const letterSwapZMetrics = useMemo(() => {
    const startZs: number[] = [];
    const maxZs: number[] = [];
    for (const letter of requiredLetters) {
      const rec = recordsByLetter[letter];
      if (!rec?.isValid) continue;
      maxZs.push(rec.bounds.maxZ);
      if (rec.bounds.estimatedLetterStartZMm !== null) {
        startZs.push(rec.bounds.estimatedLetterStartZMm);
      }
    }
    if (maxZs.length === 0) return null;
    const minStartZ = startZs.length > 0 ? Math.min(...startZs) : null;
    const maxHeight = Math.max(...maxZs);
    const estimatedLayer =
      minStartZ !== null && layerHeightMm > 0
        ? Math.max(1, Math.round(minStartZ / layerHeightMm) + 1)
        : null;
    return {
      minStartZ,
      maxHeight,
      estimatedLayer,
    };
  }, [requiredLetters, recordsByLetter, layerHeightMm]);

  const effectiveBatchId = useMemo(
    () =>
      (batchId && batchId.trim()) ||
      `preview-${formatBatchArchiveBaseName({
        totalKeycapCount: totalBatchKeycaps,
        baseColorName: resolvedBaseColor.name,
      })}`,
    [batchId, totalBatchKeycaps, resolvedBaseColor.name]
  );

  const handleExportCurrentPlate = async () => {
    if (!activePlate || isExporting) return;
    setExportError(null);
    setCompletionSummary(null);

    if (missingStlLetters.length > 0) {
      setExportError(
        `Upload missing STL model(s) before exporting: ${missingStlLetters
          .map((l) => `keycap-char-${l}.stl`)
          .join(', ')}.`
      );
      return;
    }

    setIsExporting(true);
    setProgress({
      phase: 'loading_assets',
      completedPlates: 0,
      totalPlates: 1,
      currentPlateNumber: activePlate.plateNumber,
      percent: 5,
      message: `Loading binary STL assets for Plate ${activePlate.plateNumber}...`,
    });

    try {
      const assetsByLetter = await loadRequiredStlAssetsMap({
        getAssetsByLetters,
        plates: [activePlate],
      });

      const result = await runSinglePlateStlExport({
        plate: activePlate,
        assetsByLetter,
        bedProfile: DEFAULT_BAMBU_BED_PROFILE,
        onProgress: setProgress,
      });

      triggerBinaryFileDownload(result.stlBytes, result.fileName, 'model/stl');
      setCompletionSummary({
        mode: 'single',
        fileName: result.fileName,
        plateCount: 1,
        keycapCount: result.keycapCount,
        triangleCount: result.triangleCount,
        warnings: result.validation.warnings,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setExportError(msg);
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportAllPlatesZip = async () => {
    if (plates.length === 0 || isExporting) return;
    setExportError(null);
    setCompletionSummary(null);

    if (missingStlLetters.length > 0) {
      setExportError(
        `Upload missing STL model(s) before exporting: ${missingStlLetters
          .map((l) => `keycap-char-${l}.stl`)
          .join(', ')}.`
      );
      return;
    }

    if (hasColorConflict) {
      setExportError(
        'One Production Batch must have one physical base Filament Colour before exporting a batch ZIP. Apply one colour to all plates first.'
      );
      return;
    }

    setIsExporting(true);
    setProgress({
      phase: 'loading_assets',
      completedPlates: 0,
      totalPlates: plates.length,
      percent: 5,
      message: `Loading STL assets for ${plates.length} plate(s)...`,
    });

    try {
      const assetsByLetter = await loadRequiredStlAssetsMap({
        getAssetsByLetters,
        plates,
      });

      const result = await runBatchZipStlExport({
        batchId: effectiveBatchId,
        productionDate: (productionDateIso || new Date().toISOString()).slice(0, 10),
        projectId,
        projectName,
        productName,
        baseColour: resolvedBaseColor,
        plates,
        assetsByLetter,
        bedProfile: DEFAULT_BAMBU_BED_PROFILE,
        onProgress: setProgress,
      });

      const totalTris = result.manifest.plates.reduce(
        (sum, p) => sum + p.triangleCount,
        0
      );

      triggerBinaryFileDownload(result.zipBytes, result.zipFileName, 'application/zip');
      setCompletionSummary({
        mode: 'zip',
        fileName: result.zipFileName,
        plateCount: result.manifest.plateCount,
        keycapCount: result.manifest.totalKeycapCount,
        triangleCount: totalTris,
        warnings: result.warnings,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setExportError(msg);
    } finally {
      setIsExporting(false);
    }
  };

  if (plates.length === 0 || totalBatchKeycaps === 0) return null;

  const expectedZipName = `${formatBatchArchiveBaseName({
    totalKeycapCount: totalBatchKeycaps,
    baseColorName: resolvedBaseColor.name,
  })}.zip`;

  return (
    <div
      data-testid="plate-stl-export-panel"
      className="rounded-xl border border-line bg-recessed p-4 space-y-3.5"
    >
      {/* Header & Actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold text-ink">
              Fast STL Export Engine
            </h4>
            <span className="text-xs font-mono-data text-muted">
              · {plates.length} {plates.length === 1 ? 'plate' : 'plates'} ·{' '}
              {totalBatchKeycaps.toLocaleString()} pcs · {resolvedBaseColor.name}
            </span>
          </div>
          <p className="text-xs text-muted mt-0.5">
            Generates ONE complete unified binary STL per plate (all {totalBatchKeycaps} keycaps pre-arranged cleanly on 256×256 mm Bambu bed) using exact planner coordinates.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {plates.length > 1 && (
            <select
              aria-label="Select plate for single STL export"
              value={activePlate?.plateNumber ?? ''}
              disabled={isExporting}
              onChange={(e) => setSelectedPlateNumber(Number(e.target.value))}
              className="px-2.5 py-1.5 rounded-lg border border-line bg-input text-xs font-mono-data font-semibold text-ink focus:border-brand focus:outline-none"
            >
              {plates.map((p) => (
                <option key={p.plateNumber} value={p.plateNumber}>
                  {formatPlateCompleteStlFilename(p.plateNumber)} ({countLetters(p.letters)} pcs)
                </option>
              ))}
            </select>
          )}

          <button
            type="button"
            disabled={isExporting || missingStlLetters.length > 0 || !activePlate}
            onClick={() => void handleExportCurrentPlate()}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-line bg-surface hover:bg-elevated disabled:opacity-45 text-xs font-semibold text-ink whitespace-nowrap transition-colors cursor-pointer disabled:cursor-not-allowed"
          >
            <Download className="w-3.5 h-3.5 text-brand-text" />
            <span>Export Current Plate STL</span>
          </button>

          <button
            type="button"
            disabled={isExporting || missingStlLetters.length > 0 || hasColorConflict}
            onClick={() => void handleExportAllPlatesZip()}
            title={`Export ${expectedZipName} containing all plates + manifest.json`}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-brand hover:bg-brand-hover disabled:opacity-45 text-white text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer disabled:cursor-not-allowed"
          >
            <FileArchive className="w-3.5 h-3.5" />
            <span>Export All Plates ZIP</span>
          </button>
        </div>
      </div>

      {/* Missing STL Assets Prompt */}
      {missingStlLetters.length > 0 && (
        <div
          role="alert"
          className="p-3 rounded-lg border border-warning-border bg-warning-soft text-xs text-warning-text flex flex-wrap items-center justify-between gap-2"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              Missing authentic STL model(s) for:{' '}
              <span className="font-mono-data font-semibold">
                {missingStlLetters.map((l) => `keycap-char-${l}.stl`).join(', ')}
              </span>
              . Upload them in the STL Model Library to enable STL export.
            </span>
          </div>
          {onOpenStlLibrary && (
            <button
              type="button"
              onClick={onOpenStlLibrary}
              className="px-2.5 py-1 rounded border border-warning-border bg-surface hover:bg-elevated text-[11px] font-semibold text-ink whitespace-nowrap transition-colors cursor-pointer"
            >
              Open STL Library
            </button>
          )}
        </div>
      )}

      {/* Two-Colour & Dense-Plate Physical Safety Notices */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 text-xs">
        <div className="p-3 rounded-lg border border-line bg-surface space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-ink inline-flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-brand-text" />
              <span>Manual 2-Colour Swap Reference (STL)</span>
            </span>
            <label className="inline-flex items-center gap-1.5 text-[11px] text-muted">
              <span>Layer:</span>
              <select
                aria-label="Reference layer height for filament swap calculation"
                value={layerHeightMm}
                onChange={(e) => setLayerHeightMm(Number(e.target.value))}
                className="px-1.5 py-0.5 rounded border border-line bg-input font-mono-data text-ink"
              >
                <option value={0.12}>0.12 mm</option>
                <option value={0.16}>0.16 mm</option>
                <option value={0.2}>0.20 mm</option>
                <option value={0.24}>0.24 mm</option>
              </select>
            </label>
          </div>
          <p className="text-[11px] text-ink-secondary">
            STL files do not encode AMS filament colours. Configure base colour and manual pause / filament change in Bambu Studio.
          </p>
          {letterSwapZMetrics && letterSwapZMetrics.minStartZ !== null && (
            <div className="text-[11px] font-mono-data text-brand-text">
              Measured raised-letter Z step: ~{letterSwapZMetrics.minStartZ.toFixed(2)} mm
              {letterSwapZMetrics.estimatedLayer !== null
                ? ` (~Layer ${letterSwapZMetrics.estimatedLayer} at ${layerHeightMm.toFixed(2)}mm) · Total height ${letterSwapZMetrics.maxHeight.toFixed(2)} mm`
                : ''}
            </div>
          )}
        </div>

        <div
          className={`p-3 rounded-lg border space-y-1.5 ${
            hasDensePlate
              ? 'border-warning-border bg-warning-soft text-warning-text'
              : 'border-line bg-surface text-ink-secondary'
          }`}
        >
          <div className="font-semibold inline-flex items-center gap-1.5">
            <Info className="w-3.5 h-3.5 shrink-0" />
            <span>
              {hasDensePlate
                ? 'Prime Tower & Toolhead Clearance Warning'
                : 'Bambu Studio Bed Verification'}
            </span>
          </div>
          <p className="text-[11px] leading-relaxed">
            {hasDensePlate
              ? '138-keycap grid on 256×256 mm leaves tight perimeter margin for a prime tower or front-left filament cutter exclusion zone. Inspect prime tower placement manually in Bambu Studio — slicer verification is NOT automatic.'
              : 'All coordinates stay inside 256×256 mm with zero detected overlap. Slicer verification and print slicing remain manual in Bambu Studio.'}
          </p>
        </div>
      </div>

      {/* Progress Bar */}
      {isExporting && progress && (
        <div className="p-3 rounded-lg border border-brand-border bg-surface space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-ink">{progress.message}</span>
            <span className="font-mono-data font-semibold text-brand-text">
              {progress.percent}%
            </span>
          </div>
          <div className="w-full h-1.5 rounded-full bg-recessed overflow-hidden">
            <div
              className="h-full bg-brand transition-all duration-150"
              style={{ width: `${Math.min(100, Math.max(4, progress.percent))}%` }}
            />
          </div>
        </div>
      )}

      {/* Explicit Error Callout */}
      {exportError && (
        <div
          role="alert"
          className="p-3 rounded-lg border border-status-error bg-error-soft text-xs text-error-text flex items-start gap-2"
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{exportError}</span>
        </div>
      )}

      {/* Completion Summary */}
      {completionSummary && (
        <div className="p-3 rounded-lg border border-brand-border bg-brand-soft text-xs space-y-1">
          <div className="font-semibold text-brand-text flex items-center gap-1.5">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>
              Export Complete: <span className="font-mono-data">{completionSummary.fileName}</span>
            </span>
          </div>
          <div className="text-[11px] font-mono-data text-ink-secondary">
            {completionSummary.plateCount}{' '}
            {completionSummary.plateCount === 1 ? 'plate STL' : 'complete plate STLs'} ·{' '}
            {completionSummary.keycapCount.toLocaleString()} keycaps ·{' '}
            {completionSummary.triangleCount.toLocaleString()} triangles · Batch ID:{' '}
            {effectiveBatchId}
          </div>
        </div>
      )}
    </div>
  );
};
