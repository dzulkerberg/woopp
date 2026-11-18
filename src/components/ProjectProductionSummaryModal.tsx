import React, { useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import { AlertTriangle, ArrowLeft, Printer } from 'lucide-react';
import { ProductionProject, ProductionWorkspaceV5 } from '../types';
import { DEFAULT_TIMEZONE, formatDateDDMMYYYY } from '../utils/dateFormat';
import {
  auditProductionJobRelationships,
  BatchProductionSummary,
  buildProjectProductionSummary,
} from '../utils/projectProductionSummary';

export interface ProjectProductionSummaryModalProps {
  workspace: ProductionWorkspaceV5;
  project: ProductionProject;
  onClose: () => void;
  nowMs?: number;
  initialPrintScope?: 'single' | 'all_completed';
  initialSelectedBatchId?: string;
  onPrint?: () => void;
}

export const ProjectProductionSummaryModal: React.FC<
  ProjectProductionSummaryModalProps
> = ({
  workspace,
  project,
  onClose,
  nowMs,
  initialPrintScope = 'single',
  initialSelectedBatchId,
  onPrint,
}) => {
  const effectiveNowMs = nowMs ?? Date.now();
  const timezone = workspace.settings?.timezone || DEFAULT_TIMEZONE;
  const printDateLabel = formatDateDDMMYYYY(effectiveNowMs, timezone);

  const summary = useMemo(
    () =>
      buildProjectProductionSummary({
        workspace,
        projectId: project.id,
        nowMs: effectiveNowMs,
      }),
    [workspace, project.id, effectiveNowMs]
  );

  const auditReport = useMemo(
    () => auditProductionJobRelationships(workspace, effectiveNowMs),
    [workspace, effectiveNowMs]
  );

  const [selectedBatchId, setSelectedBatchId] = useState<string>(() => {
    if (
      initialSelectedBatchId &&
      summary.batches.some((b) => b.batchId === initialSelectedBatchId)
    ) {
      return initialSelectedBatchId;
    }
    return summary.batches[0]?.batchId || '';
  });

  const [printScope, setPrintScope] = useState<'single' | 'all_completed'>(
    initialPrintScope
  );
  const [confirmingPartialBatchId, setConfirmingPartialBatchId] = useState<
    string | null
  >(null);

  const activeBatch: BatchProductionSummary | null = useMemo(() => {
    if (summary.batches.length === 0) return null;
    return (
      summary.batches.find((b) => b.batchId === selectedBatchId) ||
      summary.batches[0]
    );
  }, [summary.batches, selectedBatchId]);

  const triggerPrint = () => {
    if (onPrint) {
      onPrint();
    } else if (typeof window !== 'undefined' && typeof window.print === 'function') {
      window.print();
    }
  };

  const executePrintSingleBatch = () => {
    if (!activeBatch || activeBatch.completedPlateCount === 0) return;
    flushSync(() => {
      setConfirmingPartialBatchId(null);
      setPrintScope('single');
    });
    triggerPrint();
  };

  const handlePrintThisBatchClick = () => {
    if (!activeBatch || activeBatch.completedPlateCount === 0) return;
    if (activeBatch.completionStatus !== 'completed') {
      setConfirmingPartialBatchId(activeBatch.batchId);
      return;
    }
    executePrintSingleBatch();
  };

  const handlePrintAllCompletedBatches = () => {
    if (summary.completedBatches.length === 0) return;
    flushSync(() => {
      setConfirmingPartialBatchId(null);
      setPrintScope('all_completed');
    });
    triggerPrint();
  };

  const batchesToPrint: BatchProductionSummary[] =
    printScope === 'all_completed'
      ? summary.completedBatches
      : activeBatch && activeBatch.completedPlateCount > 0
      ? [activeBatch]
      : [];

  return (
    <div className="space-y-6">
      {/* Interactive Screen View (Hidden cleanly during Print / PDF) */}
      <div className="no-print space-y-6">
        {/* Top Bar & Project Context */}
        <section className="bg-surface border border-line rounded-xl p-6 space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-line">
            <div className="space-y-1 min-w-0">
              <button
                type="button"
                onClick={onClose}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-secondary hover:text-ink transition-colors mb-1"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Back to Projects</span>
              </button>
              <h2 className="text-lg font-bold text-ink truncate">
                Production Batches &amp; Packing Summary — {summary.projectName}
              </h2>
              <div className="text-xs text-muted flex flex-wrap items-center gap-2">
                <span>{project.salesChannel}</span>
                <span aria-hidden="true">·</span>
                <span>{project.status}</span>
                <span aria-hidden="true">·</span>
                <span>{project.productType}</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono-data">ID: {project.id}</span>
              </div>
            </div>

            {summary.batches.length > 0 && (
              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  disabled={!activeBatch || activeBatch.completedPlateCount === 0}
                  onClick={handlePrintThisBatchClick}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-brand hover:bg-brand-hover disabled:opacity-40 text-white text-xs font-semibold whitespace-nowrap transition-colors"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>
                    {activeBatch
                      ? `Print ${activeBatch.batchLabel}`
                      : 'Print This Batch'}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={summary.completedBatches.length === 0}
                  onClick={handlePrintAllCompletedBatches}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-line bg-elevated hover:bg-recessed disabled:opacity-40 text-ink text-xs font-semibold whitespace-nowrap transition-colors"
                >
                  <Printer className="w-3.5 h-3.5 text-ink-secondary" />
                  <span>
                    Print All Completed Batches ({summary.completedBatches.length})
                  </span>
                </button>
              </div>
            )}
          </div>

          {/* 4-Metric Project Batch Rollup */}
          <div className="rounded-xl border border-line bg-recessed grid grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-line">
            <div className="p-3.5">
              <div className="text-[11px] font-medium text-muted">
                Production Batches
              </div>
              <div className="text-base font-bold font-mono-data text-ink mt-0.5">
                {summary.totalBatches}
              </div>
              <div className="text-[11px] text-muted mt-0.5 font-mono-data">
                {summary.completedBatchCount} completed · {summary.partialBatchCount}{' '}
                partial · {summary.inProgressBatchCount} queued
              </div>
            </div>

            <div className="p-3.5">
              <div className="text-[11px] font-medium text-muted">
                Completed Output
              </div>
              <div className="text-base font-bold font-mono-data text-brand-text mt-0.5">
                {summary.totalCompletedUnits.toLocaleString()} pcs
              </div>
              <div className="text-[11px] text-muted mt-0.5 font-mono-data">
                {summary.totalRequestedUnits > 0
                  ? `${summary.totalRemainingUnits.toLocaleString()} pcs remaining in batches`
                  : 'Verified completed production only'}
              </div>
            </div>

            <div className="p-3.5">
              <div className="text-[11px] font-medium text-muted">
                Completed Plates
              </div>
              <div className="text-base font-bold font-mono-data text-ink mt-0.5">
                {summary.totalCompletedPlates}
              </div>
              <div className="text-[11px] text-muted mt-0.5 font-mono-data">
                {summary.activeCompletedPlates} active · {summary.archivedCompletedPlates}{' '}
                archived
              </div>
            </div>

            <div className="p-3.5">
              <div className="text-[11px] font-medium text-muted">
                Packing Sheet Date
              </div>
              <div className="text-base font-bold font-mono-data text-ink mt-0.5">
                {printDateLabel}
              </div>
              <div className="text-[11px] text-muted mt-0.5">
                {summary.reprintCompletedPlates > 0
                  ? `${summary.reprintCompletedPlates} completed after reprint`
                  : '1 Batch = 1 Product + 1 Color'}
              </div>
            </div>
          </div>

          {/* Read-only Relationship & Integrity Warnings */}
          {(summary.warnings.length > 0 || auditReport.unlinkedJobs.length > 0) && (
            <div
              role="status"
              className="p-4 rounded-xl border border-warning-border bg-warning-soft text-xs text-warning-text space-y-1.5"
            >
              <div className="flex items-center gap-2 font-semibold">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>Production Batch &amp; Data Integrity Notice (Read-Only)</span>
              </div>
              <ul className="list-disc pl-5 space-y-1">
                {summary.warnings.map((w, idx) => (
                  <li key={idx}>{w}</li>
                ))}
                {auditReport.unlinkedJobs.length > 0 && (
                  <li>
                    {auditReport.unlinkedJobs.length} workspace plate record(s) lack a valid linked project ID and are kept separate without altering historical data.
                  </li>
                )}
              </ul>
            </div>
          )}
        </section>

        {/* Batch Selector & Batch Inspection View */}
        {summary.batches.length === 0 ? (
          <section className="bg-surface border border-line rounded-xl p-10 text-center space-y-2">
            <h3 className="text-sm font-semibold text-ink">
              No Production Batches Recorded Yet for &ldquo;{summary.projectName}&rdquo;
            </h3>
            <p className="text-xs text-muted max-w-lg mx-auto">
              Generate and confirm plates in Auto Plate Planner to create an isolated Production Batch (1 Product + 1 Filament Color per batch). Completed, Planned, Printing, and Archived plates will appear grouped under their exact batch.
            </p>
          </section>
        ) : (
          <section className="bg-surface border border-line rounded-xl p-6 space-y-5">
            {/* Batch Selector Controls */}
            <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-line">
              <div className="flex flex-wrap items-center gap-2">
                {summary.batches.map((b) => {
                  const isActive = activeBatch?.batchId === b.batchId;
                  return (
                    <button
                      key={b.batchId}
                      type="button"
                      data-testid={`batch-tab-${b.batchNumber}`}
                      onClick={() => {
                        setSelectedBatchId(b.batchId);
                        setConfirmingPartialBatchId(null);
                      }}
                      className={`px-3 py-2 rounded-lg text-xs border transition-colors flex items-center gap-2 whitespace-nowrap ${
                        isActive
                          ? 'border-brand bg-brand-soft text-brand-text font-semibold'
                          : 'border-line bg-elevated text-ink-secondary hover:text-ink'
                      }`}
                    >
                      <span
                        className="w-2.5 h-2.5 rounded-full shrink-0 border border-line"
                        style={{ backgroundColor: b.colorHex }}
                        aria-hidden="true"
                      />
                      <span className="font-mono-data">{b.batchLabel}</span>
                      <span aria-hidden="true">·</span>
                      <span>{b.productName}</span>
                      <span aria-hidden="true">·</span>
                      <span>{b.colorName}</span>
                      <span className="font-mono-data text-[11px] opacity-85">
                        ({b.completedPlateCount}/{b.generatedPlateCount})
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="flex items-center gap-2">
                <label
                  htmlFor="summary-batch-select"
                  className="text-xs font-semibold text-ink-secondary whitespace-nowrap"
                >
                  Select Batch:
                </label>
                <select
                  id="summary-batch-select"
                  value={activeBatch?.batchId || ''}
                  onChange={(e) => {
                    setSelectedBatchId(e.target.value);
                    setConfirmingPartialBatchId(null);
                  }}
                  className="px-3 py-1.5 rounded-lg border border-line bg-input text-xs font-medium text-ink focus:border-brand focus:outline-none"
                >
                  {summary.batches.map((b) => (
                    <option key={b.batchId} value={b.batchId}>
                      {b.batchLabel} — {b.productName} · {b.colorName} (
                      {b.completedPlateCount}/{b.generatedPlateCount} plates ·{' '}
                      {b.completedQuantity}/{b.requestedQuantity} pcs)
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Active Selected Batch Breakdown */}
            {activeBatch && (
              <div className="space-y-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="flex items-start gap-2.5 min-w-0">
                    <span
                      className="w-3.5 h-3.5 rounded-full shrink-0 border border-line mt-1"
                      style={{ backgroundColor: activeBatch.colorHex }}
                      aria-hidden="true"
                    />
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-bold text-ink">
                          {activeBatch.batchLabel} — {activeBatch.productName}
                        </h3>
                        {activeBatch.sku && (
                          <span className="text-xs font-mono-data text-muted">
                            · {activeBatch.sku}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted flex flex-wrap items-center gap-2 font-mono-data">
                        <span className="font-sans font-medium text-ink-secondary">
                          {activeBatch.colorName}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>Created {activeBatch.createdDateLabel}</span>
                        <span aria-hidden="true">·</span>
                        <span>ID: {activeBatch.batchId}</span>
                      </div>
                    </div>
                  </div>

                  <div className="text-right space-y-0.5">
                    <div
                      className={`text-xs font-semibold ${
                        activeBatch.completionStatus === 'completed'
                          ? 'text-brand-text'
                          : activeBatch.completionStatus === 'partial'
                          ? 'text-warning-text'
                          : 'text-ink-secondary'
                      }`}
                    >
                      {activeBatch.completionStatusLabel}
                    </div>
                    <div className="text-lg font-bold font-mono-data text-ink">
                      {activeBatch.completedQuantity.toLocaleString()} /{' '}
                      {activeBatch.requestedQuantity.toLocaleString()} pcs
                    </div>
                    <div className="text-[11px] font-mono-data text-muted">
                      {activeBatch.completedPlateCount} /{' '}
                      {activeBatch.generatedPlateCount} plates completed
                      {activeBatch.remainingQuantity > 0
                        ? ` · ${activeBatch.remainingQuantity.toLocaleString()} pcs remaining`
                        : ''}
                    </div>
                  </div>
                </div>

                {/* Explicit Partial Batch Completion Warning & Confirmation Step */}
                {activeBatch.hasPartialWarning && (
                  <div
                    role="status"
                    className="p-4 rounded-xl border border-warning-border bg-warning-soft text-xs text-warning-text space-y-2.5"
                  >
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                      <div>
                        <div className="font-semibold">
                          Partial Batch Completion ({activeBatch.completedPlateCount} /{' '}
                          {activeBatch.generatedPlateCount} plates completed)
                        </div>
                        <p className="mt-0.5 opacity-95">
                          {activeBatch.completedPlateCount === 0
                            ? `No plates in ${activeBatch.batchLabel} are marked Completed yet. Printing is disabled until at least 1 plate completes.`
                            : `${activeBatch.completedQuantity.toLocaleString()} pcs completed out of ${activeBatch.requestedQuantity.toLocaleString()} pcs requested (${activeBatch.remainingQuantity.toLocaleString()} pcs remaining). Any packing sheet printed now will display a [PARTIAL BATCH COMPLETION] notice and include ONLY completed plates.`}
                        </p>
                      </div>
                    </div>

                    {confirmingPartialBatchId === activeBatch.batchId && (
                      <div className="pl-6 pt-1 flex flex-wrap items-center gap-2">
                        <span className="font-semibold">
                          Confirm printing partial batch ({activeBatch.completedPlateCount}/
                          {activeBatch.generatedPlateCount} plates)?
                        </span>
                        <button
                          type="button"
                          onClick={executePrintSingleBatch}
                          className="px-3 py-1.5 rounded-lg bg-brand hover:bg-brand-hover text-white font-semibold whitespace-nowrap transition-colors"
                        >
                          Confirm Print Partial Sheet (Completed Output Only)
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmingPartialBatchId(null)}
                          className="px-3 py-1.5 rounded-lg border border-warning-border bg-surface text-ink font-medium whitespace-nowrap transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {activeBatch.missingSnapshotPlateNumbers.length > 0 && (
                  <div className="p-3 rounded-lg border border-warning-border bg-warning-soft text-xs text-warning-text">
                    Missing variation snapshot on Completed Plate{' '}
                    {activeBatch.missingSnapshotPlateNumbers
                      .map((n) => `#${n}`)
                      .join(', ')}
                    . Totals count only plates with persisted variation snapshots.
                  </div>
                )}

                {/* Per-Variation Requested vs Completed vs Remaining Table */}
                <div className="rounded-xl border border-line overflow-hidden">
                  <div className="px-4 py-3 bg-recessed border-b border-line flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-ink">
                      Variation Breakdown — Requested vs Completed ({activeBatch.colorName})
                    </span>
                    <span className="text-xs font-mono-data text-muted">
                      Requested: {activeBatch.requestedQuantity.toLocaleString()} · Completed:{' '}
                      {activeBatch.completedQuantity.toLocaleString()} · Remaining:{' '}
                      {activeBatch.remainingQuantity.toLocaleString()} pcs
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead>
                        <tr className="border-b border-line bg-elevated text-ink-secondary">
                          <th className="py-2.5 px-4 font-semibold">Variation</th>
                          <th className="py-2.5 px-4 font-semibold text-right">
                            Requested Qty
                          </th>
                          <th className="py-2.5 px-4 font-semibold text-right">
                            Completed Qty
                          </th>
                          <th className="py-2.5 px-4 font-semibold text-right">
                            Remaining Qty
                          </th>
                          <th className="py-2.5 px-4 font-semibold">
                            Completed Plates
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line bg-surface">
                        {activeBatch.variations.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="py-4 px-4 text-center text-muted">
                              No variation breakdown recorded on this batch.
                            </td>
                          </tr>
                        ) : (
                          activeBatch.variations.map((v) => (
                            <tr key={v.variationKey}>
                              <td className="py-2.5 px-4 font-medium text-ink">
                                {v.label}
                              </td>
                              <td className="py-2.5 px-4 text-right font-mono-data text-ink-secondary">
                                {v.requestedQuantity.toLocaleString()} pcs
                              </td>
                              <td className="py-2.5 px-4 text-right font-mono-data font-semibold text-brand-text">
                                {v.completedQuantity.toLocaleString()} pcs
                              </td>
                              <td className="py-2.5 px-4 text-right font-mono-data text-ink">
                                {v.remainingQuantity.toLocaleString()} pcs
                              </td>
                              <td className="py-2.5 px-4 font-mono-data text-muted">
                                {v.completedPlateNumbers.length > 0
                                  ? v.completedPlateNumbers.map((n) => `#${n}`).join(', ')
                                  : '—'}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Generated Plates Membership Table */}
                <div className="rounded-xl border border-line overflow-hidden">
                  <div className="px-4 py-3 bg-recessed border-b border-line flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-ink">
                      Generated Plates in {activeBatch.batchLabel} ({activeBatch.generatedPlateCount})
                    </span>
                    <span className="text-[11px] text-muted">
                      Only Completed plates (active or archived) contribute to packing quantities
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead>
                        <tr className="border-b border-line bg-elevated text-ink-secondary">
                          <th className="py-2 px-4 font-semibold">Plate</th>
                          <th className="py-2 px-4 font-semibold">Queue Stage</th>
                          <th className="py-2 px-4 font-semibold text-right">
                            Planned
                          </th>
                          <th className="py-2 px-4 font-semibold text-right">
                            Completed
                          </th>
                          <th className="py-2 px-4 font-semibold">Completed At</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line bg-surface">
                        {activeBatch.plates.map((p) => (
                          <tr key={p.jobId}>
                            <td className="py-2 px-4 font-mono-data font-semibold text-ink">
                              Plate #{p.plateNumber}
                            </td>
                            <td className="py-2 px-4 text-ink-secondary">
                              <span>{p.stage}</span>
                              {p.isArchivedCompleted && (
                                <span className="text-muted"> · Archived</span>
                              )}
                              {p.isReprintCompleted && (
                                <span className="text-muted">
                                  {' '}
                                  · Completed after {p.failedCount} reprint
                                </span>
                              )}
                              {!p.isCompleted && (
                                <span className="text-muted"> · Excluded from packing</span>
                              )}
                            </td>
                            <td className="py-2 px-4 text-right font-mono-data text-ink-secondary">
                              {p.plannedUnits.toLocaleString()} pcs
                            </td>
                            <td className="py-2 px-4 text-right font-mono-data font-semibold text-ink">
                              {p.isCompleted
                                ? `${p.completedUnits.toLocaleString()} pcs`
                                : '0 pcs'}
                            </td>
                            <td className="py-2 px-4 font-mono-data text-muted">
                              {p.completedAtLabel}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </section>
        )}

        {/* Separate Non-Merged Legacy / Unassigned Batch Records */}
        {summary.legacyJobs.length > 0 && (
          <section className="bg-surface border border-line rounded-xl p-6 space-y-4">
            <div className="pb-3 border-b border-line">
              <h3 className="text-sm font-bold text-ink">
                Legacy / Unassigned Batch Records ({summary.legacyJobs.length})
              </h3>
              <p className="text-xs text-muted mt-0.5">
                Historical plates lacking a single homogeneous Batch ID are preserved individually below without auto-merging.
              </p>
            </div>
            <div className="overflow-x-auto rounded-xl border border-line">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-line bg-recessed text-ink-secondary">
                    <th className="py-2 px-4 font-semibold">Plate / ID</th>
                    <th className="py-2 px-4 font-semibold">Product</th>
                    <th className="py-2 px-4 font-semibold">Color</th>
                    <th className="py-2 px-4 font-semibold">Stage</th>
                    <th className="py-2 px-4 font-semibold text-right">Completed</th>
                    <th className="py-2 px-4 font-semibold">Note</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line bg-surface">
                  {summary.legacyJobs.map((leg) => (
                    <tr key={leg.jobId}>
                      <td className="py-2 px-4 font-mono-data text-ink">
                        Plate #{leg.plateNumber}
                      </td>
                      <td className="py-2 px-4 font-medium text-ink">
                        {leg.productName}
                      </td>
                      <td className="py-2 px-4 text-ink-secondary">
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className="w-2 h-2 rounded-full border border-line shrink-0"
                            style={{ backgroundColor: leg.colorHex }}
                            aria-hidden="true"
                          />
                          <span>{leg.colorName}</span>
                        </span>
                      </td>
                      <td className="py-2 px-4 text-ink-secondary">{leg.stage}</td>
                      <td className="py-2 px-4 text-right font-mono-data font-semibold text-ink">
                        {leg.completedUnits.toLocaleString()} pcs
                      </td>
                      <td className="py-2 px-4 text-[11px] text-muted">
                        {leg.reason}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>

      {/* A4 Portrait Printable Packing Sheet Document (Visible in Print/PDF; rendered cleanly in DOM) */}
      {batchesToPrint.length > 0 && (
        <div
          className="woopp-packing-print-root hidden print:block bg-white text-black"
          data-print-scope={printScope}
        >
          {batchesToPrint.map((batchSheet, idx) => (
            <section
              key={batchSheet.batchId}
              data-packing-batch-id={batchSheet.batchId}
              className={
                idx > 0
                  ? 'woopp-packing-color-section woopp-page-break-before'
                  : 'woopp-packing-color-section'
              }
            >
              {/* Formal Printable Batch Packing Sheet Header */}
              <header className="border-b-2 border-black pb-3 mb-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-[11px] font-bold tracking-widest uppercase">
                      WOOPP ART &amp; CRAFT
                    </div>
                    <h1 className="text-lg font-bold tracking-tight uppercase mt-0.5">
                      PRODUCTION BATCH PACKING SUMMARY
                    </h1>
                  </div>
                  <div className="text-right text-xs font-mono-data">
                    <div>
                      <span className="font-semibold">Print Date:</span>{' '}
                      {printDateLabel}
                    </div>
                    <div>
                      <span className="font-semibold">Batch Created:</span>{' '}
                      {batchSheet.createdDateLabel}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 mt-3 pt-2.5 border-t border-neutral-400 text-xs">
                  <div>
                    <span className="font-semibold">Project:</span>{' '}
                    <span className="font-bold">{summary.projectName}</span>
                  </div>
                  <div>
                    <span className="font-semibold">Batch Identity:</span>{' '}
                    <span className="font-bold font-mono-data">
                      {batchSheet.batchLabel} ({batchSheet.batchId})
                    </span>
                  </div>
                  <div>
                    <span className="font-semibold">Product:</span>{' '}
                    <span className="font-bold">
                      {batchSheet.productName}
                      {batchSheet.sku ? ` (${batchSheet.sku})` : ''}
                    </span>
                  </div>
                  <div>
                    <span className="font-semibold">Filament Color:</span>{' '}
                    <span className="font-bold">{batchSheet.colorName}</span>
                  </div>
                  <div>
                    <span className="font-semibold">Completed Plates:</span>{' '}
                    <span className="font-mono-data font-bold">
                      {batchSheet.completedPlateCount} /{' '}
                      {batchSheet.generatedPlateCount}
                    </span>
                  </div>
                  <div>
                    <span className="font-semibold">Source Completed Plates:</span>{' '}
                    <span className="font-mono-data">
                      {batchSheet.completedPlateNumbers
                        .map((n) => `#${n}`)
                        .join(', ')}
                    </span>
                  </div>
                </div>

                {batchSheet.completionStatus !== 'completed' && (
                  <div className="mt-3 p-2 border-2 border-black bg-neutral-100 text-[11px]">
                    <div className="font-bold uppercase">
                      [PARTIAL BATCH COMPLETION — COMPLETED OUTPUT ONLY]
                    </div>
                    <div className="font-mono-data mt-0.5">
                      Requested: {batchSheet.requestedQuantity.toLocaleString()} pcs ·
                      Completed: {batchSheet.completedQuantity.toLocaleString()} pcs ·
                      Remaining: {batchSheet.remainingQuantity.toLocaleString()} pcs (
                      {batchSheet.completedPlateCount}/
                      {batchSheet.generatedPlateCount} plates completed). Non-completed plates are excluded from this packing sheet.
                    </div>
                  </div>
                )}
              </header>

              {/* Variation Packing Table */}
              <table className="woopp-packing-table w-full text-xs border border-black">
                <thead>
                  <tr className="bg-neutral-100 border-b-2 border-black">
                    <th className="py-2 px-2.5 text-left font-bold border-r border-neutral-400">
                      Variation
                    </th>
                    <th className="py-2 px-2.5 text-right font-bold border-r border-neutral-400 w-24">
                      Requested
                    </th>
                    <th className="py-2 px-2.5 text-right font-bold border-r border-neutral-400 w-28">
                      Completed (Pack)
                    </th>
                    <th className="py-2 px-2.5 text-right font-bold border-r border-neutral-400 w-24">
                      Remaining
                    </th>
                    <th className="py-2 px-2.5 text-center font-bold w-16">
                      Packed
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {batchSheet.variations.map((v) => (
                    <tr
                      key={v.variationKey}
                      className="border-b border-neutral-400"
                    >
                      <td className="py-1.5 px-2.5 border-r border-neutral-400 font-medium">
                        {v.label}
                      </td>
                      <td className="py-1.5 px-2.5 border-r border-neutral-400 text-right font-mono-data">
                        {v.requestedQuantity.toLocaleString()} pcs
                      </td>
                      <td className="py-1.5 px-2.5 border-r border-neutral-400 text-right font-mono-data font-semibold">
                        {v.completedQuantity.toLocaleString()} pcs
                      </td>
                      <td className="py-1.5 px-2.5 border-r border-neutral-400 text-right font-mono-data">
                        {v.remainingQuantity.toLocaleString()} pcs
                      </td>
                      <td className="py-1.5 px-2.5 text-center font-mono-data text-sm">
                        ☐
                      </td>
                    </tr>
                  ))}

                  {batchSheet.missingSnapshotPlateNumbers.length > 0 && (
                    <tr className="border-b border-neutral-400">
                      <td colSpan={5} className="py-2 px-2.5 text-[11px] italic">
                        Warning: Completed Plate{' '}
                        {batchSheet.missingSnapshotPlateNumbers
                          .map((n) => `#${n}`)
                          .join(', ')}{' '}
                        lacks recorded variation details; verify physical count manually.
                      </td>
                    </tr>
                  )}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-black bg-neutral-100">
                    <td className="py-2 px-2.5 text-right font-bold uppercase border-r border-neutral-400">
                      Total ({batchSheet.batchLabel} · {batchSheet.colorName}):
                    </td>
                    <td className="py-2 px-2.5 text-right font-mono-data font-bold border-r border-neutral-400">
                      {batchSheet.requestedQuantity.toLocaleString()} pcs
                    </td>
                    <td className="py-2 px-2.5 text-right font-mono-data font-bold border-r border-neutral-400">
                      {batchSheet.completedQuantity.toLocaleString()} pcs
                    </td>
                    <td className="py-2 px-2.5 text-right font-mono-data font-bold border-r border-neutral-400">
                      {batchSheet.remainingQuantity.toLocaleString()} pcs
                    </td>
                    <td className="py-2 px-2.5 text-center font-bold">✓</td>
                  </tr>
                </tfoot>
              </table>

              {/* Sign-off & Packing Verification Footer */}
              <footer className="woopp-packing-signoff mt-6 pt-3 border-t border-black grid grid-cols-2 gap-6 text-xs">
                <div>
                  <span className="font-semibold">Prepared By:</span>{' '}
                  <span className="inline-block border-b border-black w-44 align-bottom" />
                </div>
                <div>
                  <span className="font-semibold">Checked By:</span>{' '}
                  <span className="inline-block border-b border-black w-44 align-bottom" />
                </div>
              </footer>
            </section>
          ))}
        </div>
      )}
    </div>
  );
};
