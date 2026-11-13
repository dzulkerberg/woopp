import {
  ABC,
  CHARM_DEFINITIONS,
} from '../constants';
import {
  CharmsMap,
  JobCatalogItemSnapshot,
  LettersMap,
  ProductionJob,
} from '../types';
import {
  formatCompletedTimestampMY,
  MALAYSIA_TIMEZONE,
} from './dateFormat';

export interface PlateVariationItem {
  key: string;
  source: 'catalog' | 'letter' | 'charm';
  productId?: string;
  productName?: string;
  variantId?: string | null;
  sku?: string;
  label: string;
  isVariationless: boolean;
  quantity: number;
}

export interface CompletedPlateBreakdown {
  hasRecordedBreakdown: boolean;
  isCompleted: boolean;
  productName: string | null;
  items: PlateVariationItem[];
  totalQuantity: number;
  hasVariations: boolean;
  failedAttempts: number;
}

/**
 * Extracts exact persisted variation quantities for a single ProductionJob plate snapshot.
 * - Reads strictly from `job.catalogItems`, `job.letters`, and `job.charms` (never live catalog).
 * - Never sums or leaks counts from other plates or planner order totals.
 * - Filters strictly to `quantity > 0`.
 * - Preserves distinct `productId + variantId` identities even when labels look similar.
 * - De-duplicates companion A–Z `letters` that mirror single-letter `catalogItems` variants.
 */
export function extractCompletedPlateBreakdown(
  job: Pick<
    ProductionJob,
    'stage' | 'catalogItems' | 'letters' | 'charms' | 'failedCount' | 'categoryNameSnapshot'
  >
): CompletedPlateBreakdown {
  const catalogItems = Array.isArray(job.catalogItems) ? job.catalogItems : [];
  const itemsByIdentity = new Map<string, PlateVariationItem>();
  const mirroredFromCatalog: Record<string, number> = {};
  const productNames: string[] = [];

  for (let i = 0; i < catalogItems.length; i += 1) {
    const ci: JobCatalogItemSnapshot | undefined = catalogItems[i];
    if (!ci) continue;
    const qty = Math.floor(Number(ci.quantity || 0));
    if (!Number.isFinite(qty) || qty <= 0) continue;

    const productName = (ci.productName || '').trim();
    if (productName && !productNames.includes(productName)) {
      productNames.push(productName);
    }

    const rawVariantId =
      typeof ci.variantId === 'string' && ci.variantId.trim().length > 0
        ? ci.variantId.trim()
        : null;
    const rawVariantLabel =
      typeof ci.variantLabel === 'string' && ci.variantLabel.trim().length > 0
        ? ci.variantLabel.trim()
        : null;
    const sku = typeof ci.sku === 'string' ? ci.sku.trim() : '';

    // Track single-letter catalog snapshots so companion `letters` map isn't double-counted
    if (rawVariantLabel) {
      const upperLabel = rawVariantLabel.toUpperCase();
      if (upperLabel.length === 1 && ABC.includes(upperLabel as any)) {
        mirroredFromCatalog[upperLabel] =
          (mirroredFromCatalog[upperLabel] || 0) + qty;
      }
    }

    const isVariationless = rawVariantId === null && rawVariantLabel === null;
    const identityKey = rawVariantId
      ? `catalog:${ci.productId}:${rawVariantId}`
      : `catalog:${ci.productId}:none:${sku}:${rawVariantLabel || productName}`;

    const existing = itemsByIdentity.get(identityKey);
    if (existing) {
      existing.quantity += qty;
    } else {
      itemsByIdentity.set(identityKey, {
        key: identityKey,
        source: 'catalog',
        productId: ci.productId,
        productName: productName || undefined,
        variantId: rawVariantId,
        sku: sku || undefined,
        label: rawVariantLabel || productName || 'Standard Item',
        isVariationless,
        quantity: qty,
      });
    }
  }

  // Extract built-in A–Z letters (excluding companion duplicates already represented in catalogItems)
  const letters: LettersMap | null | undefined = job.letters;
  if (letters) {
    for (const letter of ABC) {
      const rawQty = Math.floor(Number(letters[letter] || 0));
      const extraQty = Math.max(0, rawQty - (mirroredFromCatalog[letter] || 0));
      if (extraQty > 0) {
        itemsByIdentity.set(`letter:${letter}`, {
          key: `letter:${letter}`,
          source: 'letter',
          label: letter,
          isVariationless: false,
          quantity: extraQty,
        });
      }
    }
  }

  // Extract built-in charms
  const charms: CharmsMap | Partial<Record<string, number>> | null | undefined =
    job.charms;
  if (charms) {
    for (const def of CHARM_DEFINITIONS) {
      const qty = Math.floor(Number(charms[def.id] || 0));
      if (qty > 0) {
        itemsByIdentity.set(`charm:${def.id}`, {
          key: `charm:${def.id}`,
          source: 'charm',
          label: `${def.symbol} ${def.label}`,
          isVariationless: false,
          quantity: qty,
        });
      }
    }
  }

  const items = Array.from(itemsByIdentity.values());
  const totalQuantity = items.reduce((sum, it) => sum + it.quantity, 0);
  const hasRecordedBreakdown = items.length > 0 && totalQuantity > 0;
  const hasVariations = items.some((it) => !it.isVariationless);

  const productName =
    productNames.length > 0
      ? productNames.join(' · ')
      : job.categoryNameSnapshot?.trim() || null;

  return {
    hasRecordedBreakdown,
    isCompleted: job.stage === 'Completed',
    productName,
    items,
    totalQuantity,
    hasVariations,
    failedAttempts: Math.max(0, Math.floor(Number(job.failedCount || 0))),
  };
}

/**
 * Formats the plate's actual completion timestamp in Malaysia Time (`Asia/Kuala_Lumpur`),
 * returning `'Not recorded'` when missing or invalid without backfilling `now` or `updatedIso`.
 */
export function resolveCompletedTimestampLabel(
  job: Pick<ProductionJob, 'actualCompletedAt' | 'actualCompletedAtMs' | 'completedIso'>,
  timeZone: string = MALAYSIA_TIMEZONE
): string {
  const raw =
    job.actualCompletedAt ??
    job.actualCompletedAtMs ??
    job.completedIso ??
    null;
  return formatCompletedTimestampMY(raw, timeZone);
}

/**
 * Computes total successfully completed units strictly from `Completed` plates,
 * ignoring `Failed / Reprint`, `Cancelled`, and in-progress plates.
 */
export function computeSuccessfulCompletedUnits(
  jobs: readonly ProductionJob[]
): number {
  return jobs.reduce((sum, job) => {
    if (job.stage !== 'Completed') return sum;
    return sum + extractCompletedPlateBreakdown(job).totalQuantity;
  }, 0);
}
