import React, { useMemo, useState } from 'react';
import { countPlateKeycaps, KANBAN_STAGES } from '../constants';
import { KanbanStage, ProductionJob, ProductionWorkspaceV5 } from '../types';
import {
  formatCountdownHMS,
  formatDateTimeDDMMYYYY,
  formatDurationHoursMinutes,
} from '../utils/dateFormat';
import { GlobalScheduleResult } from '../utils/schedulingEngine';
import { DurationHMInput } from './DurationHMInput';
import { PlateCompositionSummary } from './PlateCompositionSummary';

interface KanbanQueueViewProps {
  workspace: ProductionWorkspaceV5;
  schedule: GlobalScheduleResult;
  selectedProjectId: string;
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
}

export const KanbanQueueView: React.FC<KanbanQueueViewProps> = ({
  workspace,
  schedule,
  selectedProjectId,
  onSelectProject,
  onTransitionStage,
  onPauseOrResume,
  onUpdateJobMetadata,
  onCopyQueueSummary,
}) => {
  const [projectFilter, setProjectFilter] = useState<string>(selectedProjectId || 'ALL');
  const [colorFilter, setColorFilter] = useState<string>('ALL');
  const [machineFilter, setMachineFilter] = useState<string>('ALL');
  const [viewMode, setViewMode] = useState<'kanban' | 'list'>('kanban');

  const filteredJobs = useMemo(() => {
    return workspace.jobs
      .filter((j) => {
        if (projectFilter !== 'ALL' && j.projectId !== projectFilter) return false;
        if (colorFilter !== 'ALL' && j.colorId !== colorFilter) return false;
        if (machineFilter !== 'ALL' && j.machineId !== machineFilter) return false;
        return true;
      })
      .sort((a, b) => a.plateNumber - b.plateNumber);
  }, [workspace.jobs, projectFilter, colorFilter, machineFilter]);

  const { timezone } = schedule;

  return (
    <div className="space-y-6">
      {/* Toolbar */}
      <div className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
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
            {workspace.machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
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

      {viewMode === 'kanban' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4 items-start">
          {KANBAN_STAGES.map((stage) => {
            const stageJobs = filteredJobs.filter((j) => j.stage === stage);
            const stageKeycaps = stageJobs.reduce((s, j) => s + countPlateKeycaps(j), 0);

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
                    {stageJobs.length} · {stageKeycaps} pcs
                  </span>
                </div>

                {stageJobs.length === 0 ? (
                  <div className="py-8 text-center text-xs text-neutral-400 dark:text-neutral-500 border border-dashed border-neutral-200 dark:border-neutral-800 rounded-xl">
                    No plates in {stage}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {stageJobs.map((job) => (
                      <KanbanJobCard
                        key={job.id}
                        job={job}
                        workspace={workspace}
                        schedule={schedule}
                        onTransitionStage={onTransitionStage}
                        onPauseOrResume={onPauseOrResume}
                        onUpdateJobMetadata={onUpdateJobMetadata}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-2xl overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-neutral-200 dark:border-neutral-800 text-neutral-500 dark:text-neutral-400">
                <th className="py-3 px-4 font-medium">Plate</th>
                <th className="py-3 px-4 font-medium">Project &amp; Color</th>
                <th className="py-3 px-4 font-medium">Printer</th>
                <th className="py-3 px-4 font-medium">Bambu Est / Actual</th>
                <th className="py-3 px-4 font-medium">Scheduled ETA / Countdown</th>
                <th className="py-3 px-4 font-medium">Stage</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800/70">
              {filteredJobs.map((job) => {
                const proj = workspace.projects.find((p) => p.id === job.projectId);
                const color = workspace.colors.find((c) => c.id === job.colorId);
                const qty = countPlateKeycaps(job);
                const slot = schedule.slotsByJobId[job.id];

                return (
                  <tr key={job.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-800/30">
                    <td className="py-3 px-4 text-neutral-900 dark:text-white">
                      <div className="font-semibold font-mono-data whitespace-nowrap">
                        Plate {job.plateNumber} ({qty}/{job.plateCapacity})
                      </div>
                      <div className="mt-1">
                        <PlateCompositionSummary
                          letters={job.letters}
                          charms={job.charms}
                          compact
                        />
                      </div>
                    </td>
                    <td className="py-3 px-4 text-neutral-700 dark:text-neutral-300">
                      <div className="font-medium">{proj?.name || 'Project'}</div>
                      <div className="text-neutral-500">{color?.name || 'Color'}</div>
                    </td>
                    <td className="py-3 px-4">
                      <select
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
                    </td>
                    <td className="py-3 px-4 font-mono-data text-neutral-600 dark:text-neutral-300 whitespace-nowrap">
                      {formatDurationHoursMinutes(job.estimatedMinutes)} /{' '}
                      {job.actualMinutes ? formatDurationHoursMinutes(job.actualMinutes) : '—'}
                    </td>
                    <td className="py-3 px-4 font-mono-data whitespace-nowrap">
                      {job.stage === 'Completed' ? (
                        <span className="text-emerald-600 dark:text-emerald-400">
                          Done{' '}
                          {job.actualCompletedAtMs
                            ? formatDateTimeDDMMYYYY(job.actualCompletedAtMs, timezone)
                            : ''}
                        </span>
                      ) : job.stage === 'Printing' && slot ? (
                        <span className={job.isPaused ? 'text-amber-600 font-semibold' : 'text-[#6c4ce6] dark:text-[#b49eff] font-semibold'}>
                          {job.isPaused ? 'Paused ' : ''}
                          {formatCountdownHMS(slot.remainingSecondsLive)} →{' '}
                          {slot.endMs ? formatDateTimeDDMMYYYY(slot.endMs, timezone) : ''}
                        </span>
                      ) : slot?.endMs ? (
                        <span className={slot.exceedsProjectDeadline ? 'text-red-600 font-semibold' : 'text-neutral-700 dark:text-neutral-300'}>
                          ETA {formatDateTimeDDMMYYYY(slot.endMs, timezone)}
                        </span>
                      ) : (
                        <span className="text-neutral-400">—</span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <select
                        value={job.stage}
                        onChange={(e) =>
                          onTransitionStage(job.id, e.target.value as KanbanStage)
                        }
                        className="px-2.5 py-1 rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-[#111018] font-medium"
                      >
                        {KANBAN_STAGES.map((st) => (
                          <option key={st} value={st}>
                            {st}
                          </option>
                        ))}
                      </select>
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
  onTransitionStage: KanbanQueueViewProps['onTransitionStage'];
  onPauseOrResume: KanbanQueueViewProps['onPauseOrResume'];
  onUpdateJobMetadata: KanbanQueueViewProps['onUpdateJobMetadata'];
}

const KanbanJobCard: React.FC<KanbanJobCardProps> = ({
  job,
  workspace,
  schedule,
  onTransitionStage,
  onPauseOrResume,
  onUpdateJobMetadata,
}) => {
  const [expanded, setExpanded] = useState(false);
  const project = workspace.projects.find((p) => p.id === job.projectId);
  const color = workspace.colors.find((c) => c.id === job.colorId);
  const qty = countPlateKeycaps(job);
  const slot = schedule.slotsByJobId[job.id];
  const { timezone } = schedule;

  const [pausedMinsDraft, setPausedMinsDraft] = useState<number>(() =>
    Math.max(1, Math.ceil((slot?.remainingSecondsLive || job.estimatedMinutes * 60) / 60))
  );

  const stageIndex = KANBAN_STAGES.indexOf(job.stage);

  return (
    <article
      className={`bg-white dark:bg-[#1b1829] border rounded-xl p-3.5 space-y-2.5 ${
        slot?.exceedsProjectDeadline
          ? 'border-red-400 dark:border-red-700'
          : 'border-neutral-200/90 dark:border-neutral-800'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-neutral-900 dark:text-white">
            Plate {job.plateNumber}
          </div>
          <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
            {project?.name || 'Project'} · {color?.name || 'Color'}
          </div>
        </div>
        <span className="text-xs font-mono-data font-semibold text-neutral-700 dark:text-neutral-200 whitespace-nowrap">
          {qty}/{job.plateCapacity}
        </span>
      </div>

      {/* Live Printing Countdown OR Queued Scheduled ETA */}
      {job.stage === 'Printing' && slot ? (
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
                  onClick={() => onPauseOrResume(job.id, 'update_remaining', pausedMinsDraft)}
                  className="px-2 py-1 text-[11px] font-semibold rounded bg-neutral-900 dark:bg-white text-white dark:text-neutral-900"
                >
                  Set
                </button>
              </div>
              <button
                type="button"
                onClick={() => onPauseOrResume(job.id, 'resume')}
                className="w-full py-1 text-xs font-semibold rounded bg-[#6c4ce6] text-white"
              >
                Resume Print
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setPausedMinsDraft(Math.max(1, Math.ceil(slot.remainingSecondsLive / 60)));
                onPauseOrResume(job.id, 'pause');
              }}
              className="w-full py-1 text-[11px] font-semibold rounded border border-amber-300 dark:border-amber-800 bg-white dark:bg-[#191726] text-amber-800 dark:text-amber-300"
            >
              Pause Countdown
            </button>
          )}
        </div>
      ) : job.stage !== 'Completed' && slot?.startMs && slot?.endMs ? (
        <div className="text-[11px] font-mono-data text-neutral-600 dark:text-neutral-400 bg-neutral-50 dark:bg-[#13111d] px-2.5 py-1.5 rounded-lg border border-neutral-100 dark:border-neutral-800">
          <div>
            Est Start: {formatDateTimeDDMMYYYY(slot.startMs, timezone)}
          </div>
          <div className={slot.exceedsProjectDeadline ? 'text-red-600 dark:text-red-400 font-semibold' : ''}>
            Est Finish: {formatDateTimeDDMMYYYY(slot.endMs, timezone)}
          </div>
        </div>
      ) : null}

      {/* Alphabet & Charm composition breakdown */}
      <PlateCompositionSummary letters={job.letters} charms={job.charms} />

      {/* Printer Assignment */}
      <div>
        <select
          aria-label={`Assign printer for Plate ${job.plateNumber}`}
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

      {/* Stage Selector + Quick Actions */}
      <div className="flex items-center justify-between gap-1.5 pt-1">
        <select
          aria-label={`Stage for Plate ${job.plateNumber}`}
          value={job.stage}
          onChange={(e) => onTransitionStage(job.id, e.target.value as KanbanStage)}
          className="flex-1 min-w-0 px-2 py-1 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-[#12101b] text-xs font-medium text-neutral-900 dark:text-white"
        >
          {KANBAN_STAGES.map((st) => (
            <option key={st} value={st}>
              {st}
            </option>
          ))}
        </select>

        {stageIndex >= 0 && stageIndex < 3 && (
          <button
            type="button"
            onClick={() => onTransitionStage(job.id, KANBAN_STAGES[stageIndex + 1])}
            className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-[#f1edfd] text-[#5b3cc4] dark:bg-[#2a2344] dark:text-[#c7b8ff] whitespace-nowrap"
          >
            Next →
          </button>
        )}

        {job.stage === 'Failed / Reprint' && (
          <button
            type="button"
            onClick={() => onTransitionStage(job.id, 'Ready to Print')}
            className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 whitespace-nowrap"
          >
            Reprint
          </button>
        )}
      </div>

      {/* Metadata footer & Expandable Bambu Studio Timing / Machine Overrides */}
      <div className="pt-2 border-t border-neutral-100 dark:border-neutral-800 flex items-center justify-between text-[11px] text-neutral-500 dark:text-neutral-400">
        <span>
          {job.stage === 'Completed'
            ? `Done (${formatDurationHoursMinutes(job.actualMinutes || job.estimatedMinutes)})`
            : `Bambu Est: ${formatDurationHoursMinutes(job.estimatedMinutes)}`}
          {job.failedCount > 0 ? ` · Fails: ${job.failedCount}` : ''}
        </span>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="text-[#6c4ce6] dark:text-[#b49eff] hover:underline"
        >
          {expanded ? 'Hide' : 'Timing & Notes'}
        </button>
      </div>

      {expanded && (
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
              <span className="text-[11px] text-neutral-500" title="Printer-specific duration from Bambu Studio">
                Printer-Specific (h/m):
              </span>
              <DurationHMInput
                compact
                minutes={
                  job.machineDurationOverrides?.[job.machineId] || job.estimatedMinutes
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
              <label className="block text-[11px] text-neutral-500 mb-0.5">Failure Reason</label>
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
            <label className="block text-[11px] text-neutral-500 mb-0.5">Print Notes</label>
            <input
              value={job.notes}
              placeholder="0.2mm nozzle, PLA Matte..."
              onChange={(e) => onUpdateJobMetadata(job.id, { notes: e.target.value })}
              className="w-full px-2 py-1 rounded border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-[#12101b]"
            />
          </div>
        </div>
      )}
    </article>
  );
};
