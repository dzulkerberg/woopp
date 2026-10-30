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
              className={`px-3.5 py-2 rounded-lg text-xs font-semibold border transition-colors flex items-center gap-2 whitespace-nowrap ${
                activeColor?.id === c.id
                  ? 'border-brand bg-brand-soft text-brand-text'
                  : 'border-line bg-surface hover:bg-elevated text-ink-secondary hover:text-ink'
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

        <div className="text-xs text-muted">
          Stock increases automatically once per Completed plate (`stockApplied` ledger guard).
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-surface border border-line rounded-xl p-5">
          <div className="text-xs font-medium text-muted">Net Physical Stock ({activeColor?.name})</div>
          <div className="text-2xl font-bold text-ink font-mono-data mt-1">
            {totalPhysical.toLocaleString()} pcs
          </div>
          <div className="text-xs text-muted mt-1">Produced minus wastage</div>
        </div>

        <div className="bg-surface border border-line rounded-xl p-5">
          <div className="text-xs font-medium text-muted">Reserved for Projects</div>
          <div className="text-2xl font-bold text-info-text font-mono-data mt-1">
            {totalReserved.toLocaleString()} pcs
          </div>
          <div className="text-xs text-muted mt-1">Allocated to sales channels</div>
        </div>

        <div className="bg-surface border border-line rounded-xl p-5">
          <div className="text-xs font-medium text-muted">Unallocated Available</div>
          <div className="text-2xl font-bold text-brand-text font-mono-data mt-1">
            {totalAvailable.toLocaleString()} pcs
          </div>
          <div className="text-xs text-muted mt-1">Free to assign</div>
        </div>

        <div className="bg-surface border border-line rounded-xl p-5">
          <div className="text-xs font-medium text-muted">Wastage &amp; Rejected Parts</div>
          <div className="text-2xl font-bold text-error-text font-mono-data mt-1">
            {totalWastage.toLocaleString()} pcs
          </div>
          <div className="text-xs text-muted mt-1">Recorded defects</div>
        </div>
      </div>

      {/* Allocation, Wastage & Stock Adjustment Controls */}
      <form
        onSubmit={handleSubmitAction}
        className="bg-surface border border-line rounded-xl p-6 space-y-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-ink">
            Inventory Operations &amp; Channel Allocation
          </h2>
          <div className="flex flex-wrap items-center gap-1 p-1 bg-recessed rounded-lg border border-line">
            <button
              type="button"
              onClick={() => setActionMode('allocate')}
              className={`px-3 py-1 text-xs font-medium rounded-md whitespace-nowrap transition-colors ${
                actionMode === 'allocate'
                  ? 'bg-surface text-ink border border-line font-semibold shadow-xs'
                  : 'border border-transparent text-ink-secondary hover:text-ink'
              }`}
            >
              Reserve / Release Project Stock
            </button>
            <button
              type="button"
              onClick={() => setActionMode('wastage')}
              className={`px-3 py-1 text-xs font-medium rounded-md whitespace-nowrap transition-colors ${
                actionMode === 'wastage'
                  ? 'bg-surface text-ink border border-line font-semibold shadow-xs'
                  : 'border border-transparent text-ink-secondary hover:text-ink'
              }`}
            >
              Log Wastage / Rejects
            </button>
            <button
              type="button"
              onClick={() => setActionMode('adjustment')}
              className={`px-3 py-1 text-xs font-medium rounded-md whitespace-nowrap transition-colors ${
                actionMode === 'adjustment'
                  ? 'bg-surface text-ink border border-line font-semibold shadow-xs'
                  : 'border border-transparent text-ink-secondary hover:text-ink'
              }`}
            >
              Stock Audit (+/-)
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
          {actionMode === 'allocate' && (
            <div>
              <label className="block text-xs font-semibold text-ink-secondary mb-1">
                Project / Channel
              </label>
              <select
                value={targetProjectId}
                onChange={(e) => setTargetProjectId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-line bg-input text-xs text-ink focus:border-brand"
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
            <label className="block text-xs font-semibold text-ink-secondary mb-1">
              Letter (A–Z)
            </label>
            <select
              value={letter}
              onChange={(e) => setLetter(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-line bg-input text-xs text-ink font-mono-data focus:border-brand"
            >
              {ABC.map((l) => (
                <option key={l} value={l}>
                  Letter {l} (Avail: {availableMap[l] || 0})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-ink-secondary mb-1">
              {actionMode === 'wastage' ? 'Rejected Qty' : 'Quantity (+/-)'}
            </label>
            <input
              type="number"
              step={1}
              min={actionMode === 'wastage' ? 1 : -1000}
              max={5000}
              value={qty}
              onChange={(e) => setQty(Number(e.target.value) || 0)}
              className="w-full px-3 py-2 rounded-lg border border-line bg-input text-xs text-ink font-mono-data focus:border-brand"
            />
          </div>

          <div className={actionMode === 'allocate' ? '' : 'lg:col-span-2'}>
            <label className="block text-xs font-semibold text-ink-secondary mb-1">
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
              className="w-full px-3 py-2 rounded-lg border border-line bg-input text-xs text-ink placeholder:text-muted focus:border-brand"
            />
          </div>

          <button
            type="submit"
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-brand hover:bg-brand-hover text-white whitespace-nowrap h-[36px] transition-colors"
          >
            Apply Movement
          </button>
        </div>
      </form>

      {/* Main Split: A-Z Inventory Matrix + Audit Ledger */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <section className="lg:col-span-7 bg-surface border border-line rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-line flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink">
              A–Z Stock Matrix — {activeColor?.name}
            </h3>
            <span className="text-xs text-muted">Produced · Reserved · Available · Wastage</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-line bg-recessed text-muted">
                  <th className="py-2.5 px-4 font-semibold">Letter</th>
                  <th className="py-2.5 px-4 font-semibold text-right">Physical</th>
                  <th className="py-2.5 px-4 font-semibold text-right">Reserved</th>
                  <th className="py-2.5 px-4 font-semibold text-right">Available</th>
                  <th className="py-2.5 px-4 font-semibold text-right">Wastage</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line font-mono-data">
                {ABC.map((l) => (
                  <tr key={l} className="hover:bg-elevated transition-colors">
                    <td className="py-2 px-4 font-bold text-ink">{l}</td>
                    <td className="py-2 px-4 text-right text-ink">
                      {physicalMap[l] || 0}
                    </td>
                    <td className="py-2 px-4 text-right text-info-text">
                      {reservedMap[l] || 0}
                    </td>
                    <td className="py-2 px-4 text-right font-semibold text-brand-text">
                      {availableMap[l] || 0}
                    </td>
                    <td className="py-2 px-4 text-right text-error-text">
                      {wastageMap[l] || 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="lg:col-span-5 bg-surface border border-line rounded-xl p-6 space-y-4">
          <h3 className="text-sm font-semibold text-ink">
            Idempotent Inventory Ledger
          </h3>
          {workspace.inventory.movements.length === 0 ? (
            <p className="text-xs text-muted">
              No stock transactions recorded yet. Completing a plate or logging an adjustment creates an immutable ledger entry.
            </p>
          ) : (
            <div className="divide-y divide-line max-h-[680px] overflow-y-auto">
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
                      <span className="font-semibold text-ink">
                        {mv.type.replace(/_/g, ' ')} · {cName}
                      </span>
                      <span className="text-[11px] font-mono-data text-muted">
                        {formatDateDDMMYYYY(mv.timestampIso)}
                      </span>
                    </div>
                    <div className="text-xs text-ink-secondary">
                      {mv.reason}
                    </div>
                    <div className="text-[11px] font-mono-data text-muted">
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
