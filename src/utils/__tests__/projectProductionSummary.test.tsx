import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ProjectProductionSummaryModal } from '../../components/ProjectProductionSummaryModal';
import { ProjectsView } from '../../components/ProjectsView';
import {
  ABC,
  computeProjectPlateProgress,
  createFreshWorkspaceV5,
  emptyAlphabetMap,
  emptyCharmsMap,
  normalizeWorkspaceV5,
} from '../../constants';
import {
  CatalogProduct,
  CategoryPlateSetting,
  ColorOption,
  ProductCategory,
  ProductionJob,
  ProductionProject,
  ProductionWorkspaceV5,
} from '../../types';
import {
  applyColorToAllCatalogPlates,
  assignColorToDraftCatalogPlate,
  commitCatalogPlatesSplitByColor,
  commitCatalogPlatesToWorkspace,
  generateAutomaticCatalogPlatePreviews,
  getPlannableProductItems,
  validateStagedCatalogPlatesBatch,
} from '../catalogPlannerEngine';
import { prepareWorkspaceForFirestore } from '../firestorePayload';
import { commitGeneratedPlatesToWorkspace } from '../productionEngine';
import {
  auditProductionJobRelationships,
  buildProjectProductionSummary,
} from '../projectProductionSummary';
import { computeGlobalSchedule } from '../schedulingEngine';

const OWNER_UID = 'owner-batch-summary-test';

function makeColor(id: string, name: string, hex = '#00AE42'): ColorOption {
  return { id, name, hex };
}

function makeProject(
  base: ProductionProject,
  overrides: Partial<ProductionProject> & { id: string; name: string }
): ProductionProject {
  return {
    ...base,
    ...overrides,
  };
}

function makeJob(
  base: ProductionWorkspaceV5,
  overrides: Partial<ProductionJob> & { id: string; plateNumber: number }
): ProductionJob {
  return {
    projectId: base.projects[0].id,
    colorId: base.colors[0].id,
    plateCapacity: 138,
    letters: {},
    stage: 'Completed',
    machineId: base.machines[0].id,
    estimatedMinutes: 180,
    actualMinutes: 175,
    slicerVerified: true,
    stockApplied: true,
    stockTransactionId: null,
    failedCount: 0,
    failureReason: '',
    notes: '',
    createdIso: '2026-11-10T06:00:00.000Z',
    updatedIso: '2026-11-10T09:00:00.000Z',
    completedIso: '2026-11-10T09:00:00.000Z',
    actualCompletedAt: '2026-11-10T09:00:00.000Z',
    actualCompletedAtMs: Date.parse('2026-11-10T09:00:00.000Z'),
    ...overrides,
  };
}

function makeBaseV1Product(categoryId = 'cat-clicker'): CatalogProduct {
  return {
    id: 'prod-base-v1',
    ownerId: OWNER_UID,
    sku: 'WOOPP-BASEV1',
    name: 'Base V1',
    description: 'Clicker Base V1',
    categoryId,
    images: [],
    priceMyr: 8,
    options: [],
    variants: [],
    status: 'active',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

function makeAlphabetProduct(categoryId = 'cat-keycaps'): CatalogProduct {
  return {
    id: 'prod-alpha',
    ownerId: OWNER_UID,
    sku: 'WOOPP-ALPHA',
    name: 'Keycap Letter A–Z',
    description: 'Alphabet Keycaps',
    categoryId,
    images: [],
    priceMyr: 4,
    options: [{ id: 'opt-letter', name: 'Letter', values: [...ABC], sortOrder: 0 }],
    variants: [],
    status: 'active',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

function makeCategory(
  id = 'cat-clicker',
  name = 'Clicker Bases'
): ProductCategory {
  return {
    id,
    ownerId: OWNER_UID,
    name,
    description: name,
    imageUrl: null,
    iconName: 'box',
    sortOrder: 0,
    status: 'active',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

function makeSetting(
  categoryId = 'cat-clicker',
  plateCapacity = 20
): CategoryPlateSetting {
  return {
    categoryId,
    ownerId: OWNER_UID,
    allocationMode: 'automatic_capacity',
    plateCapacity,
    defaultEstimatedMinutes: 120,
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

describe('WOOPP 6.0 — Production Batch Identity, Grouping & Printable Batch Packing Summary', () => {
  it('1–5. Creates unique immutable batchIds per confirmation (never auto-merges same Project+Product+Color); multi-plate batch shares one batchId + unique job IDs', () => {
    const base = createFreshWorkspaceV5(OWNER_UID);
    const pink = makeColor('color-pink', 'Pink', '#EC4899');
    const ws: ProductionWorkspaceV5 = { ...base, colors: [pink, ...base.colors], jobs: [] };
    const cat = makeCategory();
    const baseV1 = makeBaseV1Product(cat.id);
    const setting = makeSetting(cat.id, 20);

    // Draft preview creates NO batches or permanent IDs before confirmation
    const draft = generateAutomaticCatalogPlatePreviews({
      existingJobs: ws.jobs,
      project: ws.projects[0],
      color: null,
      workspaceColors: ws.colors,
      category: cat,
      products: [baseV1],
      selections: [{ productId: baseV1.id, variantId: null, quantity: 80 }],
      plateSetting: setting,
      nowMs: 1700000000000,
    });
    expect(draft.previews).toHaveLength(4);
    expect(ws.projects[0].productionBatches).toBeUndefined();
    expect(ws.jobs).toHaveLength(0);

    // Apply Pink to all 4 plates -> Confirm Batch 001 (4 plates, 80 pcs)
    const batch1Plates = applyColorToAllCatalogPlates(
      draft.previews!,
      pink,
      baseV1,
      ws.colors
    );
    const commit1 = commitCatalogPlatesToWorkspace(ws, {
      projectId: ws.projects[0].id,
      category: cat,
      products: [baseV1],
      confirmedPlates: batch1Plates,
      nowMs: 1700000100000,
    });
    expect(commit1.error).toBeUndefined();
    expect(commit1.batchRecord?.batchNumber).toBe(1);
    expect(commit1.createdJobs).toHaveLength(4);
    expect(new Set(commit1.createdJobs!.map((j) => j.id)).size).toBe(4);
    expect(new Set(commit1.createdJobs!.map((j) => j.batchId)).size).toBe(1);

    // Second separate confirmation for SAME project + SAME product (Base V1) + SAME color (Pink)
    const wsAfter1 = commit1.nextWorkspace!;
    const draft2 = generateAutomaticCatalogPlatePreviews({
      existingJobs: wsAfter1.jobs,
      project: wsAfter1.projects[0],
      color: null,
      workspaceColors: wsAfter1.colors,
      category: cat,
      products: [baseV1],
      selections: [{ productId: baseV1.id, variantId: null, quantity: 40 }],
      plateSetting: setting,
      nowMs: 1700000200000,
    });
    const batch2Plates = applyColorToAllCatalogPlates(
      draft2.previews!,
      pink,
      baseV1,
      wsAfter1.colors
    );
    const commit2 = commitCatalogPlatesToWorkspace(wsAfter1, {
      projectId: wsAfter1.projects[0].id,
      category: cat,
      products: [baseV1],
      confirmedPlates: batch2Plates,
      nowMs: 1700000300000,
    });
    expect(commit2.error).toBeUndefined();
    expect(commit2.batchRecord?.batchNumber).toBe(2);
    expect(commit2.batchId).not.toBe(commit1.batchId);

    // Mark all jobs Completed across both batches
    const wsAllCompleted: ProductionWorkspaceV5 = {
      ...commit2.nextWorkspace!,
      jobs: commit2.nextWorkspace!.jobs.map((j) => ({
        ...j,
        stage: 'Completed',
        actualCompletedAt: '2026-11-10T10:00:00.000Z',
        actualCompletedAtMs: Date.parse('2026-11-10T10:00:00.000Z'),
        completedIso: '2026-11-10T10:00:00.000Z',
      })),
    };

    const summary = buildProjectProductionSummary({
      workspace: wsAllCompleted,
      projectId: ws.projects[0].id,
    });
    expect(summary.totalBatches).toBe(2);
    expect(summary.batches[0].batchLabel).toBe('Batch 001');
    expect(summary.batches[0].generatedPlateCount).toBe(4);
    expect(summary.batches[0].completedQuantity).toBe(80);
    expect(summary.batches[1].batchLabel).toBe('Batch 002');
    expect(summary.batches[1].generatedPlateCount).toBe(2);
    expect(summary.batches[1].completedQuantity).toBe(40);
  });

  it('6–8. Isolates different project IDs sharing identical names, detects missing/dangling projects, and ignores misleading job ID suffixes', () => {
    const base = createFreshWorkspaceV5(OWNER_UID);
    const p1 = makeProject(base.projects[0], {
      id: 'proj-alpha-1',
      name: 'Mydin Ecah',
      productionBatches: [
        {
          id: 'batch-p1-1',
          batchNumber: 1,
          projectId: 'proj-alpha-1',
          productId: 'builtin:alphabet',
          productName: 'Alphabet Keycaps (A–Z)',
          sku: null,
          categoryId: null,
          categoryName: 'Built-in Keycap Workflows',
          colorId: base.colors[0].id,
          colorName: base.colors[0].name,
          mode: 'alphabet_only',
          plateCapacity: 138,
          requestedQuantity: 45,
          committedQuantity: 45,
          generatedJobIds: ['job-p1-a', 'job-p1-b'],
          plateNumbers: [1, 2],
          requestedVariations: [
            { variationKey: 'letter:A', variantId: null, label: 'A', requestedQuantity: 30 },
            { variationKey: 'letter:B', variantId: null, label: 'B', requestedQuantity: 15 },
          ],
          createdIso: '2026-11-01T09:00:00.000Z',
          updatedIso: '2026-11-01T09:00:00.000Z',
        },
      ],
    });
    const p2 = makeProject(base.projects[0], {
      id: 'proj-beta-2',
      name: 'Mydin Ecah', // identical name, different ID
      productionBatches: [
        {
          id: 'batch-p2-1',
          batchNumber: 1,
          projectId: 'proj-beta-2',
          productId: 'builtin:alphabet',
          productName: 'Alphabet Keycaps (A–Z)',
          sku: null,
          categoryId: null,
          categoryName: 'Built-in Keycap Workflows',
          colorId: base.colors[0].id,
          colorName: base.colors[0].name,
          mode: 'alphabet_only',
          plateCapacity: 138,
          requestedQuantity: 99,
          committedQuantity: 99,
          generatedJobIds: ['job-proj-alpha-1-suffix'],
          plateNumbers: [3],
          requestedVariations: [
            { variationKey: 'letter:Z', variantId: null, label: 'Z', requestedQuantity: 99 },
          ],
          createdIso: '2026-11-02T09:00:00.000Z',
          updatedIso: '2026-11-02T09:00:00.000Z',
        },
      ],
    });

    const jobs: ProductionJob[] = [
      makeJob(base, {
        id: 'job-p1-a',
        projectId: 'proj-alpha-1',
        batchId: 'batch-p1-1',
        plateNumber: 1,
        machineId: base.machines[0].id,
        letters: { ...emptyAlphabetMap(), A: 30 },
      }),
      makeJob(base, {
        id: 'job-p1-b',
        projectId: 'proj-alpha-1',
        batchId: 'batch-p1-1',
        plateNumber: 2,
        machineId: base.machines[1].id, // different machine + date
        actualCompletedAt: '2026-11-15T14:00:00.000Z',
        actualCompletedAtMs: Date.parse('2026-11-15T14:00:00.000Z'),
        letters: { ...emptyAlphabetMap(), B: 15 },
      }),
      makeJob(base, {
        id: 'job-proj-alpha-1-suffix',
        projectId: 'proj-beta-2',
        batchId: 'batch-p2-1',
        plateNumber: 3,
        letters: { ...emptyAlphabetMap(), Z: 99 },
      }),
      makeJob(base, {
        id: 'job-missing-proj',
        projectId: '',
        plateNumber: 4,
        letters: { ...emptyAlphabetMap(), C: 10 },
      }),
      makeJob(base, {
        id: 'job-dangling-proj',
        projectId: 'proj-nonexistent',
        plateNumber: 5,
        letters: { ...emptyAlphabetMap(), D: 10 },
      }),
    ];

    const ws: ProductionWorkspaceV5 = { ...base, projects: [p1, p2], jobs };
    const audit = auditProductionJobRelationships(ws);
    expect(audit.unlinkedJobs.map((j) => j.id)).toEqual([
      'job-missing-proj',
      'job-dangling-proj',
    ]);

    const s1 = buildProjectProductionSummary({ workspace: ws, projectId: 'proj-alpha-1' });
    const s2 = buildProjectProductionSummary({ workspace: ws, projectId: 'proj-beta-2' });
    expect(s1.totalBatches).toBe(1);
    expect(s1.totalCompletedUnits).toBe(45);
    expect(s2.totalBatches).toBe(1);
    expect(s2.totalCompletedUnits).toBe(99);
  });

  it('9–12. Blocks silent mixed-color single batch, supports Apply Color to All Plates and explicit Split by Color, and enforces 1 Product per batch', () => {
    const base = createFreshWorkspaceV5(OWNER_UID);
    const c1 = makeColor('color-pink', 'Pink', '#EC4899');
    const c2 = makeColor('color-black', 'Black', '#18181B');
    const ws: ProductionWorkspaceV5 = { ...base, colors: [c1, c2] };
    const cat = makeCategory();
    const baseV1 = makeBaseV1Product(cat.id);
    const setting = makeSetting(cat.id, 20);

    const preview = generateAutomaticCatalogPlatePreviews({
      existingJobs: [],
      project: ws.projects[0],
      color: null,
      workspaceColors: ws.colors,
      category: cat,
      products: [baseV1],
      selections: [{ productId: baseV1.id, variantId: null, quantity: 40 }],
      plateSetting: setting,
      nowMs: 1700000000000,
    });

    const mixedPlates = [
      assignColorToDraftCatalogPlate(preview.previews![0], c1, baseV1, ws.colors),
      assignColorToDraftCatalogPlate(preview.previews![1], c2, baseV1, ws.colors),
    ];

    const val = validateStagedCatalogPlatesBatch(mixedPlates, {
      category: cat,
      product: baseV1,
      workspaceColors: ws.colors,
    });
    expect(val.hasColorConflict).toBe(true);
    expect(val.allValid).toBe(false);
    expect(val.batchColorConflictError).toMatch(/One Production Batch must use one/i);

    const blocked = commitCatalogPlatesToWorkspace(ws, {
      projectId: ws.projects[0].id,
      category: cat,
      products: [baseV1],
      confirmedPlates: mixedPlates,
    });
    expect(blocked.error).toMatch(/Batch color conflict/i);
    expect(blocked.createdJobs).toBeUndefined();

    // Apply Pink to All Plates -> 1 batch
    const appliedPink = applyColorToAllCatalogPlates(mixedPlates, c1, baseV1, ws.colors);
    expect(appliedPink.every((p) => p.colorId === 'color-pink')).toBe(true);

    // Explicit Split by Color -> 2 isolated batches
    const splitRes = commitCatalogPlatesSplitByColor(ws, {
      projectId: ws.projects[0].id,
      category: cat,
      products: [baseV1],
      confirmedPlates: mixedPlates,
      nowMs: 1700000500000,
    });
    expect(splitRes.error).toBeUndefined();
    expect(splitRes.batchIds).toHaveLength(2);
    expect(splitRes.batchRecords!.map((b) => b.batchNumber)).toEqual([1, 2]);
    expect(splitRes.batchRecords!.map((b) => b.colorId)).toEqual([
      'color-pink',
      'color-black',
    ]);

    // Mixed products across plates in one batch blocked cleanly
    const prod2 = { ...baseV1, id: 'prod-other', name: 'Other Product' };
    const pOther = {
      ...appliedPink[1],
      productId: prod2.id,
      productName: prod2.name,
      items: appliedPink[1].items.map((it) => ({
        ...it,
        productId: prod2.id,
        productName: prod2.name,
      })),
    };
    const prodConflict = commitCatalogPlatesToWorkspace(ws, {
      projectId: ws.projects[0].id,
      category: cat,
      products: [baseV1, prod2],
      confirmedPlates: [appliedPink[0], pOther],
    });
    expect(prodConflict.error).toMatch(/Batch product conflict/i);
  });

  it('13–17. Tracks Partial Completion accurately, includes archived Completed, excludes Planned/Printing/Failed/Cancelled, deduplicates job IDs & companion A-Z, and single-counts reprints', () => {
    const base = createFreshWorkspaceV5(OWNER_UID);
    const nowMs = Date.parse('2026-11-17T12:00:00.000Z');
    const oldCompletedMs = Date.parse('2026-11-01T08:00:00.000Z'); // >72h archived

    const p = makeProject(base.projects[0], {
      id: 'proj-partial',
      name: 'Partial Batch Order',
      productionBatches: [
        {
          id: 'batch-partial-1',
          batchNumber: 1,
          projectId: 'proj-partial',
          productId: 'prod-alpha',
          productName: 'Keycap Letter A–Z',
          sku: 'WOOPP-ALPHA',
          categoryId: 'cat-keycaps',
          categoryName: 'Keycaps',
          colorId: base.colors[0].id,
          colorName: base.colors[0].name,
          mode: 'catalog_category',
          plateCapacity: 50,
          requestedQuantity: 100,
          committedQuantity: 100,
          generatedJobIds: [
            'job-done-reprint',
            'job-done-archived',
            'job-printing',
            'job-failed',
            'job-cancelled',
          ],
          plateNumbers: [1, 2, 3, 4, 5],
          requestedVariations: [
            { variationKey: 'var:v-a', variantId: 'v-a', label: 'A', requestedQuantity: 60 },
            { variationKey: 'var:v-b', variantId: 'v-b', label: 'B', requestedQuantity: 40 },
          ],
          createdIso: '2026-11-01T06:00:00.000Z',
          updatedIso: '2026-11-01T06:00:00.000Z',
        },
      ],
    });

    const catSnap = (varId: string, label: string, qty: number) => [
      {
        productId: 'prod-alpha',
        productName: 'Keycap Letter A–Z',
        sku: 'WOOPP-ALPHA',
        categoryId: 'cat-keycaps',
        categoryName: 'Keycaps',
        variantId: varId,
        variantLabel: label,
        colorId: base.colors[0].id,
        colorName: base.colors[0].name,
        quantity: qty,
      },
    ];

    const completedJob1 = makeJob(base, {
      id: 'job-done-reprint',
      projectId: p.id,
      batchId: 'batch-partial-1',
      plateNumber: 1,
      actualCompletedAt: '2026-11-17T10:00:00.000Z',
      actualCompletedAtMs: Date.parse('2026-11-17T10:00:00.000Z'),
      completedIso: '2026-11-17T10:00:00.000Z',
      failedCount: 2, // reprint completed twice before passing -> must count ONCE!
      letters: { ...emptyAlphabetMap(), A: 30 }, // mirrored companion letters -> must NOT double-count!
      catalogItems: catSnap('v-a', 'A', 30),
    });

    const jobs: ProductionJob[] = [
      completedJob1,
      { ...completedJob1 }, // duplicate job.id in array -> deduplicated
      makeJob(base, {
        id: 'job-done-archived',
        projectId: p.id,
        batchId: 'batch-partial-1',
        plateNumber: 2,
        actualCompletedAt: new Date(oldCompletedMs).toISOString(),
        actualCompletedAtMs: oldCompletedMs,
        completedIso: new Date(oldCompletedMs).toISOString(),
        letters: { ...emptyAlphabetMap(), A: 10, B: 15 },
        catalogItems: [...catSnap('v-a', 'A', 10), ...catSnap('v-b', 'B', 15)],
      }),
      makeJob(base, {
        id: 'job-printing',
        projectId: p.id,
        batchId: 'batch-partial-1',
        plateNumber: 3,
        stage: 'Printing',
        completedIso: null,
        actualCompletedAt: null,
        actualCompletedAtMs: null,
        catalogItems: catSnap('v-a', 'A', 20),
      }),
      makeJob(base, {
        id: 'job-failed',
        projectId: p.id,
        batchId: 'batch-partial-1',
        plateNumber: 4,
        stage: 'Failed / Reprint',
        failedCount: 1,
        completedIso: null,
        actualCompletedAt: null,
        actualCompletedAtMs: null,
        catalogItems: catSnap('v-b', 'B', 15),
      }),
      makeJob(base, {
        id: 'job-cancelled',
        projectId: p.id,
        batchId: 'batch-partial-1',
        plateNumber: 5,
        stage: 'Cancelled',
        completedIso: null,
        actualCompletedAt: null,
        actualCompletedAtMs: null,
        catalogItems: catSnap('v-b', 'B', 10),
      }),
    ];

    const ws: ProductionWorkspaceV5 = { ...base, projects: [p], jobs };
    const summary = buildProjectProductionSummary({
      workspace: ws,
      projectId: p.id,
      nowMs,
    });

    expect(summary.duplicateJobIdsSkipped).toEqual(['job-done-reprint']);
    expect(summary.totalBatches).toBe(1);
    const b = summary.batches[0];
    expect(b.completionStatus).toBe('partial');
    expect(b.hasPartialWarning).toBe(true);
    expect(b.isCompleteForBulkPrint).toBe(false);
    expect(b.generatedPlateCount).toBe(5);
    expect(b.completedPlateCount).toBe(2);
    expect(b.archivedCompletedPlateCount).toBe(1);
    expect(b.reprintCompletedPlateCount).toBe(1);
    expect(b.requestedQuantity).toBe(100);
    expect(b.completedQuantity).toBe(55); // 30 A + 10 A + 15 B
    expect(b.remainingQuantity).toBe(45);
    expect(b.variations.map((v) => [v.label, v.requestedQuantity, v.completedQuantity, v.remainingQuantity])).toEqual([
      ['A', 60, 40, 20],
      ['B', 40, 15, 25],
    ]);
  });

  it('18–21. Legacy jobs never silently merge; homogeneous planningSessionId reconstructs safely while mixed sessions stay in legacyJobs; deleted batch jobs leave 0 empty batches', () => {
    const base = createFreshWorkspaceV5(OWNER_UID);
    const c1 = makeColor('color-1', 'Green', '#00AE42');
    const c2 = makeColor('color-2', 'Pink', '#EC4899');
    const proj = makeProject(base.projects[0], {
      id: 'proj-legacy-check',
      name: 'Legacy Audit Project',
      productionBatches: [
        {
          id: 'batch-deleted-all-jobs',
          batchNumber: 99,
          projectId: 'proj-legacy-check',
          productId: 'prod-base-v1',
          productName: 'Deleted Batch Product',
          sku: null,
          categoryId: null,
          categoryName: null,
          colorId: 'color-1',
          colorName: 'Green',
          mode: 'catalog_category',
          plateCapacity: 20,
          requestedQuantity: 20,
          committedQuantity: 20,
          generatedJobIds: ['nonexistent-deleted-job'],
          plateNumbers: [99],
          requestedVariations: [],
          createdIso: '2026-10-01T00:00:00.000Z',
          updatedIso: '2026-10-01T00:00:00.000Z',
        },
      ],
    });

    const baseSnap = (colorId: string, colorName: string) => [
      {
        productId: 'prod-base-v1',
        productName: 'Base V1',
        sku: 'WOOPP-BASEV1',
        categoryId: 'cat-clicker',
        categoryName: 'Clicker Bases',
        variantId: null,
        variantLabel: null,
        colorId,
        colorName,
        quantity: 20,
      },
    ];

    const jobs: ProductionJob[] = [
      // Two historical jobs with same project + same product + same color, NO batchId, NO planningSessionId -> MUST NOT merge!
      makeJob(base, {
        id: 'legacy-1',
        projectId: proj.id,
        colorId: 'color-1',
        plateNumber: 1,
        catalogItems: baseSnap('color-1', 'Green'),
      }),
      makeJob(base, {
        id: 'legacy-2',
        projectId: proj.id,
        colorId: 'color-1',
        plateNumber: 2,
        catalogItems: baseSnap('color-1', 'Green'),
      }),
      // Old homogeneous planningSessionId -> safely reconstructs into 1 batch
      makeJob(base, {
        id: 'sess-ok-1',
        projectId: proj.id,
        colorId: 'color-1',
        planningSessionId: 'session-single-color',
        plateNumber: 3,
        catalogItems: baseSnap('color-1', 'Green'),
      }),
      makeJob(base, {
        id: 'sess-ok-2',
        projectId: proj.id,
        colorId: 'color-1',
        planningSessionId: 'session-single-color',
        plateNumber: 4,
        catalogItems: baseSnap('color-1', 'Green'),
      }),
      // Old multi-color session -> MUST NOT reconstruct or merge; stays in legacyJobs individually
      makeJob(base, {
        id: 'sess-mixed-1',
        projectId: proj.id,
        colorId: 'color-1',
        planningSessionId: 'catplan-old-mixed',
        plateNumber: 5,
        catalogItems: baseSnap('color-1', 'Green'),
      }),
      makeJob(base, {
        id: 'sess-mixed-2',
        projectId: proj.id,
        colorId: 'color-2',
        planningSessionId: 'catplan-old-mixed',
        plateNumber: 6,
        catalogItems: baseSnap('color-2', 'Pink'),
      }),
    ];

    const ws: ProductionWorkspaceV5 = { ...base, colors: [c1, c2], projects: [proj], jobs };
    const summary = buildProjectProductionSummary({
      workspace: ws,
      projectId: proj.id,
    });

    // Empty deleted batch record must NOT appear as a 0-plate batch
    expect(summary.batches.some((b) => b.batchId === 'batch-deleted-all-jobs')).toBe(false);
    // Only the homogeneous planningSessionId reconstructs into 1 batch (2 plates, 40 pcs)
    expect(summary.totalBatches).toBe(1);
    expect(summary.batches[0].identitySource).toBe('reconstructed_session');
    expect(summary.batches[0].completedPlateCount).toBe(2);
    expect(summary.batches[0].completedQuantity).toBe(40);
    // The 2 unlinked legacy jobs + 2 mixed-session jobs stay individually in legacyJobs (4 items)
    expect(summary.legacyJobs).toHaveLength(4);
    expect(summary.legacyJobs.map((l) => l.jobId)).toEqual([
      'legacy-1',
      'legacy-2',
      'sess-mixed-1',
      'sess-mixed-2',
    ]);
  });

  it('22–26. Modal renders batch selector, partial completion warning & completed-only packing output, Print All Completed Batches with A4 page breaks, and Print CSS', async () => {
    const base = createFreshWorkspaceV5(OWNER_UID);
    const c1 = makeColor('color-pink', 'Pink', '#EC4899');
    const c2 = makeColor('color-black', 'Black', '#18181B');
    const p = makeProject(base.projects[0], {
      id: 'proj-print-check',
      name: 'Print Sheet Order',
      productionBatches: [
        {
          id: 'batch-done-1',
          batchNumber: 1,
          projectId: 'proj-print-check',
          productId: 'prod-1',
          productName: 'Base V1',
          sku: 'SKU-B1',
          categoryId: 'cat-1',
          categoryName: 'Bases',
          colorId: 'color-pink',
          colorName: 'Pink',
          mode: 'catalog_category',
          plateCapacity: 20,
          requestedQuantity: 40,
          committedQuantity: 40,
          generatedJobIds: ['j-b1-1', 'j-b1-2'],
          plateNumbers: [1, 2],
          requestedVariations: [
            { variationKey: 'novar:standard', variantId: null, label: 'Standard / No Variation', requestedQuantity: 40 },
          ],
          createdIso: '2026-11-10T08:00:00.000Z',
          updatedIso: '2026-11-10T08:00:00.000Z',
        },
        {
          id: 'batch-done-2',
          batchNumber: 2,
          projectId: 'proj-print-check',
          productId: 'prod-1',
          productName: 'Base V1',
          sku: 'SKU-B1',
          categoryId: 'cat-1',
          categoryName: 'Bases',
          colorId: 'color-black',
          colorName: 'Black',
          mode: 'catalog_category',
          plateCapacity: 20,
          requestedQuantity: 20,
          committedQuantity: 20,
          generatedJobIds: ['j-b2-1'],
          plateNumbers: [3],
          requestedVariations: [
            { variationKey: 'novar:standard', variantId: null, label: 'Standard / No Variation', requestedQuantity: 20 },
          ],
          createdIso: '2026-11-11T08:00:00.000Z',
          updatedIso: '2026-11-11T08:00:00.000Z',
        },
        {
          id: 'batch-partial-3',
          batchNumber: 3,
          projectId: 'proj-print-check',
          productId: 'prod-1',
          productName: 'Base V1',
          sku: 'SKU-B1',
          categoryId: 'cat-1',
          categoryName: 'Bases',
          colorId: 'color-pink',
          colorName: 'Pink',
          mode: 'catalog_category',
          plateCapacity: 20,
          requestedQuantity: 40,
          committedQuantity: 40,
          generatedJobIds: ['j-b3-1', 'j-b3-2'],
          plateNumbers: [4, 5],
          requestedVariations: [
            { variationKey: 'novar:standard', variantId: null, label: 'Standard / No Variation', requestedQuantity: 40 },
          ],
          createdIso: '2026-11-12T08:00:00.000Z',
          updatedIso: '2026-11-12T08:00:00.000Z',
        },
      ],
    });

    const snap = (colorId: string, colorName: string, qty: number) => [
      {
        productId: 'prod-1',
        productName: 'Base V1',
        sku: 'SKU-B1',
        categoryId: 'cat-1',
        categoryName: 'Bases',
        variantId: null,
        variantLabel: null,
        colorId,
        colorName,
        quantity: qty,
      },
    ];

    const jobs: ProductionJob[] = [
      makeJob(base, { id: 'j-b1-1', projectId: p.id, colorId: 'color-pink', batchId: 'batch-done-1', plateNumber: 1, catalogItems: snap('color-pink', 'Pink', 20) }),
      makeJob(base, { id: 'j-b1-2', projectId: p.id, colorId: 'color-pink', batchId: 'batch-done-1', plateNumber: 2, catalogItems: snap('color-pink', 'Pink', 20) }),
      makeJob(base, { id: 'j-b2-1', projectId: p.id, colorId: 'color-black', batchId: 'batch-done-2', plateNumber: 3, catalogItems: snap('color-black', 'Black', 20) }),
      makeJob(base, { id: 'j-b3-1', projectId: p.id, colorId: 'color-pink', batchId: 'batch-partial-3', plateNumber: 4, catalogItems: snap('color-pink', 'Pink', 20) }),
      makeJob(base, { id: 'j-b3-2', projectId: p.id, colorId: 'color-pink', batchId: 'batch-partial-3', plateNumber: 5, stage: 'Printing', completedIso: null, actualCompletedAt: null, actualCompletedAtMs: null, catalogItems: snap('color-pink', 'Pink', 20) }),
    ];

    const ws: ProductionWorkspaceV5 = { ...base, colors: [c1, c2], projects: [p], jobs };

    // Single partial batch print includes [PARTIAL BATCH COMPLETION — COMPLETED OUTPUT ONLY]
    const htmlPartialSingle = renderToStaticMarkup(
      <ProjectProductionSummaryModal
        workspace={ws}
        project={p}
        onClose={vi.fn()}
        nowMs={Date.parse('2026-11-17T10:00:00.000Z')}
        initialSelectedBatchId="batch-partial-3"
        initialPrintScope="single"
      />
    );
    expect(htmlPartialSingle).toContain('Batch 001');
    expect(htmlPartialSingle).toContain('Batch 002');
    expect(htmlPartialSingle).toContain('Batch 003');
    expect(htmlPartialSingle).toContain('Print All Completed Batches (2)');
    expect(htmlPartialSingle).toContain('[PARTIAL BATCH COMPLETION — COMPLETED OUTPUT ONLY]');
    expect(htmlPartialSingle).toContain('20 pcs');

    // Print All Completed Batches includes ONLY Batch 001 and Batch 002 (NOT partial Batch 003) with page break
    const htmlAllCompleted = renderToStaticMarkup(
      <ProjectProductionSummaryModal
        workspace={ws}
        project={p}
        onClose={vi.fn()}
        nowMs={Date.parse('2026-11-17T10:00:00.000Z')}
        initialPrintScope="all_completed"
      />
    );
    expect(htmlAllCompleted).toContain('data-packing-batch-id="batch-done-1"');
    expect(htmlAllCompleted).toContain('data-packing-batch-id="batch-done-2"');
    expect(htmlAllCompleted).not.toContain('data-packing-batch-id="batch-partial-3"');
    expect(htmlAllCompleted).toContain('woopp-page-break-before');

    // ProjectsView Print Summary button present
    const projectsHtml = renderToStaticMarkup(
      <ProjectsView
        workspace={ws}
        selectedProjectId={p.id}
        onSelectProject={vi.fn()}
        onSaveProject={vi.fn()}
        onUpdateProjectStatus={vi.fn()}
        onNavigate={vi.fn()}
      />
    );
    expect(projectsHtml).toContain('Print Summary');

    // Verify A4 Print CSS styles intact
    const fsSpecifier = ['node', 'fs'].join(':');
    const { readFileSync } = await import(/* @vite-ignore */ fsSpecifier);
    const cssText = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');
    expect(cssText).toContain('size: A4 portrait');
    expect(cssText).toContain('.no-print');
    expect(cssText).toContain('.woopp-page-break-before');
  });

  it('27–30. Supports Built-in & Product Studio E2E pipeline, preserves Firestore round-trip & existing schedules, and leaves zero orphans on validation failure', () => {
    const base = createFreshWorkspaceV5(OWNER_UID);
    const pink = makeColor('color-pink', 'Pink', '#EC4899');
    const ws: ProductionWorkspaceV5 = { ...base, colors: [pink, ...base.colors], jobs: [] };
    const cat = makeCategory('cat-keys', 'Keycaps');
    const alphaProd = makeAlphabetProduct(cat.id);
    const plannable = getPlannableProductItems(alphaProd);
    const varA = plannable.find((i) => i.label === 'A')!;
    const varK = plannable.find((i) => i.label === 'K')!;

    // Failure atomicity: invalid batch leaves zero orphan batchRecords or jobs
    const failedCommit = commitCatalogPlatesToWorkspace(ws, {
      projectId: 'nonexistent-proj',
      category: cat,
      products: [alphaProd],
      confirmedPlates: [],
    });
    expect(failedCommit.error).toBeDefined();
    expect(failedCommit.nextWorkspace).toBeUndefined();
    expect(ws.projects[0].productionBatches).toBeUndefined();

    // Built-in workflow creates homogeneous Batch 001
    const builtinCommit = commitGeneratedPlatesToWorkspace(ws, {
      projectId: ws.projects[0].id,
      colorId: pink.id,
      plateCapacity: 50,
      mode: 'charm_only',
      targetLetters: emptyAlphabetMap(),
      targetCharms: { ...emptyCharmsMap(), CHARM_LOVE: 12 },
      carryForwardLetters: emptyAlphabetMap(),
      carryForwardCharms: emptyCharmsMap(),
      confirmedPlates: [
        {
          tempId: 'draft-charm-1',
          plateNumber: 1,
          capacity: 50,
          letters: {},
          charms: { CHARM_LOVE: 12 },
          plateMode: 'charm_only',
          estimatedMinutes: 90,
          slicerVerified: true,
          notes: '',
        },
      ],
      nowMs: 1700001000000,
    });
    expect(builtinCommit.error).toBeUndefined();
    expect(builtinCommit.batchRecord?.batchNumber).toBe(1);

    // Product Studio workflow creates homogeneous Batch 002
    const ws2 = builtinCommit.nextWorkspace!;
    const preview = generateAutomaticCatalogPlatePreviews({
      existingJobs: ws2.jobs,
      project: ws2.projects[0],
      color: null,
      workspaceColors: ws2.colors,
      category: cat,
      products: [alphaProd],
      selections: [
        { productId: alphaProd.id, variantId: varA.id, quantity: 30 },
        { productId: alphaProd.id, variantId: varK.id, quantity: 25 },
      ],
      plateSetting: makeSetting(cat.id, 138),
      nowMs: 1700002000000,
    });
    const assigned = applyColorToAllCatalogPlates(
      preview.previews!,
      pink,
      alphaProd,
      ws2.colors
    );
    const catalogCommit = commitCatalogPlatesToWorkspace(ws2, {
      projectId: ws2.projects[0].id,
      category: cat,
      products: [alphaProd],
      confirmedPlates: assigned,
      nowMs: 1700002100000,
    });
    expect(catalogCommit.error).toBeUndefined();
    expect(catalogCommit.batchRecord?.batchNumber).toBe(2);

    // Complete all jobs in Batch 001 & Batch 002
    const completedWs: ProductionWorkspaceV5 = {
      ...catalogCommit.nextWorkspace!,
      jobs: catalogCommit.nextWorkspace!.jobs.map((j) => ({
        ...j,
        stage: 'Completed',
        actualCompletedAt: '2026-11-16T12:00:00.000Z',
        actualCompletedAtMs: Date.parse('2026-11-16T12:00:00.000Z'),
        completedIso: '2026-11-16T12:00:00.000Z',
      })),
    };

    // Verify full Firestore sanitization + JSON round-trip preserves productionBatches & job.batchId
    const fsPayload = prepareWorkspaceForFirestore(completedWs, OWNER_UID);
    const roundTripped = normalizeWorkspaceV5(
      JSON.parse(JSON.stringify(fsPayload)),
      OWNER_UID
    );
    expect(roundTripped.projects[0].productionBatches).toHaveLength(2);
    expect(roundTripped.jobs.every((j) => Boolean(j.batchId))).toBe(true);

    // Existing project progress & schedule helpers continue cleanly
    const progressBefore = computeProjectPlateProgress(roundTripped.jobs, roundTripped.projects[0].id);
    const schedBefore = computeGlobalSchedule(roundTripped, 1700003000000);
    const summary = buildProjectProductionSummary({
      workspace: roundTripped,
      projectId: roundTripped.projects[0].id,
    });
    const progressAfter = computeProjectPlateProgress(roundTripped.jobs, roundTripped.projects[0].id);
    const schedAfter = computeGlobalSchedule(roundTripped, 1700003000000);

    expect(summary.totalBatches).toBe(2);
    expect(summary.completedBatchCount).toBe(2);
    expect(summary.totalCompletedUnits).toBe(67); // 12 Love + 30 A + 25 K
    expect(progressAfter).toEqual(progressBefore);
    expect(schedAfter.projectEtas).toEqual(schedBefore.projectEtas);
  });
});
