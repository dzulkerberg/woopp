import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  RotateCcw,
  Save,
  Store,
} from 'lucide-react';
import { countCatalogItems } from '../constants';
import {
  CatalogProduct,
  CategoryPlateSetting,
  ColorOption,
  ProductCategory,
  ProductionJob,
  ProductionProject,
} from '../types';
import {
  buildCatalogSelectionKey,
  CatalogPlannerSelectionInput,
  DraftCatalogPlatePreview,
  generateAutomaticCatalogPlatePreviews,
  getPlannableItemsForSelectedFilamentColor,
  getPlannableProductItems,
  validateCategoryForPlanning,
  validateStrictSingleProductPlateItems,
} from '../utils/catalogPlannerEngine';
import { DurationHMInput } from './DurationHMInput';
import { DynamicOptionQuantityGrid } from './DynamicOptionQuantityGrid';
import { CategoryIcon } from './product-studio/CategoryIcon';
import { formatMyrPrice } from './product-studio/ProductDetailModal';

export interface CatalogCategoryPlannerSectionProps {
  category: ProductCategory;
  categoryProducts: readonly CatalogProduct[];
  plateSetting: CategoryPlateSetting | null;
  currentProject: ProductionProject;
  selectedColor: ColorOption;
  workspaceColors?: readonly ColorOption[];
  existingJobs: readonly ProductionJob[];
  quantitiesByKey: Record<string, number>;
  highlightedProductId: string | null;
  allCategories?: readonly ProductCategory[];
  onSelectCategory?: (categoryId: string) => void;
  onSelectColor?: (colorId: string) => void;
  onChangeQuantity: (selectionKey: string, nextQty: number) => void;
  onSaveCategoryPlateSetting: (
    setting: Omit<CategoryPlateSetting, 'ownerId' | 'updatedAt'>
  ) => Promise<void>;
  onConfirmCatalogPlates: (
    category: ProductCategory,
    confirmedPlates: DraftCatalogPlatePreview[],
    onSuccess: () => void
  ) => void;
  onOpenProductStudio: () => void;
  onAlert: (msg: string, title?: string) => void;
  resetSignal: number;
}

/**
 * WOOPP 6.0 Auto Plate Planner Section:
 *
 * MANDATORY PRODUCTION INVARIANT:
 * ONE PLATE = ONE PRODUCT ID + ONE PHYSICAL FILAMENT COLOR.
 * - Variations of the SAME product can share a plate up to configured capacity.
 * - Different products NEVER share a plate.
 * - Different physical colors NEVER share a plate.
 *
 * WORKFLOW:
 * Select Category -> Select Product -> Select Filament Color -> Enter Quantities -> Generate Preview -> Confirm to Queue.
 */
export const CatalogCategoryPlannerSection: React.FC<
  CatalogCategoryPlannerSectionProps
> = ({
  category,
  categoryProducts,
  plateSetting,
  currentProject,
  selectedColor,
  workspaceColors = [],
  existingJobs,
  quantitiesByKey,
  highlightedProductId,
  allCategories = [],
  onSelectCategory,
  onSelectColor,
  onChangeQuantity,
  onSaveCategoryPlateSetting,
  onConfirmCatalogPlates,
  onOpenProductStudio,
  onAlert,
  resetSignal,
}) => {
  // Active products in the selected category
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

  // Sync selected product when category or highlightedProductId changes
  useEffect(() => {
    if (
      highlightedProductId &&
      activeCategoryProducts.some((p) => p.id === highlightedProductId)
    ) {
      setSelectedProductId(highlightedProductId);
      return;
    }
    if (
      !activeCategoryProducts.some((p) => p.id === selectedProductId) &&
      activeCategoryProducts.length > 0
    ) {
      setSelectedProductId(activeCategoryProducts[0].id);
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

  // Staged Plate Previews
  const [stagedCatalogPlates, setStagedCatalogPlates] = useState<
    DraftCatalogPlatePreview[] | null
  >(null);

  // Sync saved rule when category updates
  useEffect(() => {
    setCapacityInput(
      plateSetting?.plateCapacity !== null && plateSetting?.plateCapacity !== undefined
        ? String(plateSetting.plateCapacity)
        : ''
    );
    setDefaultMinutes(plateSetting?.defaultEstimatedMinutes || 180);
    setStagedCatalogPlates(null);
  }, [
    category.id,
    plateSetting?.plateCapacity,
    plateSetting?.defaultEstimatedMinutes,
  ]);

  // Handle parent Reset signal
  useEffect(() => {
    if (resetSignal === 0) return;
    setStagedCatalogPlates(null);
  }, [resetSignal]);

  const parsedConfiguredCapacity: number | null = useMemo(() => {
    const trimmed = capacityInput.trim();
    if (!trimmed) return null;
    const n = Math.floor(Number(trimmed));
    return Number.isFinite(n) && n >= 1 ? n : null;
  }, [capacityInput]);

  // Color-filtered items and compatibility check for the selected product (Section 4)
  const colorFilteredState = useMemo(() => {
    if (!selectedProduct) return null;
    return getPlannableItemsForSelectedFilamentColor(
      selectedProduct,
      selectedColor,
      workspaceColors
    );
  }, [selectedProduct, selectedColor, workspaceColors]);

  // Compute total entered quantity for the current selected product and filament color
  const currentProductTotal = useMemo(() => {
    if (!selectedProduct || !colorFilteredState || !colorFilteredState.isColorCompatible) {
      return 0;
    }
    let sum = 0;
    for (const item of colorFilteredState.items) {
      const key = buildCatalogSelectionKey(
        selectedProduct.id,
        item.id !== 'base' ? item.id : null,
        selectedColor.id
      );
      sum += Math.floor(Number(quantitiesByKey[key] || 0));
    }
    return sum;
  }, [selectedProduct, colorFilteredState, selectedColor.id, quantitiesByKey]);

  // Reset ONLY current editable planning quantities for this product and filament color
  const handleResetCurrentProduct = () => {
    if (!selectedProduct || !colorFilteredState) return;
    for (const item of colorFilteredState.items) {
      const key = buildCatalogSelectionKey(
        selectedProduct.id,
        item.id !== 'base' ? item.id : null,
        selectedColor.id
      );
      if ((quantitiesByKey[key] ?? 0) > 0) {
        onChangeQuantity(key, 0);
      }
    }
    setStagedCatalogPlates(null);
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
    if (!selectedProduct) {
      onAlert('Select a product first.');
      return;
    }
    if (!colorFilteredState || !colorFilteredState.isColorCompatible) {
      onAlert(
        `Selected filament color "${selectedColor.name}" is not compatible with "${selectedProduct.name}". Choose one of the available variation colors first.`,
        'Color Incompatibility'
      );
      return;
    }

    if (parsedConfiguredCapacity === null) {
      onAlert(
        `Configure a valid Max Units per Plate rule for "${category.name}" first (138 is never assumed).`,
        'Plate Capacity Required'
      );
      return;
    }

    // Build selections for ONLY this selected product and color!
    const selections: CatalogPlannerSelectionInput[] = [];
    for (const item of colorFilteredState.items) {
      const key = buildCatalogSelectionKey(
        selectedProduct.id,
        item.id !== 'base' ? item.id : null,
        selectedColor.id
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
      color: selectedColor,
      workspaceColors,
      category,
      products: [selectedProduct], // Strictly isolated to this single product!
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
        `Total selected quantity (${currentProductTotal} pcs) is less than 1 full plate (${parsedConfiguredCapacity} pcs). Use "Preview Full + Partial Plate" to include the partial plate.`,
        'No Full Plates'
      );
      return;
    }

    // Strict validation check on all generated previews
    for (const p of res.previews) {
      const singleCheck = validateStrictSingleProductPlateItems(
        p.items,
        selectedProduct.id,
        selectedColor.id,
        category.id
      );
      if (!singleCheck.valid) {
        onAlert(
          singleCheck.error || 'Strict plate validation failed.',
          'Strict Plate Isolation'
        );
        return;
      }
    }

    setStagedCatalogPlates(res.previews);
  };

  const handleAdjustStagedItemQty = (
    tempId: string,
    itemIndex: number,
    rawVal: string
  ) => {
    if (!stagedCatalogPlates) return;
    const nextQty = Math.max(0, Math.floor(Number(rawVal) || 0));
    setStagedCatalogPlates(
      stagedCatalogPlates.map((plate) => {
        if (plate.tempId !== tempId) return plate;
        const nextItems = plate.items.map((it, idx) =>
          idx === itemIndex ? { ...it, quantity: nextQty } : it
        );
        return {
          ...plate,
          items: nextItems,
        };
      })
    );
  };

  const handleConfirmClick = () => {
    if (!stagedCatalogPlates || stagedCatalogPlates.length === 0) return;

    for (const plate of stagedCatalogPlates) {
      const singleProdCheck = validateStrictSingleProductPlateItems(
        plate.items,
        selectedProduct?.id,
        plate.colorId || selectedColor.id,
        category.id
      );
      if (!singleProdCheck.valid) {
        onAlert(
          singleProdCheck.error || 'Strict plate validation failed.',
          'Plate Isolation Validation'
        );
        return;
      }
      const total = countCatalogItems(plate.items);
      if (total <= 0) {
        onAlert(
          `Plate ${plate.plateNumber} has 0 units. Adjust quantities before confirming.`
        );
        return;
      }
      if (plate.capacity !== null && total > plate.capacity) {
        onAlert(
          `Plate ${plate.plateNumber} (${total} pcs) exceeds configured capacity (${plate.capacity} pcs).`,
          'Plate Capacity Exceeded'
        );
        return;
      }
    }

    const cleanedPlates = stagedCatalogPlates.map((p) => ({
      ...p,
      items: p.items.filter((it) => Math.floor(Number(it.quantity || 0)) > 0),
    }));

    onConfirmCatalogPlates(category, cleanedPlates, () => {
      setStagedCatalogPlates(null);
      // Clear planned quantities for this product and color after successful commit
      if (selectedProduct && colorFilteredState) {
        for (const item of colorFilteredState.items) {
          const key = buildCatalogSelectionKey(
            selectedProduct.id,
            item.id !== 'base' ? item.id : null,
            selectedColor.id
          );
          onChangeQuantity(key, 0);
        }
      }
    });
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
      {/* 2-Step Dropdown Selector: Step 1 (Category) & Step 2 (Product) */}
      <section className="bg-surface border border-line rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-line">
          <div>
            <h2 className="text-sm font-semibold text-ink">
              Auto Plate Planner · Product &amp; Option Selection
            </h2>
            <p className="text-xs text-muted mt-0.5">
              Select a category and product to configure print quantities. Plates are strictly isolated: <b className="text-ink">ONE PLATE = ONE PRODUCT + ONE FILAMENT COLOR</b>.
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
          {/* Step 1: Category Dropdown */}
          <div>
            <label
              htmlFor="planner-category-select"
              className="block text-xs font-semibold text-ink-secondary mb-1"
            >
              1. Category
            </label>
            <select
              id="planner-category-select"
              value={category.id}
              onChange={(e) => {
                onSelectCategory?.(e.target.value);
                setStagedCatalogPlates(null);
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
      ) : selectedProduct ? (
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
                    <span>Filament: <b className="text-ink flex-inline items-center gap-1">{selectedColor.name}</b></span>
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

          {/* Dynamic Variation Quantity Inputs (Strictly for this selected product) */}
          <section className="bg-surface border border-line rounded-xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h4 className="text-sm font-semibold text-ink">
                  Product Options &amp; Quantities
                </h4>
                <p className="text-xs text-muted mt-0.5">
                  Filament Color: <b className="text-ink">{selectedColor.name}</b> · Enter non-negative integers. Quantities are stored independently per product and color.
                </p>
              </div>
            </div>

            {/* Case A: Incompatible Physical Color (Section 4) */}
            {colorFilteredState && colorFilteredState.displayMode === 'incompatible_color' && (
              <div className="p-4 rounded-xl border border-warning-border bg-warning-soft text-xs text-warning-text space-y-2.5">
                <div className="flex items-center gap-2 font-semibold">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>
                    Selected filament color &ldquo;{selectedColor.name}&rdquo; is not configured as an available variation for {selectedProduct.name}.
                  </span>
                </div>
                <p className="text-ink-secondary">
                  To plan plates for this product, select one of its configured variation colors:
                </p>
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  {colorFilteredState.availableColors.map((c) => (
                    <button
                      key={c.name}
                      type="button"
                      onClick={() => onSelectColor?.(c.colorId || c.name)}
                      className="px-2.5 py-1 rounded-lg border border-line bg-surface hover:bg-elevated text-xs font-medium text-ink flex items-center gap-1.5 transition-colors"
                    >
                      {c.hex && (
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0 border border-line"
                          style={{ backgroundColor: c.hex }}
                        />
                      )}
                      <span>Switch to {c.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Case B: Single Quantity Input (Base product or Color-only product matching selected filament) */}
            {colorFilteredState && colorFilteredState.displayMode === 'single_input' && (
              <div className="p-4 rounded-xl border border-line bg-recessed flex flex-wrap items-center justify-between gap-4">
                <div>
                  <div className="text-xs font-semibold text-ink">
                    {colorFilteredState.hasColorOption
                      ? `${selectedProduct.name} · ${selectedColor.name} Variation`
                      : `${selectedProduct.name} Standard Unit`}
                  </div>
                  <p className="text-[11px] text-muted mt-0.5">
                    Physical manufacturing filament color:{' '}
                    <b className="text-ink">{selectedColor.name}</b>
                  </p>
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
                          colorFilteredState.items[0]?.id !== 'base'
                            ? colorFilteredState.items[0]?.id
                            : null,
                          selectedColor.id
                        )
                      ] ?? 0
                    }
                    onChange={(e) => {
                      const val = Math.max(0, Math.floor(Number(e.target.value) || 0));
                      onChangeQuantity(
                        buildCatalogSelectionKey(
                          selectedProduct.id,
                          colorFilteredState.items[0]?.id !== 'base'
                            ? colorFilteredState.items[0]?.id
                            : null,
                          selectedColor.id
                        ),
                        val
                      );
                      setStagedCatalogPlates(null);
                    }}
                    className="w-28 px-2.5 py-1.5 text-right rounded-lg border border-line bg-input text-sm font-mono-data font-bold text-ink focus:border-brand focus:outline-none"
                  />
                </div>
              </div>
            )}

            {/* Case C: Multi-Option Variation Grid (Alphabet A–Z, Designs, Sizes) */}
            {colorFilteredState && colorFilteredState.displayMode === 'variation_grid' && (
              <DynamicOptionQuantityGrid
                product={selectedProduct}
                items={colorFilteredState.items}
                quantitiesByKey={quantitiesByKey}
                colorId={selectedColor.id}
                hasMultipleGroups={Boolean(
                  selectedProduct.options &&
                    selectedProduct.options.length > (colorFilteredState.hasColorOption ? 2 : 1)
                )}
                onChangeQuantity={onChangeQuantity}
                onDirty={() => setStagedCatalogPlates(null)}
              />
            )}

            {/* Action Bar: Total Summary & Generate Plate Preview */}
            <div className="pt-3 border-t border-line flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs text-ink-secondary font-mono-data">
                Target for <b className="font-sans text-ink">{selectedProduct.name}</b> ({selectedColor.name}):{' '}
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
                    parsedConfiguredCapacity === null ||
                    (colorFilteredState?.displayMode === 'incompatible_color')
                  }
                  onClick={() => handlePreviewAutomatic(true)}
                  className="px-4 py-2 rounded-lg bg-brand hover:bg-brand-hover disabled:opacity-40 text-white text-xs font-semibold transition-colors cursor-pointer disabled:cursor-not-allowed"
                >
                  Generate Plate Preview
                </button>
              </div>
            </div>
          </section>

          {/* Staged Plate Preview & Bambu Studio Fit Verification (Section 10) */}
          {stagedCatalogPlates && stagedCatalogPlates.length > 0 && (
            <section className="bg-surface border-2 border-brand rounded-xl p-6 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-ink">
                    Review &amp; Confirm Plates ({stagedCatalogPlates.length})
                  </h3>
                  <p className="text-xs text-muted mt-0.5">
                    Single-Product Strict Isolation: All plates contain ONLY <b className="text-ink">{selectedProduct.name}</b> in <b className="text-ink">{selectedColor.name}</b>.
                  </p>
                </div>

                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => setStagedCatalogPlates(null)}
                    className="px-3.5 py-2 rounded-lg border border-line bg-elevated text-xs font-medium text-ink hover:bg-recessed transition-colors"
                  >
                    Discard Preview
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmClick}
                    className="px-4 py-2 rounded-lg bg-brand hover:bg-brand-hover text-white text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer"
                  >
                    Confirm &amp; Save to Print Queue
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {stagedCatalogPlates.map((plate) => {
                  const totalUnits = countCatalogItems(plate.items);
                  const overCap =
                    plate.capacity !== null && totalUnits > plate.capacity;
                  const plateColorObj = (workspaceColors || []).find((c) => c.id === plate.colorId);

                  return (
                    <div
                      key={plate.tempId}
                      className={`rounded-xl border p-4 space-y-3 ${
                        overCap
                          ? 'border-status-error bg-error-soft'
                          : 'border-line bg-elevated'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <span className="text-sm font-semibold text-ink">
                            Plate {plate.plateNumber}
                          </span>
                          <span className="text-[11px] text-brand-text font-semibold ml-1.5">
                            · {plate.productName || selectedProduct.name}
                          </span>
                        </div>
                        <span className="text-xs font-mono-data font-semibold text-ink">
                          {plate.capacity !== null
                            ? `${totalUnits} / ${plate.capacity} pcs`
                            : `${totalUnits} pcs`}
                        </span>
                      </div>

                      {/* Authoritative Plate Printing Filament Color */}
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="text-muted font-medium">Filament Color:</span>
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
                            onChange={(e) => {
                              const nextCid = e.target.value || null;
                              const matchedC = (workspaceColors || []).find((c) => c.id === nextCid);
                              setStagedCatalogPlates((prev) =>
                                prev
                                  ? prev.map((p) =>
                                      p.tempId === plate.tempId
                                        ? {
                                            ...p,
                                            colorId: nextCid,
                                            colorName: matchedC ? matchedC.name : 'Unassigned Color',
                                          }
                                        : p
                                    )
                                  : null
                              );
                            }}
                            className="px-2 py-1 rounded-lg border border-line bg-input text-xs font-semibold text-ink focus:border-brand focus:outline-none"
                          >
                            <option value="">Unassigned Color</option>
                            {(workspaceColors || []).map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
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
                            key={`${item.productId}:${item.variantId || 'base'}`}
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

                      <label className="flex items-center gap-1.5 pt-2 border-t border-line text-[11px] text-ink-secondary cursor-pointer">
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
