import {
  ABC,
  CHARM_DEFINITIONS,
} from '../constants';
import {
  CharmsMap,
  JobCatalogItemSnapshot,
  LettersMap,
  ProductionJob,
  ProductionWorkspaceV5,
} from '../types';
import {
  formatCompletedTimestampMY,
  MALAYSIA_TIMEZONE,
  toComparableYYYYMMDD,
} from './dateFormat';
import { resolveJobCompletionTimestampMs } from './productionCountdown';

export const COMPLETED_AUTO_ARCHIVE_HOURS = 72;
export const COMPLETED_AUTO_ARCHIVE_MS =
  COMPLETED_AUTO_ARCHIVE_HOURS * 60 * 60 * 1000;

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
 * Derived 72-hour automatic archive classification.
 * - Applies strictly when `job.stage === 'Completed'`.
 * - Requires a valid persisted completion timestamp (`resolveJobCompletionTimestampMs`).
 * - Becomes true when `nowMs >= completedAtMs + (72 * 60 * 60 * 1000)`.
 * - Legacy jobs with missing/invalid timestamps return `false` (never auto-archived).
 */
export function isCompletedAutoArchived(
  job: Pick<
    ProductionJob,
    'stage' | 'actualCompletedAt' | 'actualCompletedAtMs' | 'completedIso'
  >,
  nowMs: number
): boolean {
  if (job.stage !== 'Completed') return false;
  if (!Number.isFinite(nowMs)) return false;
  const completedMs = resolveJobCompletionTimestampMs(job);
  if (completedMs === null) return false;
  return nowMs >= completedMs + COMPLETED_AUTO_ARCHIVE_MS;
}

/**
 * Returns true if a `Completed` plate belongs in the Completed Archive
 * (either automatically after 72h OR via manual archive flag).
 */
export function isCompletedArchivedJob(
  job: Pick<
    ProductionJob,
    'stage' | 'archived' | 'actualCompletedAt' | 'actualCompletedAtMs' | 'completedIso'
  >,
  nowMs: number
): boolean {
  if (job.stage !== 'Completed') return false;
  return Boolean(job.archived) || isCompletedAutoArchived(job, nowMs);
}

/**
 * Sorts Completed plates descending by their persisted completion timestamp (newest first).
 * - Never substitutes `updatedIso`, `createdIso`, or plate numbers when timestamps exist.
 * - Places jobs with valid timestamps before legacy jobs lacking timestamps.
 * - Uses deterministic stable secondary tie-breakers (`plateNumber`, then `id`) when equal.
 */
export function compareCompletedJobsNewestFirst(
  a: Pick<
    ProductionJob,
    'id' | 'plateNumber' | 'actualCompletedAt' | 'actualCompletedAtMs' | 'completedIso'
  >,
  b: Pick<
    ProductionJob,
    'id' | 'plateNumber' | 'actualCompletedAt' | 'actualCompletedAtMs' | 'completedIso'
  >
): number {
  const aMs = resolveJobCompletionTimestampMs(a);
  const bMs = resolveJobCompletionTimestampMs(b);

  if (aMs !== null && bMs !== null) {
    if (bMs !== aMs) return bMs - aMs;
  } else if (aMs !== null) {
    return -1;
  } else if (bMs !== null) {
    return 1;
  }

  if (a.plateNumber !== b.plateNumber) {
    return a.plateNumber - b.plateNumber;
  }
  return a.id.localeCompare(b.id);
}

/**
 * Extracts a plate's persisted completion calendar date (`YYYY-MM-DD`) in `Asia/Kuala_Lumpur`.
 * Returns `null` when completion timestamp is missing or invalid.
 */
export function getCompletionCalendarDateMY(
  job: Pick<ProductionJob, 'actualCompletedAt' | 'actualCompletedAtMs' | 'completedIso'>,
  timeZone: string = MALAYSIA_TIMEZONE
): string | null {
  const completedMs = resolveJobCompletionTimestampMs(job);
  if (completedMs === null) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(completedMs));
    const dd = parts.find((p) => p.type === 'day')?.value;
    const mm = parts.find((p) => p.type === 'month')?.value;
    const yyyy = parts.find((p) => p.type === 'year')?.value;
    if (!dd || !mm || !yyyy) return null;
    return `${yyyy}-${mm}-${dd}`;
  } catch {
    return null;
  }
}

export interface CompletedArchiveFilterOptions {
  workspace: Pick<ProductionWorkspaceV5, 'projects' | 'colors' | 'machines'>;
  nowMs: number;
  searchQuery?: string;
  projectId?: string;
  colorId?: string;
  machineId?: string;
  dateFrom?: string;
  dateTo?: string;
  timeZone?: string;
}

export interface CompletedArchiveFilterResult {
  jobs: ProductionJob[];
  totalArchivedPlates: number;
  totalArchivedUnits: number;
  filteredUnits: number;
}

/**
 * Returns Completed Archive plates (sorted newest-first) alongside full & filtered counts,
 * matching against project name, product snapshot name, filament color name, SKU, variation labels,
 * plate number, and Malaysia (`Asia/Kuala_Lumpur`) completion calendar date range.
 */
export function filterCompletedArchiveJobs(
  allJobs: readonly ProductionJob[],
  options: CompletedArchiveFilterOptions
): CompletedArchiveFilterResult {
  const {
    workspace,
    nowMs,
    searchQuery = '',
    projectId = 'ALL',
    colorId = 'ALL',
    machineId = 'ALL',
    dateFrom = '',
    dateTo = '',
    timeZone = MALAYSIA_TIMEZONE,
  } = options;

  const archivedPool = allJobs
    .filter((job) => isCompletedArchivedJob(job, nowMs))
    .sort(compareCompletedJobsNewestFirst);

  const totalArchivedUnits = archivedPool.reduce(
    (sum, job) => sum + extractCompletedPlateBreakdown(job).totalQuantity,
    0
  );

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const normalizedFrom = toComparableYYYYMMDD(dateFrom);
  const normalizedTo = toComparableYYYYMMDD(dateTo);

  const projectMap = new Map(workspace.projects.map((p) => [p.id, p]));
  const colorMap = new Map(workspace.colors.map((c) => [c.id, c]));
  const machineMap = new Map(workspace.machines.map((m) => [m.id, m]));

  const filtered = archivedPool.filter((job) => {
    if (projectId !== 'ALL' && job.projectId !== projectId) return false;
    if (colorId === 'UNASSIGNED') {
      if (job.colorId && job.colorId !== 'unassigned') return false;
    } else if (colorId !== 'ALL' && job.colorId !== colorId) {
      return false;
    }
    if (machineId === 'UNASSIGNED') {
      if (job.machineId !== null && job.machineId !== '') return false;
    } else if (machineId !== 'ALL' && job.machineId !== machineId) {
      return false;
    }

    if (normalizedFrom || normalizedTo) {
      const jobDateMY = getCompletionCalendarDateMY(job, timeZone);
      if (!jobDateMY) return false;
      if (normalizedFrom && jobDateMY < normalizedFrom) return false;
      if (normalizedTo && jobDateMY > normalizedTo) return false;
    }

    if (normalizedQuery) {
      const project = projectMap.get(job.projectId);
      const color = colorMap.get(job.colorId);
      const machine = job.machineId ? machineMap.get(job.machineId) : undefined;
      const breakdown = extractCompletedPlateBreakdown(job);

      const searchableParts = [
        `plate ${job.plateNumber}`,
        project?.name || '',
        project?.productType || '',
        breakdown.productName || '',
        job.categoryNameSnapshot || '',
        color?.name || 'unassigned color',
        machine?.name || '',
        ...breakdown.items.flatMap((it) => [
          it.productName || '',
          it.label || '',
          it.sku || '',
        ]),
      ];

      const haystack = searchableParts.join(' ').toLowerCase();
      const terms = normalizedQuery.split(/\s+/).filter(Boolean);
      if (!terms.every((term) => haystack.includes(term))) {
        return false;
      }
    }

    return true;
  });

  const filteredUnits = filtered.reduce(
    (sum, job) => sum + extractCompletedPlateBreakdown(job).totalQuantity,
    0
  );

  return {
    jobs: filtered,
    totalArchivedPlates: archivedPool.length,
    totalArchivedUnits,
    filteredUnits,
  };
}

/**
 * Computes total successfully completed units strictly from `Completed` plates
 * (including both active Completed and archived Completed plates, zero double counting),
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
