import React, { useMemo, useState } from 'react';
import { Archive, Calendar, Clock, Cpu, Search, Timer } from 'lucide-react';
import { ProductionJob, ProductionWorkspaceV5 } from '../types';
import {
  extractCompletedPlateBreakdown,
  filterCompletedArchiveJobs,
  isCompletedAutoArchived,
  resolveCompletedTimestampLabel,
} from '../utils/completedPlateUtils';
import {
  formatDurationHoursMinutes,
  MALAYSIA_TIMEZONE,
} from '../utils/dateFormat';
import { CompletedPlateExpandedDetails } from './CompletedPlateDetails';
import { DateInputDDMMYYYY } from './DateInputDDMMYYYY';

interface CompletedArchivePanelProps {
  workspace: ProductionWorkspaceV5;
  nowMs: number;
  projectFilter: string;
  colorFilter: string;
  machineFilter: string;
  initialExpandedJobIds?: ReadonlySet<string>;
}

/**
 * Searchable, Malaysia-date-filterable Completed Archive panel displaying
 * plates automatically archived after 72 hours (or manually archived while Completed).
 * Preserves all historical snapshots, timestamps, variation breakdowns, and analytics.
 */
export const CompletedArchivePanel: React.FC<CompletedArchivePanelProps> = ({
  workspace,
  nowMs,
  projectFilter,
  colorFilter,
  machineFilter,
  initialExpandedJobIds,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set(initialExpandedJobIds ? Array.from(initialExpandedJobIds) : [])
  );

  const archiveResult = useMemo(
    () =>
      filterCompletedArchiveJobs(workspace.jobs, {
        workspace,
        nowMs,
        searchQuery,
        projectId: projectFilter,
        colorId: colorFilter,
        machineId: machineFilter,
        dateFrom,
        dateTo,
        timeZone: MALAYSIA_TIMEZONE,
      }),
    [
      workspace,
      nowMs,
      searchQuery,
      projectFilter,
      colorFilter,
      machineFilter,
      dateFrom,
      dateTo,
    ]
  );

  const hasArchiveFilters = Boolean(searchQuery.trim() || dateFrom || dateTo);

  const toggleExpand = (jobId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) {
        next.delete(jobId);
      } else {
        next.add(jobId);
      }
      return next;
    });
  };

  return (
    <section
      aria-label="Completed Archive"
      className="space-y-4"
    >
      {/* Archive Summary Header + Search & Malaysia Date Filter Controls */}
      <div className="bg-surface border border-line rounded-xl p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <Archive className="w-4 h-4 text-brand-text shrink-0" aria-hidden="true" />
              <h2 className="text-sm font-semibold text-ink">
                Completed Archive (3+ Days / 72h+)
              </h2>
            </div>
            <p className="text-xs text-muted">
              Plates automatically move here 72 hours after completion. Production totals, machine history, and analytics remain preserved.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 text-xs font-mono-data">
            <div className="px-3 py-1.5 rounded-lg bg-recessed border border-line">
              <span className="text-muted">Archived Plates: </span>
              <b className="text-ink">{archiveResult.totalArchivedPlates}</b>
            </div>
            <div className="px-3 py-1.5 rounded-lg bg-brand-soft border border-brand-border">
              <span className="text-brand-text">Archived Quantity Total: </span>
              <b className="text-brand-text">
                {archiveResult.totalArchivedUnits.toLocaleString()} pcs
              </b>
            </div>
          </div>
        </div>

        {/* Search + Completion Date Range (Malaysia Calendar Dates) */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end pt-3 border-t border-line">
          <div className="md:col-span-6">
            <label
              htmlFor="completed-archive-search-input"
              className="block text-[11px] font-medium text-muted mb-1"
            >
              Search Project, Product, or Filament Color
            </label>
            <div className="relative flex items-center">
              <Search
                className="w-3.5 h-3.5 text-muted absolute left-3 pointer-events-none"
                aria-hidden="true"
              />
              <input
                id="completed-archive-search-input"
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search project, product name, filament color, variation, or plate..."
                className="w-full pl-8 pr-3 py-2 rounded-lg border border-line bg-input text-xs text-ink placeholder:text-muted focus:border-brand focus:outline-none"
              />
            </div>
          </div>

          <div className="md:col-span-3">
            <label className="flex items-center gap-1 text-[11px] font-medium text-muted mb-1">
              <Calendar className="w-3 h-3 shrink-0" aria-hidden="true" />
              <span>Completed From (MYT)</span>
            </label>
            <DateInputDDMMYYYY
              ariaLabel="Completed Archive From Date (DD/MM/YYYY MYT)"
              value={dateFrom}
              onChange={setDateFrom}
            />
          </div>

          <div className="md:col-span-3">
            <label className="flex items-center gap-1 text-[11px] font-medium text-muted mb-1">
              <Calendar className="w-3 h-3 shrink-0" aria-hidden="true" />
              <span>Completed To (MYT)</span>
            </label>
            <DateInputDDMMYYYY
              ariaLabel="Completed Archive To Date (DD/MM/YYYY MYT)"
              value={dateTo}
              onChange={setDateTo}
            />
          </div>
        </div>

        {hasArchiveFilters && (
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs pt-1">
            <span className="font-mono-data text-ink-secondary">
              Matching <b className="text-ink">{archiveResult.jobs.length}</b> of{' '}
              {archiveResult.totalArchivedPlates} archived plate(s) ·{' '}
              <b className="text-brand-text">
                {archiveResult.filteredUnits.toLocaleString()} pcs
              </b>
            </span>
            <button
              type="button"
              onClick={() => {
                setSearchQuery('');
                setDateFrom('');
                setDateTo('');
              }}
              className="text-xs font-medium text-brand-text hover:underline"
            >
              Clear Archive Search &amp; Dates
            </button>
          </div>
        )}
      </div>

      {/* Archived Completed Plates List */}
      {archiveResult.jobs.length === 0 ? (
        <div className="bg-surface border border-line rounded-xl p-10 text-center space-y-1.5">
          <div className="text-sm font-medium text-ink">
            {archiveResult.totalArchivedPlates === 0
              ? 'No Completed plates have reached the 72-hour archive window yet.'
              : 'No archived plates match your current search or date range.'}
          </div>
          <div className="text-xs text-muted">
            Completed plates remain in Active Queue for 72 hours before appearing here automatically.
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 items-start">
          {archiveResult.jobs.map((job: ProductionJob) => {
            const project = workspace.projects.find((p) => p.id === job.projectId);
            const color = workspace.colors.find((c) => c.id === job.colorId);
            const machine = job.machineId
              ? workspace.machines.find((m) => m.id === job.machineId) || null
              : null;
            const breakdown = extractCompletedPlateBreakdown(job);
            const completedAtLabel = resolveCompletedTimestampLabel(
              job,
              MALAYSIA_TIMEZONE
            );
            const isAuto = isCompletedAutoArchived(job, nowMs);
            const isExpanded = expandedIds.has(job.id);
            const visibleItems = isExpanded
              ? breakdown.items
              : breakdown.items.slice(0, 8);
            const hiddenCount = Math.max(
              0,
              breakdown.items.length - visibleItems.length
            );

            return (
              <article
                key={job.id}
                className="min-w-0 w-full max-w-full bg-surface border border-line rounded-xl p-3.5 space-y-2.5"
              >
                {/* Header: Plate Number, Project, Product, Filament Color */}
                <div className="flex items-start justify-between gap-2 min-w-0">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-sm font-semibold text-ink">
                        Plate {job.plateNumber}
                      </span>
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-recessed border border-line text-muted">
                        {isAuto && !job.archived ? 'Auto-Archived (72h+)' : 'Archived'}
                      </span>
                    </div>

                    <div
                      className="text-[11px] font-semibold text-ink truncate"
                      title={`Project: ${project?.name || 'Project'}`}
                    >
                      {project?.name || 'Project'}
                    </div>

                    <div className="text-[11px] text-ink-secondary truncate">
                      Product:{' '}
                      <span className="font-medium text-ink">
                        {breakdown.productName ||
                          project?.productType ||
                          'Standard Product'}
                      </span>
                    </div>

                    <div className="text-[11px] flex items-center gap-1.5 truncate">
                      {color ? (
                        <>
                          <span
                            className="w-2.5 h-2.5 rounded-full shrink-0 border border-line"
                            style={{ backgroundColor: color.hex }}
                            aria-hidden="true"
                          />
                          <span className="font-medium text-ink-secondary truncate">
                            {color.name}
                          </span>
                        </>
                      ) : (
                        <span className="text-muted italic">Unassigned Color</span>
                      )}
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <div className="text-xs font-mono-data font-bold text-brand-text whitespace-nowrap">
                      {breakdown.hasRecordedBreakdown
                        ? `${breakdown.totalQuantity.toLocaleString()} pcs`
                        : 'Not recorded'}
                    </div>
                  </div>
                </div>

                {/* Completed At (MYT) + Machine + Duration */}
                <div className="rounded-lg border border-line bg-elevated px-2.5 py-2 space-y-1 text-[11px]">
                  <div className="flex flex-wrap items-center justify-between gap-1.5">
                    <span className="inline-flex items-center gap-1 text-muted font-medium">
                      <Clock className="w-3 h-3 shrink-0" aria-hidden="true" />
                      <span>Completed At</span>
                    </span>
                    <span
                      className={`font-mono-data ${
                        completedAtLabel === 'Not recorded'
                          ? 'text-muted italic'
                          : 'font-semibold text-ink'
                      }`}
                    >
                      {completedAtLabel}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-1.5">
                    <span className="inline-flex items-center gap-1 text-muted">
                      <Cpu className="w-3 h-3 shrink-0" aria-hidden="true" />
                      <span>Machine</span>
                    </span>
                    <span className="font-medium text-ink">
                      {machine ? machine.name : 'Unassigned'}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-1.5">
                    <span className="inline-flex items-center gap-1 text-muted">
                      <Timer className="w-3 h-3 shrink-0" aria-hidden="true" />
                      <span>Duration</span>
                    </span>
                    <span className="font-mono-data font-medium text-ink">
                      {formatDurationHoursMinutes(
                        job.actualMinutes || job.estimatedMinutes
                      )}
                    </span>
                  </div>
                </div>

                {/* Variation Breakdown */}
                <div className="rounded-lg border border-line bg-recessed px-2.5 py-2 space-y-1.5 min-w-0">
                  {!breakdown.hasRecordedBreakdown ? (
                    <div className="text-xs text-muted italic">
                      Variation Breakdown: Not recorded
                    </div>
                  ) : !breakdown.hasVariations ? (
                    <div className="flex items-center justify-between gap-2 text-xs text-ink">
                      <span className="font-medium break-words">
                        {breakdown.items.map((it) => it.label).join(' · ')}
                      </span>
                      <span className="font-mono-data font-bold whitespace-nowrap">
                        Total: {breakdown.totalQuantity.toLocaleString()} pcs
                      </span>
                    </div>
                  ) : (
                    <>
                      <div className="flex flex-wrap gap-1.5 min-w-0">
                        {visibleItems.map((item) => (
                          <span
                            key={item.key}
                            className="inline-flex items-center gap-1 max-w-full px-2 py-0.5 rounded-md border border-line bg-surface text-[11px] text-ink min-w-0 break-words"
                          >
                            <span className="font-medium break-words">
                              {item.label}
                            </span>
                            <span className="font-mono-data font-bold text-brand-text shrink-0">
                              × {item.quantity.toLocaleString()}
                            </span>
                          </span>
                        ))}
                        {!isExpanded && hiddenCount > 0 && (
                          <button
                            type="button"
                            onClick={() => toggleExpand(job.id)}
                            className="inline-flex items-center px-2 py-0.5 rounded-md border border-brand-border bg-brand-soft text-[11px] font-semibold text-brand-text"
                          >
                            +{hiddenCount} more
                          </button>
                        )}
                      </div>
                      <div className="pt-1 border-t border-line flex items-center justify-between text-[11px]">
                        <span className="text-muted font-medium">
                          Total Completed
                        </span>
                        <span className="font-mono-data font-bold text-ink">
                          {breakdown.totalQuantity.toLocaleString()} pcs
                        </span>
                      </div>
                    </>
                  )}
                </div>

                {/* Footer Toggle for Full Details */}
                <div className="pt-1.5 border-t border-line flex items-center justify-between gap-2 text-[11px] text-muted">
                  <span>
                    {job.failedCount > 0
                      ? `Previous Fails: ${job.failedCount}`
                      : 'Historical Record'}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggleExpand(job.id)}
                    className="text-brand-text font-medium hover:underline"
                  >
                    {isExpanded ? 'Hide Details' : 'Details & Breakdown'}
                  </button>
                </div>

                {isExpanded && (
                  <div className="pt-2 border-t border-line">
                    <CompletedPlateExpandedDetails
                      job={job}
                      project={project}
                      color={color}
                      machine={machine}
                    />
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
};
