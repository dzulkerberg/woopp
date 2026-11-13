import React from 'react';
import { Clock, Layers, PackageCheck } from 'lucide-react';
import { ColorOption, PrinterMachine, ProductionJob, ProductionProject } from '../types';
import {
  extractCompletedPlateBreakdown,
  resolveCompletedTimestampLabel,
} from '../utils/completedPlateUtils';
import { MALAYSIA_TIMEZONE } from '../utils/dateFormat';

const COMPACT_CHIP_LIMIT = 8;

interface CompletedPlateSummaryBlockProps {
  job: ProductionJob;
  expanded: boolean;
  onToggleExpand: () => void;
}

/**
 * Compact card body rendered on Completed Kanban cards:
 * - Completed Date & Time in Malaysia Time (or "Not recorded" for legacy records)
 * - Exact persisted plate-level Product & Variation Breakdown + Total Completed pcs
 */
export const CompletedPlateSummaryBlock: React.FC<CompletedPlateSummaryBlockProps> = ({
  job,
  expanded,
  onToggleExpand,
}) => {
  const completedAtLabel = resolveCompletedTimestampLabel(job, MALAYSIA_TIMEZONE);
  const breakdown = extractCompletedPlateBreakdown(job);
  const isMissingTimestamp = completedAtLabel === 'Not recorded';

  const visibleItems = expanded
    ? breakdown.items
    : breakdown.items.slice(0, COMPACT_CHIP_LIMIT);
  const hiddenCount = Math.max(0, breakdown.items.length - visibleItems.length);

  return (
    <div className="min-w-0 space-y-2.5">
      {/* Completed Date & Time */}
      <div className="min-w-0 rounded-lg border border-line bg-elevated px-2.5 py-2 space-y-0.5">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
          <Clock className="w-3 h-3 shrink-0" aria-hidden="true" />
          <span>Completed At</span>
        </div>
        <div
          className={`text-xs font-mono-data break-words ${
            isMissingTimestamp ? 'text-muted italic font-normal' : 'text-ink font-semibold'
          }`}
        >
          {completedAtLabel}
        </div>
      </div>

      {/* Persisted Plate-Level Variation Breakdown */}
      <div className="min-w-0 rounded-lg border border-line bg-recessed px-2.5 py-2 space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-1.5 min-w-0">
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted min-w-0">
            <Layers className="w-3 h-3 shrink-0" aria-hidden="true" />
            <span className="truncate">
              {breakdown.productName || 'Variation Breakdown'}
            </span>
          </span>
          {breakdown.hasRecordedBreakdown && (
            <span className="text-[11px] font-mono-data font-bold text-brand-text whitespace-nowrap">
              {breakdown.totalQuantity.toLocaleString()} pcs
            </span>
          )}
        </div>

        {!breakdown.hasRecordedBreakdown ? (
          <div className="text-xs text-muted italic break-words">
            Variation Breakdown: Not recorded
          </div>
        ) : !breakdown.hasVariations ? (
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink min-w-0">
            <span className="font-medium break-words">
              {breakdown.items.map((it) => it.label).join(' · ')}
            </span>
            <span className="font-mono-data font-bold text-ink whitespace-nowrap">
              Total: {breakdown.totalQuantity.toLocaleString()} pcs
            </span>
          </div>
        ) : (
          <div className="space-y-1.5 min-w-0">
            <div className="flex flex-wrap gap-1.5 min-w-0">
              {visibleItems.map((item) => (
                <span
                  key={item.key}
                  className="inline-flex items-center gap-1 max-w-full px-2 py-0.5 rounded-md border border-line bg-surface text-[11px] text-ink min-w-0 break-words"
                >
                  <span className="font-medium break-words">{item.label}</span>
                  <span className="font-mono-data font-bold text-brand-text shrink-0">
                    × {item.quantity.toLocaleString()}
                  </span>
                </span>
              ))}
              {!expanded && hiddenCount > 0 && (
                <button
                  type="button"
                  onClick={onToggleExpand}
                  className="inline-flex items-center px-2 py-0.5 rounded-md border border-brand-border bg-brand-soft text-[11px] font-semibold text-brand-text hover:opacity-90 transition-opacity"
                >
                  +{hiddenCount} more
                </button>
              )}
            </div>

            <div className="pt-1 border-t border-line flex items-center justify-between gap-2 text-[11px] min-w-0">
              <span className="inline-flex items-center gap-1 text-muted font-medium">
                <PackageCheck className="w-3 h-3 shrink-0" aria-hidden="true" />
                <span>Total Completed</span>
              </span>
              <span className="font-mono-data font-bold text-ink whitespace-nowrap">
                {breakdown.totalQuantity.toLocaleString()} pcs
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

interface CompletedPlateExpandedDetailsProps {
  job: ProductionJob;
  project?: ProductionProject;
  color?: ColorOption;
  machine?: PrinterMachine | null;
}

/**
 * Full Completed plate inspection panel displayed inside Expanded Plate Details:
 * - Never truncates variations even when all 26+ variants exist
 * - Displays Completed At (MYT), Product, Project, Filament Color, Failed Attempts separately from Completed output
 */
export const CompletedPlateExpandedDetails: React.FC<CompletedPlateExpandedDetailsProps> = ({
  job,
  project,
  color,
  machine,
}) => {
  const completedAtLabel = resolveCompletedTimestampLabel(job, MALAYSIA_TIMEZONE);
  const breakdown = extractCompletedPlateBreakdown(job);

  return (
    <div className="rounded-lg border border-line bg-recessed p-2.5 space-y-2 text-xs min-w-0">
      <div className="text-[11px] font-semibold text-ink">
        Completed Plate Details
      </div>

      <div className="grid grid-cols-1 gap-1 text-[11px] min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-muted">Status</span>
          <span className="font-semibold text-brand-text">
            Completed{job.archived ? ' (Archived)' : ''}
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-muted">Plate</span>
          <span className="font-mono-data font-semibold text-ink">
            Plate {job.plateNumber}
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
          <span className="text-muted">Project</span>
          <span className="font-medium text-ink break-words text-right">
            {project?.name || 'Project'}
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
          <span className="text-muted">Product</span>
          <span className="font-medium text-ink break-words text-right">
            {breakdown.productName || project?.productType || 'Standard Product'}
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
          <span className="text-muted">Filament Color</span>
          <span className="inline-flex items-center gap-1.5 font-medium text-ink">
            {color && (
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0 border border-line"
                style={{ backgroundColor: color.hex }}
                aria-hidden="true"
              />
            )}
            <span>{color?.name || 'Unassigned Color'}</span>
          </span>
        </div>
        {machine && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-muted">Printer</span>
            <span className="font-medium text-ink">{machine.name}</span>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-muted">Completed At</span>
          <span
            className={`font-mono-data text-right break-words ${
              completedAtLabel === 'Not recorded'
                ? 'text-muted italic'
                : 'font-semibold text-ink'
            }`}
          >
            {completedAtLabel}
          </span>
        </div>
        {breakdown.failedAttempts > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-muted">Previous Failed Attempts</span>
            <span className="font-mono-data font-semibold text-warning-text">
              {breakdown.failedAttempts} failed run{breakdown.failedAttempts === 1 ? '' : 's'}
            </span>
          </div>
        )}
      </div>

      {/* Complete, Un-truncated Variation Breakdown */}
      <div className="pt-2 border-t border-line space-y-1.5 min-w-0">
        <div className="text-[11px] font-semibold text-ink-secondary">
          Full Variation Breakdown
        </div>
        {!breakdown.hasRecordedBreakdown ? (
          <div className="text-[11px] text-muted italic">
            Variation Breakdown: Not recorded
          </div>
        ) : (
          <>
            <div className="space-y-1 min-w-0">
              {breakdown.items.map((item) => (
                <div
                  key={item.key}
                  className="flex items-start justify-between gap-2 px-2 py-1 rounded border border-line bg-surface text-[11px] min-w-0"
                >
                  <div className="min-w-0 break-words">
                    <span className="font-medium text-ink">{item.label}</span>
                    {item.sku && (
                      <span className="ml-1.5 text-[10px] font-mono-data text-muted">
                        [{item.sku}]
                      </span>
                    )}
                  </div>
                  <span className="font-mono-data font-bold text-brand-text whitespace-nowrap shrink-0">
                    × {item.quantity.toLocaleString()} pcs
                  </span>
                </div>
              ))}
            </div>
            <div className="pt-1 flex items-center justify-between gap-2 text-[11px] font-semibold text-ink">
              <span>Total Completed</span>
              <span className="font-mono-data text-brand-text">
                {breakdown.totalQuantity.toLocaleString()} pcs
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
