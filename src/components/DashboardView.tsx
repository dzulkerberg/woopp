import React, { useMemo, useState } from 'react';
import {
  computeProjectPlateProgress,
  countPlateKeycaps,
  SALES_CHANNELS,
} from '../constants';
import { NavSection, ProductionWorkspaceV5 } from '../types';
import {
  formatActivityTimestamp,
  formatCountdownHMS,
  formatDateDDMMYYYY,
  formatDateTimeDDMMYYYY,
  formatDurationHoursMinutes,
  getTodayYYYYMMDD,
  toComparableYYYYMMDD,
} from '../utils/dateFormat';
import { GlobalScheduleResult } from '../utils/schedulingEngine';

interface DashboardViewProps {
  workspace: ProductionWorkspaceV5;
  schedule: GlobalScheduleResult;
  onNavigate: (nav: NavSection) => void;
  onSelectProject: (projectId: string) => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  workspace,
  schedule,
  onNavigate,
  onSelectProject,
}) => {
  const [channelFilter, setChannelFilter] = useState<string>('ALL');
  const [machineFilter, setMachineFilter] = useState<string>('ALL');
  const [colorFilter, setColorFilter] = useState<string>('ALL');

  const { timezone, activePrintingSlots, nextAvailableMachine, projectEtas, deadlineWarningsCount } =
    schedule;

  const activeProjects = useMemo(
    () =>
      workspace.projects.filter(
        (p) =>
          p.status !== 'Archived' &&
          (channelFilter === 'ALL' || p.salesChannel === channelFilter)
      ),
    [workspace.projects, channelFilter]
  );

  const activeProjectIds = useMemo(
    () => new Set(activeProjects.map((p) => p.id)),
    [activeProjects]
  );

  const filteredJobs = useMemo(
    () =>
      workspace.jobs.filter((j) => {
        if (!activeProjectIds.has(j.projectId)) return false;
        if (machineFilter !== 'ALL' && j.machineId !== machineFilter) return false;
        if (colorFilter !== 'ALL' && j.colorId !== colorFilter) return false;
        return true;
      }),
    [workspace.jobs, activeProjectIds, machineFilter, colorFilter]
  );

  const completedJobs = filteredJobs.filter((j) => j.stage === 'Completed');
  const printingJobs = filteredJobs.filter((j) => !j.archived && j.stage === 'Printing');
  const activePlanJobs = filteredJobs.filter(
    (j) => j.stage === 'Completed' || (!j.archived && j.stage !== 'Cancelled')
  );
  const remainingQueueJobs = filteredJobs.filter(
    (j) => !j.archived && j.stage !== 'Completed' && j.stage !== 'Cancelled'
  );
  const totalProducedKeycaps = completedJobs.reduce(
    (sum, j) => sum + countPlateKeycaps(j),
    0
  );
  const totalPlannedKeycaps = activePlanJobs.reduce(
    (sum, j) => sum + countPlateKeycaps(j),
    0
  );
  const totalEstMinutes = activePlanJobs.reduce(
    (sum, j) => sum + (j.estimatedMinutes || 0),
    0
  );
  const completedMinutes = completedJobs.reduce(
    (sum, j) => sum + (j.actualMinutes || j.estimatedMinutes || 0),
    0
  );

  const channelBreakdown = useMemo(() => {
    return SALES_CHANNELS.map((ch) => {
      const chProjects = workspace.projects.filter(
        (p) => p.status !== 'Archived' && p.salesChannel === ch
      );
      const chProjectIds = new Set(chProjects.map((p) => p.id));
      const chJobs = workspace.jobs.filter((j) => chProjectIds.has(j.projectId));
      const done = chJobs.filter((j) => j.stage === 'Completed');
      const validChJobs = chJobs.filter(
        (j) => j.stage === 'Completed' || (!j.archived && j.stage !== 'Cancelled')
      );
      const donePcs = done.reduce((s, j) => s + countPlateKeycaps(j), 0);
      const plannedPcs = validChJobs.reduce((s, j) => s + countPlateKeycaps(j), 0);
      const pct = plannedPcs > 0 ? Math.min(100, Math.round((donePcs / plannedPcs) * 100)) : 0;
      return {
        channel: ch,
        projectsCount: chProjects.length,
        donePcs,
        plannedPcs,
        pct,
      };
    });
  }, [workspace.projects, workspace.jobs]);

  const upcomingDeadlines = useMemo(() => {
    return activeProjects
      .filter((p) => Boolean(p.deadline) && p.status === 'Active')
      .sort((a, b) =>
        toComparableYYYYMMDD(a.deadline).localeCompare(toComparableYYYYMMDD(b.deadline))
      )
      .slice(0, 6);
  }, [activeProjects]);

  const projectEtaMap = useMemo(
    () => new Map(projectEtas.map((pe) => [pe.project.id, pe])),
    [projectEtas]
  );

  return (
    <div className="space-y-8">
      {/* Deadline Alert Strip if any project's parallel ETA exceeds its deadline */}
      {deadlineWarningsCount > 0 && (
        <div className="p-4 rounded-xl bg-red-50 dark:bg-red-950/35 border border-red-200 dark:border-red-900/60 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-red-800 dark:text-red-200">
            <span className="font-semibold">
              Schedule Warning: {deadlineWarningsCount}{' '}
              {deadlineWarningsCount === 1 ? 'project is' : 'projects are'} projected to finish after deadline
            </span>{' '}
            based on current parallel Bambu machine availability.
          </div>
          <button
            type="button"
            onClick={() => onNavigate('eta')}
            className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-semibold whitespace-nowrap"
          >
            Open ETA Dashboard
          </button>
        </div>
      )}

      {/* Quick Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-xl p-4">
        <div className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
          Production Overview
          <span className="ml-2 text-xs font-normal text-neutral-500 dark:text-neutral-400">
            · {timezone}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <select
            aria-label="Filter by sales channel"
            value={channelFilter}
            onChange={(e) => setChannelFilter(e.target.value)}
            className="px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-[#111018] text-xs text-neutral-800 dark:text-neutral-200"
          >
            <option value="ALL">All Sales Channels</option>
            {SALES_CHANNELS.map((ch) => (
              <option key={ch} value={ch}>
                {ch}
              </option>
            ))}
          </select>

          <select
            aria-label="Filter by printer"
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

          <select
            aria-label="Filter by color"
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
        </div>
      </div>

      {/* Top KPI Grid (Includes Next Available Machine & Live Countdown Summary) */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-xl p-5">
          <div className="text-xs text-neutral-500 dark:text-neutral-400">Active Projects</div>
          <div className="text-2xl font-bold text-neutral-900 dark:text-white mt-1 font-mono-data">
            {activeProjects.filter((p) => p.status === 'Active').length}
          </div>
          <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
            {workspace.projects.length} total registered
          </div>
        </div>

        <div className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-xl p-5">
          <div className="text-xs text-neutral-500 dark:text-neutral-400">Plates Completed</div>
          <div className="text-2xl font-bold text-[#6c4ce6] dark:text-[#b49eff] mt-1 font-mono-data">
            {completedJobs.length} / {activePlanJobs.length}
          </div>
          <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
            {remainingQueueJobs.length} remaining in queue
          </div>
        </div>

        <div className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-xl p-5">
          <div className="text-xs text-neutral-500 dark:text-neutral-400">Current Print Jobs</div>
          <div className="text-2xl font-bold text-amber-600 dark:text-amber-400 mt-1 font-mono-data">
            {printingJobs.length}
          </div>
          <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 truncate">
            {activePrintingSlots[0]
              ? `Next done: ${formatCountdownHMS(activePrintingSlots[0].remainingSecondsLive)}`
              : 'All printers idle'}
          </div>
        </div>

        <div className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-xl p-5">
          <div className="text-xs text-neutral-500 dark:text-neutral-400">Keycaps Produced</div>
          <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400 mt-1 font-mono-data">
            {totalProducedKeycaps.toLocaleString()}
          </div>
          <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
            of {totalPlannedKeycaps.toLocaleString()} planned pcs
          </div>
        </div>

        <div className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-xl p-5 col-span-2 lg:col-span-1">
          <div className="text-xs text-neutral-500 dark:text-neutral-400">Next Free Printer</div>
          <div className="text-base font-bold text-neutral-900 dark:text-white mt-1 truncate">
            {nextAvailableMachine ? nextAvailableMachine.machine.name : 'None Online'}
          </div>
          <div className="text-xs font-mono-data text-emerald-600 dark:text-emerald-400 mt-1">
            {nextAvailableMachine
              ? nextAvailableMachine.waitSeconds === 0
                ? 'Ready Now'
                : `In ${formatCountdownHMS(nextAvailableMachine.waitSeconds)}`
              : `${formatDurationHoursMinutes(completedMinutes)} / ${formatDurationHoursMinutes(totalEstMinutes)}`}
          </div>
        </div>
      </div>

      {/* Main 2-column Workspace Split */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-7 space-y-6">
          {/* Active Projects, Deadlines & Parallel Estimated Completion */}
          <section className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-neutral-900 dark:text-white">
                Project Deadlines &amp; Estimated Completion
              </h2>
              <button
                type="button"
                onClick={() => onNavigate('eta')}
                className="text-xs font-medium text-[#6c4ce6] dark:text-[#b49eff] hover:underline whitespace-nowrap"
              >
                Full ETA Schedule
              </button>
            </div>

            {activeProjects.length === 0 ? (
              <p className="text-sm text-neutral-500 dark:text-neutral-400 py-4">
                No active projects match the current filter.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-neutral-200 dark:border-neutral-800 text-xs text-neutral-500 dark:text-neutral-400">
                      <th className="py-2.5 pr-3 font-medium">Project</th>
                      <th className="py-2.5 px-3 font-medium">Deadline</th>
                      <th className="py-2.5 px-3 font-medium">Est. Completion</th>
                      <th className="py-2.5 pl-3 font-medium text-right">Progress</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800/70 text-xs">
                    {(upcomingDeadlines.length > 0 ? upcomingDeadlines : activeProjects.slice(0, 6)).map(
                      (proj) => {
                        const progress = computeProjectPlateProgress(workspace.jobs, proj.id);
                        const pct = progress.progressPct;
                        const comparableDeadline = toComparableYYYYMMDD(proj.deadline);
                        const etaInfo = projectEtaMap.get(proj.id);
                        const isOverdue =
                          etaInfo?.isDeadlineExceeded ||
                          (Boolean(comparableDeadline) &&
                            comparableDeadline < getTodayYYYYMMDD(timezone) &&
                            (progress.totalValidPlates === 0 || pct < 100));

                        return (
                          <tr
                            key={proj.id}
                            onClick={() => {
                              onSelectProject(proj.id);
                              onNavigate('projects');
                            }}
                            className="hover:bg-neutral-50 dark:hover:bg-neutral-800/40 cursor-pointer transition-colors"
                          >
                            <td className="py-3 pr-3">
                              <div className="font-semibold text-neutral-900 dark:text-white">
                                {proj.name}
                              </div>
                              <div className="text-[11px] text-neutral-500">
                                {proj.salesChannel} · {proj.priority}
                              </div>
                            </td>
                            <td
                              className={`py-3 px-3 font-mono-data ${
                                isOverdue
                                  ? 'text-red-600 dark:text-red-400 font-semibold'
                                  : 'text-neutral-600 dark:text-neutral-300'
                              }`}
                            >
                              {proj.deadline ? formatDateDDMMYYYY(proj.deadline) : 'Flexible'}
                            </td>
                            <td
                              className={`py-3 px-3 font-mono-data ${
                                etaInfo?.isDeadlineExceeded
                                  ? 'text-red-600 dark:text-red-400 font-semibold'
                                  : 'text-neutral-700 dark:text-neutral-200'
                              }`}
                            >
                              {etaInfo?.outstandingPlates === 0 &&
                              (etaInfo?.totalPlates || 0) > 0
                                ? 'Done'
                                : etaInfo?.estimatedCompletionMs
                                ? formatDateTimeDDMMYYYY(etaInfo.estimatedCompletionMs, timezone)
                                : '—'}
                            </td>
                            <td className="py-3 pl-3 text-right font-mono-data text-neutral-800 dark:text-neutral-200">
                              {pct}%
                            </td>
                          </tr>
                        );
                      }
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-neutral-900 dark:text-white">
                Progress by Sales Channel
              </h2>
              <button
                type="button"
                onClick={() => onNavigate('projects')}
                className="text-xs font-medium text-[#6c4ce6] dark:text-[#b49eff] hover:underline whitespace-nowrap"
              >
                Manage Projects
              </button>
            </div>

            <div className="space-y-4">
              {channelBreakdown.map((row) => (
                <div key={row.channel} className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <div className="font-medium text-neutral-800 dark:text-neutral-200">
                      {row.channel}
                      <span className="text-neutral-400 dark:text-neutral-500 ml-1.5">
                        · {row.projectsCount} {row.projectsCount === 1 ? 'project' : 'projects'}
                      </span>
                    </div>
                    <div className="font-mono-data text-neutral-600 dark:text-neutral-300">
                      {row.donePcs.toLocaleString()} / {row.plannedPcs.toLocaleString()} pcs ({row.pct}%)
                    </div>
                  </div>
                  <div className="h-2 rounded-full bg-neutral-100 dark:bg-neutral-800 overflow-hidden">
                    <div
                      className="h-full bg-[#6c4ce6] transition-opacity"
                      style={{ width: `${row.pct}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* Fleet Utilization & Recent Activity */}
        <div className="lg:col-span-5 space-y-6">
          <section className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-neutral-900 dark:text-white">
                Live Printer Fleet &amp; Countdowns
              </h2>
              <button
                type="button"
                onClick={() => onNavigate('timeline')}
                className="text-xs font-medium text-[#6c4ce6] dark:text-[#b49eff] hover:underline whitespace-nowrap"
              >
                Timeline View
              </button>
            </div>

            <div className="divide-y divide-neutral-100 dark:divide-neutral-800/70">
              {schedule.machineSchedules.map((ms) => {
                const { machine, activeSlot, queuedSlots } = ms;
                return (
                  <div
                    key={machine.id}
                    className="py-3 first:pt-0 last:pb-0 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-neutral-900 dark:text-white truncate">
                        {machine.name}
                      </div>
                      <div className="text-xs text-neutral-500 dark:text-neutral-400 truncate font-mono-data">
                        {activeSlot
                          ? `P${activeSlot.job.plateNumber} · ${
                              activeSlot.isPaused ? 'Paused ' : ''
                            }${formatCountdownHMS(activeSlot.remainingSecondsLive)}`
                          : `${queuedSlots.length} scheduled · ${machine.totalCompletedPlates} done`}
                      </div>
                    </div>
                    <span
                      className={`text-xs font-semibold shrink-0 ${
                        machine.status === 'Printing'
                          ? 'text-amber-600 dark:text-amber-400'
                          : machine.status === 'Idle' || machine.status === 'Completed'
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-red-600 dark:text-red-400'
                      }`}
                    >
                      {activeSlot?.isPaused ? 'Paused' : machine.status}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-neutral-900 dark:text-white">
                Recent Production Activity
              </h2>
              <button
                type="button"
                onClick={() => onNavigate('queue')}
                className="text-xs font-medium text-[#6c4ce6] dark:text-[#b49eff] hover:underline whitespace-nowrap"
              >
                Open Kanban
              </button>
            </div>

            {workspace.log.length === 0 ? (
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                No activity recorded yet.
              </p>
            ) : (
              <div className="divide-y divide-neutral-100 dark:divide-neutral-800/70">
                {workspace.log.slice(0, 7).map((entry) => (
                  <div key={entry.id} className="py-2.5 first:pt-0 last:pb-0">
                    <div className="text-xs text-neutral-800 dark:text-neutral-200">
                      {entry.msg}
                    </div>
                    <div className="text-[11px] text-neutral-400 dark:text-neutral-500 font-mono-data mt-0.5">
                      {formatActivityTimestamp(entry.at, entry.timestampIso, timezone)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};
