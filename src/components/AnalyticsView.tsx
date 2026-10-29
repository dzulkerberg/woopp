import React, { useMemo, useState } from 'react';
import { ABC, countLetters, SALES_CHANNELS } from '../constants';
import { ProductionWorkspaceV5 } from '../types';
import { formatDateDDMMYYYY } from '../utils/dateFormat';
import { DateInputDDMMYYYY } from './DateInputDDMMYYYY';

interface AnalyticsViewProps {
  workspace: ProductionWorkspaceV5;
}

export const AnalyticsView: React.FC<AnalyticsViewProps> = ({ workspace }) => {
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [projectFilter, setProjectFilter] = useState<string>('ALL');
  const [channelFilter, setChannelFilter] = useState<string>('ALL');
  const [machineFilter, setMachineFilter] = useState<string>('ALL');
  const [colorFilter, setColorFilter] = useState<string>('ALL');

  const matchingProjectIds = useMemo(() => {
    return new Set(
      workspace.projects
        .filter((p) => {
          if (projectFilter !== 'ALL' && p.id !== projectFilter) return false;
          if (channelFilter !== 'ALL' && p.salesChannel !== channelFilter) return false;
          return true;
        })
        .map((p) => p.id)
    );
  }, [workspace.projects, projectFilter, channelFilter]);

  const filteredJobs = useMemo(() => {
    return workspace.jobs.filter((j) => {
      if (!matchingProjectIds.has(j.projectId)) return false;
      if (machineFilter !== 'ALL' && j.machineId !== machineFilter) return false;
      if (colorFilter !== 'ALL' && j.colorId !== colorFilter) return false;
      if (dateFrom) {
        const jobDate = (j.completedIso || j.updatedIso || j.createdIso).slice(0, 10);
        if (jobDate < dateFrom) return false;
      }
      if (dateTo) {
        const jobDate = (j.completedIso || j.updatedIso || j.createdIso).slice(0, 10);
        if (jobDate > dateTo) return false;
      }
      return true;
    });
  }, [workspace.jobs, matchingProjectIds, machineFilter, colorFilter, dateFrom, dateTo]);

  const completedJobs = filteredJobs.filter((j) => j.stage === 'Completed');
  const failedJobs = filteredJobs.filter((j) => j.stage === 'Failed / Reprint' || j.failedCount > 0);

  const producedKeycaps = completedJobs.reduce((s, j) => s + countLetters(j.letters), 0);
  const plannedKeycaps = filteredJobs.reduce((s, j) => s + countLetters(j.letters), 0);
  const actualPrintMins = completedJobs.reduce(
    (s, j) => s + (j.actualMinutes || j.estimatedMinutes || 0),
    0
  );
  const estPrintMins = filteredJobs.reduce((s, j) => s + (j.estimatedMinutes || 0), 0);

  const letterDemandRanking = useMemo(() => {
    const map: Record<string, { planned: number; produced: number }> = Object.fromEntries(
      ABC.map((l) => [l, { planned: 0, produced: 0 }])
    );
    for (const job of filteredJobs) {
      for (const [k, v] of Object.entries(job.letters)) {
        if (map[k]) {
          map[k].planned += Number(v || 0);
          if (job.stage === 'Completed') {
            map[k].produced += Number(v || 0);
          }
        }
      }
    }
    return ABC.map((l) => ({ letter: l, ...map[l] })).sort(
      (a, b) => b.planned - a.planned || a.letter.localeCompare(b.letter)
    );
  }, [filteredJobs]);

  const exportAnalyticsCSV = () => {
    const headers = [
      'PlateNumber',
      'Project',
      'SalesChannel',
      'Color',
      'Stage',
      'Printer',
      'Keycaps',
      'EstimatedMinutes',
      'ActualMinutes',
      'UpdatedDate',
    ];
    const rows = filteredJobs.map((j) => {
      const p = workspace.projects.find((pr) => pr.id === j.projectId);
      const c = workspace.colors.find((cl) => cl.id === j.colorId);
      const m = workspace.machines.find((mc) => mc.id === j.machineId);
      return [
        j.plateNumber,
        `"${(p?.name || '').replace(/"/g, '""')}"`,
        `"${p?.salesChannel || ''}"`,
        `"${c?.name || ''}"`,
        `"${j.stage}"`,
        `"${m?.name || 'Unassigned'}"`,
        countLetters(j.letters),
        j.estimatedMinutes,
        j.actualMinutes,
        formatDateDDMMYYYY(j.updatedIso || j.createdIso),
      ].join(',');
    });
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const todayStr = formatDateDDMMYYYY(new Date()).replace(/\//g, '-');
    a.download = `woopp-analytics-${todayStr}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="space-y-6">
      {/* Multi-Dimensional Filter Bar */}
      <section className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-2xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-white">
            Analytics &amp; Production Filters
          </h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setDateFrom('');
                setDateTo('');
                setProjectFilter('ALL');
                setChannelFilter('ALL');
                setMachineFilter('ALL');
                setColorFilter('ALL');
              }}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300"
            >
              Reset Filters
            </button>
            <button
              type="button"
              onClick={exportAnalyticsCSV}
              className="px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-[#6c4ce6] hover:bg-[#5b3cc4] text-white whitespace-nowrap"
            >
              Export CSV Report
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <div>
            <label className="block text-[11px] font-medium text-neutral-500 mb-1">
              From Date (DD/MM/YYYY)
            </label>
            <DateInputDDMMYYYY
              ariaLabel="From Date (DD/MM/YYYY)"
              value={dateFrom}
              onChange={setDateFrom}
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-neutral-500 mb-1">
              To Date (DD/MM/YYYY)
            </label>
            <DateInputDDMMYYYY
              ariaLabel="To Date (DD/MM/YYYY)"
              value={dateTo}
              onChange={setDateTo}
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-neutral-500 mb-1">Project</label>
            <select
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              className="w-full px-2.5 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-[#111018] text-xs"
            >
              <option value="ALL">All Projects</option>
              {workspace.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-medium text-neutral-500 mb-1">Channel</label>
            <select
              value={channelFilter}
              onChange={(e) => setChannelFilter(e.target.value)}
              className="w-full px-2.5 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-[#111018] text-xs"
            >
              <option value="ALL">All Channels</option>
              {SALES_CHANNELS.map((ch) => (
                <option key={ch} value={ch}>
                  {ch}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-medium text-neutral-500 mb-1">Machine</label>
            <select
              value={machineFilter}
              onChange={(e) => setMachineFilter(e.target.value)}
              className="w-full px-2.5 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-[#111018] text-xs"
            >
              <option value="ALL">All Machines</option>
              {workspace.machines.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-medium text-neutral-500 mb-1">Color</label>
            <select
              value={colorFilter}
              onChange={(e) => setColorFilter(e.target.value)}
              className="w-full px-2.5 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-[#111018] text-xs"
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
      </section>

      {/* Filtered Summary Metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-xl p-5">
          <div className="text-xs text-neutral-500">Completion Rate</div>
          <div className="text-2xl font-bold text-neutral-900 dark:text-white font-mono-data mt-1">
            {filteredJobs.length > 0
              ? Math.round((completedJobs.length / filteredJobs.length) * 100)
              : 0}
            %
          </div>
          <div className="text-xs text-neutral-400 mt-1 font-mono-data">
            {completedJobs.length} / {filteredJobs.length} plates
          </div>
        </div>

        <div className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-xl p-5">
          <div className="text-xs text-neutral-500">Keycap Yield</div>
          <div className="text-2xl font-bold text-[#6c4ce6] dark:text-[#b49eff] font-mono-data mt-1">
            {producedKeycaps.toLocaleString()} pcs
          </div>
          <div className="text-xs text-neutral-400 mt-1 font-mono-data">
            Target: {plannedKeycaps.toLocaleString()} pcs
          </div>
        </div>

        <div className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-xl p-5">
          <div className="text-xs text-neutral-500">Logged Print Hours</div>
          <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400 font-mono-data mt-1">
            {(actualPrintMins / 60).toFixed(1)} hrs
          </div>
          <div className="text-xs text-neutral-400 mt-1 font-mono-data">
            Planned: {(estPrintMins / 60).toFixed(1)} hrs
          </div>
        </div>

        <div className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-xl p-5">
          <div className="text-xs text-neutral-500">Plates w/ Failures</div>
          <div className="text-2xl font-bold text-amber-600 dark:text-amber-400 font-mono-data mt-1">
            {failedJobs.length}
          </div>
          <div className="text-xs text-neutral-400 mt-1">Tracked reprints</div>
        </div>
      </div>

      {/* Machine Utilization & Top Letter Demand */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-2xl p-6 space-y-4">
          <h3 className="text-base font-semibold text-neutral-900 dark:text-white">
            Machine Utilization Breakdown
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-neutral-200 dark:border-neutral-800 text-neutral-500">
                  <th className="py-2 pr-3 font-medium">Printer</th>
                  <th className="py-2 px-3 font-medium text-right">Done Plates</th>
                  <th className="py-2 px-3 font-medium text-right">Failed</th>
                  <th className="py-2 pl-3 font-medium text-right">Runtime</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800/70 font-mono-data">
                {workspace.machines.map((m) => (
                  <tr key={m.id}>
                    <td className="py-2.5 pr-3 font-sans font-medium text-neutral-900 dark:text-white">
                      {m.name}
                    </td>
                    <td className="py-2.5 px-3 text-right text-neutral-700 dark:text-neutral-300">
                      {m.totalCompletedPlates}
                    </td>
                    <td className="py-2.5 px-3 text-right text-red-600 dark:text-red-400">
                      {m.totalFailedPlates}
                    </td>
                    <td className="py-2.5 pl-3 text-right text-neutral-800 dark:text-neutral-200">
                      {Math.floor(m.totalPrintMinutes / 60)}h {m.totalPrintMinutes % 60}m
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-2xl p-6 space-y-4">
          <h3 className="text-base font-semibold text-neutral-900 dark:text-white">
            Top Requested Alphabet Volume
          </h3>
          <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1">
            {letterDemandRanking.slice(0, 12).map((item) => {
              const maxPlanned = Math.max(1, letterDemandRanking[0]?.planned || 1);
              const widthPct = Math.round((item.planned / maxPlanned) * 100);
              return (
                <div key={item.letter} className="space-y-1">
                  <div className="flex items-center justify-between text-xs font-mono-data">
                    <span className="font-bold text-neutral-900 dark:text-white">
                      Letter {item.letter}
                    </span>
                    <span className="text-neutral-600 dark:text-neutral-300">
                      {item.produced} / {item.planned} pcs produced
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-neutral-100 dark:bg-neutral-800 overflow-hidden">
                    <div
                      className="h-full bg-[#6c4ce6]"
                      style={{ width: `${widthPct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
};
