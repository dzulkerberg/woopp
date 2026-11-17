import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, RotateCcw, Store } from 'lucide-react';
import {
  ABC,
  CHARM_BY_ID,
  CHARM_DEFINITIONS,
  CHARM_IDS,
  compactCharmsMap,
  compactLettersMap,
  countCatalogItems,
  countCharms,
  countLetters,
  countPlateKeycaps,
  DEFAULT_PLATE_CAPACITY,
  emptyAlphabetMap,
  emptyCharmsMap,
  normalizeAlphabetMap,
  sumAlphabetMaps,
  sumCharmsMaps,
} from '../constants';
import {
  AlphabetPreset,
  CatalogProduct,
  CategoryPlateSetting,
  CharmId,
  CharmsMap,
  ColorOption,
  LettersMap,
  PlannerPreselection,
  PlateGenerationMode,
  ProductCategory,
  ProductionWorkspaceV5,
} from '../types';
import {
  createZeroedPlannerInputs,
  DraftCatalogPlatePreview,
  generateIndependentKeycapBatchPreviews,
  validateBuiltInPlateCategoryIsolation,
} from '../utils/catalogPlannerEngine';
import {
  computeColorPlanningState,
  DraftPlatePreview,
  inferPlateMode,
} from '../utils/productionEngine';
import { CatalogCategoryPlannerSection } from './CatalogCategoryPlannerSection';
import { DurationHMInput } from './DurationHMInput';

type PlannerWorkflowId = 'builtin:alphabet' | 'builtin:charm' | `catalog:${string}`;

export type BuiltInStagedPlate = DraftPlatePreview & {
  colorId?: string | null;
};

export interface AutoPlannerViewProps {
  workspace: ProductionWorkspaceV5;
  selectedProjectId: string;
  onSelectProject: (projectId: string) => void;
  onSavePreset: (preset: AlphabetPreset) => void;
  onDeletePreset: (presetId: string) => void;
  onCommitGeneratedPlates: (params: {
    projectId: string;
    colorId?: string;
    plateCapacity: number;
    mode: PlateGenerationMode;
    targetLetters: LettersMap;
    targetCharms: CharmsMap;
    carryForwardLetters: LettersMap;
    carryForwardCharms: CharmsMap;
    confirmedPlates: BuiltInStagedPlate[];
    preserveQueuedPlates?: boolean;
    onSuccess?: () => void;
  }) => Promise<void> | void;
  onClearCarryForward?: (params: {
    projectId: string;
    colorId: string;
    mode: PlateGenerationMode;
    trimTargetRemainder: boolean;
  }) => void;
  categories?: readonly ProductCategory[];
  products?: readonly CatalogProduct[];
  plateSettingsByCategoryId?: Record<string, CategoryPlateSetting>;
  plannerPreselection?: PlannerPreselection | null;
  onConsumePreselection?: () => void;
  onSaveCategoryPlateSetting?: (
    setting: Omit<CategoryPlateSetting, 'ownerId' | 'updatedAt'>
  ) => Promise<void>;
  onCommitCatalogPlates?: (params: {
    projectId: string;
    colorId?: string | null;
    category: ProductCategory;
    confirmedPlates: DraftCatalogPlatePreview[];
    onSuccess?: () => void;
  }) => Promise<void> | void;
  onOpenProductStudio?: () => void;
  onAlert: (msg: string, title?: string) => void;
}

export const AutoPlannerView: React.FC<AutoPlannerViewProps> = ({
  workspace,
  selectedProjectId,
  onSelectProject,
  onSavePreset,
  onDeletePreset,
  onCommitGeneratedPlates,
  onClearCarryForward,
  categories = [],
  products = [],
  plateSettingsByCategoryId = {},
  plannerPreselection = null,
  onConsumePreselection,
  onSaveCategoryPlateSetting,
  onCommitCatalogPlates,
  onOpenProductStudio,
  onAlert,
}) => {
  const activeProjects = workspace.projects.filter((p) => p.status !== 'Archived');
  const currentProject =
    activeProjects.find((p) => p.id === selectedProjectId) || activeProjects[0] || null;

  const activeCatalogCategories = useMemo(
    () =>
      [...categories]
        .filter((c) => c.status === 'active')
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    [categories]
  );

  const [plateCapacity, setPlateCapacity] = useState<number>(
    currentProject?.plateCapacity || DEFAULT_PLATE_CAPACITY
  );
  const [defaultPlateMinutes, setDefaultPlateMinutes] = useState<number>(195); // 3h 15m Bambu Studio default
  const [selectedWorkflow, setSelectedWorkflow] = useState<PlannerWorkflowId>(() => {
    if (plannerPreselection?.categoryId) {
      return `catalog:${plannerPreselection.categoryId}`;
    }
    if (activeCatalogCategories.length > 0) {
      return `catalog:${activeCatalogCategories[0].id}`;
    }
    return 'builtin:alphabet';
  });
  const hasUserSelectedWorkflowRef = useRef<boolean>(Boolean(plannerPreselection?.categoryId));

  // If catalog categories hydrate after initial render and user hasn't picked a workflow yet,
  // default cleanly to the first active Product Studio category.
  useEffect(() => {
    if (hasUserSelectedWorkflowRef.current || plannerPreselection) return;
    if (activeCatalogCategories.length > 0 && !selectedWorkflow.startsWith('catalog:')) {
      setSelectedWorkflow(`catalog:${activeCatalogCategories[0].id}`);
    }
  }, [activeCatalogCategories, plannerPreselection, selectedWorkflow]);

  // Independent editable batch inputs (default to 0; never force completed counts as locked minimums)
  const [draftLetters, setDraftLetters] = useState<LettersMap>(() => emptyAlphabetMap());
  const [draftCharms, setDraftCharms] = useState<Record<CharmId, number>>(() =>
    emptyCharmsMap()
  );
  const [draftCatalogQuantities, setDraftCatalogQuantities] = useState<
    Record<string, number>
  >({});
  const [highlightedProductId, setHighlightedProductId] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState<number>(0);
  const [carryIncludedColorId, setCarryIncludedColorId] = useState<string | null>(null);

  const [presetName, setPresetName] = useState<string>('');
  const [selectedPresetId, setSelectedPresetId] = useState<string>('');

  // Staging area for manual adjustment & per-plate filament color before confirming Built-in plates
  const [stagedPlates, setStagedPlates] = useState<BuiltInStagedPlate[] | null>(null);
  const [remainderMode, setRemainderMode] = useState<'carry_forward' | 'partial_plate'>(
    'carry_forward'
  );
  const [hasAttemptedBuiltInConfirm, setHasAttemptedBuiltInConfirm] = useState<boolean>(false);
  const [isBuiltInConfirming, setIsBuiltInConfirming] = useState<boolean>(false);

  const prevProjectIdRef = useRef<string>('');

  // Handle incoming `Send to Print Planner` preselection from Product Studio
  useEffect(() => {
    if (!plannerPreselection) return;
    hasUserSelectedWorkflowRef.current = true;
    setSelectedWorkflow(`catalog:${plannerPreselection.categoryId}`);
    setHighlightedProductId(plannerPreselection.productId || null);
    setStagedPlates(null);
    setHasAttemptedBuiltInConfirm(false);
    onConsumePreselection?.();
  }, [plannerPreselection, onConsumePreselection]);

  // Synchronize default plate capacity when project switches (no top-level filament color state)
  useEffect(() => {
    if (!currentProject) return;
    if (prevProjectIdRef.current !== currentProject.id) {
      prevProjectIdRef.current = currentProject.id;
      setPlateCapacity(currentProject.plateCapacity || DEFAULT_PLATE_CAPACITY);
      setCarryIncludedColorId(null);
      setStagedPlates(null);
      setHasAttemptedBuiltInConfirm(false);
    }
  }, [currentProject]);

  // Project-wide production & queue metrics across all colors (project-scoped, never color-0 biased)
  const projectSummaryMetrics = useMemo(() => {
    if (!currentProject) return null;
    const projectJobs = workspace.jobs.filter(
      (j) => j.projectId === currentProject.id && !j.archived && j.stage !== 'Cancelled'
    );
    let completedTotal = 0;
    let completedPlatesCount = 0;
    let activePlatesTotal = 0;
    let queuedPlatesCount = 0;
    let printingPlatesCount = 0;

    for (const j of projectJobs) {
      const units =
        j.catalogItems && j.catalogItems.length > 0
          ? countCatalogItems(j.catalogItems)
          : countPlateKeycaps(j);
      if (j.stage === 'Completed') {
        completedTotal += units;
        completedPlatesCount += 1;
      } else if (j.stage === 'Ready to Print' || j.stage === 'Planned') {
        activePlatesTotal += units;
        queuedPlatesCount += 1;
      } else if (j.stage === 'Printing') {
        activePlatesTotal += units;
        printingPlatesCount += 1;
      }
    }

    return {
      completedTotal,
      completedPlatesCount,
      activePlatesTotal,
      queuedPlatesCount,
      printingPlatesCount,
    };
  }, [workspace.jobs, currentProject]);

  const isCatalogWorkflow = selectedWorkflow.startsWith('catalog:');
  const selectedCatalogCategoryId = isCatalogWorkflow
    ? selectedWorkflow.slice('catalog:'.length)
    : null;
  const selectedCatalogCategory = useMemo(
    () =>
      selectedCatalogCategoryId
        ? categories.find((c) => c.id === selectedCatalogCategoryId) || null
        : null,
    [categories, selectedCatalogCategoryId]
  );

  const builtInMode: 'alphabet_only' | 'charm_only' =
    selectedWorkflow === 'builtin:charm' ? 'charm_only' : 'alphabet_only';

  // Per-color carry-forward entries for active Built-in mode (only shown when > 0)
  const builtInCarryForwardEntries = useMemo(() => {
    if (!currentProject || isCatalogWorkflow) return [];
    const list: {
      color: ColorOption;
      count: number;
      letters: LettersMap;
      charms: CharmsMap;
    }[] = [];

    for (const c of workspace.colors) {
      const st = computeColorPlanningState(workspace.jobs, currentProject, c.id);
      const count =
        builtInMode === 'alphabet_only'
          ? st.carryForwardLettersCount
          : st.carryForwardCharmsCount;
      if (count > 0) {
        list.push({
          color: c,
          count,
          letters: st.carryForwardLetters,
          charms: st.carryForwardCharms,
        });
      }
    }
    return list;
  }, [currentProject, isCatalogWorkflow, workspace.colors, workspace.jobs, builtInMode]);

  const carryForwardTotal = useMemo(
    () => builtInCarryForwardEntries.reduce((sum, e) => sum + e.count, 0),
    [builtInCarryForwardEntries]
  );

  const batchPreview = useMemo(() => {
    if (!currentProject || isCatalogWorkflow) return null;
    return generateIndependentKeycapBatchPreviews({
      existingJobs: workspace.jobs,
      projectId: currentProject.id,
      mode: builtInMode,
      batchLetters: draftLetters,
      batchCharms: draftCharms,
      capacity: plateCapacity,
      defaultMinutesPerPlate: defaultPlateMinutes,
    });
  }, [
    currentProject,
    isCatalogWorkflow,
    workspace.jobs,
    builtInMode,
    draftLetters,
    draftCharms,
    plateCapacity,
    defaultPlateMinutes,
  ]);

  if (!currentProject || !projectSummaryMetrics) {
    return (
      <div className="bg-surface border border-line rounded-xl p-8 text-center">
        <p className="text-sm text-ink-secondary">
          Create or unarchive a project first to plan production plates.
        </p>
      </div>
    );
  }

  // Reset ONLY editable planner inputs to 0 without affecting completed production or Print Queue
  const handleResetPlannerInputs = () => {
    const zeroed = createZeroedPlannerInputs();
    setDraftLetters(zeroed.draftLetters);
    setDraftCharms(zeroed.draftCharms);
    setDraftCatalogQuantities(zeroed.draftCatalogQuantities);
    setCarryIncludedColorId(null);
    setHighlightedProductId(null);
    setStagedPlates(null);
    setHasAttemptedBuiltInConfirm(false);
    setResetSignal((n) => n + 1);
  };

  const handleSetLetterQty = (letter: string, rawVal: string) => {
    const val = Math.max(0, Math.floor(Number(rawVal) || 0));
    setDraftLetters((prev) => ({ ...prev, [letter]: val }));
    setStagedPlates(null);
    setHasAttemptedBuiltInConfirm(false);
  };

  const handleSetCharmQty = (charmId: CharmId, nextVal: number) => {
    const safeVal = Math.max(0, Math.floor(Number.isFinite(nextVal) ? nextVal : 0));
    setDraftCharms((prev) => ({ ...prev, [charmId]: safeVal }));
    setStagedPlates(null);
    setHasAttemptedBuiltInConfirm(false);
  };

  const handleChangeCatalogQuantity = (selectionKey: string, nextQty: number) => {
    const safeVal = Math.max(0, Math.floor(Number.isFinite(nextQty) ? nextQty : 0));
    setDraftCatalogQuantities((prev) => {
      const next = { ...prev };
      if (safeVal <= 0) {
        delete next[selectionKey];
      } else {
        next[selectionKey] = safeVal;
      }
      return next;
    });
  };

  const handleIncludeCarryForward = (entry: {
    color: ColorOption;
    count: number;
    letters: LettersMap;
    charms: CharmsMap;
  }) => {
    if (entry.count === 0 || carryIncludedColorId === entry.color.id) return;
    if (builtInMode === 'alphabet_only') {
      setDraftLetters((prev) => sumAlphabetMaps([prev, entry.letters]));
    } else {
      setDraftCharms((prev) =>
        Object.assign(emptyCharmsMap(), sumCharmsMaps([prev, entry.charms]))
      );
    }
    setCarryIncludedColorId(entry.color.id);
    setStagedPlates(null);
    setHasAttemptedBuiltInConfirm(false);
  };

  const handleApplyPreset = () => {
    const preset = workspace.presets.find((p) => p.id === selectedPresetId);
    if (!preset) return;
    hasUserSelectedWorkflowRef.current = true;
    setSelectedWorkflow('builtin:alphabet');
    setDraftLetters(normalizeAlphabetMap(preset.letters));
    if (preset.plateCapacity > 0) {
      setPlateCapacity(preset.plateCapacity);
    }
    setStagedPlates(null);
    setHasAttemptedBuiltInConfirm(false);
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
    if (!batchPreview) return;
    if (batchPreview.totalRequestedCount <= 0) {
      onAlert(
        `Enter at least 1 ${
          builtInMode === 'alphabet_only' ? 'Alphabet A–Z' : 'Charm'
        } keycap quantity to generate print plates.`
      );
      return;
    }

    setRemainderMode(mode);
    const previewList: BuiltInStagedPlate[] = batchPreview.fullPlates.map((p) => ({
      ...p,
      letters: { ...p.letters },
      charms: { ...p.charms },
      colorId: null, // Always start unassigned ("Select Filament Color")
    }));

    if (mode === 'partial_plate' && batchPreview.remainderCount > 0) {
      const usedNums = new Set<number>(previewList.map((p) => p.plateNumber));
      workspace.jobs
        .filter((j) => j.projectId === currentProject.id)
        .forEach((j) => {
          if (!j.archived && j.stage !== 'Cancelled') {
            usedNums.add(j.plateNumber);
          }
        });

      let partialNum = 1;
      while (usedNums.has(partialNum)) {
        partialNum += 1;
      }

      const remLetters = { ...batchPreview.remainderLetters };
      const remCharms = { ...batchPreview.remainderCharms };
      const freeCap = Math.max(0, plateCapacity - batchPreview.remainderCount);

      previewList.push({
        tempId: `draft-partial-${Date.now()}`,
        plateNumber: partialNum,
        capacity: plateCapacity,
        letters: remLetters,
        charms: remCharms,
        plateMode: inferPlateMode(remLetters, remCharms),
        estimatedMinutes: Math.max(
          15,
          Math.round((batchPreview.remainderCount / plateCapacity) * defaultPlateMinutes)
        ),
        slicerVerified: false,
        notes: `Incomplete plate (${batchPreview.remainderCount}/${plateCapacity} pcs · ${freeCap} pcs remaining capacity)`,
        colorId: null, // Unassigned until operator selects per plate
      });
    }

    // Validate strict single-category plate isolation at preview generation
    for (const plate of previewList) {
      const isoCheck = validateBuiltInPlateCategoryIsolation(plate, builtInMode);
      if (!isoCheck.valid) {
        onAlert(
          isoCheck.error || 'Cannot mix different categories on a single plate.',
          'Category Mixing Blocked'
        );
        return;
      }
    }

    setHasAttemptedBuiltInConfirm(false);
    if (previewList.length === 0 && mode === 'carry_forward') {
      setStagedPlates([]);
      return;
    }

    setStagedPlates(previewList);
  };

  const handleAssignBuiltInPlateColor = (tempId: string, colorIdRaw: string) => {
    const trimmed = colorIdRaw.trim();
    const matched = trimmed ? workspace.colors.find((c) => c.id === trimmed) : null;
    setStagedPlates((prev) =>
      prev
        ? prev.map((p) =>
            p.tempId === tempId ? { ...p, colorId: matched ? matched.id : null } : p
          )
        : null
    );
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
          plateMode: 'alphabet_only',
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
          plateMode: 'charm_only',
        };
      })
    );
  };

  const handleAddLetterToStagedPlate = (tempId: string, letter: string) => {
    if (!stagedPlates || !ABC.includes(letter) || builtInMode !== 'alphabet_only') return;
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
          plateMode: 'alphabet_only',
        };
      })
    );
  };

  const handleAddCharmToStagedPlate = (tempId: string, charmId: CharmId) => {
    if (!stagedPlates || !CHARM_IDS.includes(charmId) || builtInMode !== 'charm_only') return;
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
          plateMode: 'charm_only',
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

  const getBuiltInPlateErrors = (plate: BuiltInStagedPlate): string[] => {
    const errors: string[] = [];
    const qty = countPlateKeycaps(plate);
    if (qty <= 0) {
      errors.push(`Plate ${plate.plateNumber} has 0 keycaps.`);
    }
    if (qty > plate.capacity) {
      errors.push(
        `Capacity exceeded (${qty} / ${plate.capacity} pcs).`
      );
    }
    const isoCheck = validateBuiltInPlateCategoryIsolation(plate, builtInMode);
    if (!isoCheck.valid && isoCheck.error) {
      errors.push(isoCheck.error);
    }
    if (!plate.colorId || !workspace.colors.some((c) => c.id === plate.colorId)) {
      errors.push('Select a physical Filament Color for this plate.');
    }
    return errors;
  };

  const invalidBuiltInPlateNumbers =
    stagedPlates
      ?.filter((p) => getBuiltInPlateErrors(p).length > 0)
      .map((p) => p.plateNumber) || [];

  const handleConfirmAndSavePlates = async () => {
    if (!stagedPlates || !batchPreview || isBuiltInConfirming) return;

    setHasAttemptedBuiltInConfirm(true);

    if (stagedPlates.length === 0) {
      onAlert(
        'Generate at least 1 plate before confirming to Print Queue.',
        'No Plates to Confirm'
      );
      return;
    }

    if (invalidBuiltInPlateNumbers.length > 0) {
      return;
    }

    const fallbackCarryColorId =
      carryIncludedColorId || stagedPlates[0]?.colorId || workspace.colors[0]?.id;

    const firstColorState = fallbackCarryColorId
      ? computeColorPlanningState(workspace.jobs, currentProject, fallbackCarryColorId)
      : null;

    const baseCarryLetters = carryIncludedColorId
      ? emptyAlphabetMap()
      : firstColorState?.carryForwardLetters || emptyAlphabetMap();
    const baseCarryCharms: CharmsMap = carryIncludedColorId
      ? {}
      : firstColorState?.carryForwardCharms || {};

    const carryForwardLettersToSave =
      builtInMode === 'alphabet_only'
        ? remainderMode === 'carry_forward'
          ? compactLettersMap(
              sumAlphabetMaps([baseCarryLetters, batchPreview.remainderLetters])
            )
          : compactLettersMap(baseCarryLetters)
        : compactLettersMap(firstColorState?.carryForwardLetters || {});

    const carryForwardCharmsToSave =
      builtInMode === 'charm_only'
        ? remainderMode === 'carry_forward'
          ? compactCharmsMap(
              sumCharmsMaps([baseCarryCharms, batchPreview.remainderCharms])
            )
          : compactCharmsMap(baseCarryCharms)
        : compactCharmsMap(firstColorState?.carryForwardCharms || {});

    const stagedLettersSum = sumAlphabetMaps(stagedPlates.map((p) => p.letters));
    const stagedCharmsSum = sumCharmsMaps(stagedPlates.map((p) => p.charms));

    const committedTargetLetters =
      builtInMode === 'charm_only'
        ? compactLettersMap(
            sumAlphabetMaps([
              firstColorState?.validAllocatedLetters || {},
              carryForwardLettersToSave,
            ])
          )
        : compactLettersMap(
            sumAlphabetMaps([
              firstColorState?.validAllocatedLetters || {},
              stagedLettersSum,
              carryForwardLettersToSave,
            ])
          );

    const committedTargetCharms =
      builtInMode === 'alphabet_only'
        ? compactCharmsMap(
            sumCharmsMaps([
              firstColorState?.validAllocatedCharms || {},
              carryForwardCharmsToSave,
            ])
          )
        : compactCharmsMap(
            sumCharmsMaps([
              firstColorState?.validAllocatedCharms || {},
              stagedCharmsSum,
              carryForwardCharmsToSave,
            ])
          );

    setIsBuiltInConfirming(true);
    try {
      await Promise.resolve(
        onCommitGeneratedPlates({
          projectId: currentProject.id,
          colorId:
            stagedPlates.length === 1 && stagedPlates[0].colorId
              ? stagedPlates[0].colorId
              : undefined,
          plateCapacity,
          mode: builtInMode,
          targetLetters: committedTargetLetters,
          targetCharms: committedTargetCharms,
          carryForwardLetters: carryForwardLettersToSave,
          carryForwardCharms: carryForwardCharmsToSave,
          confirmedPlates: stagedPlates,
          preserveQueuedPlates: true,
          onSuccess: () => {
            if (builtInMode === 'alphabet_only') {
              setDraftLetters(emptyAlphabetMap());
            } else {
              setDraftCharms(emptyCharmsMap());
            }
            setCarryIncludedColorId(null);
            setStagedPlates(null);
            setHasAttemptedBuiltInConfirm(false);
          },
        })
      );
    } finally {
      setIsBuiltInConfirming(false);
    }
  };

  const totalAlphabetRequested = countLetters(draftLetters);
  const totalCharmsRequested = countCharms(draftCharms);
  const totalCatalogRequested = Object.values(draftCatalogQuantities).reduce(
    (sum, v) => sum + Math.max(0, Math.floor(Number(v || 0))),
    0
  );

  const currentPlannerInputDisplay = isCatalogWorkflow
    ? totalCatalogRequested
    : builtInMode === 'alphabet_only'
    ? totalAlphabetRequested
    : totalCharmsRequested;

  const remainderSummaryParts: string[] = [];
  if (batchPreview) {
    for (const [k, v] of Object.entries(batchPreview.remainderLetters)) {
      if (v > 0) remainderSummaryParts.push(`${k}×${v}`);
    }
    for (const def of CHARM_DEFINITIONS) {
      const v = batchPreview.remainderCharms[def.id] || 0;
      if (v > 0) remainderSummaryParts.push(`${def.symbol} ${def.label}×${v}`);
    }
  }

  return (
    <div className="space-y-6">
      {/* Top Context Selector: Project + Reset ONLY (no top-level Filament Color, no duplicate Category selector) */}
      <section className="bg-surface border border-line rounded-xl p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-line">
          <div>
            <h2 className="text-sm font-semibold text-ink">
              Production Batch Context
            </h2>
            <p className="text-xs text-muted mt-0.5">
              Select target project. Physical Filament Color is selected individually for each generated plate in Preview.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {onOpenProductStudio && (
              <button
                type="button"
                onClick={onOpenProductStudio}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-line bg-elevated hover:bg-recessed text-xs font-medium text-ink whitespace-nowrap transition-colors"
              >
                <Store className="w-3.5 h-3.5 text-brand-text" />
                <span>Product Studio</span>
              </button>
            )}
            <button
              type="button"
              onClick={handleResetPlannerInputs}
              title="Reset current planner quantity inputs to 0 without affecting completed production or Print Queue"
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-line bg-elevated hover:bg-recessed text-xs font-semibold text-ink whitespace-nowrap transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5 text-ink-secondary" />
              <span>Reset</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <div>
            <label
              htmlFor="planner-project-select"
              className="block text-xs font-semibold text-ink-secondary mb-1"
            >
              Target Project
            </label>
            <select
              id="planner-project-select"
              value={currentProject.id}
              onChange={(e) => onSelectProject(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-line bg-input text-sm text-ink focus:border-brand focus:outline-none"
            >
              {activeProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.salesChannel})
                </option>
              ))}
            </select>
          </div>

          {!isCatalogWorkflow && (
            <>
              <div>
                <label className="block text-xs font-semibold text-ink-secondary mb-1">
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
                      setPlateCapacity(
                        Math.max(1, Math.floor(Number(e.target.value) || 138))
                      );
                      setStagedPlates(null);
                      setHasAttemptedBuiltInConfirm(false);
                    }}
                    className="w-20 px-2.5 py-1.5 rounded-lg border border-line bg-input text-xs text-ink font-mono-data focus:border-brand focus:outline-none"
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
                <label className="block text-xs font-semibold text-ink-secondary mb-1">
                  Load Alphabet Preset
                </label>
                <div className="flex gap-2">
                  <select
                    value={selectedPresetId}
                    onChange={(e) => setSelectedPresetId(e.target.value)}
                    className="flex-1 min-w-0 px-2.5 py-2 rounded-lg border border-line bg-input text-xs text-ink focus:border-brand focus:outline-none"
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
                    className="px-3 py-2 text-xs font-semibold rounded-lg border border-line bg-elevated text-ink hover:bg-recessed disabled:opacity-40 whitespace-nowrap transition-colors"
                  >
                    Apply
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        {/* 4-Metric Project-Wide Production & Queue Status Breakdown */}
        <div className="rounded-xl border border-line bg-recessed grid grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-line">
          <div className="p-3">
            <div className="text-[11px] font-medium text-muted">
              Current Planner Input
            </div>
            <div className="text-sm font-bold font-mono-data text-ink mt-0.5">
              {currentPlannerInputDisplay.toLocaleString()} pcs
            </div>
            <div className="text-[11px] text-muted mt-0.5">
              New batch quantity to plate
            </div>
          </div>

          <div className="p-3">
            <div className="text-[11px] font-medium text-muted">
              Completed Production
            </div>
            <div className="text-sm font-bold font-mono-data text-brand-text mt-0.5">
              {projectSummaryMetrics.completedTotal.toLocaleString()} pcs
            </div>
            <div className="text-[11px] font-mono-data text-muted mt-0.5">
              {projectSummaryMetrics.completedPlatesCount} completed plate(s)
            </div>
          </div>

          <div className="p-3">
            <div className="text-[11px] font-medium text-muted">
              Generated Active Plates
            </div>
            <div className="text-sm font-bold font-mono-data text-ink mt-0.5">
              {projectSummaryMetrics.activePlatesTotal.toLocaleString()} pcs
            </div>
            <div className="text-[11px] font-mono-data text-muted mt-0.5">
              {projectSummaryMetrics.queuedPlatesCount} queued ·{' '}
              {projectSummaryMetrics.printingPlatesCount} printing
            </div>
          </div>

          <div className="p-3">
            <div className="text-[11px] font-medium text-muted">
              Session Carry-Forward
            </div>
            <div
              className={`text-sm font-bold font-mono-data mt-0.5 ${
                carryForwardTotal > 0 ? 'text-warning-text' : 'text-ink'
              }`}
            >
              {carryForwardTotal.toLocaleString()} pcs
            </div>
            <div className="text-[11px] text-muted mt-0.5">
              {carryForwardTotal > 0
                ? 'Active incomplete-plate remainder'
                : 'No unplated remainder'}
            </div>
          </div>
        </div>

        {/* Carry-Forward Controls for Built-in Workflows (hidden completely when 0) */}
        {!isCatalogWorkflow && builtInCarryForwardEntries.length > 0 && (
          <div className="p-3.5 rounded-xl bg-warning-soft border border-warning-border text-xs text-warning-text space-y-2">
            {builtInCarryForwardEntries.map((entry) => (
              <div
                key={entry.color.id}
                className="flex flex-wrap items-center justify-between gap-2.5"
              >
                <span className="inline-flex items-center gap-1.5 font-medium">
                  <span
                    className="w-2.5 h-2.5 rounded-full border border-line shrink-0"
                    style={{ backgroundColor: entry.color.hex }}
                  />
                  <span>
                    {entry.color.name}: {entry.count} pcs carry-forward remainder
                  </span>
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  {carryIncludedColorId !== entry.color.id ? (
                    <button
                      type="button"
                      onClick={() => handleIncludeCarryForward(entry)}
                      className="px-3 py-1.5 rounded-lg bg-brand hover:bg-brand-hover text-white font-semibold whitespace-nowrap transition-colors"
                    >
                      + Merge Carry-Forward ({entry.count} pcs)
                    </button>
                  ) : (
                    <span className="px-2.5 py-1 rounded-lg bg-surface border border-warning-border text-[11px] font-medium text-warning-text whitespace-nowrap">
                      Merged into current batch
                    </span>
                  )}
                  {onClearCarryForward && (
                    <button
                      type="button"
                      onClick={() =>
                        onClearCarryForward({
                          projectId: currentProject.id,
                          colorId: entry.color.id,
                          mode: builtInMode,
                          trimTargetRemainder: true,
                        })
                      }
                      className="px-2.5 py-1.5 rounded-lg border border-warning-border bg-surface text-warning-text hover:bg-elevated font-medium whitespace-nowrap transition-colors"
                    >
                      Dismiss Carry-Forward
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Dynamic Product Studio Category Planner (contains the SINGLE authoritative #planner-category-select) */}
      {isCatalogWorkflow && selectedCatalogCategory && (
        <CatalogCategoryPlannerSection
          category={selectedCatalogCategory}
          categoryProducts={products}
          plateSetting={plateSettingsByCategoryId[selectedCatalogCategory.id] || null}
          currentProject={currentProject}
          workspaceColors={workspace.colors}
          existingJobs={workspace.jobs}
          quantitiesByKey={draftCatalogQuantities}
          highlightedProductId={highlightedProductId}
          allCategories={activeCatalogCategories}
          selectedWorkflowValue={selectedWorkflow}
          onSelectWorkflow={(workflowVal) => {
            hasUserSelectedWorkflowRef.current = true;
            setSelectedWorkflow(workflowVal as PlannerWorkflowId);
            setCarryIncludedColorId(null);
            setStagedPlates(null);
            setHasAttemptedBuiltInConfirm(false);
          }}
          onSelectCategory={(catId) => {
            hasUserSelectedWorkflowRef.current = true;
            setSelectedWorkflow(`catalog:${catId}`);
            setStagedPlates(null);
          }}
          onChangeQuantity={handleChangeCatalogQuantity}
          onSaveCategoryPlateSetting={
            onSaveCategoryPlateSetting || (async () => undefined)
          }
          onConfirmCatalogPlates={(category, confirmedPlates, onSuccess) =>
            onCommitCatalogPlates?.({
              projectId: currentProject.id,
              category,
              confirmedPlates,
              onSuccess: () => {
                onSuccess();
                // Clear planned quantities for this category after successful queue commit
                const catProductIds = new Set(
                  products
                    .filter((p) => p.categoryId === category.id)
                    .map((p) => p.id)
                );
                setDraftCatalogQuantities((prev) => {
                  const next: Record<string, number> = {};
                  for (const [key, val] of Object.entries(prev)) {
                    const pid = key.includes(':::')
                      ? key.split(':::')[0]
                      : key.split('::')[0];
                    if (!catProductIds.has(pid)) {
                      next[key] = val;
                    }
                  }
                  return next;
                });
              },
            })
          }
          onOpenProductStudio={onOpenProductStudio || (() => undefined)}
          onAlert={onAlert}
          resetSignal={resetSignal}
        />
      )}

      {/* Single Authoritative Category Selector when Built-in or missing Catalog Category */}
      {(!isCatalogWorkflow || !selectedCatalogCategory) && (
        <section className="bg-surface border border-line rounded-xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-line">
            <div>
              <h2 className="text-sm font-semibold text-ink">
                Auto Plate Planner · Product &amp; Option Selection
              </h2>
              <p className="text-xs text-muted mt-0.5">
                Select a category, enter variation quantities, then assign a physical Filament Color to each generated plate in Preview. <b className="text-ink">ONE PLATE = ONE PRODUCT + ONE FILAMENT COLOR</b>.
              </p>
            </div>
            {onOpenProductStudio && (
              <button
                type="button"
                onClick={onOpenProductStudio}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-line bg-elevated hover:bg-recessed text-xs font-medium text-ink transition-colors"
              >
                <Store className="w-3.5 h-3.5 text-brand-text" />
                <span>Product Studio</span>
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="planner-category-select"
                className="block text-xs font-semibold text-ink-secondary mb-1"
              >
                1. Category
              </label>
              <select
                id="planner-category-select"
                value={selectedWorkflow}
                onChange={(e) => {
                  hasUserSelectedWorkflowRef.current = true;
                  setSelectedWorkflow(e.target.value as PlannerWorkflowId);
                  setCarryIncludedColorId(null);
                  setStagedPlates(null);
                  setHasAttemptedBuiltInConfirm(false);
                }}
                className="w-full px-3 py-2 rounded-lg border border-line bg-input text-sm text-ink focus:border-brand focus:outline-none"
              >
                {activeCatalogCategories.length > 0 && (
                  <optgroup label="Product Studio Categories">
                    {activeCatalogCategories.map((c) => {
                      const count = products.filter(
                        (p) => p.categoryId === c.id && p.status === 'active'
                      ).length;
                      return (
                        <option key={c.id} value={`catalog:${c.id}`}>
                          {c.name} ({count} active {count === 1 ? 'product' : 'products'})
                        </option>
                      );
                    })}
                  </optgroup>
                )}
                <optgroup label="Built-in Keycap Workflows">
                  <option value="builtin:alphabet">Alphabet Keycaps (A–Z)</option>
                  <option value="builtin:charm">Charm Keycaps (♥ ★ ✿ # @)</option>
                </optgroup>
              </select>
            </div>
          </div>

          {isCatalogWorkflow && !selectedCatalogCategory && (
            <div className="p-4 rounded-xl bg-recessed border border-line text-center space-y-2.5">
              <p className="text-xs text-ink-secondary">
                The selected Product Studio category was not found. Choose another category above or open Product Studio.
              </p>
              {onOpenProductStudio && (
                <button
                  type="button"
                  onClick={onOpenProductStudio}
                  className="px-4 py-2 rounded-lg bg-brand hover:bg-brand-hover text-xs font-semibold text-white transition-colors"
                >
                  Open Product Studio
                </button>
              )}
            </div>
          )}
        </section>
      )}

      {/* Built-in Category 1: Alphabet Keycaps A–Z */}
      {!isCatalogWorkflow && builtInMode === 'alphabet_only' && (
        <section className="bg-surface border border-line rounded-xl p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-ink">
                  Alphabet A–Z Batch Quantities
                </h2>
                <span className="text-xs font-mono-data text-brand-text font-semibold">
                  · {totalAlphabetRequested} pcs
                </span>
              </div>
              <p className="text-xs text-muted mt-0.5">
                Enter new keycap quantities first, then select the Filament Color for each generated plate in Preview. Completed and queued plates remain untouched.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-4 sm:grid-cols-7 md:grid-cols-9 lg:grid-cols-13 gap-2.5">
            {ABC.map((letter) => {
              const currentVal = draftLetters[letter] ?? 0;
              return (
                <div
                  key={letter}
                  className={`p-2 rounded-xl border ${
                    currentVal > 0
                      ? 'border-brand-border bg-brand-soft'
                      : 'border-line bg-elevated'
                  }`}
                >
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="font-bold text-ink">{letter}</span>
                  </div>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    aria-label={`Quantity for letter ${letter}`}
                    value={currentVal}
                    onChange={(e) => handleSetLetterQty(letter, e.target.value)}
                    className="w-full px-1.5 py-1.5 text-center rounded-lg border border-line bg-input text-xs font-mono-data text-ink focus:border-brand focus:outline-none"
                  />
                </div>
              );
            })}
          </div>

          {/* Save Reusable Alphabet Preset Bar */}
          <div className="pt-4 border-t border-line flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-2 flex-1 max-w-md">
              <input
                placeholder="Save current A–Z grid as reusable preset..."
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                maxLength={80}
                className="flex-1 min-w-[200px] px-3 py-1.5 rounded-lg border border-line bg-input text-xs text-ink focus:border-brand focus:outline-none"
              />
              <button
                type="button"
                onClick={handleSaveNewPreset}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-line bg-elevated text-ink hover:bg-recessed whitespace-nowrap transition-colors"
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
                  className="px-2.5 py-1.5 text-xs text-error-text hover:underline whitespace-nowrap"
                >
                  Delete Preset
                </button>
              )}
            </div>
            <div className="text-xs font-mono-data text-muted">
              New Batch Subtotal: <b className="text-ink">{totalAlphabetRequested}</b> pcs
            </div>
          </div>
        </section>
      )}

      {/* Built-in Category 2: Charm Keycaps */}
      {!isCatalogWorkflow && builtInMode === 'charm_only' && (
        <section className="bg-surface border border-line rounded-xl p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-ink">
                  Charm Keycaps Batch Quantities
                </h2>
                <span className="text-xs font-mono-data text-brand-text font-semibold">
                  · {totalCharmsRequested} pcs
                </span>
              </div>
              <p className="text-xs text-muted mt-0.5">
                Enter new charm keycap quantities first, then select the Filament Color for each generated plate in Preview. Completed and queued plates remain untouched.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3.5">
            {CHARM_DEFINITIONS.map((charm) => {
              const currentVal = draftCharms[charm.id] ?? 0;

              return (
                <div
                  key={charm.id}
                  className={`rounded-xl border p-4 flex flex-col justify-between gap-3 transition-colors ${
                    currentVal > 0
                      ? 'border-brand-border bg-brand-soft'
                      : 'border-line bg-elevated'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div
                        className="w-10 h-10 rounded-xl bg-brand-soft border border-brand-border flex items-center justify-center text-lg font-bold text-brand-text shrink-0"
                        aria-hidden="true"
                      >
                        {charm.symbol}
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs font-bold tracking-wide text-ink truncate">
                          {charm.label}
                        </div>
                        <div className="text-[10px] font-mono-data text-muted truncate">
                          {charm.id}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      aria-label={`Decrease ${charm.label} quantity`}
                      onClick={() => handleSetCharmQty(charm.id, currentVal - 1)}
                      className="w-8 h-9 rounded-lg border border-line bg-input hover:bg-recessed text-sm font-semibold text-ink shrink-0 transition-colors"
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
                        handleSetCharmQty(
                          charm.id,
                          Math.floor(Number(e.target.value) || 0)
                        )
                      }
                      className="w-full h-9 px-2 text-center rounded-lg border border-line bg-input text-xs font-mono-data font-semibold text-ink focus:border-brand focus:outline-none"
                    />
                    <button
                      type="button"
                      aria-label={`Increase ${charm.label} quantity`}
                      onClick={() => handleSetCharmQty(charm.id, currentVal + 1)}
                      className="w-8 h-9 rounded-lg border border-line bg-input hover:bg-recessed text-sm font-semibold text-ink shrink-0 transition-colors"
                    >
                      +
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Built-in Auto Plate Generator Summary & Remainder Controls */}
      {!isCatalogWorkflow && batchPreview && (
        <section className="bg-surface border border-line rounded-xl p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-ink">
                Auto Plate Generator (
                {builtInMode === 'alphabet_only'
                  ? 'Alphabet Keycaps A–Z'
                  : 'Charm Keycaps'}
                )
              </h2>
              <p className="text-xs text-muted mt-0.5">
                Completed, Printing, and existing Queued plates remain untouched. New plates contain only items from this category.
              </p>
            </div>

            <div className="text-xs font-mono-data text-ink-secondary">
              Batch Input: <b className="text-ink">{batchPreview.totalRequestedCount}</b> pcs · Full Plates:{' '}
              <b className="text-ink">{batchPreview.fullPlates.length}</b> ({plateCapacity}/plate) · Remainder:{' '}
              <b className="text-ink">{batchPreview.remainderCount}</b> pcs
            </div>
          </div>

          <div className="p-4 rounded-xl bg-recessed border border-line space-y-3">
            {batchPreview.remainderCount > 0 ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink">
                  <div>
                    <span className="font-semibold">
                      Incomplete Plate Remainder ({batchPreview.remainderCount} / {plateCapacity} pcs):
                    </span>{' '}
                    <span className="font-mono-data">{remainderSummaryParts.join(', ')}</span>
                  </div>
                  <span className="px-2.5 py-1 rounded-lg bg-brand-soft border border-brand-border text-brand-text font-mono-data font-semibold whitespace-nowrap">
                    Remaining Capacity: {batchPreview.neededForNextFullPlate} pcs available
                  </span>
                </div>
                <p className="text-xs text-muted">
                  Unrequested items are never added automatically. Generate an incomplete plate with{' '}
                  <span className="font-mono-data font-semibold text-ink">
                    {batchPreview.neededForNextFullPlate} pcs
                  </span>{' '}
                  remaining capacity, carry the remainder forward, or adjust quantities above:
                </p>
                <div className="flex flex-wrap gap-2.5">
                  <button
                    type="button"
                    onClick={() => handlePreparePlatesPreview('partial_plate')}
                    className="px-4 py-2 text-xs font-semibold rounded-lg bg-brand hover:bg-brand-hover text-white whitespace-nowrap transition-colors"
                  >
                    {batchPreview.fullPlates.length > 0
                      ? `Preview ${batchPreview.fullPlates.length} Full + 1 Incomplete Plate (${batchPreview.remainderCount}/${plateCapacity} pcs)`
                      : `Preview 1 Incomplete Plate (${batchPreview.remainderCount}/${plateCapacity} pcs)`}
                  </button>
                  <button
                    type="button"
                    onClick={() => handlePreparePlatesPreview('carry_forward')}
                    className="px-4 py-2 text-xs font-medium rounded-lg border border-line bg-surface hover:bg-elevated text-ink whitespace-nowrap transition-colors"
                  >
                    {batchPreview.fullPlates.length > 0
                      ? `Generate ${batchPreview.fullPlates.length} Exact Plate(s) & Carry Remainder (${batchPreview.remainderCount} pcs) Forward`
                      : `Carry Remainder (${batchPreview.remainderCount} pcs) Forward Only`}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-brand-text font-medium">
                  {batchPreview.totalRequestedCount > 0
                    ? `Exact multiple of ${plateCapacity} pcs — distributes cleanly into ${batchPreview.fullPlates.length} full plate(s) with 0 remainder.`
                    : `Enter ${
                        builtInMode === 'alphabet_only' ? 'Alphabet A–Z' : 'Charm'
                      } quantities above to generate print plates.`}
                </div>
                <button
                  type="button"
                  disabled={batchPreview.totalRequestedCount === 0}
                  onClick={() => handlePreparePlatesPreview('carry_forward')}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-brand hover:bg-brand-hover disabled:opacity-40 text-white whitespace-nowrap transition-colors"
                >
                  Generate Plate Preview ({batchPreview.fullPlates.length})
                </button>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Interactive Pre-Confirmation Plate Adjustment Area for Built-in Workflows */}
      {!isCatalogWorkflow && stagedPlates !== null && (
        <section className="bg-surface border-2 border-brand rounded-xl p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-ink">
                Review &amp; Confirm Plates ({stagedPlates.length})
              </h3>
              <p className="text-xs text-muted mt-0.5">
                Select a physical <b className="text-ink">Filament Color</b> individually for each plate (never exceeding {plateCapacity} pcs/plate), and verify physical fit in Bambu Studio.
              </p>
            </div>
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                disabled={isBuiltInConfirming}
                onClick={() => {
                  setStagedPlates(null);
                  setHasAttemptedBuiltInConfirm(false);
                }}
                className="px-3.5 py-2 text-xs font-medium rounded-lg border border-line bg-elevated text-ink hover:bg-recessed disabled:opacity-40 transition-colors"
              >
                Discard Preview
              </button>
              <button
                type="button"
                disabled={isBuiltInConfirming}
                onClick={() => void handleConfirmAndSavePlates()}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-brand hover:bg-brand-hover disabled:opacity-50 text-white whitespace-nowrap transition-colors"
              >
                {isBuiltInConfirming ? 'Saving...' : 'Confirm & Save to Print Queue'}
              </button>
            </div>
          </div>

          {hasAttemptedBuiltInConfirm && invalidBuiltInPlateNumbers.length > 0 && (
            <div
              role="alert"
              className="p-3.5 rounded-xl border border-status-error bg-error-soft text-xs text-error-text flex items-start gap-2.5"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold">
                  Cannot confirm batch: Fix validation issues on Plate{' '}
                  {invalidBuiltInPlateNumbers.join(', Plate ')} before saving to Print Queue.
                </div>
                <div className="text-[11px] opacity-90 mt-0.5">
                  Every plate must have a valid physical Filament Color, positive quantity within capacity, and zero category conflicts.
                </div>
              </div>
            </div>
          )}

          {stagedPlates.length === 0 ? (
            <div className="p-4 rounded-xl bg-recessed border border-line text-xs text-ink-secondary">
              0 full plates to create right now. Remainder ({batchPreview?.remainderCount || 0} pcs) can be added as a partial plate above.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {stagedPlates.map((plate) => {
                const count = countPlateKeycaps(plate);
                const overCap = count > plate.capacity;
                const plateErrors = getBuiltInPlateErrors(plate);
                const visibleErrors = hasAttemptedBuiltInConfirm
                  ? plateErrors
                  : plateErrors.filter((e) => !e.includes('Select a physical Filament Color'));

                return (
                  <StagedPlateEditorCard
                    key={plate.tempId}
                    plate={plate}
                    builtInMode={builtInMode}
                    workspaceColors={workspace.colors}
                    count={count}
                    overCap={overCap}
                    missingColorError={
                      hasAttemptedBuiltInConfirm &&
                      (!plate.colorId || !workspace.colors.some((c) => c.id === plate.colorId))
                    }
                    visibleErrors={visibleErrors}
                    onSelectColor={handleAssignBuiltInPlateColor}
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
  plate: BuiltInStagedPlate;
  builtInMode: 'alphabet_only' | 'charm_only';
  workspaceColors: readonly ColorOption[];
  count: number;
  overCap: boolean;
  missingColorError: boolean;
  visibleErrors: string[];
  onSelectColor: (tempId: string, colorId: string) => void;
  onAdjustLetter: (tempId: string, letter: string, val: string) => void;
  onAdjustCharm: (tempId: string, charmId: CharmId, val: string) => void;
  onAddLetter: (tempId: string, letter: string) => void;
  onAddCharm: (tempId: string, charmId: CharmId) => void;
  onToggleVerified: (tempId: string) => void;
  onChangeDuration: (tempId: string, minutes: number) => void;
}

const StagedPlateEditorCard: React.FC<StagedPlateEditorCardProps> = ({
  plate,
  builtInMode,
  workspaceColors,
  count,
  overCap,
  missingColorError,
  visibleErrors,
  onSelectColor,
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

  const modeBadgeLabel = builtInMode === 'charm_only' ? 'Charm' : 'Alphabet';
  const plateColorObj = workspaceColors.find((c) => c.id === plate.colorId);
  const hasCardError = overCap || visibleErrors.length > 0;

  return (
    <div
      data-testid={`staged-plate-card-${plate.plateNumber}`}
      className={`rounded-xl border p-4 space-y-3 ${
        hasCardError
          ? 'border-status-error bg-error-soft'
          : 'border-line bg-elevated'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-ink">
            Plate {plate.plateNumber}
          </span>
          <span className="text-[10px] font-semibold text-brand-text">
            · {modeBadgeLabel}
          </span>
        </div>
        <span
          className={`text-xs font-mono-data font-semibold ${
            overCap
              ? 'text-error-text'
              : count === plate.capacity
              ? 'text-brand-text'
              : 'text-warning-text'
          }`}
        >
          {count} / {plate.capacity} pcs
        </span>
      </div>

      {/* Per-Plate Filament Color Selector */}
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted font-medium">Filament Color *</span>
        <div className="flex items-center gap-1.5 min-w-0">
          {plateColorObj ? (
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0 border border-line"
              style={{ backgroundColor: plateColorObj.hex }}
              aria-hidden="true"
            />
          ) : (
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0 border border-dashed border-line bg-recessed"
              aria-hidden="true"
            />
          )}
          <select
            aria-label={`Filament color for Plate ${plate.plateNumber}`}
            value={plate.colorId || ''}
            onChange={(e) => onSelectColor(plate.tempId, e.target.value)}
            className={`px-2 py-1 rounded-lg border bg-input text-xs font-semibold focus:border-brand focus:outline-none ${
              missingColorError
                ? 'border-status-error text-error-text'
                : 'border-line text-ink'
            }`}
          >
            <option value="">Select Filament Color</option>
            {workspaceColors.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {overCap ? (
        <div className="text-[11px] font-mono-data font-semibold text-error-text">
          Exceeds plate capacity by {count - plate.capacity} pcs (max {plate.capacity} pcs)
        </div>
      ) : remainingCapacity > 0 ? (
        <div className="text-[11px] font-mono-data text-warning-text bg-warning-soft border border-warning-border rounded-lg px-2.5 py-1">
          Incomplete plate · Remaining capacity: <b>{remainingCapacity} pcs</b> available
        </div>
      ) : (
        <div className="text-[11px] font-mono-data text-brand-text">
          Full capacity ({plate.capacity} pcs) · Remaining capacity: 0 pcs
        </div>
      )}

      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted">Bambu Studio Time:</span>
        <DurationHMInput
          compact
          minutes={plate.estimatedMinutes}
          onChangeMinutes={(mins) => onChangeDuration(plate.tempId, mins)}
          ariaLabelPrefix={`Plate ${plate.plateNumber} duration`}
        />
      </div>

      {builtInMode === 'alphabet_only' && letterEntries.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[11px] font-semibold text-muted">
            Alphabet A–Z ({countLetters(plate.letters)} pcs)
          </div>
          <div className="grid grid-cols-3 gap-2">
            {letterEntries.map(([k, v]) => (
              <div
                key={k}
                className="flex items-center gap-1 bg-input border border-line rounded-lg px-2 py-1"
              >
                <span className="text-xs font-bold text-ink w-4">
                  {k}
                </span>
                <input
                  type="number"
                  min={0}
                  aria-label={`Plate ${plate.plateNumber} letter ${k} quantity`}
                  value={v}
                  onChange={(e) => onAdjustLetter(plate.tempId, k, e.target.value)}
                  className="w-full text-right text-xs font-mono-data bg-transparent text-ink focus:outline-none"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {builtInMode === 'charm_only' && charmEntries.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[11px] font-semibold text-brand-text">
            Charm Keycaps ({countCharms(plate.charms)} pcs)
          </div>
          <div className="grid grid-cols-2 gap-2">
            {charmEntries.map(({ def, qty }) => (
              <div
                key={def.id}
                className="flex items-center justify-between gap-1.5 bg-brand-soft border border-brand-border rounded-lg px-2.5 py-1"
              >
                <span className="text-xs font-semibold text-brand-text whitespace-nowrap">
                  {def.symbol} {def.label}
                </span>
                <input
                  type="number"
                  min={0}
                  aria-label={`Plate ${plate.plateNumber} charm ${def.label} quantity`}
                  value={qty}
                  onChange={(e) => onAdjustCharm(plate.tempId, def.id, e.target.value)}
                  className="w-12 text-right text-xs font-mono-data font-bold bg-transparent text-ink focus:outline-none"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {visibleErrors.length > 0 && (
        <div
          role="alert"
          className="p-2 rounded-lg border border-status-error bg-surface/80 text-[11px] font-medium text-error-text space-y-1"
        >
          {visibleErrors.map((err, i) => (
            <div key={i}>{err}</div>
          ))}
        </div>
      )}

      <div className="space-y-2 pt-2 border-t border-line">
        <div className="flex flex-wrap items-center gap-1.5">
          {builtInMode === 'alphabet_only' ? (
            <>
              <select
                aria-label="Select letter to add to plate"
                value={letterToAdd}
                onChange={(e) => setLetterToAdd(e.target.value)}
                className="px-2 py-1 rounded border border-line bg-input text-ink text-xs focus:border-brand focus:outline-none"
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
                className="px-2 py-1 text-xs rounded border border-line bg-surface hover:bg-recessed text-ink disabled:opacity-40 whitespace-nowrap transition-colors"
              >
                + Letter
              </button>
            </>
          ) : (
            <>
              <select
                aria-label="Select charm to add to plate"
                value={charmToAdd}
                onChange={(e) => setCharmToAdd(e.target.value as CharmId)}
                className="px-2 py-1 rounded border border-line bg-input text-ink text-xs focus:border-brand focus:outline-none"
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
                className="px-2 py-1 text-xs rounded border border-brand-border bg-brand-soft hover:bg-brand hover:text-white text-brand-text disabled:opacity-40 whitespace-nowrap transition-colors"
              >
                + Charm
              </button>
            </>
          )}
        </div>

        <label className="flex items-center gap-1.5 text-[11px] text-ink-secondary cursor-pointer">
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
