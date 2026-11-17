import {
  ABC,
  CHARM_IDS,
  compactCharmsMap,
  compactLettersMap,
  countCatalogItems,
  countCharms,
  countLetters,
  emptyAlphabetMap,
  emptyCharmsMap,
  normalizeAlphabetMap,
  normalizeCharmsMap,
} from '../constants';
import {
  CatalogProduct,
  CategoryPlateSetting,
  CharmId,
  CharmsMap,
  ColorOption,
  JobCatalogItemSnapshot,
  LettersMap,
  PlateGenerationMode,
  ProductCategory,
  ProductOptionDefinition,
  ProductionJob,
  ProductionProject,
  ProductionWorkspaceV5,
} from '../types';
import { DEFAULT_TIMEZONE } from './dateFormat';
import {
  createActivityLogEntry,
  DraftPlatePreview,
  inferPlateMode,
} from './productionEngine';
import { syncVariantsFromOptions } from './catalogValidation';

export interface CatalogPlannerSelectionInput {
  productId: string;
  variantId: string | null;
  quantity: number;
}

export interface PlannableProductItem {
  id: string;
  label: string;
  optionValues?: Record<string, string>;
  priceMyr?: number | null;
  sortOrder: number;
}

/**
 * Resolves plannable items for a product by checking:
 * 1. Saved `product.variants` if populated and non-empty.
 * 2. Dynamically deriving variants from `product.options` (e.g. 26 alphabet letters, colors, charms, or custom option values)
 *    when variants are stored in the scalable subcollection or when options are configured.
 * 3. Fallback to a single base item (`id: 'base'`) if the product has neither options nor variants.
 */
export function getPlannableProductItems(
  product: CatalogProduct
): PlannableProductItem[] {
  if (product.options && product.options.length > 0) {
    if (product.variants && product.variants.length > 0) {
      return product.variants.map((v) => ({
        id: v.id,
        label: v.label,
        optionValues: v.optionValues,
        priceMyr: v.priceMyr,
        sortOrder: v.sortOrder,
      }));
    }
    const derived = syncVariantsFromOptions(product.options, product.variants || []);
    if (derived.length > 0) {
      return derived.map((v) => ({
        id: v.id,
        label: v.label,
        optionValues: v.optionValues,
        priceMyr: v.priceMyr,
        sortOrder: v.sortOrder,
      }));
    }
  }

  if (product.variants && product.variants.length > 0) {
    return product.variants.map((v) => ({
      id: v.id,
      label: v.label,
      optionValues: v.optionValues,
      priceMyr: v.priceMyr,
      sortOrder: v.sortOrder,
    }));
  }

  return [
    {
      id: 'base',
      label: product.name,
      sortOrder: 0,
    },
  ];
}

/**
 * Checks whether an array of plannable items represents an alphabet grid
 * (e.g. 26 letters A–Z or single uppercase letter characters).
 */
export function isAlphabetProductItems(
  items: readonly PlannableProductItem[]
): boolean {
  if (items.length === 0) return false;
  if (
    items.length === 26 &&
    items.every((it) => it.label.length === 1 && /[A-Za-z]/.test(it.label))
  ) {
    return true;
  }
  return (
    items.length >= 2 &&
    items.every((it) => it.label.length === 1 && ABC.includes(it.label.toUpperCase() as any))
  );
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const COLOR_AGNOSTIC_BASE_ITEM_ID = '__color_agnostic_base__';
export const NON_COLOR_COMBO_PREFIX = '__noncolor__::';

export interface WorkspaceColorMatchDetail {
  color: ColorOption | null;
  ambiguous: boolean;
  candidates: ColorOption[];
}

/**
 * Resolves an option value string against workspace filament colors WITHOUT loose substring guessing.
 * Matches only by exact color ID or exact case-insensitive color name.
 */
export function matchWorkspaceColorValue(
  rawValue: string | null | undefined,
  workspaceColors: readonly ColorOption[]
): WorkspaceColorMatchDetail {
  if (!rawValue || typeof rawValue !== 'string' || !workspaceColors || workspaceColors.length === 0) {
    return { color: null, ambiguous: false, candidates: [] };
  }
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return { color: null, ambiguous: false, candidates: [] };
  }
  const cleanVal = trimmed.toLowerCase();

  const exactIdMatches = workspaceColors.filter((c) => c.id === trimmed);
  if (exactIdMatches.length === 1) {
    return { color: exactIdMatches[0], ambiguous: false, candidates: exactIdMatches };
  }

  const exactNameMatches = workspaceColors.filter(
    (c) => c.name.trim().toLowerCase() === cleanVal
  );
  if (exactNameMatches.length === 1) {
    return { color: exactNameMatches[0], ambiguous: false, candidates: exactNameMatches };
  }
  if (exactNameMatches.length > 1) {
    return { color: null, ambiguous: true, candidates: exactNameMatches };
  }

  return { color: null, ambiguous: false, candidates: [] };
}

export interface VariantColorConstraintResult {
  status: 'matched' | 'ambiguous' | 'unmapped_color_option' | 'none';
  color: ColorOption | null;
  candidates: ColorOption[];
  rawColorValue?: string;
}

/**
 * Resolves whether a product variant explicitly constrains physical filament color,
 * avoiding heuristic substring guessing when multiple colors could match.
 */
export function resolveVariantColorConstraint(
  variant: {
    label?: string | null;
    optionValues?: Record<string, string> | null;
  } | null | undefined,
  workspaceColors: readonly ColorOption[]
): VariantColorConstraintResult {
  if (!variant || !workspaceColors || workspaceColors.length === 0) {
    return { status: 'none', color: null, candidates: [] };
  }

  if (variant.optionValues) {
    for (const [groupName, val] of Object.entries(variant.optionValues)) {
      if (!val || typeof val !== 'string') continue;
      const valMatch = matchWorkspaceColorValue(val, workspaceColors);
      if (valMatch.ambiguous) {
        return {
          status: 'ambiguous',
          color: null,
          candidates: valMatch.candidates,
          rawColorValue: val.trim(),
        };
      }
      if (valMatch.color) {
        return {
          status: 'matched',
          color: valMatch.color,
          candidates: [valMatch.color],
          rawColorValue: val.trim(),
        };
      }

      if (/^(color|colour|warna|filament)$/i.test(groupName.trim())) {
        return {
          status: 'unmapped_color_option',
          color: null,
          candidates: [],
          rawColorValue: val.trim(),
        };
      }
    }
  }

  if (variant.label && typeof variant.label === 'string') {
    const labelMatch = matchWorkspaceColorValue(variant.label, workspaceColors);
    if (labelMatch.ambiguous) {
      return {
        status: 'ambiguous',
        color: null,
        candidates: labelMatch.candidates,
        rawColorValue: variant.label.trim(),
      };
    }
    if (labelMatch.color) {
      return {
        status: 'matched',
        color: labelMatch.color,
        candidates: [labelMatch.color],
        rawColorValue: variant.label.trim(),
      };
    }

    // Delimiter-delimited exact token match inside compound labels (e.g. "Base V1 · Mulberry")
    // Only resolves when exactly ONE workspace color matches unambiguously.
    const tokenMatches: ColorOption[] = [];
    for (const c of workspaceColors) {
      const cName = c.name.trim().toLowerCase();
      if (!cName) continue;
      const escaped = escapeRegExp(cName);
      const re = new RegExp(`(^|[·|/\\s\\(\\)\\[\\]\\-,;:])${escaped}($|[·|/\\s\\(\\)\\[\\]\\-,;:])`, 'i');
      if (re.test(variant.label)) {
        tokenMatches.push(c);
      }
    }
    if (tokenMatches.length === 1) {
      return {
        status: 'matched',
        color: tokenMatches[0],
        candidates: tokenMatches,
        rawColorValue: variant.label.trim(),
      };
    }
    if (tokenMatches.length > 1) {
      return {
        status: 'ambiguous',
        color: null,
        candidates: tokenMatches,
        rawColorValue: variant.label.trim(),
      };
    }
  }

  return { status: 'none', color: null, candidates: [] };
}

/**
 * Dynamically resolves whether a product variant or option values match a known workspace filament color.
 * Supports unlimited user-created colors without hardcoding color names or loose substring guessing.
 */
export function matchWorkspaceColorForVariant(
  variant: {
    label?: string | null;
    optionValues?: Record<string, string> | null;
  } | null | undefined,
  workspaceColors: readonly ColorOption[]
): ColorOption | null {
  const res = resolveVariantColorConstraint(variant, workspaceColors);
  return res.status === 'matched' ? res.color : null;
}

export interface DraftCatalogPlatePreview {
  tempId: string;
  plateNumber: number;
  categoryId: string;
  categoryName: string;
  productId?: string | null; // Authoritative product ID (MANDATORY INVARIANT: ONE PLATE = ONE PRODUCT ID)
  productName?: string | null; // Authoritative product name
  colorId?: string | null; // Authoritative plate printing filament color ID
  colorName?: string | null; // Authoritative plate printing filament color name
  capacity: number | null; // null when composed in manual_plate mode without a fixed category capacity
  items: JobCatalogItemSnapshot[];
  estimatedMinutes: number;
  slicerVerified: boolean;
  notes: string;
}

export interface CatalogPlateGenerationResult {
  previews?: DraftCatalogPlatePreview[];
  totalUnits?: number;
  fullPlateCount?: number;
  remainderUnits?: number;
  error?: string;
}

export interface PlannerEditableInputsState {
  draftLetters: LettersMap;
  draftCharms: Record<CharmId, number>;
  draftCatalogQuantities: Record<string, number>;
}

/**
 * Pure helper for the Auto Plate Planner `Reset` button:
 * Resets ONLY editable planner quantity inputs to `0` without touching
 * completed production, existing plates, or Print Queue state.
 */
export function createZeroedPlannerInputs(): PlannerEditableInputsState {
  return {
    draftLetters: emptyAlphabetMap(),
    draftCharms: emptyCharmsMap(),
    draftCatalogQuantities: {},
  };
}

/**
 * Builds a deterministic selection map key for a product + optional variant + optional filament color.
 * When colorId is provided, isolates draft quantities per (product, color, variant).
 */
export function buildCatalogSelectionKey(
  productId: string,
  variantId?: string | null,
  colorId?: string | null
): string {
  if (colorId) {
    return variantId
      ? `${productId}:::${colorId}:::${variantId}`
      : `${productId}:::${colorId}:::base`;
  }
  return variantId ? `${productId}::${variantId}` : `${productId}::base`;
}

/**
 * Parses a selection key back into its component parts.
 */
export function parseCatalogSelectionKey(key: string): {
  productId: string;
  variantId: string | null;
  colorId: string | null;
} {
  if (key.includes(':::')) {
    const parts = key.split(':::');
    return {
      productId: parts[0],
      colorId: parts[1] || null,
      variantId: parts[2] === 'base' ? null : parts[2],
    };
  }
  const parts = key.split('::');
  return {
    productId: parts[0],
    colorId: null,
    variantId: parts[1] === 'base' ? null : parts[1],
  };
}

/**
 * Identifies if a product has a physical color variation option group
 * (e.g. named Color/Colour/Warna/Filament, or whose values correspond to workspace colors).
 */
export function findProductColorOption(
  product: CatalogProduct,
  workspaceColors: readonly ColorOption[]
): ProductOptionDefinition | null {
  if (!product.options || product.options.length === 0) return null;

  for (const opt of product.options) {
    if (/^(color|colour|warna|filament)$/i.test(opt.name.trim())) {
      return opt;
    }
  }

  if (workspaceColors && workspaceColors.length > 0) {
    for (const opt of product.options) {
      if (!opt.values || opt.values.length === 0) continue;
      let matchedCount = 0;
      for (const val of opt.values) {
        const cleanVal = val.trim().toLowerCase();
        if (
          workspaceColors.some(
            (c) => c.name.trim().toLowerCase() === cleanVal || c.id === val.trim()
          )
        ) {
          matchedCount += 1;
        }
      }
      if (matchedCount > 0 && matchedCount >= Math.ceil(opt.values.length / 2)) {
        return opt;
      }
    }
  }

  return null;
}

export interface ColorFilteredPlannableItemsResult {
  hasColorOption: boolean;
  colorOptionName?: string;
  isColorCompatible: boolean;
  matchingColorValue?: string;
  availableColors: { name: string; hex?: string; colorId?: string }[];
  items: PlannableProductItem[];
  displayMode: 'single_input' | 'variation_grid' | 'incompatible_color';
}

export function buildNonColorOptionComboKey(
  optionValues: Record<string, string>,
  nonColorOptions: readonly ProductOptionDefinition[]
): string {
  return `${NON_COLOR_COMBO_PREFIX}${nonColorOptions
    .map((o) => `${encodeURIComponent(o.name)}=${encodeURIComponent((optionValues[o.name] || '').trim())}`)
    .join('&')}`;
}

export function parseNonColorOptionComboKey(
  itemId: string | null | undefined
): Record<string, string> | null {
  if (!itemId || !itemId.startsWith(NON_COLOR_COMBO_PREFIX)) return null;
  const raw = itemId.slice(NON_COLOR_COMBO_PREFIX.length);
  if (!raw) return {};
  const result: Record<string, string> = {};
  for (const part of raw.split('&')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx <= 0) continue;
    const k = decodeURIComponent(part.slice(0, eqIdx));
    const v = decodeURIComponent(part.slice(eqIdx + 1));
    if (k && v) {
      result[k] = v;
    }
  }
  return result;
}

export interface PlannerProductInputModel {
  hasPhysicalColorOption: boolean;
  isColorDeduplicated: boolean;
  hasAmbiguousColorMapping: boolean;
  colorOptionName?: string;
  configuredColors: { rawValue: string; colorId: string | null; hex?: string }[];
  effectiveOptions: ProductOptionDefinition[];
  displayMode: 'single_input' | 'variation_grid';
  items: PlannableProductItem[];
}

/**
 * Builds the color-agnostic quantity entry model for a Product Studio product
 * when Filament Color is chosen per-plate in the Plate Preview stage.
 * - Avoids duplicated color quantity grids when a product's Color option maps unambiguously to physical workspace colors and non-color combinations are uniform across colors.
 * - Never collapses or guesses when color mapping is ambiguous or combinations are asymmetric.
 */
export function buildPlannerProductInputModel(
  product: CatalogProduct,
  workspaceColors: readonly ColorOption[]
): PlannerProductInputModel {
  const allItems = getPlannableProductItems(product);
  const colorOpt = findProductColorOption(product, workspaceColors);

  if (!colorOpt) {
    const isSingleBase = allItems.length === 1 && allItems[0].id === 'base';
    return {
      hasPhysicalColorOption: false,
      isColorDeduplicated: false,
      hasAmbiguousColorMapping: false,
      configuredColors: [],
      effectiveOptions: product.options || [],
      displayMode: isSingleBase ? 'single_input' : 'variation_grid',
      items: allItems,
    };
  }

  const configuredColors = colorOpt.values.map((rawVal) => {
    const match = matchWorkspaceColorValue(rawVal, workspaceColors);
    return {
      rawValue: rawVal,
      colorId: match.color ? match.color.id : null,
      hex: match.color?.hex,
    };
  });

  const allColorsMapUnambiguously =
    configuredColors.length > 0 && configuredColors.every((c) => c.colorId !== null);

  const nonColorOptions = (product.options || [])
    .filter((o) => o.id !== colorOpt.id)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  // Check if non-color combinations are uniform across all color values so deduplicating won't generate invalid combos
  let combosUniformAcrossColors = true;
  const nonColorComboMap = new Map<
    string,
    { label: string; optionValues: Record<string, string>; sortOrder: number; colorCount: number }
  >();

  if (nonColorOptions.length > 0) {
    const seenPerComboColor = new Map<string, Set<string>>();
    for (const item of allItems) {
      const ov = item.optionValues || {};
      const colorVal = (ov[colorOpt.name] || '').trim().toLowerCase();
      if (!colorVal) {
        combosUniformAcrossColors = false;
        break;
      }
      const nonColorOv: Record<string, string> = {};
      const labelParts: string[] = [];
      for (const nOpt of nonColorOptions) {
        const val = (ov[nOpt.name] || '').trim();
        if (!val) {
          combosUniformAcrossColors = false;
          break;
        }
        nonColorOv[nOpt.name] = val;
        labelParts.push(val);
      }
      if (!combosUniformAcrossColors) break;

      const comboKey = buildNonColorOptionComboKey(nonColorOv, nonColorOptions);
      if (!seenPerComboColor.has(comboKey)) {
        seenPerComboColor.set(comboKey, new Set());
        nonColorComboMap.set(comboKey, {
          label: labelParts.join(' · '),
          optionValues: nonColorOv,
          sortOrder: item.sortOrder,
          colorCount: 0,
        });
      }
      seenPerComboColor.get(comboKey)!.add(colorVal);
    }

    if (combosUniformAcrossColors) {
      const expectedColorCount = new Set(
        colorOpt.values.map((v) => v.trim().toLowerCase())
      ).size;
      for (const [comboKey, colorSet] of seenPerComboColor.entries()) {
        if (colorSet.size !== expectedColorCount) {
          combosUniformAcrossColors = false;
          break;
        }
        const entry = nonColorComboMap.get(comboKey);
        if (entry) entry.colorCount = colorSet.size;
      }
    }
  } else {
    // Only Color option: verify each color option has a valid item (no missing/broken mapping)
    combosUniformAcrossColors = allItems.length >= colorOpt.values.length;
  }

  if (allColorsMapUnambiguously && combosUniformAcrossColors) {
    if (nonColorOptions.length === 0) {
      return {
        hasPhysicalColorOption: true,
        isColorDeduplicated: true,
        hasAmbiguousColorMapping: false,
        colorOptionName: colorOpt.name,
        configuredColors,
        effectiveOptions: [],
        displayMode: 'single_input',
        items: [
          {
            id: COLOR_AGNOSTIC_BASE_ITEM_ID,
            label: product.name,
            sortOrder: 0,
          },
        ],
      };
    }

    const dedupedItems: PlannableProductItem[] = Array.from(nonColorComboMap.entries()).map(
      ([comboKey, info]) => ({
        id: comboKey,
        label: info.label,
        optionValues: info.optionValues,
        sortOrder: info.sortOrder,
      })
    );

    return {
      hasPhysicalColorOption: true,
      isColorDeduplicated: true,
      hasAmbiguousColorMapping: false,
      colorOptionName: colorOpt.name,
      configuredColors,
      effectiveOptions: nonColorOptions,
      displayMode: 'variation_grid',
      items: dedupedItems,
    };
  }

  return {
    hasPhysicalColorOption: true,
    isColorDeduplicated: false,
    hasAmbiguousColorMapping: !allColorsMapUnambiguously,
    colorOptionName: colorOpt.name,
    configuredColors,
    effectiveOptions: product.options || [],
    displayMode:
      allItems.length === 1 && allItems[0].id === 'base'
        ? 'single_input'
        : 'variation_grid',
    items: allItems,
  };
}

/**
 * Resolves plannable items for a product in the context of an explicit physical filament color.
 * Preserved for direct color-scoped callers and backwards-compatible unit tests.
 */
export function getPlannableItemsForSelectedFilamentColor(
  product: CatalogProduct,
  selectedColor: ColorOption,
  workspaceColors: readonly ColorOption[]
): ColorFilteredPlannableItemsResult {
  const allItems = getPlannableProductItems(product);
  const colorOpt = findProductColorOption(product, workspaceColors);

  if (!colorOpt) {
    const isSingleBase = allItems.length === 1 && allItems[0].id === 'base';
    return {
      hasColorOption: false,
      isColorCompatible: true,
      availableColors: [],
      items: allItems,
      displayMode: isSingleBase ? 'single_input' : 'variation_grid',
    };
  }

  const availableColors = colorOpt.values.map((v) => {
    const matched = matchWorkspaceColorValue(v, workspaceColors).color;
    return {
      name: v,
      hex: matched?.hex,
      colorId: matched?.id,
    };
  });

  const selNameClean = selectedColor.name.trim().toLowerCase();
  const matchingValue = colorOpt.values.find((v) => {
    const valClean = v.trim().toLowerCase();
    return valClean === selNameClean || (selectedColor.id && v.trim() === selectedColor.id);
  });

  if (!matchingValue) {
    return {
      hasColorOption: true,
      colorOptionName: colorOpt.name,
      isColorCompatible: false,
      availableColors,
      items: [],
      displayMode: 'incompatible_color',
    };
  }

  const matchingItems = allItems.filter((item) => {
    if (item.optionValues && item.optionValues[colorOpt.name]) {
      return (
        item.optionValues[colorOpt.name].trim().toLowerCase() ===
        matchingValue.trim().toLowerCase()
      );
    }
    return false;
  });

  const otherOptions = (product.options || []).filter((o) => o.id !== colorOpt.id);
  if (otherOptions.length === 0 || matchingItems.length === 1) {
    const singleItem = matchingItems[0] || {
      id: matchingValue,
      label: `${product.name} (${matchingValue})`,
      optionValues: { [colorOpt.name]: matchingValue },
      sortOrder: 0,
    };
    return {
      hasColorOption: true,
      colorOptionName: colorOpt.name,
      isColorCompatible: true,
      matchingColorValue: matchingValue,
      availableColors,
      items: [singleItem],
      displayMode: 'single_input',
    };
  }

  const nonColorItems = matchingItems.map((item) => {
    let cleanSubLabel = item.label;
    if (item.optionValues) {
      const nonColorParts = Object.entries(item.optionValues)
        .filter(([k]) => k !== colorOpt.name)
        .map(([, v]) => v);
      if (nonColorParts.length > 0) {
        cleanSubLabel = nonColorParts.join(' · ');
      }
    }
    return {
      ...item,
      label: cleanSubLabel,
    };
  });

  return {
    hasColorOption: true,
    colorOptionName: colorOpt.name,
    isColorCompatible: true,
    matchingColorValue: matchingValue,
    availableColors,
    items: nonColorItems,
    displayMode: 'variation_grid',
  };
}

/**
 * Verifies whether a category is active and eligible for creating new print plans.
 * Archived categories cannot create new print plans until restored.
 */
export function validateCategoryForPlanning(
  category: ProductCategory | null | undefined
): { ok: boolean; error?: string } {
  if (!category) {
    return { ok: false, error: 'Selected category was not found in Product Studio.' };
  }
  if (category.status === 'archived') {
    return {
      ok: false,
      error: `Category "${category.name}" is archived. Restore this category in Product Studio before creating new print plans.`,
    };
  }
  return { ok: true };
}

/**
 * Enforces Category-Based Plate Mixing strictly by immutable `categoryId` (never by display name):
 * - Products can share a plate ONLY when they have the exact same `categoryId`.
 * - Never allows items from different categories on one plate.
 */
export function validateSameCategoryPlateItems(
  items: readonly Pick<JobCatalogItemSnapshot, 'productId' | 'productName' | 'categoryId' | 'quantity'>[],
  expectedCategoryId?: string
): { valid: boolean; resolvedCategoryId?: string; error?: string } {
  const nonEmpty = items.filter((item) => Math.floor(Number(item.quantity || 0)) > 0);
  if (nonEmpty.length === 0) {
    return {
      valid: false,
      error: 'Each plate must include at least 1 product unit.',
    };
  }

  const anchorCategoryId = (expectedCategoryId || nonEmpty[0].categoryId || '').trim();
  if (!anchorCategoryId) {
    return {
      valid: false,
      error: 'Missing categoryId on plate items.',
    };
  }

  for (const item of nonEmpty) {
    if (!item.categoryId || item.categoryId.trim() !== anchorCategoryId) {
      return {
        valid: false,
        error: `Cross-category plate mixing blocked: "${item.productName}" belongs to category ID "${item.categoryId}", which cannot share a plate with category ID "${anchorCategoryId}".`,
      };
    }
  }

  return {
    valid: true,
    resolvedCategoryId: anchorCategoryId,
  };
}

/**
 * MANDATORY PRODUCTION INVARIANT:
 * ONE PLATE = ONE PRODUCT ID + ONE PHYSICAL FILAMENT COLOR.
 * - A plate MAY contain multiple variations of the same product, provided those variations use the same physical filament color.
 * - A plate must NEVER contain:
 *   - Multiple different product IDs.
 *   - Multiple different physical filament colors.
 *   - Conflicting physical color variations.
 */
export function validateStrictSingleProductPlateItems(
  items: readonly Pick<
    JobCatalogItemSnapshot,
    'productId' | 'productName' | 'categoryId' | 'quantity' | 'colorId'
  >[],
  expectedProductId?: string,
  expectedColorId?: string,
  expectedCategoryId?: string
): {
  valid: boolean;
  resolvedProductId?: string;
  resolvedColorId?: string;
  resolvedCategoryId?: string;
  error?: string;
} {
  const nonEmpty = items.filter((item) => Math.floor(Number(item.quantity || 0)) > 0);
  if (nonEmpty.length === 0) {
    return {
      valid: false,
      error: 'Each plate must include at least 1 product unit.',
    };
  }

  // 1. Strict single category verification
  const anchorCategoryId = (expectedCategoryId || nonEmpty[0].categoryId || '').trim();
  if (anchorCategoryId) {
    for (const item of nonEmpty) {
      if (!item.categoryId || item.categoryId.trim() !== anchorCategoryId) {
        return {
          valid: false,
          error: `Cross-category plate mixing blocked: "${item.productName}" belongs to category ID "${item.categoryId}", which cannot share a plate with category ID "${anchorCategoryId}".`,
        };
      }
    }
  }

  // 2. Strict single product verification (NO product mixing allowed!)
  const anchorProductId = (expectedProductId || nonEmpty[0].productId || '').trim();
  if (!anchorProductId) {
    return {
      valid: false,
      error: 'Missing productId on plate items.',
    };
  }
  for (const item of nonEmpty) {
    if (!item.productId || item.productId.trim() !== anchorProductId) {
      return {
        valid: false,
        error: `Product mixing blocked: Plate contains multiple different products ("${item.productName}" [${item.productId}] cannot share a plate with product [${anchorProductId}]). ONE PLATE = ONE PRODUCT ID.`,
      };
    }
  }

  // 3. Strict single filament color verification (NO physical color mixing allowed!)
  const anchorColorId = (expectedColorId || nonEmpty[0].colorId || '').trim();
  if (anchorColorId && anchorColorId !== 'unassigned') {
    for (const item of nonEmpty) {
      if (
        item.colorId &&
        item.colorId.trim() !== anchorColorId &&
        item.colorId !== 'unassigned'
      ) {
        return {
          valid: false,
          error: `Color mixing blocked: Plate contains conflicting physical filament colors (${item.colorId} vs ${anchorColorId}). ONE PLATE = ONE PHYSICAL FILAMENT COLOR.`,
        };
      }
    }
  }

  return {
    valid: true,
    resolvedProductId: anchorProductId,
    resolvedColorId: anchorColorId || undefined,
    resolvedCategoryId: anchorCategoryId || undefined,
  };
}

/**
 * Builds immutable `JobCatalogItemSnapshot` entries from user planner selections,
 * enforcing that every selected product is active and belongs to `category.id`.
 */
export function resolveCatalogSnapshotsFromSelections(params: {
  category: ProductCategory;
  products: readonly CatalogProduct[];
  selections: readonly CatalogPlannerSelectionInput[];
  color?: ColorOption | null;
  workspaceColors?: readonly ColorOption[];
}): { snapshots?: JobCatalogItemSnapshot[]; error?: string } {
  const catCheck = validateCategoryForPlanning(params.category);
  if (!catCheck.ok) {
    return { error: catCheck.error };
  }

  const productById = new Map<string, CatalogProduct>();
  for (const p of params.products) {
    productById.set(p.id, p);
  }

  const mergedByKey = new Map<string, JobCatalogItemSnapshot>();

  for (const sel of params.selections) {
    const qty = Math.floor(Number(sel.quantity || 0));
    if (qty <= 0) continue;

    const product = productById.get(sel.productId);
    if (!product) {
      return {
        error: `Selected product (${sel.productId}) no longer exists in Product Studio.`,
      };
    }
    if (product.status === 'archived') {
      return {
        error: `Product "${product.name}" (${product.sku}) is archived. Restore it in Product Studio before planning new plates.`,
      };
    }
    if (product.categoryId !== params.category.id) {
      return {
        error: `Cross-category plate mixing blocked: "${product.name}" belongs to category ID "${product.categoryId}" and cannot be mixed with "${params.category.name}" (${params.category.id}).`,
      };
    }

    let variantId: string | null = null;
    let variantLabel: string | null = null;

    const plannableItems = getPlannableProductItems(product);
    const hasConfiguredVariants =
      (product.options && product.options.length > 0) ||
      (product.variants && product.variants.length > 0) ||
      (plannableItems.length > 1 || (plannableItems.length === 1 && plannableItems[0].id !== 'base'));

    let matchedVar: PlannableProductItem | undefined;
    const isColorAgnosticSel = sel.variantId === COLOR_AGNOSTIC_BASE_ITEM_ID;
    const nonColorComboOptionValues = parseNonColorOptionComboKey(sel.variantId);

    if (hasConfiguredVariants) {
      if (isColorAgnosticSel) {
        // Color-only product deduplicated during quantity entry; concrete color variant resolves upon per-plate color selection (or immediately if params.color is supplied)
        const colorOpt = findProductColorOption(product, params.workspaceColors || []);
        if (colorOpt && params.color) {
          const targetVar = plannableItems.find(
            (v) =>
              v.optionValues?.[colorOpt.name]?.trim().toLowerCase() ===
              params.color!.name.trim().toLowerCase()
          );
          if (!targetVar) {
            return {
              error: `"${product.name}" does not support physical filament color "${params.color.name}".`,
            };
          }
          matchedVar = targetVar;
          variantId = targetVar.id;
          variantLabel = targetVar.label;
        } else {
          variantId = COLOR_AGNOSTIC_BASE_ITEM_ID;
          variantLabel = null;
        }
      } else if (nonColorComboOptionValues) {
        const colorOpt = findProductColorOption(product, params.workspaceColors || []);
        if (colorOpt && params.color) {
          const targetVar = plannableItems.find((v) => {
            if (!v.optionValues) return false;
            const cVal = (v.optionValues[colorOpt.name] || '').trim().toLowerCase();
            if (cVal !== params.color!.name.trim().toLowerCase()) return false;
            return Object.entries(nonColorComboOptionValues).every(
              ([k, val]) => (v.optionValues?.[k] || '').trim() === val.trim()
            );
          });
          if (!targetVar) {
            return {
              error: `Variation "${Object.values(nonColorComboOptionValues).join(' · ')}" on "${product.name}" is not available in "${params.color.name}".`,
            };
          }
          matchedVar = targetVar;
          variantId = targetVar.id;
          variantLabel = targetVar.label;
        } else {
          variantId = sel.variantId;
          variantLabel = Object.values(nonColorComboOptionValues).join(' · ') || null;
        }
      } else {
        if (!sel.variantId) {
          return {
            error: `Select a variation for "${product.name}" before generating plates.`,
          };
        }
        matchedVar = plannableItems.find((v) => v.id === sel.variantId);
        if (!matchedVar) {
          return {
            error: `Selected variation for "${product.name}" was not found.`,
          };
        }
        variantId = matchedVar.id;
        variantLabel = matchedVar.label;
      }
    }

    // Resolve snapshot color:
    // - If params.color is omitted/null (per-plate color workflow), initialize draft items as unassigned
    //   so operators explicitly choose Filament Color per plate in Preview (never auto-assigned to color-0!).
    // - If params.color is supplied (legacy/direct callers), resolve explicit variant color or fallback to params.color.
    let itemColorId = 'unassigned';
    let itemColorName = 'Unassigned Color';
    if (params.color) {
      let resolvedColorId = '';
      let resolvedColorName = '';
      if (matchedVar && params.workspaceColors && params.workspaceColors.length > 0) {
        const matched = matchWorkspaceColorForVariant(matchedVar, params.workspaceColors);
        if (matched) {
          resolvedColorId = matched.id;
          resolvedColorName = matched.name;
        }
      }
      itemColorId = resolvedColorId || params.color.id;
      itemColorName = resolvedColorName || params.color.name;
    }

    const key = buildCatalogSelectionKey(product.id, variantId);
    const existing = mergedByKey.get(key);
    if (existing) {
      existing.quantity += qty;
    } else {
      mergedByKey.set(key, {
        productId: product.id,
        productName: product.name,
        sku: product.sku,
        categoryId: params.category.id,
        categoryName: params.category.name,
        variantId,
        variantLabel,
        colorId: itemColorId,
        colorName: itemColorName,
        quantity: qty,
      });
    }
  }

  const snapshots = Array.from(mergedByKey.values());
  if (snapshots.length === 0) {
    return {
      error: `Enter a quantity of at least 1 for one or more products in "${params.category.name}".`,
    };
  }

  const mixCheck = validateSameCategoryPlateItems(snapshots, params.category.id);
  if (!mixCheck.valid) {
    return { error: mixCheck.error };
  }

  return { snapshots };
}

function getNextSequentialPlateNumberGenerator(
  existingJobs: readonly ProductionJob[],
  projectId: string,
  colorId?: string
): () => number {
  const used = new Set(
    existingJobs
      .filter((j) => j.projectId === projectId && (!colorId || j.colorId === colorId))
      .map((j) => j.plateNumber)
  );
  let cursor = 1;
  return () => {
    while (used.has(cursor)) {
      cursor += 1;
    }
    const chosen = cursor;
    used.add(chosen);
    cursor += 1;
    return chosen;
  };
}

/**
 * Generates plate previews for a Product Studio category using `categoryPlateSettings`.
 * - NEVER assumes `138` capacity for unknown categories!
 * - In `automatic_capacity` mode, requires `plateSetting.plateCapacity >= 1`.
 * - Products in the SAME `categoryId` share plates up to `plateCapacity`.
 * - Products from DIFFERENT `categoryId`s are strictly rejected.
 * - Naturally groups items by their design/filament color onto separate plates so different colors never conflict.
 * - Sets explicit, authoritative `colorId` and `colorName` on each generated plate preview.
 */
export function generateAutomaticCatalogPlatePreviews(params: {
  existingJobs: readonly ProductionJob[];
  project: ProductionProject;
  color?: ColorOption | null;
  workspaceColors?: readonly ColorOption[];
  category: ProductCategory;
  products: readonly CatalogProduct[];
  selections: readonly CatalogPlannerSelectionInput[];
  plateSetting: Pick<
    CategoryPlateSetting,
    'allocationMode' | 'plateCapacity' | 'defaultEstimatedMinutes'
  > | null;
  includePartialRemainderPlate?: boolean;
  nowMs?: number;
}): CatalogPlateGenerationResult {
  const resolved = resolveCatalogSnapshotsFromSelections({
    category: params.category,
    products: params.products,
    selections: params.selections,
    color: params.color,
    workspaceColors: params.workspaceColors,
  });
  if (resolved.error || !resolved.snapshots) {
    return { error: resolved.error };
  }

  // Strictly block automatic capacity splitting if the category has no configured capacity (never assume 138!)
  const rawCap = params.plateSetting?.plateCapacity ?? null;
  if (rawCap === null || !Number.isFinite(rawCap) || Math.floor(rawCap) < 1) {
    return {
      error: `No plate capacity is configured for "${params.category.name}" yet. Configure a Max Units per Plate rule for this category or switch to Manual Plate Composition (138 is never assumed for custom categories).`,
    };
  }

  const safeCap = Math.floor(rawCap);
  const safeMins = Math.max(
    1,
    Math.round(params.plateSetting?.defaultEstimatedMinutes || 180)
  );
  const includePartial = params.includePartialRemainderPlate !== false;
  const nowMs = params.nowMs ?? Date.now();

  // Partition snapshots strictly by (productId, colorId) so different products and different physical colors NEVER share a plate!
  // MANDATORY PRODUCTION INVARIANT: ONE PLATE = ONE PRODUCT ID + ONE PHYSICAL FILAMENT COLOR.
  // Note: When params.color is omitted/null (per-plate preview workflow), group by (productId, 'unassigned' or variant color key)
  // and leave generated draft plate colorId as null ("Select Filament Color") so no color is auto-assigned.
  const groupsByProductAndColor = new Map<string, JobCatalogItemSnapshot[]>();
  const productById = new Map(params.products.map((p) => [p.id, p]));
  for (const s of resolved.snapshots) {
    const pKey = (s.productId || 'unknown').trim();
    let partitionColorKey = (s.colorId || 'unassigned').trim();
    if (!params.color && params.workspaceColors && s.variantId && s.variantId !== COLOR_AGNOSTIC_BASE_ITEM_ID && !s.variantId.startsWith(NON_COLOR_COMBO_PREFIX)) {
      const prod = productById.get(pKey);
      const v = prod ? getPlannableProductItems(prod).find((it) => it.id === s.variantId) : undefined;
      if (v) {
        const constraint = resolveVariantColorConstraint(v, params.workspaceColors);
        if (constraint.status === 'matched' && constraint.color) {
          partitionColorKey = `locked:${constraint.color.id}`;
        }
      }
    }
    const comboKey = `${pKey}:::${partitionColorKey}`;
    if (!groupsByProductAndColor.has(comboKey)) {
      groupsByProductAndColor.set(comboKey, []);
    }
    groupsByProductAndColor.get(comboKey)!.push({ ...s });
  }

  const previews: DraftCatalogPlatePreview[] = [];
  let totalUnits = 0;
  let fullPlateCount = 0;
  let remainderUnits = 0;

  const usedPlateNumbers = new Set(
    params.existingJobs
      .filter((j) => j.projectId === params.project.id)
      .map((j) => j.plateNumber)
  );
  let plateCursor = 1;
  const getNextPlateNumber = () => {
    while (usedPlateNumbers.has(plateCursor)) {
      plateCursor += 1;
    }
    const chosen = plateCursor;
    usedPlateNumbers.add(chosen);
    plateCursor += 1;
    return chosen;
  };

  for (const [comboKey, itemsForGroup] of groupsByProductAndColor.entries()) {
    const [prodKey, colorKey] = comboKey.split(':::');
    const groupUnits = countCatalogItems(itemsForGroup);
    totalUnits += groupUnits;
    const groupFullPlates = Math.floor(groupUnits / safeCap);
    const groupRemainder = groupUnits % safeCap;
    fullPlateCount += groupFullPlates;
    if (groupRemainder > 0) {
      remainderUnits += groupRemainder;
    }

    const matchedProduct = params.products.find((p) => p.id === prodKey);
    const prodName = itemsForGroup[0]?.productName || matchedProduct?.name || 'Product';

    // Only pre-populate plate color when params.color was explicitly provided by caller.
    // When params.color is omitted/null, initialize unassigned (colorId: null -> "Select Filament Color").
    const matchedColor =
      params.color && colorKey !== 'unassigned' && !colorKey.startsWith('locked:')
        ? (params.workspaceColors || []).find((c) => c.id === colorKey) ||
          (params.color.id === colorKey ? params.color : null)
        : null;
    const groupColorId = params.color
      ? matchedColor
        ? matchedColor.id
        : colorKey !== 'unassigned'
        ? colorKey
        : null
      : null;
    const groupColorName = params.color
      ? matchedColor
        ? matchedColor.name
        : colorKey !== 'unassigned'
        ? colorKey
        : ''
      : '';

    const pool = itemsForGroup.map((it) => ({ ...it }));

    const fillOnePlate = (targetRoom: number, isPartial: boolean, idx: number) => {
      let room = targetRoom;
      const plateItems: JobCatalogItemSnapshot[] = [];

      // Sort larger remaining quantities first for clean variation grouping within the SAME product
      pool.sort((a, b) => b.quantity - a.quantity);

      for (const candidate of pool) {
        if (room <= 0) break;
        if (candidate.quantity <= 0) continue;
        const take = Math.min(candidate.quantity, room);
        if (take > 0) {
          plateItems.push({
            ...candidate,
            quantity: take,
          });
          candidate.quantity -= take;
          room -= take;
        }
      }

      if (plateItems.length === 0) return;

      plateItems.sort((a, b) => {
        const vA = a.variantLabel || '';
        const vB = b.variantLabel || '';
        return vA.localeCompare(vB, undefined, { numeric: true, sensitivity: 'base' });
      });

      const unitSum = countCatalogItems(plateItems);
      const estMins = isPartial
        ? Math.max(15, Math.round((unitSum / safeCap) * safeMins))
        : safeMins;

      const chosenPlateNumber = getNextPlateNumber();
      const colorSuffix = groupColorName ? ` · ${groupColorName}` : '';
      previews.push({
        tempId: `cat-draft-${nowMs}-${prodKey}-${colorKey}-${idx}`,
        plateNumber: chosenPlateNumber,
        categoryId: params.category.id,
        categoryName: params.category.name,
        productId: prodKey,
        productName: prodName,
        colorId: groupColorId,
        colorName: groupColorName,
        capacity: safeCap,
        items: plateItems,
        estimatedMinutes: estMins,
        slicerVerified: false,
        notes: isPartial
          ? `${prodName}${colorSuffix} partial plate (${unitSum}/${safeCap} pcs · verify layout in Bambu Studio)`
          : `${prodName}${colorSuffix} plate (${unitSum}/${safeCap} pcs · verify layout in Bambu Studio)`,
      });
    };

    for (let p = 0; p < groupFullPlates; p += 1) {
      fillOnePlate(safeCap, false, p);
    }

    if (includePartial && groupRemainder > 0) {
      fillOnePlate(groupRemainder, true, groupFullPlates);
    }
  }

  return {
    previews,
    totalUnits,
    fullPlateCount,
    remainderUnits,
  };
}

/**
 * Assigns (or clears) a physical filament color on a single staged draft plate preview,
 * synchronizing `plate.colorId`, `plate.colorName`, AND all `plate.items[i].colorId` / `colorName`
 * so changing Plate 1 from color-0 to color-1 never triggers false stale-item color conflicts.
 * Also resolves concrete color-dependent variant IDs when a product's Color option was deduplicated.
 */
export function assignColorToDraftCatalogPlate(
  plate: DraftCatalogPlatePreview,
  color: ColorOption | null,
  product?: CatalogProduct | null,
  workspaceColors: readonly ColorOption[] = []
): DraftCatalogPlatePreview {
  const nextColorId = color ? color.id : null;
  const nextColorName = color ? color.name : '';
  const itemColorId = color ? color.id : 'unassigned';
  const itemColorName = color ? color.name : 'Unassigned Color';

  const plannableItems = product ? getPlannableProductItems(product) : [];
  const colorOpt = product ? findProductColorOption(product, workspaceColors) : null;
  const inputModel = product ? buildPlannerProductInputModel(product, workspaceColors) : null;

  const updatedItems: JobCatalogItemSnapshot[] = plate.items.map((item) => {
    let nextVariantId = item.variantId;
    let nextVariantLabel = item.variantLabel;

    if (product && colorOpt && inputModel?.isColorDeduplicated) {
      if (!color) {
        // Reverting to unassigned: preserve non-color option descriptor cleanly
        const currentVar = item.variantId
          ? plannableItems.find((v) => v.id === item.variantId)
          : null;
        if (currentVar && currentVar.optionValues) {
          const nonColorOptions = (product.options || [])
            .filter((o) => o.id !== colorOpt.id)
            .sort((a, b) => a.sortOrder - b.sortOrder);
          if (nonColorOptions.length === 0) {
            nextVariantId = COLOR_AGNOSTIC_BASE_ITEM_ID;
            nextVariantLabel = null;
          } else {
            nextVariantId = buildNonColorOptionComboKey(currentVar.optionValues, nonColorOptions);
            nextVariantLabel = nonColorOptions.map((o) => currentVar.optionValues![o.name]).join(' · ');
          }
        }
      } else {
        // Resolve concrete variant matching selected physical color + any non-color options
        let nonColorValues: Record<string, string> | null = parseNonColorOptionComboKey(item.variantId);
        if (!nonColorValues && item.variantId && item.variantId !== COLOR_AGNOSTIC_BASE_ITEM_ID) {
          const currentVar = plannableItems.find((v) => v.id === item.variantId);
          if (currentVar?.optionValues) {
            nonColorValues = {};
            for (const [k, v] of Object.entries(currentVar.optionValues)) {
              if (k !== colorOpt.name) {
                nonColorValues[k] = v;
              }
            }
          }
        }

        const matchedVariant = plannableItems.find((v) => {
          if (!v.optionValues) return false;
          const vColorVal = (v.optionValues[colorOpt.name] || '').trim().toLowerCase();
          if (vColorVal !== color.name.trim().toLowerCase()) return false;
          if (!nonColorValues) return true;
          return Object.entries(nonColorValues).every(
            ([k, val]) => (v.optionValues?.[k] || '').trim() === val.trim()
          );
        });

        if (matchedVariant) {
          nextVariantId = matchedVariant.id;
          nextVariantLabel = matchedVariant.label;
        }
      }
    }

    return {
      ...item,
      variantId: nextVariantId,
      variantLabel: nextVariantLabel,
      colorId: itemColorId,
      colorName: itemColorName,
    };
  });

  return {
    ...plate,
    colorId: nextColorId,
    colorName: nextColorName,
    items: updatedItems,
  };
}

export interface StagedPlateValidationResult {
  valid: boolean;
  requiresColorSelection: boolean;
  blockingErrors: string[];
  colorSelectionError: string | null;
}

/**
 * Validates a single staged catalog plate preview thoroughly before Print Queue confirmation.
 * Returns both immediate structural/constraint errors and missing color selection status.
 */
export function validateStagedCatalogPlate(
  plate: DraftCatalogPlatePreview,
  context: {
    category: ProductCategory;
    product?: CatalogProduct | null;
    workspaceColors: readonly ColorOption[];
  }
): StagedPlateValidationResult {
  const blockingErrors: string[] = [];
  let colorSelectionError: string | null = null;
  let requiresColorSelection = false;

  const totalUnits = countCatalogItems(plate.items);
  if (totalUnits <= 0) {
    blockingErrors.push(`Plate ${plate.plateNumber} has 0 units. Enter at least 1 unit.`);
  }

  if (plate.capacity !== null && plate.capacity >= 1 && totalUnits > plate.capacity) {
    blockingErrors.push(
      `Plate ${plate.plateNumber} (${totalUnits} pcs) exceeds capacity of ${plate.capacity} pcs.`
    );
  }

  if (plate.categoryId !== context.category.id) {
    blockingErrors.push(
      `Plate ${plate.plateNumber} belongs to category "${plate.categoryId}", expected "${context.category.id}".`
    );
  }

  const assignedColorId = (plate.colorId || '').trim();
  const matchedWorkspaceColor =
    assignedColorId && assignedColorId !== 'unassigned'
      ? context.workspaceColors.find((c) => c.id === assignedColorId) || null
      : null;

  if (!assignedColorId || assignedColorId === 'unassigned') {
    requiresColorSelection = true;
    colorSelectionError = `Select a Filament Color for Plate ${plate.plateNumber} before confirming.`;
  } else if (!matchedWorkspaceColor) {
    blockingErrors.push(
      `Plate ${plate.plateNumber} references unknown Filament Color "${assignedColorId}".`
    );
  }

  // Strict single-product, single-category, single-color homogeneity check across plate items
  const strictCheck = validateStrictSingleProductPlateItems(
    plate.items,
    plate.productId || context.product?.id || undefined,
    assignedColorId && assignedColorId !== 'unassigned' ? assignedColorId : undefined,
    context.category.id
  );
  if (!strictCheck.valid && strictCheck.error) {
    blockingErrors.push(strictCheck.error);
  }

  // Verify product-level and variant-level physical color constraints (never silently substitute!)
  if (matchedWorkspaceColor && context.product) {
    const plannableItems = getPlannableProductItems(context.product);
    const colorOpt = findProductColorOption(context.product, context.workspaceColors);

    for (const item of plate.items) {
      if (Math.floor(Number(item.quantity || 0)) <= 0) continue;

      if (
        item.variantId === COLOR_AGNOSTIC_BASE_ITEM_ID ||
        (item.variantId && item.variantId.startsWith(NON_COLOR_COMBO_PREFIX))
      ) {
        if (colorOpt) {
          const nonColorValues = parseNonColorOptionComboKey(item.variantId);
          const hasMatchingVariant = plannableItems.some((v) => {
            if (!v.optionValues) return false;
            const cVal = (v.optionValues[colorOpt.name] || '').trim().toLowerCase();
            if (cVal !== matchedWorkspaceColor.name.trim().toLowerCase()) return false;
            if (!nonColorValues) return true;
            return Object.entries(nonColorValues).every(
              ([k, val]) => (v.optionValues?.[k] || '').trim() === val.trim()
            );
          });
          if (!hasMatchingVariant) {
            blockingErrors.push(
              `"${context.product.name}" does not have a valid "${matchedWorkspaceColor.name}" variation for "${item.variantLabel || context.product.name}" (available: ${colorOpt.values.join(', ')}).`
            );
          }
        }
      } else if (item.variantId) {
        const concreteVar = plannableItems.find((v) => v.id === item.variantId);
        if (concreteVar) {
          const colorConstraint = resolveVariantColorConstraint(
            concreteVar,
            context.workspaceColors
          );
          if (
            colorConstraint.status === 'matched' &&
            colorConstraint.color &&
            colorConstraint.color.id !== matchedWorkspaceColor.id
          ) {
            blockingErrors.push(
              `Variation "${concreteVar.label}" requires physical filament color "${colorConstraint.color.name}" and cannot be printed in "${matchedWorkspaceColor.name}".`
            );
          }
        }
      }
    }
  }

  const uniqueErrors = Array.from(new Set(blockingErrors));
  return {
    valid: uniqueErrors.length === 0 && !requiresColorSelection,
    requiresColorSelection,
    blockingErrors: uniqueErrors,
    colorSelectionError,
  };
}

/**
 * Validates an entire staged batch before Queue Confirmation.
 * Never approves partial batches when any single plate is invalid.
 */
export function validateStagedCatalogPlatesBatch(
  plates: readonly DraftCatalogPlatePreview[],
  context: {
    category: ProductCategory;
    product?: CatalogProduct | null;
    workspaceColors: readonly ColorOption[];
  }
): {
  allValid: boolean;
  byTempId: Record<string, StagedPlateValidationResult>;
  invalidPlateNumbers: number[];
} {
  const byTempId: Record<string, StagedPlateValidationResult> = {};
  const invalidPlateNumbers: number[] = [];

  for (const plate of plates) {
    const res = validateStagedCatalogPlate(plate, context);
    byTempId[plate.tempId] = res;
    if (!res.valid) {
      invalidPlateNumbers.push(plate.plateNumber);
    }
  }

  return {
    allValid: plates.length > 0 && invalidPlateNumbers.length === 0,
    byTempId,
    invalidPlateNumbers,
  };
}

/**
 * Validates and builds plate previews from manual per-plate composition in Auto Plate Planner
 * (used when a category has no fixed numeric capacity or the operator prefers custom per-plate grouping).
 */
export function buildManualCatalogPlatePreviews(params: {
  existingJobs: readonly ProductionJob[];
  project: ProductionProject;
  color?: ColorOption | null;
  workspaceColors?: readonly ColorOption[];
  category: ProductCategory;
  products: readonly CatalogProduct[];
  manualPlates: readonly {
    colorId?: string | null;
    selections: readonly CatalogPlannerSelectionInput[];
    estimatedMinutes: number;
    slicerVerified?: boolean;
    notes?: string;
  }[];
  configuredCapacity?: number | null;
  nowMs?: number;
}): CatalogPlateGenerationResult {
  const catCheck = validateCategoryForPlanning(params.category);
  if (!catCheck.ok) {
    return { error: catCheck.error };
  }

  if (!params.manualPlates.length) {
    return { error: 'Add at least one manual plate before generating preview.' };
  }

  const usedPlateNumbers = new Set(
    params.existingJobs
      .filter((j) => j.projectId === params.project.id)
      .map((j) => j.plateNumber)
  );
  let plateCursor = 1;
  const getNextPlateNumber = () => {
    while (usedPlateNumbers.has(plateCursor)) {
      plateCursor += 1;
    }
    const chosen = plateCursor;
    usedPlateNumbers.add(chosen);
    plateCursor += 1;
    return chosen;
  };

  const nowMs = params.nowMs ?? Date.now();
  const previews: DraftCatalogPlatePreview[] = [];
  let totalUnits = 0;

  for (let i = 0; i < params.manualPlates.length; i += 1) {
    const mp = params.manualPlates[i];
    const resolved = resolveCatalogSnapshotsFromSelections({
      category: params.category,
      products: params.products,
      selections: mp.selections,
      color: params.color,
      workspaceColors: params.workspaceColors,
    });
    if (resolved.error || !resolved.snapshots) {
      return { error: `Manual Plate ${i + 1}: ${resolved.error}` };
    }

    const unitsOnPlate = countCatalogItems(resolved.snapshots);
    const cap =
      params.configuredCapacity !== null &&
      params.configuredCapacity !== undefined &&
      params.configuredCapacity >= 1
        ? Math.floor(params.configuredCapacity)
        : null;

    if (cap !== null && unitsOnPlate > cap) {
      return {
        error: `Manual Plate ${i + 1} has ${unitsOnPlate} pcs, exceeding the configured category capacity of ${cap} pcs.`,
      };
    }

    // Determine manual plate's color
    let plateColorId: string | null = mp.colorId ?? null;
    if (!plateColorId && resolved.snapshots.length > 0) {
      // If all items share a color, use it
      const firstCid = resolved.snapshots[0].colorId;
      if (firstCid && firstCid !== 'unassigned' && resolved.snapshots.every((it) => it.colorId === firstCid)) {
        plateColorId = firstCid;
      }
    }
    if (!plateColorId && params.color) {
      plateColorId = params.color.id;
    }

    const matchedC = (params.workspaceColors || []).find((c) => c.id === plateColorId) ||
      (params.color && params.color.id === plateColorId ? params.color : null);
    const plateColorName = matchedC ? matchedC.name : (plateColorId ? plateColorId : 'Unassigned Color');

    // Enforce strict single-product invariant on manual plates (no product mixing!)
    const singleProductCheck = validateStrictSingleProductPlateItems(
      resolved.snapshots,
      undefined,
      plateColorId || undefined,
      params.category.id
    );
    if (!singleProductCheck.valid) {
      return { error: `Manual Plate ${i + 1}: ${singleProductCheck.error}` };
    }

    const firstProd = resolved.snapshots[0];
    const manualProdId = firstProd ? firstProd.productId : null;
    const manualProdName = firstProd ? firstProd.productName : null;

    totalUnits += unitsOnPlate;
    previews.push({
      tempId: `cat-manual-${nowMs}-${i}`,
      plateNumber: getNextPlateNumber(),
      categoryId: params.category.id,
      categoryName: params.category.name,
      productId: manualProdId,
      productName: manualProdName,
      colorId: plateColorId,
      colorName: plateColorName,
      capacity: cap,
      items: resolved.snapshots,
      estimatedMinutes: Math.max(1, Math.round(mp.estimatedMinutes || 180)),
      slicerVerified: Boolean(mp.slicerVerified),
      notes:
        mp.notes?.trim() ||
        `${manualProdName || params.category.name} manual plate (${unitsOnPlate} pcs · verify layout in Bambu Studio)`,
    });
  }

  return {
    previews,
    totalUnits,
    fullPlateCount: previews.length,
    remainderUnits: 0,
  };
}

/**
 * Confirms staged Product Studio category plates into `ProductionWorkspaceV5` (`workspace.jobs`):
 * - Re-validates category status (active) and strict single-`categoryId` homogeneity on every plate!
 * - Preserves each plate's explicit, authoritative `colorId` rather than blindly stamping a single global color!
 * - Stores immutable `JobCatalogItemSnapshot[]` on each `ProductionJob` so future product edits/renames/archives never corrupt Print Queue history.
 * - Never auto-assigns a machine (`machineId: null`) and never auto-starts printing (`Planned` or `Ready to Print` if slicerVerified).
 * - Preserves 100% of existing jobs, projects, machines, countdowns, and inventory.
 */
export function commitCatalogPlatesToWorkspace(
  workspace: ProductionWorkspaceV5,
  params: {
    projectId: string;
    colorId?: string | null;
    category: ProductCategory;
    products?: readonly CatalogProduct[];
    confirmedPlates: readonly DraftCatalogPlatePreview[];
    nowMs?: number;
  }
): {
  nextWorkspace?: ProductionWorkspaceV5;
  createdJobs?: ProductionJob[];
  error?: string;
} {
  const project = workspace.projects.find((p) => p.id === params.projectId);
  if (!project) {
    return { error: 'Project not found.' };
  }
  if (project.status === 'Archived') {
    return { error: 'Cannot add print plates to an archived project.' };
  }

  const defaultColor = params.colorId
    ? workspace.colors.find((c) => c.id === params.colorId)
    : null;

  const catCheck = validateCategoryForPlanning(params.category);
  if (!catCheck.ok) {
    return { error: catCheck.error };
  }

  if (!params.confirmedPlates.length) {
    return { error: 'No confirmed plates to add to Print Queue.' };
  }

  const nowMs = params.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const timezone = workspace.settings?.timezone || DEFAULT_TIMEZONE;
  const sessionId = `catplan-${nowMs}-${Math.random().toString(36).slice(2, 7)}`;

  const createdJobs: ProductionJob[] = [];
  const assignedColorIdsToAdd = new Set<string>();

  for (let idx = 0; idx < params.confirmedPlates.length; idx += 1) {
    const draft = params.confirmedPlates[idx];
    if (draft.categoryId !== params.category.id) {
      return {
        error: `Cross-category plate confirmation blocked on Plate ${draft.plateNumber}: expected category ID "${params.category.id}", received "${draft.categoryId}".`,
      };
    }

    const rawColorId = (draft.colorId || params.colorId || '').trim();
    if (!rawColorId || rawColorId === 'unassigned') {
      return {
        error: `Plate ${draft.plateNumber} requires a physical Filament Color before saving to Print Queue.`,
      };
    }

    const plateColor =
      workspace.colors.find((c) => c.id === rawColorId) ||
      (defaultColor && defaultColor.id === rawColorId ? defaultColor : null);
    if (!plateColor) {
      return {
        error: `Plate ${draft.plateNumber}: Selected Filament Color "${rawColorId}" was not found in workspace colors.`,
      };
    }

    const matchedProduct =
      params.products?.find((p) => p.id === (draft.productId || draft.items[0]?.productId)) ||
      null;

    // Validate all invariants on this plate individually (including color constraints)
    const stagedValidation = validateStagedCatalogPlate(
      { ...draft, colorId: plateColor.id, colorName: plateColor.name },
      {
        category: params.category,
        product: matchedProduct,
        workspaceColors: workspace.colors,
      }
    );
    if (!stagedValidation.valid) {
      const msg =
        stagedValidation.blockingErrors[0] ||
        stagedValidation.colorSelectionError ||
        `Plate ${draft.plateNumber} failed validation.`;
      return { error: `Plate ${draft.plateNumber}: ${msg}` };
    }

    const unitTotal = countCatalogItems(draft.items);
    const effectiveColorId = plateColor.id;
    const effectiveColorName = plateColor.name;
    assignedColorIdsToAdd.add(plateColor.id);

    // Ensure concrete variant resolution if placeholder was still present and matchedProduct is available
    const syncedDraft = matchedProduct
      ? assignColorToDraftCatalogPlate(draft, plateColor, matchedProduct, workspace.colors)
      : draft;

    // Snapshot immutable fields cleanly (zero undefined)
    const immutableSnapshots: JobCatalogItemSnapshot[] = syncedDraft.items
      .filter((item) => Math.floor(Number(item.quantity || 0)) > 0)
      .map((item) => {
        const cleanVarId =
          item.variantId &&
          item.variantId !== COLOR_AGNOSTIC_BASE_ITEM_ID &&
          !item.variantId.startsWith(NON_COLOR_COMBO_PREFIX)
            ? item.variantId.trim()
            : null;
        return {
          productId: item.productId.trim(),
          productName: item.productName.trim(),
          sku: item.sku.trim().toUpperCase(),
          categoryId: params.category.id,
          categoryName: params.category.name.trim(),
          variantId: cleanVarId,
          variantLabel: item.variantLabel ? item.variantLabel.trim() : null,
          colorId: effectiveColorId,
          colorName: effectiveColorName,
          quantity: Math.floor(Number(item.quantity)),
        };
      });

    const effectivePlateCapacity =
      draft.capacity !== null && draft.capacity >= 1 ? Math.floor(draft.capacity) : unitTotal;

    // Build companion letters map if items correspond to single A–Z letters (e.g. Keycap Letter A–Z)
    const companionLetters: LettersMap = {};
    for (const snap of immutableSnapshots) {
      const vLabel = (snap.variantLabel || '').trim().toUpperCase();
      if (vLabel.length === 1 && ABC.includes(vLabel as any) && snap.quantity > 0) {
        companionLetters[vLabel] = (companionLetters[vLabel] || 0) + snap.quantity;
      }
    }

    const job: ProductionJob = {
      id: `job-${nowMs}-${idx}-${effectiveColorId}`,
      projectId: project.id,
      colorId: effectiveColorId,
      plateNumber: draft.plateNumber,
      plateCapacity: effectivePlateCapacity,
      letters: companionLetters,
      plateMode: 'catalog_category',
      planningSessionId: sessionId,
      categoryId: params.category.id,
      categoryNameSnapshot: params.category.name.trim(),
      catalogItems: immutableSnapshots,
      stage: draft.slicerVerified ? 'Ready to Print' : 'Planned',
      machineId: null, // Never auto-assign machine
      estimatedMinutes: Math.max(1, Math.round(draft.estimatedMinutes || 180)),
      actualMinutes: 0,
      slicerVerified: Boolean(draft.slicerVerified),
      stockApplied: false,
      stockTransactionId: null,
      failedCount: 0,
      failureReason: '',
      notes:
        draft.notes?.trim() ||
        `Product Studio · ${params.category.name} (${unitTotal} pcs)`,
      createdIso: nowIso,
      updatedIso: nowIso,
      completedIso: null,
    };

    createdJobs.push(job);
  }

  const totalConfirmedUnits = createdJobs.reduce(
    (sum, j) => sum + countCatalogItems(j.catalogItems),
    0
  );

  // Ensure all colors assigned to plates are recorded in project.assignedColorIds
  const nextProjects = workspace.projects.map((p) => {
    if (p.id !== project.id) return p;
    const currentAssigned = new Set(p.assignedColorIds || []);
    let modified = false;
    for (const cid of assignedColorIdsToAdd) {
      if (!currentAssigned.has(cid)) {
        currentAssigned.add(cid);
        modified = true;
      }
    }
    if (!modified) return p;
    return {
      ...p,
      assignedColorIds: Array.from(currentAssigned),
      updatedIso: nowIso,
    };
  });

  const distinctColorNames = Array.from(
    new Set(createdJobs.map((j) => workspace.colors.find((c) => c.id === j.colorId)?.name || 'Unassigned Color'))
  ).join(', ');

  const logMsg = `${project.name} · ${distinctColorNames} (${params.category.name}): Added ${createdJobs.length} plate(s) (${totalConfirmedUnits} pcs) from Product Studio.`;

  return {
    createdJobs,
    nextWorkspace: {
      ...workspace,
      projects: nextProjects,
      jobs: [...workspace.jobs, ...createdJobs],
      log: [
        createActivityLogEntry({
          category: 'plate',
          msg: logMsg,
          projectId: project.id,
          nowMs,
          timezone,
        }),
        ...workspace.log,
      ].slice(0, 200),
      updatedIso: nowIso,
    },
  };
}

/**
 * Pure independent batch plate planner for Built-in Alphabet (A–Z) OR Built-in Charm Keycaps:
 * - Treats `batchLetters` / `batchCharms` as NEW quantities to plan right now (independent of historical completed production!).
 * - Enforces Category-Based Plate Mixing: `'alphabet_only'` plans ONLY A–Z letters; `'charm_only'` plans ONLY Charm keycaps (never mixing A–Z and Charm on the same plate when category isolation is active).
 * - Never forces completed quantities as locked minimum inputs.
 */
export function generateIndependentKeycapBatchPreviews(params: {
  existingJobs: readonly ProductionJob[];
  projectId: string;
  colorId?: string;
  mode: 'alphabet_only' | 'charm_only';
  batchLetters?: LettersMap;
  batchCharms?: CharmsMap;
  capacity: number;
  defaultMinutesPerPlate: number;
  nowMs?: number;
}): {
  fullPlates: DraftPlatePreview[];
  remainderLetters: LettersMap;
  remainderCharms: CharmsMap;
  remainderCount: number;
  neededForNextFullPlate: number;
  totalRequestedCount: number;
} {
  const safeCap = Math.max(1, Math.floor(params.capacity || 138));
  const safeMins = Math.max(1, Math.round(params.defaultMinutesPerPlate || 195));
  const nowMs = params.nowMs ?? Date.now();

  const letterPool: LettersMap =
    params.mode === 'alphabet_only'
      ? normalizeAlphabetMap(params.batchLetters)
      : emptyAlphabetMap();
  const charmPool: Record<CharmId, number> =
    params.mode === 'charm_only'
      ? normalizeCharmsMap(params.batchCharms)
      : emptyCharmsMap();

  const totalRequestedCount =
    countLetters(letterPool) + countCharms(charmPool);
  const fullPlateCount = Math.floor(totalRequestedCount / safeCap);
  const remainderCount = totalRequestedCount % safeCap;
  const neededForNextFullPlate = remainderCount === 0 ? 0 : safeCap - remainderCount;

  const nextPlateNumber = getNextSequentialPlateNumberGenerator(
    params.existingJobs,
    params.projectId,
    params.colorId
  );

  const fullPlates: DraftPlatePreview[] = [];

  for (let p = 0; p < fullPlateCount; p += 1) {
    let room = safeCap;
    const plateLetters: LettersMap = {};
    const plateCharms: CharmsMap = {};

    if (params.mode === 'alphabet_only') {
      const sortedLetters = ABC.filter((l) => (letterPool[l] || 0) > 0).sort(
        (a, b) => (letterPool[b] || 0) - (letterPool[a] || 0) || ABC.indexOf(a) - ABC.indexOf(b)
      );
      for (const letter of sortedLetters) {
        if (room <= 0) break;
        const take = Math.min(letterPool[letter] || 0, room);
        if (take > 0) {
          plateLetters[letter] = take;
          letterPool[letter] -= take;
          room -= take;
        }
      }
    } else {
      const sortedCharms = CHARM_IDS.filter((cid) => (charmPool[cid] || 0) > 0).sort(
        (a, b) =>
          (charmPool[b] || 0) - (charmPool[a] || 0) ||
          CHARM_IDS.indexOf(a) - CHARM_IDS.indexOf(b)
      );
      for (const cid of sortedCharms) {
        if (room <= 0) break;
        const take = Math.min(charmPool[cid] || 0, room);
        if (take > 0) {
          plateCharms[cid] = take;
          charmPool[cid] -= take;
          room -= take;
        }
      }
    }

    const compactedL = compactLettersMap(plateLetters);
    const compactedC = compactCharmsMap(plateCharms);
    fullPlates.push({
      tempId: `batch-draft-${nowMs}-${p}`,
      plateNumber: nextPlateNumber(),
      capacity: safeCap,
      letters: compactedL,
      charms: compactedC,
      plateMode: inferPlateMode(compactedL, compactedC),
      estimatedMinutes: safeMins,
      slicerVerified: false,
      notes: '',
    });
  }

  return {
    fullPlates,
    remainderLetters: compactLettersMap(letterPool),
    remainderCharms: compactCharmsMap(charmPool),
    remainderCount,
    neededForNextFullPlate,
    totalRequestedCount,
  };
}

/**
 * Helper to validate that a Built-in Keycap staged plate does not violate
 * single-category plate isolation (A–Z letters and Charm keycaps must not mix on new plates).
 */
export function validateBuiltInPlateCategoryIsolation(
  plate: Pick<DraftPlatePreview, 'plateNumber' | 'letters' | 'charms'>,
  expectedMode: PlateGenerationMode
): { valid: boolean; error?: string } {
  const lCount = countLetters(plate.letters);
  const cCount = countCharms(plate.charms);

  if (lCount > 0 && cCount > 0) {
    return {
      valid: false,
      error: `Cross-category plate mixing blocked on Plate ${plate.plateNumber}: Alphabet Keycaps and Charm Keycaps belong to different categories and cannot share one plate.`,
    };
  }
  if (expectedMode === 'alphabet_only' && cCount > 0) {
    return {
      valid: false,
      error: `Plate ${plate.plateNumber} contains Charm Keycaps while planning Alphabet Keycaps.`,
    };
  }
  if (expectedMode === 'charm_only' && lCount > 0) {
    return {
      valid: false,
      error: `Plate ${plate.plateNumber} contains Alphabet Keycaps while planning Charm Keycaps.`,
    };
  }
  return { valid: true };
}
