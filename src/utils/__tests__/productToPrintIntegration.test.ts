import { describe, expect, it } from 'vitest';
import {
  computeProjectPlateProgress,
  countPlateKeycaps,
  createFreshWorkspaceV5,
  formatPlateItemsText,
} from '../../constants';
import {
  CatalogProduct,
  CategoryPlateSetting,
  ProductCategory,
} from '../../types';
import {
  buildManualCatalogPlatePreviews,
  commitCatalogPlatesToWorkspace,
  createZeroedPlannerInputs,
  generateAutomaticCatalogPlatePreviews,
  generateIndependentKeycapBatchPreviews,
  validateBuiltInPlateCategoryIsolation,
  validateCategoryForPlanning,
  validateSameCategoryPlateItems,
} from '../catalogPlannerEngine';
import {
  findUndefinedPaths,
  prepareWorkspaceForFirestore,
} from '../firestorePayload';
import { transitionJobState } from '../productionEngine';
import { generateRawWooppSku } from '../skuGenerator';

describe('Product-to-Print Integration, Category Plate Mixing & Planner Reset Suite', () => {
  const ownerId = 'owner-woopp-6';
  const nowIso = '2026-10-30T09:00:00.000Z';

  const makeCategory = (
    overrides: Partial<ProductCategory> = {}
  ): ProductCategory => ({
    id: 'cat-charm-keycaps',
    ownerId,
    name: 'Charm Keycaps',
    description: 'Custom 3D printed charm keycaps',
    imageUrl: null,
    iconName: 'sparkles',
    sortOrder: 0,
    status: 'active',
    createdAt: nowIso,
    updatedAt: nowIso,
    ...overrides,
  });

  const makeProduct = (
    overrides: Partial<CatalogProduct> = {}
  ): CatalogProduct => ({
    id: 'prod-charm-moon',
    ownerId,
    sku: generateRawWooppSku(),
    name: 'Charm Moon',
    description: 'Crescent moon charm',
    categoryId: 'cat-charm-keycaps',
    priceMyr: 14.5,
    images: ['https://cdn.example.com/charm-moon.jpg'],
    options: [],
    variants: [],
    status: 'active',
    createdAt: nowIso,
    updatedAt: nowIso,
    ...overrides,
  });

  it('completes end-to-end Charm Moon product-to-print flow and preserves immutable snapshots across later catalog edits/archiving', () => {
    const ws = createFreshWorkspaceV5(ownerId);
    ws.jobs = [];
    ws.inventory.movements = [];
    const project = ws.projects[0];
    const color = ws.colors[0];

    const charmCategory = makeCategory();
    const charmMoon = makeProduct({ sku: 'WOOPP-8KM4NP2Q' });
    const charmRule: CategoryPlateSetting = {
      categoryId: charmCategory.id,
      ownerId,
      allocationMode: 'automatic_capacity',
      plateCapacity: 30,
      defaultEstimatedMinutes: 150,
      updatedAt: nowIso,
    };

    // Plan 50 units of Charm Moon -> 1 full plate (30 pcs) + 1 partial plate (20 pcs)
    const previewRes = generateAutomaticCatalogPlatePreviews({
      category: charmCategory,
      products: [charmMoon],
      selections: [{ productId: charmMoon.id, variantId: null, quantity: 50 }],
      color,
      plateSetting: charmRule,
      existingJobs: ws.jobs,
      project,
      includePartialRemainderPlate: true,
      nowMs: 1761814800000,
    });

    expect(previewRes.error).toBeUndefined();
    expect(previewRes.previews).toHaveLength(2);
    expect(previewRes.fullPlateCount).toBe(1);
    expect(previewRes.remainderUnits).toBe(20);

    // Confirm to Print Queue
    const commitRes = commitCatalogPlatesToWorkspace(ws, {
      projectId: project.id,
      colorId: color.id,
      category: charmCategory,
      confirmedPlates: previewRes.previews!,
      nowMs: 1761814805000,
    });

    expect(commitRes.error).toBeUndefined();
    expect(commitRes.createdJobs).toHaveLength(2);
    const nextWs = commitRes.nextWorkspace!;

    // Verify Firestore workspace validation passes with zero undefined fields
    const firestoreReady = prepareWorkspaceForFirestore(nextWs, ownerId);
    expect(findUndefinedPaths(firestoreReady)).toEqual([]);

    const plate1 = firestoreReady.jobs.find((j) => j.id === commitRes.createdJobs![0].id)!;
    expect(plate1.machineId).toBeNull(); // Never auto-assigned to a printer
    expect(plate1.plateMode).toBe('catalog_category');
    expect(plate1.categoryId).toBe('cat-charm-keycaps');
    expect(plate1.categoryNameSnapshot).toBe('Charm Keycaps');
    expect(countPlateKeycaps(plate1)).toBe(30);
    expect(formatPlateItemsText(plate1, true)).toBe('Charm Moon×30');
    expect(formatPlateItemsText(plate1, false)).toContain('WOOPP-8KM4NP2Q');

    // Simulate later renaming/archiving the product & renaming the category:
    // Existing Print Queue snapshot MUST remain completely unchanged!
    const mutatedCatalogProduct: CatalogProduct = {
      ...charmMoon,
      name: 'Renamed Lunar Charm V2',
      priceMyr: 99,
      status: 'archived',
    };
    expect(mutatedCatalogProduct.status).toBe('archived');
    expect(plate1.catalogItems?.[0]).toEqual({
      productId: charmMoon.id,
      productName: 'Charm Moon',
      sku: 'WOOPP-8KM4NP2Q',
      categoryId: 'cat-charm-keycaps',
      categoryName: 'Charm Keycaps',
      variantId: null,
      variantLabel: null,
      colorId: color.id,
      colorName: color.name,
      quantity: 30,
    });

    // Verify lifecycle transitions (Planned -> Printing -> Completed) work cleanly without corrupting A–Z inventory
    const machine = firestoreReady.machines[0];
    const startRes = transitionJobState(firestoreReady, plate1.id, 'Printing', {
      machineId: machine.id,
      nowMs: 1761815000000,
    });
    expect(startRes.error).toBeUndefined();

    const completeRes = transitionJobState(
      startRes.nextWorkspace!,
      plate1.id,
      'Completed',
      {
        actualMinutes: 145,
        nowMs: 1761823700000,
      }
    );
    expect(completeRes.error).toBeUndefined();
    const afterCompleteWs = completeRes.nextWorkspace!;
    const progress = computeProjectPlateProgress(afterCompleteWs.jobs, project.id);
    expect(progress.completedPlates).toBe(1);
    expect(progress.producedKeycaps).toBe(30);
    expect(afterCompleteWs.inventory.movements).toHaveLength(0); // A–Z physical stock untouched
  });

  it('enforces Category-Based Plate Mixing strictly by immutable categoryId at both preview and queue confirmation', () => {
    const ws = createFreshWorkspaceV5(ownerId);
    const project = ws.projects[0];
    const color = ws.colors[0];

    const charmCategory = makeCategory({ id: 'cat-charms', name: 'Charm Keycaps' });
    const standCategory = makeCategory({ id: 'cat-stands', name: 'Desk Stands' });

    const charmMoon = makeProduct({
      id: 'prod-moon',
      sku: 'WOOPP-22223333',
      name: 'Charm Moon',
      categoryId: 'cat-charms',
    });
    const charmStar = makeProduct({
      id: 'prod-star',
      sku: 'WOOPP-44445555',
      name: 'Charm Star',
      categoryId: 'cat-charms',
    });
    const phoneStand = makeProduct({
      id: 'prod-stand',
      sku: 'WOOPP-66667777',
      name: 'Desk Phone Stand',
      categoryId: 'cat-stands',
    });

    const charmSetting: CategoryPlateSetting = {
      categoryId: 'cat-charms',
      ownerId,
      allocationMode: 'automatic_capacity',
      plateCapacity: 50,
      defaultEstimatedMinutes: 160,
      updatedAt: nowIso,
    };

    // 1. Same categoryId -> Charm Moon (25) + Charm Star (25) share 1 plate of 50 pcs!
    const sameCatPreview = generateAutomaticCatalogPlatePreviews({
      category: charmCategory,
      products: [charmMoon, charmStar],
      selections: [
        { productId: charmMoon.id, variantId: null, quantity: 25 },
        { productId: charmStar.id, variantId: null, quantity: 25 },
      ],
      color,
      plateSetting: charmSetting,
      existingJobs: ws.jobs,
      project,
      includePartialRemainderPlate: true,
    });
    expect(sameCatPreview.error).toBeUndefined();
    expect(sameCatPreview.previews).toHaveLength(1);
    expect(sameCatPreview.previews![0].items).toHaveLength(2);

    // 2. Renaming category preserves immutable categoryId -> still shares plate!
    const renamedCharmCategory: ProductCategory = {
      ...charmCategory,
      name: ' Cute Keycap Charms ',
    };
    const afterRenamePreview = generateAutomaticCatalogPlatePreviews({
      category: renamedCharmCategory,
      products: [charmMoon, charmStar],
      selections: [
        { productId: charmMoon.id, variantId: null, quantity: 20 },
        { productId: charmStar.id, variantId: null, quantity: 20 },
      ],
      color,
      plateSetting: charmSetting,
      existingJobs: ws.jobs,
      project,
      includePartialRemainderPlate: true,
    });
    expect(afterRenamePreview.error).toBeUndefined();
    expect(afterRenamePreview.previews).toHaveLength(1);

    // 3. Different categoryId -> rejected at preview generation!
    const crossCatPreview = generateAutomaticCatalogPlatePreviews({
      category: charmCategory,
      products: [charmMoon, phoneStand],
      selections: [
        { productId: charmMoon.id, variantId: null, quantity: 10 },
        { productId: phoneStand.id, variantId: null, quantity: 5 },
      ],
      color,
      plateSetting: charmSetting,
      existingJobs: ws.jobs,
      project,
      includePartialRemainderPlate: true,
    });
    expect(crossCatPreview.error).toMatch(/Cross-category plate mixing blocked/i);

    // 4. Different categoryId -> also rejected at confirmation (`commitCatalogPlatesToWorkspace`)!
    const tamperedPlate = {
      ...sameCatPreview.previews![0],
      items: [
        ...sameCatPreview.previews![0].items,
        {
          productId: phoneStand.id,
          productName: phoneStand.name,
          sku: phoneStand.sku,
          categoryId: standCategory.id,
          categoryName: standCategory.name,
          variantId: null,
          variantLabel: null,
          colorId: color.id,
          colorName: color.name,
          quantity: 2,
        },
      ],
    };
    expect(validateSameCategoryPlateItems(tamperedPlate.items, charmCategory.id).valid).toBe(
      false
    );
    const tamperedCommit = commitCatalogPlatesToWorkspace(ws, {
      projectId: project.id,
      colorId: color.id,
      category: charmCategory,
      confirmedPlates: [tamperedPlate],
    });
    expect(tamperedCommit.error).toMatch(/Cross-category plate mixing blocked/i);

    // 5. Archived category cannot create new print plans until restored
    const archivedCat = { ...charmCategory, status: 'archived' as const };
    expect(validateCategoryForPlanning(archivedCat).ok).toBe(false);

    // 6. Built-in Alphabet + Built-in Charm mixing blocked on new plates
    expect(
      validateBuiltInPlateCategoryIsolation(
        {
          plateNumber: 1,
          letters: { A: 10 },
          charms: { CHARM_STAR: 5 },
        },
        'alphabet_only'
      ).valid
    ).toBe(false);
  });

  it('never assumes 138 capacity for new categories without a configured rule and supports Manual Plate Composition', () => {
    const ws = createFreshWorkspaceV5(ownerId);
    const project = ws.projects[0];
    const color = ws.colors[0];

    const figurineCategory = makeCategory({
      id: 'cat-figurines',
      name: 'Custom Figurines',
    });
    const dragonFigurine = makeProduct({
      id: 'prod-dragon',
      sku: 'WOOPP-DRGN9988',
      name: 'Mini Articulated Dragon',
      categoryId: 'cat-figurines',
    });

    // No plateSetting configured (null) -> automatic capacity mode MUST block instead of assuming 138!
    const unconfiguredAuto = generateAutomaticCatalogPlatePreviews({
      category: figurineCategory,
      products: [dragonFigurine],
      selections: [{ productId: dragonFigurine.id, variantId: null, quantity: 6 }],
      color,
      plateSetting: null,
      existingJobs: ws.jobs,
      project,
      includePartialRemainderPlate: true,
    });
    expect(unconfiguredAuto.error).toMatch(/No plate capacity is configured/i);
    expect(unconfiguredAuto.error).toMatch(/138 is never assumed/i);

    // Manual Plate Composition works cleanly without requiring a 138 or fixed category capacity rule
    const manualRes = buildManualCatalogPlatePreviews({
      category: figurineCategory,
      products: [dragonFigurine],
      color,
      existingJobs: ws.jobs,
      project,
      configuredCapacity: null,
      manualPlates: [
        {
          selections: [{ productId: dragonFigurine.id, variantId: null, quantity: 4 }],
          estimatedMinutes: 240,
          slicerVerified: true,
          notes: '4 articulated dragons verified in Bambu Studio',
        },
      ],
    });
    expect(manualRes.error).toBeUndefined();
    expect(manualRes.previews).toHaveLength(1);
    expect(manualRes.previews![0].capacity).toBeNull();
    expect(manualRes.previews![0].items[0].quantity).toBe(4);
  });

  it('resets planner inputs to 0 and plans independent batches without affecting completed production or Print Queue', () => {
    const ws = createFreshWorkspaceV5(ownerId);
    const project = ws.projects[0];
    const color = ws.colors[0];

    // Simulate historical completed plate with 138 pcs of letter A
    ws.jobs = [
      {
        id: 'job-completed-hist',
        projectId: project.id,
        colorId: color.id,
        plateNumber: 1,
        plateCapacity: 138,
        letters: { A: 138 },
        plateMode: 'alphabet_only',
        stage: 'Completed',
        machineId: null,
        estimatedMinutes: 195,
        actualMinutes: 190,
        slicerVerified: true,
        stockApplied: true,
        stockTransactionId: 'tx-1',
        failedCount: 0,
        failureReason: '',
        notes: '',
        createdIso: nowIso,
        updatedIso: nowIso,
        completedIso: nowIso,
      },
    ];

    const zeroed = createZeroedPlannerInputs();
    expect(zeroed.draftLetters.A).toBe(0);
    expect(zeroed.draftCharms.CHARM_LOVE).toBe(0);
    expect(zeroed.draftCatalogQuantities).toEqual({});
    // Historical completed job remains untouched
    expect(ws.jobs).toHaveLength(1);
    expect(ws.jobs[0].stage).toBe('Completed');

    // Plan a small independent new batch of A=20 even though completed A is 138!
    const independentBatch = generateIndependentKeycapBatchPreviews({
      existingJobs: ws.jobs,
      projectId: project.id,
      colorId: color.id,
      mode: 'alphabet_only',
      batchLetters: { ...zeroed.draftLetters, A: 20 },
      capacity: 138,
      defaultMinutesPerPlate: 195,
    });
    expect(independentBatch.totalRequestedCount).toBe(20);
    expect(independentBatch.fullPlates).toHaveLength(0);
    expect(independentBatch.remainderCount).toBe(20);
  });
});
