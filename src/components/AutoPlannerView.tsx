import React, { useEffect, useMemo, useState } from 'react';
import {
  ABC,
  compactLettersMap,
  countLetters,
  DEFAULT_PLATE_CAPACITY,
  emptyAlphabetMap,
  normalizeAlphabetMap,
  sumAlphabetMaps,
} from '../constants';
import {
  AlphabetPreset,
  LettersMap,
  ProductionJob,
  ProductionWorkspaceV5,
} from '../types';
import { computeIntelligentPlates, DraftPlatePreview } from '../utils/productionEngine';
import { DurationHMInput } from './DurationHMInput';

interface AutoPlannerViewProps {
  workspace: ProductionWorkspaceV5;
  selectedProjectId: string;
  onSelectProject: (projectId: string) => void;
  onSavePreset: (preset: AlphabetPreset) => void;
  onDeletePreset: (presetId: string) => void;
  onCommitGeneratedPlates: (params: {
    projectId: string;
    colorId: string;
    plateCapacity: number;
    targetLetters: LettersMap;
    carryForwardLetters: LettersMap;
    confirmedPlates: DraftPlatePreview[];
  }) => void;
  onAlert: (msg: string, title?: string) => void;
}

export const AutoPlannerView: React.FC<AutoPlannerViewProps> = ({
  workspace,
  selectedProjectId,
  onSelectProject,
  onSavePreset,
  onDeletePreset,
  onCommitGeneratedPlates,
  onAlert,
}) => {
  const activeProjects = workspace.projects.filter((p) => p.status !== 'Archived');
  const currentProject =
    activeProjects.find((p) => p.id === selectedProjectId) || activeProjects[0] || null;

  const projectColors = useMemo(() => {
    if (!currentProject) return workspace.colors;
    const assigned = workspace.colors.filter((c) =>
      currentProject.assignedColorIds.includes(c.id)
    );
    return assigned.length > 0 ? assigned : workspace.colors;
  }, [currentProject, workspace.colors]);

  const [selectedColorId, setSelectedColorId] = useState<string>(
    projectColors[0]?.id || workspace.colors[0]?.id || 'color-0'
  );
  const [plateCapacity, setPlateCapacity] = useState<number>(
    currentProject?.plateCapacity || DEFAULT_PLATE_CAPACITY
  );
  const [defaultPlateMinutes, setDefaultPlateMinutes] = useState<number>(195); // 3h 15m Bambu Studio default
  const [draftLetters, setDraftLetters] = useState<LettersMap>(() => emptyAlphabetMap());
  const [presetName, setPresetName] = useState<string>('');
  const [selectedPresetId, setSelectedPresetId] = useState<string>('');

  // Staging area for manual adjustment before confirming plates
  const [stagedPlates, setStagedPlates] = useState<DraftPlatePreview[] | null>(null);
  const [remainderMode, setRemainderMode] = useState<'carry_forward' | 'partial_plate'>(
    'carry_forward'
  );

  // Sync draft letters when project or color changes
  useEffect(() => {
    if (!currentProject) return;
    if (!projectColors.some((c) => c.id === selectedColorId) && projectColors[0]) {
      setSelectedColorId(projectColors[0].id);
      return;
    }
    setPlateCapacity(currentProject.plateCapacity || DEFAULT_PLATE_CAPACITY);
    const savedTarget = currentProject.targetsByColor?.[selectedColorId];
    if (savedTarget && countLetters(savedTarget) > 0) {
      setDraftLetters(normalizeAlphabetMap(savedTarget));
    } else {
      const existingJobs = workspace.jobs.filter(
        (j) => j.projectId === currentProject.id && j.colorId === selectedColorId
      );
      setDraftLetters(sumAlphabetMaps(existingJobs.map((j) => j.letters)));
    }
    setStagedPlates(null);
  }, [currentProject?.id, selectedColorId, projectColors]);

  const distribution = useMemo(() => {
    if (!currentProject) return null;
    return computeIntelligentPlates(
      workspace.jobs,
      currentProject.id,
      selectedColorId,
      draftLetters,
      plateCapacity,
      defaultPlateMinutes
    );
  }, [
    workspace.jobs,
    currentProject,
    selectedColorId,
    draftLetters,
    plateCapacity,
    defaultPlateMinutes,
  ]);

  if (!currentProject) {
    return (
      <div className="bg-white dark:bg-[#171522] border border-neutral-200 dark:border-neutral-800 rounded-2xl p-8 text-center">
        <p className="text-sm text-neutral-600 dark:text-neutral-300">
          Create or unarchive a project first to plan alphabet keycap plates.
        </p>
      </div>
    );
  }

  const carryForwardSaved =
    currentProject.carryForwardByColor?.[selectedColorId] || emptyAlphabetMap();
  const carryForwardTotal = countLetters(carryForwardSaved);

  const handleSetLetterQty = (letter: string, rawVal: string) => {
    const val = Math.max(0, Math.floor(Number(rawVal) || 0));
    setDraftLetters((prev) => ({ ...prev, [letter]: val }));
    setStagedPlates(null);
  };

  const handleLoadFromCurrentQueue = () => {
    const jobsForPair: ProductionJob[] = workspace.jobs.filter(
      (j) => j.projectId === currentProject.id && j.colorId === selectedColorId
    );
    setDraftLetters(sumAlphabetMaps(jobsForPair.map((j) => j.letters)));
    setStagedPlates(null);
  };

  const handleIncludeCarryForward = () => {
    const merged = sumAlphabetMaps([draftLetters, carryForwardSaved]);
    setDraftLetters(merged);
    setStagedPlates(null);
  };

  const handleApplyPreset = () => {
    const preset = workspace.presets.find((p) => p.id === selectedPresetId);
    if (!preset) return;
    setDraftLetters(normalizeAlphabetMap(preset.letters));
    if (preset.plateCapacity > 0) {
      setPlateCapacity(preset.plateCapacity);
    }
    setStagedPlates(null);
  };

  const handleSaveNewPreset = () => {
    const trimmed = presetName.trim();
    if (!trimmed) {
      onAlert('Enter a name for the alphabet preset before saving.');
      return;
    }
    if (countLetters(draftLetters) === 0) {
      onAlert('Enter at least 1 keycap quantity in the A–Z grid before saving a preset.');
      return;
    }
    const newPreset: AlphabetPreset = {
      id: `preset-${Date.now()}`,
      name: trimmed,
      productType: currentProject.productType || '3D Clicker Keycap',
      plateCapacity,
      letters: compactLettersMap(draftLetters),
      createdIso: new Date().toISOString(),
    };
    onSavePreset(newPreset);
    setPresetName('');
    setSelectedPresetId(newPreset.id);
  };

  const handlePreparePlatesPreview = (mode: 'carry_forward' | 'partial_plate') => {
    if (!distribution) return;
    if (distribution.underLockedLetters.length > 0) {
      onAlert(
        `Target cannot be lower than already Completed or Printing plates for letters: ${distribution.underLockedLetters.join(
          ', '
        )}.`,
        'Locked Plate Protection'
      );
      return;
    }
    if (distribution.totalNetCount === 0) {
      onAlert('All requested keycaps are already covered by Completed or Printing plates.');
      return;
    }

    setRemainderMode(mode);
    const previewList: DraftPlatePreview[] = distribution.fullPlates.map((p) => ({
      ...p,
      letters: { ...p.letters },
    }));

    if (mode === 'partial_plate' && distribution.remainderCount > 0) {
      const maxNum = previewList.reduce((m, p) => Math.max(m, p.plateNumber), 0);
      const lockedMax = workspace.jobs
        .filter(
          (j) =>
            j.projectId === currentProject.id &&
            j.colorId === selectedColorId &&
            (j.stage === 'Completed' || j.stage === 'Printing')
        )
        .reduce((m, j) => Math.max(m, j.plateNumber), 0);

      previewList.push({
        tempId: `draft-partial-${Date.now()}`,
        plateNumber: Math.max(maxNum, lockedMax) + 1,
        capacity: plateCapacity,
        letters: { ...distribution.remainder },
        estimatedMinutes: Math.max(
          15,
          Math.round((distribution.remainderCount / plateCapacity) * defaultPlateMinutes)
        ),
        slicerVerified: false,
        notes: `Partial remainder plate (${distribution.remainderCount}/${plateCapacity} pcs)`,
      });
    }

    if (previewList.length === 0 && mode === 'carry_forward') {
      // Total net count < 1 full plate, user wants to store carry-forward only
      setStagedPlates([]);
      return;
    }

    setStagedPlates(previewList);
  };

  const handleAdjustStagedPlateLetter = (
    tempId: string,
    letter: string,
    nextValRaw: string
  ) => {
    if (!stagedPlates) return;
    const val = Math.max(0, Math.floor(Number(nextValRaw) || 0));
    setStagedPlates(
      stagedPlates.map((plate) => {
        if (plate.tempId !== tempId) return plate;
        const nextLetters = { ...plate.letters };
        if (val === 0) {
          delete nextLetters[letter];
        } else {
          nextLetters[letter] = val;
        }
        return { ...plate, letters: nextLetters };
      })
    );
  };

  const handleAddLetterToStagedPlate = (tempId: string, letter: string) => {
    if (!stagedPlates || !ABC.includes(letter)) return;
    setStagedPlates(
      stagedPlates.map((plate) => {
        if (plate.tempId !== tempId) return plate;
        return {
          ...plate,
          letters: {
            ...plate.letters,
            [letter]: (plate.letters[letter] || 0) + 1,
          },
        };
      })
    );
  };

  const handleToggleStagedSlicerVerified = (tempId: string) => {
    if (!stagedPlates) return;
    setStagedPlates(
      stagedPlates.map((plate) =>
        plate.tempId === tempId ? { ...plate, slicerVerified: !plate.slicerVerified } : plate
      )
    );
  };

  const handleAdjustStagedDuration = (tempId: string, nextMinutes: number) => {
    if (!stagedPlates) return;
    setStagedPlates(
      stagedPlates.map((plate) =>
        plate.tempId === tempId ? { ...plate, estimatedMinutes: nextMinutes } : plate
      )
    );
  };

  const handleConfirmAndSavePlates = () => {
    if (!stagedPlates || !distribution) return;

    // Validate capacity on every staged plate before saving
    for (const plate of stagedPlates) {
      const qty = countLetters(plate.letters);
      if (qty <= 0) {
        onAlert(`Plate ${plate.plateNumber} has 0 keycaps. Adjust or regenerate before saving.`);
        return;
      }
      if (qty > plate.capacity) {
        onAlert(
          `Capacity exceeded on Plate ${plate.plateNumber}: ${qty} pcs exceeds numerical capacity of ${plate.capacity} pcs.`,
          'Plate Capacity Validation'
        );
        return;
      }
    }

    const carryForwardToSave =
      remainderMode === 'carry_forward' ? distribution.remainder : emptyAlphabetMap();

    onCommitGeneratedPlates({
      projectId: currentProject.id,
      colorId: selectedColorId,
      plateCapacity,
      targetLetters: compactLettersMap(draftLetters),
      carryForwardLetters: carryForwardToSave,
      confirmedPlates: stagedPlates,
    });

    setStagedPlates(null);
  };

  const totalRequested = countLetters(draftLetters);
  const lockedCount = distribution ? countLetters(distribution.lockedTotals) : 0;

  return (
    <div className="space-y-6">
      {/* Top Context Selector: Project, Color, Plate Capacity & Presets */}
      <section className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-2xl p-6 space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div>
            <label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
              Target Project
            </label>
            <select
              value={currentProject.id}
              onChange={(e) => onSelectProject(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-[#111018] text-sm text-neutral-900 dark:text-white"
            >
              {activeProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.salesChannel})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
              Color Variant
            </label>
            <div className="flex flex-wrap gap-1.5">
              {projectColors.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedColorId(c.id)}
                  className={`px-3 py-2 rounded-lg text-xs font-medium border transition-colors flex items-center gap-1.5 whitespace-nowrap ${
                    selectedColorId === c.id
                      ? 'border-[#6c4ce6] bg-[#f1edfd] text-[#5b3cc4] dark:bg-[#2a2344] dark:text-[#c7b8ff]'
                      : 'border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300'
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
          </div>

          <div>
            <label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
              Capacity &amp; Bambu Est. Time
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={1000}
                title="Keycaps per plate"
                value={plateCapacity}
                onChange={(e) => {
                  setPlateCapacity(Math.max(1, Math.floor(Number(e.target.value) || 138)));
                  setStagedPlates(null);
                }}
                className="w-20 px-2.5 py-1.5 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-[#111018] text-xs text-neutral-900 dark:text-white font-mono-data"
              />
              <DurationHMInput
                compact
                minutes={defaultPlateMinutes}
                onChangeMinutes={(mins) => {
                  setDefaultPlateMinutes(mins);
                  setStagedPlates(null);
                }}
                ariaLabelPrefix="Default plate Bambu Studio duration"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
              Load Alphabet Preset
            </label>
            <div className="flex gap-2">
              <select
                value={selectedPresetId}
                onChange={(e) => setSelectedPresetId(e.target.value)}
                className="flex-1 min-w-0 px-2.5 py-2 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-[#111018] text-xs text-neutral-900 dark:text-white"
              >
                <option value="">Select preset...</option>
                {workspace.presets.map((pr) => (
                  <option key={pr.id} value={pr.id}>
                    {pr.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!selectedPresetId}
                onClick={handleApplyPreset}
                className="px-3 py-2 text-xs font-semibold rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-800 dark:text-neutral-200 disabled:opacity-40 whitespace-nowrap"
              >
                Apply
              </button>
            </div>
          </div>
        </div>

        {/* Slicer Fit vs Numerical Capacity Notice */}
        <div className="p-3.5 rounded-xl bg-amber-50/70 dark:bg-amber-950/25 border border-amber-200/80 dark:border-amber-900/50 text-xs text-amber-900 dark:text-amber-200 flex flex-wrap items-center justify-between gap-2">
          <div>
            <span className="font-semibold">Numerical Capacity vs. Slicer Physical Fit:</span>{' '}
            {plateCapacity} pcs/plate is a mathematical batch target (default 138 keycaps). Wide letters (M, W) occupy larger bed area than narrow letters (I) — always verify physical bed fit in Bambu Studio before printing.
          </div>
          {carryForwardTotal > 0 && (
            <button
              type="button"
              onClick={handleIncludeCarryForward}
              className="px-3 py-1.5 rounded-lg bg-amber-600 text-white font-semibold whitespace-nowrap"
            >
              + Add Carry-Forward ({carryForwardTotal} pcs)
            </button>
          )}
        </div>
      </section>

      {/* Editable A-Z Grid */}
      <section className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-2xl p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-neutral-900 dark:text-white">
              Custom Alphabet Inventory Grid (A–Z)
            </h2>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
              Enter total target quantity per letter (including locked Completed/Printing plates). Unwanted letters are never added automatically.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleLoadFromCurrentQueue}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 whitespace-nowrap"
            >
              Load Current Queue Totals
            </button>
            <button
              type="button"
              onClick={() => {
                if (distribution) {
                  setDraftLetters({ ...distribution.lockedTotals });
                  setStagedPlates(null);
                }
              }}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 whitespace-nowrap"
            >
              Reset to Locked Minimum
            </button>
          </div>
        </div>

        <div className="grid grid-cols-4 sm:grid-cols-7 md:grid-cols-9 lg:grid-cols-13 gap-2.5">
          {ABC.map((letter) => {
            const lockedVal = distribution?.lockedTotals[letter] || 0;
            const currentVal = draftLetters[letter] ?? 0;
            const isInvalid = currentVal < lockedVal;
            return (
              <div
                key={letter}
                className={`p-2 rounded-xl border ${
                  isInvalid
                    ? 'border-red-400 bg-red-50/40 dark:bg-red-950/30'
                    : 'border-neutral-200/80 dark:border-neutral-800 bg-neutral-50/50 dark:bg-[#13111c]'
                }`}
              >
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="font-bold text-neutral-900 dark:text-white">{letter}</span>
                  {lockedVal > 0 && (
                    <span
                      className="text-[10px] font-mono-data text-neutral-500 dark:text-neutral-400"
                      title="Locked in Printing/Completed plates"
                    >
                      L:{lockedVal}
                    </span>
                  )}
                </div>
                <input
                  type="number"
                  min={0}
                  step={1}
                  aria-label={`Quantity for letter ${letter}`}
                  value={currentVal}
                  onChange={(e) => handleSetLetterQty(letter, e.target.value)}
                  className="w-full px-1.5 py-1.5 text-center rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-[#191726] text-xs font-mono-data text-neutral-900 dark:text-white"
                />
              </div>
            );
          })}
        </div>

        {/* Save Reusable Preset Bar */}
        <div className="pt-4 border-t border-neutral-100 dark:border-neutral-800 flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-2 flex-1 max-w-md">
            <input
              placeholder="Save current A–Z grid as reusable preset..."
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              maxLength={80}
              className="flex-1 min-w-[200px] px-3 py-1.5 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-[#111018] text-xs text-neutral-900 dark:text-white"
            />
            <button
              type="button"
              onClick={handleSaveNewPreset}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-800 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-800 whitespace-nowrap"
            >
              Save Preset
            </button>
            {selectedPresetId && !selectedPresetId.startsWith('preset-woopp-') && (
              <button
                type="button"
                onClick={() => {
                  onDeletePreset(selectedPresetId);
                  setSelectedPresetId('');
                }}
                className="px-2.5 py-1.5 text-xs text-red-600 dark:text-red-400 hover:underline whitespace-nowrap"
              >
                Delete Preset
              </button>
            )}
          </div>

          {distribution && (
            <div className="text-xs font-mono-data text-neutral-700 dark:text-neutral-300">
              Total Target: <b>{totalRequested}</b> pcs · Locked: <b>{lockedCount}</b> pcs · Net to Plate:{' '}
              <b>{distribution.totalNetCount}</b> pcs · Full Plates:{' '}
              <b>{distribution.fullPlates.length}</b> ({plateCapacity}/plate) · Remainder:{' '}
              <b>{distribution.remainderCount}</b> pcs
            </div>
          )}
        </div>

        {/* Remainder Resolution & Generation Controls */}
        {distribution && (
          <div className="p-4 rounded-xl bg-neutral-50 dark:bg-[#13111c] border border-neutral-200/80 dark:border-neutral-800 space-y-3">
            {distribution.underLockedLetters.length > 0 ? (
              <p className="text-xs font-semibold text-red-600 dark:text-red-400">
                Increase target quantities for locked letters ({distribution.underLockedLetters.join(', ')}) so they are at least equal to already Completed/Printing plates.
              </p>
            ) : distribution.remainderCount > 0 ? (
              <div className="space-y-2">
                <div className="text-xs text-neutral-800 dark:text-neutral-200">
                  <span className="font-semibold">
                    Remainder Detected ({distribution.remainderCount} keycaps not divisible by {plateCapacity}):
                  </span>{' '}
                  {Object.entries(distribution.remainder)
                    .map(([k, v]) => `${k}×${v}`)
                    .join(', ')}
                  . Add <span className="font-mono-data font-semibold">{distribution.neededForNextFullPlate}</span> more keycaps in the A–Z grid above for another exact {plateCapacity}-keycap plate, or choose how to handle the remainder:
                </div>
                <div className="flex flex-wrap gap-2.5">
                  <button
                    type="button"
                    onClick={() => handlePreparePlatesPreview('carry_forward')}
                    className="px-4 py-2 text-xs font-semibold rounded-lg bg-[#6c4ce6] hover:bg-[#5b3cc4] text-white whitespace-nowrap"
                  >
                    Generate {distribution.fullPlates.length} Exact Plate(s) &amp; Carry Remainder ({distribution.remainderCount} pcs) Forward
                  </button>
                  <button
                    type="button"
                    onClick={() => handlePreparePlatesPreview('partial_plate')}
                    className="px-4 py-2 text-xs font-medium rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-[#171522] text-neutral-800 dark:text-neutral-200 whitespace-nowrap"
                  >
                    Generate {distribution.fullPlates.length} Full + 1 Partial Plate ({distribution.remainderCount}/{plateCapacity} pcs)
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-emerald-700 dark:text-emerald-400 font-medium">
                  Exact multiple of {plateCapacity} pcs — distributes cleanly into {distribution.fullPlates.length} full plate(s) with 0 remainder.
                </div>
                <button
                  type="button"
                  disabled={distribution.totalNetCount === 0}
                  onClick={() => handlePreparePlatesPreview('carry_forward')}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-[#6c4ce6] hover:bg-[#5b3cc4] disabled:opacity-40 text-white whitespace-nowrap"
                >
                  Preview &amp; Adjust {distribution.fullPlates.length} Plate(s)
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Interactive Pre-Confirmation Plate Adjustment Area */}
      {stagedPlates !== null && (
        <section className="bg-white dark:bg-[#171522] border-2 border-[#6c4ce6] rounded-2xl p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-neutral-900 dark:text-white">
                Review &amp; Manually Adjust Generated Plates Before Saving
              </h3>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                Completed and currently Printing plates remain untouched. Adjust letter counts on any proposed plate below (validated up to {plateCapacity} pcs/plate).
              </p>
            </div>
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => setStagedPlates(null)}
                className="px-3.5 py-2 text-xs font-medium rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300"
              >
                Discard Preview
              </button>
              <button
                type="button"
                onClick={handleConfirmAndSavePlates}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-[#6c4ce6] hover:bg-[#5b3cc4] text-white whitespace-nowrap"
              >
                Confirm &amp; Save to Print Queue
              </button>
            </div>
          </div>

          {stagedPlates.length === 0 ? (
            <div className="p-4 rounded-xl bg-neutral-50 dark:bg-[#111018] text-xs text-neutral-700 dark:text-neutral-300">
              0 full plates to create right now. Confirming will save the{' '}
              <b>{distribution?.remainderCount || 0} pcs</b> remainder to this project&apos;s Carry-Forward pool.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {stagedPlates.map((plate) => {
                const count = countLetters(plate.letters);
                const overCap = count > plate.capacity;
                return (
                  <StagedPlateEditorCard
                    key={plate.tempId}
                    plate={plate}
                    count={count}
                    overCap={overCap}
                    onAdjustLetter={handleAdjustStagedPlateLetter}
                    onAddLetter={handleAddLetterToStagedPlate}
                    onToggleVerified={handleToggleStagedSlicerVerified}
                    onChangeDuration={handleAdjustStagedDuration}
                  />
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
};

interface StagedPlateEditorCardProps {
  plate: DraftPlatePreview;
  count: number;
  overCap: boolean;
  onAdjustLetter: (tempId: string, letter: string, val: string) => void;
  onAddLetter: (tempId: string, letter: string) => void;
  onToggleVerified: (tempId: string) => void;
  onChangeDuration: (tempId: string, minutes: number) => void;
}

const StagedPlateEditorCard: React.FC<StagedPlateEditorCardProps> = ({
  plate,
  count,
  overCap,
  onAdjustLetter,
  onAddLetter,
  onToggleVerified,
  onChangeDuration,
}) => {
  const [letterToAdd, setLetterToAdd] = useState('A');

  return (
    <div
      className={`rounded-xl border p-4 space-y-3 ${
        overCap
          ? 'border-red-500 bg-red-50/30 dark:bg-red-950/20'
          : 'border-neutral-200 dark:border-neutral-800 bg-neutral-50/60 dark:bg-[#13111c]'
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-neutral-900 dark:text-white">
          Plate {plate.plateNumber}
        </span>
        <span
          className={`text-xs font-mono-data font-semibold ${
            overCap
              ? 'text-red-600 dark:text-red-400'
              : count === plate.capacity
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-amber-600 dark:text-amber-400'
          }`}
        >
          {count} / {plate.capacity} pcs
        </span>
      </div>

      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-neutral-500">Bambu Studio Time:</span>
        <DurationHMInput
          compact
          minutes={plate.estimatedMinutes}
          onChangeMinutes={(mins) => onChangeDuration(plate.tempId, mins)}
          ariaLabelPrefix={`Plate ${plate.plateNumber} duration`}
        />
      </div>

      <div className="grid grid-cols-3 gap-2">
        {Object.entries(plate.letters).map(([k, v]) => (
          <div
            key={k}
            className="flex items-center gap-1 bg-white dark:bg-[#1a1828] border border-neutral-200 dark:border-neutral-700 rounded-lg px-2 py-1"
          >
            <span className="text-xs font-bold text-neutral-800 dark:text-neutral-200 w-4">
              {k}
            </span>
            <input
              type="number"
              min={0}
              value={v}
              onChange={(e) => onAdjustLetter(plate.tempId, k, e.target.value)}
              className="w-full text-right text-xs font-mono-data bg-transparent text-neutral-900 dark:text-white focus:outline-none"
            />
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-2 pt-2 border-t border-neutral-200/70 dark:border-neutral-800">
        <div className="flex items-center gap-1.5">
          <select
            aria-label="Select letter to add to plate"
            value={letterToAdd}
            onChange={(e) => setLetterToAdd(e.target.value)}
            className="px-2 py-1 rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-[#1a1828] text-xs"
          >
            {ABC.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => onAddLetter(plate.tempId, letterToAdd)}
            className="px-2 py-1 text-xs rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-[#1a1828] hover:bg-neutral-100 dark:hover:bg-neutral-800 whitespace-nowrap"
          >
            + Add Letter
          </button>
        </div>

        <label className="flex items-center gap-1.5 text-[11px] text-neutral-600 dark:text-neutral-400 cursor-pointer">
          <input
            type="checkbox"
            checked={plate.slicerVerified}
            onChange={() => onToggleVerified(plate.tempId)}
          />
          <span>Slicer Fit Checked</span>
        </label>
      </div>
    </div>
  );
};
