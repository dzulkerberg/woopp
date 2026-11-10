import { describe, expect, it } from 'vitest';
import {
  CatalogProduct,
  CategoryPlateSetting,
  ColorOption,
  JobCatalogItemSnapshot,
  ProductCategory,
  ProductionProject,
  ProductionWorkspaceV5,
} from '../../types';
import {
  buildCatalogSelectionKey,
  commitCatalogPlatesToWorkspace,
  generateAutomaticCatalogPlatePreviews,
  getPlannableItemsForSelectedFilamentColor,
  parseCatalogSelectionKey,
  validateStrictSingleProductPlateItems,
} from '../catalogPlannerEngine';
import { prepareWorkspaceForFirestore } from '../firestorePayload';

describe('WOOPP 6.0 — Auto Plate Planner Simplification & Strict Plate Isolation', () => {
  const nowIso = '2026-11-10T00:00:00.000Z';
  const ownerId = 'usr-test-planner-strict';

  const workspaceColors: ColorOption[] = [
    { id: 'col-pink', name: 'Pink', hex: '#FF69B4' },
    { id: 'col-blue', name: 'Blue', hex: '#1E90FF' },
    { id: 'col-purple', name: 'Purple', hex: '#800080' },
    { id: 'col-mulberry', name: 'Mulberry', hex: '#C54B8C' },
    { id: 'col-black', name: 'Black', hex: '#000000' },
  ];

  const categoryKeycaps: ProductCategory = {
    id: 'cat-keycaps',
    ownerId,
    name: 'Keycaps',
    description: 'Custom 3D printed keycaps',
    imageUrl: null,
    iconName: 'sparkles',
    sortOrder: 1,
    status: 'active',
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const project: ProductionProject = {
    id: 'proj-orders-1',
    name: 'Bulk Production 2026',
    salesChannel: 'Corporate/Event',
    priority: 'Normal',
    status: 'Active',
    deadline: '2026-12-31',
    productType: 'Keycaps',
    plateCapacity: 138,
    assignedColorIds: ['col-pink'],
    targetsByColor: {},
    carryForwardByColor: {},
    allocatedStockByColor: {},
    notes: '',
    createdIso: nowIso,
    updatedIso: nowIso,
  };

  // Product 1: Keycap Letter (has 26 alphabet options A–Z, NO color option)
  const productKeycapLetter: CatalogProduct = {
    id: 'prod-keycap-letter',
    ownerId,
    sku: 'WOOPP-KEYLETTER',
    name: 'Keycap Letter',
    description: 'Alphabet keycaps A through Z',
    categoryId: categoryKeycaps.id,
    priceMyr: 5.0,
    images: ['https://storage.googleapis.com/test/letter.png'],
    options: [
      {
        id: 'opt-letter',
        name: 'Letter',
        values: ['A', 'B', 'C', 'D', 'E'],
        sortOrder: 1,
      },
    ],
    variants: [
      { id: 'var-a', label: 'A', optionValues: { Letter: 'A' }, priceMyr: 5.0, imageUrl: null, sortOrder: 1 },
      { id: 'var-b', label: 'B', optionValues: { Letter: 'B' }, priceMyr: 5.0, imageUrl: null, sortOrder: 2 },
      { id: 'var-c', label: 'C', optionValues: { Letter: 'C' }, priceMyr: 5.0, imageUrl: null, sortOrder: 3 },
    ],
    status: 'active',
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  // Product 2: Clicker Base (has Color options: Pink, Blue, Purple, Mulberry)
  const productClickerBase: CatalogProduct = {
    id: 'prod-clicker-base',
    ownerId,
    sku: 'WOOPP-CLICKBASE',
    name: 'Clicker Base',
    description: 'Mechanical clicker base with physical color variations',
    categoryId: categoryKeycaps.id,
    priceMyr: 12.0,
    images: ['https://storage.googleapis.com/test/base.png'],
    options: [
      {
        id: 'opt-color',
        name: 'Color',
        values: ['Pink', 'Blue', 'Purple', 'Mulberry'],
        sortOrder: 1,
      },
    ],
    variants: [
      { id: 'var-pink', label: 'Pink', optionValues: { Color: 'Pink' }, priceMyr: 12.0, imageUrl: null, sortOrder: 1 },
      { id: 'var-blue', label: 'Blue', optionValues: { Color: 'Blue' }, priceMyr: 12.0, imageUrl: null, sortOrder: 2 },
      { id: 'var-purple', label: 'Purple', optionValues: { Color: 'Purple' }, priceMyr: 12.0, imageUrl: null, sortOrder: 3 },
      { id: 'var-mulberry', label: 'Mulberry', optionValues: { Color: 'Mulberry' }, priceMyr: 12.0, imageUrl: null, sortOrder: 4 },
    ],
    status: 'active',
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  // Product 3: Multi-option product (Color + Design)
  const productCharmKeycap: CatalogProduct = {
    id: 'prod-charm-keycap',
    ownerId,
    sku: 'WOOPP-CHARM',
    name: 'Charm Keycap',
    description: 'Charm keycap with color and design options',
    categoryId: categoryKeycaps.id,
    priceMyr: 8.0,
    images: ['https://storage.googleapis.com/test/charm.png'],
    options: [
      {
        id: 'opt-col',
        name: 'Color',
        values: ['Pink', 'Blue'],
        sortOrder: 1,
      },
      {
        id: 'opt-design',
        name: 'Design',
        values: ['Heart', 'Star'],
        sortOrder: 2,
      },
    ],
    variants: [
      { id: 'var-p-heart', label: 'Pink · Heart', optionValues: { Color: 'Pink', Design: 'Heart' }, priceMyr: 8.0, imageUrl: null, sortOrder: 1 },
      { id: 'var-p-star', label: 'Pink · Star', optionValues: { Color: 'Pink', Design: 'Star' }, priceMyr: 8.0, imageUrl: null, sortOrder: 2 },
      { id: 'var-b-heart', label: 'Blue · Heart', optionValues: { Color: 'Blue', Design: 'Heart' }, priceMyr: 8.0, imageUrl: null, sortOrder: 3 },
      { id: 'var-b-star', label: 'Blue · Star', optionValues: { Color: 'Blue', Design: 'Star' }, priceMyr: 8.0, imageUrl: null, sortOrder: 4 },
    ],
    status: 'active',
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const plateSetting: CategoryPlateSetting = {
    categoryId: categoryKeycaps.id,
    ownerId,
    allocationMode: 'automatic_capacity',
    plateCapacity: 138,
    defaultEstimatedMinutes: 195,
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
      defaultPlateCapacity: 138,
      defaultProductType: 'Keycaps',
      theme: 'dark',
    },
    updatedIso: nowIso,
  };

  it('1. validateStrictSingleProductPlateItems enforces ONE PLATE = ONE PRODUCT ID', () => {
    // Valid: Variations of the SAME product
    const validSameProductItems: JobCatalogItemSnapshot[] = [
      {
        productId: productKeycapLetter.id,
        productName: productKeycapLetter.name,
        sku: productKeycapLetter.sku,
        categoryId: categoryKeycaps.id,
        categoryName: categoryKeycaps.name,
        variantId: 'var-a',
        variantLabel: 'A',
        colorId: 'col-pink',
        colorName: 'Pink',
        quantity: 60,
      },
      {
        productId: productKeycapLetter.id,
        productName: productKeycapLetter.name,
        sku: productKeycapLetter.sku,
        categoryId: categoryKeycaps.id,
        categoryName: categoryKeycaps.name,
        variantId: 'var-b',
        variantLabel: 'B',
        colorId: 'col-pink',
        colorName: 'Pink',
        quantity: 50,
      },
    ];
    const checkValid = validateStrictSingleProductPlateItems(
      validSameProductItems,
      productKeycapLetter.id,
      'col-pink',
      categoryKeycaps.id
    );
    expect(checkValid.valid).toBe(true);
    expect(checkValid.resolvedProductId).toBe(productKeycapLetter.id);

    // Invalid: Multiple different product IDs mixed onto the same plate
    const mixedProductItems: JobCatalogItemSnapshot[] = [
      ...validSameProductItems,
      {
        productId: productClickerBase.id,
        productName: productClickerBase.name,
        sku: productClickerBase.sku,
        categoryId: categoryKeycaps.id,
        categoryName: categoryKeycaps.name,
        variantId: 'var-pink',
        variantLabel: 'Pink',
        colorId: 'col-pink',
        colorName: 'Pink',
        quantity: 20,
      },
    ];
    const checkMixed = validateStrictSingleProductPlateItems(mixedProductItems);
    expect(checkMixed.valid).toBe(false);
    expect(checkMixed.error).toMatch(/Product mixing blocked/i);

    // Invalid: Conflicting physical colors on the same plate
    const conflictingColorItems: JobCatalogItemSnapshot[] = [
      {
        productId: productClickerBase.id,
        productName: productClickerBase.name,
        sku: productClickerBase.sku,
        categoryId: categoryKeycaps.id,
        categoryName: categoryKeycaps.name,
        variantId: 'var-pink',
        variantLabel: 'Pink',
        colorId: 'col-pink',
        colorName: 'Pink',
        quantity: 30,
      },
      {
        productId: productClickerBase.id,
        productName: productClickerBase.name,
        sku: productClickerBase.sku,
        categoryId: categoryKeycaps.id,
        categoryName: categoryKeycaps.name,
        variantId: 'var-blue',
        variantLabel: 'Blue',
        colorId: 'col-blue',
        colorName: 'Blue',
        quantity: 30,
      },
    ];
    const checkColorConflict = validateStrictSingleProductPlateItems(conflictingColorItems);
    expect(checkColorConflict.valid).toBe(false);
    expect(checkColorConflict.error).toMatch(/Color mixing blocked/i);
  });

  it('2. getPlannableItemsForSelectedFilamentColor cleanly resolves color variation rules (Section 4)', () => {
    // Case A: Product with physical Color variation only (Clicker Base)
    // When Pink selected: returns single item for Pink
    const clickerPink = getPlannableItemsForSelectedFilamentColor(
      productClickerBase,
      workspaceColors[0], // Pink
      workspaceColors
    );
    expect(clickerPink.hasColorOption).toBe(true);
    expect(clickerPink.isColorCompatible).toBe(true);
    expect(clickerPink.displayMode).toBe('single_input');
    expect(clickerPink.items).toHaveLength(1);
    expect(clickerPink.items[0].optionValues?.Color).toBe('Pink');

    // When an unconfigured color selected (Black): returns incompatible
    const clickerBlack = getPlannableItemsForSelectedFilamentColor(
      productClickerBase,
      workspaceColors[4], // Black
      workspaceColors
    );
    expect(clickerBlack.isColorCompatible).toBe(false);
    expect(clickerBlack.displayMode).toBe('incompatible_color');
    expect(clickerBlack.availableColors.map((c) => c.name)).toEqual([
      'Pink',
      'Blue',
      'Purple',
      'Mulberry',
    ]);

    // Case B: Product with Color + Design (Charm Keycap)
    // When Pink selected: returns Heart and Star variations for Pink only
    const charmPink = getPlannableItemsForSelectedFilamentColor(
      productCharmKeycap,
      workspaceColors[0], // Pink
      workspaceColors
    );
    expect(charmPink.hasColorOption).toBe(true);
    expect(charmPink.isColorCompatible).toBe(true);
    expect(charmPink.displayMode).toBe('variation_grid');
    expect(charmPink.items).toHaveLength(2);
    expect(charmPink.items.map((i) => i.label)).toEqual(['Heart', 'Star']);

    // Case C: Product without color option (Keycap Letter A–Z)
    // When Pink selected: returns all letter variations for Pink
    const letterPink = getPlannableItemsForSelectedFilamentColor(
      productKeycapLetter,
      workspaceColors[0], // Pink
      workspaceColors
    );
    expect(letterPink.hasColorOption).toBe(false);
    expect(letterPink.isColorCompatible).toBe(true);
    expect(letterPink.displayMode).toBe('variation_grid');
    expect(letterPink.items).toHaveLength(3);
    expect(letterPink.items.map((i) => i.label)).toEqual(['A', 'B', 'C']);
  });

  it('3. generateAutomaticCatalogPlatePreviews packs variations of the SAME product across plates (prompt example: A×60, B×50, C×40 with capacity 138)', () => {
    // Requested: A × 60, B × 50, C × 40 = 150 pcs on capacity 138
    // Expected:
    // Plate 1: 138 pcs (A × 60, B × 50, C × 28)
    // Plate 2: 12 pcs (C × 12)
    const genRes = generateAutomaticCatalogPlatePreviews({
      existingJobs: [],
      project,
      color: workspaceColors[0], // Pink
      workspaceColors,
      category: categoryKeycaps,
      products: [productKeycapLetter],
      selections: [
        { productId: productKeycapLetter.id, variantId: 'var-a', quantity: 60 },
        { productId: productKeycapLetter.id, variantId: 'var-b', quantity: 50 },
        { productId: productKeycapLetter.id, variantId: 'var-c', quantity: 40 },
      ],
      plateSetting,
      includePartialRemainderPlate: true,
    });

    expect(genRes.error).toBeUndefined();
    expect(genRes.previews).toHaveLength(2);

    const plate1 = genRes.previews![0];
    const plate2 = genRes.previews![1];

    // Plate 1 properties
    expect(plate1.productId).toBe(productKeycapLetter.id);
    expect(plate1.productName).toBe(productKeycapLetter.name);
    expect(plate1.colorId).toBe('col-pink');
    expect(plate1.colorName).toBe('Pink');
    const plate1Total = plate1.items.reduce((s, it) => s + it.quantity, 0);
    expect(plate1Total).toBe(138);

    // Breakdown on Plate 1: A x 60, B x 50, C x 28
    const aOnPlate1 = plate1.items.find((it) => it.variantId === 'var-a')!;
    const bOnPlate1 = plate1.items.find((it) => it.variantId === 'var-b')!;
    const cOnPlate1 = plate1.items.find((it) => it.variantId === 'var-c')!;
    expect(aOnPlate1.quantity).toBe(60);
    expect(bOnPlate1.quantity).toBe(50);
    expect(cOnPlate1.quantity).toBe(28);

    // Plate 2 properties
    expect(plate2.productId).toBe(productKeycapLetter.id);
    expect(plate2.colorId).toBe('col-pink');
    const plate2Total = plate2.items.reduce((s, it) => s + it.quantity, 0);
    expect(plate2Total).toBe(12);
    const cOnPlate2 = plate2.items.find((it) => it.variantId === 'var-c')!;
    expect(cOnPlate2.quantity).toBe(12);

    // Re-verify strict single-product invariant on both plates
    expect(validateStrictSingleProductPlateItems(plate1.items).valid).toBe(true);
    expect(validateStrictSingleProductPlateItems(plate2.items).valid).toBe(true);
  });

  it('4. Multi-product input is strictly partitioned so different products NEVER share a plate', () => {
    // If selections contain both Keycap Letter and Clicker Base:
    const multiProductRes = generateAutomaticCatalogPlatePreviews({
      existingJobs: [],
      project,
      color: workspaceColors[0], // Pink
      workspaceColors,
      category: categoryKeycaps,
      products: [productKeycapLetter, productClickerBase],
      selections: [
        { productId: productKeycapLetter.id, variantId: 'var-a', quantity: 40 },
        { productId: productClickerBase.id, variantId: 'var-pink', quantity: 20 },
      ],
      plateSetting,
      includePartialRemainderPlate: true,
    });

    expect(multiProductRes.error).toBeUndefined();
    // Must generate 2 distinct plates, NEVER 1 mixed plate
    expect(multiProductRes.previews).toHaveLength(2);

    const letterPlate = multiProductRes.previews!.find(
      (p) => p.productId === productKeycapLetter.id
    )!;
    const basePlate = multiProductRes.previews!.find(
      (p) => p.productId === productClickerBase.id
    )!;

    expect(letterPlate).toBeDefined();
    expect(basePlate).toBeDefined();

    // Verify each plate contains ONLY its respective product
    expect(letterPlate.items.every((it) => it.productId === productKeycapLetter.id)).toBe(true);
    expect(basePlate.items.every((it) => it.productId === productClickerBase.id)).toBe(true);
  });

  it('5. commitCatalogPlatesToWorkspace persists authoritative product and color and passes Firestore validation', () => {
    const genRes = generateAutomaticCatalogPlatePreviews({
      existingJobs: [],
      project,
      color: workspaceColors[0], // Pink
      workspaceColors,
      category: categoryKeycaps,
      products: [productKeycapLetter],
      selections: [
        { productId: productKeycapLetter.id, variantId: 'var-a', quantity: 50 },
      ],
      plateSetting,
      includePartialRemainderPlate: true,
    });

    const commitRes = commitCatalogPlatesToWorkspace(baseWorkspace, {
      projectId: project.id,
      colorId: workspaceColors[0].id,
      category: categoryKeycaps,
      confirmedPlates: genRes.previews!,
    });

    expect(commitRes.error).toBeUndefined();
    expect(commitRes.createdJobs).toHaveLength(1);

    const job = commitRes.createdJobs![0];
    expect(job.colorId).toBe('col-pink');
    expect(job.catalogItems).toHaveLength(1);
    expect(job.catalogItems![0].productId).toBe(productKeycapLetter.id);
    expect(job.catalogItems![0].colorId).toBe('col-pink');
    expect(job.catalogItems![0].quantity).toBe(50);

    // Verify Firestore workspace sanitization succeeds
    const firestorePayload = prepareWorkspaceForFirestore(commitRes.nextWorkspace!, ownerId);
    expect(firestorePayload.jobs).toHaveLength(1);
    expect(firestorePayload.jobs[0].colorId).toBe('col-pink');
  });

  it('6. buildCatalogSelectionKey and parseCatalogSelectionKey isolate drafts by product, color, and variant', () => {
    const keyPinkA = buildCatalogSelectionKey('prod-1', 'var-a', 'col-pink');
    expect(keyPinkA).toBe('prod-1:::col-pink:::var-a');

    const parsed = parseCatalogSelectionKey(keyPinkA);
    expect(parsed.productId).toBe('prod-1');
    expect(parsed.colorId).toBe('col-pink');
    expect(parsed.variantId).toBe('var-a');

    const keyBlueA = buildCatalogSelectionKey('prod-1', 'var-a', 'col-blue');
    expect(keyBlueA).toBe('prod-1:::col-blue:::var-a');
    expect(keyPinkA).not.toBe(keyBlueA); // Pink and Blue quantities never collide!
  });
});
