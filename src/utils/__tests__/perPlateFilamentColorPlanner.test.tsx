import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AutoPlannerView } from '../../components/AutoPlannerView';
import { CatalogCategoryPlannerSection } from '../../components/CatalogCategoryPlannerSection';
import { KanbanQueueView } from '../../components/KanbanQueueView';
import {
  ABC,
  countCatalogItems,
  createFreshWorkspaceV5,
  normalizeWorkspaceV5,
} from '../../constants';
import {
  CatalogProduct,
  CategoryPlateSetting,
  ColorOption,
  ProductCategory,
  ProductionJob,
  ProductionWorkspaceV5,
} from '../../types';
import {
  assignColorToDraftCatalogPlate,
  buildCatalogSelectionKey,
  buildPlannerProductInputModel,
  COLOR_AGNOSTIC_BASE_ITEM_ID,
  commitCatalogPlatesToWorkspace,
  DraftCatalogPlatePreview,
  generateAutomaticCatalogPlatePreviews,
  getPlannableProductItems,
  NON_COLOR_COMBO_PREFIX,
  validateStagedCatalogPlate,
  validateStagedCatalogPlatesBatch,
} from '../catalogPlannerEngine';
import { prepareWorkspaceForFirestore } from '../firestorePayload';
import { hydrateJobCountdownFields } from '../productionCountdown';
import { computeGlobalSchedule } from '../schedulingEngine';

const OWNER_UID = 'owner-per-plate-color-test';

function makeWorkspaceColors(): ColorOption[] {
  return [
    { id: 'color-matcha-pink', name: 'Matcha Pink', hex: '#f4a6b8' },
    { id: 'color-lemon-yellow', name: 'Lemon Yellow', hex: '#f7e26b' },
    { id: 'color-black', name: 'Black', hex: '#18181b' },
    { id: 'color-purple', name: 'Purple', hex: '#8b5cf6' },
    { id: 'color-light-pink', name: 'Light Pink', hex: '#fbcfe8' },
    { id: 'color-pink', name: 'Pink', hex: '#ec4899' },
  ];
}

function makeTestWorkspace(withCompletedRecord = false): ProductionWorkspaceV5 {
  const base = createFreshWorkspaceV5(OWNER_UID);
  const colors = makeWorkspaceColors();
  const project = {
    ...base.projects[0],
    id: 'proj-mydin-ecah',
    name: 'Mydin Ecah',
    assignedColorIds: colors.map((c) => c.id),
  };

  const completedJob: ProductionJob | null = withCompletedRecord
    ? {
        id: 'job-historical-completed-1',
        projectId: project.id,
        colorId: 'color-purple',
        plateNumber: 1,
        plateCapacity: 20,
        letters: {},
        plateMode: 'catalog_category',
        categoryId: 'cat-clicker-base',
        categoryNameSnapshot: 'Clicker Bases',
        catalogItems: [
          {
            productId: 'prod-base-v1',
            productName: 'Base V1',
            sku: 'WOOPP-BASEV1',
            categoryId: 'cat-clicker-base',
            categoryName: 'Clicker Bases',
            variantId: null,
            variantLabel: null,
            colorId: 'color-purple',
            colorName: 'Purple',
            quantity: 20,
          },
        ],
        stage: 'Completed',
        machineId: base.machines[0].id,
        estimatedMinutes: 180,
        actualMinutes: 175,
        actualCompletedAt: '2026-11-10T10:00:00.000Z',
        actualCompletedAtMs: Date.parse('2026-11-10T10:00:00.000Z'),
        completedIso: '2026-11-10T10:00:00.000Z',
        slicerVerified: true,
        stockApplied: true,
        stockTransactionId: 'tx-hist-1',
        failedCount: 0,
        failureReason: '',
        notes: 'Historical completed batch',
        createdIso: '2026-11-10T06:00:00.000Z',
        updatedIso: '2026-11-10T10:00:00.000Z',
      }
    : null;

  return {
    ...base,
    colors,
    projects: [project],
    jobs: completedJob ? [completedJob] : [],
  };
}

function makeCategories(): ProductCategory[] {
  return [
    {
      id: 'cat-clicker-base',
      ownerId: OWNER_UID,
      name: 'Clicker Bases',
      description: '3D Clicker Bases',
      imageUrl: null,
      iconName: 'box',
      sortOrder: 0,
      status: 'active',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    },
    {
      id: 'cat-keycaps',
      ownerId: OWNER_UID,
      name: 'Keycaps',
      description: 'Custom Keycaps',
      imageUrl: null,
      iconName: 'sparkles',
      sortOrder: 1,
      status: 'active',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    },
  ];
}

function makeBaseV1StandardProduct(): CatalogProduct {
  return {
    id: 'prod-base-v1',
    ownerId: OWNER_UID,
    sku: 'WOOPP-BASEV1',
    name: 'Base V1',
    description: 'Standard clicker base',
    categoryId: 'cat-clicker-base',
    images: [],
    priceMyr: 5,
    options: [],
    variants: [],
    status: 'active',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

function makeBaseV1WithColorVariations(colorNames: string[]): CatalogProduct {
  return {
    id: 'prod-base-v1-colors',
    ownerId: OWNER_UID,
    sku: 'WOOPP-BASEV1C',
    name: 'Base V1 Colored',
    description: 'Clicker base with color option',
    categoryId: 'cat-clicker-base',
    images: [],
    priceMyr: 6,
    options: [
      {
        id: 'opt-color',
        name: 'Color',
        values: colorNames,
        sortOrder: 0,
      },
    ],
    variants: colorNames.map((name, idx) => ({
      id: `var-color-${idx}`,
      label: name,
      optionValues: { Color: name },
      priceMyr: null,
      imageUrl: null,
      sortOrder: idx,
    })),
    status: 'active',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

function makeColorPlusSizeProduct(colorNames: string[], sizes: string[]): CatalogProduct {
  const variants: CatalogProduct['variants'] = [];
  let sortOrder = 0;
  for (const c of colorNames) {
    for (const s of sizes) {
      variants.push({
        id: `var-${c.toLowerCase().replace(/\s+/g, '')}-${s.toLowerCase()}`,
        label: `${c} · ${s}`,
        optionValues: { Color: c, Size: s },
        priceMyr: null,
        imageUrl: null,
        sortOrder: sortOrder++,
      });
    }
  }
  return {
    id: 'prod-base-color-size',
    ownerId: OWNER_UID,
    sku: 'WOOPP-BCS',
    name: 'Clicker Base Pro',
    description: 'Clicker base with Color and Size',
    categoryId: 'cat-clicker-base',
    images: [],
    priceMyr: 8,
    options: [
      { id: 'opt-color', name: 'Color', values: colorNames, sortOrder: 0 },
      { id: 'opt-size', name: 'Size', values: sizes, sortOrder: 1 },
    ],
    variants,
    status: 'active',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

function makeKeycapAlphabetProduct(): CatalogProduct {
  return {
    id: 'prod-keycap-letter',
    ownerId: OWNER_UID,
    sku: 'WOOPP-KEYAZ',
    name: 'Keycap Letter A-Z',
    description: 'Alphabet keycaps',
    categoryId: 'cat-keycaps',
    images: [],
    priceMyr: 4,
    options: [{ id: 'opt-letter', name: 'Letter', values: [...ABC], sortOrder: 0 }],
    variants: [],
    status: 'active',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

function makePlateSetting(categoryId: string, plateCapacity: number): CategoryPlateSetting {
  return {
    categoryId,
    ownerId: OWNER_UID,
    allocationMode: 'automatic_capacity',
    plateCapacity,
    defaultEstimatedMinutes: 180,
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

describe('WOOPP 6.0 — Per-Plate Filament Color Selection & Single Category Selector', () => {
  it('1. Auto Plate Planner renders NO top-level Filament Color selector in Production Batch Context', () => {
    const ws = makeTestWorkspace();
    const cats = makeCategories();
    const prods = [makeBaseV1StandardProduct(), makeKeycapAlphabetProduct()];

    const html = renderToStaticMarkup(
      <AutoPlannerView
        workspace={ws}
        selectedProjectId={ws.projects[0].id}
        onSelectProject={vi.fn()}
        onSavePreset={vi.fn()}
        onDeletePreset={vi.fn()}
        onCommitGeneratedPlates={vi.fn()}
        categories={cats}
        products={prods}
        plateSettingsByCategoryId={{
          'cat-clicker-base': makePlateSetting('cat-clicker-base', 20),
          'cat-keycaps': makePlateSetting('cat-keycaps', 138),
        }}
        onAlert={vi.fn()}
      />
    );

    // Must NOT render any top-level Filament Color selector/label or color swatch buttons inside Production Batch Context
    const contextSectionMatch = html.match(
      /Production Batch Context[\s\S]*?(?=Auto Plate Planner · Product &amp; Option Selection)/
    );
    expect(contextSectionMatch).not.toBeNull();
    expect(contextSectionMatch![0]).not.toMatch(/<label[^>]*>Filament Color<\/label>/);
    expect(contextSectionMatch![0]).not.toContain('Matcha Pink');
    expect(contextSectionMatch![0]).not.toContain('Lemon Yellow');
    expect(contextSectionMatch![0]).not.toContain('Black');
    expect(contextSectionMatch![0]).not.toContain('Purple');
    expect(html).toContain('Target Project');
  });

  it('2. Auto Plate Planner renders ONLY ONE Category selector (#planner-category-select inside Product & Option Selection)', () => {
    const ws = makeTestWorkspace();
    const cats = makeCategories();
    const prods = [makeBaseV1StandardProduct(), makeKeycapAlphabetProduct()];

    const htmlCatalogMode = renderToStaticMarkup(
      <AutoPlannerView
        workspace={ws}
        selectedProjectId={ws.projects[0].id}
        onSelectProject={vi.fn()}
        onSavePreset={vi.fn()}
        onDeletePreset={vi.fn()}
        onCommitGeneratedPlates={vi.fn()}
        categories={cats}
        products={prods}
        plateSettingsByCategoryId={{
          'cat-clicker-base': makePlateSetting('cat-clicker-base', 20),
        }}
        onAlert={vi.fn()}
      />
    );

    // Old duplicate #top-category-select must not exist anywhere
    expect(htmlCatalogMode).not.toContain('id="top-category-select"');
    // Exactly one #planner-category-select must exist
    const plannerCategoryMatches = htmlCatalogMode.match(/id="planner-category-select"/g) || [];
    expect(plannerCategoryMatches).toHaveLength(1);

    // Even when there are no catalog categories (Built-in mode), still only 1 Category selector
    const htmlBuiltinMode = renderToStaticMarkup(
      <AutoPlannerView
        workspace={ws}
        selectedProjectId={ws.projects[0].id}
        onSelectProject={vi.fn()}
        onSavePreset={vi.fn()}
        onDeletePreset={vi.fn()}
        onCommitGeneratedPlates={vi.fn()}
        categories={[]}
        products={[]}
        onAlert={vi.fn()}
      />
    );
    expect(htmlBuiltinMode).not.toContain('id="top-category-select"');
    const builtinCategoryMatches = htmlBuiltinMode.match(/id="planner-category-select"/g) || [];
    expect(builtinCategoryMatches).toHaveLength(1);
  });

  it('3 & 4 & 16. Generates previews WITHOUT a Filament Color, initializes unassigned (colorId: null), and splits 80 pcs Base V1 @ 20/plate into 4 plates of 20 pcs', () => {
    const ws = makeTestWorkspace();
    const cat = makeCategories()[0];
    const baseV1 = makeBaseV1StandardProduct();

    const preview = generateAutomaticCatalogPlatePreviews({
      existingJobs: ws.jobs,
      project: ws.projects[0],
      color: null, // No filament color chosen before generating preview
      workspaceColors: ws.colors,
      category: cat,
      products: [baseV1],
      selections: [{ productId: baseV1.id, variantId: null, quantity: 80 }],
      plateSetting: makePlateSetting(cat.id, 20),
      includePartialRemainderPlate: true,
      nowMs: 1700000000000,
    });

    expect(preview.error).toBeUndefined();
    expect(preview.previews).toBeDefined();
    expect(preview.totalUnits).toBe(80);
    expect(preview.fullPlateCount).toBe(4);
    expect(preview.remainderUnits).toBe(0);
    expect(preview.previews).toHaveLength(4);

    for (const plate of preview.previews!) {
      expect(countCatalogItems(plate.items)).toBe(20);
      expect(plate.colorId).toBeNull();
      expect(plate.colorName).toBe('');
      expect(plate.items.every((it) => it.colorId === 'unassigned')).toBe(true);
    }
  });

  it('5. Assigning different colors across 4 plates (Matcha Pink, Lemon Yellow, Black, Purple) succeeds cleanly with zero Color Mixing Blocked errors', () => {
    const ws = makeTestWorkspace();
    const cat = makeCategories()[0];
    const baseV1 = makeBaseV1StandardProduct();

    const preview = generateAutomaticCatalogPlatePreviews({
      existingJobs: ws.jobs,
      project: ws.projects[0],
      color: null,
      workspaceColors: ws.colors,
      category: cat,
      products: [baseV1],
      selections: [{ productId: baseV1.id, variantId: null, quantity: 80 }],
      plateSetting: makePlateSetting(cat.id, 20),
      nowMs: 1700000000000,
    });

    const targetColorNames = ['Matcha Pink', 'Lemon Yellow', 'Black', 'Purple'];
    const assignedPlates = preview.previews!.map((plate, idx) => {
      const col = ws.colors.find((c) => c.name === targetColorNames[idx])!;
      return assignColorToDraftCatalogPlate(plate, col, baseV1, ws.colors);
    });

    const validation = validateStagedCatalogPlatesBatch(assignedPlates, {
      category: cat,
      product: baseV1,
      workspaceColors: ws.colors,
    });
    expect(validation.allValid).toBe(true);
    expect(validation.invalidPlateNumbers).toEqual([]);

    const commitRes = commitCatalogPlatesToWorkspace(ws, {
      projectId: ws.projects[0].id,
      colorId: null,
      category: cat,
      products: [baseV1],
      confirmedPlates: assignedPlates,
      nowMs: 1700000100000,
    });

    expect(commitRes.error).toBeUndefined();
    expect(commitRes.createdJobs).toHaveLength(4);
    expect(commitRes.createdJobs!.map((j) => j.colorId)).toEqual([
      'color-matcha-pink',
      'color-lemon-yellow',
      'color-black',
      'color-purple',
    ]);
  });

  it('6. Blocks assigning multiple different physical colors on 1 plate', () => {
    const ws = makeTestWorkspace();
    const cat = makeCategories()[0];
    const baseV1 = makeBaseV1StandardProduct();

    const conflictingPlate: DraftCatalogPlatePreview = {
      tempId: 'draft-conflict-color',
      plateNumber: 1,
      categoryId: cat.id,
      categoryName: cat.name,
      productId: baseV1.id,
      productName: baseV1.name,
      colorId: 'color-matcha-pink',
      colorName: 'Matcha Pink',
      capacity: 20,
      estimatedMinutes: 180,
      slicerVerified: true,
      notes: '',
      items: [
        {
          productId: baseV1.id,
          productName: baseV1.name,
          sku: baseV1.sku,
          categoryId: cat.id,
          categoryName: cat.name,
          variantId: null,
          variantLabel: null,
          colorId: 'color-matcha-pink',
          colorName: 'Matcha Pink',
          quantity: 10,
        },
        {
          productId: baseV1.id,
          productName: baseV1.name,
          sku: baseV1.sku,
          categoryId: cat.id,
          categoryName: cat.name,
          variantId: null,
          variantLabel: null,
          colorId: 'color-lemon-yellow',
          colorName: 'Lemon Yellow',
          quantity: 10,
        },
      ],
    };

    const singleRes = validateStagedCatalogPlate(conflictingPlate, {
      category: cat,
      product: baseV1,
      workspaceColors: ws.colors,
    });
    expect(singleRes.valid).toBe(false);
    expect(singleRes.blockingErrors.some((e) => /conflict|color mixing/i.test(e))).toBe(true);

    const commitRes = commitCatalogPlatesToWorkspace(ws, {
      projectId: ws.projects[0].id,
      category: cat,
      products: [baseV1],
      confirmedPlates: [conflictingPlate],
    });
    expect(commitRes.error).toBeDefined();
    expect(commitRes.error).toMatch(/conflict|color/i);
  });

  it('7. Blocks assigning multiple different productIds on 1 plate', () => {
    const ws = makeTestWorkspace();
    const cat = makeCategories()[0];
    const baseV1 = makeBaseV1StandardProduct();
    const baseV1Colored = makeBaseV1WithColorVariations(['Matcha Pink']);

    const mixedProductPlate: DraftCatalogPlatePreview = {
      tempId: 'draft-mixed-prod',
      plateNumber: 1,
      categoryId: cat.id,
      categoryName: cat.name,
      productId: baseV1.id,
      productName: baseV1.name,
      colorId: 'color-matcha-pink',
      colorName: 'Matcha Pink',
      capacity: 20,
      estimatedMinutes: 180,
      slicerVerified: true,
      notes: '',
      items: [
        {
          productId: baseV1.id,
          productName: baseV1.name,
          sku: baseV1.sku,
          categoryId: cat.id,
          categoryName: cat.name,
          variantId: null,
          variantLabel: null,
          colorId: 'color-matcha-pink',
          colorName: 'Matcha Pink',
          quantity: 10,
        },
        {
          productId: baseV1Colored.id,
          productName: baseV1Colored.name,
          sku: baseV1Colored.sku,
          categoryId: cat.id,
          categoryName: cat.name,
          variantId: null,
          variantLabel: null,
          colorId: 'color-matcha-pink',
          colorName: 'Matcha Pink',
          quantity: 10,
        },
      ],
    };

    const res = validateStagedCatalogPlate(mixedProductPlate, {
      category: cat,
      workspaceColors: ws.colors,
    });
    expect(res.valid).toBe(false);
    expect(res.blockingErrors.some((e) => /different products|one product/i.test(e))).toBe(true);

    const commitRes = commitCatalogPlatesToWorkspace(ws, {
      projectId: ws.projects[0].id,
      category: cat,
      products: [baseV1, baseV1Colored],
      confirmedPlates: [mixedProductPlate],
    });
    expect(commitRes.error).toBeDefined();
    expect(commitRes.error).toMatch(/different products|one product/i);
  });

  it('8. Multiple non-color variations of the same product share a plate up to capacity cleanly', () => {
    const ws = makeTestWorkspace();
    const keycapsCat = makeCategories()[1];
    const keycapProd = makeKeycapAlphabetProduct();
    const plannable = getPlannableProductItems(keycapProd);
    const varA = plannable.find((i) => i.label === 'A')!;
    const varB = plannable.find((i) => i.label === 'B')!;
    const varC = plannable.find((i) => i.label === 'C')!;

    const preview = generateAutomaticCatalogPlatePreviews({
      existingJobs: ws.jobs,
      project: ws.projects[0],
      color: null,
      workspaceColors: ws.colors,
      category: keycapsCat,
      products: [keycapProd],
      selections: [
        { productId: keycapProd.id, variantId: varA.id, quantity: 50 },
        { productId: keycapProd.id, variantId: varB.id, quantity: 50 },
        { productId: keycapProd.id, variantId: varC.id, quantity: 38 },
      ],
      plateSetting: makePlateSetting(keycapsCat.id, 138),
      nowMs: 1700000000000,
    });

    expect(preview.error).toBeUndefined();
    expect(preview.previews).toHaveLength(1);
    const plate = preview.previews![0];
    expect(countCatalogItems(plate.items)).toBe(138);
    expect(plate.items.map((i) => i.variantLabel).sort()).toEqual(['A', 'B', 'C']);

    const pink = ws.colors.find((c) => c.name === 'Matcha Pink')!;
    const assigned = assignColorToDraftCatalogPlate(plate, pink, keycapProd, ws.colors);
    const validation = validateStagedCatalogPlatesBatch([assigned], {
      category: keycapsCat,
      product: keycapProd,
      workspaceColors: ws.colors,
    });
    expect(validation.allValid).toBe(true);
  });

  it('9. Deduplicates physical Color variations safely and enforces color constraints without substring guessing or silent substitution', () => {
    const ws = makeTestWorkspace();
    const cat = makeCategories()[0];

    // 9a. Uniform Color + Size product deduplicates Color into Size-only input cards
    const proProd = makeColorPlusSizeProduct(['Matcha Pink', 'Black'], ['Standard', 'Mini']);
    const proModel = buildPlannerProductInputModel(proProd, ws.colors);
    expect(proModel.isColorDeduplicated).toBe(true);
    expect(proModel.hasAmbiguousColorMapping).toBe(false);
    expect(proModel.displayMode).toBe('variation_grid');
    expect(proModel.items.map((i) => i.label)).toEqual(['Standard', 'Mini']);
    expect(proModel.items[0].id.startsWith(NON_COLOR_COMBO_PREFIX)).toBe(true);

    // 9b. Single-Color-option product deduplicates into single_input
    const limitedColorProd = makeBaseV1WithColorVariations(['Matcha Pink', 'Black']);
    const limitedModel = buildPlannerProductInputModel(limitedColorProd, ws.colors);
    expect(limitedModel.isColorDeduplicated).toBe(true);
    expect(limitedModel.displayMode).toBe('single_input');
    expect(limitedModel.items[0].id).toBe(COLOR_AGNOSTIC_BASE_ITEM_ID);

    // Preview 40 pcs -> 2 plates of 20 pcs
    const preview = generateAutomaticCatalogPlatePreviews({
      existingJobs: ws.jobs,
      project: ws.projects[0],
      color: null,
      workspaceColors: ws.colors,
      category: cat,
      products: [limitedColorProd],
      selections: [
        { productId: limitedColorProd.id, variantId: COLOR_AGNOSTIC_BASE_ITEM_ID, quantity: 40 },
      ],
      plateSetting: makePlateSetting(cat.id, 20),
    });
    expect(preview.previews).toHaveLength(2);

    // Selecting supported color (Matcha Pink) succeeds & resolves concrete variant ID
    const matchaPink = ws.colors.find((c) => c.id === 'color-matcha-pink')!;
    const assignedSupported = assignColorToDraftCatalogPlate(
      preview.previews![0],
      matchaPink,
      limitedColorProd,
      ws.colors
    );
    expect(assignedSupported.items[0].variantId).toBe('var-color-0');
    expect(
      validateStagedCatalogPlate(assignedSupported, {
        category: cat,
        product: limitedColorProd,
        workspaceColors: ws.colors,
      }).valid
    ).toBe(true);

    // Selecting unsupported physical color (Purple — NOT configured on limitedColorProd) is BLOCKED (never silently substituted)
    const purple = ws.colors.find((c) => c.id === 'color-purple')!;
    const assignedUnsupported = assignColorToDraftCatalogPlate(
      preview.previews![1],
      purple,
      limitedColorProd,
      ws.colors
    );
    expect(assignedUnsupported.items[0].variantId).toBe(COLOR_AGNOSTIC_BASE_ITEM_ID);
    const badCheck = validateStagedCatalogPlate(assignedUnsupported, {
      category: cat,
      product: limitedColorProd,
      workspaceColors: ws.colors,
    });
    expect(badCheck.valid).toBe(false);
    expect(badCheck.blockingErrors[0]).toMatch(/does not have a valid.*Purple/i);

    // 9c. Ambiguous/unmapped value ('Rose Pink') must NOT guess 'Pink' or 'Light Pink' via substring `.includes()`
    const customNameProd = makeBaseV1WithColorVariations(['Rose Pink', 'Sky']);
    const customModel = buildPlannerProductInputModel(customNameProd, ws.colors);
    expect(customModel.isColorDeduplicated).toBe(false);
    expect(customModel.hasAmbiguousColorMapping).toBe(true);
    expect(customModel.items.map((i) => i.label)).toEqual(['Rose Pink', 'Sky']);
  });

  it('10 & 11. Changing Plate 1 color does NOT modify Plates 2-4, and assigned plate colors persist across preview edits', () => {
    const ws = makeTestWorkspace();
    const cat = makeCategories()[0];
    const baseV1 = makeBaseV1StandardProduct();

    const preview = generateAutomaticCatalogPlatePreviews({
      existingJobs: ws.jobs,
      project: ws.projects[0],
      color: null,
      workspaceColors: ws.colors,
      category: cat,
      products: [baseV1],
      selections: [{ productId: baseV1.id, variantId: null, quantity: 80 }],
      plateSetting: makePlateSetting(cat.id, 20),
    });

    const initialColors = [
      ws.colors.find((c) => c.id === 'color-matcha-pink')!,
      ws.colors.find((c) => c.id === 'color-lemon-yellow')!,
      ws.colors.find((c) => c.id === 'color-black')!,
      ws.colors.find((c) => c.id === 'color-purple')!,
    ];

    let plates = preview.previews!.map((p, idx) =>
      assignColorToDraftCatalogPlate(p, initialColors[idx], baseV1, ws.colors)
    );

    // Change Plate 1 from Matcha Pink -> Light Pink
    const lightPink = ws.colors.find((c) => c.id === 'color-light-pink')!;
    plates = plates.map((p, idx) =>
      idx === 0 ? assignColorToDraftCatalogPlate(p, lightPink, baseV1, ws.colors) : p
    );

    // Plates 2-4 remain completely unchanged
    expect(plates[0].colorId).toBe('color-light-pink');
    expect(plates[1].colorId).toBe('color-lemon-yellow');
    expect(plates[2].colorId).toBe('color-black');
    expect(plates[3].colorId).toBe('color-purple');

    // Simulate preview edits (duration change, item quantity tweak, bed-fit verification)
    plates = plates.map((p, idx) =>
      idx === 1
        ? {
            ...p,
            estimatedMinutes: 215,
            slicerVerified: true,
            items: p.items.map((it) => ({ ...it, quantity: 18 })),
          }
        : p
    );

    expect(plates[1].colorId).toBe('color-lemon-yellow');
    expect(plates[1].items[0].colorId).toBe('color-lemon-yellow');
    expect(plates[1].estimatedMinutes).toBe(215);
    expect(plates[1].slicerVerified).toBe(true);
  });

  it('12. Confirmation blocks partial/invalid batches when any plate is missing a Filament Color and renders inline card error + alert banner', () => {
    const ws = makeTestWorkspace();
    const cat = makeCategories()[0];
    const baseV1 = makeBaseV1StandardProduct();

    const preview = generateAutomaticCatalogPlatePreviews({
      existingJobs: ws.jobs,
      project: ws.projects[0],
      color: null,
      workspaceColors: ws.colors,
      category: cat,
      products: [baseV1],
      selections: [{ productId: baseV1.id, variantId: null, quantity: 40 }],
      plateSetting: makePlateSetting(cat.id, 20),
    });

    // Assign Plate 1, leave Plate 2 unassigned (null)
    const matchaPink = ws.colors.find((c) => c.id === 'color-matcha-pink')!;
    const partialAssigned = [
      assignColorToDraftCatalogPlate(preview.previews![0], matchaPink, baseV1, ws.colors),
      preview.previews![1],
    ];

    const batchCheck = validateStagedCatalogPlatesBatch(partialAssigned, {
      category: cat,
      product: baseV1,
      workspaceColors: ws.colors,
    });
    expect(batchCheck.allValid).toBe(false);
    expect(batchCheck.invalidPlateNumbers).toEqual([2]);
    expect(batchCheck.byTempId[partialAssigned[1].tempId].requiresColorSelection).toBe(true);

    // Must not silently save partial batch
    const commitRes = commitCatalogPlatesToWorkspace(ws, {
      projectId: ws.projects[0].id,
      colorId: null,
      category: cat,
      products: [baseV1],
      confirmedPlates: partialAssigned,
    });
    expect(commitRes.error).toMatch(/Plate 2 requires a physical Filament Color/i);
    expect(commitRes.nextWorkspace).toBeUndefined();
    expect(commitRes.createdJobs).toBeUndefined();
  });

  it('13. CatalogCategoryPlannerSection renders without top-level color requirement and shows Select Filament Color workflow copy cleanly', () => {
    const ws = makeTestWorkspace();
    const cats = makeCategories();
    const prods = [makeBaseV1StandardProduct()];

    const html = renderToStaticMarkup(
      <CatalogCategoryPlannerSection
        category={cats[0]}
        categoryProducts={prods}
        plateSetting={makePlateSetting(cats[0].id, 20)}
        currentProject={ws.projects[0]}
        workspaceColors={ws.colors}
        existingJobs={ws.jobs}
        quantitiesByKey={{ [buildCatalogSelectionKey(prods[0].id, null)]: 80 }}
        highlightedProductId={null}
        allCategories={cats}
        selectedWorkflowValue={`catalog:${cats[0].id}`}
        onSelectWorkflow={vi.fn()}
        onChangeQuantity={vi.fn()}
        onSaveCategoryPlateSetting={async () => undefined}
        onConfirmCatalogPlates={vi.fn()}
        onOpenProductStudio={vi.fn()}
        onAlert={vi.fn()}
        resetSignal={0}
      />
    );

    expect(html).toContain('id="planner-category-select"');
    expect(html).toContain('id="planner-product-select"');
    expect(html).toContain('Generate Plate Preview');
    expect(html).toContain('Assigned per plate in Preview');
    expect(html).toContain('80 pcs');
    expect(html).toContain('full plate(s)');
  });

  it('14 & 15. Confirmed plates persist exact per-plate colorIds to Print Queue, survive Firestore round-trip, and preserve existing Completed records', () => {
    const ws = makeTestWorkspace(true); // includes historical completed job
    const cat = makeCategories()[0];
    const baseV1 = makeBaseV1StandardProduct();

    const preview = generateAutomaticCatalogPlatePreviews({
      existingJobs: ws.jobs,
      project: ws.projects[0],
      color: null,
      workspaceColors: ws.colors,
      category: cat,
      products: [baseV1],
      selections: [{ productId: baseV1.id, variantId: null, quantity: 80 }],
      plateSetting: makePlateSetting(cat.id, 20),
      nowMs: 1700000000000,
    });

    const chosenColors = ['color-matcha-pink', 'color-lemon-yellow', 'color-black', 'color-purple'].map(
      (cid) => ws.colors.find((c) => c.id === cid)!
    );
    const assigned = preview.previews!.map((plate, i) => ({
      ...assignColorToDraftCatalogPlate(plate, chosenColors[i], baseV1, ws.colors),
      slicerVerified: true,
    }));

    const commitRes = commitCatalogPlatesToWorkspace(ws, {
      projectId: ws.projects[0].id,
      category: cat,
      products: [baseV1],
      confirmedPlates: assigned,
      nowMs: 1700000500000,
    });

    expect(commitRes.error).toBeUndefined();
    const nextWs = commitRes.nextWorkspace!;
    expect(nextWs.jobs).toHaveLength(5); // 1 historical Completed + 4 newly confirmed plates

    // Firestore sanitization & round-trip must succeed with zero errors
    const firestorePayload = prepareWorkspaceForFirestore(nextWs, OWNER_UID);
    const serialized = JSON.parse(JSON.stringify(firestorePayload));
    const rehydrated = normalizeWorkspaceV5(serialized, OWNER_UID);
    const hydratedWs: ProductionWorkspaceV5 = {
      ...rehydrated,
      jobs: rehydrated.jobs.map((j) => hydrateJobCountdownFields(j)),
    };

    // Historical Completed record completely intact
    const histJob = hydratedWs.jobs.find((j) => j.id === 'job-historical-completed-1');
    expect(histJob).toBeDefined();
    expect(histJob!.stage).toBe('Completed');
    expect(histJob!.actualCompletedAt).toBe('2026-11-10T10:00:00.000Z');
    expect(histJob!.colorId).toBe('color-purple');

    // Newly queued plates persist exact per-plate colors & labels in Print Queue
    const newJobs = hydratedWs.jobs.filter((j) => j.id !== 'job-historical-completed-1');
    expect(newJobs).toHaveLength(4);
    expect(newJobs.map((j) => j.colorId)).toEqual([
      'color-matcha-pink',
      'color-lemon-yellow',
      'color-black',
      'color-purple',
    ]);
    for (const j of newJobs) {
      expect(j.catalogItems![0].colorId).toBe(j.colorId);
      const expectedColorName = hydratedWs.colors.find((c) => c.id === j.colorId)!.name;
      expect(j.catalogItems![0].colorName).toBe(expectedColorName);
    }

    // Verify Print Queue renders each plate header with its distinct plate color (never hardcoded stale color)
    const nowMs = Date.parse('2026-11-10T12:00:00.000Z');
    const schedule = computeGlobalSchedule(hydratedWs, nowMs);
    const queueHtml = renderToStaticMarkup(
      <KanbanQueueView
        workspace={hydratedWs}
        schedule={schedule}
        selectedProjectId={hydratedWs.projects[0].id}
        isAdmin={true}
        busyJobIds={new Set()}
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

    expect(queueHtml).toContain('title="Project: Mydin Ecah"');
    expect(queueHtml).toContain('title="Plate Printing Color: Matcha Pink"');
    expect(queueHtml).toContain('title="Plate Printing Color: Lemon Yellow"');
    expect(queueHtml).toContain('title="Plate Printing Color: Black"');
    expect(queueHtml).toContain('title="Plate Printing Color: Purple"');
  });
});
