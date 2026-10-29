import React, { useState } from 'react';
import { countLetters, countPlateKeycaps } from '../constants';
import { KanbanStage, NavSection, ProductionJob, ProductionWorkspaceV5 } from '../types';
import {
  formatCountdownHMS,
  formatDateDDMMYYYY,
  formatDateTimeDDMMYYYY,
  formatDurationHoursMinutes,
} from '../utils/dateFormat';
import { GlobalScheduleResult, ScheduledJobSlot } from '../utils/schedulingEngine';
import { DurationHMInput } from './DurationHMInput';
import { PlateCompositionSummary } from './PlateCompositionSummary';

interface EtaDashboardViewProps {
  workspace: ProductionWorkspaceV5;
  schedule: GlobalScheduleResult;
  isAdmin?: boolean;
  busyJobIds?: ReadonlySet<string>;
  onNavigate: (nav: NavSection) => void;
  onSelectProject: (projectId: string) => void;
  onPauseOrResume: (
    jobId: string,
    action: 'pause' | 'resume' | 'update_remaining',
    overrideRemainingMinutes?: number
  ) => void;
  onTransitionStage: (
    jobId: string,
    nextStage: KanbanStage,
    opts?: { machineId?: string | null }
  ) => void;
  onRequestCancelPrinting?: (job: ProductionJob) => void;
  onUpdateBufferMinutes: (bufferMins: number) => void;
}

export const EtaDashboardView: React.FC<EtaDashboardViewProps> = ({
  workspace,
  schedule,
  isAdmin = true,
  busyJobIds,
  onNavigate,
  onSelectProject,
  onPauseOrResume,
  onTransitionStage,
  onRequestCancelPrinting,
  onUpdateBufferMinutes,
}) => {
  const {
    timezone,
    activePrintingSlots,
    nextAvailableMachine,
    projectEtas,
    turnaroundBufferMinutes,
    deadlineWarningsCount,
  } = schedule;

  const [bufferDraft, setBufferDraft] = useState<number>(turnaroundBufferMinutes);

  return (
    <div className="space-y-6">
      {/* Deadline Warning Banner */}
      {deadlineWarningsCount > 0 && (
        <div className="p-4 rounded-xl bg-red-50 dark:bg-red-950/35 border border-red-200 dark:border-red-900/60 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-red-800 dark:text-red-200">
            <span className="font-semibold">
              Deadline Alert ({deadlineWarningsCount}{' '}
              {deadlineWarningsCount === 1 ? 'project exceeds' : 'projects exceed'} target deadline):
            </span>{' '}
            Estimated completion of the final outstanding plate finishes after the scheduled project deadline. Reassign queued plates to idle Bambu printers or adjust priorities.
          </div>
          <button
            type="button"
            onClick={() => onNavigate('timeline')}
            className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-semibold whitespace-nowrap"
          >
            Inspect Timeline
          </button>
        </div>
      )}

      {/* Top Global ETA KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-xl p-5">
          <div className="text-xs text-neutral-500 dark:text-neutral-400">
            Active Printing Plates
          </div>
          <div className="text-2xl font-bold text-[#6c4ce6] dark:text-[#b49eff] font-mono-data mt-1">
            {activePrintingSlots.length}
          </div>
          <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
            {activePrintingSlots.filter((s) => s.isPaused).length > 0
              ? `${activePrintingSlots.filter((s) => s.isPaused).length} currently paused`
              : `Across ${workspace.machines.length} registered printers`}
          </div>
        </div>

        <div className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-xl p-5">
          <div className="text-xs text-neutral-500 dark:text-neutral-400">
            Next Available Machine
          </div>
          {nextAvailableMachine ? (
            <>
              <div className="text-lg font-bold text-neutral-900 dark:text-white mt-1 truncate">
                {nextAvailableMachine.machine.name}
              </div>
              <div className="text-xs font-mono-data text-emerald-600 dark:text-emerald-400 mt-1">
                {nextAvailableMachine.waitSeconds === 0
                  ? 'Available Immediately'
                  : `Free in ${formatCountdownHMS(nextAvailableMachine.waitSeconds)} (${formatDateTimeDDMMYYYY(
                      nextAvailableMachine.freeAtMs,
                      timezone
                    )})`}
              </div>
            </>
          ) : (
            <>
              <div className="text-lg font-bold text-red-600 dark:text-red-400 mt-1">
                No Online Printers
              </div>
              <div className="text-xs text-neutral-500 mt-1">
                Set at least one printer to Idle
              </div>
            </>
          )}
        </div>

        <div className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-xl p-5">
          <div className="text-xs text-neutral-500 dark:text-neutral-400">
            Plate Turnaround Buffer
          </div>
          <div className="flex items-center gap-2 mt-1.5">
            <input
              type="number"
              min={0}
              max={240}
              aria-label="Turnaround buffer minutes"
              value={bufferDraft}
              onChange={(e) => setBufferDraft(Math.max(0, Math.round(Number(e.target.value) || 0)))}
              className="w-16 px-2 py-1 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-[#111018] text-sm font-mono-data text-neutral-900 dark:text-white"
            />
            <span className="text-xs text-neutral-500">min</span>
            {bufferDraft !== turnaroundBufferMinutes && (
              <button
                type="button"
                onClick={() => onUpdateBufferMinutes(bufferDraft)}
                className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-[#6c4ce6] text-white whitespace-nowrap"
              >
                Apply
              </button>
            )}
          </div>
          <div className="text-[11px] text-neutral-400 mt-1">
            Removal, bed cleaning &amp; restart
          </div>
        </div>

        <div className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-xl p-5">
          <div className="text-xs text-neutral-500 dark:text-neutral-400">
            Display Timezone
          </div>
          <div className="text-base font-bold text-neutral-900 dark:text-white mt-1 truncate">
            {timezone}
          </div>
          <div className="text-xs font-mono-data text-neutral-500 dark:text-neutral-400 mt-1">
            Now: {formatDateTimeDDMMYYYY(schedule.nowMs, timezone)}
          </div>
        </div>
      </div>

      {/* Live Printing Countdown Cards (with Pause / Update Remaining / Resume / Complete) */}
      <section className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-2xl p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-neutral-900 dark:text-white">
              Live Printing Jobs &amp; Real-Time Countdown
            </h2>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
              Start timestamps sync with Firebase server time. Pausing freezes the countdown immediately and lets you enter an updated remaining time from Bambu Studio.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('machines')}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 whitespace-nowrap"
          >
            Start Another Plate
          </button>
        </div>

        {activePrintingSlots.length === 0 ? (
          <div className="p-8 rounded-xl border border-dashed border-neutral-200 dark:border-neutral-800 text-center space-y-2">
            <div className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              No plates are actively printing right now.
            </div>
            <div className="text-xs text-neutral-500">
              Move a queued plate to <span className="font-semibold">Printing</span> in Print Queue or Machines to start live ETA tracking.
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {activePrintingSlots.map((slot) => (
              <ActivePrintCountdownCard
                key={slot.job.id}
                slot={slot}
                timezone={timezone}
                isAdmin={isAdmin}
                isBusy={Boolean(busyJobIds?.has(slot.job.id))}
                onPauseOrResume={onPauseOrResume}
                onComplete={() =>
                  onTransitionStage(slot.job.id, 'Completed', {
                    machineId: slot.job.machineId,
                  })
                }
                onCancelPrinting={
                  onRequestCancelPrinting
                    ? () => onRequestCancelPrinting(slot.job)
                    : undefined
                }
              />
            ))}
          </div>
        )}
      </section>

      {/* Project Completion ETA Table (Parallel-Aware: Final Outstanding Job) */}
      <section className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-2xl p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-neutral-900 dark:text-white">
              Estimated Project Completion (Parallel Fleet Schedule)
            </h2>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
              Calculated from each project&apos;s final outstanding plate across parallel Bambu printers — never naively summed.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('timeline')}
            className="text-xs font-semibold text-[#6c4ce6] dark:text-[#b49eff] hover:underline whitespace-nowrap"
          >
            View Machine Timeline →
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-neutral-200 dark:border-neutral-800 text-neutral-500 dark:text-neutral-400">
                <th className="py-3 pr-4 font-medium">Project</th>
                <th className="py-3 px-3 font-medium">Priority</th>
                <th className="py-3 px-3 font-medium text-right">Plates (Done / Total)</th>
                <th className="py-3 px-3 font-medium">Project Deadline</th>
                <th className="py-3 px-3 font-medium">Estimated Completion</th>
                <th className="py-3 pl-3 font-medium text-right">Schedule Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800/70">
              {projectEtas.map((pe) => {
                const allDone =
                  pe.outstandingPlates === 0 && pe.totalPlates > 0;
                return (
                  <tr
                    key={pe.project.id}
                    onClick={() => {
                      onSelectProject(pe.project.id);
                      onNavigate('projects');
                    }}
                    className="hover:bg-neutral-50 dark:hover:bg-neutral-800/30 cursor-pointer transition-colors"
                  >
                    <td className="py-3.5 pr-4">
                      <div className="font-semibold text-neutral-900 dark:text-white">
                        {pe.project.name}
                      </div>
                      <div className="text-[11px] text-neutral-500">
                        {pe.project.salesChannel} · {pe.activePrintingPlates} printing
                        {pe.cancelledPlates > 0 ? ` · ${pe.cancelledPlates} cancelled` : ''}
                      </div>
                    </td>
                    <td className="py-3.5 px-3 text-neutral-700 dark:text-neutral-300">
                      {pe.project.priority}
                    </td>
                    <td className="py-3.5 px-3 text-right font-mono-data text-neutral-800 dark:text-neutral-200">
                      {pe.completedPlates} / {pe.totalPlates}
                    </td>
                    <td className="py-3.5 px-3 font-mono-data text-neutral-700 dark:text-neutral-300">
                      {pe.project.deadline
                        ? `${formatDateDDMMYYYY(pe.project.deadline)} 23:59`
                        : 'Flexible'}
                    </td>
                    <td className="py-3.5 px-3 font-mono-data font-semibold text-neutral-900 dark:text-white">
                      {allDone
                        ? 'All Plates Completed'
                        : pe.estimatedCompletionMs
                        ? formatDateTimeDDMMYYYY(pe.estimatedCompletionMs, timezone)
                        : pe.totalPlates === 0
                        ? 'No plates planned'
                        : 'Awaiting online printer'}
                    </td>
                    <td className="py-3.5 pl-3 text-right font-semibold whitespace-nowrap">
                      {allDone ? (
                        <span className="text-emerald-600 dark:text-emerald-400">Completed</span>
                      ) : pe.totalPlates === 0 ? (
                        <span className="text-neutral-400">No plates</span>
                      ) : pe.isDeadlineExceeded ? (
                        <span className="text-red-600 dark:text-red-400">
                          Late by {formatDurationHoursMinutes(Math.abs(pe.slackMinutes || 0))}
                        </span>
                      ) : pe.slackMinutes !== null ? (
                        <span className="text-emerald-600 dark:text-emerald-400">
                          On Track ({formatDurationHoursMinutes(pe.slackMinutes)} buffer)
                        </span>
                      ) : (
                        <span className="text-neutral-500">Scheduled</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};

interface ActivePrintCountdownCardProps {
  slot: ScheduledJobSlot;
  timezone: string;
  isAdmin?: boolean;
  isBusy?: boolean;
  onPauseOrResume: EtaDashboardViewProps['onPauseOrResume'];
  onComplete: () => void;
  onCancelPrinting?: () => void;
}

const ActivePrintCountdownCard: React.FC<ActivePrintCountdownCardProps> = ({
  slot,
  timezone,
  isAdmin = true,
  isBusy = false,
  onPauseOrResume,
  onComplete,
  onCancelPrinting,
}) => {
  const { job, project, colorName, assignedMachineName, isPaused, remainingSecondsLive, endMs } =
    slot;

  const [editingRemaining, setEditingRemaining] = useState<boolean>(false);
  const [remMinutesInput, setRemMinutesInput] = useState<number>(() =>
    Math.max(1, Math.ceil(remainingSecondsLive / 60))
  );

  const totalEstSecs = Math.max(60, slot.effectivePrintMinutes * 60);
  const pctDone = Math.min(
    100,
    Math.max(0, Math.round(((totalEstSecs - remainingSecondsLive) / totalEstSecs) * 100))
  );

  return (
    <article
      className={`rounded-xl border p-4 space-y-3 ${
        isPaused
          ? 'border-amber-300 dark:border-amber-800 bg-amber-50/40 dark:bg-amber-950/20'
          : 'border-neutral-200 dark:border-neutral-800 bg-neutral-50/60 dark:bg-[#13111c]'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-neutral-900 dark:text-white">
            {assignedMachineName} · Plate {job.plateNumber}
          </div>
          <div className="text-xs text-neutral-500 dark:text-neutral-400">
            {project?.name || 'Project'} · {colorName} · {countPlateKeycaps(job)}/{job.plateCapacity} pcs
          </div>
        </div>
        <span
          className={`text-xs font-semibold ${
            isPaused
              ? 'text-amber-700 dark:text-amber-400'
              : remainingSecondsLive === 0
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-[#6c4ce6] dark:text-[#b49eff]'
          }`}
        >
          {isPaused ? 'Paused (Frozen)' : remainingSecondsLive === 0 ? 'Ready to Finish' : 'Printing Live'}
        </span>
      </div>

      <PlateCompositionSummary letters={job.letters} charms={job.charms} compact />

      {/* Big Tabular Countdown & Finish Timestamp */}
      <div className="flex flex-wrap items-baseline justify-between gap-2 pt-1">
        <div>
          <div className="text-[11px] text-neutral-400">Remaining Countdown</div>
          <div className="text-2xl font-bold font-mono-data text-neutral-900 dark:text-white">
            {formatCountdownHMS(remainingSecondsLive)}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[11px] text-neutral-400">
            {isPaused ? 'Projected Finish (if resumed now)' : 'Estimated Finish'}
          </div>
          <div className="text-xs font-mono-data font-semibold text-neutral-800 dark:text-neutral-200">
            {endMs ? formatDateTimeDDMMYYYY(endMs, timezone) : '—'}
          </div>
          {job.startedAtMs && (
            <div className="text-[11px] font-mono-data text-neutral-400">
              Started: {formatDateTimeDDMMYYYY(job.startedAtMs, timezone)}
            </div>
          )}
        </div>
      </div>

      <div className="h-2 rounded-full bg-neutral-200 dark:bg-neutral-800 overflow-hidden">
        <div
          className={`h-full ${isPaused ? 'bg-amber-500' : 'bg-[#6c4ce6]'}`}
          style={{ width: `${pctDone}%` }}
        />
      </div>

      {/* Update Remaining Duration Box (always accessible when paused or via Adjust button) */}
      {(isPaused || editingRemaining) && (
        <div className="p-3 rounded-lg bg-white dark:bg-[#191726] border border-neutral-200 dark:border-neutral-700 flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
            Remaining time on Bambu screen:
          </div>
          <div className="flex items-center gap-2">
            <DurationHMInput
              compact
              minutes={remMinutesInput}
              onChangeMinutes={setRemMinutesInput}
              ariaLabelPrefix={`Remaining time for Plate ${job.plateNumber}`}
            />
            <button
              type="button"
              onClick={() => {
                onPauseOrResume(job.id, 'update_remaining', remMinutesInput);
                setEditingRemaining(false);
              }}
              className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 whitespace-nowrap"
            >
              Update ETA
            </button>
          </div>
        </div>
      )}

      {/* Action Controls */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <div className="flex items-center gap-2">
          {!isPaused ? (
            <button
              type="button"
              onClick={() => {
                const curMins = Math.max(1, Math.ceil(remainingSecondsLive / 60));
                setRemMinutesInput(curMins);
                onPauseOrResume(job.id, 'pause');
              }}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300 bg-white dark:bg-[#191726] whitespace-nowrap"
            >
              Pause Print
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onPauseOrResume(job.id, 'resume')}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#6c4ce6] hover:bg-[#5b3cc4] text-white whitespace-nowrap"
            >
              Resume Countdown
            </button>
          )}

          {!isPaused && (
            <button
              type="button"
              onClick={() => {
                setRemMinutesInput(Math.max(1, Math.ceil(remainingSecondsLive / 60)));
                setEditingRemaining(!editingRemaining);
              }}
              className="px-2.5 py-1.5 text-xs font-medium rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 whitespace-nowrap"
            >
              {editingRemaining ? 'Close Adjust' : 'Adjust Remaining'}
            </button>
          )}
          {onCancelPrinting && (
            <button
              type="button"
              disabled={!isAdmin || isBusy}
              onClick={onCancelPrinting}
              className="px-2.5 py-1.5 text-xs font-medium rounded-lg border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/35 disabled:opacity-45 whitespace-nowrap"
            >
              Cancel Print
            </button>
          )}
        </div>

        <button
          type="button"
          disabled={isBusy}
          onClick={onComplete}
          className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50 whitespace-nowrap"
        >
          {countLetters(job.letters) > 0 ? 'Complete Print (+Stock)' : 'Complete Print'}
        </button>
      </div>
    </article>
  );
};
