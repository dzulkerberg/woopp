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
      <section className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-2xl p-6 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-neutral-900 dark:text-white">
            Production &amp; Scheduling Defaults
          </h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
            Configure plate turnaround buffer (removal, bed cleaning &amp; restart), display timezone, and default product parameters.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
              Default Plate Capacity (pcs)
            </label>
            <input
              type="number"
              min={1}
              max={1000}
              value={defaultCap}
              onChange={(e) => setDefaultCap(Math.max(1, Number(e.target.value) || 138))}
              className="w-full px-3 py-2 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-[#111018] text-sm font-mono-data"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
              Default Product Type
            </label>
            <input
              maxLength={80}
              value={defaultProduct}
              onChange={(e) => setDefaultProduct(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-[#111018] text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
              Turnaround Buffer Between Plates (minutes)
            </label>
            <input
              type="number"
              min={0}
              max={240}
              value={bufferMins}
              onChange={(e) => setBufferMins(Math.max(0, Math.round(Number(e.target.value) || 0)))}
              className="w-full px-3 py-2 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-[#111018] text-sm font-mono-data"
            />
            <span className="text-[11px] text-neutral-400">
              Time allowed for plate removal, PEI cleaning, and starting next job.
            </span>
          </div>

          <div>
            <label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
              Schedule Display Timezone
            </label>
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-[#111018] text-sm"
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
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-[#6c4ce6] hover:bg-[#5b3cc4] text-white whitespace-nowrap"
          >
            Save Scheduling &amp; Production Defaults
          </button>
        </div>
      </section>

      {/* Color Catalog */}
      <section className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-2xl p-6 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-neutral-900 dark:text-white">
            Filament Color Catalog
          </h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
            Rename existing v1 colors or add new filament colors for upcoming projects.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {workspace.colors.map((c) => (
            <EditableColorRow key={c.id} color={c} onSave={onRenameColor} />
          ))}
        </div>

        <div className="pt-4 border-t border-neutral-100 dark:border-neutral-800 flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[180px]">
            <label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
              New Filament Color Name
            </label>
            <input
              placeholder="e.g. Sakura Pink Matte"
              maxLength={50}
              value={newColorName}
              onChange={(e) => setNewColorName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-[#111018] text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
              Swatch
            </label>
            <input
              type="color"
              value={newColorHex}
              onChange={(e) => setNewColorHex(e.target.value)}
              className="h-[38px] w-14 p-1 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-[#111018] cursor-pointer"
            />
          </div>
          <button
            type="button"
            onClick={() => {
              if (!newColorName.trim()) return;
              onAddColor(newColorName.trim(), newColorHex);
              setNewColorName('');
            }}
            className="px-4 py-2 text-xs font-semibold rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-800 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-800 h-[38px] whitespace-nowrap"
          >
            + Add Color
          </button>
        </div>
      </section>

      {/* Data Backup, Restore & Legacy Safety */}
      <section className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-2xl p-6 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-neutral-900 dark:text-white">
            Cloud Backup, Import &amp; Migration Integrity
          </h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
            WOOPP 5.0 stores workspace state at <span className="font-mono-data">users/&#123;uid&#125;/tracker/v5_workspace</span> while leaving your original <span className="font-mono-data">users/&#123;uid&#125;/tracker/main</span> untouched.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onExportBackup}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-[#6c4ce6] hover:bg-[#5b3cc4] text-white whitespace-nowrap"
          >
            Download JSON Backup (v5)
          </button>

          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="px-4 py-2 text-xs font-medium rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-800 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-800 whitespace-nowrap"
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
            className="px-4 py-2 text-xs font-medium rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-800 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-800 whitespace-nowrap"
          >
            Print Production Report
          </button>

          <button
            type="button"
            onClick={onClearActivityLog}
            className="px-4 py-2 text-xs font-medium rounded-lg border border-red-200 dark:border-red-900/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 whitespace-nowrap"
          >
            Clear Activity Log
          </button>
        </div>

        {legacyLocalData && (
          <div className="pt-4 border-t border-neutral-100 dark:border-neutral-800">
            <div className="p-4 rounded-xl bg-amber-50/80 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/70 flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs text-amber-900 dark:text-amber-200 max-w-xl">
                <div className="font-semibold">
                  One-Time Migration for Unsynced Browser Data ({legacyLocalData.format.toUpperCase()})
                </div>
                <p className="mt-0.5 text-amber-800 dark:text-amber-300">
                  Found {legacyLocalData.projectCount} project(s) and {legacyLocalData.jobCount} plate(s) from a retired Local Workspace session in this browser. Existing browser records remain untouched.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {onExportLegacyLocalBackup && (
                  <button
                    type="button"
                    onClick={onExportLegacyLocalBackup}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-amber-300 dark:border-amber-700 bg-white dark:bg-[#171522] text-amber-900 dark:text-amber-200 whitespace-nowrap"
                  >
                    Export Local JSON
                  </button>
                )}
                {onMigrateLegacyLocalToCloud && (
                  <button
                    type="button"
                    onClick={onMigrateLegacyLocalToCloud}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#6c4ce6] hover:bg-[#5b3cc4] text-white whitespace-nowrap"
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
    <div className="flex items-center gap-2 p-2.5 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50/50 dark:bg-[#12101b]">
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
        className="flex-1 min-w-0 px-2 py-1 text-xs font-medium bg-transparent text-neutral-900 dark:text-white focus:outline-none border-b border-transparent focus:border-[#6c4ce6]"
      />
    </div>
  );
};
