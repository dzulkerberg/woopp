import { describe, expect, it } from 'vitest';
import {
  ABC,
  countCatalogItems,
  emptyAlphabetMap,
} from '../../constants';
import {
  CatalogProduct,
  CategoryPlateSetting,
  ColorOption,
  ProductCategory,
  ProductionWorkspaceV5,
} from '../../types';
import {
  commitCatalogPlatesToWorkspace,
  createZeroedPlannerInputs,
  generateAutomaticCatalogPlatePreviews,
  getPlannableProductItems,
  isAlphabetProductItems,
  resolveCatalogSnapshotsFromSelections,
} from '../catalogPlannerEngine';

describe('WOOPP Products 6.0 — Per-Option Quantity Planner & Scalable Options', () => {
  const dummyColor: ColorOption = {
    id: 'col-black',
    name: 'Black',
    hex: '#000000',
  };

  const dummyCategory: ProductCategory = {
    id: 'cat-keycaps',
    ownerId: 'user-1',
    name: 'Keycaps',
    description: 'Custom keycaps',
    imageUrl: null,
    iconName: 'sparkles',
    sortOrder: 1,
    status: 'active',
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
  };

  const dummyAlphabetProduct: CatalogProduct = {
    id: 'prod-keycap-letter',
    ownerId: 'user-1',
    sku: 'KEY-AZ-01',
    name: 'Keycap Letter',
    description: 'Letter keycaps A to Z',
    categoryId: dummyCategory.id,
    images: ['https://storage.googleapis.com/test/a.png'],
    priceMyr: 4.5,
    options: [
      {
        id: 'opt-letter',
        name: 'Letter',
        values: [...ABC], // 26 letters A–Z
        sortOrder: 0,
      },
    ],
    variants: [], // Empty parent array (scalable storage pattern)
    status: 'active',
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
  };

  const dummyColorsProduct: CatalogProduct = {
    id: 'prod-base-v1',
    ownerId: 'user-1',
    sku: 'BASE-V1',
    name: 'Base V1',
    description: 'Keyboard base in multiple colors',
    categoryId: dummyCategory.id,
    images: ['https://storage.googleapis.com/test/base.png'],
    priceMyr: 12.0,
    options: [
      {
        id: 'opt-color',
        name: 'Color',
        values: ['Pink', 'Blue', 'Yellow', 'Lightskin', 'Purple', 'Black'],
        sortOrder: 0,
      },
    ],
    variants: [],
    status: 'active',
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
  };

  const dummyMultiGroupProduct: CatalogProduct = {
    id: 'prod-custom-keycap',
    ownerId: 'user-1',
    sku: 'CUST-KEY-01',
    name: 'Custom Charm Keycap',
    description: 'Charm keycap with design and finish',
    categoryId: dummyCategory.id,
    images: ['https://storage.googleapis.com/test/charm.png'],
    priceMyr: 8.5,
    options: [
      {
        id: 'opt-charm',
        name: 'Design',
        values: ['Love', 'Star', 'Flower'],
        sortOrder: 0,
      },
      {
        id: 'opt-finish',
        name: 'Finish',
        values: ['Matte', 'Glossy'],
        sortOrder: 1,
      },
    ],
    variants: [],
    status: 'active',
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
  };

  it('1. Derives all 26 plannable letter items dynamically even when variants array is empty in parent doc', () => {
    const items = getPlannableProductItems(dummyAlphabetProduct);
    expect(items).toHaveLength(26);
    expect(items.map((it) => it.label)).toEqual(ABC);
    expect(isAlphabetProductItems(items)).toBe(true);
  });

  it('2. Correctly detects non-alphabet word-based options (Base V1 colors)', () => {
    const items = getPlannableProductItems(dummyColorsProduct);
    expect(items).toHaveLength(6);
    expect(items.map((it) => it.label)).toEqual([
      'Pink',
      'Blue',
      'Yellow',
      'Lightskin',
      'Purple',
      'Black',
    ]);
    expect(isAlphabetProductItems(items)).toBe(false);
  });

  it('3. Generates plannable combinations for multi-group options (Charm Design + Finish)', () => {
    const items = getPlannableProductItems(dummyMultiGroupProduct);
    expect(items).toHaveLength(6); // 3 designs * 2 finishes
    expect(items[0].optionValues).toHaveProperty('Design');
    expect(items[0].optionValues).toHaveProperty('Finish');
  });

  it('4. Automatically calculates total from individual option quantities (e.g. A=50, B=30, C=20 -> 100 pcs)', () => {
    const items = getPlannableProductItems(dummyAlphabetProduct);
    const itemA = items.find((i) => i.label === 'A')!;
    const itemB = items.find((i) => i.label === 'B')!;
    const itemC = items.find((i) => i.label === 'C')!;

    const selections = [
      { productId: dummyAlphabetProduct.id, variantId: itemA.id, quantity: 50 },
      { productId: dummyAlphabetProduct.id, variantId: itemB.id, quantity: 30 },
      { productId: dummyAlphabetProduct.id, variantId: itemC.id, quantity: 20 },
    ];

    const resolved = resolveCatalogSnapshotsFromSelections({
      category: dummyCategory,
      products: [dummyAlphabetProduct],
      selections,
      color: dummyColor,
    });

    expect(resolved.error).toBeUndefined();
    expect(resolved.snapshots).toBeDefined();
    expect(resolved.snapshots).toHaveLength(3);
    const totalPcs = countCatalogItems(resolved.snapshots!);
    expect(totalPcs).toBe(100);

    const snapA = resolved.snapshots!.find((s) => s.variantLabel === 'A');
    const snapB = resolved.snapshots!.find((s) => s.variantLabel === 'B');
    const snapC = resolved.snapshots!.find((s) => s.variantLabel === 'C');
    expect(snapA?.quantity).toBe(50);
    expect(snapB?.quantity).toBe(30);
    expect(snapC?.quantity).toBe(20);
  });

  it('5. Reset helper creates zeroed draft inputs without mutating historical records', () => {
    const zeroed = createZeroedPlannerInputs();
    expect(zeroed.draftCatalogQuantities).toEqual({});
    expect(zeroed.draftLetters).toEqual(emptyAlphabetMap());
  });

  it('6. Splits plates up to category plateCapacity and preserves exact item breakdown without extra invented units', () => {
    const items = getPlannableProductItems(dummyAlphabetProduct);
    const itemA = items.find((i) => i.label === 'A')!;
    const itemB = items.find((i) => i.label === 'B')!;

    // Total 100 units, capacity 50 -> exactly 2 plates of 50
    const selections = [
      { productId: dummyAlphabetProduct.id, variantId: itemA.id, quantity: 70 },
      { productId: dummyAlphabetProduct.id, variantId: itemB.id, quantity: 30 },
    ];

    const plateSetting: Pick<CategoryPlateSetting, 'allocationMode' | 'plateCapacity' | 'defaultEstimatedMinutes'> = {
      allocationMode: 'automatic_capacity',
      plateCapacity: 50,
      defaultEstimatedMinutes: 180,
    };

    const result = generateAutomaticCatalogPlatePreviews({
      existingJobs: [],
      project: {
        id: 'proj-1',
        name: 'Online Orders',
        salesChannel: 'Klebang Walk',
        priority: 'Normal',
        deadline: '2026-05-01',
        productType: 'Keycap Letter',
        plateCapacity: 50,
        assignedColorIds: [dummyColor.id],
        targetsByColor: {},
        carryForwardByColor: {},
        allocatedStockByColor: {},
        status: 'Active',
        notes: '',
        createdIso: '2026-04-01T00:00:00.000Z',
        updatedIso: '2026-04-01T00:00:00.000Z',
      },
      color: dummyColor,
      category: dummyCategory,
      products: [dummyAlphabetProduct],
      selections,
      plateSetting,
      includePartialRemainderPlate: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.previews).toHaveLength(2);
    expect(result.totalUnits).toBe(100);

    const plate1Units = countCatalogItems(result.previews![0].items);
    const plate2Units = countCatalogItems(result.previews![1].items);
    expect(plate1Units).toBe(50);
    expect(plate2Units).toBe(50);

    // Sum of items matches original request exactly (70 + 30 = 100)
    const totalA = result.previews!.flatMap((p) => p.items)
      .filter((it) => it.variantLabel === 'A')
      .reduce((sum, it) => sum + it.quantity, 0);
    const totalB = result.previews!.flatMap((p) => p.items)
      .filter((it) => it.variantLabel === 'B')
      .reduce((sum, it) => sum + it.quantity, 0);

    expect(totalA).toBe(70);
    expect(totalB).toBe(30);
  });

  it('7. Commits confirmed plates to workspace with exact snapshots and companion letters map', () => {
    const items = getPlannableProductItems(dummyAlphabetProduct);
    const itemA = items.find((i) => i.label === 'A')!;

    const stagedPlate = {
      tempId: 'draft-plate-1',
      plateNumber: 1,
      categoryId: dummyCategory.id,
      categoryName: dummyCategory.name,
      capacity: 50,
      items: [
        {
          productId: dummyAlphabetProduct.id,
          productName: dummyAlphabetProduct.name,
          sku: dummyAlphabetProduct.sku,
          categoryId: dummyCategory.id,
          categoryName: dummyCategory.name,
          variantId: itemA.id,
          variantLabel: 'A',
          colorId: dummyColor.id,
          colorName: dummyColor.name,
          quantity: 25,
        },
      ],
      estimatedMinutes: 180,
      slicerVerified: true,
      notes: 'Plate 1',
    };

    const initialWorkspace: ProductionWorkspaceV5 = {
      schemaVersion: 5,
      ownerId: 'user-1',
      migratedFromV1: false,
      colors: [dummyColor],
      machines: [],
      projects: [
        {
          id: 'proj-1',
          name: 'Online Orders',
          salesChannel: 'Klebang Walk',
          priority: 'Normal',
          deadline: '2026-05-01',
          productType: 'Keycap Letter',
          plateCapacity: 50,
          assignedColorIds: [dummyColor.id],
          targetsByColor: {},
          carryForwardByColor: {},
          allocatedStockByColor: {},
          status: 'Active',
          notes: '',
          createdIso: '2026-04-01T00:00:00.000Z',
          updatedIso: '2026-04-01T00:00:00.000Z',
        },
      ],
      jobs: [],
      presets: [],
      inventory: { physicalByColor: {}, wastageByColor: {}, movements: [] },
      log: [],
      settings: { defaultPlateCapacity: 50, defaultProductType: 'Keycap', theme: 'light' },
      updatedIso: '2026-04-01T00:00:00.000Z',
    };

    const committed = commitCatalogPlatesToWorkspace(initialWorkspace, {
      projectId: 'proj-1',
      colorId: dummyColor.id,
      category: dummyCategory,
      confirmedPlates: [stagedPlate],
    });

    expect(committed.error).toBeUndefined();
    expect(committed.createdJobs).toHaveLength(1);

    const job = committed.createdJobs![0];
    expect(job.catalogItems).toHaveLength(1);
    expect(job.catalogItems![0].productName).toBe('Keycap Letter');
    expect(job.catalogItems![0].variantLabel).toBe('A');
    expect(job.catalogItems![0].quantity).toBe(25);
    // Companion letters map populated for A–Z
    expect(job.letters).toEqual({ A: 25 });
    expect(job.stage).toBe('Ready to Print'); // Because slicerVerified was true
    expect(job.machineId).toBeNull(); // Never auto-assigned
  });

  it('8. Supports long option labels, varying option numbers, and handles 4-digit quantities cleanly in snapshot resolutions', () => {
    const longLabelsProduct: CatalogProduct = {
      id: 'prod-special-edition',
      ownerId: 'user-1',
      sku: 'SPEC-ED-01',
      name: 'Artisan Switch Collection Special Edition',
      description: 'Long labels with custom switches',
      categoryId: dummyCategory.id,
      images: ['https://storage.googleapis.com/test/switch.png'],
      priceMyr: 25.0,
      options: [
        {
          id: 'opt-switch',
          name: 'Switch Type & Actuation Force',
          values: [
            'Gateron Oil King Linear 55g Heavy Lubricated',
            'KTT Strawberry Tactile 45g Ultra Smooth',
            'TTC Silent Bluish White Muted Bump 42g',
          ],
          sortOrder: 0,
        },
      ],
      variants: [],
      status: 'active',
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
    };

    const items = getPlannableProductItems(longLabelsProduct);
    expect(items).toHaveLength(3);
    expect(items[0].label).toBe('Gateron Oil King Linear 55g Heavy Lubricated');
    expect(items[1].label).toBe('KTT Strawberry Tactile 45g Ultra Smooth');
    expect(items[2].label).toBe('TTC Silent Bluish White Muted Bump 42g');
    expect(isAlphabetProductItems(items)).toBe(false);

    // Test 4-digit quantities (e.g. 1500 pcs, 2500 pcs)
    const selections = [
      { productId: longLabelsProduct.id, variantId: items[0].id, quantity: 1500 },
      { productId: longLabelsProduct.id, variantId: items[1].id, quantity: 2500 },
    ];

    const resolved = resolveCatalogSnapshotsFromSelections({
      category: dummyCategory,
      products: [longLabelsProduct],
      selections,
      color: dummyColor,
    });

    expect(resolved.error).toBeUndefined();
    expect(resolved.snapshots).toHaveLength(2);
    expect(countCatalogItems(resolved.snapshots!)).toBe(4000);
    expect(resolved.snapshots![0].quantity).toBe(1500);
    expect(resolved.snapshots![0].variantLabel).toBe('Gateron Oil King Linear 55g Heavy Lubricated');
    expect(resolved.snapshots![1].quantity).toBe(2500);
  });
});

