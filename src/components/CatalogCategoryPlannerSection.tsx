import React, { useEffect, useMemo, useState } from 'react';
import { Layers, Plus, RotateCcw, Save, Sliders, Trash2 } from 'lucide-react';
import { countCatalogItems } from '../constants';
import {
  CatalogProduct,
  CategoryAllocationMode,
  CategoryPlateSetting,
  ColorOption,
  ProductCategory,
  ProductionJob,
  ProductionProject,
} from '../types';
import {
  buildCatalogSelectionKey,
  buildManualCatalogPlatePreviews,
  CatalogPlannerSelectionInput,
  DraftCatalogPlatePreview,
  generateAutomaticCatalogPlatePreviews,
  getPlannableProductItems,
  validateCategoryForPlanning,
  validateSameCategoryPlateItems,
} from '../utils/catalogPlannerEngine';
import { DurationHMInput } from './DurationHMInput';
import { DynamicOptionQuantityGrid } from './DynamicOptionQuantityGrid';
import { CategoryIcon } from './product-studio/CategoryIcon';
import { formatMyrPrice } from './product-studio/ProductDetailModal';

interface ManualDraftRow {
  rowId: string;
  productId: string;
  variantId: string | null;
  quantity: number;
}

interface ManualDraftPlate {
  draftPlateId: string;
  estimatedMinutes: number;
  slicerVerified: boolean;
  notes: string;
  rows: ManualDraftRow[];
}

interface CatalogCategoryPlannerSectionProps {
  category: ProductCategory;
  categoryProducts: readonly CatalogProduct[];
  plateSetting: CategoryPlateSetting | null;
  currentProject: ProductionProject;
  selectedColor: ColorOption;
  existingJobs: readonly ProductionJob[];
  quantitiesByKey: Record<string, number>;
  highlightedProductId: string | null;
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

export const CatalogCategoryPlannerSection: React.FC<
  CatalogCategoryPlannerSectionProps
> = ({
  category,
  categoryProducts,
  plateSetting,
  currentProject,
  selectedColor,
  existingJobs,
  quantitiesByKey,
  highlightedProductId,
  onChangeQuantity,
  onSaveCategoryPlateSetting,
  onConfirmCatalogPlates,
  onOpenProductStudio,
  onAlert,
  resetSignal,
}) => {
  const activeCategoryProducts = useMemo(
    () =>
      categoryProducts.filter(
        (p) => p.categoryId === category.id && p.status === 'active'
      ),
    [categoryProducts, category.id]
  );

  const [allocationMode, setAllocationMode] = useState<CategoryAllocationMode>(
    plateSetting?.allocationMode || 'automatic_capacity'
  );
  const [capacityInput, setCapacityInput] = useState<string>(
    plateSetting?.plateCapacity !== null && plateSetting?.plateCapacity !== undefined
      ? String(plateSetting.plateCapacity)
      : ''
  );
  const [defaultMinutes, setDefaultMinutes] = useState<number>(
    plateSetting?.defaultEstimatedMinutes || 180
  );
  const [isSavingRule, setIsSavingRule] = useState<boolean>(false);

  const [stagedCatalogPlates, setStagedCatalogPlates] = useState<
    DraftCatalogPlatePreview[] | null
  >(null);

  // Manual plate composition state
  const createBlankManualPlate = (defaultProd?: CatalogProduct): ManualDraftPlate => {
    const firstItem = defaultProd ? getPlannableProductItems(defaultProd)[0] : undefined;
    return {
      draftPlateId: `mplate-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      estimatedMinutes: defaultMinutes,
      slicerVerified: false,
      notes: '',
      rows: defaultProd
        ? [
            {
              rowId: `mrow-${Date.now()}-1`,
              productId: defaultProd.id,
              variantId: firstItem && firstItem.id !== 'base' ? firstItem.id : null,
              quantity: 0,
            },
          ]
        : [],
    };
  };

  const [manualPlates, setManualPlates] = useState<ManualDraftPlate[]>(() => [
    createBlankManualPlate(activeCategoryProducts[0]),
  ]);

  // Sync saved rule when switching category or receiving Firestore updates
  useEffect(() => {
    setAllocationMode(plateSetting?.allocationMode || 'automatic_capacity');
    setCapacityInput(
      plateSetting?.plateCapacity !== null && plateSetting?.plateCapacity !== undefined
        ? String(plateSetting.plateCapacity)
        : ''
    );
    setDefaultMinutes(plateSetting?.defaultEstimatedMinutes || 180);
    setStagedCatalogPlates(null);
  }, [
    category.id,
    plateSetting?.allocationMode,
    plateSetting?.plateCapacity,
    plateSetting?.defaultEstimatedMinutes,
  ]);

  // Respond to parent `Reset` button signal: zero manual plate quantities & clear preview
  useEffect(() => {
    if (resetSignal === 0) return;
    setStagedCatalogPlates(null);
    setManualPlates([createBlankManualPlate(activeCategoryProducts[0])]);
  }, [resetSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  const parsedConfiguredCapacity: number | null = useMemo(() => {
    const trimmed = capacityInput.trim();
    if (!trimmed) return null;
    const n = Math.floor(Number(trimmed));
    return Number.isFinite(n) && n >= 1 ? n : null;
  }, [capacityInput]);

  const selectionsList: CatalogPlannerSelectionInput[] = useMemo(() => {
    const out: CatalogPlannerSelectionInput[] = [];
    for (const prod of activeCategoryProducts) {
      const items = getPlannableProductItems(prod);
      const isConfiguredVariants =
        items.length > 1 || (items.length === 1 && items[0].id !== 'base');

      if (isConfiguredVariants) {
        for (const item of items) {
          const key = buildCatalogSelectionKey(prod.id, item.id);
          const qty = Math.floor(Number(quantitiesByKey[key] || 0));
          if (qty > 0) {
            out.push({ productId: prod.id, variantId: item.id, quantity: qty });
          }
        }
      } else {
        const key = buildCatalogSelectionKey(prod.id, null);
        const qty = Math.floor(Number(quantitiesByKey[key] || 0));
        if (qty > 0) {
          out.push({ productId: prod.id, variantId: null, quantity: qty });
        }
      }
    }
    return out;
  }, [activeCategoryProducts, quantitiesByKey]);

  const totalSelectedUnits = useMemo(
    () => selectionsList.reduce((s, item) => s + item.quantity, 0),
    [selectionsList]
  );

  const categoryCheck = validateCategoryForPlanning(category);

  const handleSaveRuleClick = async () => {
    if (isSavingRule) return;
    if (allocationMode === 'automatic_capacity' && parsedConfiguredCapacity === null) {
      onAlert(
        `Enter a valid Max Units per Plate (>= 1) for "${category.name}" before saving an automatic capacity rule, or switch to Manual Plate Composition.`,
        'Category Plate Rule'
      );
      return;
    }

    setIsSavingRule(true);
    try {
      await onSaveCategoryPlateSetting({
        categoryId: category.id,
        allocationMode,
        plateCapacity: parsedConfiguredCapacity,
        defaultEstimatedMinutes: defaultMinutes,
      });
    } finally {
      setIsSavingRule(false);
    }
  };

  const handlePreviewAutomatic = (includePartial: boolean) => {
    const res = generateAutomaticCatalogPlatePreviews({
      existingJobs,
      project: currentProject,
      color: selectedColor,
      category,
      products: activeCategoryProducts,
      selections: selectionsList,
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
        `Total selected quantity (${totalSelectedUnits} pcs) is less than 1 full plate (${parsedConfiguredCapacity} pcs). Use "Preview Full + Partial Plate" to include the partial plate.`,
        'No Full Plates'
      );
      return;
    }
    setStagedCatalogPlates(res.previews);
  };

  const handlePreviewManual = () => {
    const res = buildManualCatalogPlatePreviews({
      existingJobs,
      project: currentProject,
      color: selectedColor,
      category,
      products: activeCategoryProducts,
      manualPlates: manualPlates.map((mp) => ({
        selections: mp.rows.map((r) => ({
          productId: r.productId,
          variantId: r.variantId,
          quantity: r.quantity,
        })),
        estimatedMinutes: mp.estimatedMinutes,
        slicerVerified: mp.slicerVerified,
        notes: mp.notes,
      })),
      configuredCapacity: parsedConfiguredCapacity,
    });

    if (res.error || !res.previews) {
      onAlert(res.error || 'Unable to build manual plate preview.', 'Manual Plate Validation');
      return;
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
      const mixCheck = validateSameCategoryPlateItems(plate.items, category.id);
      if (!mixCheck.valid) {
        onAlert(mixCheck.error || 'Cross-category mixing is not allowed.', 'Category Mixing Rule');
        return;
      }
      const total = countCatalogItems(plate.items);
      if (total <= 0) {
        onAlert(`Plate ${plate.plateNumber} has 0 units. Adjust quantities before confirming.`);
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
    });
  };

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
      {/* Category Plate Rule Configurator (Never assumes 138 for custom categories) */}
      <section className="bg-surface border border-line rounded-xl p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg border border-brand-border bg-brand-soft text-brand-text flex items-center justify-center shrink-0">
              <CategoryIcon name={category.iconName} className="w-4 h-4" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-ink">
                  {category.name}
                </h2>
                <span className="text-xs text-muted">
                  · Same-category plate sharing enabled (`{category.id}`)
                </span>
              </div>
              <p className="text-xs text-muted mt-0.5">
                Products in <b className="text-ink">{category.name}</b> can share plates together and are never mixed with other categories.
              </p>
            </div>
          </div>

          <div
            role="group"
            aria-label="Category plate allocation mode"
            className="inline-flex flex-wrap items-center gap-1 p-1 rounded-xl bg-recessed border border-line"
          >
            <button
              type="button"
              onClick={() => {
                setAllocationMode('automatic_capacity');
                setStagedCatalogPlates(null);
              }}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                allocationMode === 'automatic_capacity'
                  ? 'bg-brand text-white'
                  : 'text-ink-secondary hover:text-ink'
              }`}
            >
              <Sliders className="w-3.5 h-3.5" />
              <span>Category Capacity Rule</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setAllocationMode('manual_plate');
                setStagedCatalogPlates(null);
              }}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                allocationMode === 'manual_plate'
                  ? 'bg-brand text-white'
                  : 'text-ink-secondary hover:text-ink'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              <span>Manual Plate Composition</span>
            </button>
          </div>
        </div>

        <div className="p-4 rounded-xl bg-recessed border border-line flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label
                htmlFor="cat-plate-cap-input"
                className="block text-xs font-semibold text-ink-secondary mb-1"
              >
                Max Units / Plate {allocationMode === 'automatic_capacity' ? '*' : '(Optional Cap)'}
              </label>
              <input
                id="cat-plate-cap-input"
                type="number"
                min={1}
                max={5000}
                placeholder="Not set (configure)"
                value={capacityInput}
                onChange={(e) => {
                  setCapacityInput(e.target.value);
                  setStagedCatalogPlates(null);
                }}
                className="w-40 px-3 py-1.5 rounded-lg border border-line bg-input text-xs font-mono-data text-ink focus:border-brand focus:outline-none"
              />
            </div>

            <div>
              <span className="block text-xs font-semibold text-ink-secondary mb-1">
                Default Bambu Est. Duration
              </span>
              <DurationHMInput
                compact
                minutes={defaultMinutes}
                onChangeMinutes={(mins) => {
                  setDefaultMinutes(mins);
                  setStagedCatalogPlates(null);
                }}
                ariaLabelPrefix={`${category.name} default plate duration`}
              />
            </div>
          </div>

          <button
            type="button"
            disabled={isSavingRule}
            onClick={() => void handleSaveRuleClick()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-line bg-surface hover:bg-elevated text-xs font-semibold text-ink disabled:opacity-50 transition-colors"
          >
            <Save className="w-3.5 h-3.5 text-brand-text" />
            <span>{isSavingRule ? 'Saving Rule...' : 'Save Category Plate Rule'}</span>
          </button>
        </div>

        {allocationMode === 'automatic_capacity' && parsedConfiguredCapacity === null && (
          <div className="p-3 rounded-lg border border-warning-border bg-warning-soft text-xs text-warning-text">
            No plate capacity is configured for <b>{category.name}</b> yet (138 is never assumed for custom categories). Enter <b>Max Units / Plate</b> above or switch to <b>Manual Plate Composition</b>.
          </div>
        )}
      </section>

      {/* Empty Category State */}
      {activeCategoryProducts.length === 0 ? (
        <section className="bg-surface border border-line rounded-xl p-8 text-center space-y-2.5">
          <div className="text-sm font-semibold text-ink">
            No active products in &ldquo;{category.name}&rdquo;
          </div>
          <p className="text-xs text-muted">
            Add or restore products in Product Studio under this category to plan print plates.
          </p>
          <button
            type="button"
            onClick={onOpenProductStudio}
            className="px-4 py-2 rounded-lg bg-brand hover:bg-brand-hover text-white text-xs font-semibold transition-colors"
          >
            Add Products in Product Studio
          </button>
        </section>
      ) : allocationMode === 'automatic_capacity' ? (
        /* Mode A: Automatic Category Capacity Product Grid */
        <section className="bg-surface border border-line rounded-xl p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-ink">
                Select Products &amp; Print Quantities ({activeCategoryProducts.length} available)
              </h3>
              <p className="text-xs text-muted mt-0.5">
                Target Project: <b className="text-ink">{currentProject.name}</b> · Filament Color:{' '}
                <b className="text-ink">{selectedColor.name}</b> · Selected Total:{' '}
                <b className="font-mono-data text-brand-text">{totalSelectedUnits} pcs</b>
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {activeCategoryProducts.map((product) => {
              const isHighlighted = highlightedProductId === product.id;
              const thumb = product.images[0] || null;
              const plannableItems = getPlannableProductItems(product);
              const hasConfiguredOptions =
                (product.options && product.options.length > 0) ||
                (product.variants && product.variants.length > 0) ||
                (plannableItems.length > 1 || (plannableItems.length === 1 && plannableItems[0].id !== 'base'));

              // Compute real-time product total dynamically from individual inputs
              let productTotal = 0;
              if (hasConfiguredOptions) {
                for (const item of plannableItems) {
                  const key = buildCatalogSelectionKey(product.id, item.id);
                  productTotal += quantitiesByKey[key] ?? 0;
                }
              } else {
                const key = buildCatalogSelectionKey(product.id, null);
                productTotal = quantitiesByKey[key] ?? 0;
              }

              const handleResetProductQuantities = () => {
                if (hasConfiguredOptions) {
                  for (const item of plannableItems) {
                    const key = buildCatalogSelectionKey(product.id, item.id);
                    if ((quantitiesByKey[key] ?? 0) > 0) {
                      onChangeQuantity(key, 0);
                    }
                  }
                } else {
                  const key = buildCatalogSelectionKey(product.id, null);
                  if ((quantitiesByKey[key] ?? 0) > 0) {
                    onChangeQuantity(key, 0);
                  }
                }
                setStagedCatalogPlates(null);
              };

              // Detect multiple option groups (e.g. Letter + Color)
              const hasMultipleGroups = Boolean(product.options && product.options.length > 1);

              return (
                <div
                  key={product.id}
                  className={`rounded-xl border p-4 space-y-3 transition-colors ${
                    isHighlighted
                      ? 'border-brand ring-1 ring-brand bg-brand-soft/40'
                      : 'border-line bg-elevated'
                  } ${hasConfiguredOptions ? 'col-span-1 md:col-span-2 lg:col-span-3' : ''}`}
                >
                  {/* Product Header: thumbnail, name, SKU, price, real-time total, and compact Reset button */}
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      {thumb ? (
                        <img
                          src={thumb}
                          alt={product.name}
                          className="w-11 h-11 rounded-lg object-cover border border-line bg-recessed shrink-0"
                        />
                      ) : (
                        <div className="w-11 h-11 rounded-lg border border-line bg-recessed flex items-center justify-center text-muted shrink-0">
                          <CategoryIcon name={category.iconName} className="w-5 h-5 text-ink-secondary" />
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-ink truncate leading-tight">
                          {product.name}
                        </div>
                        <div className="text-[11px] font-mono-data text-muted mt-0.5">
                          {product.sku} · {formatMyrPrice(product.priceMyr)}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <div className="text-xs font-mono-data bg-recessed/80 border border-line/80 px-2.5 py-1 rounded-lg flex items-center gap-1.5">
                        <span className="text-[11px] text-muted uppercase tracking-wider font-sans">Total</span>
                        <span className="font-bold text-ink">{productTotal} pcs</span>
                      </div>
                      <button
                        type="button"
                        onClick={handleResetProductQuantities}
                        disabled={productTotal === 0}
                        title={`Reset ${product.name} quantity inputs to 0`}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-line bg-surface hover:bg-recessed text-xs font-semibold text-ink disabled:opacity-35 transition-colors cursor-pointer disabled:cursor-not-allowed"
                      >
                        <RotateCcw className="w-3 h-3 text-ink-secondary" />
                        <span>Reset</span>
                      </button>
                    </div>
                  </div>

                  {/* Quantity Inputs Section */}
                  {hasConfiguredOptions ? (
                    <DynamicOptionQuantityGrid
                      product={product}
                      items={plannableItems}
                      quantitiesByKey={quantitiesByKey}
                      hasMultipleGroups={hasMultipleGroups}
                      onChangeQuantity={onChangeQuantity}
                      onDirty={() => setStagedCatalogPlates(null)}
                    />
                  ) : (
                    <div className="flex items-center justify-between gap-2 pt-2 border-t border-line/60">
                      <span className="text-xs font-medium text-ink-secondary">
                        Print Quantity (pcs)
                      </span>
                      <input
                        type="number"
                        min={0}
                        step={1}
                        aria-label={`Quantity for ${product.name}`}
                        value={quantitiesByKey[buildCatalogSelectionKey(product.id, null)] ?? 0}
                        onChange={(e) => {
                          onChangeQuantity(
                            buildCatalogSelectionKey(product.id, null),
                            Math.max(0, Math.floor(Number(e.target.value) || 0))
                          );
                          setStagedCatalogPlates(null);
                        }}
                        className="w-28 px-2.5 py-1.5 text-right rounded-lg border border-line bg-input text-xs font-mono-data font-semibold text-ink focus:border-brand focus:outline-none"
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="p-4 rounded-xl bg-recessed border border-line flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-ink-secondary font-mono-data">
              Selected in <b className="font-sans text-ink">{category.name}</b>:{' '}
              <b className="text-ink">{totalSelectedUnits}</b> pcs
              {parsedConfiguredCapacity !== null && totalSelectedUnits > 0 && (
                <span>
                  {' '}
                  · {Math.floor(totalSelectedUnits / parsedConfiguredCapacity)} full plate(s)
                  {totalSelectedUnits % parsedConfiguredCapacity > 0
                    ? ` + ${totalSelectedUnits % parsedConfiguredCapacity} pcs partial`
                    : ''}
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {parsedConfiguredCapacity !== null &&
                totalSelectedUnits >= parsedConfiguredCapacity &&
                totalSelectedUnits % parsedConfiguredCapacity > 0 && (
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
                disabled={totalSelectedUnits === 0 || parsedConfiguredCapacity === null}
                onClick={() => handlePreviewAutomatic(true)}
                className="px-4 py-2 rounded-lg bg-brand hover:bg-brand-hover disabled:opacity-40 text-white text-xs font-semibold transition-colors"
              >
                Generate Plate Preview
              </button>
            </div>
          </div>
        </section>
      ) : (
        /* Mode B: Manual Plate Composition */
        <section className="bg-surface border border-line rounded-xl p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-ink">
                Manual Plate Composition · {category.name}
              </h3>
              <p className="text-xs text-muted mt-0.5">
                Compose plates manually using products from <b>{category.name}</b> without assuming a fixed 138 capacity.
              </p>
            </div>

            <button
              type="button"
              onClick={() =>
                setManualPlates((prev) => [
                  ...prev,
                  createBlankManualPlate(activeCategoryProducts[0]),
                ])
              }
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-line bg-elevated hover:bg-recessed text-xs font-semibold text-ink transition-colors"
            >
              <Plus className="w-3.5 h-3.5 text-brand-text" />
              <span>Add Manual Plate</span>
            </button>
          </div>

          <div className="space-y-4">
            {manualPlates.map((mp, pIdx) => (
              <div
                key={mp.draftPlateId}
                className="p-4 rounded-xl border border-line bg-recessed space-y-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-bold text-ink">
                    Draft Manual Plate #{pIdx + 1}
                  </span>

                  <div className="flex items-center gap-3">
                    <DurationHMInput
                      compact
                      minutes={mp.estimatedMinutes}
                      onChangeMinutes={(mins) =>
                        setManualPlates((prev) =>
                          prev.map((p) =>
                            p.draftPlateId === mp.draftPlateId
                              ? { ...p, estimatedMinutes: mins }
                              : p
                          )
                        )
                      }
                      ariaLabelPrefix={`Manual plate ${pIdx + 1} duration`}
                    />
                    {manualPlates.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          setManualPlates((prev) =>
                            prev.filter((p) => p.draftPlateId !== mp.draftPlateId)
                          )
                        }
                        className="p-1.5 rounded-lg border border-error-border bg-error-soft text-error-text"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  {mp.rows.map((row) => {
                    const selectedProd =
                      activeCategoryProducts.find((p) => p.id === row.productId) ||
                      activeCategoryProducts[0];
                    return (
                      <div
                        key={row.rowId}
                        className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center"
                      >
                        <div className="sm:col-span-5">
                          <select
                            value={selectedProd?.id || ''}
                            onChange={(e) => {
                              const nextProd = activeCategoryProducts.find(
                                (p) => p.id === e.target.value
                              );
                              setManualPlates((prev) =>
                                prev.map((p) =>
                                  p.draftPlateId === mp.draftPlateId
                                    ? {
                                        ...p,
                                        rows: p.rows.map((r) =>
                                          r.rowId === row.rowId
                                            ? {
                                                ...r,
                                                productId: nextProd?.id || '',
                                                variantId:
                                                  nextProd?.variants[0]?.id ?? null,
                                              }
                                            : r
                                        ),
                                      }
                                    : p
                                )
                              );
                            }}
                            className="w-full px-2.5 py-1.5 rounded-lg border border-line bg-input text-xs text-ink"
                          >
                            {activeCategoryProducts.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name} ({p.sku})
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="sm:col-span-4">
                          {(() => {
                            if (!selectedProd) return null;
                            const plannableItems = getPlannableProductItems(selectedProd);
                            const hasVariants =
                              plannableItems.length > 1 ||
                              (plannableItems.length === 1 && plannableItems[0].id !== 'base');

                            if (!hasVariants) {
                              return (
                                <span className="text-xs text-muted px-2">
                                  Standard item
                                </span>
                              );
                            }

                            return (
                              <select
                                value={row.variantId || plannableItems[0]?.id || ''}
                                onChange={(e) =>
                                  setManualPlates((prev) =>
                                    prev.map((p) =>
                                      p.draftPlateId === mp.draftPlateId
                                        ? {
                                            ...p,
                                            rows: p.rows.map((r) =>
                                              r.rowId === row.rowId
                                                ? { ...r, variantId: e.target.value }
                                                : r
                                            ),
                                          }
                                        : p
                                    )
                                  )
                                }
                                className="w-full px-2.5 py-1.5 rounded-lg border border-line bg-input text-xs text-ink"
                              >
                                {plannableItems.map((v) => (
                                  <option key={v.id} value={v.id}>
                                    {v.label}
                                  </option>
                                ))}
                              </select>
                            );
                          })()}
                        </div>

                        <div className="sm:col-span-2">
                          <input
                            type="number"
                            min={0}
                            step={1}
                            placeholder="Qty"
                            value={row.quantity}
                            onChange={(e) =>
                              setManualPlates((prev) =>
                                prev.map((p) =>
                                  p.draftPlateId === mp.draftPlateId
                                    ? {
                                        ...p,
                                        rows: p.rows.map((r) =>
                                          r.rowId === row.rowId
                                            ? {
                                                ...r,
                                                quantity: Math.max(
                                                  0,
                                                  Math.floor(Number(e.target.value) || 0)
                                                ),
                                              }
                                            : r
                                        ),
                                      }
                                    : p
                                )
                              )
                            }
                            className="w-full px-2.5 py-1.5 rounded-lg border border-line bg-input text-xs font-mono-data text-right text-ink"
                          />
                        </div>

                        <div className="sm:col-span-1 text-right">
                          {mp.rows.length > 1 && (
                            <button
                              type="button"
                              onClick={() =>
                                setManualPlates((prev) =>
                                  prev.map((p) =>
                                    p.draftPlateId === mp.draftPlateId
                                      ? {
                                          ...p,
                                          rows: p.rows.filter(
                                            (r) => r.rowId !== row.rowId
                                          ),
                                        }
                                      : p
                                  )
                                )
                              }
                              className="p-1 text-muted hover:text-error-text"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  <button
                    type="button"
                    onClick={() =>
                      setManualPlates((prev) =>
                        prev.map((p) =>
                          p.draftPlateId === mp.draftPlateId
                            ? {
                                ...p,
                                rows: [
                                  ...p.rows,
                                  {
                                    rowId: `mrow-${Date.now()}-${Math.random()
                                      .toString(36)
                                      .slice(2, 5)}`,
                                    productId: activeCategoryProducts[0].id,
                                    variantId:
                                      activeCategoryProducts[0].variants[0]?.id ?? null,
                                    quantity: 0,
                                  },
                                ],
                              }
                            : p
                        )
                      )
                    }
                    className="text-xs font-semibold text-brand-text hover:underline"
                  >
                    + Add Product Row on Plate #{pIdx + 1}
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={handlePreviewManual}
              className="px-4 py-2 rounded-lg bg-brand hover:bg-brand-hover text-white text-xs font-semibold transition-colors"
            >
              Generate Manual Plate Preview
            </button>
          </div>
        </section>
      )}

      {/* Staged Plate Preview & Bambu Studio Fit Verification */}
      {stagedCatalogPlates && stagedCatalogPlates.length > 0 && (
        <section className="bg-surface border-2 border-brand rounded-xl p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-ink">
                Review &amp; Confirm {category.name} Plates ({stagedCatalogPlates.length})
              </h3>
              <p className="text-xs text-muted mt-0.5">
                All items on each plate belong to <b>{category.name}</b>. Verify physical bed fit in Bambu Studio before printing.
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
                className="px-4 py-2 rounded-lg bg-brand hover:bg-brand-hover text-white text-xs font-semibold whitespace-nowrap transition-colors"
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
                        · {plate.categoryName}
                      </span>
                    </div>
                    <span className="text-xs font-mono-data font-semibold text-ink">
                      {plate.capacity !== null
                        ? `${totalUnits} / ${plate.capacity} pcs`
                        : `${totalUnits} pcs`}
                    </span>
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

                  <div className="space-y-1.5">
                    {plate.items.map((item, idx) => (
                      <div
                        key={`${item.productId}:${item.variantId || 'base'}`}
                        className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-input border border-line text-xs"
                      >
                        <div className="min-w-0">
                          <div className="font-semibold text-ink truncate">
                            {item.productName}
                            {item.variantLabel ? ` (${item.variantLabel})` : ''}
                          </div>
                          <div className="text-[10px] font-mono-data text-muted">
                            {item.sku}
                          </div>
                        </div>
                        <input
                          type="number"
                          min={0}
                          step={1}
                          aria-label={`Plate ${plate.plateNumber} ${item.productName} quantity`}
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
  );
};


