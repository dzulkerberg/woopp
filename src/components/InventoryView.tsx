import React, { useState } from 'react';
import { ABC, countLetters, normalizeAlphabetMap } from '../constants';
import { ProductionWorkspaceV5 } from '../types';
import {
  getAvailableStockForColor,
  getReservedStockForColor,
} from '../utils/productionEngine';
import { formatDateDDMMYYYY } from '../utils/dateFormat';

interface InventoryViewProps {
  workspace: ProductionWorkspaceV5;
  onManualStockAction: (params: {
    mode: 'adjustment' | 'wastage' | 'allocate';
    colorId: string;
    projectId?: string;
    letter: string;
    quantity: number;
    reason: string;
  }) => void;
}

export const InventoryView: React.FC<InventoryViewProps> = ({
  workspace,
  onManualStockAction,
}) => {
  const [selectedColorId, setSelectedColorId] = useState<string>(
    workspace.colors[0]?.id || 'color-0'
  );
  const [actionMode, setActionMode] = useState<'allocate' | 'wastage' | 'adjustment'>('allocate');
  const [targetProjectId, setTargetProjectId] = useState<string>(
    workspace.projects.find((p) => p.status !== 'Archived')?.id || ''
  );
  const [letter, setLetter] = useState<string>('A');
  const [qty, setQty] = useState<number>(10);
  const [reason, setReason] = useState<string>('');

  const activeProjects = workspace.projects.filter((p) => p.status !== 'Archived');
  const activeColor =
    workspace.colors.find((c) => c.id === selectedColorId) || workspace.colors[0];

  const physicalMap = activeColor
    ? normalizeAlphabetMap(workspace.inventory.physicalByColor[activeColor.id])
    : normalizeAlphabetMap(null);
  const reservedMap = activeColor
    ? getReservedStockForColor(workspace, activeColor.id)
    : normalizeAlphabetMap(null);
  const availableMap = activeColor
    ? getAvailableStockForColor(workspace, activeColor.id)
    : normalizeAlphabetMap(null);
  const wastageMap = activeColor
    ? normalizeAlphabetMap(workspace.inventory.wastageByColor[activeColor.id])
    : normalizeAlphabetMap(null);

  const totalPhysical = countLetters(physicalMap);
  const totalReserved = countLetters(reservedMap);
  const totalAvailable = countLetters(availableMap);
  const totalWastage = countLetters(wastageMap);

  const handleSubmitAction = (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeColor) return;
    if (qty === 0) return;

    onManualStockAction({
      mode: actionMode,
      colorId: activeColor.id,
      projectId: actionMode === 'allocate' ? targetProjectId : undefined,
      letter,
      quantity: Math.floor(qty),
      reason:
        reason.trim() ||
        (actionMode === 'allocate'
          ? 'Allocated to project'
          : actionMode === 'wastage'
          ? 'Rejected / wastage logged'
          : 'Manual stock audit adjustment'),
    });
    setReason('');
  };

  return (
    <div className="space-y-6">
      {/* Color Selector & Stock Summary KPIs */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap gap-2">
          {workspace.colors.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setSelectedColorId(c.id)}
              className={`px-3.5 py-2 rounded-xl text-xs font-semibold border transition-colors flex items-center gap-2 whitespace-nowrap ${
                activeColor?.id === c.id
                  ? 'border-[#6c4ce6] bg-[#f1edfd] text-[#5b3cc4] dark:bg-[#2a2344] dark:text-[#c7b8ff]'
                  : 'border-neutral-200 dark:border-neutral-800 bg-white dark:bg-[#171522] text-neutral-700 dark:text-neutral-300'
              }`}
            >
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: c.hex }}
              />
              <span>{c.name}</span>
            </button>
          ))}
        </div>

        <div className="text-xs text-neutral-500 dark:text-neutral-400">
          Stock increases automatically once per Completed plate (`stockApplied` ledger guard).
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-xl p-5">
          <div className="text-xs text-neutral-500">Net Physical Stock ({activeColor?.name})</div>
          <div className="text-2xl font-bold text-neutral-900 dark:text-white font-mono-data mt-1">
            {totalPhysical.toLocaleString()} pcs
          </div>
          <div className="text-xs text-neutral-400 mt-1">Produced minus wastage</div>
        </div>

        <div className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-xl p-5">
          <div className="text-xs text-neutral-500">Reserved for Projects</div>
          <div className="text-2xl font-bold text-[#6c4ce6] dark:text-[#b49eff] font-mono-data mt-1">
            {totalReserved.toLocaleString()} pcs
          </div>
          <div className="text-xs text-neutral-400 mt-1">Allocated to sales channels</div>
        </div>

        <div className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-xl p-5">
          <div className="text-xs text-neutral-500">Unallocated Available</div>
          <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400 font-mono-data mt-1">
            {totalAvailable.toLocaleString()} pcs
          </div>
          <div className="text-xs text-neutral-400 mt-1">Free to assign</div>
        </div>

        <div className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-xl p-5">
          <div className="text-xs text-neutral-500">Wastage &amp; Rejected Parts</div>
          <div className="text-2xl font-bold text-red-600 dark:text-red-400 font-mono-data mt-1">
            {totalWastage.toLocaleString()} pcs
          </div>
          <div className="text-xs text-neutral-400 mt-1">Recorded defects</div>
        </div>
      </div>

      {/* Allocation, Wastage & Stock Adjustment Controls */}
      <form
        onSubmit={handleSubmitAction}
        className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-2xl p-6 space-y-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-white">
            Inventory Operations &amp; Channel Allocation
          </h2>
          <div className="flex items-center gap-1 p-1 bg-neutral-100 dark:bg-[#111018] rounded-lg border border-neutral-200/70 dark:border-neutral-800">
            <button
              type="button"
              onClick={() => setActionMode('allocate')}
              className={`px-3 py-1 text-xs font-medium rounded-md whitespace-nowrap ${
                actionMode === 'allocate'
                  ? 'bg-white dark:bg-[#2a2440] text-neutral-900 dark:text-white'
                  : 'text-neutral-500'
              }`}
            >
              Reserve / Release Project Stock
            </button>
            <button
              type="button"
              onClick={() => setActionMode('wastage')}
              className={`px-3 py-1 text-xs font-medium rounded-md whitespace-nowrap ${
                actionMode === 'wastage'
                  ? 'bg-white dark:bg-[#2a2440] text-neutral-900 dark:text-white'
                  : 'text-neutral-500'
              }`}
            >
              Log Wastage / Rejects
            </button>
            <button
              type="button"
              onClick={() => setActionMode('adjustment')}
              className={`px-3 py-1 text-xs font-medium rounded-md whitespace-nowrap ${
                actionMode === 'adjustment'
                  ? 'bg-white dark:bg-[#2a2440] text-neutral-900 dark:text-white'
                  : 'text-neutral-500'
              }`}
            >
              Stock Audit (+/-)
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
          {actionMode === 'allocate' && (
            <div>
              <label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
                Project / Channel
              </label>
              <select
                value={targetProjectId}
                onChange={(e) => setTargetProjectId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-[#111018] text-xs"
              >
                {activeProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.salesChannel})
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
              Letter (A–Z)
            </label>
            <select
              value={letter}
              onChange={(e) => setLetter(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-[#111018] text-xs font-mono-data"
            >
              {ABC.map((l) => (
                <option key={l} value={l}>
                  Letter {l} (Avail: {availableMap[l] || 0})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
              {actionMode === 'wastage' ? 'Rejected Qty' : 'Quantity (+/-)'}
            </label>
            <input
              type="number"
              step={1}
              min={actionMode === 'wastage' ? 1 : -1000}
              max={5000}
              value={qty}
              onChange={(e) => setQty(Number(e.target.value) || 0)}
              className="w-full px-3 py-2 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-[#111018] text-xs font-mono-data"
            />
          </div>

          <div className={actionMode === 'allocate' ? '' : 'lg:col-span-2'}>
            <label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
              Reason / Batch Note
            </label>
            <input
              maxLength={120}
              placeholder={
                actionMode === 'wastage'
                  ? 'e.g. Stringing / broken stem'
                  : 'e.g. Booth packing / physical count'
              }
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-[#111018] text-xs"
            />
          </div>

          <button
            type="submit"
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-[#6c4ce6] hover:bg-[#5b3cc4] text-white whitespace-nowrap h-[36px]"
          >
            Apply Movement
          </button>
        </div>
      </form>

      {/* Main Split: A-Z Inventory Matrix + Audit Ledger */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <section className="lg:col-span-7 bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-neutral-100 dark:border-neutral-800 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-neutral-900 dark:text-white">
              A–Z Stock Matrix — {activeColor?.name}
            </h3>
            <span className="text-xs text-neutral-500">Produced · Reserved · Available · Wastage</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50/70 dark:bg-[#13111c] text-neutral-500">
                  <th className="py-2.5 px-4 font-medium">Letter</th>
                  <th className="py-2.5 px-4 font-medium text-right">Physical</th>
                  <th className="py-2.5 px-4 font-medium text-right">Reserved</th>
                  <th className="py-2.5 px-4 font-medium text-right">Available</th>
                  <th className="py-2.5 px-4 font-medium text-right">Wastage</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800/70 font-mono-data">
                {ABC.map((l) => (
                  <tr key={l} className="hover:bg-neutral-50 dark:hover:bg-neutral-800/30">
                    <td className="py-2 px-4 font-bold text-neutral-900 dark:text-white">{l}</td>
                    <td className="py-2 px-4 text-right text-neutral-800 dark:text-neutral-200">
                      {physicalMap[l] || 0}
                    </td>
                    <td className="py-2 px-4 text-right text-[#6c4ce6] dark:text-[#b49eff]">
                      {reservedMap[l] || 0}
                    </td>
                    <td className="py-2 px-4 text-right font-semibold text-emerald-600 dark:text-emerald-400">
                      {availableMap[l] || 0}
                    </td>
                    <td className="py-2 px-4 text-right text-red-600 dark:text-red-400">
                      {wastageMap[l] || 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="lg:col-span-5 bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-2xl p-6 space-y-4">
          <h3 className="text-sm font-semibold text-neutral-900 dark:text-white">
            Idempotent Inventory Ledger
          </h3>
          {workspace.inventory.movements.length === 0 ? (
            <p className="text-xs text-neutral-500">
              No stock transactions recorded yet. Completing a plate or logging an adjustment creates an immutable ledger entry.
            </p>
          ) : (
            <div className="divide-y divide-neutral-100 dark:divide-neutral-800/70 max-h-[680px] overflow-y-auto">
              {workspace.inventory.movements.slice(0, 35).map((mv) => {
                const cName =
                  workspace.colors.find((c) => c.id === mv.colorId)?.name || mv.colorId;
                const deltaSummary = Object.entries(mv.deltas)
                  .slice(0, 6)
                  .map(([k, v]) => `${k}${v >= 0 ? `+${v}` : v}`)
                  .join(' ');
                return (
                  <div key={mv.id} className="py-3 first:pt-0 last:pb-0 space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-neutral-900 dark:text-white">
                        {mv.type.replace(/_/g, ' ')} · {cName}
                      </span>
                      <span className="text-[11px] font-mono-data text-neutral-400">
                        {formatDateDDMMYYYY(mv.timestampIso)}
                      </span>
                    </div>
                    <div className="text-xs text-neutral-600 dark:text-neutral-300">
                      {mv.reason}
                    </div>
                    <div className="text-[11px] font-mono-data text-neutral-500">
                      {deltaSummary}
                      {Object.keys(mv.deltas).length > 6 ? ' ...' : ''}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
