import React, { useRef, useState } from 'react';
import { DEFAULT_COLOR_PALETTE } from '../constants';
import { ColorOption, ProductionWorkspaceV5 } from '../types';
import { DEFAULT_TIMEZONE, SUPPORTED_TIMEZONES } from '../utils/dateFormat';
import { LegacyLocalDataSummary } from '../utils/legacyLocalBackup';

interface SettingsViewProps {
  workspace: ProductionWorkspaceV5;
  onUpdateWorkspaceDefaults: (params: {
    defaultPlateCapacity: number;
    defaultProductType: string;
    turnaroundBufferMinutes: number;
    timezone: string;
  }) => void;
  onAddColor: (name: string, hex: string) => void;
  onRenameColor: (colorId: string, name: string, hex: string) => void;
  onExportBackup: () => void;
  onImportBackup: (file: File) => void;
  onClearActivityLog: () => void;
  legacyLocalData?: LegacyLocalDataSummary | null;
  onExportLegacyLocalBackup?: () => void;
  onMigrateLegacyLocalToCloud?: () => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  workspace,
  onUpdateWorkspaceDefaults,
  onAddColor,
  onRenameColor,
  onExportBackup,
  onImportBackup,
  onClearActivityLog,
  legacyLocalData,
  onExportLegacyLocalBackup,
  onMigrateLegacyLocalToCloud,
}) => {
  const [defaultCap, setDefaultCap] = useState(workspace.settings.defaultPlateCapacity);
  const [defaultProduct, setDefaultProduct] = useState(workspace.settings.defaultProductType);
  const [bufferMins, setBufferMins] = useState(
    workspace.settings.turnaroundBufferMinutes ?? 15
  );
  const [timezone, setTimezone] = useState(
    workspace.settings.timezone || DEFAULT_TIMEZONE
  );
  const [newColorName, setNewColorName] = useState('');
  const [newColorHex, setNewColorHex] = useState(DEFAULT_COLOR_PALETTE[0]);
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Global Defaults & Smart Scheduling Settings */}
      <section className="bg-surface border border-line rounded-xl p-6 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-ink">
            Production &amp; Scheduling Defaults
          </h2>
          <p className="text-xs text-muted mt-0.5">
            Configure plate turnaround buffer (removal, bed cleaning &amp; restart), display timezone, and default product parameters.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-ink-secondary mb-1">
              Default Plate Capacity (pcs)
            </label>
            <input
              type="number"
              min={1}
              max={1000}
              value={defaultCap}
              onChange={(e) => setDefaultCap(Math.max(1, Number(e.target.value) || 138))}
              className="w-full px-3 py-2 rounded-lg border border-line bg-input text-sm text-ink font-mono-data focus:border-brand"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-ink-secondary mb-1">
              Default Product Type
            </label>
            <input
              maxLength={80}
              value={defaultProduct}
              onChange={(e) => setDefaultProduct(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-line bg-input text-sm text-ink focus:border-brand"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-ink-secondary mb-1">
              Turnaround Buffer Between Plates (minutes)
            </label>
            <input
              type="number"
              min={0}
              max={240}
              value={bufferMins}
              onChange={(e) => setBufferMins(Math.max(0, Math.round(Number(e.target.value) || 0)))}
              className="w-full px-3 py-2 rounded-lg border border-line bg-input text-sm text-ink font-mono-data focus:border-brand"
            />
            <span className="text-[11px] text-muted">
              Time allowed for plate removal, PEI cleaning, and starting next job.
            </span>
          </div>

          <div>
            <label className="block text-xs font-semibold text-ink-secondary mb-1">
              Schedule Display Timezone
            </label>
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-line bg-input text-sm text-ink focus:border-brand"
            >
              {SUPPORTED_TIMEZONES.map((tz) => (
                <option key={tz.value} value={tz.value}>
                  {tz.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={() =>
              onUpdateWorkspaceDefaults({
                defaultPlateCapacity: defaultCap,
                defaultProductType: defaultProduct.trim() || '3D Clicker Keycap',
                turnaroundBufferMinutes: bufferMins,
                timezone,
              })
            }
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-brand hover:bg-brand-hover text-white whitespace-nowrap transition-colors"
          >
            Save Scheduling &amp; Production Defaults
          </button>
        </div>
      </section>

      {/* Color Catalog */}
      <section className="bg-surface border border-line rounded-xl p-6 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-ink">
            Filament Color Catalog
          </h2>
          <p className="text-xs text-muted mt-0.5">
            Rename existing v1 colors or add new filament colors for upcoming projects.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {workspace.colors.map((c) => (
            <EditableColorRow key={c.id} color={c} onSave={onRenameColor} />
          ))}
        </div>

        <div className="pt-4 border-t border-line flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[180px]">
            <label className="block text-xs font-semibold text-ink-secondary mb-1">
              New Filament Color Name
            </label>
            <input
              placeholder="e.g. Sakura Pink Matte"
              maxLength={50}
              value={newColorName}
              onChange={(e) => setNewColorName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-line bg-input text-sm text-ink placeholder:text-muted focus:border-brand"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink-secondary mb-1">
              Swatch
            </label>
            <input
              type="color"
              value={newColorHex}
              onChange={(e) => setNewColorHex(e.target.value)}
              className="h-[38px] w-14 p-1 rounded-lg border border-line bg-input cursor-pointer"
            />
          </div>
          <button
            type="button"
            onClick={() => {
              if (!newColorName.trim()) return;
              onAddColor(newColorName.trim(), newColorHex);
              setNewColorName('');
            }}
            className="px-4 py-2 text-xs font-semibold rounded-lg border border-line bg-surface hover:bg-elevated text-ink h-[38px] whitespace-nowrap transition-colors"
          >
            + Add Color
          </button>
        </div>
      </section>

      {/* Data Backup, Restore & Legacy Safety */}
      <section className="bg-surface border border-line rounded-xl p-6 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-ink">
            Cloud Backup, Import &amp; Migration Integrity
          </h2>
          <p className="text-xs text-muted mt-0.5">
            WOOPP 5.0 stores workspace state at <span className="font-mono-data text-ink">users/&#123;uid&#125;/tracker/v5_workspace</span> while leaving your original <span className="font-mono-data text-ink">users/&#123;uid&#125;/tracker/main</span> untouched.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onExportBackup}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-brand hover:bg-brand-hover text-white whitespace-nowrap transition-colors"
          >
            Download JSON Backup (v5)
          </button>

          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="px-4 py-2 text-xs font-medium rounded-lg border border-line bg-surface hover:bg-elevated text-ink-secondary hover:text-ink whitespace-nowrap transition-colors"
          >
            Import Backup (Supports v1 &amp; v5 JSON)
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onImportBackup(file);
              e.target.value = '';
            }}
          />

          <button
            type="button"
            onClick={() => window.print()}
            className="px-4 py-2 text-xs font-medium rounded-lg border border-line bg-surface hover:bg-elevated text-ink-secondary hover:text-ink whitespace-nowrap transition-colors"
          >
            Print Production Report
          </button>

          <button
            type="button"
            onClick={onClearActivityLog}
            className="px-4 py-2 text-xs font-medium rounded-lg border border-error-border bg-surface hover:bg-error-soft text-error-text whitespace-nowrap transition-colors"
          >
            Clear Activity Log
          </button>
        </div>

        {legacyLocalData && (
          <div className="pt-4 border-t border-line">
            <div className="p-4 rounded-xl bg-warning-soft border border-warning-border flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs text-warning-text max-w-xl">
                <div className="font-semibold">
                  One-Time Migration for Unsynced Browser Data ({legacyLocalData.format.toUpperCase()})
                </div>
                <p className="mt-0.5">
                  Found {legacyLocalData.projectCount} project(s) and {legacyLocalData.jobCount} plate(s) from a retired Local Workspace session in this browser. Existing browser records remain untouched.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {onExportLegacyLocalBackup && (
                  <button
                    type="button"
                    onClick={onExportLegacyLocalBackup}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-warning-border bg-surface hover:bg-elevated text-warning-text whitespace-nowrap transition-colors"
                  >
                    Export Local JSON
                  </button>
                )}
                {onMigrateLegacyLocalToCloud && (
                  <button
                    type="button"
                    onClick={onMigrateLegacyLocalToCloud}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-brand hover:bg-brand-hover text-white whitespace-nowrap transition-colors"
                  >
                    Migrate to Cloud Firestore
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
};

const EditableColorRow: React.FC<{
  color: ColorOption;
  onSave: (id: string, name: string, hex: string) => void;
}> = ({ color, onSave }) => {
  const [name, setName] = useState(color.name);
  const [hex, setHex] = useState(color.hex);

  return (
    <div className="flex items-center gap-2 p-2.5 rounded-lg border border-line bg-elevated">
      <input
        type="color"
        aria-label={`Color swatch for ${color.name}`}
        value={hex}
        onChange={(e) => {
          setHex(e.target.value);
          onSave(color.id, name.trim() || color.name, e.target.value);
        }}
        className="w-8 h-8 rounded cursor-pointer border-0 bg-transparent shrink-0"
      />
      <input
        aria-label={`Color name for ${color.name}`}
        value={name}
        maxLength={50}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          const trimmed = name.trim();
          if (trimmed && trimmed !== color.name) {
            onSave(color.id, trimmed, hex);
          } else {
            setName(color.name);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        className="flex-1 min-w-0 px-2 py-1 text-xs font-medium bg-transparent text-ink focus:outline-none border-b border-transparent focus:border-brand"
      />
    </div>
  );
};
