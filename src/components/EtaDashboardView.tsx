import React, { useEffect, useState } from 'react';
import { countLetters, countPlateKeycaps } from '../constants';
import {
  EtaRecalibrationInput,
  KanbanStage,
  NavSection,
  ProductionJob,
  ProductionWorkspaceV5,
} from '../types';
import {
  formatCountdownHMS,
  formatDateDDMMYYYY,
  formatDateTimeDDMMYYYY,
  formatDurationHoursMinutes,
} from '../utils/dateFormat';
import {
  ETA_NEEDS_RECALIBRATION_LABEL,
  ETA_REACHED_LABEL,
} from '../utils/productionCountdown';
import { GlobalScheduleResult, ScheduledJobSlot } from '../utils/schedulingEngine';
import { DurationHMInput } from './DurationHMInput';
import { EtaRecalibrationBox } from './EtaRecalibrationBox';
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
  onRecalibrateJobEta: (jobId: string, input: EtaRecalibrationInput) => void;
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
  onRecalibrateJobEta,
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

  useEffect(() => {
    setBufferDraft(turnaroundBufferMinutes);
  }, [turnaroundBufferMinutes]);

  return (
    <div className="space-y-6">
      {/* Deadline Warning Banner */}
      {deadlineWarningsCount > 0 && (
        <div className="p-4 rounded-xl bg-error-soft border border-error-border flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-error-text">
            <span className="font-semibold">
              Deadline Alert ({deadlineWarningsCount}{' '}
              {deadlineWarningsCount === 1 ? 'project exceeds' : 'projects exceed'} target deadline):
            </span>{' '}
            Estimated completion of the final outstanding plate finishes after the scheduled project deadline. Reassign queued plates to idle Bambu printers or adjust priorities.
          </div>
          <button
            type="button"
            onClick={() => onNavigate('queue')}
            className="px-3 py-1.5 rounded-lg bg-status-error hover:opacity-90 text-white text-xs font-semibold whitespace-nowrap transition-opacity"
          >
            Manage Print Queue
          </button>
        </div>
      )}

      {/* Top Global ETA KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-surface border border-line rounded-xl p-5">
          <div className="text-xs font-medium text-muted">
            Active Printing Plates
          </div>
          <div className="text-2xl font-bold text-brand-text font-mono-data mt-1">
            {activePrintingSlots.length}
          </div>
          <div className="text-xs text-muted mt-1">
            {activePrintingSlots.filter((s) => s.isPaused).length > 0
              ? `${activePrintingSlots.filter((s) => s.isPaused).length} currently paused`
              : `Across ${workspace.machines.length} registered printers`}
          </div>
        </div>

        <div className="bg-surface border border-line rounded-xl p-5">
          <div className="text-xs font-medium text-muted">
            Next Available Machine
          </div>
          {nextAvailableMachine ? (
            <>
              <div className="text-lg font-bold text-ink mt-1 truncate">
                {nextAvailableMachine.machine.name}
              </div>
              <div className="text-xs font-mono-data text-brand-text mt-1">
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
              <div className="text-lg font-bold text-error-text mt-1">
                No Online Printers
              </div>
              <div className="text-xs text-muted mt-1">
                Set at least one printer to Idle
              </div>
            </>
          )}
        </div>

        <div className="bg-surface border border-line rounded-xl p-5">
          <div className="text-xs font-medium text-muted">
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
              className="w-16 px-2 py-1 rounded-lg border border-line bg-input text-sm font-mono-data text-ink focus:border-brand"
            />
            <span className="text-xs text-muted">min</span>
            {bufferDraft !== turnaroundBufferMinutes && (
              <button
                type="button"
                onClick={() => onUpdateBufferMinutes(bufferDraft)}
                className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-brand hover:bg-brand-hover text-white whitespace-nowrap transition-colors"
              >
                Apply
              </button>
            )}
          </div>
          <div className="text-[11px] text-muted mt-1">
            Removal, bed cleaning &amp; restart
          </div>
        </div>

        <div className="bg-surface border border-line rounded-xl p-5">
          <div className="text-xs font-medium text-muted">
            Display Timezone
          </div>
          <div className="text-base font-bold text-ink mt-1 truncate">
            {timezone}
          </div>
          <div className="text-xs font-mono-data text-muted mt-1">
            Now: {formatDateTimeDDMMYYYY(schedule.nowMs, timezone)}
          </div>
        </div>
      </div>

      {/* Live Printing Countdown Cards (with Pause / Update Remaining / Resume / Complete) */}
      <section className="bg-surface border border-line rounded-xl p-4 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-ink">
              Live Printing Jobs &amp; Real-Time Countdown
            </h2>
            <p className="text-xs text-muted mt-0.5">
              Start timestamps sync with Firebase server time. Pausing freezes the countdown immediately and lets you enter an updated remaining time from Bambu Studio.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('machines')}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-line bg-elevated text-ink-secondary hover:text-ink hover:border-brand-border transition-colors whitespace-nowrap"
          >
            Start Another Plate
          </button>
        </div>

        {activePrintingSlots.length === 0 ? (
          <div className="p-8 rounded-xl border border-dashed border-line bg-recessed/50 text-center space-y-2">
            <div className="text-sm font-medium text-ink">
              No plates are actively printing right now.
            </div>
            <div className="text-xs text-muted">
              Move a queued plate to <span className="font-semibold text-ink">Printing</span> in Print Queue or Machines to start live ETA tracking.
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {activePrintingSlots.map((slot) => (
              <ActivePrintCountdownCard
                key={slot.job.id}
                slot={slot}
                nowMs={schedule.nowMs}
                timezone={timezone}
                isAdmin={isAdmin}
                isBusy={Boolean(busyJobIds?.has(slot.job.id))}
                onPauseOrResume={onPauseOrResume}
                onRecalibrateJobEta={onRecalibrateJobEta}
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
      <section className="bg-surface border border-line rounded-xl p-4 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-ink">
              Estimated Project Completion (Parallel Fleet Schedule)
            </h2>
            <p className="text-xs text-muted mt-0.5">
              Calculated from each project&apos;s final outstanding plate across parallel Bambu printers — never naively summed.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('queue')}
            className="text-xs font-semibold text-brand-text hover:underline whitespace-nowrap"
          >
            View Print Queue →
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-line text-muted">
                <th className="py-3 pr-4 font-semibold">Project</th>
                <th className="py-3 px-3 font-semibold">Priority</th>
                <th className="py-3 px-3 font-semibold text-right">Plates (Done / Total)</th>
                <th className="py-3 px-3 font-semibold">Project Deadline</th>
                <th className="py-3 px-3 font-semibold">Estimated Completion</th>
                <th className="py-3 pl-3 font-semibold text-right">Schedule Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
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
                    className="hover:bg-elevated cursor-pointer transition-colors"
                  >
                    <td className="py-3.5 pr-4">
                      <div className="font-semibold text-ink">
                        {pe.project.name}
                      </div>
                      <div className="text-[11px] text-muted">
                        {pe.project.salesChannel} · {pe.activePrintingPlates} printing
                        {pe.cancelledPlates > 0 ? ` · ${pe.cancelledPlates} cancelled` : ''}
                      </div>
                    </td>
                    <td className="py-3.5 px-3 text-ink-secondary">
                      {pe.project.priority}
                    </td>
                    <td className="py-3.5 px-3 text-right font-mono-data text-ink">
                      {pe.completedPlates} / {pe.totalPlates}
                    </td>
                    <td className="py-3.5 px-3 font-mono-data text-ink-secondary">
                      {pe.project.deadline
                        ? `${formatDateDDMMYYYY(pe.project.deadline)} 23:59`
                        : 'Flexible'}
                    </td>
                    <td className="py-3.5 px-3 font-mono-data font-semibold text-ink">
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
                        <span className="text-brand-text">Completed</span>
                      ) : pe.totalPlates === 0 ? (
                        <span className="text-muted">No plates</span>
                      ) : pe.isDeadlineExceeded ? (
                        <span className="text-error-text">
                          Late by {formatDurationHoursMinutes(Math.abs(pe.slackMinutes || 0))}
                        </span>
                      ) : pe.slackMinutes !== null ? (
                        <span className="text-brand-text">
                          On Track ({formatDurationHoursMinutes(pe.slackMinutes)} buffer)
                        </span>
                      ) : (
                        <span className="text-info-text">Scheduled</span>
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
  nowMs: number;
  timezone: string;
  isAdmin?: boolean;
  isBusy?: boolean;
  onPauseOrResume: EtaDashboardViewProps['onPauseOrResume'];
  onRecalibrateJobEta: EtaDashboardViewProps['onRecalibrateJobEta'];
  onComplete: () => void;
  onCancelPrinting?: () => void;
}

const ActivePrintCountdownCard: React.FC<ActivePrintCountdownCardProps> = ({
  slot,
  nowMs,
  timezone,
  isAdmin = true,
  isBusy = false,
  onPauseOrResume,
  onRecalibrateJobEta,
  onComplete,
  onCancelPrinting,
}) => {
  const {
    job,
    project,
    colorName,
    assignedMachineName,
    isPaused,
    needsEtaRecalibration,
    isAwaitingConfirmation,
    remainingSecondsLive,
    startMs,
    endMs,
  } = slot;

  const [editingRemaining, setEditingRemaining] = useState<boolean>(false);
  const [remMinutesInput, setRemMinutesInput] = useState<number>(() =>
    Math.max(1, Math.ceil((remainingSecondsLive || slot.effectivePrintMinutes * 60) / 60))
  );

  const totalEstSecs = Math.max(60, slot.effectivePrintMinutes * 60);
  const pctDone = needsEtaRecalibration
    ? 0
    : Math.min(
        100,
        Math.max(0, Math.round(((totalEstSecs - remainingSecondsLive) / totalEstSecs) * 100))
      );

  const statusText = needsEtaRecalibration
    ? ETA_NEEDS_RECALIBRATION_LABEL
    : isPaused
    ? 'Paused (Frozen)'
    : isAwaitingConfirmation
    ? ETA_REACHED_LABEL
    : 'Printing Live';

  return (
    <article
      className={`min-w-0 w-full max-w-full rounded-xl border p-4 space-y-3 ${
        needsEtaRecalibration || isPaused
          ? 'border-warning-border bg-warning-soft'
          : isAwaitingConfirmation
          ? 'border-brand-border bg-brand-soft'
          : 'border-line bg-elevated'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2 min-w-0">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink break-words">
            {assignedMachineName} · Plate {job.plateNumber}
          </div>
          <div className="text-xs text-muted break-words">
            {project?.name || 'Project'} · {colorName} · {countPlateKeycaps(job)}/{job.plateCapacity} pcs
          </div>
        </div>
        <span
          className={`px-2 py-0.5 rounded-md border text-[11px] font-semibold break-words ${
            needsEtaRecalibration || isPaused
              ? 'border-warning-border bg-surface text-warning-text'
              : 'border-brand-border bg-brand-soft text-brand-text'
          }`}
        >
          {statusText}
        </span>
      </div>

      <PlateCompositionSummary letters={job.letters} charms={job.charms} compact />

      {needsEtaRecalibration ? (
        <EtaRecalibrationBox
          jobId={job.id}
          plateNumber={job.plateNumber}
          defaultDurationMinutes={slot.effectivePrintMinutes}
          nowMs={nowMs}
          timezone={timezone}
          disabled={isBusy}
          onRecalibrate={onRecalibrateJobEta}
        />
      ) : (
        <>
          {/* Big Tabular Countdown & Finish Timestamp */}
          <div className="flex flex-wrap items-baseline justify-between gap-2 pt-1">
            <div>
              <div className="text-[11px] text-muted">Remaining Countdown</div>
              <div className="text-2xl font-bold font-mono-data text-ink">
                {formatCountdownHMS(remainingSecondsLive)}
              </div>
              {isAwaitingConfirmation && (
                <div className="text-[11px] font-semibold text-brand-text mt-0.5">
                  {ETA_REACHED_LABEL}
                </div>
              )}
            </div>
            <div className="text-right">
              <div className="text-[11px] text-muted">
                {isPaused ? 'Projected Finish (if resumed now)' : 'Estimated Finish'}
              </div>
              <div className="text-xs font-mono-data font-semibold text-ink">
                {endMs ? formatDateTimeDDMMYYYY(endMs, timezone) : '—'}
              </div>
              {startMs && (
                <div className="text-[11px] font-mono-data text-muted">
                  Started: {formatDateTimeDDMMYYYY(startMs, timezone)}
                </div>
              )}
            </div>
          </div>

          <div className="h-2 rounded-full bg-recessed border border-line/60 overflow-hidden">
            <div
              className={`h-full transition-all ${
                isPaused
                  ? 'bg-status-warning'
                  : 'bg-brand'
              }`}
              style={{ width: `${pctDone}%` }}
            />
          </div>

          {/* Update Remaining Duration Box (always accessible when paused or via Adjust button) */}
          {(isPaused || editingRemaining) && (
            <div className="p-3 rounded-lg bg-surface border border-line flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-medium text-ink-secondary">
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
                  className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-brand hover:bg-brand-hover text-white whitespace-nowrap transition-colors"
                >
                  Update ETA
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Action Controls */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 min-w-0">
        <div className="flex flex-wrap items-stretch gap-2 min-w-0 w-full sm:w-auto">
          {!needsEtaRecalibration &&
            (!isPaused ? (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => {
                  const curMins = Math.max(0, Math.ceil(remainingSecondsLive / 60));
                  setRemMinutesInput(Math.max(1, curMins));
                  onPauseOrResume(job.id, 'pause');
                }}
                className="w-full sm:w-auto grow sm:grow-0 min-w-0 inline-flex items-center justify-center px-3 py-1.5 text-xs font-semibold rounded-lg border border-warning-border text-warning-text bg-surface hover:bg-warning-soft text-center leading-tight break-words disabled:opacity-50 transition-colors"
              >
                Pause Print
              </button>
            ) : (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => onPauseOrResume(job.id, 'resume')}
                className="w-full sm:w-auto grow sm:grow-0 min-w-0 inline-flex items-center justify-center px-3 py-1.5 text-xs font-semibold rounded-lg bg-brand hover:bg-brand-hover text-white text-center leading-tight break-words disabled:opacity-50 transition-colors"
              >
                Resume Countdown
              </button>
            ))}

          {!needsEtaRecalibration && !isPaused && (
            <button
              type="button"
              onClick={() => {
                setRemMinutesInput(Math.max(1, Math.ceil(remainingSecondsLive / 60)));
                setEditingRemaining(!editingRemaining);
              }}
              className="w-full sm:w-auto grow sm:grow-0 min-w-0 inline-flex items-center justify-center px-2.5 py-1.5 text-xs font-medium rounded-lg border border-line bg-surface hover:bg-recessed text-ink-secondary hover:text-ink text-center leading-tight break-words transition-colors"
            >
              {editingRemaining ? 'Close Adjust' : 'Adjust Remaining'}
            </button>
          )}
          {onCancelPrinting && (
            <button
              type="button"
              disabled={!isAdmin || isBusy}
              onClick={onCancelPrinting}
              className="w-full sm:w-auto grow sm:grow-0 min-w-0 inline-flex items-center justify-center px-2.5 py-1.5 text-xs font-medium rounded-lg border border-error-border bg-surface hover:bg-error-soft text-error-text disabled:opacity-45 text-center leading-tight break-words transition-colors"
            >
              Cancel Print
            </button>
          )}
        </div>

        <button
          type="button"
          disabled={isBusy}
          onClick={onComplete}
          className="w-full sm:w-auto grow sm:grow-0 min-w-0 inline-flex items-center justify-center px-3 py-1.5 text-xs font-semibold rounded-lg bg-brand hover:bg-brand-hover text-white disabled:opacity-50 text-center leading-tight break-words transition-colors"
        >
          {countLetters(job.letters) > 0 ? 'Complete Print (+Stock)' : 'Complete Print'}
        </button>
      </div>
    </article>
  );
};
