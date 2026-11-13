import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { KanbanQueueView } from '../../components/KanbanQueueView';
import {
  ABC,
  countPlateKeycaps,
  createFreshWorkspaceV5,
  emptyAlphabetMap,
  normalizeWorkspaceV5,
} from '../../constants';
import {
  CatalogProduct,
  ProductCategory,
  ProductionJob,
  ProductionWorkspaceV5,
} from '../../types';
import {
  commitCatalogPlatesToWorkspace,
  generateAutomaticCatalogPlatePreviews,
  getPlannableProductItems,
} from '../catalogPlannerEngine';
import {
  computeSuccessfulCompletedUnits,
  extractCompletedPlateBreakdown,
  resolveCompletedTimestampLabel,
} from '../completedPlateUtils';
import {
  formatCompletedTimestampMY,
  MALAYSIA_TIMEZONE,
} from '../dateFormat';
import {
  prepareWorkspaceForFirestore,
} from '../firestorePayload';
import {
  hydrateJobCountdownFields,
  resolveJobCompletionTimestampMs,
} from '../productionCountdown';
import { transitionJobState } from '../productionEngine';
import { computeGlobalSchedule } from '../schedulingEngine';

const OWNER_UID = 'owner-uid-test';

function createBaseWorkspace(): ProductionWorkspaceV5 {
  return createFreshWorkspaceV5(OWNER_UID);
}

function makeCategory(): ProductCategory {
  return {
    id: 'cat-keycaps',
    ownerId: OWNER_UID,
    name: 'Keycaps',
    description: 'Custom Keycaps',
    imageUrl: null,
    iconName: 'sparkles',
    sortOrder: 0,
    status: 'active',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

function makeAlphabetProduct(): CatalogProduct {
  return {
    id: 'prod-keycap-letter',
    ownerId: OWNER_UID,
    sku: 'KEY-AZ-01',
    name: 'Keycap Letter',
    description: 'Letter keycaps A-Z',
    categoryId: 'cat-keycaps',
    images: [],
    priceMyr: 4.5,
    options: [
      {
        id: 'opt-letter',
        name: 'Letter',
        values: [...ABC],
        sortOrder: 0,
      },
    ],
    variants: [],
    status: 'active',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

function simulateFirestoreRoundTrip(ws: ProductionWorkspaceV5): ProductionWorkspaceV5 {
  const firestoreDoc = prepareWorkspaceForFirestore(ws, OWNER_UID);
  const serialized = JSON.parse(JSON.stringify(firestoreDoc));
  const normalized = normalizeWorkspaceV5(serialized, OWNER_UID);
  return {
    ...normalized,
    jobs: normalized.jobs.map((j) => hydrateJobCountdownFields(j)),
  };
}

describe('WOOPP 6.0 — Completed Timestamp & Variation Breakdown in Print Queue', () => {
  it('1 & 2. Captures actualCompletedAt on Printing -> Completed and survives Firestore round-trip', () => {
    const base = createBaseWorkspace();
    const machineId = base.machines[0].id;
    const projectId = base.projects[0].id;
    const colorId = base.colors[0].id;

    // 2026-11-13 6:32 PM MYT = 2026-11-13T10:32:00.000Z
    const startMs = Date.parse('2026-11-13T07:32:00.000Z');
    const completeMs = Date.parse('2026-11-13T10:32:00.000Z');

    const job: ProductionJob = {
      id: 'job-comp-1',
      projectId,
      colorId,
      plateNumber: 1,
      plateCapacity: 138,
      letters: { ...emptyAlphabetMap(), X: 40, Y: 50, Z: 30 },
      stage: 'Ready to Print',
      machineId: null,
      estimatedMinutes: 180,
      actualMinutes: 0,
      slicerVerified: true,
      stockApplied: false,
      stockTransactionId: null,
      completedIso: null,
      failedCount: 0,
      failureReason: '',
      notes: '',
      createdIso: new Date(startMs - 60_000).toISOString(),
      updatedIso: new Date(startMs - 60_000).toISOString(),
    };

    const ws1 = { ...base, jobs: [job] };
    const started = transitionJobState(ws1, job.id, 'Printing', {
      machineId,
      nowMs: startMs,
    }).nextWorkspace!;

    const completed = transitionJobState(started, job.id, 'Completed', {
      machineId,
      nowMs: completeMs,
    }).nextWorkspace!;

    const hydrated = simulateFirestoreRoundTrip(completed);
    const hydratedJob = hydrated.jobs.find((j) => j.id === job.id)!;

    expect(hydratedJob.stage).toBe('Completed');
    expect(hydratedJob.actualCompletedAt).toBe('2026-11-13T10:32:00.000Z');
    expect(hydratedJob.actualCompletedAtMs).toBe(completeMs);
    expect(hydratedJob.completedIso).toBe('2026-11-13T10:32:00.000Z');
    expect(resolveCompletedTimestampLabel(hydratedJob)).toBe('13 Nov 2026 · 6:32 PM');
  });

  it('3, 4 & 5. Repeated Completed transitions, hydration refresh, and unrelated metadata edits do not overwrite timestamp', () => {
    const base = createBaseWorkspace();
    const machineId = base.machines[0].id;
    const initialCompleteMs = Date.parse('2026-11-13T10:32:00.000Z');
    const laterMs = Date.parse('2026-11-14T15:00:00.000Z');

    const completedJob: ProductionJob = {
      id: 'job-idemp-1',
      projectId: base.projects[0].id,
      colorId: base.colors[0].id,
      plateNumber: 1,
      plateCapacity: 138,
      letters: { ...emptyAlphabetMap(), A: 20 },
      stage: 'Completed',
      machineId,
      estimatedMinutes: 120,
      actualMinutes: 118,
      actualStartedAt: '2026-11-13T08:34:00.000Z',
      actualCompletedAt: '2026-11-13T10:32:00.000Z',
      actualCompletedAtMs: initialCompleteMs,
      completedIso: '2026-11-13T10:32:00.000Z',
      slicerVerified: true,
      stockApplied: true,
      stockTransactionId: 'tx-1',
      failedCount: 0,
      failureReason: '',
      notes: '',
      createdIso: '2026-11-13T08:00:00.000Z',
      updatedIso: '2026-11-13T10:32:00.000Z',
    };

    // Repeated Completed -> Completed transition at much later time
    const repeatRes = transitionJobState(
      { ...base, jobs: [completedJob] },
      completedJob.id,
      'Completed',
      { machineId, nowMs: laterMs }
    ).nextWorkspace!;
    const afterRepeat = repeatRes.jobs[0];
    expect(afterRepeat.actualCompletedAt).toBe('2026-11-13T10:32:00.000Z');
    expect(afterRepeat.actualCompletedAtMs).toBe(initialCompleteMs);
    expect(afterRepeat.completedIso).toBe('2026-11-13T10:32:00.000Z');
    expect(afterRepeat.actualMinutes).toBe(118);

    // Legacy Completed job missing timestamp must NOT be backfilled on repeated Completed transition
    const legacyMissingJob: ProductionJob = {
      ...completedJob,
      id: 'job-legacy-missing',
      actualCompletedAt: null,
      actualCompletedAtMs: null,
      completedIso: null,
      stockApplied: false,
      letters: emptyAlphabetMap(),
    };
    const afterLegacyRepeat = transitionJobState(
      { ...base, jobs: [legacyMissingJob] },
      legacyMissingJob.id,
      'Completed',
      { machineId, nowMs: laterMs }
    ).nextWorkspace!.jobs[0];
    expect(afterLegacyRepeat.actualCompletedAt).toBeNull();
    expect(afterLegacyRepeat.completedIso).toBeNull();
    expect(resolveCompletedTimestampLabel(afterLegacyRepeat)).toBe('Not recorded');

    // Hydrating & editing unrelated metadata leaves timestamp untouched
    const hydrated = hydrateJobCountdownFields({
      ...afterRepeat,
      notes: 'Updated nozzle 0.4mm',
      updatedIso: new Date(laterMs).toISOString(),
    });
    expect(hydrated.actualCompletedAt).toBe('2026-11-13T10:32:00.000Z');
    expect(resolveCompletedTimestampLabel(hydrated)).toBe('13 Nov 2026 · 6:32 PM');
  });

  it('6, 7 & 8. Formats timestamps strictly in Asia/Kuala_Lumpur, supports Firestore Timestamp objects, and shows "Not recorded" for missing/invalid', () => {
    // 10:32 AM UTC = 6:32 PM MYT same day
    expect(formatCompletedTimestampMY('2026-11-13T10:32:00.000Z', MALAYSIA_TIMEZONE)).toBe(
      '13 Nov 2026 · 6:32 PM'
    );

    // UTC midnight crossing: 2026-11-13T17:32:00.000Z = 14 Nov 2026 · 1:32 AM MYT
    expect(formatCompletedTimestampMY('2026-11-13T17:32:00.000Z', MALAYSIA_TIMEZONE)).toBe(
      '14 Nov 2026 · 1:32 AM'
    );

    // Firestore Timestamp-like objects
    const targetMs = Date.parse('2026-11-13T10:32:00.000Z');
    expect(formatCompletedTimestampMY({ toMillis: () => targetMs })).toBe(
      '13 Nov 2026 · 6:32 PM'
    );
    expect(
      formatCompletedTimestampMY({
        seconds: Math.floor(targetMs / 1000),
        nanoseconds: 0,
      })
    ).toBe('13 Nov 2026 · 6:32 PM');

    // Missing or invalid -> Not recorded (never backfilled with updatedIso)
    expect(formatCompletedTimestampMY(null)).toBe('Not recorded');
    expect(formatCompletedTimestampMY(undefined)).toBe('Not recorded');
    expect(formatCompletedTimestampMY('')).toBe('Not recorded');
    expect(formatCompletedTimestampMY('not-a-valid-iso')).toBe('Not recorded');

    const legacyJob: ProductionJob = {
      ...createBaseWorkspace().jobs[0],
      id: 'legacy-no-ts',
      projectId: 'proj-1',
      colorId: 'col-1',
      plateNumber: 1,
      plateCapacity: 100,
      letters: { X: 10 },
      stage: 'Completed',
      machineId: null,
      estimatedMinutes: 120,
      actualMinutes: 120,
      slicerVerified: true,
      stockApplied: true,
      stockTransactionId: null,
      completedIso: null,
      actualCompletedAt: null,
      actualCompletedAtMs: null,
      failedCount: 0,
      failureReason: '',
      notes: '',
      createdIso: '2026-10-01T00:00:00.000Z',
      updatedIso: '2026-11-13T10:32:00.000Z',
    };
    expect(resolveJobCompletionTimestampMs(legacyJob)).toBeNull();
    expect(resolveCompletedTimestampLabel(legacyJob)).toBe('Not recorded');
  });

  it('9 & 10. Multi-plate planner order splits X/Y/Z cleanly across Plate 1 (120) and Plate 2 (80) without leaking combined order total', () => {
    const base = createBaseWorkspace();
    const category = makeCategory();
    const product = makeAlphabetProduct();
    const color = base.colors[0];
    const project = base.projects[0];
    const items = getPlannableProductItems(product);

    const itemW = items.find((i) => i.label === 'W')!;
    const itemX = items.find((i) => i.label === 'X')!;
    const itemY = items.find((i) => i.label === 'Y')!;
    const itemZ = items.find((i) => i.label === 'Z')!;

    // Total planned = 200 pcs across W=80, X=40, Y=50, Z=30 with capacity 120 -> Plate 1 (120 pcs) + Plate 2 (80 pcs)
    const previewRes = generateAutomaticCatalogPlatePreviews({
      existingJobs: [],
      project,
      color,
      category,
      products: [product],
      selections: [
        { productId: product.id, variantId: itemX.id, quantity: 40 },
        { productId: product.id, variantId: itemY.id, quantity: 50 },
        { productId: product.id, variantId: itemZ.id, quantity: 30 },
        { productId: product.id, variantId: itemW.id, quantity: 80 },
      ],
      plateSetting: {
        allocationMode: 'automatic_capacity',
        plateCapacity: 120,
        defaultEstimatedMinutes: 180,
      },
      includePartialRemainderPlate: true,
    });

    expect(previewRes.previews).toHaveLength(2);
    const committed = commitCatalogPlatesToWorkspace(base, {
      projectId: project.id,
      colorId: color.id,
      category,
      confirmedPlates: previewRes.previews!,
      nowMs: Date.parse('2026-11-13T06:00:00.000Z'),
    });

    const wsWithPlates = committed.nextWorkspace!;
    const createdIds = committed.createdJobs!.map((j) => j.id);
    const autoPlate1 = wsWithPlates.jobs.find((j) => j.id === createdIds[0])!;
    const autoPlate2 = wsWithPlates.jobs.find((j) => j.id === createdIds[1])!;

    // Auto-split produces 120 pcs on Plate 1 and 80 pcs on Plate 2 (never 200 combined on either plate)
    expect(countPlateKeycaps(autoPlate1)).toBe(120);
    expect(countPlateKeycaps(autoPlate2)).toBe(80);
    expect(extractCompletedPlateBreakdown(autoPlate1).totalQuantity).toBe(120);
    expect(extractCompletedPlateBreakdown(autoPlate2).totalQuantity).toBe(80);
    expect(
      extractCompletedPlateBreakdown(autoPlate1).totalQuantity +
        extractCompletedPlateBreakdown(autoPlate2).totalQuantity
    ).toBe(200);

    // Explicit staged confirmation with Plate 1: X=40, Y=50, Z=30 (120 pcs) and Plate 2: W=80 (80 pcs)
    const explicitCommit = commitCatalogPlatesToWorkspace(base, {
      projectId: project.id,
      colorId: color.id,
      category,
      confirmedPlates: [
        {
          tempId: 'plate-1',
          plateNumber: 101,
          categoryId: category.id,
          categoryName: category.name,
          capacity: 120,
          items: [
            {
              productId: product.id,
              productName: product.name,
              sku: product.sku,
              categoryId: category.id,
              categoryName: category.name,
              variantId: itemX.id,
              variantLabel: 'X',
              colorId: color.id,
              colorName: color.name,
              quantity: 40,
            },
            {
              productId: product.id,
              productName: product.name,
              sku: product.sku,
              categoryId: category.id,
              categoryName: category.name,
              variantId: itemY.id,
              variantLabel: 'Y',
              colorId: color.id,
              colorName: color.name,
              quantity: 50,
            },
            {
              productId: product.id,
              productName: product.name,
              sku: product.sku,
              categoryId: category.id,
              categoryName: category.name,
              variantId: itemZ.id,
              variantLabel: 'Z',
              colorId: color.id,
              colorName: color.name,
              quantity: 30,
            },
          ],
          estimatedMinutes: 180,
          slicerVerified: true,
          notes: '',
        },
        {
          tempId: 'plate-2',
          plateNumber: 102,
          categoryId: category.id,
          categoryName: category.name,
          capacity: 120,
          items: [
            {
              productId: product.id,
              productName: product.name,
              sku: product.sku,
              categoryId: category.id,
              categoryName: category.name,
              variantId: itemW.id,
              variantLabel: 'W',
              colorId: color.id,
              colorName: color.name,
              quantity: 80,
            },
          ],
          estimatedMinutes: 140,
          slicerVerified: true,
          notes: '',
        },
      ],
      nowMs: Date.parse('2026-11-13T06:05:00.000Z'),
    });

    const p1 = explicitCommit.createdJobs![0];
    const p2 = explicitCommit.createdJobs![1];

    expect(countPlateKeycaps(p1)).toBe(120);
    const b1 = extractCompletedPlateBreakdown(p1);
    expect(b1.totalQuantity).toBe(120);
    expect(b1.items.map((i) => ({ label: i.label, qty: i.quantity }))).toEqual([
      { label: 'X', qty: 40 },
      { label: 'Y', qty: 50 },
      { label: 'Z', qty: 30 },
    ]);

    expect(countPlateKeycaps(p2)).toBe(80);
    const b2 = extractCompletedPlateBreakdown(p2);
    expect(b2.totalQuantity).toBe(80);
    expect(b2.items.map((i) => ({ label: i.label, qty: i.quantity }))).toEqual([
      { label: 'W', qty: 80 },
    ]);
  });

  it('11, 12, 13 & 14. Supports custom option labels, all 26 A-Z options, multi-option distinct variantId preservation, and variationless products', () => {
    const base = createBaseWorkspace();
    const category = makeCategory();
    const color = base.colors[0];
    const project = base.projects[0];

    // All 26 A-Z letters on one plate (e.g., 5 each = 130 pcs)
    const alphaProduct = makeAlphabetProduct();
    const alphaItems = getPlannableProductItems(alphaProduct);
    const all26Job: ProductionJob = {
      id: 'job-26-letters',
      projectId: project.id,
      colorId: color.id,
      plateNumber: 1,
      plateCapacity: 138,
      letters: Object.fromEntries(ABC.map((l) => [l, 5])),
      plateMode: 'catalog_category',
      categoryId: category.id,
      categoryNameSnapshot: category.name,
      catalogItems: alphaItems.map((it) => ({
        productId: alphaProduct.id,
        productName: alphaProduct.name,
        sku: alphaProduct.sku,
        categoryId: category.id,
        categoryName: category.name,
        variantId: it.id,
        variantLabel: it.label,
        colorId: color.id,
        colorName: color.name,
        quantity: 5,
      })),
      stage: 'Completed',
      machineId: base.machines[0].id,
      estimatedMinutes: 180,
      actualMinutes: 175,
      slicerVerified: true,
      stockApplied: true,
      stockTransactionId: null,
      completedIso: '2026-11-13T10:32:00.000Z',
      actualCompletedAt: '2026-11-13T10:32:00.000Z',
      actualCompletedAtMs: Date.parse('2026-11-13T10:32:00.000Z'),
      failedCount: 0,
      failureReason: '',
      notes: '',
      createdIso: '2026-11-13T06:00:00.000Z',
      updatedIso: '2026-11-13T10:32:00.000Z',
    };

    expect(countPlateKeycaps(all26Job)).toBe(130);
    const b26 = extractCompletedPlateBreakdown(all26Job);
    expect(b26.items).toHaveLength(26);
    expect(b26.totalQuantity).toBe(130);

    // Multi-option product keeping distinct variantIds separate even when variantLabels match
    const multiOptionDistinctJob: ProductionJob = {
      ...all26Job,
      id: 'job-multi-opt',
      letters: {},
      catalogItems: [
        {
          productId: 'prod-custom',
          productName: 'Artisan Cap',
          sku: 'ART-M-MAT',
          categoryId: category.id,
          categoryName: category.name,
          variantId: 'var-matte-1',
          variantLabel: 'Gold Edition',
          colorId: color.id,
          colorName: color.name,
          quantity: 12,
        },
        {
          productId: 'prod-custom',
          productName: 'Artisan Cap',
          sku: 'ART-L-GLS',
          categoryId: category.id,
          categoryName: category.name,
          variantId: 'var-gloss-2',
          variantLabel: 'Gold Edition',
          colorId: color.id,
          colorName: color.name,
          quantity: 8,
        },
      ],
    };
    const bMulti = extractCompletedPlateBreakdown(multiOptionDistinctJob);
    expect(bMulti.items).toHaveLength(2);
    expect(bMulti.items[0].quantity).toBe(12);
    expect(bMulti.items[1].quantity).toBe(8);
    expect(bMulti.totalQuantity).toBe(20);

    // Standard product without variations (variantId: null, variantLabel: null)
    const variationlessJob: ProductionJob = {
      ...all26Job,
      id: 'job-variationless',
      letters: {},
      catalogItems: [
        {
          productId: 'prod-moon',
          productName: 'Charm Moon',
          sku: 'MOON-01',
          categoryId: category.id,
          categoryName: category.name,
          variantId: null,
          variantLabel: null,
          colorId: color.id,
          colorName: color.name,
          quantity: 40,
        },
      ],
    };
    const bFlat = extractCompletedPlateBreakdown(variationlessJob);
    expect(bFlat.hasRecordedBreakdown).toBe(true);
    expect(bFlat.hasVariations).toBe(false);
    expect(bFlat.totalQuantity).toBe(40);
  });

  it('15 & 16. Legacy job missing breakdown shows Not recorded, and historical snapshots ignore catalog renames', () => {
    const legacyNoItemsJob: ProductionJob = {
      id: 'job-legacy-empty',
      projectId: 'proj-1',
      colorId: 'col-1',
      plateNumber: 4,
      plateCapacity: 138,
      letters: {},
      stage: 'Completed',
      machineId: null,
      estimatedMinutes: 120,
      actualMinutes: 120,
      slicerVerified: true,
      stockApplied: false,
      stockTransactionId: null,
      completedIso: null,
      failedCount: 0,
      failureReason: '',
      notes: '',
      createdIso: '2026-10-01T00:00:00.000Z',
      updatedIso: '2026-10-01T02:00:00.000Z',
    };

    const legacyBreakdown = extractCompletedPlateBreakdown(legacyNoItemsJob);
    expect(legacyBreakdown.hasRecordedBreakdown).toBe(false);
    expect(legacyBreakdown.totalQuantity).toBe(0);

    // Historical completed job with catalog snapshot stays unaffected by live catalog mutation
    const snapshotJob: ProductionJob = {
      ...legacyNoItemsJob,
      id: 'job-historical-snap',
      catalogItems: [
        {
          productId: 'prod-keycap-letter',
          productName: 'Keycap Letter Original',
          sku: 'KEY-01',
          categoryId: 'cat-1',
          categoryName: 'Keycaps',
          variantId: 'var-x',
          variantLabel: 'X',
          colorId: 'col-1',
          colorName: 'Black',
          quantity: 40,
        },
      ],
    };
    const snapRes = extractCompletedPlateBreakdown(snapshotJob);
    expect(snapRes.productName).toBe('Keycap Letter Original');
    expect(snapRes.items[0].label).toBe('X');
    expect(snapRes.items[0].quantity).toBe(40);
  });

  it('17, 18 & 21. Failed/Reprint outputs are excluded from completed totals; reprint captures new completion timestamp while preserving failedCount; leaving Completed clears old completion timestamp', () => {
    const base = createBaseWorkspace();
    const m0 = base.machines[0].id;
    const t1 = Date.parse('2026-11-13T05:00:00.000Z');
    const tFail = Date.parse('2026-11-13T06:00:00.000Z');
    const tReprintStart = Date.parse('2026-11-13T07:00:00.000Z');
    const tReprintDone = Date.parse('2026-11-13T10:32:00.000Z');

    const job: ProductionJob = {
      id: 'job-reprint-flow',
      projectId: base.projects[0].id,
      colorId: base.colors[0].id,
      plateNumber: 1,
      plateCapacity: 138,
      letters: { ...emptyAlphabetMap(), X: 40, Y: 50, Z: 30 },
      stage: 'Printing',
      machineId: m0,
      actualStartedAt: new Date(t1).toISOString(),
      startedAtMs: t1,
      estimatedMinutes: 180,
      actualMinutes: 0,
      slicerVerified: true,
      stockApplied: false,
      stockTransactionId: null,
      completedIso: null,
      failedCount: 0,
      failureReason: '',
      notes: '',
      createdIso: new Date(t1).toISOString(),
      updatedIso: new Date(t1).toISOString(),
    };

    const ws0 = { ...base, jobs: [job] };
    const wsFailed = transitionJobState(ws0, job.id, 'Failed / Reprint', {
      machineId: null,
      failureReason: 'Layer shift',
      nowMs: tFail,
    }).nextWorkspace!;

    // Failed job is NOT counted in completed output
    expect(computeSuccessfulCompletedUnits(wsFailed.jobs)).toBe(0);
    expect(wsFailed.jobs[0].failedCount).toBe(1);

    // Reprint workflow: Failed -> Ready to Print -> Printing -> Completed
    const wsReady = transitionJobState(wsFailed, job.id, 'Ready to Print', {
      machineId: null,
      nowMs: tReprintStart - 60_000,
    }).nextWorkspace!;
    const wsPrinting = transitionJobState(wsReady, job.id, 'Printing', {
      machineId: m0,
      nowMs: tReprintStart,
    }).nextWorkspace!;
    const wsCompleted = transitionJobState(wsPrinting, job.id, 'Completed', {
      machineId: m0,
      nowMs: tReprintDone,
    }).nextWorkspace!;

    const completedReprintJob = wsCompleted.jobs[0];
    expect(completedReprintJob.failedCount).toBe(1);
    expect(completedReprintJob.actualCompletedAt).toBe('2026-11-13T10:32:00.000Z');
    expect(computeSuccessfulCompletedUnits(wsCompleted.jobs)).toBe(120);

    // Leaving Completed -> Failed / Reprint clears completion timestamp
    const wsReversedToFail = transitionJobState(
      wsCompleted,
      job.id,
      'Failed / Reprint',
      { machineId: null, nowMs: tReprintDone + 60_000 }
    ).nextWorkspace!;
    expect(wsReversedToFail.jobs[0].actualCompletedAt).toBeNull();
    expect(wsReversedToFail.jobs[0].completedIso).toBeNull();
    expect(wsReversedToFail.jobs[0].failedCount).toBe(2);
    expect(computeSuccessfulCompletedUnits(wsReversedToFail.jobs)).toBe(0);
  });

  it('19, 20 & 22. Renders Completed Kanban card, Expanded Details, Table View, and Legacy Fallbacks cleanly inside narrow constraints', () => {
    const base = createBaseWorkspace();
    const project = base.projects[0];
    const color = base.colors[0];
    const completeMs = Date.parse('2026-11-13T10:32:00.000Z');

    const completedCatalogJob: ProductionJob = {
      id: 'job-ui-1',
      projectId: project.id,
      colorId: color.id,
      plateNumber: 1,
      plateCapacity: 138,
      letters: { X: 40, Y: 50, Z: 30 },
      plateMode: 'catalog_category',
      categoryId: 'cat-keycaps',
      categoryNameSnapshot: 'Keycaps',
      catalogItems: [
        {
          productId: 'prod-keycap-letter',
          productName: 'Keycap Letter',
          sku: 'KEY-AZ',
          categoryId: 'cat-keycaps',
          categoryName: 'Keycaps',
          variantId: 'var-x',
          variantLabel: 'X',
          colorId: color.id,
          colorName: color.name,
          quantity: 40,
        },
        {
          productId: 'prod-keycap-letter',
          productName: 'Keycap Letter',
          sku: 'KEY-AZ',
          categoryId: 'cat-keycaps',
          categoryName: 'Keycaps',
          variantId: 'var-y',
          variantLabel: 'Y',
          colorId: color.id,
          colorName: color.name,
          quantity: 50,
        },
        {
          productId: 'prod-keycap-letter',
          productName: 'Keycap Letter',
          sku: 'KEY-AZ',
          categoryId: 'cat-keycaps',
          categoryName: 'Keycaps',
          variantId: 'var-z',
          variantLabel: 'Z',
          colorId: color.id,
          colorName: color.name,
          quantity: 30,
        },
      ],
      stage: 'Completed',
      machineId: base.machines[0].id,
      estimatedMinutes: 180,
      actualMinutes: 175,
      actualCompletedAt: '2026-11-13T10:32:00.000Z',
      actualCompletedAtMs: completeMs,
      completedIso: '2026-11-13T10:32:00.000Z',
      slicerVerified: true,
      stockApplied: true,
      stockTransactionId: null,
      failedCount: 1,
      failureReason: '',
      notes: 'Smooth bed adhesion',
      createdIso: '2026-11-13T06:00:00.000Z',
      updatedIso: '2026-11-13T10:32:00.000Z',
    };

    const legacyJob: ProductionJob = {
      id: 'job-ui-legacy',
      projectId: project.id,
      colorId: color.id,
      plateNumber: 2,
      plateCapacity: 138,
      letters: {},
      stage: 'Completed',
      machineId: null,
      estimatedMinutes: 180,
      actualMinutes: 180,
      actualCompletedAt: null,
      actualCompletedAtMs: null,
      completedIso: null,
      slicerVerified: true,
      stockApplied: false,
      stockTransactionId: null,
      failedCount: 0,
      failureReason: '',
      notes: '',
      createdIso: '2026-10-01T00:00:00.000Z',
      updatedIso: '2026-10-01T03:00:00.000Z',
    };

    const archivedCompletedJob: ProductionJob = {
      ...completedCatalogJob,
      id: 'job-ui-archived',
      plateNumber: 3,
      archived: true,
    };

    const ws: ProductionWorkspaceV5 = {
      ...base,
      jobs: [completedCatalogJob, legacyJob, archivedCompletedJob],
    };
    const schedule = computeGlobalSchedule(ws, completeMs);

    const html = renderToStaticMarkup(
      <KanbanQueueView
        workspace={ws}
        schedule={schedule}
        selectedProjectId="ALL"
        isAdmin={true}
        busyJobIds={new Set()}
        initialExpandedJobIds={new Set([completedCatalogJob.id, archivedCompletedJob.id])}
        onSelectProject={vi.fn()}
        onTransitionStage={vi.fn()}
        onPauseOrResume={vi.fn()}
        onRecalibrateJobEta={vi.fn()}
        onUpdateJobMetadata={vi.fn()}
        onCopyQueueSummary={vi.fn()}
        onRequestDeletePlate={vi.fn()}
        onRequestCancelPrinting={vi.fn()}
        onArchivePlate={vi.fn()}
        onRestorePlate={vi.fn()}
        onRequestBulkAction={vi.fn()}
      />
    );

    // Completed timestamp & breakdown visible on Completed card + Expanded details
    expect(html).toContain('13 Nov 2026 · 6:32 PM');
    expect(html).toContain('Keycap Letter');
    expect(html).toContain('120 pcs');
    expect(html).toContain('Full Variation Breakdown');
    expect(html).toContain('Completed Plate Details');
    expect(html).toContain('Previous Failed Attempts');
    expect(html).toContain('1 failed run');
    expect(html).toContain(color.name);
    // Must not double-count companion letters as 240
    expect(html).not.toContain('240 pcs');

    // Legacy fallbacks rendered truthfully
    expect(html).toContain('Not recorded');
    expect(html).toContain('Variation Breakdown: Not recorded');

    // Narrow card safety: article retains min-w-0 width constraint
    const articles = [...html.matchAll(/<article class="([^"]*)"/g)];
    expect(articles.length).toBeGreaterThanOrEqual(2);
    for (const [, articleClass] of articles) {
      expect(articleClass).toContain('min-w-0');
    }
  });
});
