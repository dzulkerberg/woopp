import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, RotateCcw, Trash2, XCircle } from 'lucide-react';
import {
  ACTIVE_KANBAN_STAGES,
  countPlateKeycaps,
  KANBAN_STAGES,
} from '../constants';
import {
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
  canArchivePlate,
  canDeletePlate,
  canRestorePlate,
  filterQueueJobs,
} from '../utils/productionEngine';
import { GlobalScheduleResult } from '../utils/schedulingEngine';
import { DurationHMInput } from './DurationHMInput';
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
      <div className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-2xl p-4 space-y-4">
        {/* Top Row: Lifecycle Tabs & View Switcher */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-100 dark:border-neutral-800 pb-3.5">
          <div
            role="tablist"
            aria-label="Print queue lifecycle views"
            className="flex flex-wrap items-center gap-1 p-1 bg-neutral-100 dark:bg-[#111018] rounded-xl border border-neutral-200/70 dark:border-neutral-800"
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
                      ? 'bg-white dark:bg-[#2a2440] text-neutral-900 dark:text-white shadow-xs'
                      : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white'
                  }`}
                >
                  <span>{tab.label}</span>
                  <span
                    className={`font-mono-data text-[11px] px-1.5 py-0.5 rounded-md ${
                      active
                        ? 'bg-[#f1edfd] text-[#5b3cc4] dark:bg-[#3a3158] dark:text-[#d8ccff]'
                        : 'bg-neutral-200/70 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400'
                    }`}
                  >
                    {tab.count}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 p-1 bg-neutral-100 dark:bg-[#111018] rounded-lg border border-neutral-200/70 dark:border-neutral-800">
              <button
                type="button"
                onClick={() => setViewMode('kanban')}
                className={`px-2.5 py-1 text-xs font-medium rounded-md whitespace-nowrap ${
                  viewMode === 'kanban'
                    ? 'bg-white dark:bg-[#2a2440] text-neutral-900 dark:text-white'
                    : 'text-neutral-500 dark:text-neutral-400'
                }`}
              >
                Kanban Board
              </button>
              <button
                type="button"
                onClick={() => setViewMode('list')}
                className={`px-2.5 py-1 text-xs font-medium rounded-md whitespace-nowrap ${
                  viewMode === 'list'
                    ? 'bg-white dark:bg-[#2a2440] text-neutral-900 dark:text-white'
                    : 'text-neutral-500 dark:text-neutral-400'
                }`}
              >
                Table View
              </button>
            </div>

            <button
              type="button"
              onClick={() => onCopyQueueSummary(filteredJobs)}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 whitespace-nowrap"
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
              className="px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-[#111018] text-xs text-neutral-800 dark:text-neutral-200"
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
              className="px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-[#111018] text-xs text-neutral-800 dark:text-neutral-200"
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
              className="px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-[#111018] text-xs text-neutral-800 dark:text-neutral-200"
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
              className="px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-[#111018] text-xs text-neutral-800 dark:text-neutral-200"
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
                className="px-2.5 py-1.5 text-xs text-[#6c4ce6] dark:text-[#b49eff] hover:underline whitespace-nowrap"
              >
                Reset Filters
              </button>
            )}
          </div>

          <div className="text-xs font-mono-data text-neutral-500 dark:text-neutral-400">
            Showing <b className="text-neutral-900 dark:text-white">{filteredJobs.length}</b>{' '}
            plate{filteredJobs.length === 1 ? '' : 's'} ·{' '}
            <b className="text-neutral-900 dark:text-white">
              {filteredTotalKeycaps.toLocaleString()}
            </b>{' '}
            pcs
          </div>
        </div>
      </div>

      {/* Bulk Selection Bar in Table View */}
      {viewMode === 'list' && filteredJobs.length > 0 && (
        <div className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-mono-data font-semibold text-neutral-900 dark:text-white">
              {selectedJobs.length} plate{selectedJobs.length === 1 ? '' : 's'} selected
            </span>
            <span className="text-neutral-400">·</span>
            <span className="font-mono-data text-neutral-600 dark:text-neutral-300">
              {selectedTotalKeycaps.toLocaleString()} keycaps affected
            </span>

            <div className="flex flex-wrap items-center gap-1.5 ml-1">
              {deletableInView.length > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    setSelectedIds(new Set(deletableInView.map((j) => j.id)))
                  }
                  className="px-2 py-1 rounded-md border border-neutral-200 dark:border-neutral-700 text-[11px] text-neutral-600 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 whitespace-nowrap"
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
                  className="px-2 py-1 rounded-md border border-neutral-200 dark:border-neutral-700 text-[11px] text-neutral-600 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 whitespace-nowrap"
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
                  className="px-2 py-1 rounded-md border border-neutral-200 dark:border-neutral-700 text-[11px] text-neutral-600 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 whitespace-nowrap"
                >
                  Select Archived ({restorableInView.length})
                </button>
              )}
              {selectedJobs.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSelectedIds(new Set())}
                  className="px-2 py-1 text-[11px] text-neutral-500 hover:text-neutral-900 dark:hover:text-white whitespace-nowrap"
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
                  className="text-[11px] text-amber-700 dark:text-amber-400 hover:underline whitespace-nowrap"
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
                  className="text-[11px] text-[#6c4ce6] dark:text-[#b49eff] hover:underline whitespace-nowrap"
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
                className="px-3 py-1.5 rounded-lg border border-[#cfc2ff] dark:border-[#433575] bg-[#f6f3ff] dark:bg-[#251f3d] text-xs font-semibold text-[#5b3cc4] dark:text-[#d5c8ff] disabled:opacity-40 flex items-center gap-1.5 whitespace-nowrap"
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
              className="px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-[#111018] hover:bg-neutral-100 dark:hover:bg-neutral-800 text-xs font-semibold text-neutral-800 dark:text-neutral-200 disabled:opacity-40 flex items-center gap-1.5 whitespace-nowrap"
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
              className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-semibold disabled:opacity-40 flex items-center gap-1.5 whitespace-nowrap"
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
                className="bg-neutral-100/70 dark:bg-[#151320] border border-neutral-200/80 dark:border-neutral-800 rounded-2xl p-3.5 space-y-3"
              >
                <div className="flex items-center justify-between px-1">
                  <h3 className="text-xs font-semibold text-neutral-900 dark:text-white">
                    {stage}
                  </h3>
                  <span className="text-xs font-mono-data text-neutral-500 dark:text-neutral-400">
                    {stageJobs.length} · {stageKeycaps.toLocaleString()} pcs
                  </span>
                </div>

                {stageJobs.length === 0 ? (
                  <div className="py-8 text-center text-xs text-neutral-400 dark:text-neutral-500 border border-dashed border-neutral-200 dark:border-neutral-800 rounded-xl">
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
        <div className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-2xl p-10 text-center space-y-2">
          <div className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
            No print plates match the current view and filters.
          </div>
          <div className="text-xs text-neutral-500 dark:text-neutral-400">
            Switch lifecycle tabs above or reset filters to view plates across other stages.
          </div>
        </div>
      ) : (
        <div className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-2xl overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-neutral-200 dark:border-neutral-800 text-neutral-500 dark:text-neutral-400">
                <th className="py-3 pl-4 pr-2 w-9">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    aria-label="Select all visible plates"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAllVisible}
                    className="rounded border-neutral-300 dark:border-neutral-700"
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
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800/70">
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
                        ? 'bg-[#f8f6ff] dark:bg-[#221d36]/60'
                        : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/30'
                    }`}
                  >
                    <td className="py-3 pl-4 pr-2 align-top">
                      <input
                        type="checkbox"
                        aria-label={`Select Plate ${job.plateNumber} (${job.id})`}
                        checked={isSelected}
                        onChange={() => toggleSelectOne(job.id)}
                        className="mt-0.5 rounded border-neutral-300 dark:border-neutral-700"
                      />
                    </td>
                    <td className="py-3 px-3 text-neutral-900 dark:text-white align-top">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-semibold font-mono-data whitespace-nowrap">
                          Plate {job.plateNumber} ({qty}/{job.plateCapacity})
                        </span>
                        {job.archived && (
                          <span className="px-1.5 py-0.5 rounded bg-neutral-200/80 dark:bg-neutral-800 text-[10px] font-medium text-neutral-700 dark:text-neutral-300">
                            Archived
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] font-mono-data text-neutral-400 dark:text-neutral-500 mt-0.5">
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
                    <td className="py-3 px-3 text-neutral-700 dark:text-neutral-300 align-top">
                      <div className="font-medium text-neutral-900 dark:text-white">
                        {proj?.name || 'Project'}
                      </div>
                      <div className="text-neutral-500 flex items-center gap-1.5 mt-0.5">
                        {color && (
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ backgroundColor: color.hex }}
                          />
                        )}
                        <span>{color?.name || 'Color'}</span>
                      </div>
                    </td>
                    <td className="py-3 px-3 align-top">
                      {isReadOnlyStage ? (
                        <span className="text-neutral-500 dark:text-neutral-400">
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
                          className="px-2 py-1 rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-[#111018]"
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
                    <td className="py-3 px-3 font-mono-data text-neutral-600 dark:text-neutral-300 whitespace-nowrap align-top">
                      {formatDurationHoursMinutes(job.estimatedMinutes)} /{' '}
                      {job.actualMinutes
                        ? formatDurationHoursMinutes(job.actualMinutes)
                        : '—'}
                    </td>
                    <td className="py-3 px-3 font-mono-data align-top">
                      {job.stage === 'Cancelled' ? (
                        <div className="space-y-0.5">
                          <div className="text-red-600 dark:text-red-400 font-sans font-medium">
                            Cancelled{' '}
                            {job.cancelledIso
                              ? formatDateTimeDDMMYYYY(new Date(job.cancelledIso), timezone)
                              : ''}
                          </div>
                          {job.cancellationReason && (
                            <div className="text-[11px] font-sans text-neutral-500 dark:text-neutral-400 max-w-xs truncate">
                              Reason: {job.cancellationReason}
                            </div>
                          )}
                        </div>
                      ) : job.stage === 'Completed' ? (
                        <span className="text-emerald-600 dark:text-emerald-400 whitespace-nowrap">
                          Done{' '}
                          {job.actualCompletedAtMs
                            ? formatDateTimeDDMMYYYY(job.actualCompletedAtMs, timezone)
                            : ''}
                        </span>
                      ) : job.stage === 'Printing' && slot ? (
                        <span
                          className={
                            job.isPaused
                              ? 'text-amber-600 font-semibold whitespace-nowrap'
                              : 'text-[#6c4ce6] dark:text-[#b49eff] font-semibold whitespace-nowrap'
                          }
                        >
                          {job.isPaused ? 'Paused ' : ''}
                          {formatCountdownHMS(slot.remainingSecondsLive)} →{' '}
                          {slot.endMs
                            ? formatDateTimeDDMMYYYY(slot.endMs, timezone)
                            : ''}
                        </span>
                      ) : slot?.endMs ? (
                        <span
                          className={
                            slot.exceedsProjectDeadline
                              ? 'text-red-600 font-semibold whitespace-nowrap'
                              : 'text-neutral-700 dark:text-neutral-300 whitespace-nowrap'
                          }
                        >
                          ETA {formatDateTimeDDMMYYYY(slot.endMs, timezone)}
                        </span>
                      ) : (
                        <span className="text-neutral-400">—</span>
                      )}
                    </td>
                    <td className="py-3 px-3 align-top">
                      {isReadOnlyStage ? (
                        <span
                          className={`inline-block px-2.5 py-1 rounded-md text-xs font-semibold whitespace-nowrap ${
                            job.stage === 'Cancelled'
                              ? 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300'
                              : job.stage === 'Completed'
                              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                              : 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
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
                          className="px-2.5 py-1 rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-[#111018] font-medium"
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
                            className="p-1.5 rounded-lg text-neutral-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/35 disabled:opacity-40 transition-colors"
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
                            className="p-1.5 rounded-lg text-neutral-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/35 disabled:opacity-40 transition-colors"
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
      className={`bg-white dark:bg-[#1b1829] border rounded-xl p-3.5 space-y-2.5 ${
        slot?.exceedsProjectDeadline
          ? 'border-red-400 dark:border-red-700'
          : 'border-neutral-200/90 dark:border-neutral-800'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm font-semibold text-neutral-900 dark:text-white">
              Plate {job.plateNumber}
            </span>
            {job.archived && (
              <span className="px-1.5 py-0.5 rounded bg-neutral-200/80 dark:bg-neutral-800 text-[10px] font-medium text-neutral-700 dark:text-neutral-300">
                Archived
              </span>
            )}
          </div>
          <div className="text-[11px] text-neutral-500 dark:text-neutral-400 flex items-center gap-1.5 truncate">
            {color && (
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: color.hex }}
              />
            )}
            <span className="truncate">
              {project?.name || 'Project'} · {color?.name || 'Color'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <span className="text-xs font-mono-data font-semibold text-neutral-700 dark:text-neutral-200 whitespace-nowrap">
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
        <div className="p-2.5 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50/70 dark:bg-red-950/25 text-xs space-y-1">
          <div className="flex items-center justify-between font-semibold text-red-700 dark:text-red-300">
            <span>Cancelled</span>
            {job.cancelledIso && (
              <span className="text-[11px] font-mono-data font-normal">
                {formatDateTimeDDMMYYYY(new Date(job.cancelledIso), timezone)}
              </span>
            )}
          </div>
          {releasedMachine && (
            <div className="text-[11px] text-neutral-600 dark:text-neutral-300">
              Released printer: {releasedMachine.name}
            </div>
          )}
          {job.cancellationReason && (
            <div className="text-[11px] text-neutral-700 dark:text-neutral-200">
              Reason: {job.cancellationReason}
            </div>
          )}
        </div>
      )}

      {/* Live Printing Countdown OR Queued Scheduled ETA */}
      {!job.archived && job.stage === 'Printing' && slot ? (
        <div
          className={`p-2.5 rounded-lg border text-xs space-y-1.5 ${
            job.isPaused
              ? 'bg-amber-50/70 dark:bg-amber-950/30 border-amber-300 dark:border-amber-800'
              : 'bg-[#f6f3ff] dark:bg-[#251f3d] border-[#dcd2ff] dark:border-[#3f3469]'
          }`}
        >
          <div className="flex items-center justify-between font-mono-data">
            <span className="font-bold text-sm text-neutral-900 dark:text-white">
              {formatCountdownHMS(slot.remainingSecondsLive)}
            </span>
            <span className="text-[11px] font-semibold">
              {job.isPaused ? 'PAUSED' : 'LIVE'}
            </span>
          </div>
          {slot.endMs && (
            <div className="text-[11px] font-mono-data text-neutral-600 dark:text-neutral-300">
              Est. Finish: {formatDateTimeDDMMYYYY(slot.endMs, timezone)}
            </div>
          )}

          {job.isPaused ? (
            <div className="pt-1 space-y-1.5">
              <div className="flex items-center justify-between gap-1">
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
                  className="px-2 py-1 text-[11px] font-semibold rounded bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 whitespace-nowrap"
                >
                  Set
                </button>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => onPauseOrResume(job.id, 'resume')}
                  className="flex-1 py-1 text-xs font-semibold rounded bg-[#6c4ce6] text-white whitespace-nowrap"
                >
                  Resume Print
                </button>
                <button
                  type="button"
                  disabled={!isAdmin || isBusy}
                  onClick={() => onRequestCancelPrinting(job)}
                  className="px-2 py-1 text-[11px] font-semibold rounded border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 bg-white dark:bg-[#191726] whitespace-nowrap"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={isBusy}
                onClick={() => {
                  setPausedMinsDraft(
                    Math.max(1, Math.ceil(slot.remainingSecondsLive / 60))
                  );
                  onPauseOrResume(job.id, 'pause');
                }}
                className="flex-1 py-1 text-[11px] font-semibold rounded border border-amber-300 dark:border-amber-800 bg-white dark:bg-[#191726] text-amber-800 dark:text-amber-300 whitespace-nowrap"
              >
                Pause Countdown
              </button>
              <button
                type="button"
                disabled={!isAdmin || isBusy}
                onClick={() => onRequestCancelPrinting(job)}
                className="px-2 py-1 text-[11px] font-semibold rounded border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 bg-white dark:bg-[#191726] whitespace-nowrap"
              >
                Cancel Print
              </button>
            </div>
          )}
        </div>
      ) : !job.archived &&
        job.stage !== 'Completed' &&
        job.stage !== 'Cancelled' &&
        slot?.startMs &&
        slot?.endMs ? (
        <div className="text-[11px] font-mono-data text-neutral-600 dark:text-neutral-400 bg-neutral-50 dark:bg-[#13111d] px-2.5 py-1.5 rounded-lg border border-neutral-100 dark:border-neutral-800">
          <div>Est Start: {formatDateTimeDDMMYYYY(slot.startMs, timezone)}</div>
          <div
            className={
              slot.exceedsProjectDeadline
                ? 'text-red-600 dark:text-red-400 font-semibold'
                : ''
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
        <div>
          <select
            aria-label={`Assign printer for Plate ${job.plateNumber}`}
            disabled={isBusy}
            value={job.machineId || ''}
            onChange={(e) =>
              onUpdateJobMetadata(job.id, { machineId: e.target.value || null })
            }
            className="w-full px-2.5 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-[#12101b] text-xs text-neutral-800 dark:text-neutral-200"
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
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
            Status: <b className="text-neutral-800 dark:text-neutral-200">{job.stage}</b>
          </span>
          {job.archived ? (
            <button
              type="button"
              disabled={!isAdmin || isBusy}
              onClick={() => onRestorePlate(job)}
              className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-[#f1edfd] text-[#5b3cc4] dark:bg-[#2a2344] dark:text-[#c7b8ff] disabled:opacity-45 whitespace-nowrap"
            >
              Restore Plate
            </button>
          ) : (
            <button
              type="button"
              disabled={!isAdmin || isBusy}
              onClick={() => onArchivePlate(job)}
              className="px-2.5 py-1 text-xs font-medium rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-45 whitespace-nowrap"
            >
              Archive Plate
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-center justify-between gap-1.5 pt-1">
          <select
            aria-label={`Stage for Plate ${job.plateNumber}`}
            disabled={isBusy}
            value={job.stage}
            onChange={(e) =>
              onTransitionStage(job.id, e.target.value as KanbanStage)
            }
            className="flex-1 min-w-0 px-2 py-1 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-[#12101b] text-xs font-medium text-neutral-900 dark:text-white"
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
              className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-[#f1edfd] text-[#5b3cc4] dark:bg-[#2a2344] dark:text-[#c7b8ff] whitespace-nowrap"
            >
              Next →
            </button>
          )}

          {job.stage === 'Failed / Reprint' && (
            <button
              type="button"
              disabled={isBusy}
              onClick={() => onTransitionStage(job.id, 'Ready to Print')}
              className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 whitespace-nowrap"
            >
              Reprint
            </button>
          )}
        </div>
      )}

      {/* Metadata footer & Expandable Bambu Studio Timing / Machine Overrides */}
      <div className="pt-2 border-t border-neutral-100 dark:border-neutral-800 flex items-center justify-between text-[11px] text-neutral-500 dark:text-neutral-400">
        <span>
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
            className="text-[#6c4ce6] dark:text-[#b49eff] hover:underline whitespace-nowrap"
          >
            {expanded ? 'Hide' : 'Timing & Notes'}
          </button>
        )}
      </div>

      {expanded && !job.archived && (
        <div className="pt-2 space-y-2.5 border-t border-neutral-100 dark:border-neutral-800 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-neutral-500">Bambu Est. (h/m):</span>
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
            <div className="flex items-center justify-between gap-2">
              <span
                className="text-[11px] text-neutral-500"
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
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-neutral-500">Actual Print (h/m):</span>
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

          <label className="flex items-center gap-2 text-xs text-neutral-700 dark:text-neutral-300 cursor-pointer">
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
              <label className="block text-[11px] text-neutral-500 mb-0.5">
                Failure Reason
              </label>
              <input
                value={job.failureReason}
                placeholder="Warping / filament runout..."
                onChange={(e) =>
                  onUpdateJobMetadata(job.id, { failureReason: e.target.value })
                }
                className="w-full px-2 py-1 rounded border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-[#12101b]"
              />
            </div>
          )}

          <div>
            <label className="block text-[11px] text-neutral-500 mb-0.5">
              Print Notes
            </label>
            <input
              value={job.notes}
              placeholder="0.2mm nozzle, PLA Matte..."
              onChange={(e) =>
                onUpdateJobMetadata(job.id, { notes: e.target.value })
              }
              className="w-full px-2 py-1 rounded border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-[#12101b]"
            />
          </div>
        </div>
      )}
    </article>
  );
};
