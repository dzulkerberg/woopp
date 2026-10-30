import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ABC,
  CHARM_BY_ID,
  CHARM_DEFINITIONS,
  CHARM_IDS,
  compactCharmsMap,
  compactLettersMap,
  countCharms,
  countLetters,
  countPlateKeycaps,
  DEFAULT_PLATE_CAPACITY,
  emptyAlphabetMap,
  emptyCharmsMap,
  normalizeAlphabetMap,
  normalizeCharmsMap,
  sumAlphabetMaps,
  sumCharmsMaps,
} from '../constants';
import {
  AlphabetPreset,
  CharmId,
  CharmsMap,
  LettersMap,
  PlateGenerationMode,
  ProductionJob,
  ProductionWorkspaceV5,
} from '../types';
import {
  computeColorPlanningState,
  computeIntelligentPlates,
  DraftPlatePreview,
  inferPlateMode,
  isValidProductionAllocationJob,
} from '../utils/productionEngine';
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
    mode: PlateGenerationMode;
    targetLetters: LettersMap;
    targetCharms: CharmsMap;
    carryForwardLetters: LettersMap;
    carryForwardCharms: CharmsMap;
    confirmedPlates: DraftPlatePreview[];
    preserveQueuedPlates?: boolean;
    onSuccess?: () => void;
  }) => void;
  onClearCarryForward?: (params: {
    projectId: string;
    colorId: string;
    mode: PlateGenerationMode;
    trimTargetRemainder: boolean;
  }) => void;
  onAlert: (msg: string, title?: string) => void;
}

const MODE_OPTIONS: { id: PlateGenerationMode; label: string; hint: string }[] = [
  {
    id: 'alphabet_only',
    label: 'Alphabet Only',
    hint: 'Distributes A–Z keycaps only; preserves Charm targets & queued Charm plates',
  },
  {
    id: 'charm_only',
    label: 'Charm Only',
    hint: 'Distributes Charm keycaps (♥ ★ ✿ # @) only; preserves A–Z targets & queued A–Z plates',
  },
  {
    id: 'mixed',
    label: 'Alphabet + Charm (Mixed)',
    hint: 'Combines A–Z and Charm keycaps together up to 138 pcs per plate',
  },
];

export const AutoPlannerView: React.FC<AutoPlannerViewProps> = ({
  workspace,
  selectedProjectId,
  onSelectProject,
  onSavePreset,
  onDeletePreset,
  onCommitGeneratedPlates,
  onClearCarryForward,
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
  const [generationMode, setGenerationMode] = useState<PlateGenerationMode>('mixed');
  const [draftLetters, setDraftLetters] = useState<LettersMap>(() => emptyAlphabetMap());
  const [draftCharms, setDraftCharms] = useState<Record<CharmId, number>>(() =>
    emptyCharmsMap()
  );
  const [hasUnsavedGridEdits, setHasUnsavedGridEdits] = useState<boolean>(false);
  const [preserveQueuedPlates, setPreserveQueuedPlates] = useState<boolean>(false);
  const [presetName, setPresetName] = useState<string>('');
  const [selectedPresetId, setSelectedPresetId] = useState<string>('');

  // Staging area for manual adjustment before confirming plates
  const [stagedPlates, setStagedPlates] = useState<DraftPlatePreview[] | null>(null);
  const [remainderMode, setRemainderMode] = useState<'carry_forward' | 'partial_plate'>(
    'carry_forward'
  );

  const prevContextKeyRef = useRef<string>('');

  // Synchronize draft letters & charms when project/color changes OR when external queue
  // mutations (delete, cancel, archive, restore, clear carry-forward) update valid planning state.
  useEffect(() => {
    if (!currentProject) return;
    if (!projectColors.some((c) => c.id === selectedColorId) && projectColors[0]) {
      setSelectedColorId(projectColors[0].id);
      return;
    }

    const contextKey = `${currentProject.id}:${selectedColorId}`;
    const isContextSwitch = prevContextKeyRef.current !== contextKey;
    if (isContextSwitch) {
      prevContextKeyRef.current = contextKey;
      setHasUnsavedGridEdits(false);
      setPreserveQueuedPlates(false);
      setPlateCapacity(currentProject.plateCapacity || DEFAULT_PLATE_CAPACITY);
      setStagedPlates(null);
    } else if (hasUnsavedGridEdits) {
      return;
    }

    const state = computeColorPlanningState(
      workspace.jobs,
      currentProject,
      selectedColorId
    );

    setDraftLetters(
      normalizeAlphabetMap(
        sumAlphabetMaps([state.validAllocatedLetters, state.carryForwardLetters])
      )
    );
    setDraftCharms(
      normalizeCharmsMap(
        sumCharmsMaps([state.validAllocatedCharms, state.carryForwardCharms])
      )
    );

    if (!isContextSwitch) {
      setStagedPlates(null);
    }
  }, [
    currentProject,
    selectedColorId,
    projectColors,
    workspace.jobs,
    hasUnsavedGridEdits,
  ]);

  const colorPlanningState = useMemo(() => {
    if (!currentProject) return null;
    return computeColorPlanningState(workspace.jobs, currentProject, selectedColorId);
  }, [workspace.jobs, currentProject, selectedColorId]);

  const effectivePreserveQueued =
    Boolean(preserveQueuedPlates) && (colorPlanningState?.queuedPlatesCount || 0) > 0;

  const distribution = useMemo(() => {
    if (!currentProject) return null;
    return computeIntelligentPlates(
      workspace.jobs,
      currentProject.id,
      selectedColorId,
      draftLetters,
      plateCapacity,
      defaultPlateMinutes,
      {
        requestedCharms: draftCharms,
        mode: generationMode,
        preserveQueuedPlates: effectivePreserveQueued,
      }
    );
  }, [
    workspace.jobs,
    currentProject,
    selectedColorId,
    draftLetters,
    draftCharms,
    plateCapacity,
    defaultPlateMinutes,
    generationMode,
    effectivePreserveQueued,
  ]);

  if (!currentProject || !colorPlanningState) {
    return (
      <div className="bg-white dark:bg-[#171522] border border-neutral-200 dark:border-neutral-800 rounded-2xl p-8 text-center">
        <p className="text-sm text-neutral-600 dark:text-neutral-300">
          Create or unarchive a project first to plan alphabet and charm keycap plates.
        </p>
      </div>
    );
  }

  // Carry-forward is always derived from the current valid planning state (never a stale snapshot)
  const carryForwardLettersDerived = colorPlanningState.carryForwardLetters;
  const carryForwardCharmsDerived = colorPlanningState.carryForwardCharms;

  const carryForwardLettersCount =
    generationMode === 'charm_only' ? 0 : colorPlanningState.carryForwardLettersCount;
  const carryForwardCharmsCount =
    generationMode === 'alphabet_only' ? 0 : colorPlanningState.carryForwardCharmsCount;
  const carryForwardTotal = carryForwardLettersCount + carryForwardCharmsCount;

  // Determine how much of the active carry-forward is NOT yet included in the current grid
  // so clicking Merge Carry-Forward never double-adds carry-forward on top of saved targets.
  const missingCarryLetters = emptyAlphabetMap();
  if (generationMode !== 'charm_only' && carryForwardLettersCount > 0) {
    for (const letter of ABC) {
      const carryVal = carryForwardLettersDerived[letter] || 0;
      if (carryVal > 0) {
        const expectedMin =
          (colorPlanningState.validAllocatedLetters[letter] || 0) + carryVal;
        missingCarryLetters[letter] = Math.max(
          0,
          expectedMin - (draftLetters[letter] || 0)
        );
      }
    }
  }
  const missingCarryCharms: CharmsMap = {};
  if (generationMode !== 'alphabet_only' && carryForwardCharmsCount > 0) {
    for (const charmId of CHARM_IDS) {
      const carryVal = carryForwardCharmsDerived[charmId] || 0;
      if (carryVal > 0) {
        const expectedMin =
          (colorPlanningState.validAllocatedCharms[charmId] || 0) + carryVal;
        const diff = Math.max(0, expectedMin - (draftCharms[charmId] || 0));
        if (diff > 0) {
          missingCarryCharms[charmId] = diff;
        }
      }
    }
  }
  const missingCarryTotal =
    countLetters(missingCarryLetters) + countCharms(missingCarryCharms);

  const handleSetLetterQty = (letter: string, rawVal: string) => {
    const val = Math.max(0, Math.floor(Number(rawVal) || 0));
    setHasUnsavedGridEdits(true);
    setDraftLetters((prev) => ({ ...prev, [letter]: val }));
    setStagedPlates(null);
  };

  const handleSetCharmQty = (charmId: CharmId, nextVal: number) => {
    const safeVal = Math.max(0, Math.floor(Number.isFinite(nextVal) ? nextVal : 0));
    setHasUnsavedGridEdits(true);
    setDraftCharms((prev) => ({ ...prev, [charmId]: safeVal }));
    setStagedPlates(null);
  };

  const handleLoadAlphabetFromQueue = () => {
    const jobsForPair: ProductionJob[] = workspace.jobs.filter(
      (j) =>
        j.projectId === currentProject.id &&
        j.colorId === selectedColorId &&
        isValidProductionAllocationJob(j)
    );
    setHasUnsavedGridEdits(true);
    setDraftLetters(sumAlphabetMaps(jobsForPair.map((j) => j.letters)));
    setStagedPlates(null);
  };

  const handleLoadCharmsFromQueue = () => {
    const jobsForPair: ProductionJob[] = workspace.jobs.filter(
      (j) =>
        j.projectId === currentProject.id &&
        j.colorId === selectedColorId &&
        isValidProductionAllocationJob(j)
    );
    setHasUnsavedGridEdits(true);
    setDraftCharms(sumCharmsMaps(jobsForPair.map((j) => j.charms)));
    setStagedPlates(null);
  };

  const handleIncludeCarryForward = () => {
    if (missingCarryTotal === 0) return;
    setHasUnsavedGridEdits(true);
    if (generationMode !== 'charm_only' && countLetters(missingCarryLetters) > 0) {
      setDraftLetters((prev) => sumAlphabetMaps([prev, missingCarryLetters]));
    }
    if (generationMode !== 'alphabet_only' && countCharms(missingCarryCharms) > 0) {
      setDraftCharms((prev) => sumCharmsMaps([prev, missingCarryCharms]));
    }
    setStagedPlates(null);
  };

  const handleApplyPreset = () => {
    const preset = workspace.presets.find((p) => p.id === selectedPresetId);
    if (!preset) return;
    setHasUnsavedGridEdits(true);
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
    if (distribution.underLockedLabels.length > 0) {
      onAlert(
        `Target cannot be lower than already Completed or Printing plates for: ${distribution.underLockedLabels.join(
          ', '
        )}.`,
        'Locked Plate Protection'
      );
      return;
    }
    if (distribution.totalNetCount === 0) {
      onAlert(
        'Enter at least 1 net keycap to plate (above Completed/Printing plates) for the selected generation mode.'
      );
      return;
    }

    setRemainderMode(mode);
    const previewList: DraftPlatePreview[] = distribution.fullPlates.map((p) => ({
      ...p,
      letters: { ...p.letters },
      charms: { ...p.charms },
    }));

    if (mode === 'partial_plate' && distribution.remainderCount > 0) {
      const usedNums = new Set<number>(previewList.map((p) => p.plateNumber));
      workspace.jobs
        .filter((j) => j.projectId === currentProject.id && j.colorId === selectedColorId)
        .forEach((j) => {
          if (
            Boolean(j.archived) ||
            j.stage === 'Completed' ||
            j.stage === 'Printing' ||
            j.stage === 'Failed / Reprint' ||
            j.stage === 'Cancelled' ||
            (effectivePreserveQueued &&
              (j.stage === 'Planned' || j.stage === 'Ready to Print')) ||
            (generationMode === 'alphabet_only' &&
              countLetters(j.letters) === 0 &&
              countCharms(j.charms) > 0) ||
            (generationMode === 'charm_only' &&
              countCharms(j.charms) === 0 &&
              countLetters(j.letters) > 0)
          ) {
            usedNums.add(j.plateNumber);
          }
        });

      let partialNum = 1;
      while (usedNums.has(partialNum)) {
        partialNum += 1;
      }

      const remLetters = { ...distribution.remainder };
      const remCharms = { ...distribution.remainderCharms };
      const freeCap = Math.max(0, plateCapacity - distribution.remainderCount);

      previewList.push({
        tempId: `draft-partial-${Date.now()}`,
        plateNumber: partialNum,
        capacity: plateCapacity,
        letters: remLetters,
        charms: remCharms,
        plateMode: inferPlateMode(remLetters, remCharms),
        estimatedMinutes: Math.max(
          15,
          Math.round((distribution.remainderCount / plateCapacity) * defaultPlateMinutes)
        ),
        slicerVerified: false,
        notes: `Incomplete plate (${distribution.remainderCount}/${plateCapacity} pcs · ${freeCap} pcs remaining capacity)`,
      });
    }

    if (previewList.length === 0 && mode === 'carry_forward') {
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
        return {
          ...plate,
          letters: nextLetters,
          plateMode: inferPlateMode(nextLetters, plate.charms),
        };
      })
    );
  };

  const handleAdjustStagedPlateCharm = (
    tempId: string,
    charmId: CharmId,
    nextValRaw: string
  ) => {
    if (!stagedPlates) return;
    const val = Math.max(0, Math.floor(Number(nextValRaw) || 0));
    setStagedPlates(
      stagedPlates.map((plate) => {
        if (plate.tempId !== tempId) return plate;
        const nextCharms: CharmsMap = { ...plate.charms };
        if (val === 0) {
          delete nextCharms[charmId];
        } else {
          nextCharms[charmId] = val;
        }
        return {
          ...plate,
          charms: nextCharms,
          plateMode: inferPlateMode(plate.letters, nextCharms),
        };
      })
    );
  };

  const handleAddLetterToStagedPlate = (tempId: string, letter: string) => {
    if (!stagedPlates || !ABC.includes(letter)) return;
    setStagedPlates(
      stagedPlates.map((plate) => {
        if (plate.tempId !== tempId) return plate;
        const currentTotal = countPlateKeycaps(plate);
        if (currentTotal >= plate.capacity) {
          onAlert(
            `Plate ${plate.plateNumber} is already at full capacity (${plate.capacity} pcs). Reduce another keycap before adding more.`,
            'Plate Capacity Limit'
          );
          return plate;
        }
        const nextLetters = {
          ...plate.letters,
          [letter]: (plate.letters[letter] || 0) + 1,
        };
        return {
          ...plate,
          letters: nextLetters,
          plateMode: inferPlateMode(nextLetters, plate.charms),
        };
      })
    );
  };

  const handleAddCharmToStagedPlate = (tempId: string, charmId: CharmId) => {
    if (!stagedPlates || !CHARM_IDS.includes(charmId)) return;
    setStagedPlates(
      stagedPlates.map((plate) => {
        if (plate.tempId !== tempId) return plate;
        const currentTotal = countPlateKeycaps(plate);
        if (currentTotal >= plate.capacity) {
          onAlert(
            `Plate ${plate.plateNumber} is already at full capacity (${plate.capacity} pcs). Reduce another keycap before adding more.`,
            'Plate Capacity Limit'
          );
          return plate;
        }
        const nextCharms: CharmsMap = {
          ...plate.charms,
          [charmId]: (plate.charms[charmId] || 0) + 1,
        };
        return {
          ...plate,
          charms: nextCharms,
          plateMode: inferPlateMode(plate.letters, nextCharms),
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

    // Strictly validate capacity on every staged plate before saving (never exceed plate capacity)
    for (const plate of stagedPlates) {
      const qty = countPlateKeycaps(plate);
      if (qty <= 0) {
        onAlert(`Plate ${plate.plateNumber} has 0 keycaps. Adjust or regenerate before saving.`);
        return;
      }
      if (qty > plate.capacity) {
        onAlert(
          `Capacity exceeded on Plate ${plate.plateNumber}: ${qty} pcs exceeds configured plate capacity of ${plate.capacity} pcs.`,
          'Plate Capacity Validation'
        );
        return;
      }
    }

    const carryForwardLettersToSave =
      remainderMode === 'carry_forward' && generationMode !== 'charm_only'
        ? distribution.remainder
        : generationMode === 'charm_only'
        ? compactLettersMap(carryForwardLettersDerived)
        : emptyAlphabetMap();

    const carryForwardCharmsToSave =
      remainderMode === 'carry_forward' && generationMode !== 'alphabet_only'
        ? distribution.remainderCharms
        : generationMode === 'alphabet_only'
        ? compactCharmsMap(carryForwardCharmsDerived)
        : {};

    // Reconcile targets with confirmed staged plates + locked plates + carry-forward so manual edits stay accurate,
    // while strictly preserving the untouched category when in Alphabet Only or Charm Only mode.
    const stagedLettersSum = sumAlphabetMaps(stagedPlates.map((p) => p.letters));
    const stagedCharmsSum = sumCharmsMaps(stagedPlates.map((p) => p.charms));

    const committedTargetLetters =
      generationMode === 'charm_only'
        ? compactLettersMap(
            sumAlphabetMaps([
              colorPlanningState.validAllocatedLetters,
              carryForwardLettersToSave,
            ])
          )
        : compactLettersMap(
            sumAlphabetMaps([
              distribution.lockedTotals,
              stagedLettersSum,
              carryForwardLettersToSave,
            ])
          );

    const committedTargetCharms =
      generationMode === 'alphabet_only'
        ? compactCharmsMap(
            sumCharmsMaps([
              colorPlanningState.validAllocatedCharms,
              carryForwardCharmsToSave,
            ])
          )
        : compactCharmsMap(
            sumCharmsMaps([
              distribution.lockedCharms,
              stagedCharmsSum,
              carryForwardCharmsToSave,
            ])
          );

    onCommitGeneratedPlates({
      projectId: currentProject.id,
      colorId: selectedColorId,
      plateCapacity,
      mode: generationMode,
      targetLetters: committedTargetLetters,
      targetCharms: committedTargetCharms,
      carryForwardLetters: carryForwardLettersToSave,
      carryForwardCharms: carryForwardCharmsToSave,
      confirmedPlates: stagedPlates,
      preserveQueuedPlates: effectivePreserveQueued,
      onSuccess: () => {
        setHasUnsavedGridEdits(false);
        setStagedPlates(null);
      },
    });
  };

  const totalAlphabetRequested = countLetters(draftLetters);
  const totalCharmsRequested = countCharms(draftCharms);
  const activeModeTargetTotal =
    generationMode === 'alphabet_only'
      ? totalAlphabetRequested
      : generationMode === 'charm_only'
      ? totalCharmsRequested
      : totalAlphabetRequested + totalCharmsRequested;

  const lockedAlphabetCount = distribution ? countLetters(distribution.lockedTotals) : 0;
  const lockedCharmCount = distribution ? countCharms(distribution.lockedCharms) : 0;
  const activeModeLockedCount =
    generationMode === 'alphabet_only'
      ? lockedAlphabetCount
      : generationMode === 'charm_only'
      ? lockedCharmCount
      : lockedAlphabetCount + lockedCharmCount;

  const remainderSummaryParts: string[] = [];
  if (distribution) {
    for (const [k, v] of Object.entries(distribution.remainder)) {
      if (v > 0) remainderSummaryParts.push(`${k}×${v}`);
    }
    for (const def of CHARM_DEFINITIONS) {
      const v = distribution.remainderCharms[def.id] || 0;
      if (v > 0) remainderSummaryParts.push(`${def.symbol} ${def.label}×${v}`);
    }
  }

  return (
    <div className="space-y-6">
      {/* Top Context Selector: Project, Color, Plate Capacity, Presets & Production Mode */}
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
                title="Keycaps per plate (1 letter = 1 pc, 1 charm = 1 pc)"
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

        {/* Auto Plate Generator Mode Selector */}
        <div className="pt-4 border-t border-neutral-100 dark:border-neutral-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="text-xs font-semibold text-neutral-800 dark:text-neutral-200">
              Auto Plate Generator Mode
            </div>
            <div className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-0.5">
              {MODE_OPTIONS.find((m) => m.id === generationMode)?.hint}
            </div>
          </div>

          <div
            role="group"
            aria-label="Plate generation mode"
            className="inline-flex flex-wrap items-center gap-1 p-1 rounded-xl bg-neutral-100 dark:bg-[#111018] border border-neutral-200/80 dark:border-neutral-800"
          >
            {MODE_OPTIONS.map((opt) => {
              const active = generationMode === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => {
                    setGenerationMode(opt.id);
                    setStagedPlates(null);
                  }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                    active
                      ? 'bg-[#6c4ce6] text-white shadow-xs'
                      : 'text-neutral-600 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-white'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* 4-Metric Color Plate & Carry-Forward Breakdown */}
        <div className="rounded-xl border border-neutral-200/80 dark:border-neutral-800 bg-neutral-50/70 dark:bg-[#12101b] grid grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-neutral-200/70 dark:divide-neutral-800">
          <div className="p-3">
            <div className="text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
              Current Planner Input
            </div>
            <div className="text-sm font-bold font-mono-data text-neutral-900 dark:text-white mt-0.5">
              {(totalAlphabetRequested + totalCharmsRequested).toLocaleString()} pcs
            </div>
            <div className="text-[11px] font-mono-data text-neutral-500 dark:text-neutral-400 mt-0.5">
              {totalAlphabetRequested} A–Z · {totalCharmsRequested} Charm
            </div>
          </div>

          <div className="p-3">
            <div className="text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
              Completed Production
            </div>
            <div className="text-sm font-bold font-mono-data text-emerald-700 dark:text-emerald-400 mt-0.5">
              {colorPlanningState.completedTotal.toLocaleString()} pcs
            </div>
            <div className="text-[11px] font-mono-data text-neutral-500 dark:text-neutral-400 mt-0.5">
              {colorPlanningState.completedPlatesCount} completed plate(s)
            </div>
          </div>

          <div className="p-3">
            <div className="text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
              Generated Active Plates
            </div>
            <div className="text-sm font-bold font-mono-data text-neutral-900 dark:text-white mt-0.5">
              {colorPlanningState.activePlatesTotal.toLocaleString()} pcs
            </div>
            <div className="text-[11px] font-mono-data text-neutral-500 dark:text-neutral-400 mt-0.5">
              {colorPlanningState.queuedPlatesCount} queued ·{' '}
              {colorPlanningState.printingPlatesCount} printing
            </div>
          </div>

          <div className="p-3">
            <div className="text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
              Session Carry-Forward
            </div>
            <div
              className={`text-sm font-bold font-mono-data mt-0.5 ${
                carryForwardTotal > 0
                  ? 'text-[#5b3cc4] dark:text-[#c7b8ff]'
                  : 'text-neutral-900 dark:text-white'
              }`}
            >
              {carryForwardTotal.toLocaleString()} pcs
            </div>
            <div className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-0.5">
              {carryForwardTotal > 0
                ? 'Active incomplete-plate remainder'
                : 'No unplated remainder'}
            </div>
          </div>
        </div>

        {/* Carry-Forward Controls */}
        {carryForwardTotal > 0 && (
          <div className="p-3.5 rounded-xl bg-amber-50/70 dark:bg-amber-950/25 border border-amber-200/80 dark:border-amber-900/50 text-xs text-amber-900 dark:text-amber-200 flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex flex-wrap items-center gap-2">
              {missingCarryTotal > 0 ? (
                <button
                  type="button"
                  onClick={handleIncludeCarryForward}
                  className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-semibold whitespace-nowrap"
                >
                  + Merge Carry-Forward ({missingCarryTotal} pcs)
                </button>
              ) : (
                <span className="px-2.5 py-1 rounded-lg bg-white/80 dark:bg-[#191726] border border-amber-300/80 dark:border-amber-800/70 text-[11px] font-medium text-amber-900 dark:text-amber-200 whitespace-nowrap">
                  Carry-forward ({carryForwardTotal} pcs) included in target grid
                </span>
              )}
              {onClearCarryForward && (
                <button
                  type="button"
                  onClick={() =>
                    onClearCarryForward({
                      projectId: currentProject.id,
                      colorId: selectedColorId,
                      mode: generationMode,
                      trimTargetRemainder: true,
                    })
                  }
                  className="px-2.5 py-1.5 rounded-lg border border-amber-300 dark:border-amber-700 bg-white dark:bg-[#171522] text-amber-900 dark:text-amber-200 hover:bg-amber-100/60 dark:hover:bg-amber-950/40 font-medium whitespace-nowrap"
                >
                  Dismiss Carry-Forward
                </button>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Category 1: Alphabet A–Z */}
      <section
        className={`bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-2xl p-6 space-y-5 transition-opacity ${
          generationMode === 'charm_only' ? 'opacity-65' : ''
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-neutral-900 dark:text-white">
                Alphabet A–Z
              </h2>
              <span className="text-xs font-mono-data px-2 py-0.5 rounded-md bg-[#f4f0ff] dark:bg-[#26203d] text-[#5b3cc4] dark:text-[#d5c8ff] font-semibold">
                {totalAlphabetRequested} pcs
              </span>
              {generationMode === 'charm_only' && (
                <span className="text-[11px] px-2 py-0.5 rounded-md bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 font-medium">
                  Excluded in Charm Only mode · Existing A–Z plates preserved
                </span>
              )}
            </div>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
              Enter custom quantity per letter for this filament color. Unrequested letters are never added automatically.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {hasUnsavedGridEdits && (
              <button
                type="button"
                onClick={() => {
                  setHasUnsavedGridEdits(false);
                  setStagedPlates(null);
                }}
                className="px-3 py-1.5 text-xs font-medium rounded-lg border border-[#dfd7fb] dark:border-[#3e3366] bg-[#faf8ff] dark:bg-[#221c38] text-[#5b3cc4] dark:text-[#d5c8ff] whitespace-nowrap"
              >
                Reset to Active Queue
              </button>
            )}
            <button
              type="button"
              onClick={handleLoadAlphabetFromQueue}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 whitespace-nowrap"
            >
              Load Queue A–Z
            </button>
            <button
              type="button"
              onClick={() => {
                if (distribution) {
                  setHasUnsavedGridEdits(true);
                  setDraftLetters({ ...distribution.lockedTotals });
                  setStagedPlates(null);
                }
              }}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 whitespace-nowrap"
            >
              Reset A–Z to Locked Minimum
            </button>
          </div>
        </div>

        <div className="grid grid-cols-4 sm:grid-cols-7 md:grid-cols-9 lg:grid-cols-13 gap-2.5">
          {ABC.map((letter) => {
            const lockedVal = distribution?.lockedTotals[letter] || 0;
            const currentVal = draftLetters[letter] ?? 0;
            const isInvalid = generationMode !== 'charm_only' && currentVal < lockedVal;
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

        {/* Save Reusable Alphabet Preset Bar */}
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
          <div className="text-xs font-mono-data text-neutral-500 dark:text-neutral-400">
            Alphabet Subtotal: <b className="text-neutral-900 dark:text-white">{totalAlphabetRequested}</b> pcs · Locked: <b>{lockedAlphabetCount}</b> pcs
          </div>
        </div>
      </section>

      {/* Category 2: Charm Keycaps */}
      <section
        className={`bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-2xl p-6 space-y-5 transition-opacity ${
          generationMode === 'alphabet_only' ? 'opacity-65' : ''
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-neutral-900 dark:text-white">
                Charm Keycaps
              </h2>
              <span className="text-xs font-mono-data px-2 py-0.5 rounded-md bg-[#f4f0ff] dark:bg-[#26203d] text-[#5b3cc4] dark:text-[#d5c8ff] font-semibold">
                {totalCharmsRequested} pcs
              </span>
              {generationMode === 'alphabet_only' && (
                <span className="text-[11px] px-2 py-0.5 rounded-md bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 font-medium">
                  Excluded in Alphabet Only mode · Existing Charm plates preserved
                </span>
              )}
            </div>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
              Each charm counts as 1 physical keycap and supports independent quantities per filament color (defaults to 0).
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleLoadCharmsFromQueue}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 whitespace-nowrap"
            >
              Load Queue Charms
            </button>
            <button
              type="button"
              onClick={() => {
                if (distribution) {
                  setHasUnsavedGridEdits(true);
                  setDraftCharms({ ...distribution.lockedCharms });
                  setStagedPlates(null);
                }
              }}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 whitespace-nowrap"
            >
              Reset Charms to Locked Minimum
            </button>
          </div>
        </div>

        {/* 5 Visual Charm Cards (Desktop 5-col, Tablet 3-col, Mobile 1-2 col) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3.5">
          {CHARM_DEFINITIONS.map((charm) => {
            const lockedVal = distribution?.lockedCharms[charm.id] || 0;
            const currentVal = draftCharms[charm.id] ?? 0;
            const isInvalid = generationMode !== 'alphabet_only' && currentVal < lockedVal;

            return (
              <div
                key={charm.id}
                className={`rounded-2xl border p-4 flex flex-col justify-between gap-3 transition-colors ${
                  isInvalid
                    ? 'border-red-400 bg-red-50/40 dark:bg-red-950/30'
                    : currentVal > 0
                    ? 'border-[#cfc2ff] dark:border-[#433575] bg-[#faf8ff] dark:bg-[#1b172b]'
                    : 'border-neutral-200/80 dark:border-neutral-800 bg-neutral-50/50 dark:bg-[#13111c]'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div
                      className="w-10 h-10 rounded-xl bg-[#f1edfd] dark:bg-[#2a2344] border border-[#dfd7fb] dark:border-[#3e3366] flex items-center justify-center text-lg font-bold text-[#5b3cc4] dark:text-[#d5c8ff] shrink-0"
                      aria-hidden="true"
                    >
                      {charm.symbol}
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs font-bold tracking-wide text-neutral-900 dark:text-white truncate">
                        {charm.label}
                      </div>
                      <div className="text-[10px] font-mono-data text-neutral-400 dark:text-neutral-500 truncate">
                        {charm.id}
                      </div>
                    </div>
                  </div>

                  {lockedVal > 0 && (
                    <span
                      className="text-[10px] font-mono-data px-1.5 py-0.5 rounded bg-neutral-200/70 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 shrink-0"
                      title="Locked in Printing/Completed plates"
                    >
                      L:{lockedVal}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    aria-label={`Decrease ${charm.label} quantity`}
                    onClick={() => handleSetCharmQty(charm.id, currentVal - 1)}
                    className="w-8 h-9 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-[#191726] hover:bg-neutral-100 dark:hover:bg-neutral-800 text-sm font-semibold text-neutral-700 dark:text-neutral-200 shrink-0"
                  >
                    −
                  </button>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    aria-label={`Quantity for charm ${charm.label}`}
                    value={currentVal}
                    onChange={(e) =>
                      handleSetCharmQty(charm.id, Math.floor(Number(e.target.value) || 0))
                    }
                    className="w-full h-9 px-2 text-center rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-[#191726] text-xs font-mono-data font-semibold text-neutral-900 dark:text-white"
                  />
                  <button
                    type="button"
                    aria-label={`Increase ${charm.label} quantity`}
                    onClick={() => handleSetCharmQty(charm.id, currentVal + 1)}
                    className="w-8 h-9 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-[#191726] hover:bg-neutral-100 dark:hover:bg-neutral-800 text-sm font-semibold text-neutral-700 dark:text-neutral-200 shrink-0"
                  >
                    +
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Auto Plate Generator Summary & Remainder Controls */}
      {distribution && (
        <section className="bg-white dark:bg-[#171522] border border-neutral-200/80 dark:border-neutral-800 rounded-2xl p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-neutral-900 dark:text-white">
                Auto Plate Generator ({MODE_OPTIONS.find((m) => m.id === generationMode)?.label})
              </h2>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                Completed, Failed, and Printing plate history is strictly preserved. Deleted plates and missing letters or charms are never recreated automatically.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {colorPlanningState.queuedPlatesCount > 0 && (
                <div
                  role="group"
                  aria-label="Queue preservation mode"
                  className="inline-flex items-center gap-1 p-1 rounded-xl bg-neutral-100 dark:bg-[#111018] border border-neutral-200/80 dark:border-neutral-800"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setPreserveQueuedPlates(false);
                      setStagedPlates(null);
                    }}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors whitespace-nowrap ${
                      !effectivePreserveQueued
                        ? 'bg-[#6c4ce6] text-white'
                        : 'text-neutral-600 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-white'
                    }`}
                  >
                    Regenerate Queue
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPreserveQueuedPlates(true);
                      setStagedPlates(null);
                    }}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors whitespace-nowrap ${
                      effectivePreserveQueued
                        ? 'bg-[#6c4ce6] text-white'
                        : 'text-neutral-600 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-white'
                    }`}
                  >
                    Queue Remaining Demand Only ({colorPlanningState.queuedPlatesCount} kept)
                  </button>
                </div>
              )}

              <div className="text-xs font-mono-data text-neutral-700 dark:text-neutral-300">
                Mode Target: <b>{activeModeTargetTotal}</b> pcs
                {generationMode === 'mixed' && (
                  <span className="text-neutral-500">
                    {' '}
                    ({totalAlphabetRequested} A–Z + {totalCharmsRequested} Charm)
                  </span>
                )}{' '}
                · {effectivePreserveQueued ? 'Allocated' : 'Locked'}:{' '}
                <b>{activeModeLockedCount}</b> pcs · Net to Plate:{' '}
                <b>{distribution.totalNetCount}</b> pcs · Full Plates:{' '}
                <b>{distribution.fullPlates.length}</b> ({plateCapacity}/plate) · Remainder:{' '}
                <b>{distribution.remainderCount}</b> pcs
              </div>
            </div>
          </div>

          <div className="p-4 rounded-xl bg-neutral-50 dark:bg-[#13111c] border border-neutral-200/80 dark:border-neutral-800 space-y-3">
            {distribution.underLockedLabels.length > 0 ? (
              <p className="text-xs font-semibold text-red-600 dark:text-red-400">
                Increase target quantities for locked items ({distribution.underLockedLabels.join(', ')}) so they are at least equal to already Completed/Printing plates.
              </p>
            ) : distribution.remainderCount > 0 ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-800 dark:text-neutral-200">
                  <div>
                    <span className="font-semibold">
                      Incomplete Plate Remainder ({distribution.remainderCount} / {plateCapacity} pcs):
                    </span>{' '}
                    <span className="font-mono-data">{remainderSummaryParts.join(', ')}</span>
                  </div>
                  <span className="px-2.5 py-1 rounded-lg bg-[#f1edfd] dark:bg-[#2a2344] text-[#5b3cc4] dark:text-[#d5c8ff] font-mono-data font-semibold whitespace-nowrap">
                    Remaining Capacity: {distribution.neededForNextFullPlate} pcs available
                  </span>
                </div>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  Unrequested letters or charms are never added automatically. You can generate an incomplete plate with{' '}
                  <span className="font-mono-data font-semibold">
                    {distribution.neededForNextFullPlate} pcs
                  </span>{' '}
                  remaining capacity, carry the remainder forward, or adjust quantities above:
                </p>
                <div className="flex flex-wrap gap-2.5">
                  <button
                    type="button"
                    onClick={() => handlePreparePlatesPreview('partial_plate')}
                    className="px-4 py-2 text-xs font-semibold rounded-lg bg-[#6c4ce6] hover:bg-[#5b3cc4] text-white whitespace-nowrap"
                  >
                    {distribution.fullPlates.length > 0
                      ? `Preview ${distribution.fullPlates.length} Full + 1 Incomplete Plate (${distribution.remainderCount}/${plateCapacity} pcs · ${distribution.neededForNextFullPlate} free)`
                      : `Preview 1 Incomplete Plate (${distribution.remainderCount}/${plateCapacity} pcs · ${distribution.neededForNextFullPlate} pcs free)`}
                  </button>
                  <button
                    type="button"
                    onClick={() => handlePreparePlatesPreview('carry_forward')}
                    className="px-4 py-2 text-xs font-medium rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-[#171522] text-neutral-800 dark:text-neutral-200 whitespace-nowrap"
                  >
                    {distribution.fullPlates.length > 0
                      ? `Generate ${distribution.fullPlates.length} Exact Plate(s) & Carry Remainder (${distribution.remainderCount} pcs) Forward`
                      : `Carry Remainder (${distribution.remainderCount} pcs) Forward Only`}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-emerald-700 dark:text-emerald-400 font-medium">
                  {distribution.totalNetCount > 0
                    ? `Exact multiple of ${plateCapacity} pcs — distributes cleanly into ${distribution.fullPlates.length} full plate(s) with 0 remainder.`
                    : 'Enter net Alphabet or Charm quantities above to generate print plates.'}
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
        </section>
      )}

      {/* Interactive Pre-Confirmation Plate Adjustment Area */}
      {stagedPlates !== null && (
        <section className="bg-white dark:bg-[#171522] border-2 border-[#6c4ce6] rounded-2xl p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-neutral-900 dark:text-white">
                Review &amp; Manually Adjust Generated Plates Before Saving
              </h3>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                Completed, Failed, and Printing plates remain untouched. Adjust letter or charm counts below (never exceeding {plateCapacity} pcs/plate), and verify physical fit in Bambu Studio.
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
                const count = countPlateKeycaps(plate);
                const overCap = count > plate.capacity;
                return (
                  <StagedPlateEditorCard
                    key={plate.tempId}
                    plate={plate}
                    count={count}
                    overCap={overCap}
                    onAdjustLetter={handleAdjustStagedPlateLetter}
                    onAdjustCharm={handleAdjustStagedPlateCharm}
                    onAddLetter={handleAddLetterToStagedPlate}
                    onAddCharm={handleAddCharmToStagedPlate}
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
  onAdjustCharm: (tempId: string, charmId: CharmId, val: string) => void;
  onAddLetter: (tempId: string, letter: string) => void;
  onAddCharm: (tempId: string, charmId: CharmId) => void;
  onToggleVerified: (tempId: string) => void;
  onChangeDuration: (tempId: string, minutes: number) => void;
}

const StagedPlateEditorCard: React.FC<StagedPlateEditorCardProps> = ({
  plate,
  count,
  overCap,
  onAdjustLetter,
  onAdjustCharm,
  onAddLetter,
  onAddCharm,
  onToggleVerified,
  onChangeDuration,
}) => {
  const [letterToAdd, setLetterToAdd] = useState('A');
  const [charmToAdd, setCharmToAdd] = useState<CharmId>('CHARM_LOVE');

  const remainingCapacity = Math.max(0, plate.capacity - count);
  const letterEntries = Object.entries(plate.letters).filter(([, v]) => Number(v) > 0);
  const charmEntries = CHARM_IDS.filter((cid) => Number(plate.charms?.[cid] || 0) > 0).map(
    (cid) => ({
      def: CHARM_BY_ID[cid],
      qty: Number(plate.charms?.[cid] || 0),
    })
  );

  const modeBadgeLabel =
    letterEntries.length > 0 && charmEntries.length > 0
      ? 'Mixed'
      : charmEntries.length > 0
      ? 'Charm'
      : 'Alphabet';

  return (
    <div
      className={`rounded-xl border p-4 space-y-3 ${
        overCap
          ? 'border-red-500 bg-red-50/30 dark:bg-red-950/20'
          : 'border-neutral-200 dark:border-neutral-800 bg-neutral-50/60 dark:bg-[#13111c]'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-neutral-900 dark:text-white">
            Plate {plate.plateNumber}
          </span>
          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-[#f1edfd] dark:bg-[#2a2344] text-[#5b3cc4] dark:text-[#d5c8ff]">
            {modeBadgeLabel}
          </span>
        </div>
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

      {/* Remaining capacity indicator for incomplete plates */}
      {overCap ? (
        <div className="text-[11px] font-mono-data font-semibold text-red-600 dark:text-red-400">
          Exceeds plate capacity by {count - plate.capacity} pcs (max {plate.capacity} pcs)
        </div>
      ) : remainingCapacity > 0 ? (
        <div className="text-[11px] font-mono-data text-amber-700 dark:text-amber-300 bg-amber-50/80 dark:bg-amber-950/30 border border-amber-200/70 dark:border-amber-800/60 rounded-lg px-2.5 py-1">
          Incomplete plate · Remaining capacity: <b>{remainingCapacity} pcs</b> available
        </div>
      ) : (
        <div className="text-[11px] font-mono-data text-emerald-700 dark:text-emerald-400">
          Full capacity ({plate.capacity} pcs) · Remaining capacity: 0 pcs
        </div>
      )}

      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-neutral-500">Bambu Studio Time:</span>
        <DurationHMInput
          compact
          minutes={plate.estimatedMinutes}
          onChangeMinutes={(mins) => onChangeDuration(plate.tempId, mins)}
          ariaLabelPrefix={`Plate ${plate.plateNumber} duration`}
        />
      </div>

      {/* Alphabet Quantities on Plate */}
      {letterEntries.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[11px] font-semibold text-neutral-500 dark:text-neutral-400">
            Alphabet A–Z ({countLetters(plate.letters)} pcs)
          </div>
          <div className="grid grid-cols-3 gap-2">
            {letterEntries.map(([k, v]) => (
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
                  aria-label={`Plate ${plate.plateNumber} letter ${k} quantity`}
                  value={v}
                  onChange={(e) => onAdjustLetter(plate.tempId, k, e.target.value)}
                  className="w-full text-right text-xs font-mono-data bg-transparent text-neutral-900 dark:text-white focus:outline-none"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Charm Quantities on Plate */}
      {charmEntries.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[11px] font-semibold text-[#5b3cc4] dark:text-[#c7b8ff]">
            Charm Keycaps ({countCharms(plate.charms)} pcs)
          </div>
          <div className="grid grid-cols-2 gap-2">
            {charmEntries.map(({ def, qty }) => (
              <div
                key={def.id}
                className="flex items-center justify-between gap-1.5 bg-[#faf8ff] dark:bg-[#221c38] border border-[#dfd7fb] dark:border-[#3e3366] rounded-lg px-2.5 py-1"
              >
                <span className="text-xs font-semibold text-[#4c32a8] dark:text-[#d5c8ff] whitespace-nowrap">
                  {def.symbol} {def.label}
                </span>
                <input
                  type="number"
                  min={0}
                  aria-label={`Plate ${plate.plateNumber} charm ${def.label} quantity`}
                  value={qty}
                  onChange={(e) => onAdjustCharm(plate.tempId, def.id, e.target.value)}
                  className="w-12 text-right text-xs font-mono-data font-bold bg-transparent text-neutral-900 dark:text-white focus:outline-none"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Manual Add Letter / Add Charm Controls + Bambu Studio Fit Checkbox */}
      <div className="space-y-2 pt-2 border-t border-neutral-200/70 dark:border-neutral-800">
        <div className="flex flex-wrap items-center gap-1.5">
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
            disabled={count >= plate.capacity}
            onClick={() => onAddLetter(plate.tempId, letterToAdd)}
            className="px-2 py-1 text-xs rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-[#1a1828] hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40 whitespace-nowrap"
          >
            + Letter
          </button>

          <select
            aria-label="Select charm to add to plate"
            value={charmToAdd}
            onChange={(e) => setCharmToAdd(e.target.value as CharmId)}
            className="px-2 py-1 rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-[#1a1828] text-xs"
          >
            {CHARM_DEFINITIONS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.symbol} {c.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={count >= plate.capacity}
            onClick={() => onAddCharm(plate.tempId, charmToAdd)}
            className="px-2 py-1 text-xs rounded border border-[#dfd7fb] dark:border-[#3e3366] bg-[#faf8ff] dark:bg-[#221c38] text-[#4c32a8] dark:text-[#d5c8ff] disabled:opacity-40 whitespace-nowrap"
          >
            + Charm
          </button>
        </div>

        <label className="flex items-center gap-1.5 text-[11px] text-neutral-600 dark:text-neutral-400 cursor-pointer">
          <input
            type="checkbox"
            checked={plate.slicerVerified}
            onChange={() => onToggleVerified(plate.tempId)}
          />
          <span>Physical bed fit verified in Bambu Studio</span>
        </label>
      </div>
    </div>
  );
};

