import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Download,
  Loader2,
  RotateCcw,
  Save,
  Store,
} from 'lucide-react';
import { countCatalogItems, countLetters } from '../constants';
import {
  Bambu3mfExportProgressEvent,
  CatalogProduct,
  CategoryPlateSetting,
  ColorOption,
  Master3mfTemplateAsset,
  ProductCategory,
  ProductionBatchVariationSnapshot,
  ProductionJob,
  ProductionProject,
  StlModelAssetEntry,
  StlModelAssetRecord,
} from '../types';
import {
  applyColorToAllCatalogPlates,
  assignColorToDraftCatalogPlate,
  buildCatalogSelectionKey,
  buildPlannerProductInputModel,
  CatalogPlannerSelectionInput,
  DraftCatalogPlatePreview,
  generateAutomaticCatalogPlatePreviews,
  getPlannableProductItems,
  isAlphabetProductItems,
  validateCategoryForPlanning,
  validateStagedCatalogPlatesBatch,
} from '../utils/catalogPlannerEngine';
import {
  PlateIdRegistryAdapter,
  reservePlateCodesForPreviewPlates,
} from '../services/plateIdService';
import { generateStableBatchId, normalizePlateCode } from '../utils/plateIdGenerator';
import {
  exportBatchPlates3mfAction,
  exportSinglePlate3mfAction,
} from '../utils/platePreviewHelper';
import { extractLettersMapFromCatalogItems } from '../utils/plateStlLayout';
import { DurationHMInput } from './DurationHMInput';
import { DynamicOptionQuantityGrid } from './DynamicOptionQuantityGrid';
import { CategoryIcon } from './product-studio/CategoryIcon';
import { formatMyrPrice } from './product-studio/ProductDetailModal';
import { ToastVariant } from './ToastStack';

export interface CatalogCategoryPlannerSectionProps {
  category: ProductCategory;
  categoryProducts: readonly CatalogProduct[];
  plateSetting: CategoryPlateSetting | null;
  currentProject: ProductionProject;
  workspaceColors?: readonly ColorOption[];
  existingJobs: readonly ProductionJob[];
  quantitiesByKey: Record<string, number>;
  highlightedProductId: string | null;
  allCategories?: readonly ProductCategory[];
  selectedWorkflowValue?: string;
  onSelectWorkflow?: (workflowValue: string) => void;
  onSelectCategory?: (categoryId: string) => void;
  onChangeQuantity: (selectionKey: string, nextQty: number) => void;
  onSaveCategoryPlateSetting: (
    setting: Omit<CategoryPlateSetting, 'ownerId' | 'updatedAt'>
  ) => Promise<void>;
  onConfirmCatalogPlates: (
    category: ProductCategory,
    confirmedPlates: DraftCatalogPlatePreview[],
    onSuccess: () => void,
    options?: {
      batchId?: string | null;
      splitByColor?: boolean;
      requestedQuantity?: number;
      requestedVariations?: ProductionBatchVariationSnapshot[];
    }
  ) => Promise<void | boolean> | void;
  onOpenProductStudio: () => void;
  onAlert: (msg: string, title?: string) => void;
  onToast?: (variant: ToastVariant, message: string) => void;
  ownerId?: string | null;
  plateIdRegistry?: PlateIdRegistryAdapter;
  resetSignal: number;
  stlRecordsByLetter?: Record<string, StlModelAssetRecord>;
  getStlAssetsByLetters?: (
    letters: readonly string[]
  ) => Promise<Record<string, StlModelAssetEntry>>;
  getMaster3mfAsset?: () => Promise<Master3mfTemplateAsset | null>;
}

/**
 * WOOPP 6.0 Auto Plate Planner Section:
 *
 * MANDATORY PRODUCTION INVARIANT:
 * ONE PLATE = ONE PRODUCT ID + ONE PHYSICAL FILAMENT COLOR.
 *
 * WORKFLOW:
 * Select Project -> Select Category -> Select Product -> Enter Variation Quantities
 * -> Generate Plate Preview -> Select Filament Color for EACH Plate
 * -> Verify Physical Bed Fit -> Confirm & Save to Print Queue.
 */
export const CatalogCategoryPlannerSection: React.FC<
  CatalogCategoryPlannerSectionProps
> = ({
  category,
  categoryProducts,
  plateSetting,
  currentProject,
  workspaceColors = [],
  existingJobs,
  quantitiesByKey,
  highlightedProductId,
  allCategories = [],
  selectedWorkflowValue,
  onSelectWorkflow,
  onSelectCategory,
  onChangeQuantity,
  onSaveCategoryPlateSetting,
  onConfirmCatalogPlates,
  onOpenProductStudio,
  onAlert,
  onToast,
  ownerId = null,
  plateIdRegistry,
  resetSignal,
  getMaster3mfAsset,
}) => {
  // Active products strictly within the selected category
  const activeCategoryProducts = useMemo(
    () =>
      categoryProducts
        .filter((p) => p.categoryId === category.id && p.status === 'active')
        .sort((a, b) => a.name.localeCompare(b.name)),
    [categoryProducts, category.id]
  );

  // Selected Product State (Step 2 of workflow)
  const [selectedProductId, setSelectedProductId] = useState<string>(() => {
    if (
      highlightedProductId &&
      activeCategoryProducts.some((p) => p.id === highlightedProductId)
    ) {
      return highlightedProductId;
    }
    return activeCategoryProducts[0]?.id || '';
  });

  // Sync selected product when category or highlightedProductId changes (never leave orphan selection)
  useEffect(() => {
    if (
      highlightedProductId &&
      activeCategoryProducts.some((p) => p.id === highlightedProductId)
    ) {
      setSelectedProductId(highlightedProductId);
      return;
    }
    if (!activeCategoryProducts.some((p) => p.id === selectedProductId)) {
      setSelectedProductId(activeCategoryProducts[0]?.id || '');
    }
  }, [category.id, highlightedProductId, activeCategoryProducts, selectedProductId]);

  const selectedProduct = useMemo(
    () =>
      activeCategoryProducts.find((p) => p.id === selectedProductId) ||
      activeCategoryProducts[0] ||
      null,
    [activeCategoryProducts, selectedProductId]
  );

  // Plate capacity settings for this category
  const [capacityInput, setCapacityInput] = useState<string>(
    plateSetting?.plateCapacity !== null && plateSetting?.plateCapacity !== undefined
      ? String(plateSetting.plateCapacity)
      : ''
  );
  const [defaultMinutes, setDefaultMinutes] = useState<number>(
    plateSetting?.defaultEstimatedMinutes || 180
  );
  const [isSavingRule, setIsSavingRule] = useState<boolean>(false);

  // Staged Plate Previews & confirmation/validation state
  const [stagedCatalogPlates, setStagedCatalogPlates] = useState<
    DraftCatalogPlatePreview[] | null
  >(null);
  const [stagedBatchId, setStagedBatchId] = useState<string | null>(null);
  const [stagedRequestMeta, setStagedRequestMeta] = useState<{
    requestedQuantity: number;
    requestedVariations: ProductionBatchVariationSnapshot[];
  } | null>(null);
  const [bulkColorId, setBulkColorId] = useState<string>('');
  const [hasAttemptedConfirm, setHasAttemptedConfirm] = useState<boolean>(false);
  const [isConfirming, setIsConfirming] = useState<boolean>(false);
  const [exportingPlateTempIds, setExportingPlateTempIds] = useState<Record<string, boolean>>({});
  const [isBatchExporting3mf, setIsBatchExporting3mf] = useState<boolean>(false);
  const [batch3mfProgress, setBatch3mfProgress] =
    useState<Bambu3mfExportProgressEvent | null>(null);
  const previewReservationPromiseRef = useRef<Promise<Record<string, string>> | null>(null);
  const confirmLockRef = useRef<boolean>(false);

  // Sync saved rule when category updates
  useEffect(() => {
    setCapacityInput(
      plateSetting?.plateCapacity !== null && plateSetting?.plateCapacity !== undefined
        ? String(plateSetting.plateCapacity)
        : ''
    );
    setDefaultMinutes(plateSetting?.defaultEstimatedMinutes || 180);
    setStagedCatalogPlates(null);
    setStagedBatchId(null);
    setStagedRequestMeta(null);
    setBulkColorId('');
    setHasAttemptedConfirm(false);
  }, [
    category.id,
    plateSetting?.plateCapacity,
    plateSetting?.defaultEstimatedMinutes,
  ]);

  // Handle parent Reset signal
  useEffect(() => {
    if (resetSignal === 0) return;
    setStagedCatalogPlates(null);
    setStagedBatchId(null);
    setStagedRequestMeta(null);
    setBulkColorId('');
    setHasAttemptedConfirm(false);
  }, [resetSignal]);

  const parsedConfiguredCapacity: number | null = useMemo(() => {
    const trimmed = capacityInput.trim();
    if (!trimmed) return null;
    const n = Math.floor(Number(trimmed));
    return Number.isFinite(n) && n >= 1 ? n : null;
  }, [capacityInput]);

  // Color-agnostic quantity input model (no top-level filament color filter)
  const inputModel = useMemo(() => {
    if (!selectedProduct) return null;
    return buildPlannerProductInputModel(selectedProduct, workspaceColors);
  }, [selectedProduct, workspaceColors]);

  // Compute total entered quantity for the current selected product
  const currentProductTotal = useMemo(() => {
    if (!selectedProduct || !inputModel) return 0;
    let sum = 0;
    for (const item of inputModel.items) {
      const key = buildCatalogSelectionKey(
        selectedProduct.id,
        item.id !== 'base' ? item.id : null
      );
      sum += Math.floor(Number(quantitiesByKey[key] || 0));
    }
    return sum;
  }, [selectedProduct, inputModel, quantitiesByKey]);

  const batchValidation = useMemo(() => {
    if (!stagedCatalogPlates || stagedCatalogPlates.length === 0) return null;
    return validateStagedCatalogPlatesBatch(stagedCatalogPlates, {
      category,
      product: selectedProduct,
      workspaceColors,
    });
  }, [stagedCatalogPlates, category, selectedProduct, workspaceColors]);

  // Reset ONLY current editable planning quantities for this product
  const handleResetCurrentProduct = () => {
    if (!selectedProduct || !inputModel) return;
    for (const item of inputModel.items) {
      const key = buildCatalogSelectionKey(
        selectedProduct.id,
        item.id !== 'base' ? item.id : null
      );
      if ((quantitiesByKey[key] ?? 0) > 0) {
        onChangeQuantity(key, 0);
      }
    }
    setStagedCatalogPlates(null);
    setStagedBatchId(null);
    setHasAttemptedConfirm(false);
  };

  const handleSaveRuleClick = async () => {
    if (isSavingRule) return;
    if (parsedConfiguredCapacity === null) {
      onAlert(
        `Enter a valid Max Units per Plate (>= 1) for "${category.name}" before saving.`,
        'Category Plate Capacity'
      );
      return;
    }

    setIsSavingRule(true);
    try {
      await onSaveCategoryPlateSetting({
        categoryId: category.id,
        allocationMode: 'automatic_capacity',
        plateCapacity: parsedConfiguredCapacity,
        defaultEstimatedMinutes: defaultMinutes,
      });
    } finally {
      setIsSavingRule(false);
    }
  };

  const handlePreviewAutomatic = (includePartial: boolean) => {
    if (!selectedProduct || !inputModel) {
      onAlert('Select a product first.');
      return;
    }

    if (parsedConfiguredCapacity === null) {
      onAlert(
        `Configure a valid Max Units per Plate rule for "${category.name}" first (138 is never assumed).`,
        'Plate Capacity Required'
      );
      return;
    }

    // Build selections strictly for this selected product (no filament color required!)
    const selections: CatalogPlannerSelectionInput[] = [];
    for (const item of inputModel.items) {
      const key = buildCatalogSelectionKey(
        selectedProduct.id,
        item.id !== 'base' ? item.id : null
      );
      const qty = Math.floor(Number(quantitiesByKey[key] || 0));
      if (qty > 0) {
        selections.push({
          productId: selectedProduct.id,
          variantId: item.id !== 'base' ? item.id : null,
          quantity: qty,
        });
      }
    }

    if (selections.length === 0) {
      onAlert(
        `Enter a quantity of at least 1 for "${selectedProduct.name}" before generating plates.`,
        'No Quantities Entered'
      );
      return;
    }

    const res = generateAutomaticCatalogPlatePreviews({
      existingJobs,
      project: currentProject,
      color: null, // Always start draft plates unassigned ("Select Filament Color")
      workspaceColors,
      category,
      products: [selectedProduct],
      selections,
      plateSetting: {
        allocationMode: 'automatic_capacity',
        plateCapacity: parsedConfiguredCapacity,
        defaultEstimatedMinutes: defaultMinutes,
      },
      includePartialRemainderPlate: includePartial,
    });

    if (res.error || !res.previews) {
      onAlert(res.error || 'Unable to generate plate preview.', 'Plate Planning Notice');
      return;
    }

    if (res.previews.length === 0) {
      onAlert(
        `Total selected quantity (${currentProductTotal} pcs) is less than 1 full plate (${parsedConfiguredCapacity} pcs). Use "Generate Plate Preview" to include the partial plate.`,
        'No Full Plates'
      );
      return;
    }

    // Capture requested batch quantities at preview time (even if preview omits a remainder)
    const reqVars: ProductionBatchVariationSnapshot[] = [];
    let reqTotal = 0;
    for (const item of inputModel.items) {
      const key = buildCatalogSelectionKey(
        selectedProduct.id,
        item.id !== 'base' ? item.id : null
      );
      const qty = Math.floor(Number(quantitiesByKey[key] || 0));
      if (qty > 0) {
        reqTotal += qty;
        const isBase = item.id === 'base' || item.id === '__color_agnostic_base__';
        const isSyntheticCombo = item.id.startsWith('noncolor::');
        const cleanVarId = isBase || isSyntheticCombo ? null : item.id;
        const cleanLabel = isBase ? 'Standard / No Variation' : item.label;
        const varKey = cleanVarId
          ? `var:${cleanVarId}`
          : `novar:${isBase ? 'standard' : cleanLabel}`;
        reqVars.push({
          variationKey: varKey,
          variantId: cleanVarId,
          label: cleanLabel,
          requestedQuantity: qty,
        });
      }
    }

    const nextBatchId = generateStableBatchId();
    setStagedBatchId(nextBatchId);
    setStagedCatalogPlates(res.previews);
    setStagedRequestMeta({
      requestedQuantity: reqTotal,
      requestedVariations: reqVars,
    });
    setBulkColorId('');
    setHasAttemptedConfirm(false);

    const effectiveOwnerId = (ownerId || currentProject.id || 'local-operator').trim();
    const reservePromise = reservePlateCodesForPreviewPlates({
      plates: res.previews,
      ownerId: effectiveOwnerId,
      projectId: currentProject.id,
      batchId: nextBatchId,
      existingJobs,
      registry: plateIdRegistry,
    })
      .then((reservedPlates) => {
        const codeByTempId: Record<string, string> = {};
        for (const rp of reservedPlates) {
          codeByTempId[rp.tempId] = rp.plateCode;
        }
        setStagedCatalogPlates((prev) =>
          prev
            ? prev.map((p) =>
                codeByTempId[p.tempId] ? { ...p, plateCode: codeByTempId[p.tempId] } : p
              )
            : null
        );
        return codeByTempId;
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        onToast?.('error', `Unable to reserve Plate IDs: ${msg}`);
        return {} as Record<string, string>;
      });

    previewReservationPromiseRef.current = reservePromise;
  };

  const ensureCatalogPlateCode = async (
    plate: DraftCatalogPlatePreview
  ): Promise<string> => {
    const existing = normalizePlateCode(plate.plateCode);
    if (existing) return existing;
    if (previewReservationPromiseRef.current) {
      const codeMap = await previewReservationPromiseRef.current;
      const fromInFlight = normalizePlateCode(codeMap[plate.tempId]);
      if (fromInFlight) return fromInFlight;
    }
    const effectiveOwnerId = (ownerId || currentProject.id || 'local-operator').trim();
    const [reserved] = await reservePlateCodesForPreviewPlates({
      plates: [plate],
      ownerId: effectiveOwnerId,
      projectId: currentProject.id,
      batchId: stagedBatchId || undefined,
      existingJobs,
      registry: plateIdRegistry,
    });
    setStagedCatalogPlates((prev) =>
      prev
        ? prev.map((p) =>
            p.tempId === plate.tempId ? { ...p, plateCode: reserved.plateCode } : p
          )
        : null
    );
    return reserved.plateCode;
  };

  const handleExportCatalogPlate3mf = async (plate: DraftCatalogPlatePreview) => {
    if (!selectedProduct || exportingPlateTempIds[plate.tempId] || isBatchExporting3mf) {
      return;
    }
    setExportingPlateTempIds((prev) => ({ ...prev, [plate.tempId]: true }));
    try {
      const extracted = extractLettersMapFromCatalogItems(plate.items);
      const matchedColor = workspaceColors.find((c) => c.id === plate.colorId);

      await exportSinglePlate3mfAction({
        plateNumber: plate.plateNumber,
        plateCode: plate.plateCode,
        capacity: plate.capacity || countCatalogItems(plate.items),
        letters: extracted.letters,
        colorId: matchedColor?.id || plate.colorId || null,
        colorName: matchedColor?.name || plate.colorName || null,
        colorHex: matchedColor?.hex || null,
        productName: selectedProduct.name,
        projectName: currentProject.name,
        getMaster3mfAsset,
        ensurePlateCode: () => ensureCatalogPlateCode(plate),
        onToast,
      });
    } finally {
      setExportingPlateTempIds((prev) => {
        const next = { ...prev };
        delete next[plate.tempId];
        return next;
      });
    }
  };

  const handleExportCatalogBatch3mf = async () => {
    if (
      !selectedProduct ||
      !stagedCatalogPlates ||
      stagedCatalogPlates.length === 0 ||
      isBatchExporting3mf
    ) {
      return;
    }
    setIsBatchExporting3mf(true);
    setBatch3mfProgress({
      phase: 'loading_master',
      completedPlates: 0,
      totalPlates: stagedCatalogPlates.length,
      percent: 5,
      message: 'Preparing multi-plate Bambu Studio .3MF export...',
    });

    try {
      const effectiveBatchId = stagedBatchId || generateStableBatchId();
      if (!stagedBatchId) {
        setStagedBatchId(effectiveBatchId);
      }

      await exportBatchPlates3mfAction({
        batchId: effectiveBatchId,
        plates: stagedCatalogPlates.map((p) => {
          const extracted = extractLettersMapFromCatalogItems(p.items);
          const matchedColor = workspaceColors.find((c) => c.id === p.colorId);
          return {
            tempId: p.tempId,
            plateNumber: p.plateNumber,
            plateCode: p.plateCode,
            capacity: p.capacity || countCatalogItems(p.items),
            letters: extracted.letters,
            colorId: matchedColor?.id || p.colorId || null,
            colorName: matchedColor?.name || p.colorName || null,
            colorHex: matchedColor?.hex || null,
            productName: p.productName || selectedProduct.name,
          };
        }),
        projectName: currentProject.name,
        getMaster3mfAsset,
        ensureAllPlateCodes: async () => {
          const codeMap: Record<string, string> = previewReservationPromiseRef.current
            ? { ...(await previewReservationPromiseRef.current) }
            : {};
          const missing = stagedCatalogPlates.filter(
            (p) => !normalizePlateCode(p.plateCode) && !normalizePlateCode(codeMap[p.tempId])
          );
          if (missing.length > 0) {
            const effectiveOwnerId = (ownerId || currentProject.id || 'local-operator').trim();
            const reserved = await reservePlateCodesForPreviewPlates({
              plates: missing,
              ownerId: effectiveOwnerId,
              projectId: currentProject.id,
              batchId: effectiveBatchId,
              existingJobs,
              registry: plateIdRegistry,
            });
            for (const rp of reserved) {
              codeMap[rp.tempId] = rp.plateCode;
            }
          }
          setStagedCatalogPlates((prev) =>
            prev
              ? prev.map((p) =>
                  codeMap[p.tempId] && !normalizePlateCode(p.plateCode)
                    ? { ...p, plateCode: codeMap[p.tempId] }
                    : p
                )
              : null
          );
          return codeMap;
        },
        onProgress: (ev) => setBatch3mfProgress(ev),
        onToast,
      });
    } finally {
      setIsBatchExporting3mf(false);
      setBatch3mfProgress(null);
    }
  };

  const handleApplyColorToAllPlates = (colorIdRaw: string) => {
    const cleanId = colorIdRaw.trim();
    const matchedColor = cleanId
      ? workspaceColors.find((c) => c.id === cleanId) || null
      : null;
    if (!matchedColor) return;
    setBulkColorId(matchedColor.id);
    setStagedCatalogPlates((prev) =>
      prev
        ? applyColorToAllCatalogPlates(
            prev,
            matchedColor,
            selectedProduct,
            workspaceColors
          )
        : null
    );
  };

  const handleAssignPlateColor = (tempId: string, nextColorIdRaw: string) => {
    const nextColorId = nextColorIdRaw.trim();
    const matchedColor = nextColorId
      ? workspaceColors.find((c) => c.id === nextColorId) || null
      : null;

    setStagedCatalogPlates((prev) =>
      prev
        ? prev.map((p) =>
            p.tempId === tempId
              ? assignColorToDraftCatalogPlate(
                  p,
                  matchedColor,
                  selectedProduct,
                  workspaceColors
                )
              : p
          )
        : null
    );
  };

  const handleAdjustStagedItemQty = (
    tempId: string,
    itemIndex: number,
    rawVal: string
  ) => {
    const nextQty = Math.max(0, Math.floor(Number(rawVal) || 0));
    setStagedCatalogPlates((prev) =>
      prev
        ? prev.map((plate) => {
            if (plate.tempId !== tempId) return plate;
            const nextItems = plate.items.map((it, idx) =>
              idx === itemIndex ? { ...it, quantity: nextQty } : it
            );
            return {
              ...plate,
              items: nextItems,
            };
          })
        : null
    );
  };

  const handleConfirmClick = async (splitByColor = false) => {
    if (
      !stagedCatalogPlates ||
      stagedCatalogPlates.length === 0 ||
      isConfirming ||
      confirmLockRef.current
    ) {
      return;
    }

    setHasAttemptedConfirm(true);

    const validation = validateStagedCatalogPlatesBatch(stagedCatalogPlates, {
      category,
      product: selectedProduct,
      workspaceColors,
    });

    const perPlateValid = validation.invalidPlateNumbers.length === 0;
    if (!perPlateValid || (validation.hasColorConflict && !splitByColor)) {
      // Block silent splitting or invalid plates; conflict banner offers explicit resolution actions
      return;
    }

    const cleanedPlates = stagedCatalogPlates.map((p) => ({
      ...p,
      items: p.items.filter((it) => Math.floor(Number(it.quantity || 0)) > 0),
    }));

    confirmLockRef.current = true;
    setIsConfirming(true);
    try {
      await onConfirmCatalogPlates(
        category,
        cleanedPlates,
        () => {
          setStagedCatalogPlates(null);
          setStagedBatchId(null);
          setStagedRequestMeta(null);
          setBulkColorId('');
          setHasAttemptedConfirm(false);
          if (selectedProduct && inputModel) {
            for (const item of inputModel.items) {
              const key = buildCatalogSelectionKey(
                selectedProduct.id,
                item.id !== 'base' ? item.id : null
              );
              onChangeQuantity(key, 0);
            }
          }
        },
        {
          batchId: splitByColor ? undefined : stagedBatchId,
          splitByColor,
          requestedQuantity: splitByColor
            ? undefined
            : stagedRequestMeta?.requestedQuantity,
          requestedVariations: splitByColor
            ? undefined
            : stagedRequestMeta?.requestedVariations,
        }
      );
    } finally {
      confirmLockRef.current = false;
      setIsConfirming(false);
    }
  };

  const categoryCheck = validateCategoryForPlanning(category);
  if (!categoryCheck.ok) {
    return (
      <section className="bg-surface border border-warning-border rounded-xl p-6 space-y-2">
        <div className="text-sm font-semibold text-warning-text">
          Archived Category Cannot Create New Print Plans
        </div>
        <p className="text-xs text-ink-secondary">{categoryCheck.error}</p>
        <button
          type="button"
          onClick={onOpenProductStudio}
          className="px-3.5 py-2 rounded-lg border border-line bg-elevated hover:bg-recessed text-xs font-semibold text-ink transition-colors"
        >
          Open Product Studio →
        </button>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      {/* Authoritative Single Category & Product Selector */}
      <section className="bg-surface border border-line rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-line">
          <div>
            <h2 className="text-sm font-semibold text-ink">
              Auto Plate Planner · Product &amp; Option Selection
            </h2>
            <p className="text-xs text-muted mt-0.5">
              Select a category and product to enter quantities, then assign a physical Filament Color to each generated plate in Preview. <b className="text-ink">ONE PLATE = ONE PRODUCT + ONE FILAMENT COLOR</b>.
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
          {/* Step 1: Single Authoritative Category Dropdown */}
          <div>
            <label
              htmlFor="planner-category-select"
              className="block text-xs font-semibold text-ink-secondary mb-1"
            >
              1. Category
            </label>
            {onSelectWorkflow && selectedWorkflowValue ? (
              <select
                id="planner-category-select"
                value={selectedWorkflowValue}
                onChange={(e) => {
                  onSelectWorkflow(e.target.value);
                  setStagedCatalogPlates(null);
                  setStagedBatchId(null);
                  setHasAttemptedConfirm(false);
                }}
                className="w-full px-3 py-2 rounded-lg border border-line bg-input text-sm text-ink focus:border-brand focus:outline-none"
              >
                <optgroup label="Product Studio Categories">
                  {(allCategories.length > 0 ? allCategories : [category]).map((c) => {
                    const count = categoryProducts.filter(
                      (p) => p.categoryId === c.id && p.status === 'active'
                    ).length;
                    return (
                      <option key={c.id} value={`catalog:${c.id}`}>
                        {c.name} ({count} active {count === 1 ? 'product' : 'products'})
                      </option>
                    );
                  })}
                </optgroup>
                <optgroup label="Built-in Keycap Workflows">
                  <option value="builtin:alphabet">Alphabet Keycaps (A–Z)</option>
                  <option value="builtin:charm">Charm Keycaps (♥ ★ ✿ # @)</option>
                </optgroup>
              </select>
            ) : (
              <select
                id="planner-category-select"
                value={category.id}
                onChange={(e) => {
                  onSelectCategory?.(e.target.value);
                  setStagedCatalogPlates(null);
                  setStagedBatchId(null);
                  setHasAttemptedConfirm(false);
                }}
                className="w-full px-3 py-2 rounded-lg border border-line bg-input text-sm text-ink focus:border-brand focus:outline-none"
              >
                {allCategories.length > 0 ? (
                  allCategories.map((c) => {
                    const count = categoryProducts.filter(
                      (p) => p.categoryId === c.id && p.status === 'active'
                    ).length;
                    return (
                      <option key={c.id} value={c.id}>
                        {c.name} ({count} active {count === 1 ? 'product' : 'products'})
                      </option>
                    );
                  })
                ) : (
                  <option value={category.id}>
                    {category.name} ({activeCategoryProducts.length} active products)
                  </option>
                )}
              </select>
            )}
          </div>

          {/* Step 2: Product Dropdown (Filtered strictly by selected category) */}
          <div>
            <label
              htmlFor="planner-product-select"
              className="block text-xs font-semibold text-ink-secondary mb-1"
            >
              2. Product ({category.name})
            </label>
            {activeCategoryProducts.length > 0 ? (
              <select
                id="planner-product-select"
                value={selectedProduct?.id || ''}
                onChange={(e) => {
                  setSelectedProductId(e.target.value);
                  setStagedCatalogPlates(null);
                  setStagedBatchId(null);
                  setHasAttemptedConfirm(false);
                }}
                className="w-full px-3 py-2 rounded-lg border border-line bg-input text-sm text-ink focus:border-brand focus:outline-none font-medium"
              >
                {activeCategoryProducts.map((p) => {
                  const plannable = getPlannableProductItems(p);
                  const varCount =
                    plannable.length > 1 || (plannable.length === 1 && plannable[0].id !== 'base')
                      ? plannable.length
                      : 0;
                  return (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.sku} {varCount > 0 ? `(${varCount} variations)` : ''}
                    </option>
                  );
                })}
              </select>
            ) : (
              <div className="px-3 py-2 rounded-lg border border-line bg-recessed text-xs text-muted">
                No active products in this category
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Empty State: No active products in this category */}
      {activeCategoryProducts.length === 0 ? (
        <section className="bg-surface border border-line rounded-xl p-8 text-center space-y-3">
          <div className="w-12 h-12 rounded-xl bg-recessed border border-line flex items-center justify-center mx-auto text-muted">
            <CategoryIcon name={category.iconName} className="w-6 h-6 text-ink-secondary" />
          </div>
          <div className="text-sm font-semibold text-ink">
            No active products in &ldquo;{category.name}&rdquo;
          </div>
          <p className="text-xs text-muted max-w-md mx-auto">
            Add new products or restore existing ones in Product Studio under this category to start planning print plates.
          </p>
          <button
            type="button"
            onClick={onOpenProductStudio}
            className="px-4 py-2 rounded-lg bg-brand hover:bg-brand-hover text-white text-xs font-semibold transition-colors"
          >
            Add Products in Product Studio
          </button>
        </section>
      ) : selectedProduct && inputModel ? (
        /* Selected Product Planning Workspace */
        <div className="space-y-5">
          {/* Product Summary Header & Category Capacity Setting */}
          <section className="bg-surface border border-line rounded-xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3.5 min-w-0">
                {selectedProduct.images[0] ? (
                  <img
                    src={selectedProduct.images[0]}
                    alt={selectedProduct.name}
                    className="w-13 h-13 rounded-xl object-cover border border-line bg-recessed shrink-0"
                  />
                ) : (
                  <div className="w-13 h-13 rounded-xl border border-line bg-recessed flex items-center justify-center text-muted shrink-0">
                    <CategoryIcon name={category.iconName} className="w-6 h-6 text-ink-secondary" />
                  </div>
                )}
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-bold text-ink truncate leading-tight">
                      {selectedProduct.name}
                    </h3>
                    <span className="px-2 py-0.5 rounded-md bg-recessed border border-line text-[11px] font-medium text-ink-secondary">
                      {category.name}
                    </span>
                  </div>
                  <div className="text-xs font-mono-data text-muted mt-1 flex flex-wrap items-center gap-2">
                    <span>SKU: <b className="text-ink">{selectedProduct.sku}</b></span>
                    <span>·</span>
                    <span>Price: <b className="text-ink">{formatMyrPrice(selectedProduct.priceMyr)}</b></span>
                    <span>·</span>
                    <span>Filament Color: <b className="text-ink">Assigned per plate in Preview</b></span>
                  </div>
                </div>
              </div>

              {/* Total & Reset Control */}
              <div className="flex items-center gap-2.5">
                <div className="text-xs font-mono-data bg-recessed border border-line px-3 py-1.5 rounded-lg flex items-center gap-2">
                  <span className="text-[11px] text-muted uppercase tracking-wider font-sans font-semibold">
                    Current Total
                  </span>
                  <span className="text-sm font-bold text-brand-text">
                    {currentProductTotal.toLocaleString()} pcs
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleResetCurrentProduct}
                  disabled={currentProductTotal === 0}
                  title={`Reset editable quantities for ${selectedProduct.name} to 0`}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-line bg-elevated hover:bg-recessed text-xs font-semibold text-ink disabled:opacity-35 transition-colors cursor-pointer disabled:cursor-not-allowed"
                >
                  <RotateCcw className="w-3.5 h-3.5 text-ink-secondary" />
                  <span>Reset</span>
                </button>
              </div>
            </div>

            {/* Category Plate Capacity & Bambu Duration Rule */}
            <div className="p-3.5 rounded-xl bg-recessed border border-line flex flex-wrap items-end justify-between gap-3 text-xs">
              <div className="flex flex-wrap items-end gap-3.5">
                <div>
                  <label
                    htmlFor="cat-plate-cap-input"
                    className="block text-[11px] font-semibold text-ink-secondary mb-1"
                  >
                    Max Units / Plate ({category.name}) *
                  </label>
                  <input
                    id="cat-plate-cap-input"
                    type="number"
                    min={1}
                    max={5000}
                    placeholder="Enter capacity"
                    value={capacityInput}
                    onChange={(e) => {
                      setCapacityInput(e.target.value);
                      setStagedCatalogPlates(null);
                      setStagedBatchId(null);
                      setHasAttemptedConfirm(false);
                    }}
                    className="w-36 px-2.5 py-1.5 rounded-lg border border-line bg-input text-xs font-mono-data text-ink focus:border-brand focus:outline-none"
                  />
                </div>

                <div>
                  <span className="block text-[11px] font-semibold text-ink-secondary mb-1">
                    Bambu Est. Duration
                  </span>
                  <DurationHMInput
                    compact
                    minutes={defaultMinutes}
                    onChangeMinutes={(mins) => {
                      setDefaultMinutes(mins);
                      setStagedCatalogPlates(null);
                      setStagedBatchId(null);
                      setHasAttemptedConfirm(false);
                    }}
                    ariaLabelPrefix={`${category.name} plate duration`}
                  />
                </div>
              </div>

              <button
                type="button"
                disabled={isSavingRule}
                onClick={() => void handleSaveRuleClick()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-line bg-surface hover:bg-elevated text-xs font-semibold text-ink disabled:opacity-50 transition-colors"
              >
                <Save className="w-3.5 h-3.5 text-brand-text" />
                <span>{isSavingRule ? 'Saving...' : 'Save Category Rule'}</span>
              </button>
            </div>

            {parsedConfiguredCapacity === null && (
              <div className="p-3 rounded-lg border border-warning-border bg-warning-soft text-xs text-warning-text flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>
                  Configure <b>Max Units / Plate</b> above before generating plates (capacity is never assumed for custom products).
                </span>
              </div>
            )}
          </section>

          {/* Dynamic Variation Quantity Inputs (Color-agnostic until Plate Preview) */}
          <section className="bg-surface border border-line rounded-xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h4 className="text-sm font-semibold text-ink">
                  Product Options &amp; Quantities
                </h4>
                <p className="text-xs text-muted mt-0.5">
                  Enter variation quantities first. No filament color is required yet — you will select the physical Filament Color for each plate in Preview.
                </p>
              </div>
            </div>

            {inputModel.hasAmbiguousColorMapping && (
              <div className="p-3 rounded-lg border border-warning-border bg-warning-soft text-xs text-warning-text flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  Some <b className="font-semibold">{inputModel.colorOptionName || 'Color'}</b> option values on this product do not exactly match Workspace Filament Colors. All saved variations are shown explicitly below without guessing — select the corresponding physical Filament Color per plate in Preview.
                </span>
              </div>
            )}

            {/* Case A: Single Quantity Input (Standard base product OR single-Color product deduplicated across physical colors) */}
            {inputModel.displayMode === 'single_input' && (
              <div className="p-4 rounded-xl border border-line bg-recessed flex flex-wrap items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="text-xs font-semibold text-ink">
                    {selectedProduct.name} · Batch Quantity
                  </div>
                  {inputModel.isColorDeduplicated && inputModel.configuredColors.length > 0 ? (
                    <p className="text-[11px] text-muted">
                      Available physical colors ({inputModel.configuredColors.map((c) => c.rawValue).join(', ')}) — select filament color individually per generated plate below.
                    </p>
                  ) : (
                    <p className="text-[11px] text-muted">
                      Physical filament color is selected individually for each generated plate in Preview.
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <label
                    htmlFor="single-product-qty"
                    className="text-xs font-medium text-ink-secondary"
                  >
                    Quantity (pcs):
                  </label>
                  <input
                    id="single-product-qty"
                    type="number"
                    min={0}
                    step={1}
                    aria-label={`Print quantity for ${selectedProduct.name}`}
                    value={
                      quantitiesByKey[
                        buildCatalogSelectionKey(
                          selectedProduct.id,
                          inputModel.items[0]?.id !== 'base'
                            ? inputModel.items[0]?.id
                            : null
                        )
                      ] ?? 0
                    }
                    onChange={(e) => {
                      const val = Math.max(0, Math.floor(Number(e.target.value) || 0));
                      onChangeQuantity(
                        buildCatalogSelectionKey(
                          selectedProduct.id,
                          inputModel.items[0]?.id !== 'base'
                            ? inputModel.items[0]?.id
                            : null
                        ),
                        val
                      );
                      setStagedCatalogPlates(null);
                      setStagedBatchId(null);
                      setHasAttemptedConfirm(false);
                    }}
                    className="w-28 px-2.5 py-1.5 text-right rounded-lg border border-line bg-input text-sm font-mono-data font-bold text-ink focus:border-brand focus:outline-none"
                  />
                </div>
              </div>
            )}

            {/* Case B: Multi-Option Variation Grid (Alphabet A–Z, Designs, Sizes, or Explicit Variants) */}
            {inputModel.displayMode === 'variation_grid' && (
              <div className="space-y-2.5">
                {inputModel.isColorDeduplicated && inputModel.configuredColors.length > 0 && (
                  <div className="text-[11px] text-muted">
                    Available product colors: <span className="font-medium text-ink-secondary">{inputModel.configuredColors.map((c) => c.rawValue).join(', ')}</span> — assign each plate&apos;s Filament Color in Preview.
                  </div>
                )}
                <DynamicOptionQuantityGrid
                  product={selectedProduct}
                  items={inputModel.items}
                  quantitiesByKey={quantitiesByKey}
                  hasMultipleGroups={inputModel.effectiveOptions.length > 1}
                  secondaryGroupOption={inputModel.effectiveOptions[1] || null}
                  onChangeQuantity={onChangeQuantity}
                  onDirty={() => {
                    setStagedCatalogPlates(null);
                    setStagedBatchId(null);
                    setHasAttemptedConfirm(false);
                  }}
                />
              </div>
            )}

            {/* Action Bar: Total Summary & Generate Plate Preview */}
            <div className="pt-3 border-t border-line flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs text-ink-secondary font-mono-data">
                Target for <b className="font-sans text-ink">{selectedProduct.name}</b>:{' '}
                <b className="text-brand-text font-bold">{currentProductTotal} pcs</b>
                {parsedConfiguredCapacity !== null && currentProductTotal > 0 && (
                  <span>
                    {' '}· {Math.floor(currentProductTotal / parsedConfiguredCapacity)} full plate(s)
                    {currentProductTotal % parsedConfiguredCapacity > 0
                      ? ` + ${currentProductTotal % parsedConfiguredCapacity} pcs partial`
                      : ''}
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {parsedConfiguredCapacity !== null &&
                  currentProductTotal >= parsedConfiguredCapacity &&
                  currentProductTotal % parsedConfiguredCapacity > 0 && (
                    <button
                      type="button"
                      onClick={() => handlePreviewAutomatic(false)}
                      className="px-3.5 py-2 rounded-lg border border-line bg-surface hover:bg-elevated text-xs font-medium text-ink transition-colors"
                    >
                      Preview Full Plates Only
                    </button>
                  )}
                <button
                  type="button"
                  disabled={
                    currentProductTotal === 0 ||
                    parsedConfiguredCapacity === null
                  }
                  onClick={() => handlePreviewAutomatic(true)}
                  className="px-4 py-2 rounded-lg bg-brand hover:bg-brand-hover disabled:opacity-40 text-white text-xs font-semibold transition-colors cursor-pointer disabled:cursor-not-allowed"
                >
                  Generate Plate Preview
                </button>
              </div>
            </div>
          </section>

          {/* Staged Plate Preview: Independent Per-Plate Filament Color + Apply-to-All + Single-Color Batch Enforcement */}
          {stagedCatalogPlates && stagedCatalogPlates.length > 0 && (
            <section className="bg-surface border-2 border-brand rounded-xl p-6 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold text-ink">
                      Review &amp; Confirm Batch ({stagedCatalogPlates.length}{' '}
                      {stagedCatalogPlates.length === 1 ? 'plate' : 'plates'})
                    </h3>
                    {stagedBatchId && (
                      <span
                        data-testid="staged-batch-id-label"
                        className="text-[11px] font-mono-data text-muted"
                      >
                        · {stagedBatchId}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted mt-0.5">
                    One batch requires <b className="text-ink">1 Product + 1 Filament Color</b>. Apply one Filament Color across all plates below, or assign per plate and split into separate batches if mixed.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2.5">
                  {isAlphabetProductItems(getPlannableProductItems(selectedProduct)) && (
                    <button
                      type="button"
                      data-testid="export-all-plates-3mf"
                      disabled={isBatchExporting3mf || isConfirming}
                      onClick={() => void handleExportCatalogBatch3mf()}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-brand-border bg-brand-soft hover:bg-brand hover:text-white text-brand-text text-xs font-semibold disabled:opacity-50 whitespace-nowrap transition-colors cursor-pointer"
                    >
                      {isBatchExporting3mf ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Download className="w-3.5 h-3.5" />
                      )}
                      <span>
                        {isBatchExporting3mf
                          ? 'Exporting .3MF...'
                          : 'Export All Plates (.3MF)'}
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={isConfirming || isBatchExporting3mf}
                    onClick={() => {
                      setStagedCatalogPlates(null);
                      setStagedBatchId(null);
                      setStagedRequestMeta(null);
                      setBulkColorId('');
                      setHasAttemptedConfirm(false);
                    }}
                    className="px-3.5 py-2 rounded-lg border border-line bg-elevated text-xs font-medium text-ink hover:bg-recessed disabled:opacity-40 whitespace-nowrap transition-colors"
                  >
                    Discard Preview
                  </button>
                  <button
                    type="button"
                    disabled={
                      isConfirming ||
                      isBatchExporting3mf ||
                      Boolean(batchValidation?.hasColorConflict)
                    }
                    onClick={() => void handleConfirmClick(false)}
                    className="px-4 py-2 rounded-lg bg-brand hover:bg-brand-hover disabled:opacity-50 text-white text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer disabled:cursor-not-allowed"
                  >
                    {isConfirming ? 'Saving...' : 'Confirm & Save Batch to Queue'}
                  </button>
                </div>
              </div>

              {isBatchExporting3mf && batch3mfProgress && (
                <div
                  data-testid="batch-3mf-export-progress"
                  className="p-3 rounded-xl border border-brand-border bg-brand-soft/60 space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2 text-xs text-ink">
                    <span className="font-medium flex items-center gap-1.5">
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-brand-text shrink-0" />
                      <span>{batch3mfProgress.message}</span>
                    </span>
                    <span className="font-mono-data font-bold text-brand-text">
                      {batch3mfProgress.percent}%
                    </span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-recessed overflow-hidden">
                    <div
                      className="h-full bg-brand transition-all duration-200"
                      style={{
                        width: `${Math.min(100, Math.max(5, batch3mfProgress.percent))}%`,
                      }}
                    />
                  </div>
                </div>
              )}

              {/* Apply Color to All Plates Toolbar */}
              {stagedCatalogPlates.length > 1 && (
                <div className="p-3 rounded-xl border border-line bg-recessed flex flex-wrap items-center justify-between gap-3">
                  <div className="text-xs text-ink-secondary">
                    <span className="font-semibold text-ink">Apply Color to All Plates:</span>{' '}
                    Assign a single filament color to all {stagedCatalogPlates.length} plates in this batch at once.
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      aria-label="Select Filament Color for all staged plates"
                      value={bulkColorId}
                      onChange={(e) => {
                        const val = e.target.value;
                        setBulkColorId(val);
                        if (val) {
                          handleApplyColorToAllPlates(val);
                        }
                      }}
                      className="px-2.5 py-1.5 rounded-lg border border-line bg-input text-xs font-semibold text-ink focus:border-brand focus:outline-none"
                    >
                      <option value="">Select color for all plates...</option>
                      {(workspaceColors || []).map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={!bulkColorId || isConfirming}
                      onClick={() => handleApplyColorToAllPlates(bulkColorId)}
                      className="px-3 py-1.5 rounded-lg border border-line bg-surface hover:bg-elevated text-xs font-semibold text-ink disabled:opacity-40 whitespace-nowrap transition-colors"
                    >
                      Apply to All Plates
                    </button>
                  </div>
                </div>
              )}

              {/* Explicit Batch Color Conflict Notice & Resolution Options (Never silently splits) */}
              {batchValidation?.hasColorConflict && (
                <div
                  role="alert"
                  className="p-4 rounded-xl border border-warning-border bg-warning-soft text-xs text-warning-text space-y-3"
                >
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <div>
                      <div className="font-semibold">
                        Batch Color Conflict: Multiple Filament Colors Selected
                      </div>
                      <div className="mt-0.5 opacity-95">
                        {batchValidation.batchColorConflictError}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 pl-6">
                    {batchValidation.distinctColorIds.map((cid) => {
                      const col = workspaceColors.find((c) => c.id === cid);
                      if (!col) return null;
                      return (
                        <button
                          key={cid}
                          type="button"
                          disabled={isConfirming}
                          onClick={() => handleApplyColorToAllPlates(cid)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-warning-border bg-surface hover:bg-elevated text-ink font-semibold whitespace-nowrap transition-colors"
                        >
                          <span
                            className="w-2.5 h-2.5 rounded-full border border-line shrink-0"
                            style={{ backgroundColor: col.hex }}
                            aria-hidden="true"
                          />
                          <span>Apply {col.name} to All Plates</span>
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      disabled={isConfirming || batchValidation.invalidPlateNumbers.length > 0}
                      onClick={() => void handleConfirmClick(true)}
                      className="px-3.5 py-1.5 rounded-lg bg-brand hover:bg-brand-hover disabled:opacity-50 text-white font-semibold whitespace-nowrap transition-colors"
                    >
                      Split &amp; Confirm as Separate Batches by Color ({batchValidation.distinctColorIds.length})
                    </button>
                  </div>
                </div>
              )}

              {/* Batch Validation Summary Banner */}
              {hasAttemptedConfirm &&
                batchValidation &&
                batchValidation.invalidPlateNumbers.length > 0 && (
                <div
                  role="alert"
                  className="p-3.5 rounded-xl border border-status-error bg-error-soft text-xs text-error-text flex items-start gap-2.5"
                >
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold">
                      Cannot confirm batch: Fix validation issues on Plate{' '}
                      {batchValidation.invalidPlateNumbers.join(', Plate ')} before saving to Print Queue.
                    </div>
                    <div className="text-[11px] opacity-90 mt-0.5">
                      Every plate must have a valid physical Filament Color, positive quantity within capacity, and zero product/color conflicts.
                    </div>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {stagedCatalogPlates.map((plate) => {
                  const totalUnits = countCatalogItems(plate.items);
                  const plateColorObj = (workspaceColors || []).find(
                    (c) => c.id === plate.colorId
                  );
                  const valRes = batchValidation?.byTempId[plate.tempId];
                  const immediateBlockingErrors = valRes?.blockingErrors || [];
                  const inlineErrors = [
                    ...immediateBlockingErrors,
                    ...(hasAttemptedConfirm && valRes?.colorSelectionError
                      ? [valRes.colorSelectionError]
                      : []),
                  ];
                  const hasCardError = inlineErrors.length > 0;

                  return (
                    <div
                      key={plate.tempId}
                      data-testid={`staged-plate-card-${plate.plateNumber}`}
                      className={`rounded-xl border p-4 space-y-3 transition-colors ${
                        hasCardError
                          ? 'border-status-error bg-error-soft'
                          : 'border-line bg-elevated'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0 flex items-center gap-1.5 flex-wrap">
                          <span className="text-sm font-semibold text-ink whitespace-nowrap">
                            Plate {plate.plateNumber}
                          </span>
                          <span className="text-[11px] text-brand-text font-semibold truncate">
                            · {plate.productName || selectedProduct.name}
                          </span>
                          <span
                            data-testid={`staged-plate-code-${plate.plateNumber}`}
                            className="text-[11px] font-mono-data text-muted whitespace-nowrap"
                          >
                            {normalizePlateCode(plate.plateCode)
                              ? `WP-${normalizePlateCode(plate.plateCode)}`
                              : 'WP-·····'}
                          </span>
                        </div>
                        <span className="text-xs font-mono-data font-semibold text-ink shrink-0">
                          {plate.capacity !== null
                            ? `${totalUnits} / ${plate.capacity} pcs`
                            : `${totalUnits} pcs`}
                        </span>
                      </div>

                      {/* Authoritative Per-Plate Filament Color Selector */}
                      <div className="space-y-1">
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="text-muted font-medium">Filament Color *</span>
                          <div className="flex items-center gap-1.5 min-w-0">
                            {plateColorObj ? (
                              <span
                                className="w-2.5 h-2.5 rounded-full shrink-0 border border-line shadow-xs"
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
                              onChange={(e) =>
                                handleAssignPlateColor(plate.tempId, e.target.value)
                              }
                              className={`px-2 py-1 rounded-lg border bg-input text-xs font-semibold focus:border-brand focus:outline-none ${
                                hasAttemptedConfirm && valRes?.requiresColorSelection
                                  ? 'border-status-error text-error-text'
                                  : 'border-line text-ink'
                              }`}
                            >
                              <option value="">Select Filament Color</option>
                              {(workspaceColors || []).map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="text-muted">Bambu Studio Time:</span>
                        <DurationHMInput
                          compact
                          minutes={plate.estimatedMinutes}
                          onChangeMinutes={(mins) =>
                            setStagedCatalogPlates((prev) =>
                              prev
                                ? prev.map((p) =>
                                    p.tempId === plate.tempId
                                      ? { ...p, estimatedMinutes: mins }
                                      : p
                                  )
                                : null
                            )
                          }
                          ariaLabelPrefix={`Plate ${plate.plateNumber} duration`}
                        />
                      </div>

                      {/* Variation Breakdown */}
                      <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                        {plate.items.map((item, idx) => (
                          <div
                            key={`${item.productId}:${item.variantId || 'base'}:${idx}`}
                            className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-input border border-line text-xs"
                          >
                            <div className="min-w-0">
                              <div className="font-semibold text-ink truncate">
                                {item.variantLabel || item.productName}
                              </div>
                              <div className="text-[10px] font-mono-data text-muted">
                                {item.sku}
                              </div>
                            </div>
                            <input
                              type="number"
                              min={0}
                              step={1}
                              aria-label={`Plate ${plate.plateNumber} ${item.variantLabel || item.productName} quantity`}
                              value={item.quantity}
                              onChange={(e) =>
                                handleAdjustStagedItemQty(
                                  plate.tempId,
                                  idx,
                                  e.target.value
                                )
                              }
                              className="w-16 text-right font-mono-data font-bold bg-transparent text-ink focus:outline-none"
                            />
                          </div>
                        ))}
                      </div>

                      {/* Inline Per-Plate Validation Errors */}
                      {inlineErrors.length > 0 && (
                        <div
                          role="alert"
                          className="p-2 rounded-lg border border-status-error bg-surface/80 text-[11px] font-medium text-error-text space-y-1"
                        >
                          {inlineErrors.map((errMsg, errIdx) => (
                            <div key={errIdx}>{errMsg}</div>
                          ))}
                        </div>
                      )}

                      <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-line">
                        <label className="flex items-center gap-1.5 text-[11px] text-ink-secondary cursor-pointer">
                          <input
                            type="checkbox"
                            checked={plate.slicerVerified}
                            onChange={() =>
                              setStagedCatalogPlates((prev) =>
                                prev
                                  ? prev.map((p) =>
                                      p.tempId === plate.tempId
                                        ? { ...p, slicerVerified: !p.slicerVerified }
                                        : p
                                    )
                                  : null
                              )
                            }
                          />
                          <span>Physical bed fit verified in Bambu Studio</span>
                        </label>
                        {isAlphabetProductItems(getPlannableProductItems(selectedProduct)) && (
                          <button
                            type="button"
                            disabled={
                              Boolean(exportingPlateTempIds[plate.tempId]) ||
                              isBatchExporting3mf ||
                              countLetters(extractLettersMapFromCatalogItems(plate.items).letters) === 0
                            }
                            onClick={() => void handleExportCatalogPlate3mf(plate)}
                            data-testid={`export-3mf-plate-${plate.plateNumber}`}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-line bg-surface hover:bg-recessed text-[11px] font-semibold text-ink disabled:opacity-45 whitespace-nowrap transition-colors"
                          >
                            {exportingPlateTempIds[plate.tempId] ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin text-brand-text" />
                            ) : (
                              <Download className="w-3.5 h-3.5 text-brand-text" />
                            )}
                            <span>
                              {exportingPlateTempIds[plate.tempId]
                                ? 'Exporting...'
                                : 'Export 3MF'}
                            </span>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      ) : null}
    </div>
  );
};
