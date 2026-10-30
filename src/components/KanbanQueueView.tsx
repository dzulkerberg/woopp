import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, RotateCcw, Trash2, XCircle } from 'lucide-react';
import {
  ACTIVE_KANBAN_STAGES,
  countPlateKeycaps,
  KANBAN_STAGES,
} from '../constants';
import {
  EtaRecalibrationInput,
  KanbanStage,
  ProductionJob,
  ProductionWorkspaceV5,
  QueueLifecycleTab,
} from '../types';
import {
  formatCountdownHMS,
  formatDateTimeDDMMYYYY,
  formatDurationHoursMinutes,
} from '../utils/dateFormat';
import {
  ETA_NEEDS_RECALIBRATION_LABEL,
  ETA_REACHED_LABEL,
  parseUtcTimestampMs,
} from '../utils/productionCountdown';
import {
  canArchivePlate,
  canDeletePlate,
  canRestorePlate,
  filterQueueJobs,
} from '../utils/productionEngine';
import { GlobalScheduleResult } from '../utils/schedulingEngine';
import { DurationHMInput } from './DurationHMInput';
import { EtaRecalibrationBox } from './EtaRecalibrationBox';
import { PlateCompositionSummary } from './PlateCompositionSummary';
import {
  BulkQueueActionKind,
  PlateLifecycleMenu,
} from './QueueLifecycleModals';

interface KanbanQueueViewProps {
  workspace: ProductionWorkspaceV5;
  schedule: GlobalScheduleResult;
  selectedProjectId: string;
  isAdmin: boolean;
  busyJobIds: ReadonlySet<string>;
  onSelectProject: (projectId: string) => void;
  onTransitionStage: (
    jobId: string,
    nextStage: KanbanStage,
    opts?: { machineId?: string | null; actualMinutes?: number; failureReason?: string }
  ) => void;
  onPauseOrResume: (
    jobId: string,
    action: 'pause' | 'resume' | 'update_remaining',
    overrideRemainingMinutes?: number
  ) => void;
  onRecalibrateJobEta: (jobId: string, input: EtaRecalibrationInput) => void;
  onUpdateJobMetadata: (
    jobId: string,
    updates: Partial<
      Pick<
        ProductionJob,
        | 'machineId'
        | 'estimatedMinutes'
        | 'actualMinutes'
        | 'notes'
        | 'slicerVerified'
        | 'failureReason'
        | 'machineDurationOverrides'
      >
    >
  ) => void;
  onCopyQueueSummary: (jobs: ProductionJob[]) => void;
  onRequestDeletePlate: (job: ProductionJob) => void;
  onRequestCancelPrinting: (job: ProductionJob) => void;
  onArchivePlate: (job: ProductionJob) => void;
  onRestorePlate: (job: ProductionJob) => void;
  onRequestBulkAction: (action: BulkQueueActionKind, jobs: ProductionJob[]) => void;
}

const ARCHIVED_STAGES: KanbanStage[] = [
  'Completed',
  'Failed / Reprint',
  'Cancelled',
];

export const KanbanQueueView: React.FC<KanbanQueueViewProps> = ({
  workspace,
  schedule,
  selectedProjectId,
  isAdmin,
  busyJobIds,
  onSelectProject,
  onTransitionStage,
  onPauseOrResume,
  onRecalibrateJobEta,
  onUpdateJobMetadata,
  onCopyQueueSummary,
  onRequestDeletePlate,
  onRequestCancelPrinting,
  onArchivePlate,
  onRestorePlate,
  onRequestBulkAction,
}) => {
  const [lifecycleTab, setLifecycleTab] = useState<QueueLifecycleTab>('active');
  const [projectFilter, setProjectFilter] = useState<string>(
    selectedProjectId || 'ALL'
  );
  const [colorFilter, setColorFilter] = useState<string>('ALL');
  const [machineFilter, setMachineFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [viewMode, setViewMode] = useState<'kanban' | 'list'>('kanban');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const selectAllRef = useRef<HTMLInputElement | null>(null);

  // Tab-level base counts (respecting project/color/machine filters so badges reflect current scope)
  const tabCounts = useMemo(() => {
    const baseScope = {
      projectId: projectFilter,
      colorId: colorFilter,
      machineId: machineFilter,
      status: 'ALL',
    };
    return {
      active: filterQueueJobs(workspace.jobs, { ...baseScope, tab: 'active' }).length,
      cancelled: filterQueueJobs(workspace.jobs, { ...baseScope, tab: 'cancelled' }).length,
      archived: filterQueueJobs(workspace.jobs, { ...baseScope, tab: 'archived' }).length,
      all: filterQueueJobs(workspace.jobs, { ...baseScope, tab: 'all' }).length,
    };
  }, [workspace.jobs, projectFilter, colorFilter, machineFilter]);

  // Single shared source-of-truth filtered array used identically by Kanban Board and Table View
  const filteredJobs = useMemo(
    () =>
      filterQueueJobs(workspace.jobs, {
        tab: lifecycleTab,
        projectId: projectFilter,
        colorId: colorFilter,
        machineId: machineFilter,
        status: statusFilter,
      }),
    [
      workspace.jobs,
      lifecycleTab,
      projectFilter,
      colorFilter,
      machineFilter,
      statusFilter,
    ]
  );

  // Keep selectedIds scoped strictly to currently visible filteredJobs to prevent hidden bulk actions
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const visibleSet = new Set(filteredJobs.map((j) => j.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (visibleSet.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [filteredJobs]);

  // Determine Kanban columns for the active lifecycle tab & status filter so every filteredJob is visible
  const visibleKanbanColumns = useMemo<KanbanStage[]>(() => {
    let baseCols: KanbanStage[];
    if (lifecycleTab === 'active') {
      baseCols = [...ACTIVE_KANBAN_STAGES];
    } else if (lifecycleTab === 'cancelled') {
      baseCols = ['Cancelled'];
    } else if (lifecycleTab === 'archived') {
      const extraStages = KANBAN_STAGES.filter(
        (st) => !ARCHIVED_STAGES.includes(st) && filteredJobs.some((j) => j.stage === st)
      );
      baseCols = [...ARCHIVED_STAGES, ...extraStages];
    } else {
      baseCols = [...KANBAN_STAGES];
    }

    if (statusFilter !== 'ALL') {
      return baseCols.includes(statusFilter as KanbanStage)
        ? [statusFilter as KanbanStage]
        : [statusFilter as KanbanStage];
    }
    return baseCols;
  }, [lifecycleTab, statusFilter, filteredJobs]);

  const selectedJobs = useMemo(
    () => filteredJobs.filter((j) => selectedIds.has(j.id)),
    [filteredJobs, selectedIds]
  );

  const selectedTotalKeycaps = useMemo(
    () => selectedJobs.reduce((sum, j) => sum + countPlateKeycaps(j), 0),
    [selectedJobs]
  );

  const deletableInView = useMemo(
    () => filteredJobs.filter((j) => canDeletePlate(j)),
    [filteredJobs]
  );
  const archivableInView = useMemo(
    () => filteredJobs.filter((j) => canArchivePlate(j)),
    [filteredJobs]
  );
  const restorableInView = useMemo(
    () => filteredJobs.filter((j) => canRestorePlate(j)),
    [filteredJobs]
  );

  const allSelectedCanDelete =
    selectedJobs.length > 0 && selectedJobs.every((j) => canDeletePlate(j));
  const allSelectedCanArchive =
    selectedJobs.length > 0 && selectedJobs.every((j) => canArchivePlate(j));
  const allSelectedCanRestore =
    selectedJobs.length > 0 && selectedJobs.every((j) => canRestorePlate(j));

  const someSelectedCanDeleteCount = selectedJobs.filter((j) => canDeletePlate(j)).length;
  const someSelectedCanArchiveCount = selectedJobs.filter((j) => canArchivePlate(j)).length;

  const allVisibleSelected =
    filteredJobs.length > 0 && selectedJobs.length === filteredJobs.length;
  const partiallySelected =
    selectedJobs.length > 0 && selectedJobs.length < filteredJobs.length;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = partiallySelected;
    }
  }, [partiallySelected]);

  const toggleSelectAllVisible = () => {
    if (allVisibleSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredJobs.map((j) => j.id)));
    }
  };

  const toggleSelectOne = (jobId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) {
        next.delete(jobId);
      } else {
        next.add(jobId);
      }
      return next;
    });
  };

  const handleSwitchTab = (nextTab: QueueLifecycleTab) => {
    setLifecycleTab(nextTab);
    if (nextTab === 'cancelled') {
      setStatusFilter('ALL');
    } else if (nextTab === 'active' && statusFilter === 'Cancelled') {
      setStatusFilter('ALL');
    }
  };

  const { timezone } = schedule;
  const filteredTotalKeycaps = useMemo(
    () => filteredJobs.reduce((sum, j) => sum + countPlateKeycaps(j), 0),
    [filteredJobs]
  );

  const TABS: { id: QueueLifecycleTab; label: string; count: number }[] = [
    { id: 'active', label: 'Active Queue', count: tabCounts.active },
    { id: 'cancelled', label: 'Cancelled', count: tabCounts.cancelled },
    { id: 'archived', label: 'Archived', count: tabCounts.archived },
    { id: 'all', label: 'All Plates', count: tabCounts.all },
  ];

  return (
    <div className="space-y-5">
      {/* Lifecycle Tabs + Filter Bar */}
      <div className="bg-surface border border-line rounded-xl p-4 space-y-4">
        {/* Top Row: Lifecycle Tabs & View Switcher */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3.5">
          <div
            role="tablist"
            aria-label="Print queue lifecycle views"
            className="flex flex-wrap items-center gap-1 p-1 bg-recessed rounded-xl border border-line"
          >
            {TABS.map((tab) => {
              const active = lifecycleTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => handleSwitchTab(tab.id)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap ${
                    active
                      ? 'bg-surface text-ink border border-line shadow-xs'
                      : 'text-ink-secondary hover:text-ink'
                  }`}
                >
                  <span>{tab.label}</span>
                  <span
                    className={`font-mono-data text-[11px] px-1.5 py-0.5 rounded-md ${
                      active
                        ? 'bg-brand-soft text-brand-text font-semibold'
                        : 'bg-elevated text-muted'
                    }`}
                  >
                    {tab.count}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 p-1 bg-recessed rounded-lg border border-line">
              <button
                type="button"
                onClick={() => setViewMode('kanban')}
                className={`px-2.5 py-1 text-xs font-medium rounded-md whitespace-nowrap transition-colors ${
                  viewMode === 'kanban'
                    ? 'bg-surface text-ink border border-line shadow-xs'
                    : 'text-ink-secondary hover:text-ink'
                }`}
              >
                Kanban Board
              </button>
              <button
                type="button"
                onClick={() => setViewMode('list')}
                className={`px-2.5 py-1 text-xs font-medium rounded-md whitespace-nowrap transition-colors ${
                  viewMode === 'list'
                    ? 'bg-surface text-ink border border-line shadow-xs'
                    : 'text-ink-secondary hover:text-ink'
                }`}
              >
                Table View
              </button>
            </div>

            <button
              type="button"
              onClick={() => onCopyQueueSummary(filteredJobs)}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-line bg-elevated text-ink hover:bg-recessed whitespace-nowrap transition-colors"
            >
              Copy Queue
            </button>
          </div>
        </div>

        {/* Bottom Row: Shared Filters (Project, Color, Machine, Status) + Summary Count */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <select
              aria-label="Filter queue by project"
              value={projectFilter}
              onChange={(e) => {
                const val = e.target.value;
                setProjectFilter(val);
                if (val !== 'ALL') onSelectProject(val);
              }}
              className="px-3 py-1.5 rounded-lg border border-line bg-input text-xs text-ink focus:border-brand focus:outline-none"
            >
              <option value="ALL">All Projects</option>
              {workspace.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>

            <select
              aria-label="Filter queue by color"
              value={colorFilter}
              onChange={(e) => setColorFilter(e.target.value)}
              className="px-3 py-1.5 rounded-lg border border-line bg-input text-xs text-ink focus:border-brand focus:outline-none"
            >
              <option value="ALL">All Colors</option>
              {workspace.colors.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>

            <select
              aria-label="Filter queue by printer"
              value={machineFilter}
              onChange={(e) => setMachineFilter(e.target.value)}
              className="px-3 py-1.5 rounded-lg border border-line bg-input text-xs text-ink focus:border-brand focus:outline-none"
            >
              <option value="ALL">All Machines</option>
              <option value="UNASSIGNED">Unassigned (Auto-Schedule)</option>
              {workspace.machines.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>

            <select
              aria-label="Filter queue by status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-3 py-1.5 rounded-lg border border-line bg-input text-xs text-ink focus:border-brand focus:outline-none"
            >
              <option value="ALL">All Statuses</option>
              {(lifecycleTab === 'active'
                ? ACTIVE_KANBAN_STAGES
                : lifecycleTab === 'cancelled'
                ? (['Cancelled'] as KanbanStage[])
                : KANBAN_STAGES
              ).map((st) => (
                <option key={st} value={st}>
                  {st}
                </option>
              ))}
            </select>

            {(projectFilter !== 'ALL' ||
              colorFilter !== 'ALL' ||
              machineFilter !== 'ALL' ||
              statusFilter !== 'ALL') && (
              <button
                type="button"
                onClick={() => {
                  setProjectFilter('ALL');
                  setColorFilter('ALL');
                  setMachineFilter('ALL');
                  setStatusFilter('ALL');
                }}
                className="px-2.5 py-1.5 text-xs font-medium text-brand-text hover:underline whitespace-nowrap"
              >
                Reset Filters
              </button>
            )}
          </div>

          <div className="text-xs font-mono-data text-muted">
            Showing <b className="text-ink">{filteredJobs.length}</b>{' '}
            plate{filteredJobs.length === 1 ? '' : 's'} ·{' '}
            <b className="text-ink">
              {filteredTotalKeycaps.toLocaleString()}
            </b>{' '}
            pcs
          </div>
        </div>
      </div>

      {/* Bulk Selection Bar in Table View */}
      {viewMode === 'list' && filteredJobs.length > 0 && (
        <div className="bg-surface border border-line rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-mono-data font-semibold text-ink">
              {selectedJobs.length} plate{selectedJobs.length === 1 ? '' : 's'} selected
            </span>
            <span className="text-muted">·</span>
            <span className="font-mono-data text-ink-secondary">
              {selectedTotalKeycaps.toLocaleString()} keycaps affected
            </span>

            <div className="flex flex-wrap items-center gap-1.5 ml-1">
              {deletableInView.length > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    setSelectedIds(new Set(deletableInView.map((j) => j.id)))
                  }
                  className="px-2 py-1 rounded-md border border-line bg-elevated text-[11px] text-ink-secondary hover:text-ink hover:bg-recessed whitespace-nowrap transition-colors"
                >
                  Select Deletable ({deletableInView.length})
                </button>
              )}
              {archivableInView.length > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    setSelectedIds(new Set(archivableInView.map((j) => j.id)))
                  }
                  className="px-2 py-1 rounded-md border border-line bg-elevated text-[11px] text-ink-secondary hover:text-ink hover:bg-recessed whitespace-nowrap transition-colors"
                >
                  Select Archivable ({archivableInView.length})
                </button>
              )}
              {restorableInView.length > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    setSelectedIds(new Set(restorableInView.map((j) => j.id)))
                  }
                  className="px-2 py-1 rounded-md border border-line bg-elevated text-[11px] text-ink-secondary hover:text-ink hover:bg-recessed whitespace-nowrap transition-colors"
                >
                  Select Archived ({restorableInView.length})
                </button>
              )}
              {selectedJobs.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSelectedIds(new Set())}
                  className="px-2 py-1 text-[11px] text-muted hover:text-ink whitespace-nowrap"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {selectedJobs.length > 0 &&
              !allSelectedCanDelete &&
              someSelectedCanDeleteCount > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    setSelectedIds(
                      new Set(
                        selectedJobs.filter((j) => canDeletePlate(j)).map((j) => j.id)
                      )
                    )
                  }
                  className="text-[11px] text-warning-text hover:underline whitespace-nowrap"
                >
                  Keep only {someSelectedCanDeleteCount} deletable
                </button>
              )}

            {selectedJobs.length > 0 &&
              !allSelectedCanArchive &&
              someSelectedCanArchiveCount > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    setSelectedIds(
                      new Set(
                        selectedJobs.filter((j) => canArchivePlate(j)).map((j) => j.id)
                      )
                    )
                  }
                  className="text-[11px] text-brand-text hover:underline whitespace-nowrap"
                >
                  Keep only {someSelectedCanArchiveCount} archivable
                </button>
              )}

            {restorableInView.length > 0 && (
              <button
                type="button"
                disabled={!isAdmin || !allSelectedCanRestore}
                title={
                  !isAdmin
                    ? 'Admin permission required'
                    : !allSelectedCanRestore
                    ? 'Select only Archived plates to bulk restore'
                    : `Restore ${selectedJobs.length} archived plate(s)`
                }
                onClick={() => onRequestBulkAction('bulk_restore', selectedJobs)}
                className="px-3 py-1.5 rounded-lg border border-brand-border bg-brand-soft hover:bg-brand hover:text-white text-xs font-semibold text-brand-text disabled:opacity-40 flex items-center gap-1.5 whitespace-nowrap transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Bulk Restore</span>
              </button>
            )}

            <button
              type="button"
              disabled={!isAdmin || !allSelectedCanArchive}
              title={
                !isAdmin
                  ? 'Admin permission required'
                  : !allSelectedCanArchive
                  ? 'Select only Completed, Failed / Reprint, or Cancelled non-archived plates to bulk archive'
                  : `Archive ${selectedJobs.length} historical plate(s)`
              }
              onClick={() => onRequestBulkAction('bulk_archive', selectedJobs)}
              className="px-3 py-1.5 rounded-lg border border-line bg-elevated hover:bg-recessed text-xs font-semibold text-ink disabled:opacity-40 flex items-center gap-1.5 whitespace-nowrap transition-colors"
            >
              <Archive className="w-3.5 h-3.5" />
              <span>Bulk Archive</span>
            </button>

            <button
              type="button"
              disabled={!isAdmin || !allSelectedCanDelete}
              title={
                !isAdmin
                  ? 'Admin permission required'
                  : !allSelectedCanDelete
                  ? 'Only Planned and Ready to Print plates can be bulk deleted'
                  : `Delete ${selectedJobs.length} selected plate(s)`
              }
              onClick={() => onRequestBulkAction('bulk_delete', selectedJobs)}
              className="px-3 py-1.5 rounded-lg bg-status-error hover:opacity-90 text-white text-xs font-semibold disabled:opacity-40 flex items-center gap-1.5 whitespace-nowrap transition-opacity"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Bulk Delete</span>
            </button>
          </div>
        </div>
      )}

      {/* Kanban Board vs Table View (Strict Shared Filtered Dataset) */}
      {viewMode === 'kanban' ? (
        <div
          className={`grid grid-cols-1 md:grid-cols-2 ${
            visibleKanbanColumns.length === 1
              ? 'xl:grid-cols-1'
              : visibleKanbanColumns.length === 3
              ? 'xl:grid-cols-3'
              : visibleKanbanColumns.length >= 6
              ? 'xl:grid-cols-3 2xl:grid-cols-6'
              : 'xl:grid-cols-5'
          } gap-4 items-start`}
        >
          {visibleKanbanColumns.map((stage) => {
            const stageJobs = filteredJobs.filter((j) => j.stage === stage);
            const stageKeycaps = stageJobs.reduce(
              (s, j) => s + countPlateKeycaps(j),
              0
            );

            return (
              <div
                key={stage}
                className="min-w-0 bg-recessed border border-line rounded-xl p-3.5 space-y-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-1.5 px-1">
                  <h3 className="text-xs font-semibold text-ink">
                    {stage}
                  </h3>
                  <span className="text-xs font-mono-data text-muted">
                    {stageJobs.length} · {stageKeycaps.toLocaleString()} pcs
                  </span>
                </div>

                {stageJobs.length === 0 ? (
                  <div className="py-8 text-center text-xs text-muted border border-dashed border-line rounded-xl">
                    No plates in {stage}
                  </div>
                ) : (
                  <div
                    className={
                      visibleKanbanColumns.length === 1
                        ? 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3'
                        : 'space-y-3'
                    }
                  >
                    {stageJobs.map((job) => (
                      <KanbanJobCard
                        key={job.id}
                        job={job}
                        workspace={workspace}
                        schedule={schedule}
                        isAdmin={isAdmin}
                        isBusy={busyJobIds.has(job.id)}
                        onTransitionStage={onTransitionStage}
                        onPauseOrResume={onPauseOrResume}
                        onRecalibrateJobEta={onRecalibrateJobEta}
                        onUpdateJobMetadata={onUpdateJobMetadata}
                        onRequestDeletePlate={onRequestDeletePlate}
                        onRequestCancelPrinting={onRequestCancelPrinting}
                        onArchivePlate={onArchivePlate}
                        onRestorePlate={onRestorePlate}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : filteredJobs.length === 0 ? (
        <div className="bg-surface border border-line rounded-xl p-10 text-center space-y-2">
          <div className="text-sm font-medium text-ink">
            No print plates match the current view and filters.
          </div>
          <div className="text-xs text-muted">
            Switch lifecycle tabs above or reset filters to view plates across other stages.
          </div>
        </div>
      ) : (
        <div className="bg-surface border border-line rounded-xl overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-line text-muted bg-recessed">
                <th className="py-3 pl-4 pr-2 w-9">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    aria-label="Select all visible plates"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAllVisible}
                    className="rounded border-line"
                  />
                </th>
                <th className="py-3 px-3 font-medium">Plate</th>
                <th className="py-3 px-3 font-medium">Project &amp; Color</th>
                <th className="py-3 px-3 font-medium">Printer</th>
                <th className="py-3 px-3 font-medium">Bambu Est / Actual</th>
                <th className="py-3 px-3 font-medium">Scheduled ETA / Notes</th>
                <th className="py-3 px-3 font-medium">Status</th>
                <th className="py-3 pl-2 pr-4 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filteredJobs.map((job) => {
                const proj = workspace.projects.find((p) => p.id === job.projectId);
                const color = workspace.colors.find((c) => c.id === job.colorId);
                const qty = countPlateKeycaps(job);
                const slot = schedule.slotsByJobId[job.id];
                const isSelected = selectedIds.has(job.id);
                const isBusy = busyJobIds.has(job.id);
                const isReadOnlyStage =
                  Boolean(job.archived) || job.stage === 'Cancelled';
                const releasedMachine = job.cancelledFromMachineId
                  ? workspace.machines.find((m) => m.id === job.cancelledFromMachineId)
                  : null;

                return (
                  <tr
                    key={job.id}
                    className={`transition-colors ${
                      isSelected
                        ? 'bg-brand-soft'
                        : 'hover:bg-elevated'
                    }`}
                  >
                    <td className="py-3 pl-4 pr-2 align-top">
                      <input
                        type="checkbox"
                        aria-label={`Select Plate ${job.plateNumber} (${job.id})`}
                        checked={isSelected}
                        onChange={() => toggleSelectOne(job.id)}
                        className="mt-0.5 rounded border-line"
                      />
                    </td>
                    <td className="py-3 px-3 text-ink align-top">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-semibold font-mono-data whitespace-nowrap">
                          Plate {job.plateNumber} ({qty}/{job.plateCapacity})
                        </span>
                        {job.archived && (
                          <span className="text-[10px] font-medium text-muted">
                            · Archived
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] font-mono-data text-muted mt-0.5">
                        {job.id}
                      </div>
                      <div className="mt-1">
                        <PlateCompositionSummary
                          letters={job.letters}
                          charms={job.charms}
                          compact
                        />
                      </div>
                    </td>
                    <td className="py-3 px-3 text-ink-secondary align-top">
                      <div className="font-medium text-ink">
                        {proj?.name || 'Project'}
                      </div>
                      <div className="text-muted flex items-center gap-1.5 mt-0.5">
                        {color && (
                          <span
                            className="w-2 h-2 rounded-full shrink-0 border border-line"
                            style={{ backgroundColor: color.hex }}
                          />
                        )}
                        <span>{color?.name || 'Color'}</span>
                      </div>
                    </td>
                    <td className="py-3 px-3 align-top">
                      {isReadOnlyStage ? (
                        <span className="text-muted">
                          {job.stage === 'Cancelled'
                            ? releasedMachine
                              ? `Released (${releasedMachine.name})`
                              : 'Released (Unassigned)'
                            : job.machineId
                            ? workspace.machines.find((m) => m.id === job.machineId)?.name ||
                              'Assigned'
                            : 'Unassigned'}
                        </span>
                      ) : (
                        <select
                          aria-label={`Printer for Plate ${job.plateNumber}`}
                          disabled={isBusy}
                          value={job.machineId || ''}
                          onChange={(e) =>
                            onUpdateJobMetadata(job.id, {
                              machineId: e.target.value || null,
                            })
                          }
                          className="px-2 py-1 rounded border border-line bg-input text-ink focus:border-brand focus:outline-none"
                        >
                          <option value="">Auto-Schedule</option>
                          {workspace.machines.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name} ({m.status})
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="py-3 px-3 font-mono-data text-ink-secondary whitespace-nowrap align-top">
                      {formatDurationHoursMinutes(job.estimatedMinutes)} /{' '}
                      {job.actualMinutes
                        ? formatDurationHoursMinutes(job.actualMinutes)
                        : '—'}
                    </td>
                    <td className="py-3 px-3 font-mono-data align-top">
                      {job.stage === 'Cancelled' ? (
                        <div className="space-y-0.5">
                          <div className="text-error-text font-sans font-medium">
                            Cancelled{' '}
                            {job.cancelledIso
                              ? formatDateTimeDDMMYYYY(new Date(job.cancelledIso), timezone)
                              : ''}
                          </div>
                          {job.cancellationReason && (
                            <div className="text-[11px] font-sans text-muted max-w-xs truncate">
                              Reason: {job.cancellationReason}
                            </div>
                          )}
                        </div>
                      ) : job.stage === 'Completed' ? (
                        <span className="text-brand-text font-semibold whitespace-nowrap">
                          Done{' '}
                          {(() => {
                            const doneMs =
                              parseUtcTimestampMs(job.actualCompletedAt) ??
                              job.actualCompletedAtMs ??
                              parseUtcTimestampMs(job.completedIso);
                            return doneMs ? formatDateTimeDDMMYYYY(doneMs, timezone) : '';
                          })()}
                        </span>
                      ) : job.stage === 'Printing' && slot ? (
                        slot.needsEtaRecalibration ? (
                          <span className="text-warning-text font-sans font-semibold whitespace-nowrap">
                            {ETA_NEEDS_RECALIBRATION_LABEL}
                          </span>
                        ) : slot.isAwaitingConfirmation ? (
                          <div className="space-y-0.5">
                            <div className="text-brand-text font-sans font-semibold whitespace-nowrap">
                              {ETA_REACHED_LABEL}
                            </div>
                            <div className="text-[11px] text-muted">
                              00:00:00
                              {slot.endMs
                                ? ` · ETA ${formatDateTimeDDMMYYYY(slot.endMs, timezone)}`
                                : ''}
                            </div>
                          </div>
                        ) : (
                          <span
                            className={
                              slot.isPaused
                                ? 'text-warning-text font-semibold whitespace-nowrap'
                                : 'text-brand-text font-semibold whitespace-nowrap'
                            }
                          >
                            {slot.isPaused ? 'Paused ' : ''}
                            {formatCountdownHMS(slot.remainingSecondsLive)} →{' '}
                            {slot.endMs
                              ? formatDateTimeDDMMYYYY(slot.endMs, timezone)
                              : ''}
                          </span>
                        )
                      ) : slot?.endMs ? (
                        <span
                          className={
                            slot.exceedsProjectDeadline
                              ? 'text-error-text font-semibold whitespace-nowrap'
                              : 'text-ink-secondary whitespace-nowrap'
                          }
                        >
                          ETA {formatDateTimeDDMMYYYY(slot.endMs, timezone)}
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="py-3 px-3 align-top">
                      {isReadOnlyStage ? (
                        <span
                          className={`inline-block text-xs font-semibold whitespace-nowrap ${
                            job.stage === 'Cancelled'
                              ? 'text-error-text'
                              : job.stage === 'Completed'
                              ? 'text-brand-text'
                              : 'text-warning-text'
                          }`}
                        >
                          {job.stage}
                        </span>
                      ) : (
                        <select
                          aria-label={`Stage for Plate ${job.plateNumber}`}
                          disabled={isBusy}
                          value={job.stage}
                          onChange={(e) =>
                            onTransitionStage(job.id, e.target.value as KanbanStage)
                          }
                          className="px-2.5 py-1 rounded border border-line bg-input text-ink font-medium focus:border-brand focus:outline-none"
                        >
                          {ACTIVE_KANBAN_STAGES.map((st) => (
                            <option key={st} value={st}>
                              {st}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="py-3 pl-2 pr-4 text-right align-top">
                      <div className="inline-flex items-center justify-end gap-1">
                        {canDeletePlate(job) && (
                          <button
                            type="button"
                            disabled={!isAdmin || isBusy}
                            title="Delete Plate"
                            onClick={() => onRequestDeletePlate(job)}
                            className="p-1.5 rounded-lg text-muted hover:text-error-text hover:bg-error-soft disabled:opacity-40 transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {job.stage === 'Printing' && !job.archived && (
                          <button
                            type="button"
                            disabled={!isAdmin || isBusy}
                            title="Cancel Printing"
                            onClick={() => onRequestCancelPrinting(job)}
                            className="p-1.5 rounded-lg text-muted hover:text-error-text hover:bg-error-soft disabled:opacity-40 transition-colors"
                          >
                            <XCircle className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <PlateLifecycleMenu
                          job={job}
                          isAdmin={isAdmin}
                          isBusy={isBusy}
                          onRequestDelete={onRequestDeletePlate}
                          onRequestCancelPrinting={onRequestCancelPrinting}
                          onArchivePlate={onArchivePlate}
                          onRestorePlate={onRestorePlate}
                          onTransitionStage={onTransitionStage}
                          onPauseOrResume={onPauseOrResume}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

interface KanbanJobCardProps {
  job: ProductionJob;
  workspace: ProductionWorkspaceV5;
  schedule: GlobalScheduleResult;
  isAdmin: boolean;
  isBusy: boolean;
  onTransitionStage: KanbanQueueViewProps['onTransitionStage'];
  onPauseOrResume: KanbanQueueViewProps['onPauseOrResume'];
  onRecalibrateJobEta: KanbanQueueViewProps['onRecalibrateJobEta'];
  onUpdateJobMetadata: KanbanQueueViewProps['onUpdateJobMetadata'];
  onRequestDeletePlate: (job: ProductionJob) => void;
  onRequestCancelPrinting: (job: ProductionJob) => void;
  onArchivePlate: (job: ProductionJob) => void;
  onRestorePlate: (job: ProductionJob) => void;
}

const KanbanJobCard: React.FC<KanbanJobCardProps> = ({
  job,
  workspace,
  schedule,
  isAdmin,
  isBusy,
  onTransitionStage,
  onPauseOrResume,
  onRecalibrateJobEta,
  onUpdateJobMetadata,
  onRequestDeletePlate,
  onRequestCancelPrinting,
  onArchivePlate,
  onRestorePlate,
}) => {
  const [expanded, setExpanded] = useState(false);
  const project = workspace.projects.find((p) => p.id === job.projectId);
  const color = workspace.colors.find((c) => c.id === job.colorId);
  const qty = countPlateKeycaps(job);
  const slot = schedule.slotsByJobId[job.id];
  const { timezone } = schedule;

  const [pausedMinsDraft, setPausedMinsDraft] = useState<number>(() =>
    Math.max(
      1,
      Math.ceil((slot?.remainingSecondsLive || job.estimatedMinutes * 60) / 60)
    )
  );

  const stageIndex = ACTIVE_KANBAN_STAGES.indexOf(
    job.stage as (typeof ACTIVE_KANBAN_STAGES)[number]
  );
  const isReadOnlyStage = Boolean(job.archived) || job.stage === 'Cancelled';
  const releasedMachine = job.cancelledFromMachineId
    ? workspace.machines.find((m) => m.id === job.cancelledFromMachineId)
    : null;

  return (
    <article
      className={`min-w-0 w-full max-w-full bg-surface border rounded-xl p-3.5 space-y-2.5 ${
        slot?.exceedsProjectDeadline
          ? 'border-status-error'
          : 'border-line'
      }`}
    >
      <div className="flex items-start justify-between gap-2 min-w-0">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm font-semibold text-ink">
              Plate {job.plateNumber}
            </span>
            {job.archived && (
              <span className="text-[10px] font-medium text-muted">
                · Archived
              </span>
            )}
          </div>
          <div className="text-[11px] text-muted flex items-center gap-1.5 truncate">
            {color && (
              <span
                className="w-2 h-2 rounded-full shrink-0 border border-line"
                style={{ backgroundColor: color.hex }}
              />
            )}
            <span className="truncate">
              {project?.name || 'Project'} · {color?.name || 'Color'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <span className="text-xs font-mono-data font-semibold text-ink-secondary whitespace-nowrap">
            {qty}/{job.plateCapacity}
          </span>
          <PlateLifecycleMenu
            job={job}
            isAdmin={isAdmin}
            isBusy={isBusy}
            onRequestDelete={onRequestDeletePlate}
            onRequestCancelPrinting={onRequestCancelPrinting}
            onArchivePlate={onArchivePlate}
            onRestorePlate={onRestorePlate}
            onTransitionStage={onTransitionStage}
            onPauseOrResume={onPauseOrResume}
          />
        </div>
      </div>

      {/* Cancelled Details */}
      {job.stage === 'Cancelled' && (
        <div className="min-w-0 p-2.5 rounded-lg border border-error-border bg-error-soft text-xs space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-1 font-semibold text-error-text">
            <span>Cancelled</span>
            {job.cancelledIso && (
              <span className="text-[11px] font-mono-data font-normal break-words">
                {formatDateTimeDDMMYYYY(new Date(job.cancelledIso), timezone)}
              </span>
            )}
          </div>
          {releasedMachine && (
            <div className="text-[11px] text-ink-secondary break-words">
              Released printer: {releasedMachine.name}
            </div>
          )}
          {job.cancellationReason && (
            <div className="text-[11px] text-ink break-words">
              Reason: {job.cancellationReason}
            </div>
          )}
        </div>
      )}

      {/* Live Printing Countdown OR Queued Scheduled ETA */}
      {!job.archived && job.stage === 'Printing' && slot ? (
        slot.needsEtaRecalibration ? (
          <EtaRecalibrationBox
            compact
            jobId={job.id}
            plateNumber={job.plateNumber}
            defaultDurationMinutes={slot.effectivePrintMinutes}
            nowMs={schedule.nowMs}
            timezone={timezone}
            disabled={isBusy}
            onRecalibrate={onRecalibrateJobEta}
          />
        ) : (
          <div
            className={`min-w-0 p-2.5 rounded-lg border text-xs space-y-2 ${
              slot.isPaused
                ? 'bg-warning-soft border-warning-border'
                : 'bg-brand-soft border-brand-border'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 font-mono-data min-w-0">
              <span className="font-bold text-sm text-ink">
                {formatCountdownHMS(slot.remainingSecondsLive)}
              </span>
              <span
                className={`text-[11px] font-sans font-semibold break-words ${
                  slot.isPaused ? 'text-warning-text' : 'text-brand-text'
                }`}
              >
                {slot.isPaused
                  ? 'Paused'
                  : slot.isAwaitingConfirmation
                  ? ETA_REACHED_LABEL
                  : 'Printing'}
              </span>
            </div>
            {slot.endMs && (
              <div className="text-[11px] font-mono-data text-ink-secondary break-words">
                Est. Finish: {formatDateTimeDDMMYYYY(slot.endMs, timezone)}
              </div>
            )}

            {slot.isPaused ? (
              <div className="pt-1 space-y-2 min-w-0">
                <div className="flex flex-wrap items-center justify-between gap-1.5 min-w-0">
                  <DurationHMInput
                    compact
                    minutes={pausedMinsDraft}
                    onChangeMinutes={setPausedMinsDraft}
                    ariaLabelPrefix="Paused remaining duration"
                  />
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() =>
                      onPauseOrResume(job.id, 'update_remaining', pausedMinsDraft)
                    }
                    className="w-full sm:w-auto grow sm:grow-0 inline-flex items-center justify-center px-2.5 py-1 text-[11px] font-semibold rounded border border-line bg-surface hover:bg-elevated text-ink text-center leading-tight disabled:opacity-50 transition-colors"
                  >
                    Set
                  </button>
                </div>
                <div className="flex flex-wrap items-stretch gap-1.5 min-w-0">
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => onPauseOrResume(job.id, 'resume')}
                    className="w-full sm:w-auto grow min-w-0 inline-flex items-center justify-center px-2.5 py-1.5 text-xs font-semibold rounded bg-brand hover:bg-brand-hover text-white text-center leading-tight break-words disabled:opacity-50 transition-colors"
                  >
                    Resume Print
                  </button>
                  <button
                    type="button"
                    disabled={!isAdmin || isBusy}
                    onClick={() => onRequestCancelPrinting(job)}
                    className="w-full sm:w-auto grow min-w-0 inline-flex items-center justify-center px-2.5 py-1.5 text-[11px] font-semibold rounded border border-error-border text-error-text hover:bg-error-soft bg-surface text-center leading-tight break-words disabled:opacity-45 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-stretch gap-1.5 pt-0.5 min-w-0">
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => {
                    setPausedMinsDraft(
                      Math.max(1, Math.ceil(slot.remainingSecondsLive / 60))
                    );
                    onPauseOrResume(job.id, 'pause');
                  }}
                  className="w-full sm:w-auto grow min-w-0 inline-flex items-center justify-center px-2.5 py-1.5 text-[11px] font-semibold rounded border border-warning-border bg-surface hover:bg-warning-soft text-warning-text text-center leading-tight break-words disabled:opacity-50 transition-colors"
                >
                  Pause Countdown
                </button>
                <button
                  type="button"
                  disabled={!isAdmin || isBusy}
                  onClick={() => onRequestCancelPrinting(job)}
                  className="w-full sm:w-auto grow min-w-0 inline-flex items-center justify-center px-2.5 py-1.5 text-[11px] font-semibold rounded border border-error-border text-error-text hover:bg-error-soft bg-surface text-center leading-tight break-words disabled:opacity-45 transition-colors"
                >
                  Cancel Print
                </button>
              </div>
            )}
          </div>
        )
      ) : !job.archived &&
        job.stage !== 'Completed' &&
        job.stage !== 'Cancelled' &&
        slot?.startMs &&
        slot?.endMs ? (
        <div className="min-w-0 text-[11px] font-mono-data text-ink-secondary bg-elevated px-2.5 py-1.5 rounded-lg border border-line break-words">
          <div>Est Start: {formatDateTimeDDMMYYYY(slot.startMs, timezone)}</div>
          <div
            className={
              slot.exceedsProjectDeadline ? 'text-error-text font-semibold' : ''
            }
          >
            Est Finish: {formatDateTimeDDMMYYYY(slot.endMs, timezone)}
          </div>
        </div>
      ) : null}

      {/* Alphabet & Charm composition breakdown */}
      <PlateCompositionSummary letters={job.letters} charms={job.charms} />

      {/* Printer Assignment */}
      {!isReadOnlyStage && (
        <div className="min-w-0">
          <select
            aria-label={`Assign printer for Plate ${job.plateNumber}`}
            disabled={isBusy}
            value={job.machineId || ''}
            onChange={(e) =>
              onUpdateJobMetadata(job.id, { machineId: e.target.value || null })
            }
            className="w-full min-w-0 max-w-full px-2.5 py-1.5 rounded-lg border border-line bg-input text-xs text-ink focus:border-brand focus:outline-none"
          >
            <option value="">
              {slot?.isVirtualAssignment
                ? `Auto (${slot.assignedMachineName})`
                : 'Assign Printer...'}
            </option>
            {workspace.machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.status})
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Stage Selector + Quick Actions */}
      {isReadOnlyStage ? (
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1 min-w-0">
          <span className="text-xs font-medium text-muted min-w-0 break-words">
            Status: <b className="text-ink">{job.stage}</b>
          </span>
          {job.archived ? (
            <button
              type="button"
              disabled={!isAdmin || isBusy}
              onClick={() => onRestorePlate(job)}
              className="w-full sm:w-auto grow sm:grow-0 min-w-0 inline-flex items-center justify-center px-2.5 py-1 text-xs font-semibold rounded-lg border border-brand-border bg-brand-soft hover:bg-brand hover:text-white text-brand-text disabled:opacity-45 text-center leading-tight break-words transition-colors"
            >
              Restore Plate
            </button>
          ) : (
            <button
              type="button"
              disabled={!isAdmin || isBusy}
              onClick={() => onArchivePlate(job)}
              className="w-full sm:w-auto grow sm:grow-0 min-w-0 inline-flex items-center justify-center px-2.5 py-1 text-xs font-medium rounded-lg border border-line bg-elevated text-ink hover:bg-recessed disabled:opacity-45 text-center leading-tight break-words transition-colors"
            >
              Archive Plate
            </button>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-1.5 pt-1 min-w-0">
          <select
            aria-label={`Stage for Plate ${job.plateNumber}`}
            disabled={isBusy}
            value={job.stage}
            onChange={(e) =>
              onTransitionStage(job.id, e.target.value as KanbanStage)
            }
            className="w-full sm:w-auto flex-1 min-w-[7rem] max-w-full px-2 py-1 rounded-lg border border-line bg-input text-xs font-medium text-ink focus:border-brand focus:outline-none"
          >
            {ACTIVE_KANBAN_STAGES.map((st) => (
              <option key={st} value={st}>
                {st}
              </option>
            ))}
          </select>

          {stageIndex >= 0 && stageIndex < 3 && (
            <button
              type="button"
              disabled={isBusy}
              onClick={() =>
                onTransitionStage(job.id, ACTIVE_KANBAN_STAGES[stageIndex + 1])
              }
              className="w-full sm:w-auto grow sm:grow-0 min-w-0 inline-flex items-center justify-center px-2.5 py-1 text-xs font-semibold rounded-lg border border-brand-border bg-brand-soft hover:bg-brand hover:text-white text-brand-text text-center leading-tight break-words disabled:opacity-50 transition-colors"
            >
              Next →
            </button>
          )}

          {job.stage === 'Failed / Reprint' && (
            <button
              type="button"
              disabled={isBusy}
              onClick={() => onTransitionStage(job.id, 'Ready to Print')}
              className="w-full sm:w-auto grow sm:grow-0 min-w-0 inline-flex items-center justify-center px-2.5 py-1 text-xs font-semibold rounded-lg border border-warning-border bg-warning-soft text-warning-text text-center leading-tight break-words disabled:opacity-50 transition-colors"
            >
              Reprint
            </button>
          )}
        </div>
      )}

      {/* Metadata footer & Expandable Bambu Studio Timing / Machine Overrides */}
      <div className="pt-2 border-t border-line flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[11px] text-muted min-w-0">
        <span className="min-w-0 break-words">
          {job.stage === 'Completed'
            ? `Done (${formatDurationHoursMinutes(
                job.actualMinutes || job.estimatedMinutes
              )})`
            : `Bambu Est: ${formatDurationHoursMinutes(job.estimatedMinutes)}`}
          {job.failedCount > 0 ? ` · Fails: ${job.failedCount}` : ''}
        </span>
        {!job.archived && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="text-brand-text font-medium hover:underline shrink-0"
          >
            {expanded ? 'Hide' : 'Timing & Notes'}
          </button>
        )}
      </div>

      {expanded && !job.archived && (
        <div className="pt-2 space-y-2.5 border-t border-line text-xs min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-muted">Bambu Est. (h/m):</span>
            <DurationHMInput
              compact
              minutes={job.estimatedMinutes}
              onChangeMinutes={(mins) =>
                onUpdateJobMetadata(job.id, { estimatedMinutes: mins })
              }
              ariaLabelPrefix="Bambu Studio estimated duration"
            />
          </div>

          {job.machineId && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span
                className="text-[11px] text-muted"
                title="Printer-specific duration from Bambu Studio"
              >
                Printer-Specific (h/m):
              </span>
              <DurationHMInput
                compact
                minutes={
                  job.machineDurationOverrides?.[job.machineId] ||
                  job.estimatedMinutes
                }
                onChangeMinutes={(mins) =>
                  onUpdateJobMetadata(job.id, {
                    machineDurationOverrides: {
                      ...(job.machineDurationOverrides || {}),
                      [job.machineId!]: mins,
                    },
                  })
                }
                ariaLabelPrefix="Printer specific duration"
              />
            </div>
          )}

          {job.stage === 'Completed' && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] text-muted">Actual Print (h/m):</span>
              <DurationHMInput
                compact
                minutes={job.actualMinutes || job.estimatedMinutes}
                onChangeMinutes={(mins) =>
                  onUpdateJobMetadata(job.id, { actualMinutes: mins })
                }
                ariaLabelPrefix="Actual print duration"
              />
            </div>
          )}

          <label className="flex items-center gap-2 text-xs text-ink-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={job.slicerVerified}
              onChange={(e) =>
                onUpdateJobMetadata(job.id, { slicerVerified: e.target.checked })
              }
            />
            <span>Verified physical bed layout in slicer</span>
          </label>

          {job.stage === 'Failed / Reprint' && (
            <div>
              <label className="block text-[11px] text-muted mb-0.5">
                Failure Reason
              </label>
              <input
                value={job.failureReason}
                placeholder="Warping / filament runout..."
                onChange={(e) =>
                  onUpdateJobMetadata(job.id, { failureReason: e.target.value })
                }
                className="w-full px-2 py-1 rounded border border-line bg-input text-ink focus:border-brand focus:outline-none"
              />
            </div>
          )}

          <div>
            <label className="block text-[11px] text-muted mb-0.5">
              Print Notes
            </label>
            <input
              value={job.notes}
              placeholder="0.2mm nozzle, PLA Matte..."
              onChange={(e) =>
                onUpdateJobMetadata(job.id, { notes: e.target.value })
              }
              className="w-full px-2 py-1 rounded border border-line bg-input text-ink focus:border-brand focus:outline-none"
            />
          </div>
        </div>
      )}
    </article>
  );
};
