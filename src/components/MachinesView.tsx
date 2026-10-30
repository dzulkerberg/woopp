import React, { useState } from 'react';
import {
  countLetters,
  countPlateKeycaps,
  DEFAULT_PLATE_CAPACITY,
  formatPlateItemsText,
  MACHINE_STATUSES,
} from '../constants';
import {
  EtaRecalibrationInput,
  KanbanStage,
  MachineStatus,
  PrinterMachine,
  ProductionJob,
  ProductionWorkspaceV5,
} from '../types';
import {
  formatCountdownHMS,
  formatDateTimeDDMMYYYY,
  formatDurationHoursMinutes,
} from '../utils/dateFormat';
import {
  ETA_NEEDS_RECALIBRATION_LABEL,
  ETA_REACHED_LABEL,
} from '../utils/productionCountdown';
import { GlobalScheduleResult } from '../utils/schedulingEngine';
import { EtaRecalibrationBox } from './EtaRecalibrationBox';
import { PlateCompositionSummary } from './PlateCompositionSummary';

interface MachinesViewProps {
  workspace: ProductionWorkspaceV5;
  schedule: GlobalScheduleResult;
  isAdmin?: boolean;
  busyJobIds?: ReadonlySet<string>;
  onAddMachine: (name: string, model: string, capacity: number) => boolean;
  onUpdateMachine: (
    machineId: string,
    updates: Partial<
      Pick<
        PrinterMachine,
        | 'name'
        | 'model'
        | 'status'
        | 'plateCapacity'
        | 'notes'
        | 'speedFactor'
        | 'setupBufferMinutes'
        | 'maintenanceUntilMs'
      >
    >
  ) => void;
  onRemoveMachine: (machineId: string) => void;
  onAssignAndStartJob: (jobId: string, machineId: string) => void;
  onPauseOrResume: (
    jobId: string,
    action: 'pause' | 'resume' | 'update_remaining',
    overrideRemainingMinutes?: number
  ) => void;
  onRecalibrateJobEta: (jobId: string, input: EtaRecalibrationInput) => void;
  onTransitionStage: (
    jobId: string,
    nextStage: KanbanStage,
    opts?: { machineId?: string | null; actualMinutes?: number; failureReason?: string }
  ) => void;
  onRequestCancelPrinting?: (job: ProductionJob) => void;
}

export const MachinesView: React.FC<MachinesViewProps> = ({
  workspace,
  schedule,
  isAdmin = true,
  busyJobIds,
  onAddMachine,
  onUpdateMachine,
  onRemoveMachine,
  onAssignAndStartJob,
  onPauseOrResume,
  onRecalibrateJobEta,
  onTransitionStage,
  onRequestCancelPrinting,
}) => {
  const [newName, setNewName] = useState('');
  const [newModel, setNewModel] = useState('Bambu Lab A1');
  const [newCap, setNewCap] = useState(DEFAULT_PLATE_CAPACITY);
  const [selectedJobForMachine, setSelectedJobForMachine] = useState<Record<string, string>>({});
  const [maintHoursDraft, setMaintHoursDraft] = useState<Record<string, number>>({});

  const readyOrPlannedJobs = workspace.jobs.filter(
    (j) => !j.archived && (j.stage === 'Ready to Print' || j.stage === 'Planned')
  );

  const totalFleetMinutes = workspace.machines.reduce(
    (sum, m) => sum + (m.totalPrintMinutes || 0),
    0
  );

  const { timezone } = schedule;

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    if (onAddMachine(newName.trim(), newModel.trim() || '3D Printer', newCap)) {
      setNewName('');
    }
  };

  return (
    <div className="space-y-6">
      {/* Add Printer Form */}
      <form
        onSubmit={handleCreate}
        className="bg-surface border border-line rounded-xl p-5 flex flex-wrap items-end gap-4"
      >
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs font-semibold text-ink-secondary mb-1">
            Printer Name
          </label>
          <input
            placeholder="e.g. Bambu P1S #2"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={60}
            className="w-full px-3 py-2 rounded-lg border border-line bg-input text-sm text-ink placeholder:text-muted focus:border-brand"
          />
        </div>

        <div className="w-48">
          <label className="block text-xs font-semibold text-ink-secondary mb-1">
            Printer Model
          </label>
          <input
            placeholder="Bambu Lab A1"
            value={newModel}
            onChange={(e) => setNewModel(e.target.value)}
            maxLength={60}
            className="w-full px-3 py-2 rounded-lg border border-line bg-input text-sm text-ink placeholder:text-muted focus:border-brand"
          />
        </div>

        <div className="w-36">
          <label className="block text-xs font-semibold text-ink-secondary mb-1">
            Bed Cap (pcs)
          </label>
          <input
            type="number"
            min={1}
            max={1000}
            value={newCap}
            onChange={(e) => setNewCap(Math.max(1, Number(e.target.value) || 138))}
            className="w-full px-3 py-2 rounded-lg border border-line bg-input text-sm font-mono-data text-ink focus:border-brand"
          />
        </div>

        <button
          type="submit"
          className="px-4 py-2 text-xs font-semibold rounded-lg bg-brand hover:bg-brand-hover text-white whitespace-nowrap h-[38px] transition-colors"
        >
          + Add Printer
        </button>
      </form>

      {/* Printer Fleet Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {workspace.machines.map((machine) => {
          const msSummary = schedule.machineSchedules.find(
            (ms) => ms.machine.id === machine.id
          );
          const activeSlot = msSummary?.activeSlot || null;
          const activeJob = activeSlot?.job || null;
          const queuedSlots = msSummary?.queuedSlots || [];

          const utilShare =
            totalFleetMinutes > 0
              ? Math.round(((machine.totalPrintMinutes || 0) / totalFleetMinutes) * 100)
              : 0;

          const statusSelectClass =
            machine.status === 'Printing'
              ? 'border-brand-border bg-brand-soft text-brand-text'
              : machine.status === 'Maintenance'
              ? 'border-warning-border bg-warning-soft text-warning-text'
              : machine.status === 'Offline'
              ? 'border-line bg-recessed text-muted'
              : machine.status === 'Completed'
              ? 'border-brand-border bg-brand-soft text-brand-text'
              : 'border-line bg-input text-ink';

          return (
            <section
              key={machine.id}
              className="min-w-0 bg-surface border border-line rounded-xl p-5 flex flex-col justify-between space-y-4"
            >
              <div className="space-y-4 min-w-0">
                {/* Machine Header & Editable Name */}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`w-2 h-2 rounded-xs shrink-0 ${
                          machine.status === 'Printing' || machine.status === 'Completed'
                            ? 'bg-status-success'
                            : machine.status === 'Maintenance'
                            ? 'bg-status-warning'
                            : machine.status === 'Offline'
                            ? 'bg-status-neutral'
                            : 'bg-status-info'
                        }`}
                        aria-hidden="true"
                      />
                      <EditableMachineTitle
                        name={machine.name}
                        onRename={(next) => onUpdateMachine(machine.id, { name: next })}
                      />
                    </div>
                    <div className="text-xs text-muted mt-0.5 pl-4">
                      {machine.model} · Bed: {machine.plateCapacity} pcs
                    </div>
                  </div>

                  <select
                    aria-label={`Status for ${machine.name}`}
                    value={machine.status}
                    onChange={(e) => {
                      const nextStatus = e.target.value as MachineStatus;
                      onUpdateMachine(machine.id, {
                        status: nextStatus,
                        maintenanceUntilMs:
                          nextStatus === 'Maintenance'
                            ? Date.now() + 2 * 3600_000
                            : null,
                      });
                    }}
                    className={`px-2.5 py-1 rounded-lg border text-xs font-semibold transition-colors ${statusSelectClass}`}
                  >
                    {MACHINE_STATUSES.map((st) => (
                      <option key={st} value={st} className="bg-surface text-ink">
                        {st}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Telemetry & Speed / Setup Tuning */}
                <div className="grid grid-cols-3 gap-2 pt-3 border-t border-line text-xs">
                  <div>
                    <div className="text-muted">Completed</div>
                    <div className="font-mono-data font-semibold text-ink mt-0.5">
                      {machine.totalCompletedPlates} plates
                    </div>
                  </div>
                  <div>
                    <div className="text-muted">Runtime</div>
                    <div className="font-mono-data font-semibold text-ink mt-0.5">
                      {formatDurationHoursMinutes(machine.totalPrintMinutes)}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted">Fleet Share</div>
                    <div className="font-mono-data font-semibold text-ink mt-0.5">
                      {utilShare}% ({machine.totalFailedPlates} fail)
                    </div>
                  </div>
                </div>

                {/* Printer-Specific Speed Factor & Setup Time */}
                <div className="grid grid-cols-2 gap-2.5 pt-2 border-t border-line text-xs">
                  <div>
                    <label className="block text-[11px] text-muted mb-1">
                      Speed Multiplier
                    </label>
                    <input
                      type="number"
                      step={0.05}
                      min={0.5}
                      max={2.5}
                      value={machine.speedFactor ?? 1}
                      onChange={(e) =>
                        onUpdateMachine(machine.id, {
                          speedFactor: Math.max(0.5, Math.min(2.5, Number(e.target.value) || 1)),
                        })
                      }
                      className="w-full px-2 py-1 rounded-lg border border-line bg-input text-ink font-mono-data focus:border-brand"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-muted mb-1">
                      Extra Prep / Setup (m)
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={180}
                      value={machine.setupBufferMinutes ?? 0}
                      onChange={(e) =>
                        onUpdateMachine(machine.id, {
                          setupBufferMinutes: Math.max(0, Math.round(Number(e.target.value) || 0)),
                        })
                      }
                      className="w-full px-2 py-1 rounded-lg border border-line bg-input text-ink font-mono-data focus:border-brand"
                    />
                  </div>
                </div>

                {/* Maintenance Downtime Window */}
                {machine.status === 'Maintenance' && (
                  <div className="p-3 rounded-lg bg-warning-soft border border-warning-border space-y-2 text-xs">
                    <div className="font-semibold text-warning-text">
                      Maintenance Downtime Window
                    </div>
                    {machine.maintenanceUntilMs && machine.maintenanceUntilMs > schedule.nowMs ? (
                      <div className="font-mono-data text-warning-text">
                        Available at: {formatDateTimeDDMMYYYY(machine.maintenanceUntilMs, timezone)}
                      </div>
                    ) : (
                      <div className="text-warning-text">
                        Indefinite until return window set
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={1}
                        max={72}
                        placeholder="Hours"
                        value={maintHoursDraft[machine.id] ?? 2}
                        onChange={(e) =>
                          setMaintHoursDraft({
                            ...maintHoursDraft,
                            [machine.id]: Math.max(1, Number(e.target.value) || 2),
                          })
                        }
                        className="w-16 px-2 py-1 rounded-lg border border-warning-border bg-input text-ink font-mono-data"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const hrs = maintHoursDraft[machine.id] ?? 2;
                          onUpdateMachine(machine.id, {
                            maintenanceUntilMs: Date.now() + hrs * 3600_000,
                          });
                        }}
                        className="px-2.5 py-1 rounded-lg bg-status-warning hover:opacity-90 text-white font-semibold whitespace-nowrap transition-opacity"
                      >
                        Set +{maintHoursDraft[machine.id] ?? 2}h Downtime
                      </button>
                    </div>
                  </div>
                )}

                {/* Active Print Slot (Overlap Protected + Live Countdown) */}
                {activeSlot && activeJob ? (
                  <div
                    className={`min-w-0 p-3.5 rounded-xl border space-y-2.5 ${
                      activeSlot.needsEtaRecalibration || activeSlot.isPaused
                        ? 'bg-warning-soft border-warning-border'
                        : 'bg-brand-soft border-brand-border'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs min-w-0">
                      <span
                        className={`font-semibold break-words ${
                          activeSlot.needsEtaRecalibration || activeSlot.isPaused
                            ? 'text-warning-text'
                            : 'text-brand-text'
                        }`}
                      >
                        Plate {activeJob.plateNumber} (
                        {activeSlot.needsEtaRecalibration
                          ? ETA_NEEDS_RECALIBRATION_LABEL
                          : activeSlot.isPaused
                          ? 'Paused'
                          : activeSlot.isAwaitingConfirmation
                          ? ETA_REACHED_LABEL
                          : 'Printing'}
                        )
                      </span>
                      {!activeSlot.needsEtaRecalibration && (
                        <span className="font-mono-data font-bold text-ink">
                          {formatCountdownHMS(activeSlot.remainingSecondsLive)}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-ink-secondary break-words">
                      {activeSlot.project?.name} · {activeSlot.colorName} ({countPlateKeycaps(activeJob)}/
                      {activeJob.plateCapacity} pcs)
                    </div>
                    <PlateCompositionSummary
                      letters={activeJob.letters}
                      charms={activeJob.charms}
                      compact
                    />
                    {activeSlot.needsEtaRecalibration ? (
                      <EtaRecalibrationBox
                        compact
                        jobId={activeJob.id}
                        plateNumber={activeJob.plateNumber}
                        defaultDurationMinutes={activeSlot.effectivePrintMinutes}
                        nowMs={schedule.nowMs}
                        timezone={timezone}
                        disabled={Boolean(busyJobIds?.has(activeJob.id))}
                        onRecalibrate={onRecalibrateJobEta}
                      />
                    ) : (
                      activeSlot.endMs && (
                        <div className="text-[11px] font-mono-data text-muted break-words">
                          Est Finish: {formatDateTimeDDMMYYYY(activeSlot.endMs, timezone)}
                        </div>
                      )
                    )}
                    <div className="flex flex-wrap items-stretch gap-1.5 pt-1 min-w-0">
                      {!activeSlot.needsEtaRecalibration && (
                        <button
                          type="button"
                          onClick={() =>
                            onPauseOrResume(
                              activeJob.id,
                              activeSlot.isPaused ? 'resume' : 'pause'
                            )
                          }
                          className="w-full sm:w-auto grow min-w-0 inline-flex items-center justify-center px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-line bg-surface hover:bg-elevated text-ink text-center leading-tight break-words transition-colors"
                        >
                          {activeSlot.isPaused ? 'Resume' : 'Pause'}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          onTransitionStage(activeJob.id, 'Completed', {
                            machineId: machine.id,
                          })
                        }
                        className="w-full sm:w-auto grow min-w-0 inline-flex items-center justify-center px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-brand hover:bg-brand-hover text-white text-center leading-tight break-words transition-colors"
                      >
                        {countLetters(activeJob.letters) > 0 ? 'Complete (+Stock)' : 'Complete Print'}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          onTransitionStage(activeJob.id, 'Failed / Reprint', {
                            machineId: machine.id,
                            failureReason: 'Failed on ' + machine.name,
                          })
                        }
                        className="w-full sm:w-auto grow min-w-0 inline-flex items-center justify-center px-2.5 py-1.5 text-xs font-medium rounded-lg border border-error-border text-error-text bg-surface hover:bg-error-soft text-center leading-tight break-words transition-colors"
                      >
                        Fail
                      </button>
                      {onRequestCancelPrinting && (
                        <button
                          type="button"
                          disabled={!isAdmin || Boolean(busyJobIds?.has(activeJob.id))}
                          onClick={() => onRequestCancelPrinting(activeJob)}
                          className="w-full sm:w-auto grow min-w-0 inline-flex items-center justify-center px-2.5 py-1.5 text-xs font-medium rounded-lg border border-error-border text-error-text hover:bg-error-soft bg-surface disabled:opacity-45 text-center leading-tight break-words transition-colors"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="min-w-0 p-3.5 rounded-xl bg-recessed border border-line space-y-2">
                    <div className="text-xs font-medium text-ink-secondary">
                      {machine.status === 'Maintenance' || machine.status === 'Offline'
                        ? `Unavailable (${machine.status})`
                        : 'Ready for Print Assignment'}
                    </div>
                    {machine.status !== 'Maintenance' && machine.status !== 'Offline' && (
                      <div className="flex flex-wrap items-center gap-2 min-w-0">
                        <select
                          aria-label={`Select plate to start on ${machine.name}`}
                          value={selectedJobForMachine[machine.id] || ''}
                          onChange={(e) =>
                            setSelectedJobForMachine({
                              ...selectedJobForMachine,
                              [machine.id]: e.target.value,
                            })
                          }
                          className="w-full sm:w-auto flex-1 min-w-0 max-w-full px-2 py-1.5 rounded-lg border border-line bg-input text-xs text-ink"
                        >
                          <option value="">Select queued plate...</option>
                          {readyOrPlannedJobs.map((j) => {
                            const p = workspace.projects.find((pr) => pr.id === j.projectId);
                            const c = workspace.colors.find((cl) => cl.id === j.colorId);
                            const summary = formatPlateItemsText(j, true);
                            const shortSummary =
                              summary.length > 42 ? `${summary.slice(0, 42)}…` : summary;
                            return (
                              <option key={j.id} value={j.id}>
                                {p?.name} · {c?.name} · P{j.plateNumber} ({countPlateKeycaps(j)} pcs ·{' '}
                                {formatDurationHoursMinutes(j.estimatedMinutes)}) — {shortSummary}
                              </option>
                            );
                          })}
                        </select>
                        <button
                          type="button"
                          disabled={!selectedJobForMachine[machine.id]}
                          onClick={() => {
                            const jid = selectedJobForMachine[machine.id];
                            if (jid) {
                              onAssignAndStartJob(jid, machine.id);
                              setSelectedJobForMachine({
                                ...selectedJobForMachine,
                                [machine.id]: '',
                              });
                            }
                          }}
                          className="w-full sm:w-auto grow sm:grow-0 inline-flex items-center justify-center px-3 py-1.5 text-xs font-semibold rounded-lg bg-brand hover:bg-brand-hover disabled:opacity-40 text-white text-center leading-tight transition-colors"
                        >
                          Start Print
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Scheduled Upcoming Queue for this Machine */}
                {queuedSlots.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-[11px] font-semibold text-muted">
                      Scheduled Queue ({queuedSlots.length})
                    </div>
                    {queuedSlots.slice(0, 3).map((qs) => (
                      <div
                        key={qs.job.id}
                        className="text-xs text-ink-secondary flex items-center justify-between gap-2"
                      >
                        <span className="truncate">
                          P{qs.job.plateNumber} · {qs.project?.name} ({countPlateKeycaps(qs.job)} pcs)
                          {qs.isVirtualAssignment ? ' (Auto)' : ''}
                        </span>
                        <span className="font-mono-data text-[11px] text-muted shrink-0">
                          {qs.endMs ? formatDateTimeDDMMYYYY(qs.endMs, timezone) : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="pt-3 border-t border-line flex items-center justify-between gap-2">
                <input
                  value={machine.notes}
                  placeholder="Nozzle / maintenance note..."
                  onChange={(e) => onUpdateMachine(machine.id, { notes: e.target.value })}
                  className="flex-1 min-w-0 px-2.5 py-1 text-xs rounded-lg border border-line bg-input text-ink placeholder:text-muted focus:border-brand"
                />
                <button
                  type="button"
                  onClick={() => onRemoveMachine(machine.id)}
                  className="text-xs text-muted hover:text-error-text shrink-0 transition-colors"
                >
                  Remove
                </button>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
};

const EditableMachineTitle: React.FC<{ name: string; onRename: (n: string) => void }> = ({
  name,
  onRename,
}) => {
  const [val, setVal] = useState(name);
  React.useEffect(() => setVal(name), [name]);

  return (
    <input
      aria-label="Machine name"
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => {
        const trimmed = val.trim();
        if (trimmed && trimmed !== name) {
          onRename(trimmed);
        } else {
          setVal(name);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
      className="text-sm font-semibold text-ink bg-transparent border-b border-transparent hover:border-line focus:border-brand focus:outline-none w-full"
    />
  );
};
