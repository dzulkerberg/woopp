import React, { useMemo, useState } from 'react';
import { countLetters } from '../constants';
import { ProductionWorkspaceV5 } from '../types';
import {
  formatDateTimeDDMMYYYY,
  formatDurationHoursMinutes,
  formatTimeHHMM,
} from '../utils/dateFormat';
import { GlobalScheduleResult, ScheduledJobSlot } from '../utils/schedulingEngine';

interface ProductionTimelineViewProps {
  workspace: ProductionWorkspaceV5;
  schedule: GlobalScheduleResult;
  onAssignMachineToQueuedJob: (jobId: string, machineId: string | null) => void;
}

export const ProductionTimelineView: React.FC<ProductionTimelineViewProps> = ({
  workspace,
  schedule,
  onAssignMachineToQueuedJob,
}) => {
  const [horizonHours, setHorizonHours] = useState<12 | 24 | 48 | 72>(24);
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);

  const { nowMs, timezone, machineSchedules, turnaroundBufferMinutes } = schedule;
  const windowEndMs = nowMs + horizonHours * 3600_000;
  const windowSpanMs = windowEndMs - nowMs;

  const tickMarks = useMemo(() => {
    const stepHours = horizonHours <= 12 ? 2 : horizonHours <= 24 ? 4 : 8;
    const ticks: { ms: number; pct: number; label: string }[] = [];
    for (let h = 0; h <= horizonHours; h += stepHours) {
      const ms = nowMs + h * 3600_000;
      ticks.push({
        ms,
        pct: (h / horizonHours) * 100,
        label: h === 0 ? 'Now' : `+${h}h (${formatTimeHHMM(ms, timezone)})`,
      });
    }
    return ticks;
  }, [nowMs, horizonHours, timezone]);

  const selectedSlot: ScheduledJobSlot | null = selectedSlotId
    ? schedule.slotsByJobId[selectedSlotId] || null
    : null;

  return (
    <div className="space-y-6">
      {/* Timeline Horizon Controls */}
      <div className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-white">
            Multi-Printer Gantt Schedule ({timezone})
          </h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
            All active projects scheduled together without machine overlap · Includes {turnaroundBufferMinutes}m turnaround buffer between plates.
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 bg-neutral-100 dark:bg-[#111018] rounded-lg border border-neutral-200/70 dark:border-neutral-800">
          {([12, 24, 48, 72] as const).map((hrs) => (
            <button
              key={hrs}
              type="button"
              onClick={() => setHorizonHours(hrs)}
              className={`px-3 py-1 text-xs font-medium rounded-md whitespace-nowrap ${
                horizonHours === hrs
                  ? 'bg-white dark:bg-[#2a2440] text-neutral-900 dark:text-white'
                  : 'text-neutral-500 dark:text-neutral-400'
              }`}
            >
              {hrs}h Window
            </button>
          ))}
        </div>
      </div>

      {/* Visual Gantt Board */}
      <section className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-2xl p-6 overflow-x-auto">
        <div className="min-w-[820px] space-y-4">
          {/* Time Axis Header */}
          <div className="grid grid-cols-12 gap-4 items-end pb-2 border-b border-neutral-200 dark:border-neutral-800">
            <div className="col-span-3 text-xs font-semibold text-neutral-500">
              Bambu Printer Lane
            </div>
            <div className="col-span-9 relative h-6">
              {tickMarks.map((tick) => (
                <div
                  key={tick.ms}
                  style={{ left: `${Math.min(96, tick.pct)}%` }}
                  className="absolute bottom-0 text-[11px] font-mono-data text-neutral-400 whitespace-nowrap"
                >
                  {tick.label}
                </div>
              ))}
            </div>
          </div>

          {/* Printer Lanes */}
          <div className="divide-y divide-neutral-100 dark:divide-neutral-800/70">
            {machineSchedules.map((ms) => {
              const allSlots: ScheduledJobSlot[] = [
                ...(ms.activeSlot ? [ms.activeSlot] : []),
                ...ms.queuedSlots,
              ];

              const maintenanceEnd =
                ms.machine.status === 'Maintenance' &&
                ms.machine.maintenanceUntilMs &&
                ms.machine.maintenanceUntilMs > nowMs
                  ? ms.machine.maintenanceUntilMs
                  : null;

              const maintWidthPct = maintenanceEnd
                ? Math.min(100, Math.max(1, ((maintenanceEnd - nowMs) / windowSpanMs) * 100))
                : 0;

              return (
                <div
                  key={ms.machine.id}
                  className="py-4 grid grid-cols-12 gap-4 items-center"
                >
                  {/* Machine Label Column */}
                  <div className="col-span-3 pr-2">
                    <div className="text-sm font-semibold text-neutral-900 dark:text-white truncate">
                      {ms.machine.name}
                    </div>
                    <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                      {ms.machine.status} · {allSlots.length} scheduled
                      {ms.machine.setupBufferMinutes
                        ? ` · +${ms.machine.setupBufferMinutes}m setup`
                        : ''}
                    </div>
                  </div>

                  {/* Timeline Track Column */}
                  <div className="col-span-9 relative h-14 rounded-xl bg-neutral-50 dark:bg-[#12101b] border border-neutral-200/70 dark:border-neutral-800 overflow-hidden">
                    {ms.machine.status === 'Offline' ? (
                      <div className="h-full flex items-center justify-center text-xs text-neutral-400">
                        Printer Offline — Excluded from automatic scheduling
                      </div>
                    ) : ms.machine.status === 'Maintenance' && !maintenanceEnd ? (
                      <div className="h-full flex items-center justify-center text-xs text-amber-600 dark:text-amber-400">
                        In Maintenance (Set return time in Machines to schedule upcoming plates)
                      </div>
                    ) : (
                      <>
                        {/* Scheduled Maintenance Block */}
                        {maintenanceEnd && (
                          <div
                            style={{ left: '0%', width: `${maintWidthPct}%` }}
                            className="absolute top-1.5 bottom-1.5 rounded-lg bg-amber-200/70 dark:bg-amber-900/50 border border-amber-400/60 px-2 flex items-center text-[11px] font-medium text-amber-900 dark:text-amber-200 truncate"
                            title={`Maintenance until ${formatDateTimeDDMMYYYY(
                              maintenanceEnd,
                              timezone
                            )}`}
                          >
                            Maint.
                          </div>
                        )}

                        {/* Job Blocks */}
                        {allSlots.map((slot) => {
                          if (slot.startMs === null || slot.endMs === null) return null;
                          const clampedStart = Math.max(nowMs, slot.startMs);
                          if (clampedStart >= windowEndMs || slot.endMs <= nowMs) return null;

                          const clampedEnd = Math.min(windowEndMs, slot.endMs);
                          const leftPct = ((clampedStart - nowMs) / windowSpanMs) * 100;
                          const widthPct = Math.max(
                            2.2,
                            ((clampedEnd - clampedStart) / windowSpanMs) * 100
                          );

                          const isSelected = selectedSlotId === slot.job.id;

                          return (
                            <button
                              key={slot.job.id}
                              type="button"
                              onClick={() => setSelectedSlotId(slot.job.id)}
                              style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                              title={`Plate ${slot.job.plateNumber} (${slot.project?.name}) · ${formatDateTimeDDMMYYYY(
                                slot.startMs,
                                timezone
                              )} → ${formatDateTimeDDMMYYYY(slot.endMs, timezone)}`}
                              className={`absolute top-1.5 bottom-1.5 rounded-lg px-2 text-left transition-opacity overflow-hidden flex flex-col justify-center border ${
                                slot.exceedsProjectDeadline
                                  ? 'bg-red-600 text-white border-red-700'
                                  : slot.isActivePrinting
                                  ? slot.isPaused
                                    ? 'bg-amber-500 text-white border-amber-600'
                                    : 'bg-[#6c4ce6] text-white border-[#5b3cc4]'
                                  : slot.isVirtualAssignment
                                  ? 'bg-[#ebe6fc] dark:bg-[#26203d] text-[#4c32a8] dark:text-[#cfc2ff] border-dashed border-[#9d86f5]'
                                  : 'bg-[#dfd7fb] dark:bg-[#31294f] text-[#3a238c] dark:text-[#e2daff] border-[#b4a1f8] dark:border-[#4f4182]'
                              } ${isSelected ? 'ring-2 ring-neutral-900 dark:ring-white z-10' : ''}`}
                            >
                              <div className="text-[11px] font-semibold leading-tight truncate">
                                P{slot.job.plateNumber} · {slot.project?.name}
                              </div>
                              <div className="text-[10px] opacity-90 font-mono-data truncate">
                                {formatDurationHoursMinutes(slot.effectivePrintMinutes)}
                                {slot.isVirtualAssignment ? ' (Auto)' : ''}
                              </div>
                            </button>
                          );
                        })}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Legend */}
          <div className="pt-3 border-t border-neutral-100 dark:border-neutral-800 flex flex-wrap items-center gap-5 text-xs text-neutral-500 dark:text-neutral-400">
            <span>Solid Purple: Active Print</span>
            <span>Tinted Lavender: Assigned Queue</span>
            <span>Dashed Border: Auto-Routed Unassigned Plate</span>
            <span>Amber: Paused / Maintenance</span>
            <span>Crimson: Exceeds Project Deadline</span>
          </div>
        </div>
      </section>

      {/* Selected Slot Inspector / Quick Pin Assignment */}
      {selectedSlot && (
        <section className="bg-white dark:bg-[#171522] border border-[#6c4ce6] rounded-2xl p-5 flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm font-semibold text-neutral-900 dark:text-white">
              Plate {selectedSlot.job.plateNumber} · {selectedSlot.project?.name} ({selectedSlot.colorName})
            </div>
            <div className="text-xs font-mono-data text-neutral-600 dark:text-neutral-300">
              {selectedSlot.startMs && selectedSlot.endMs
                ? `Scheduled: ${formatDateTimeDDMMYYYY(
                    selectedSlot.startMs,
                    timezone
                  )} → ${formatDateTimeDDMMYYYY(selectedSlot.endMs, timezone)} (${formatDurationHoursMinutes(
                    selectedSlot.effectivePrintMinutes
                  )} print + ${turnaroundBufferMinutes}m turnaround)`
                : 'Unscheduled — waiting for online machine'}
            </div>
            <div className="text-xs text-neutral-500">
              Keycaps: {countLetters(selectedSlot.job.letters)} pcs · Priority:{' '}
              {selectedSlot.project?.priority || 'Normal'}
              {selectedSlot.exceedsProjectDeadline && (
                <span className="text-red-600 dark:text-red-400 font-semibold ml-2">
                  · Warning: Finishes after project deadline
                </span>
              )}
            </div>
          </div>

          {!selectedSlot.isActivePrinting && (
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
                Pin to Printer:
              </label>
              <select
                value={selectedSlot.job.machineId || ''}
                onChange={(e) =>
                  onAssignMachineToQueuedJob(
                    selectedSlot.job.id,
                    e.target.value || null
                  )
                }
                className="px-3 py-1.5 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-[#111018] text-xs"
              >
                <option value="">Auto-Schedule (Earliest Free Printer)</option>
                {workspace.machines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.status})
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setSelectedSlotId(null)}
                className="px-3 py-1.5 text-xs rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300"
              >
                Close
              </button>
            </div>
          )}
        </section>
      )}

      {/* Chronological Global Upcoming Schedule Table */}
      <section className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-2xl p-6 space-y-4">
        <h3 className="text-base font-semibold text-neutral-900 dark:text-white">
          Upcoming Scheduled Queue (All Projects Combined)
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-neutral-200 dark:border-neutral-800 text-neutral-500">
                <th className="py-2.5 pr-3 font-medium">Plate &amp; Project</th>
                <th className="py-2.5 px-3 font-medium">Assigned Machine</th>
                <th className="py-2.5 px-3 font-medium">Duration</th>
                <th className="py-2.5 px-3 font-medium">Est. Start</th>
                <th className="py-2.5 pl-3 font-medium text-right">Est. Finish</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800/70">
              {Object.values(schedule.slotsByJobId)
                .sort((a, b) => (a.startMs ?? Infinity) - (b.startMs ?? Infinity))
                .map((slot) => (
                  <tr
                    key={slot.job.id}
                    onClick={() => setSelectedSlotId(slot.job.id)}
                    className="hover:bg-neutral-50 dark:hover:bg-neutral-800/30 cursor-pointer"
                  >
                    <td className="py-3 pr-3">
                      <span className="font-semibold text-neutral-900 dark:text-white">
                        Plate {slot.job.plateNumber}
                      </span>{' '}
                      <span className="text-neutral-500">
                        · {slot.project?.name} · {slot.colorName}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-neutral-700 dark:text-neutral-300">
                      {slot.assignedMachineName}
                      {slot.isVirtualAssignment ? ' (Auto)' : ''}
                    </td>
                    <td className="py-3 px-3 font-mono-data text-neutral-700 dark:text-neutral-300">
                      {formatDurationHoursMinutes(slot.effectivePrintMinutes)}
                    </td>
                    <td className="py-3 px-3 font-mono-data text-neutral-700 dark:text-neutral-300">
                      {slot.startMs ? formatDateTimeDDMMYYYY(slot.startMs, timezone) : '—'}
                    </td>
                    <td
                      className={`py-3 pl-3 text-right font-mono-data font-semibold ${
                        slot.exceedsProjectDeadline
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-neutral-900 dark:text-white'
                      }`}
                    >
                      {slot.endMs ? formatDateTimeDDMMYYYY(slot.endMs, timezone) : '—'}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
