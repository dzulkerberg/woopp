import { ABC, CHARM_DEFINITIONS } from '../constants';
import {
  ColorOption,
  KanbanStage,
  PlateGenerationMode,
  ProductionBatchRecord,
  ProductionJob,
  ProductionProject,
  ProductionWorkspaceV5,
} from '../types';
import {
  extractCompletedPlateBreakdown,
  isCompletedArchivedJob,
  PlateVariationItem,
  resolveCompletedTimestampLabel,
} from './completedPlateUtils';
import { DEFAULT_TIMEZONE, formatDateDDMMYYYY } from './dateFormat';

export const UNASSIGNED_COLOR_KEY = '__unassigned__';

export interface ProductionRelationshipAuditReport {
  totalJobs: number;
  uniqueJobCount: number;
  duplicateJobIds: string[];
  validProjectJobs: ProductionJob[];
  missingProjectJobs: ProductionJob[];
  invalidProjectRefJobs: ProductionJob[];
  unlinkedJobs: ProductionJob[];
  legacyRelationshipJobs: ProductionJob[];
  completedJobs: ProductionJob[];
  archivedCompletedJobs: ProductionJob[];
  completedReprintJobs: ProductionJob[];
  failedOrCancelledJobs: ProductionJob[];
  inProgressOrPlannedJobs: ProductionJob[];
  jobsMissingVariationSnapshots: ProductionJob[];
  jobsMissingColorRef: ProductionJob[];
}

export type BatchCompletionStatus = 'completed' | 'partial' | 'in_progress';

export type BatchIdentitySource =
  | 'persisted_record'
  | 'job_batch_id'
  | 'reconstructed_session';

export interface BatchVariationProgress {
  variationKey: string;
  variantId: string | null;
  label: string;
  isVariationless: boolean;
  source: 'catalog' | 'letter' | 'charm';
  requestedQuantity: number;
  completedQuantity: number;
  remainingQuantity: number;
  overProducedQuantity: number;
  completedPlateNumbers: number[];
}

export interface BatchPlateSummary {
  jobId: string;
  plateNumber: number;
  plateCapacity: number;
  stage: KanbanStage;
  isCompleted: boolean;
  isArchivedCompleted: boolean;
  isReprintCompleted: boolean;
  isFailedOrCancelled: boolean;
  failedCount: number;
  machineId: string | null;
  plannedUnits: number;
  completedUnits: number;
  hasRecordedBreakdown: boolean;
  completedAtLabel: string;
  notes: string;
}

export interface BatchProductionSummary {
  batchId: string;
  batchNumber: number;
  batchLabel: string;
  identitySource: BatchIdentitySource;
  projectId: string;
  productId: string;
  productName: string;
  sku: string | null;
  categoryId: string | null;
  categoryName: string | null;
  colorId: string;
  colorName: string;
  colorHex: string;
  isUnassignedColor: boolean;
  isMissingColorCatalogRef: boolean;
  mode: PlateGenerationMode;
  plateCapacity: number;
  createdIso: string;
  createdDateLabel: string;
  requestedQuantity: number;
  committedQuantity: number;
  completedQuantity: number;
  remainingQuantity: number;
  generatedPlateCount: number;
  completedPlateCount: number;
  archivedCompletedPlateCount: number;
  activePendingPlateCount: number;
  failedReprintPlateCount: number;
  cancelledPlateCount: number;
  reprintCompletedPlateCount: number;
  plateNumbers: number[];
  completedPlateNumbers: number[];
  pendingPlateNumbers: number[];
  missingSnapshotPlateNumbers: number[];
  completionStatus: BatchCompletionStatus;
  completionStatusLabel: string;
  isCompleteForBulkPrint: boolean;
  hasPartialWarning: boolean;
  variations: BatchVariationProgress[];
  plates: BatchPlateSummary[];
  warnings: string[];
}

export interface LegacyUnassignedPlateRecord {
  jobId: string;
  plateNumber: number;
  stage: KanbanStage;
  isCompleted: boolean;
  isArchivedCompleted: boolean;
  isReprintCompleted: boolean;
  colorId: string;
  colorName: string;
  colorHex: string;
  productId: string | null;
  productName: string;
  sku: string | null;
  plannedUnits: number;
  completedUnits: number;
  hasRecordedBreakdown: boolean;
  completedAtLabel: string;
  reason: string;
  items: PlateVariationItem[];
}

export interface ProjectProductionSummary {
  project: ProductionProject | null;
  projectId: string;
  projectName: string;
  totalBatches: number;
  completedBatchCount: number;
  partialBatchCount: number;
  inProgressBatchCount: number;
  legacyPlateCount: number;
  totalCompletedPlates: number;
  activeCompletedPlates: number;
  archivedCompletedPlates: number;
  reprintCompletedPlates: number;
  totalRequestedUnits: number;
  totalCompletedUnits: number;
  totalRemainingUnits: number;
  batches: BatchProductionSummary[];
  completedBatches: BatchProductionSummary[];
  legacyJobs: LegacyUnassignedPlateRecord[];
  missingSnapshotPlateNumbers: number[];
  duplicateJobIdsSkipped: string[];
  warnings: string[];
}

/**
 * Performs a strictly read-only integrity audit across all `ProductionJob` records
 * against existing `projects` and `colors` without modifying any Firestore or workspace data.
 */
export function auditProductionJobRelationships(
  workspace: Pick<ProductionWorkspaceV5, 'projects' | 'jobs' | 'colors'>,
  nowMs: number = Date.now()
): ProductionRelationshipAuditReport {
  const projects = Array.isArray(workspace.projects) ? workspace.projects : [];
  const jobs = Array.isArray(workspace.jobs) ? workspace.jobs : [];
  const colors = Array.isArray(workspace.colors) ? workspace.colors : [];

  const projectIds = new Set(projects.map((p) => p.id));
  const colorIds = new Set(colors.map((c) => c.id));
  const seenJobIds = new Set<string>();
  const duplicateJobIds: string[] = [];

  const validProjectJobs: ProductionJob[] = [];
  const missingProjectJobs: ProductionJob[] = [];
  const invalidProjectRefJobs: ProductionJob[] = [];
  const legacyRelationshipJobs: ProductionJob[] = [];
  const completedJobs: ProductionJob[] = [];
  const archivedCompletedJobs: ProductionJob[] = [];
  const completedReprintJobs: ProductionJob[] = [];
  const failedOrCancelledJobs: ProductionJob[] = [];
  const inProgressOrPlannedJobs: ProductionJob[] = [];
  const jobsMissingVariationSnapshots: ProductionJob[] = [];
  const jobsMissingColorRef: ProductionJob[] = [];

  let uniqueJobCount = 0;

  for (const job of jobs) {
    if (!job || typeof job !== 'object') continue;
    const jId = typeof job.id === 'string' ? job.id.trim() : '';
    if (jId) {
      if (seenJobIds.has(jId)) {
        if (!duplicateJobIds.includes(jId)) {
          duplicateJobIds.push(jId);
        }
        continue;
      }
      seenJobIds.add(jId);
    }
    uniqueJobCount += 1;

    const rawProjectId =
      typeof job.projectId === 'string' ? job.projectId.trim() : '';
    if (!rawProjectId) {
      missingProjectJobs.push(job);
    } else if (!projectIds.has(rawProjectId)) {
      invalidProjectRefJobs.push(job);
    } else {
      validProjectJobs.push(job);
    }

    if (
      rawProjectId === 'proj-legacy-v1' ||
      jId.startsWith('legacy-job-')
    ) {
      legacyRelationshipJobs.push(job);
    }

    if (job.stage === 'Completed') {
      completedJobs.push(job);
      if (isCompletedArchivedJob(job, nowMs)) {
        archivedCompletedJobs.push(job);
      }
      if (Math.max(0, Math.floor(Number(job.failedCount || 0))) > 0) {
        completedReprintJobs.push(job);
      }
      const breakdown = extractCompletedPlateBreakdown(job);
      if (!breakdown.hasRecordedBreakdown) {
        jobsMissingVariationSnapshots.push(job);
      }
    } else if (job.stage === 'Failed / Reprint' || job.stage === 'Cancelled') {
      failedOrCancelledJobs.push(job);
    } else {
      inProgressOrPlannedJobs.push(job);
    }

    const rawColorId = typeof job.colorId === 'string' ? job.colorId.trim() : '';
    if (!rawColorId || rawColorId === 'unassigned' || !colorIds.has(rawColorId)) {
      jobsMissingColorRef.push(job);
    }
  }

  return {
    totalJobs: jobs.length,
    uniqueJobCount,
    duplicateJobIds,
    validProjectJobs,
    missingProjectJobs,
    invalidProjectRefJobs,
    unlinkedJobs: [...missingProjectJobs, ...invalidProjectRefJobs],
    legacyRelationshipJobs,
    completedJobs,
    archivedCompletedJobs,
    completedReprintJobs,
    failedOrCancelledJobs,
    inProgressOrPlannedJobs,
    jobsMissingVariationSnapshots,
    jobsMissingColorRef,
  };
}

function compareVariations(
  a: Pick<BatchVariationProgress, 'source' | 'label' | 'variationKey'>,
  b: Pick<BatchVariationProgress, 'source' | 'label' | 'variationKey'>
): number {
  if (a.source === 'letter' && b.source === 'letter') {
    const idxA = ABC.indexOf(a.label as (typeof ABC)[number]);
    const idxB = ABC.indexOf(b.label as (typeof ABC)[number]);
    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
  }
  if (a.source === 'charm' && b.source === 'charm') {
    const idxA = CHARM_DEFINITIONS.findIndex(
      (c) => `${c.symbol} ${c.label}` === a.label
    );
    const idxB = CHARM_DEFINITIONS.findIndex(
      (c) => `${c.symbol} ${c.label}` === b.label
    );
    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
  }
  const labelCmp = a.label.localeCompare(b.label, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
  if (labelCmp !== 0) return labelCmp;
  return a.variationKey.localeCompare(b.variationKey);
}

function resolveAuthoritativeColorMeta(
  rawColorId: string | undefined | null,
  jobsForColor: readonly ProductionJob[],
  colorById: ReadonlyMap<string, ColorOption>,
  fallbackColorName?: string | null
): {
  colorKey: string;
  colorName: string;
  colorHex: string;
  isUnassigned: boolean;
  isMissingColorCatalogRef: boolean;
} {
  const trimmed = typeof rawColorId === 'string' ? rawColorId.trim() : '';
  if (!trimmed || trimmed === 'unassigned' || trimmed === UNASSIGNED_COLOR_KEY) {
    return {
      colorKey: UNASSIGNED_COLOR_KEY,
      colorName: 'Unassigned / Unknown Color',
      colorHex: '#7B8580',
      isUnassigned: true,
      isMissingColorCatalogRef: false,
    };
  }

  const catalogColor = colorById.get(trimmed);
  if (catalogColor) {
    return {
      colorKey: catalogColor.id,
      colorName: catalogColor.name,
      colorHex: catalogColor.hex,
      isUnassigned: false,
      isMissingColorCatalogRef: false,
    };
  }

  let snapshotName: string | null =
    typeof fallbackColorName === 'string' &&
    fallbackColorName.trim().length > 0 &&
    fallbackColorName.trim() !== trimmed
      ? fallbackColorName.trim()
      : null;

  if (!snapshotName) {
    for (const job of jobsForColor) {
      if (Array.isArray(job.catalogItems)) {
        const match = job.catalogItems.find(
          (ci) =>
            ci &&
            ci.colorId === trimmed &&
            typeof ci.colorName === 'string' &&
            ci.colorName.trim().length > 0 &&
            ci.colorName.trim() !== trimmed
        );
        if (match) {
          snapshotName = match.colorName.trim();
          break;
        }
      }
    }
  }

  return {
    colorKey: trimmed,
    colorName: snapshotName
      ? `${snapshotName} (Removed Color)`
      : `Unknown Color (${trimmed})`,
    colorHex: '#7B8580',
    isUnassigned: false,
    isMissingColorCatalogRef: true,
  };
}

function extractProductIdentityFromJob(job: ProductionJob): {
  productKey: string;
  productId: string;
  productName: string;
  sku: string | null;
  categoryId: string | null;
  categoryName: string | null;
  distinctProductIds: string[];
} {
  const catalogItems = Array.isArray(job.catalogItems) ? job.catalogItems : [];
  const validCatalogItems = catalogItems.filter(
    (ci) => ci && Math.floor(Number(ci.quantity || 0)) > 0
  );

  if (validCatalogItems.length > 0) {
    const distinctProductIds = Array.from(
      new Set(
        validCatalogItems
          .map((ci) => (ci.productId || '').trim())
          .filter((id) => id.length > 0)
      )
    );
    const first = validCatalogItems[0];
    const cleanProdId = (first.productId || '').trim() || 'unknown-catalog-product';
    return {
      productKey:
        distinctProductIds.length > 1
          ? `mixed:${distinctProductIds.join('+')}`
          : `catalog:${cleanProdId}`,
      productId: cleanProdId,
      productName:
        (first.productName || '').trim() ||
        (job.categoryNameSnapshot || '').trim() ||
        `Product (${cleanProdId})`,
      sku: first.sku?.trim() || null,
      categoryId: first.categoryId?.trim() || job.categoryId?.trim() || null,
      categoryName:
        first.categoryName?.trim() || job.categoryNameSnapshot?.trim() || null,
      distinctProductIds,
    };
  }

  const breakdown = extractCompletedPlateBreakdown(job);
  const hasLetters = breakdown.items.some((i) => i.source === 'letter');
  const hasCharms = breakdown.items.some((i) => i.source === 'charm');

  if (hasLetters && !hasCharms) {
    return {
      productKey: 'builtin:alphabet',
      productId: 'builtin:alphabet',
      productName: 'Alphabet Keycaps (A–Z)',
      sku: null,
      categoryId: null,
      categoryName: 'Built-in Keycap Workflows',
      distinctProductIds: ['builtin:alphabet'],
    };
  }
  if (hasCharms && !hasLetters) {
    return {
      productKey: 'builtin:charm',
      productId: 'builtin:charm',
      productName: 'Charm Keycaps',
      sku: null,
      categoryId: null,
      categoryName: 'Built-in Keycap Workflows',
      distinctProductIds: ['builtin:charm'],
    };
  }
  if (hasLetters && hasCharms) {
    return {
      productKey: 'builtin:mixed',
      productId: 'builtin:mixed',
      productName: 'Alphabet & Charm Keycaps',
      sku: null,
      categoryId: null,
      categoryName: 'Built-in Keycap Workflows',
      distinctProductIds: ['builtin:mixed'],
    };
  }

  return {
    productKey: 'legacy:unknown',
    productId: 'legacy:unknown',
    productName: job.categoryNameSnapshot?.trim() || 'Legacy Plate Record',
    sku: null,
    categoryId: job.categoryId?.trim() || null,
    categoryName: job.categoryNameSnapshot?.trim() || null,
    distinctProductIds: [],
  };
}

function mapVariationItemToBatchKey(item: PlateVariationItem): {
  variationKey: string;
  variantId: string | null;
  label: string;
  isVariationless: boolean;
  source: 'catalog' | 'letter' | 'charm';
} {
  if (item.source === 'catalog') {
    const cleanVarId =
      typeof item.variantId === 'string' && item.variantId.trim().length > 0
        ? item.variantId.trim()
        : null;
    const label = item.isVariationless ? 'Standard / No Variation' : item.label;
    const variationKey = cleanVarId
      ? `var:${cleanVarId}`
      : `novar:${item.isVariationless ? 'standard' : label}`;
    return {
      variationKey,
      variantId: cleanVarId,
      label,
      isVariationless: item.isVariationless,
      source: 'catalog',
    };
  }
  if (item.source === 'letter') {
    return {
      variationKey: `letter:${item.label}`,
      variantId: null,
      label: item.label,
      isVariationless: false,
      source: 'letter',
    };
  }
  return {
    variationKey: item.key,
    variantId: null,
    label: item.label,
    isVariationless: false,
    source: 'charm',
  };
}

function inferVariationSourceFromKey(
  key: string
): 'catalog' | 'letter' | 'charm' {
  if (key.startsWith('letter:')) return 'letter';
  if (key.startsWith('charm:')) return 'charm';
  return 'catalog';
}

function summarizeBatchGroup(params: {
  batchId: string;
  batchNumber: number;
  identitySource: BatchIdentitySource;
  projectId: string;
  jobs: ProductionJob[];
  persistedRecord?: ProductionBatchRecord;
  colorById: ReadonlyMap<string, ColorOption>;
  timezone: string;
  nowMs: number;
}): BatchProductionSummary {
  const {
    batchId,
    batchNumber,
    identitySource,
    projectId,
    jobs,
    persistedRecord,
    colorById,
    timezone,
    nowMs,
  } = params;

  const sortedJobs = [...jobs].sort(
    (a, b) => a.plateNumber - b.plateNumber || a.id.localeCompare(b.id)
  );

  const firstJobProd = sortedJobs[0]
    ? extractProductIdentityFromJob(sortedJobs[0])
    : null;

  const productId =
    persistedRecord?.productId || firstJobProd?.productId || 'unknown-product';
  const productName =
    persistedRecord?.productName || firstJobProd?.productName || productId;
  const sku = persistedRecord?.sku ?? firstJobProd?.sku ?? null;
  const categoryId =
    persistedRecord?.categoryId ?? firstJobProd?.categoryId ?? null;
  const categoryName =
    persistedRecord?.categoryName ?? firstJobProd?.categoryName ?? null;
  const mode: PlateGenerationMode =
    persistedRecord?.mode || sortedJobs[0]?.plateMode || 'catalog_category';
  const plateCapacity =
    persistedRecord?.plateCapacity || sortedJobs[0]?.plateCapacity || 1;

  const rawColorId = persistedRecord?.colorId || sortedJobs[0]?.colorId || '';
  const colorMeta = resolveAuthoritativeColorMeta(
    rawColorId,
    sortedJobs,
    colorById,
    persistedRecord?.colorName
  );

  const earliestCreatedIso =
    persistedRecord?.createdIso ||
    sortedJobs.reduce(
      (minIso, j) =>
        !minIso || (j.createdIso && j.createdIso < minIso) ? j.createdIso : minIso,
      ''
    ) ||
    new Date(nowMs).toISOString();

  const createdDateLabel = formatDateDDMMYYYY(earliestCreatedIso, timezone);

  const warnings: string[] = [];
  if (identitySource === 'reconstructed_session') {
    warnings.push(
      'Batch reconstructed safely from matching single-product, single-color planning session history.'
    );
  }
  if (colorMeta.isUnassigned) {
    warnings.push(
      'Batch lacks an assigned physical Filament Color ID and is kept separate from colored batches.'
    );
  } else if (colorMeta.isMissingColorCatalogRef) {
    warnings.push(
      `Color ID "${colorMeta.colorKey}" was removed from Workspace Settings colors; preserving historical color ID.`
    );
  }

  // Track variation Requested vs Completed
  const variationsMap = new Map<
    string,
    {
      variationKey: string;
      variantId: string | null;
      label: string;
      isVariationless: boolean;
      source: 'catalog' | 'letter' | 'charm';
      requestedQuantity: number;
      completedQuantity: number;
      completedPlateNumbers: Set<number>;
    }
  >();

  if (persistedRecord?.requestedVariations?.length) {
    for (const rv of persistedRecord.requestedVariations) {
      const qty = Math.max(0, Math.floor(Number(rv.requestedQuantity || 0)));
      if (qty <= 0) continue;
      variationsMap.set(rv.variationKey, {
        variationKey: rv.variationKey,
        variantId: rv.variantId ?? null,
        label: rv.label,
        isVariationless: rv.variationKey === 'novar:standard',
        source: inferVariationSourceFromKey(rv.variationKey),
        requestedQuantity: qty,
        completedQuantity: 0,
        completedPlateNumbers: new Set<number>(),
      });
    }
  }

  const plateSummaries: BatchPlateSummary[] = [];
  const plateNumbersSet = new Set<number>();
  const completedPlateNumbers: number[] = [];
  const pendingPlateNumbers: number[] = [];
  const missingSnapshotPlateNumbers: number[] = [];

  let completedPlateCount = 0;
  let archivedCompletedPlateCount = 0;
  let activePendingPlateCount = 0;
  let failedReprintPlateCount = 0;
  let cancelledPlateCount = 0;
  let reprintCompletedPlateCount = 0;
  let nonCancelledPlannedSum = 0;

  for (const job of sortedJobs) {
    plateNumbersSet.add(job.plateNumber);

    // Integrity check: warn if a job inside a persisted batch has a mismatched colorId or productId
    const jobRawColor = typeof job.colorId === 'string' ? job.colorId.trim() : '';
    if (jobRawColor && jobRawColor !== colorMeta.colorKey && !colorMeta.isUnassigned) {
      warnings.push(
        `Plate #${job.plateNumber} has mismatched color "${jobRawColor}" vs batch color "${colorMeta.colorKey}".`
      );
    }

    const breakdown = extractCompletedPlateBreakdown(job);
    const failedCount = Math.max(0, Math.floor(Number(job.failedCount || 0)));
    const isCompleted = job.stage === 'Completed';
    const isArchivedCompleted = isCompleted && isCompletedArchivedJob(job, nowMs);
    const isReprintCompleted = isCompleted && failedCount > 0;
    const isFailedOrCancelled =
      job.stage === 'Failed / Reprint' || job.stage === 'Cancelled';

    const plannedUnits = breakdown.totalQuantity;
    const completedUnits = isCompleted ? breakdown.totalQuantity : 0;

    if (job.stage !== 'Cancelled') {
      nonCancelledPlannedSum += plannedUnits;
    }

    if (isCompleted) {
      completedPlateCount += 1;
      completedPlateNumbers.push(job.plateNumber);
      if (isArchivedCompleted) archivedCompletedPlateCount += 1;
      if (isReprintCompleted) reprintCompletedPlateCount += 1;
      if (!breakdown.hasRecordedBreakdown) {
        missingSnapshotPlateNumbers.push(job.plateNumber);
        warnings.push(
          `Plate #${job.plateNumber} is Completed without a recorded variation snapshot; quantities were not guessed.`
        );
      }
    } else {
      pendingPlateNumbers.push(job.plateNumber);
      if (job.stage === 'Failed / Reprint') {
        failedReprintPlateCount += 1;
      } else if (job.stage === 'Cancelled') {
        cancelledPlateCount += 1;
      } else {
        activePendingPlateCount += 1;
      }
    }

    // Derive requested quantities from non-cancelled plates if no persisted requestedVariations snapshot existed
    if (!persistedRecord?.requestedVariations?.length && job.stage !== 'Cancelled') {
      for (const item of breakdown.items) {
        if (item.quantity <= 0) continue;
        const meta = mapVariationItemToBatchKey(item);
        const existing = variationsMap.get(meta.variationKey);
        if (existing) {
          existing.requestedQuantity += item.quantity;
        } else {
          variationsMap.set(meta.variationKey, {
            variationKey: meta.variationKey,
            variantId: meta.variantId,
            label: meta.label,
            isVariationless: meta.isVariationless,
            source: meta.source,
            requestedQuantity: item.quantity,
            completedQuantity: 0,
            completedPlateNumbers: new Set<number>(),
          });
        }
      }
    }

    // Accumulate Completed units strictly from Completed plates
    if (isCompleted && breakdown.hasRecordedBreakdown) {
      for (const item of breakdown.items) {
        if (item.quantity <= 0) continue;
        const meta = mapVariationItemToBatchKey(item);
        const existing = variationsMap.get(meta.variationKey);
        if (existing) {
          existing.completedQuantity += item.quantity;
          existing.completedPlateNumbers.add(job.plateNumber);
        } else {
          variationsMap.set(meta.variationKey, {
            variationKey: meta.variationKey,
            variantId: meta.variantId,
            label: meta.label,
            isVariationless: meta.isVariationless,
            source: meta.source,
            requestedQuantity: persistedRecord ? 0 : item.quantity,
            completedQuantity: item.quantity,
            completedPlateNumbers: new Set<number>([job.plateNumber]),
          });
        }
      }
    }

    plateSummaries.push({
      jobId: job.id,
      plateNumber: job.plateNumber,
      plateCapacity: job.plateCapacity,
      stage: job.stage,
      isCompleted,
      isArchivedCompleted,
      isReprintCompleted,
      isFailedOrCancelled,
      failedCount,
      machineId: job.machineId ?? null,
      plannedUnits,
      completedUnits,
      hasRecordedBreakdown: breakdown.hasRecordedBreakdown,
      completedAtLabel: isCompleted
        ? resolveCompletedTimestampLabel(job, timezone)
        : '—',
      notes: job.notes || '',
    });
  }

  const variations: BatchVariationProgress[] = Array.from(variationsMap.values())
    .map((v) => ({
      variationKey: v.variationKey,
      variantId: v.variantId,
      label: v.label,
      isVariationless: v.isVariationless,
      source: v.source,
      requestedQuantity: v.requestedQuantity,
      completedQuantity: v.completedQuantity,
      remainingQuantity: Math.max(0, v.requestedQuantity - v.completedQuantity),
      overProducedQuantity: Math.max(0, v.completedQuantity - v.requestedQuantity),
      completedPlateNumbers: Array.from(v.completedPlateNumbers).sort((a, b) => a - b),
    }))
    .sort(compareVariations);

  const variationRequestedSum = variations.reduce(
    (sum, v) => sum + v.requestedQuantity,
    0
  );
  const completedQuantity = variations.reduce(
    (sum, v) => sum + v.completedQuantity,
    0
  );
  const requestedQuantity = persistedRecord
    ? Math.max(persistedRecord.requestedQuantity, variationRequestedSum)
    : Math.max(variationRequestedSum, nonCancelledPlannedSum);
  const committedQuantity = persistedRecord
    ? persistedRecord.committedQuantity
    : nonCancelledPlannedSum;
  const remainingQuantity = Math.max(0, requestedQuantity - completedQuantity);

  let completionStatus: BatchCompletionStatus;
  let completionStatusLabel: string;
  if (completedPlateCount === 0) {
    completionStatus = 'in_progress';
    completionStatusLabel = 'In Progress (0 Completed)';
  } else if (
    completedPlateCount === sortedJobs.length &&
    sortedJobs.length > 0 &&
    remainingQuantity === 0 &&
    cancelledPlateCount === 0 &&
    failedReprintPlateCount === 0 &&
    missingSnapshotPlateNumbers.length === 0
  ) {
    completionStatus = 'completed';
    completionStatusLabel = 'Completed';
  } else {
    completionStatus = 'partial';
    completionStatusLabel = 'Partial Completion';
  }

  return {
    batchId,
    batchNumber,
    batchLabel: `Batch ${String(batchNumber).padStart(3, '0')}`,
    identitySource,
    projectId,
    productId,
    productName,
    sku,
    categoryId,
    categoryName,
    colorId: colorMeta.colorKey,
    colorName: colorMeta.colorName,
    colorHex: colorMeta.colorHex,
    isUnassignedColor: colorMeta.isUnassigned,
    isMissingColorCatalogRef: colorMeta.isMissingColorCatalogRef,
    mode,
    plateCapacity,
    createdIso: earliestCreatedIso,
    createdDateLabel,
    requestedQuantity,
    committedQuantity,
    completedQuantity,
    remainingQuantity,
    generatedPlateCount: sortedJobs.length,
    completedPlateCount,
    archivedCompletedPlateCount,
    activePendingPlateCount,
    failedReprintPlateCount,
    cancelledPlateCount,
    reprintCompletedPlateCount,
    plateNumbers: Array.from(plateNumbersSet).sort((a, b) => a - b),
    completedPlateNumbers: completedPlateNumbers.sort((a, b) => a - b),
    pendingPlateNumbers: pendingPlateNumbers.sort((a, b) => a - b),
    missingSnapshotPlateNumbers: missingSnapshotPlateNumbers.sort((a, b) => a - b),
    completionStatus,
    completionStatusLabel,
    isCompleteForBulkPrint: completionStatus === 'completed',
    hasPartialWarning:
      completionStatus === 'partial' || completionStatus === 'in_progress',
    variations,
    plates: plateSummaries,
    warnings,
  };
}

/**
 * Aggregates production strictly using:
 *   PROJECT -> PRODUCTION BATCH (1 Product + 1 Physical Filament Color + 1 Request) -> GENERATED PLATES -> VARIATION QUANTITIES
 *
 * Guarantees:
 * - Separate batch confirmations (even same project + product + color) stay completely isolated (`Batch 001`, `Batch 002`, ...).
 * - Multi-plate batches split from one confirmation share their `batchId` and aggregate cleanly inside that batch.
 * - Counts Completed output strictly from `stage === 'Completed'` plates (including archived Completed); excludes Planned, Ready to Print, Printing, Failed / Reprint, Cancelled, and duplicate `job.id` records.
 * - Completed reprints count once using persisted plate breakdown.
 * - Historical jobs without `batchId` are reconstructed into a batch via `planningSessionId` ONLY when provably single-product, single-color, single-project; all other old jobs remain individually under `legacyJobs` (Legacy / Unassigned Batch Records) and are NEVER merged silently.
 */
export function buildProjectProductionSummary(params: {
  workspace: Pick<ProductionWorkspaceV5, 'projects' | 'jobs' | 'colors' | 'settings'>;
  projectId: string;
  nowMs?: number;
}): ProjectProductionSummary {
  const { workspace, projectId } = params;
  const nowMs = params.nowMs ?? Date.now();
  const timezone = workspace.settings?.timezone || DEFAULT_TIMEZONE;
  const projects = Array.isArray(workspace.projects) ? workspace.projects : [];
  const jobs = Array.isArray(workspace.jobs) ? workspace.jobs : [];
  const colors = Array.isArray(workspace.colors) ? workspace.colors : [];

  const project = projects.find((p) => p.id === projectId) || null;
  const colorById = new Map(colors.map((c) => [c.id, c]));

  const seenJobIds = new Set<string>();
  const duplicateJobIdsSkipped: string[] = [];
  const projectJobs: ProductionJob[] = [];

  for (const job of jobs) {
    if (!job || typeof job !== 'object') continue;
    const jId = typeof job.id === 'string' ? job.id.trim() : '';
    if (jId) {
      if (seenJobIds.has(jId)) {
        if (!duplicateJobIdsSkipped.includes(jId)) {
          duplicateJobIdsSkipped.push(jId);
        }
        continue;
      }
      seenJobIds.add(jId);
    }

    const jobProjectId =
      typeof job.projectId === 'string' ? job.projectId.trim() : '';
    if (!jobProjectId || jobProjectId !== projectId) continue;

    projectJobs.push(job);
  }

  const projectWarnings: string[] = [];
  if (duplicateJobIdsSkipped.length > 0) {
    projectWarnings.push(
      `Skipped ${duplicateJobIdsSkipped.length} duplicate job record(s) (${duplicateJobIdsSkipped.join(', ')}) to prevent double-counting.`
    );
  }

  const persistedBatches = Array.isArray(project?.productionBatches)
    ? [...project.productionBatches].sort(
        (a, b) => a.batchNumber - b.batchNumber || a.createdIso.localeCompare(b.createdIso)
      )
    : [];
  const persistedById = new Map<string, ProductionBatchRecord>(
    persistedBatches.map((b) => [b.id, b])
  );

  const jobsByPersistedBatchId = new Map<string, ProductionJob[]>();
  const unassignedToPersistedJobs: ProductionJob[] = [];

  for (const job of projectJobs) {
    const rawBatchId = typeof job.batchId === 'string' ? job.batchId.trim() : '';
    if (rawBatchId && persistedById.has(rawBatchId)) {
      if (!jobsByPersistedBatchId.has(rawBatchId)) {
        jobsByPersistedBatchId.set(rawBatchId, []);
      }
      jobsByPersistedBatchId.get(rawBatchId)!.push(job);
    } else {
      unassignedToPersistedJobs.push(job);
    }
  }

  const batchSummaries: BatchProductionSummary[] = [];
  let maxAssignedBatchNum = 0;

  for (const record of persistedBatches) {
    const matchedJobs = jobsByPersistedBatchId.get(record.id) || [];
    if (matchedJobs.length === 0) {
      // Do not create empty 0-plate summary records if all jobs were deleted from Print Queue
      continue;
    }
    if (record.batchNumber > maxAssignedBatchNum) {
      maxAssignedBatchNum = record.batchNumber;
    }
    batchSummaries.push(
      summarizeBatchGroup({
        batchId: record.id,
        batchNumber: record.batchNumber,
        identitySource: 'persisted_record',
        projectId,
        jobs: matchedJobs,
        persistedRecord: record,
        colorById,
        timezone,
        nowMs,
      })
    );
  }

  // Group candidate jobs having direct `job.batchId` (without a persisted batch record) or `planningSessionId`
  const jobsByAdHocBatchId = new Map<string, ProductionJob[]>();
  const jobsBySessionId = new Map<string, ProductionJob[]>();
  const ungroupedLegacyJobs: { job: ProductionJob; reason: string }[] = [];

  for (const job of unassignedToPersistedJobs) {
    const rawBatchId = typeof job.batchId === 'string' ? job.batchId.trim() : '';
    const rawSessionId =
      typeof job.planningSessionId === 'string' ? job.planningSessionId.trim() : '';

    if (rawBatchId) {
      if (!jobsByAdHocBatchId.has(rawBatchId)) {
        jobsByAdHocBatchId.set(rawBatchId, []);
      }
      jobsByAdHocBatchId.get(rawBatchId)!.push(job);
    } else if (rawSessionId) {
      if (!jobsBySessionId.has(rawSessionId)) {
        jobsBySessionId.set(rawSessionId, []);
      }
      jobsBySessionId.get(rawSessionId)!.push(job);
    } else {
      ungroupedLegacyJobs.push({
        job,
        reason: 'Legacy job created before Batch ID tracking (lacks batchId and planningSessionId). Kept individually without merging.',
      });
    }
  }

  const validateHomogeneousBatchCandidates = (
    groupJobs: ProductionJob[]
  ): { ok: true } | { ok: false; reason: string } => {
    const colorIds = new Set<string>();
    const productKeys = new Set<string>();

    for (const j of groupJobs) {
      const cid = typeof j.colorId === 'string' ? j.colorId.trim() : '';
      if (!cid || cid === 'unassigned') {
        return {
          ok: false,
          reason:
            'Legacy plate lacks a valid assigned physical Filament Color ID; kept in Legacy / Unassigned Batch Records.',
        };
      }
      colorIds.add(cid);

      const prodMeta = extractProductIdentityFromJob(j);
      if (prodMeta.distinctProductIds.length > 1) {
        return {
          ok: false,
          reason:
            'Legacy plate references multiple products; kept individually in Legacy / Unassigned Batch Records.',
        };
      }
      productKeys.add(prodMeta.productKey);
    }

    if (colorIds.size !== 1) {
      return {
        ok: false,
        reason:
          'Legacy planning session contained multiple filament colors and cannot be grouped as one homogeneous batch; kept individually without merging.',
      };
    }
    if (productKeys.size !== 1) {
      return {
        ok: false,
        reason:
          'Legacy planning session contained multiple products and cannot be grouped as one homogeneous batch; kept individually without merging.',
      };
    }
    return { ok: true };
  };

  let nextSyntheticNumber = maxAssignedBatchNum + 1;

  for (const [adHocBatchId, groupJobs] of jobsByAdHocBatchId.entries()) {
    const check = validateHomogeneousBatchCandidates(groupJobs);
    if (check.ok) {
      batchSummaries.push(
        summarizeBatchGroup({
          batchId: adHocBatchId,
          batchNumber: nextSyntheticNumber,
          identitySource: 'job_batch_id',
          projectId,
          jobs: groupJobs,
          colorById,
          timezone,
          nowMs,
        })
      );
      nextSyntheticNumber += 1;
    } else {
      for (const j of groupJobs) {
        ungroupedLegacyJobs.push({ job: j, reason: check.reason });
      }
    }
  }

  for (const [sessionId, groupJobs] of jobsBySessionId.entries()) {
    const check = validateHomogeneousBatchCandidates(groupJobs);
    if (check.ok) {
      batchSummaries.push(
        summarizeBatchGroup({
          batchId: sessionId,
          batchNumber: nextSyntheticNumber,
          identitySource: 'reconstructed_session',
          projectId,
          jobs: groupJobs,
          colorById,
          timezone,
          nowMs,
        })
      );
      nextSyntheticNumber += 1;
    } else {
      for (const j of groupJobs) {
        ungroupedLegacyJobs.push({ job: j, reason: check.reason });
      }
    }
  }

  batchSummaries.sort(
    (a, b) =>
      a.batchNumber - b.batchNumber || a.createdIso.localeCompare(b.createdIso)
  );

  // Build non-merged Legacy / Unassigned Plate Records
  const legacyJobs: LegacyUnassignedPlateRecord[] = ungroupedLegacyJobs
    .sort(
      (a, b) =>
        a.job.plateNumber - b.job.plateNumber ||
        a.job.id.localeCompare(b.job.id)
    )
    .map(({ job, reason }) => {
      const prodMeta = extractProductIdentityFromJob(job);
      const colorMeta = resolveAuthoritativeColorMeta(
        job.colorId,
        [job],
        colorById
      );
      const breakdown = extractCompletedPlateBreakdown(job);
      const isCompleted = job.stage === 'Completed';
      const failedCount = Math.max(0, Math.floor(Number(job.failedCount || 0)));

      if (isCompleted && !breakdown.hasRecordedBreakdown) {
        projectWarnings.push(
          `Legacy Completed Plate #${job.plateNumber} lacks a recorded variation snapshot; quantities were not guessed.`
        );
      }

      return {
        jobId: job.id,
        plateNumber: job.plateNumber,
        stage: job.stage,
        isCompleted,
        isArchivedCompleted: isCompleted && isCompletedArchivedJob(job, nowMs),
        isReprintCompleted: isCompleted && failedCount > 0,
        colorId: colorMeta.colorKey,
        colorName: colorMeta.colorName,
        colorHex: colorMeta.colorHex,
        productId: prodMeta.productId,
        productName: prodMeta.productName,
        sku: prodMeta.sku,
        plannedUnits: breakdown.totalQuantity,
        completedUnits: isCompleted ? breakdown.totalQuantity : 0,
        hasRecordedBreakdown: breakdown.hasRecordedBreakdown,
        completedAtLabel: isCompleted
          ? resolveCompletedTimestampLabel(job, timezone)
          : '—',
        reason,
        items: breakdown.items,
      };
    });

  // Roll up project-wide read-only metrics from batches + completed legacy records
  const allMissingSnapshotPlates = new Set<number>();
  let totalCompletedPlates = 0;
  let activeCompletedPlates = 0;
  let archivedCompletedPlates = 0;
  let reprintCompletedPlates = 0;
  let totalRequestedUnits = 0;
  let totalCompletedUnits = 0;
  let totalRemainingUnits = 0;

  let completedBatchCount = 0;
  let partialBatchCount = 0;
  let inProgressBatchCount = 0;

  for (const batch of batchSummaries) {
    if (batch.completionStatus === 'completed') completedBatchCount += 1;
    else if (batch.completionStatus === 'partial') partialBatchCount += 1;
    else inProgressBatchCount += 1;

    totalCompletedPlates += batch.completedPlateCount;
    archivedCompletedPlates += batch.archivedCompletedPlateCount;
    activeCompletedPlates +=
      batch.completedPlateCount - batch.archivedCompletedPlateCount;
    reprintCompletedPlates += batch.reprintCompletedPlateCount;
    totalRequestedUnits += batch.requestedQuantity;
    totalCompletedUnits += batch.completedQuantity;
    totalRemainingUnits += batch.remainingQuantity;

    for (const pNum of batch.missingSnapshotPlateNumbers) {
      allMissingSnapshotPlates.add(pNum);
    }
    for (const w of batch.warnings) {
      projectWarnings.push(`${batch.batchLabel}: ${w}`);
    }
  }

  for (const leg of legacyJobs) {
    if (leg.isCompleted) {
      totalCompletedPlates += 1;
      if (leg.isArchivedCompleted) archivedCompletedPlates += 1;
      else activeCompletedPlates += 1;
      if (leg.isReprintCompleted) reprintCompletedPlates += 1;
      totalCompletedUnits += leg.completedUnits;
      if (!leg.hasRecordedBreakdown) {
        allMissingSnapshotPlates.add(leg.plateNumber);
      }
    }
  }

  if (legacyJobs.length > 0) {
    projectWarnings.push(
      `${legacyJobs.length} plate record(s) lack a provable homogeneous Batch ID and are listed separately under Legacy / Unassigned Batch Records without auto-merging.`
    );
  }

  const completedBatches = batchSummaries.filter(
    (b) => b.isCompleteForBulkPrint
  );

  return {
    project,
    projectId,
    projectName: project?.name || `Unknown Project (${projectId})`,
    totalBatches: batchSummaries.length,
    completedBatchCount,
    partialBatchCount,
    inProgressBatchCount,
    legacyPlateCount: legacyJobs.length,
    totalCompletedPlates,
    activeCompletedPlates,
    archivedCompletedPlates,
    reprintCompletedPlates,
    totalRequestedUnits,
    totalCompletedUnits,
    totalRemainingUnits,
    batches: batchSummaries,
    completedBatches,
    legacyJobs,
    missingSnapshotPlateNumbers: Array.from(allMissingSnapshotPlates).sort(
      (a, b) => a - b
    ),
    duplicateJobIdsSkipped,
    warnings: Array.from(new Set(projectWarnings)),
  };
}
