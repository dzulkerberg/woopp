import { describe, expect, it } from 'vitest';
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
  commitCatalogPlatesToWorkspace,
  generateAutomaticCatalogPlatePreviews,
  matchWorkspaceColorForVariant,
  resolveCatalogSnapshotsFromSelections,
} from '../catalogPlannerEngine';
import { prepareWorkspaceForFirestore } from '../firestorePayload';
import { filterQueueJobs } from '../productionEngine';

describe('WOOPP 6.0 — Print Queue Plate Color Mapping & Multi-Color Planning', () => {
  const ownerId = 'usr-print-planner-test';
  const nowMs = 1762000000000;
  const nowIso = new Date(nowMs).toISOString();

  // Test project: "Mydin Ecah"
  const project: ProductionProject = {
    id: 'proj-mydin-ecah',
    name: 'Mydin Ecah',
    productType: 'Keycaps',
    salesChannel: 'Corporate/Event',
    priority: 'Normal',
    status: 'Active',
    deadline: '2026-12-31',
    plateCapacity: 50,
    notes: 'Test project for multi-color print plates',
    assignedColorIds: ['color-mulberry'],
    targetsByColor: {},
    carryForwardByColor: {},
    allocatedStockByColor: {},
    createdIso: nowIso,
    updatedIso: nowIso,
  };

  // 4 distinct filament colors in workspace
  const workspaceColors: ColorOption[] = [
    { id: 'color-mulberry', name: 'Mulberry', hex: '#581845' },
    { id: 'color-pink', name: 'Pink', hex: '#FF69B4' },
    { id: 'color-cyan', name: 'Cyan', hex: '#00FFFF' },
    { id: 'color-black', name: 'Black', hex: '#000000' },
  ];

  const category: ProductCategory = {
    id: 'cat-keycaps-base',
    ownerId,
    name: 'Base Keycaps',
    description: 'Custom keycaps with variation colors',
    imageUrl: null,
    iconName: 'layers',
    sortOrder: 1,
    status: 'active',
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  // Product "Base V1" with 4 color options
  const productBaseV1: CatalogProduct = {
    id: 'prod-base-v1',
    ownerId,
    sku: 'WOOPP-BASEV101',
    name: 'Base V1',
    description: 'Base keycap variation with 4 colors',
    categoryId: category.id,
    priceMyr: 15.0,
    images: ['https://example.com/base-v1.png'],
    options: [
      {
        id: 'opt-color',
        name: 'Color',
        values: ['Pink', 'Mulberry', 'Cyan', 'Black'],
        sortOrder: 1,
      },
    ],
    variants: [
      {
        id: 'var-pink',
        label: 'Pink',
        optionValues: { Color: 'Pink' },
        priceMyr: 15.0,
        imageUrl: null,
        sortOrder: 1,
      },
      {
        id: 'var-mulberry',
        label: 'Mulberry',
        optionValues: { Color: 'Mulberry' },
        priceMyr: 15.0,
        imageUrl: null,
        sortOrder: 2,
      },
      {
        id: 'var-cyan',
        label: 'Cyan',
        optionValues: { Color: 'Cyan' },
        priceMyr: 15.0,
        imageUrl: null,
        sortOrder: 3,
      },
      {
        id: 'var-black',
        label: 'Black',
        optionValues: { Color: 'Black' },
        priceMyr: 15.0,
        imageUrl: null,
        sortOrder: 4,
      },
    ],
    status: 'active',
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const plateSetting: CategoryPlateSetting = {
    categoryId: category.id,
    ownerId,
    allocationMode: 'automatic_capacity',
    plateCapacity: 20,
    defaultEstimatedMinutes: 120,
    updatedAt: nowIso,
  };

  const baseWorkspace: ProductionWorkspaceV5 = {
    schemaVersion: 5,
    ownerId,
    migratedFromV1: false,
    colors: workspaceColors,
    machines: [],
    projects: [project],
    jobs: [],
    presets: [],
    inventory: {
      physicalByColor: {},
      wastageByColor: {},
      movements: [],
    },
    log: [],
    settings: {
      defaultPlateCapacity: 50,
      defaultProductType: 'Keycaps',
      theme: 'dark',
    },
    updatedIso: nowIso,
  };

  it('1. matchWorkspaceColorForVariant dynamically resolves color names without hardcoding', () => {
    // Exact option value match
    const pinkMatch = matchWorkspaceColorForVariant(
      { label: 'Pink', optionValues: { Color: 'Pink' } },
      workspaceColors
    );
    expect(pinkMatch?.id).toBe('color-pink');
    expect(pinkMatch?.name).toBe('Pink');

    // Case-insensitive compound label match: "Base V1 · Mulberry"
    const mulberryMatch = matchWorkspaceColorForVariant(
      { label: 'Base V1 · Mulberry', optionValues: {} },
      workspaceColors
    );
    expect(mulberryMatch?.id).toBe('color-mulberry');

    // Custom user-created color: "Sunset Orange"
    const customColors: ColorOption[] = [
      { id: 'color-custom-sunset', name: 'Sunset Orange', hex: '#FF4500' },
    ];
    const customMatch = matchWorkspaceColorForVariant(
      { label: 'Sunset Orange Glossy', optionValues: { Finish: 'Sunset Orange' } },
      customColors
    );
    expect(customMatch?.id).toBe('color-custom-sunset');
  });

  it('2. resolveCatalogSnapshotsFromSelections maps each variation to its matching workspace color', () => {
    const selections = [
      { productId: productBaseV1.id, variantId: 'var-pink', quantity: 20 },
      { productId: productBaseV1.id, variantId: 'var-mulberry', quantity: 20 },
      { productId: productBaseV1.id, variantId: 'var-cyan', quantity: 20 },
      { productId: productBaseV1.id, variantId: 'var-black', quantity: 20 },
    ];

    const result = resolveCatalogSnapshotsFromSelections({
      category,
      products: [productBaseV1],
      selections,
      color: workspaceColors[0], // Mulberry was selected in top bar
      workspaceColors,
    });

    expect(result.error).toBeUndefined();
    expect(result.snapshots).toHaveLength(4);

    const pinkSnap = result.snapshots!.find((s) => s.variantId === 'var-pink')!;
    expect(pinkSnap.colorId).toBe('color-pink');
    expect(pinkSnap.colorName).toBe('Pink');
    expect(pinkSnap.variantLabel).toBe('Pink');

    const mulberrySnap = result.snapshots!.find((s) => s.variantId === 'var-mulberry')!;
    expect(mulberrySnap.colorId).toBe('color-mulberry');
    expect(mulberrySnap.colorName).toBe('Mulberry');

    const cyanSnap = result.snapshots!.find((s) => s.variantId === 'var-cyan')!;
    expect(cyanSnap.colorId).toBe('color-cyan');

    const blackSnap = result.snapshots!.find((s) => s.variantId === 'var-black')!;
    expect(blackSnap.colorId).toBe('color-black');
  });

  it('3. generateAutomaticCatalogPlatePreviews generates 4 plates for 4 colors with distinct authoritative colorId on each plate preview', () => {
    const selections = [
      { productId: productBaseV1.id, variantId: 'var-pink', quantity: 20 },
      { productId: productBaseV1.id, variantId: 'var-mulberry', quantity: 20 },
      { productId: productBaseV1.id, variantId: 'var-cyan', quantity: 20 },
      { productId: productBaseV1.id, variantId: 'var-black', quantity: 20 },
    ];

    const genResult = generateAutomaticCatalogPlatePreviews({
      existingJobs: [],
      project,
      color: workspaceColors[0], // Active planner context color is Mulberry
      workspaceColors,
      category,
      products: [productBaseV1],
      selections,
      plateSetting,
      nowMs,
    });

    expect(genResult.error).toBeUndefined();
    expect(genResult.previews).toHaveLength(4);
    expect(genResult.totalUnits).toBe(80);

    const previews = genResult.previews!;
    // Plates must have distinct colors: Pink, Mulberry, Cyan, Black
    const assignedColors = previews.map((p) => p.colorName);
    expect(assignedColors).toContain('Pink');
    expect(assignedColors).toContain('Mulberry');
    expect(assignedColors).toContain('Cyan');
    expect(assignedColors).toContain('Black');

    // The Pink plate contains Pink items and has colorId: 'color-pink'
    const pinkPlate = previews.find((p) => p.colorId === 'color-pink')!;
    expect(pinkPlate.items).toHaveLength(1);
    expect(pinkPlate.items[0].variantLabel).toBe('Pink');
    expect(pinkPlate.items[0].quantity).toBe(20);
    // Crucially, it must NOT have 'color-mulberry'!
    expect(pinkPlate.colorId).not.toBe('color-mulberry');
  });

  it('4. commitCatalogPlatesToWorkspace persists correct authoritative colorId on each ProductionJob into Firestore', () => {
    const selections = [
      { productId: productBaseV1.id, variantId: 'var-pink', quantity: 20 },
      { productId: productBaseV1.id, variantId: 'var-mulberry', quantity: 20 },
      { productId: productBaseV1.id, variantId: 'var-cyan', quantity: 20 },
      { productId: productBaseV1.id, variantId: 'var-black', quantity: 20 },
    ];

    const genResult = generateAutomaticCatalogPlatePreviews({
      existingJobs: [],
      project,
      color: workspaceColors[0],
      workspaceColors,
      category,
      products: [productBaseV1],
      selections,
      plateSetting,
      nowMs,
    });

    const commitResult = commitCatalogPlatesToWorkspace(baseWorkspace, {
      projectId: project.id,
      colorId: workspaceColors[0].id,
      category,
      confirmedPlates: genResult.previews!,
      nowMs,
    });

    expect(commitResult.error).toBeUndefined();
    expect(commitResult.createdJobs).toHaveLength(4);

    const createdJobs = commitResult.createdJobs!;
    const pinkJob = createdJobs.find((j) => j.colorId === 'color-pink')!;
    expect(pinkJob).toBeDefined();
    expect(pinkJob.projectId).toBe('proj-mydin-ecah');
    expect(pinkJob.catalogItems?.[0].productName).toBe('Base V1');
    expect(pinkJob.catalogItems?.[0].variantLabel).toBe('Pink');
    expect(pinkJob.catalogItems?.[0].quantity).toBe(20);
    expect(pinkJob.catalogItems?.[0].colorId).toBe('color-pink');

    // Check project assignedColorIds has recorded all 4 colors
    const updatedProject = commitResult.nextWorkspace!.projects.find(
      (p) => p.id === project.id
    )!;
    expect(updatedProject.assignedColorIds).toEqual(
      expect.arrayContaining(['color-mulberry', 'color-pink', 'color-cyan', 'color-black'])
    );

    // Verify Firestore workspace sanitization succeeds with zero schema errors
    const firestorePayload = prepareWorkspaceForFirestore(
      commitResult.nextWorkspace!,
      ownerId
    );
    expect(firestorePayload.jobs).toHaveLength(4);
    const firestorePinkJob = firestorePayload.jobs.find(
      (j) => j.colorId === 'color-pink'
    )!;
    expect(firestorePinkJob.colorId).toBe('color-pink');
  });

  it('5. Unassigned plate color shows accurate unassigned state rather than a stale project color', () => {
    const unassignedJob: ProductionJob = {
      id: 'job-unassigned-test',
      projectId: 'proj-mydin-ecah',
      colorId: 'unassigned',
      plateNumber: 5,
      plateCapacity: 50,
      letters: {},
      plateMode: 'catalog_category',
      categoryId: category.id,
      categoryNameSnapshot: category.name,
      catalogItems: [
        {
          productId: productBaseV1.id,
          productName: 'Base V1',
          sku: productBaseV1.sku,
          categoryId: category.id,
          categoryName: category.name,
          variantId: null,
          variantLabel: 'Custom',
          colorId: 'unassigned',
          colorName: 'Unassigned Color',
          quantity: 10,
        },
      ],
      stage: 'Planned',
      machineId: null,
      estimatedMinutes: 60,
      actualMinutes: 0,
      slicerVerified: false,
      stockApplied: false,
      stockTransactionId: null,
      failedCount: 0,
      failureReason: '',
      notes: '',
      createdIso: nowIso,
      updatedIso: nowIso,
      completedIso: null,
    };

    // Filter queue by UNASSIGNED
    const unassignedFiltered = filterQueueJobs([unassignedJob], {
      tab: 'active',
      projectId: 'ALL',
      colorId: 'UNASSIGNED',
      machineId: 'ALL',
      status: 'ALL',
    });
    expect(unassignedFiltered).toHaveLength(1);
    expect(unassignedFiltered[0].colorId).toBe('unassigned');

    // Looking up in workspace colors returns undefined -> triggers "Unassigned Color" badge
    const matchedColor = workspaceColors.find((c) => c.id === unassignedJob.colorId);
    expect(matchedColor).toBeUndefined();
  });
});
