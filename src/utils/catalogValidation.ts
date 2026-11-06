import {
  CatalogProduct,
  CatalogSkuReservation,
  CatalogStatus,
  CatalogVariantDoc,
  CategoryAllocationMode,
  CategoryIconName,
  CategoryPlateSetting,
  ProductCategory,
  ProductOptionDefinition,
  ProductVariant,
} from '../types';
import {
  FirestorePayloadValidationError,
  reportDevUndefinedDiagnostics,
  sanitizeFirestoreValue,
} from './firestorePayload';
import { isValidWooppSku } from './skuGenerator';

export const CATEGORY_ICON_NAMES: readonly CategoryIconName[] = [
  'tag',
  'sparkles',
  'key',
  'box',
  'gift',
  'layers',
  'star',
  'palette',
  'grid',
  'heart',
] as const;

export const CATALOG_STATUSES: readonly CatalogStatus[] = ['active', 'archived'] as const;

export const CATEGORY_ALLOCATION_MODES: readonly CategoryAllocationMode[] = [
  'automatic_capacity',
  'manual_plate',
] as const;

export const MAX_PRODUCT_IMAGES = 12;
export const MAX_PRODUCT_OPTIONS = 4;
export const MAX_PRODUCT_OPTION_VALUES = 60;
export const MAX_OPTION_COMPLEXITY_BUDGET = 120;
export const MAX_PRODUCT_VARIANTS = 60;
export const MAX_IMAGE_URL_LENGTH = 2048;

export const ALPHABET_A_TO_Z: readonly string[] = Object.freeze(
  Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i))
);

export const POPULAR_COLORS: readonly string[] = Object.freeze([
  'White',
  'Black',
  'Red',
  'Blue',
  'Gold',
  'Silver',
  'Green',
  'Yellow',
  'Orange',
  'Purple',
]);

export const NUMBERS_0_TO_9: readonly string[] = Object.freeze([
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
]);

export interface HttpsUrlValidationResult {
  valid: boolean;
  normalizedUrl: string | null;
  error?: string;
}

/**
 * Validates external HTTPS image URLs for Product Studio categories, products, and variants.
 * - Empty/whitespace input returns `{ valid: true, normalizedUrl: null }` for optional fields.
 * - Rejects `data:` base64 URIs so large binary blobs are NEVER stored in Firestore documents.
 * - Rejects `http://`, `blob:`, `file:`, relative paths, and malformed URLs.
 */
export function validateHttpsImageUrl(raw: unknown): HttpsUrlValidationResult {
  if (raw === null || raw === undefined) {
    return { valid: true, normalizedUrl: null };
  }
  if (typeof raw !== 'string') {
    return {
      valid: false,
      normalizedUrl: null,
      error: 'Image URL must be a valid HTTPS link.',
    };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { valid: true, normalizedUrl: null };
  }

  if (/^data:/i.test(trimmed)) {
    return {
      valid: false,
      normalizedUrl: null,
      error:
        'Base64 (data:) images are not supported in Cloud Firestore. Provide an external https:// image URL instead.',
    };
  }

  if (trimmed.length > MAX_IMAGE_URL_LENGTH) {
    return {
      valid: false,
      normalizedUrl: null,
      error: `Image URL exceeds maximum length of ${MAX_IMAGE_URL_LENGTH} characters.`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      valid: false,
      normalizedUrl: null,
      error: 'Enter a valid external https:// image URL.',
    };
  }

  if (parsed.protocol !== 'https:') {
    return {
      valid: false,
      normalizedUrl: null,
      error: 'Image URL must use secure https:// protocol.',
    };
  }

  if (!parsed.hostname || !parsed.hostname.includes('.')) {
    return {
      valid: false,
      normalizedUrl: null,
      error: 'Image URL must include a valid domain host.',
    };
  }

  return {
    valid: true,
    normalizedUrl: parsed.toString(),
  };
}

export type VariantGenerationStrategy = 'cartesian' | 'primary_only';

/**
 * Generates variants from option definitions and preserves any existing
 * variant-specific `priceMyr` and `imageUrl` when option values match.
 * - Supports full Alphabet A–Z (26 values) and custom lists.
 * - Avoids excessive Cartesian product explosion when multiple option groups exist
 *   by capping total auto-generated combinations at MAX_PRODUCT_VARIANTS (60), or
 *   generating variants focused on the primary option when selected.
 */
export function syncVariantsFromOptions(
  options: readonly ProductOptionDefinition[],
  existingVariants: readonly ProductVariant[] = [],
  strategy: VariantGenerationStrategy = 'cartesian'
): ProductVariant[] {
  const activeOptions = [...options]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((opt) => ({
      ...opt,
      name: opt.name.trim(),
      values: Array.from(
        new Set(opt.values.map((v) => v.trim()).filter((v) => v.length > 0))
      ),
    }))
    .filter((opt) => opt.name.length > 0 && opt.values.length > 0);

  if (activeOptions.length === 0) {
    return [];
  }

  const buildCanonicalKey = (optionValues: Record<string, string>): string =>
    activeOptions
      .map((opt) => `${opt.name.toLowerCase()}=${(optionValues[opt.name] || '').toLowerCase()}`)
      .join('|');

  const existingByKey = new Map<string, ProductVariant>();
  for (const v of existingVariants) {
    const key = buildCanonicalKey(v.optionValues || {});
    if (key && !existingByKey.has(key)) {
      existingByKey.set(key, v);
    }
  }

  let combinations: Record<string, string>[] = [];

  if (strategy === 'primary_only' && activeOptions.length > 1) {
    // Primary option focus (e.g. all 26 letters of Alphabet), paired with default primary value of other options
    const primaryOpt = activeOptions[0];
    const secondaryDefaults: Record<string, string> = {};
    for (let i = 1; i < activeOptions.length; i += 1) {
      secondaryDefaults[activeOptions[i].name] = activeOptions[i].values[0];
    }
    for (const val of primaryOpt.values) {
      if (combinations.length >= MAX_PRODUCT_VARIANTS) break;
      combinations.push({
        [primaryOpt.name]: val,
        ...secondaryDefaults,
      });
    }
  } else {
    // Cartesian product capped at MAX_PRODUCT_VARIANTS to avoid runaway combinatorial explosions
    combinations = [{}];
    for (const opt of activeOptions) {
      const next: Record<string, string>[] = [];
      for (const combo of combinations) {
        for (const val of opt.values) {
          if (next.length >= MAX_PRODUCT_VARIANTS) break;
          next.push({
            ...combo,
            [opt.name]: val,
          });
        }
        if (next.length >= MAX_PRODUCT_VARIANTS) break;
      }
      combinations = next;
    }
  }

  return combinations.map((optionValues, idx) => {
    const label = activeOptions.map((opt) => optionValues[opt.name]).join(' / ');
    const key = buildCanonicalKey(optionValues);
    const matched = existingByKey.get(key);

    return {
      id: matched?.id || `var-${idx + 1}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32)}`,
      label,
      optionValues,
      priceMyr:
        matched && typeof matched.priceMyr === 'number' && Number.isFinite(matched.priceMyr) && matched.priceMyr >= 0
          ? Math.round(matched.priceMyr * 100) / 100
          : null,
      imageUrl: matched?.imageUrl ?? null,
      sortOrder: idx,
    };
  });
}

function assertValidEntityId(id: unknown, fieldPath: string): string {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id.trim())) {
    throw new FirestorePayloadValidationError(
      fieldPath,
      'ID must be 1–128 alphanumeric, underscore, or hyphen characters.'
    );
  }
  return id.trim();
}

function assertUtcIsoString(val: unknown, fieldPath: string): string {
  if (typeof val !== 'string' || val.trim().length === 0) {
    throw new FirestorePayloadValidationError(fieldPath, 'Expected UTC ISO timestamp string.');
  }
  const ms = Date.parse(val);
  if (!Number.isFinite(ms)) {
    throw new FirestorePayloadValidationError(fieldPath, `Invalid ISO timestamp "${val}".`);
  }
  return new Date(ms).toISOString();
}

function normalizePriceMyr(val: unknown, fieldPath: string): number | null {
  if (val === null || val === undefined || val === '') {
    return null;
  }
  const num = typeof val === 'string' ? Number(val) : val;
  if (typeof num !== 'number' || !Number.isFinite(num) || num < 0) {
    throw new FirestorePayloadValidationError(
      fieldPath,
      'Selling price (MYR) must be a non-negative number or empty.'
    );
  }
  return Math.round(num * 100) / 100;
}

/**
 * Validates and sanitizes a `ProductCategory` before writing to
 * `users/{uid}/catalogCategories/{categoryId}` with zero `undefined` values.
 */
export function prepareCategoryForFirestore(
  category: ProductCategory,
  ownerId: string
): ProductCategory {
  const docLabel = `users/${ownerId}/catalogCategories/${category?.id || 'unknown'}`;
  reportDevUndefinedDiagnostics(category, docLabel);

  const validOwner = assertValidEntityId(ownerId, 'ownerId');
  const validId = assertValidEntityId(category.id, 'id');
  const trimmedName = typeof category.name === 'string' ? category.name.trim() : '';
  if (!trimmedName || trimmedName.length > 120) {
    throw new FirestorePayloadValidationError(
      'name',
      'Category name is required (1–120 characters).'
    );
  }

  const description =
    typeof category.description === 'string' ? category.description.trim().slice(0, 1000) : '';

  const imgCheck = validateHttpsImageUrl(category.imageUrl);
  if (!imgCheck.valid) {
    throw new FirestorePayloadValidationError(
      'imageUrl',
      imgCheck.error || 'Invalid category image URL.'
    );
  }

  const iconName: CategoryIconName = CATEGORY_ICON_NAMES.includes(category.iconName)
    ? category.iconName
    : 'tag';

  const status: CatalogStatus = CATALOG_STATUSES.includes(category.status)
    ? category.status
    : 'active';

  const sortOrder =
    typeof category.sortOrder === 'number' && Number.isFinite(category.sortOrder)
      ? Math.max(0, Math.floor(category.sortOrder))
      : 0;

  const clean: ProductCategory = {
    id: validId,
    ownerId: validOwner,
    name: trimmedName,
    description,
    imageUrl: imgCheck.normalizedUrl,
    iconName,
    sortOrder,
    status,
    createdAt: assertUtcIsoString(category.createdAt, 'createdAt'),
    updatedAt: assertUtcIsoString(category.updatedAt, 'updatedAt'),
  };

  return sanitizeFirestoreValue(clean);
}

/**
 * Validates and sanitizes a `CatalogProduct` before writing to
 * `users/{uid}/catalogProducts/{productId}` with zero `undefined` values and zero base64 data.
 */
export function prepareProductForFirestore(
  product: CatalogProduct,
  ownerId: string
): CatalogProduct {
  const docLabel = `users/${ownerId}/catalogProducts/${product?.id || 'unknown'}`;
  reportDevUndefinedDiagnostics(product, docLabel);

  const validOwner = assertValidEntityId(ownerId, 'ownerId');
  const validId = assertValidEntityId(product.id, 'id');
  const validCategoryId = assertValidEntityId(product.categoryId, 'categoryId');

  const sku = typeof product.sku === 'string' ? product.sku.trim().toUpperCase() : '';
  if (!isValidWooppSku(sku)) {
    throw new FirestorePayloadValidationError(
      'sku',
      `Invalid auto-generated SKU "${String(product.sku)}". Expected WOOPP-XXXXXXXX.`
    );
  }

  const trimmedName = typeof product.name === 'string' ? product.name.trim() : '';
  if (!trimmedName || trimmedName.length > 160) {
    throw new FirestorePayloadValidationError(
      'name',
      'Product name is required (1–160 characters).'
    );
  }

  const description =
    typeof product.description === 'string' ? product.description.trim().slice(0, 4000) : '';

  const priceMyr = normalizePriceMyr(product.priceMyr, 'priceMyr');

  if (!Array.isArray(product.images)) {
    throw new FirestorePayloadValidationError('images', 'Expected array of product image URLs.');
  }
  if (product.images.length > MAX_PRODUCT_IMAGES) {
    throw new FirestorePayloadValidationError(
      'images',
      `Maximum of ${MAX_PRODUCT_IMAGES} product images allowed.`
    );
  }

  const validatedImages: string[] = [];
  product.images.forEach((rawUrl, idx) => {
    const res = validateHttpsImageUrl(rawUrl);
    if (!res.valid) {
      throw new FirestorePayloadValidationError(
        `images[${idx}]`,
        res.error || 'Invalid product image URL.'
      );
    }
    if (res.normalizedUrl) {
      validatedImages.push(res.normalizedUrl);
    }
  });

  if (!Array.isArray(product.options) || product.options.length > MAX_PRODUCT_OPTIONS) {
    throw new FirestorePayloadValidationError(
      'options',
      `Expected up to ${MAX_PRODUCT_OPTIONS} product options.`
    );
  }

  const validatedOptions: ProductOptionDefinition[] = product.options.map((opt, idx) => {
    const optName = typeof opt.name === 'string' ? opt.name.trim() : '';
    if (!optName || optName.length > 60) {
      throw new FirestorePayloadValidationError(
        `options[${idx}].name`,
        'Option name is required (1–60 characters).'
      );
    }
    if (!Array.isArray(opt.values) || opt.values.length === 0) {
      throw new FirestorePayloadValidationError(
        `options[${idx}].values`,
        `Option "${optName}" must include at least one value.`
      );
    }
    const cleanVals: string[] = [];
    const seenVals = new Set<string>();
    opt.values.forEach((rawVal, vIdx) => {
      if (typeof rawVal !== 'string') {
        throw new FirestorePayloadValidationError(
          `options[${idx}].values[${vIdx}]`,
          'Option value must be a string (1–80 characters).'
        );
      }
      const trimmedVal = rawVal.trim();
      if (trimmedVal.length === 0 || trimmedVal.length > 80) {
        throw new FirestorePayloadValidationError(
          `options[${idx}].values[${vIdx}]`,
          'Option value must be between 1 and 80 characters.'
        );
      }
      if (!seenVals.has(trimmedVal)) {
        seenVals.add(trimmedVal);
        cleanVals.push(trimmedVal);
      }
    });
    if (cleanVals.length > MAX_PRODUCT_OPTION_VALUES) {
      throw new FirestorePayloadValidationError(
        `options[${idx}].values`,
        `Option "${optName}" supports at most ${MAX_PRODUCT_OPTION_VALUES} values.`
      );
    }
    const sortOrder =
      typeof opt.sortOrder === 'number' &&
      Number.isInteger(opt.sortOrder) &&
      opt.sortOrder >= 0 &&
      opt.sortOrder <= 10000
        ? opt.sortOrder
        : idx;
    return {
      id: assertValidEntityId(opt.id || `opt-${idx + 1}`, `options[${idx}].id`),
      name: optName,
      values: cleanVals,
      sortOrder,
    };
  });

  const totalOptionValues = validatedOptions.reduce(
    (sum, opt) => sum + opt.values.length,
    0
  );
  if (validatedOptions.length + totalOptionValues > MAX_OPTION_COMPLEXITY_BUDGET) {
    throw new FirestorePayloadValidationError(
      'options',
      `Too many option values across ${validatedOptions.length} option(s). Keep total options + values within ${MAX_OPTION_COMPLEXITY_BUDGET} (up to ${MAX_PRODUCT_VARIANTS} product variants).`
    );
  }

  if (!Array.isArray(product.variants) || product.variants.length > MAX_PRODUCT_VARIANTS) {
    throw new FirestorePayloadValidationError(
      'variants',
      `Expected up to ${MAX_PRODUCT_VARIANTS} product variants.`
    );
  }

  const validatedVariants: ProductVariant[] = product.variants.map((variant, idx) => {
    const label = typeof variant.label === 'string' ? variant.label.trim() : '';
    if (!label || label.length > 200) {
      throw new FirestorePayloadValidationError(
        `variants[${idx}].label`,
        'Variant label is required (1–200 characters).'
      );
    }
    const optionValues: Record<string, string> = {};
    if (variant.optionValues && typeof variant.optionValues === 'object' && !Array.isArray(variant.optionValues)) {
      for (const [k, v] of Object.entries(variant.optionValues)) {
        if (typeof k === 'string' && typeof v === 'string' && k.trim() && v.trim()) {
          optionValues[k.trim().slice(0, 60)] = v.trim().slice(0, 80);
        }
      }
    }
    if (Object.keys(optionValues).length > MAX_PRODUCT_OPTIONS) {
      throw new FirestorePayloadValidationError(
        `variants[${idx}].optionValues`,
        `Variant optionValues supports at most ${MAX_PRODUCT_OPTIONS} options.`
      );
    }

    const vImgCheck = validateHttpsImageUrl(variant.imageUrl);
    if (!vImgCheck.valid) {
      throw new FirestorePayloadValidationError(
        `variants[${idx}].imageUrl`,
        vImgCheck.error || 'Invalid variant image URL.'
      );
    }

    const sortOrder =
      typeof variant.sortOrder === 'number' &&
      Number.isInteger(variant.sortOrder) &&
      variant.sortOrder >= 0 &&
      variant.sortOrder <= 10000
        ? variant.sortOrder
        : idx;

    return {
      id: assertValidEntityId(variant.id || `var-${idx + 1}`, `variants[${idx}].id`),
      label,
      optionValues,
      priceMyr: normalizePriceMyr(variant.priceMyr, `variants[${idx}].priceMyr`),
      imageUrl: vImgCheck.normalizedUrl,
      sortOrder,
    };
  });

  const status: CatalogStatus = CATALOG_STATUSES.includes(product.status)
    ? product.status
    : 'active';

  const clean: CatalogProduct = {
    id: validId,
    ownerId: validOwner,
    sku,
    name: trimmedName,
    description,
    categoryId: validCategoryId,
    priceMyr,
    images: validatedImages,
    options: validatedOptions,
    variants: validatedVariants,
    status,
    createdAt: assertUtcIsoString(product.createdAt, 'createdAt'),
    updatedAt: assertUtcIsoString(product.updatedAt, 'updatedAt'),
  };

  return sanitizeFirestoreValue(clean);
}

/**
 * Validates and sanitizes a `CatalogSkuReservation` document stored at
 * `users/{uid}/catalogSkus/{sku}`.
 */
export function prepareSkuReservationForFirestore(
  reservation: CatalogSkuReservation,
  ownerId: string
): CatalogSkuReservation {
  const validOwner = assertValidEntityId(ownerId, 'ownerId');
  const sku = typeof reservation.sku === 'string' ? reservation.sku.trim().toUpperCase() : '';
  if (!isValidWooppSku(sku)) {
    throw new FirestorePayloadValidationError('sku', 'Invalid WOOPP SKU format.');
  }
  const clean: CatalogSkuReservation = {
    sku,
    ownerId: validOwner,
    productId: assertValidEntityId(reservation.productId, 'productId'),
    createdAt: assertUtcIsoString(reservation.createdAt, 'createdAt'),
  };
  return sanitizeFirestoreValue(clean);
}

/**
 * Validates and sanitizes a `CategoryPlateSetting` document stored at
 * `users/{uid}/catalogPlateSettings/{categoryId}`.
 * Never defaults `plateCapacity` to 138 for unknown categories.
 */
export function prepareCategoryPlateSettingForFirestore(
  setting: CategoryPlateSetting,
  ownerId: string
): CategoryPlateSetting {
  const docLabel = `users/${ownerId}/catalogPlateSettings/${setting?.categoryId || 'unknown'}`;
  reportDevUndefinedDiagnostics(setting, docLabel);

  const validOwner = assertValidEntityId(ownerId, 'ownerId');
  const validCategoryId = assertValidEntityId(setting.categoryId, 'categoryId');
  const allocationMode: CategoryAllocationMode = CATEGORY_ALLOCATION_MODES.includes(
    setting.allocationMode
  )
    ? setting.allocationMode
    : 'automatic_capacity';

  let plateCapacity: number | null = null;
  if (setting.plateCapacity !== null && setting.plateCapacity !== undefined) {
    if (
      typeof setting.plateCapacity !== 'number' ||
      !Number.isFinite(setting.plateCapacity) ||
      Math.floor(setting.plateCapacity) < 1 ||
      Math.floor(setting.plateCapacity) > 5000
    ) {
      throw new FirestorePayloadValidationError(
        'plateCapacity',
        'Configured category plate capacity must be between 1 and 5000 pcs, or null.'
      );
    }
    plateCapacity = Math.floor(setting.plateCapacity);
  }

  const defaultEstimatedMinutes =
    typeof setting.defaultEstimatedMinutes === 'number' &&
    Number.isFinite(setting.defaultEstimatedMinutes) &&
    setting.defaultEstimatedMinutes >= 1
      ? Math.min(4320, Math.round(setting.defaultEstimatedMinutes))
      : 180;

  const clean: CategoryPlateSetting = {
    categoryId: validCategoryId,
    ownerId: validOwner,
    allocationMode,
    plateCapacity,
    defaultEstimatedMinutes,
    updatedAt: assertUtcIsoString(setting.updatedAt, 'updatedAt'),
  };

  return sanitizeFirestoreValue(clean);
}

/**
 * Validates and sanitizes a `CatalogVariantDoc` before writing to
 * `users/{uid}/catalogProducts/{productId}/variants/{variantId}`.
 */
export function prepareVariantDocForFirestore(
  variant: ProductVariant,
  ownerId: string,
  productId: string,
  timestamps?: { createdAt?: string; updatedAt?: string }
): CatalogVariantDoc {
  const validOwner = assertValidEntityId(ownerId, 'ownerId');
  const validProductId = assertValidEntityId(productId, 'productId');
  const validId = assertValidEntityId(variant.id || 'var-1', 'id');

  const trimmedLabel = typeof variant.label === 'string' ? variant.label.trim() : '';
  if (!trimmedLabel || trimmedLabel.length > 200) {
    throw new FirestorePayloadValidationError(
      'label',
      'Variant label is required (1–200 characters).'
    );
  }

  const optionValues: Record<string, string> = {};
  if (
    variant.optionValues &&
    typeof variant.optionValues === 'object' &&
    !Array.isArray(variant.optionValues)
  ) {
    for (const [k, v] of Object.entries(variant.optionValues)) {
      if (typeof k === 'string' && typeof v === 'string' && k.trim() && v.trim()) {
        optionValues[k.trim().slice(0, 60)] = v.trim().slice(0, 80);
      }
    }
  }

  const imgCheck = validateHttpsImageUrl(variant.imageUrl);
  if (!imgCheck.valid) {
    throw new FirestorePayloadValidationError(
      'imageUrl',
      imgCheck.error || 'Invalid variant image URL.'
    );
  }

  const sortOrder =
    typeof variant.sortOrder === 'number' &&
    Number.isInteger(variant.sortOrder) &&
    variant.sortOrder >= 0 &&
    variant.sortOrder <= 10000
      ? variant.sortOrder
      : 0;

  const priceMyr = normalizePriceMyr(variant.priceMyr, 'priceMyr');
  const nowIso = new Date().toISOString();

  const clean: CatalogVariantDoc = {
    id: validId,
    productId: validProductId,
    ownerId: validOwner,
    label: trimmedLabel,
    optionValues,
    priceMyr,
    imageUrl: imgCheck.normalizedUrl,
    sortOrder,
    createdAt: assertUtcIsoString(timestamps?.createdAt || nowIso, 'createdAt'),
    updatedAt: assertUtcIsoString(timestamps?.updatedAt || nowIso, 'updatedAt'),
  };

  return sanitizeFirestoreValue(clean);
}
