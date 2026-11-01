import {
  ABC,
  CHARM_IDS,
  compactCharmsMap,
  compactLettersMap,
  countCatalogItems,
  countCharms,
  countLetters,
  emptyAlphabetMap,
  emptyCharmsMap,
  normalizeAlphabetMap,
  normalizeCharmsMap,
} from '../constants';
import {
  CatalogProduct,
  CategoryPlateSetting,
  CharmId,
  CharmsMap,
  ColorOption,
  JobCatalogItemSnapshot,
  LettersMap,
  PlateGenerationMode,
  ProductCategory,
  ProductionJob,
  ProductionProject,
  ProductionWorkspaceV5,
} from '../types';
import { DEFAULT_TIMEZONE } from './dateFormat';
import {
  createActivityLogEntry,
  DraftPlatePreview,
  inferPlateMode,
} from './productionEngine';

export interface CatalogPlannerSelectionInput {
  productId: string;
  variantId: string | null;
  quantity: number;
}

export interface DraftCatalogPlatePreview {
  tempId: string;
  plateNumber: number;
  categoryId: string;
  categoryName: string;
  capacity: number | null; // null when composed in manual_plate mode without a fixed category capacity
  items: JobCatalogItemSnapshot[];
  estimatedMinutes: number;
  slicerVerified: boolean;
  notes: string;
}

export interface CatalogPlateGenerationResult {
  previews?: DraftCatalogPlatePreview[];
  totalUnits?: number;
  fullPlateCount?: number;
  remainderUnits?: number;
  error?: string;
}

export interface PlannerEditableInputsState {
  draftLetters: LettersMap;
  draftCharms: Record<CharmId, number>;
  draftCatalogQuantities: Record<string, number>;
}

/**
 * Pure helper for the Auto Plate Planner `Reset` button:
 * Resets ONLY editable planner quantity inputs to `0` without touching
 * completed production, existing plates, or Print Queue state.
 */
export function createZeroedPlannerInputs(): PlannerEditableInputsState {
  return {
    draftLetters: emptyAlphabetMap(),
    draftCharms: emptyCharmsMap(),
    draftCatalogQuantities: {},
  };
}

/**
 * Builds a deterministic selection map key for a product + optional variant.
 */
export function buildCatalogSelectionKey(
  productId: string,
  variantId?: string | null
): string {
  return variantId ? `${productId}::${variantId}` : `${productId}::base`;
}

/**
 * Verifies whether a category is active and eligible for creating new print plans.
 * Archived categories cannot create new print plans until restored.
 */
export function validateCategoryForPlanning(
  category: ProductCategory | null | undefined
): { ok: boolean; error?: string } {
  if (!category) {
    return { ok: false, error: 'Selected category was not found in Product Studio.' };
  }
  if (category.status === 'archived') {
    return {
      ok: false,
      error: `Category "${category.name}" is archived. Restore this category in Product Studio before creating new print plans.`,
    };
  }
  return { ok: true };
}

/**
 * Enforces Category-Based Plate Mixing strictly by immutable `categoryId` (never by display name):
 * - Products can share a plate ONLY when they have the exact same `categoryId`.
 * - Never allows items from different categories on one plate.
 */
export function validateSameCategoryPlateItems(
  items: readonly Pick<JobCatalogItemSnapshot, 'productId' | 'productName' | 'categoryId' | 'quantity'>[],
  expectedCategoryId?: string
): { valid: boolean; resolvedCategoryId?: string; error?: string } {
  const nonEmpty = items.filter((item) => Math.floor(Number(item.quantity || 0)) > 0);
  if (nonEmpty.length === 0) {
    return {
      valid: false,
      error: 'Each plate must include at least 1 product unit.',
    };
  }

  const anchorCategoryId = (expectedCategoryId || nonEmpty[0].categoryId || '').trim();
  if (!anchorCategoryId) {
    return {
      valid: false,
      error: 'Missing categoryId on plate items.',
    };
  }

  for (const item of nonEmpty) {
    if (!item.categoryId || item.categoryId.trim() !== anchorCategoryId) {
      return {
        valid: false,
        error: `Cross-category plate mixing blocked: "${item.productName}" belongs to category ID "${item.categoryId}", which cannot share a plate with category ID "${anchorCategoryId}".`,
      };
    }
  }

  return {
    valid: true,
    resolvedCategoryId: anchorCategoryId,
  };
}

/**
 * Builds immutable `JobCatalogItemSnapshot` entries from user planner selections,
 * enforcing that every selected product is active and belongs to `category.id`.
 */
export function resolveCatalogSnapshotsFromSelections(params: {
  category: ProductCategory;
  products: readonly CatalogProduct[];
  selections: readonly CatalogPlannerSelectionInput[];
  color: ColorOption;
}): { snapshots?: JobCatalogItemSnapshot[]; error?: string } {
  const catCheck = validateCategoryForPlanning(params.category);
  if (!catCheck.ok) {
    return { error: catCheck.error };
  }

  const productById = new Map<string, CatalogProduct>();
  for (const p of params.products) {
    productById.set(p.id, p);
  }

  const mergedByKey = new Map<string, JobCatalogItemSnapshot>();

  for (const sel of params.selections) {
    const qty = Math.floor(Number(sel.quantity || 0));
    if (qty <= 0) continue;

    const product = productById.get(sel.productId);
    if (!product) {
      return {
        error: `Selected product (${sel.productId}) no longer exists in Product Studio.`,
      };
    }
    if (product.status === 'archived') {
      return {
        error: `Product "${product.name}" (${product.sku}) is archived. Restore it in Product Studio before planning new plates.`,
      };
    }
    if (product.categoryId !== params.category.id) {
      return {
        error: `Cross-category plate mixing blocked: "${product.name}" belongs to category ID "${product.categoryId}" and cannot be mixed with "${params.category.name}" (${params.category.id}).`,
      };
    }

    let variantId: string | null = null;
    let variantLabel: string | null = null;

    if (product.variants.length > 0) {
      if (!sel.variantId) {
        return {
          error: `Select a variation for "${product.name}" before generating plates.`,
        };
      }
      const matchedVar = product.variants.find((v) => v.id === sel.variantId);
      if (!matchedVar) {
        return {
          error: `Selected variation for "${product.name}" was not found.`,
        };
      }
      variantId = matchedVar.id;
      variantLabel = matchedVar.label;
    }

    const key = buildCatalogSelectionKey(product.id, variantId);
    const existing = mergedByKey.get(key);
    if (existing) {
      existing.quantity += qty;
    } else {
      mergedByKey.set(key, {
        productId: product.id,
        productName: product.name,
        sku: product.sku,
        categoryId: params.category.id,
        categoryName: params.category.name,
        variantId,
        variantLabel,
        colorId: params.color.id,
        colorName: params.color.name,
        quantity: qty,
      });
    }
  }

  const snapshots = Array.from(mergedByKey.values());
  if (snapshots.length === 0) {
    return {
      error: `Enter a quantity of at least 1 for one or more products in "${params.category.name}".`,
    };
  }

  const mixCheck = validateSameCategoryPlateItems(snapshots, params.category.id);
  if (!mixCheck.valid) {
    return { error: mixCheck.error };
  }

  return { snapshots };
}

function getNextSequentialPlateNumberGenerator(
  existingJobs: readonly ProductionJob[],
  projectId: string,
  colorId: string
): () => number {
  const used = new Set(
    existingJobs
      .filter((j) => j.projectId === projectId && j.colorId === colorId)
      .map((j) => j.plateNumber)
  );
  let cursor = 1;
  return () => {
    while (used.has(cursor)) {
      cursor += 1;
    }
    const chosen = cursor;
    used.add(chosen);
    cursor += 1;
    return chosen;
  };
}

/**
 * Generates plate previews for a Product Studio category using `categoryPlateSettings`.
 * - NEVER assumes `138` capacity for unknown categories!
 * - In `automatic_capacity` mode, requires `plateSetting.plateCapacity >= 1`.
 * - Products in the SAME `categoryId` share plates up to `plateCapacity`.
 * - Products from DIFFERENT `categoryId`s are strictly rejected.
 */
export function generateAutomaticCatalogPlatePreviews(params: {
  existingJobs: readonly ProductionJob[];
  project: ProductionProject;
  color: ColorOption;
  category: ProductCategory;
  products: readonly CatalogProduct[];
  selections: readonly CatalogPlannerSelectionInput[];
  plateSetting: Pick<
    CategoryPlateSetting,
    'allocationMode' | 'plateCapacity' | 'defaultEstimatedMinutes'
  > | null;
  includePartialRemainderPlate?: boolean;
  nowMs?: number;
}): CatalogPlateGenerationResult {
  const resolved = resolveCatalogSnapshotsFromSelections({
    category: params.category,
    products: params.products,
    selections: params.selections,
    color: params.color,
  });
  if (resolved.error || !resolved.snapshots) {
    return { error: resolved.error };
  }

  // Strictly block automatic capacity splitting if the category has no configured capacity (never assume 138!)
  const rawCap = params.plateSetting?.plateCapacity ?? null;
  if (rawCap === null || !Number.isFinite(rawCap) || Math.floor(rawCap) < 1) {
    return {
      error: `No plate capacity is configured for "${params.category.name}" yet. Configure a Max Units per Plate rule for this category or switch to Manual Plate Composition (138 is never assumed for custom categories).`,
    };
  }

  const safeCap = Math.floor(rawCap);
  const safeMins = Math.max(
    1,
    Math.round(params.plateSetting?.defaultEstimatedMinutes || 180)
  );
  const includePartial = params.includePartialRemainderPlate !== false;
  const nowMs = params.nowMs ?? Date.now();

  const pool = resolved.snapshots.map((s) => ({ ...s }));
  const totalUnits = countCatalogItems(pool);
  const fullPlateCount = Math.floor(totalUnits / safeCap);
  const remainderUnits = totalUnits % safeCap;

  const nextPlateNumber = getNextSequentialPlateNumberGenerator(
    params.existingJobs,
    params.project.id,
    params.color.id
  );

  const previews: DraftCatalogPlatePreview[] = [];

  const fillOnePlate = (targetRoom: number, isPartial: boolean, idx: number) => {
    let room = targetRoom;
    const plateItems: JobCatalogItemSnapshot[] = [];

    // Sort larger remaining quantities first for clean grouping within the same category
    pool.sort((a, b) => b.quantity - a.quantity);

    for (const candidate of pool) {
      if (room <= 0) break;
      if (candidate.quantity <= 0) continue;
      const take = Math.min(candidate.quantity, room);
      if (take > 0) {
        plateItems.push({
          ...candidate,
          quantity: take,
        });
        candidate.quantity -= take;
        room -= take;
      }
    }

    if (plateItems.length === 0) return;

    const unitSum = countCatalogItems(plateItems);
    const estMins = isPartial
      ? Math.max(15, Math.round((unitSum / safeCap) * safeMins))
      : safeMins;

    previews.push({
      tempId: `cat-draft-${nowMs}-${idx}`,
      plateNumber: nextPlateNumber(),
      categoryId: params.category.id,
      categoryName: params.category.name,
      capacity: safeCap,
      items: plateItems,
      estimatedMinutes: estMins,
      slicerVerified: false,
      notes: isPartial
        ? `${params.category.name} partial plate (${unitSum}/${safeCap} pcs · verify layout in Bambu Studio)`
        : `${params.category.name} plate (${unitSum}/${safeCap} pcs · verify layout in Bambu Studio)`,
    });
  };

  for (let p = 0; p < fullPlateCount; p += 1) {
    fillOnePlate(safeCap, false, p);
  }

  if (includePartial && remainderUnits > 0) {
    fillOnePlate(remainderUnits, true, fullPlateCount);
  }

  return {
    previews,
    totalUnits,
    fullPlateCount,
    remainderUnits,
  };
}

/**
 * Validates and builds plate previews from manual per-plate composition in Auto Plate Planner
 * (used when a category has no fixed numeric capacity or the operator prefers custom per-plate grouping).
 */
export function buildManualCatalogPlatePreviews(params: {
  existingJobs: readonly ProductionJob[];
  project: ProductionProject;
  color: ColorOption;
  category: ProductCategory;
  products: readonly CatalogProduct[];
  manualPlates: readonly {
    selections: readonly CatalogPlannerSelectionInput[];
    estimatedMinutes: number;
    slicerVerified?: boolean;
    notes?: string;
  }[];
  configuredCapacity?: number | null;
  nowMs?: number;
}): CatalogPlateGenerationResult {
  const catCheck = validateCategoryForPlanning(params.category);
  if (!catCheck.ok) {
    return { error: catCheck.error };
  }

  if (!params.manualPlates.length) {
    return { error: 'Add at least one manual plate before generating preview.' };
  }

  const nextPlateNumber = getNextSequentialPlateNumberGenerator(
    params.existingJobs,
    params.project.id,
    params.color.id
  );
  const nowMs = params.nowMs ?? Date.now();
  const previews: DraftCatalogPlatePreview[] = [];
  let totalUnits = 0;

  for (let i = 0; i < params.manualPlates.length; i += 1) {
    const mp = params.manualPlates[i];
    const resolved = resolveCatalogSnapshotsFromSelections({
      category: params.category,
      products: params.products,
      selections: mp.selections,
      color: params.color,
    });
    if (resolved.error || !resolved.snapshots) {
      return { error: `Manual Plate ${i + 1}: ${resolved.error}` };
    }

    const unitsOnPlate = countCatalogItems(resolved.snapshots);
    const cap =
      params.configuredCapacity !== null &&
      params.configuredCapacity !== undefined &&
      params.configuredCapacity >= 1
        ? Math.floor(params.configuredCapacity)
        : null;

    if (cap !== null && unitsOnPlate > cap) {
      return {
        error: `Manual Plate ${i + 1} has ${unitsOnPlate} pcs, exceeding the configured category capacity of ${cap} pcs.`,
      };
    }

    totalUnits += unitsOnPlate;
    previews.push({
      tempId: `cat-manual-${nowMs}-${i}`,
      plateNumber: nextPlateNumber(),
      categoryId: params.category.id,
      categoryName: params.category.name,
      capacity: cap,
      items: resolved.snapshots,
      estimatedMinutes: Math.max(1, Math.round(mp.estimatedMinutes || 180)),
      slicerVerified: Boolean(mp.slicerVerified),
      notes:
        mp.notes?.trim() ||
        `${params.category.name} manual plate (${unitsOnPlate} pcs · verify layout in Bambu Studio)`,
    });
  }

  return {
    previews,
    totalUnits,
    fullPlateCount: previews.length,
    remainderUnits: 0,
  };
}

/**
 * Confirms staged Product Studio category plates into `ProductionWorkspaceV5` (`workspace.jobs`):
 * - Re-validates category status (active) and strict single-`categoryId` homogeneity on every plate!
 * - Stores immutable `JobCatalogItemSnapshot[]` on each `ProductionJob` so future product edits/renames/archives never corrupt Print Queue history.
 * - Never auto-assigns a machine (`machineId: null`) and never auto-starts printing (`Planned` or `Ready to Print` if slicerVerified).
 * - Preserves 100% of existing jobs, projects, machines, countdowns, and inventory.
 */
export function commitCatalogPlatesToWorkspace(
  workspace: ProductionWorkspaceV5,
  params: {
    projectId: string;
    colorId: string;
    category: ProductCategory;
    confirmedPlates: readonly DraftCatalogPlatePreview[];
    nowMs?: number;
  }
): {
  nextWorkspace?: ProductionWorkspaceV5;
  createdJobs?: ProductionJob[];
  error?: string;
} {
  const project = workspace.projects.find((p) => p.id === params.projectId);
  const color = workspace.colors.find((c) => c.id === params.colorId);
  if (!project || !color) {
    return { error: 'Project or filament color not found.' };
  }
  if (project.status === 'Archived') {
    return { error: 'Cannot add print plates to an archived project.' };
  }

  const catCheck = validateCategoryForPlanning(params.category);
  if (!catCheck.ok) {
    return { error: catCheck.error };
  }

  if (!params.confirmedPlates.length) {
    return { error: 'No confirmed plates to add to Print Queue.' };
  }

  const nowMs = params.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const timezone = workspace.settings?.timezone || DEFAULT_TIMEZONE;
  const sessionId = `catplan-${nowMs}-${Math.random().toString(36).slice(2, 7)}`;

  const createdJobs: ProductionJob[] = [];

  for (let idx = 0; idx < params.confirmedPlates.length; idx += 1) {
    const draft = params.confirmedPlates[idx];
    if (draft.categoryId !== params.category.id) {
      return {
        error: `Cross-category plate confirmation blocked on Plate ${draft.plateNumber}: expected category ID "${params.category.id}", received "${draft.categoryId}".`,
      };
    }

    const mixCheck = validateSameCategoryPlateItems(draft.items, params.category.id);
    if (!mixCheck.valid) {
      return { error: `Plate ${draft.plateNumber}: ${mixCheck.error}` };
    }

    const unitTotal = countCatalogItems(draft.items);
    if (unitTotal <= 0) {
      return {
        error: `Plate ${draft.plateNumber} has 0 items. Enter at least 1 unit before confirming.`,
      };
    }

    if (draft.capacity !== null && draft.capacity >= 1 && unitTotal > draft.capacity) {
      return {
        error: `Plate ${draft.plateNumber} (${unitTotal} pcs) exceeds configured category capacity of ${draft.capacity} pcs.`,
      };
    }

    // Snapshot immutable fields cleanly (zero undefined)
    const immutableSnapshots: JobCatalogItemSnapshot[] = draft.items
      .filter((item) => Math.floor(Number(item.quantity || 0)) > 0)
      .map((item) => ({
        productId: item.productId.trim(),
        productName: item.productName.trim(),
        sku: item.sku.trim().toUpperCase(),
        categoryId: params.category.id,
        categoryName: params.category.name.trim(),
        variantId: item.variantId ? item.variantId.trim() : null,
        variantLabel: item.variantLabel ? item.variantLabel.trim() : null,
        colorId: color.id,
        colorName: color.name,
        quantity: Math.floor(Number(item.quantity)),
      }));

    const effectivePlateCapacity =
      draft.capacity !== null && draft.capacity >= 1 ? Math.floor(draft.capacity) : unitTotal;

    const job: ProductionJob = {
      id: `job-${nowMs}-${idx}-${color.id}`,
      projectId: project.id,
      colorId: color.id,
      plateNumber: draft.plateNumber,
      plateCapacity: effectivePlateCapacity,
      letters: {},
      plateMode: 'catalog_category',
      planningSessionId: sessionId,
      categoryId: params.category.id,
      categoryNameSnapshot: params.category.name.trim(),
      catalogItems: immutableSnapshots,
      stage: draft.slicerVerified ? 'Ready to Print' : 'Planned',
      machineId: null, // Never auto-assign machine
      estimatedMinutes: Math.max(1, Math.round(draft.estimatedMinutes || 180)),
      actualMinutes: 0,
      slicerVerified: Boolean(draft.slicerVerified),
      stockApplied: false,
      stockTransactionId: null,
      failedCount: 0,
      failureReason: '',
      notes:
        draft.notes?.trim() ||
        `Product Studio · ${params.category.name} (${unitTotal} pcs)`,
      createdIso: nowIso,
      updatedIso: nowIso,
      completedIso: null,
    };

    createdJobs.push(job);
  }

  const totalConfirmedUnits = createdJobs.reduce(
    (sum, j) => sum + countCatalogItems(j.catalogItems),
    0
  );

  // Ensure color is in project.assignedColorIds if not already assigned
  const nextProjects = workspace.projects.map((p) => {
    if (p.id !== project.id) return p;
    const hasColor = p.assignedColorIds.includes(color.id);
    if (hasColor) return p;
    return {
      ...p,
      assignedColorIds: [...p.assignedColorIds, color.id],
      updatedIso: nowIso,
    };
  });

  const logMsg = `${project.name} · ${color.name} (${params.category.name}): Added ${createdJobs.length} plate(s) (${totalConfirmedUnits} pcs) from Product Studio.`;

  return {
    createdJobs,
    nextWorkspace: {
      ...workspace,
      projects: nextProjects,
      jobs: [...workspace.jobs, ...createdJobs],
      log: [
        createActivityLogEntry({
          category: 'plate',
          msg: logMsg,
          projectId: project.id,
          nowMs,
          timezone,
        }),
        ...workspace.log,
      ].slice(0, 200),
      updatedIso: nowIso,
    },
  };
}

/**
 * Pure independent batch plate planner for Built-in Alphabet (A–Z) OR Built-in Charm Keycaps:
 * - Treats `batchLetters` / `batchCharms` as NEW quantities to plan right now (independent of historical completed production!).
 * - Enforces Category-Based Plate Mixing: `'alphabet_only'` plans ONLY A–Z letters; `'charm_only'` plans ONLY Charm keycaps (never mixing A–Z and Charm on the same plate when category isolation is active).
 * - Never forces completed quantities as locked minimum inputs.
 */
export function generateIndependentKeycapBatchPreviews(params: {
  existingJobs: readonly ProductionJob[];
  projectId: string;
  colorId: string;
  mode: 'alphabet_only' | 'charm_only';
  batchLetters?: LettersMap;
  batchCharms?: CharmsMap;
  capacity: number;
  defaultMinutesPerPlate: number;
  nowMs?: number;
}): {
  fullPlates: DraftPlatePreview[];
  remainderLetters: LettersMap;
  remainderCharms: CharmsMap;
  remainderCount: number;
  neededForNextFullPlate: number;
  totalRequestedCount: number;
} {
  const safeCap = Math.max(1, Math.floor(params.capacity || 138));
  const safeMins = Math.max(1, Math.round(params.defaultMinutesPerPlate || 195));
  const nowMs = params.nowMs ?? Date.now();

  const letterPool: LettersMap =
    params.mode === 'alphabet_only'
      ? normalizeAlphabetMap(params.batchLetters)
      : emptyAlphabetMap();
  const charmPool: Record<CharmId, number> =
    params.mode === 'charm_only'
      ? normalizeCharmsMap(params.batchCharms)
      : emptyCharmsMap();

  const totalRequestedCount =
    countLetters(letterPool) + countCharms(charmPool);
  const fullPlateCount = Math.floor(totalRequestedCount / safeCap);
  const remainderCount = totalRequestedCount % safeCap;
  const neededForNextFullPlate = remainderCount === 0 ? 0 : safeCap - remainderCount;

  const nextPlateNumber = getNextSequentialPlateNumberGenerator(
    params.existingJobs,
    params.projectId,
    params.colorId
  );

  const fullPlates: DraftPlatePreview[] = [];

  for (let p = 0; p < fullPlateCount; p += 1) {
    let room = safeCap;
    const plateLetters: LettersMap = {};
    const plateCharms: CharmsMap = {};

    if (params.mode === 'alphabet_only') {
      const sortedLetters = ABC.filter((l) => (letterPool[l] || 0) > 0).sort(
        (a, b) => (letterPool[b] || 0) - (letterPool[a] || 0) || ABC.indexOf(a) - ABC.indexOf(b)
      );
      for (const letter of sortedLetters) {
        if (room <= 0) break;
        const take = Math.min(letterPool[letter] || 0, room);
        if (take > 0) {
          plateLetters[letter] = take;
          letterPool[letter] -= take;
          room -= take;
        }
      }
    } else {
      const sortedCharms = CHARM_IDS.filter((cid) => (charmPool[cid] || 0) > 0).sort(
        (a, b) =>
          (charmPool[b] || 0) - (charmPool[a] || 0) ||
          CHARM_IDS.indexOf(a) - CHARM_IDS.indexOf(b)
      );
      for (const cid of sortedCharms) {
        if (room <= 0) break;
        const take = Math.min(charmPool[cid] || 0, room);
        if (take > 0) {
          plateCharms[cid] = take;
          charmPool[cid] -= take;
          room -= take;
        }
      }
    }

    const compactedL = compactLettersMap(plateLetters);
    const compactedC = compactCharmsMap(plateCharms);
    fullPlates.push({
      tempId: `batch-draft-${nowMs}-${p}`,
      plateNumber: nextPlateNumber(),
      capacity: safeCap,
      letters: compactedL,
      charms: compactedC,
      plateMode: inferPlateMode(compactedL, compactedC),
      estimatedMinutes: safeMins,
      slicerVerified: false,
      notes: '',
    });
  }

  return {
    fullPlates,
    remainderLetters: compactLettersMap(letterPool),
    remainderCharms: compactCharmsMap(charmPool),
    remainderCount,
    neededForNextFullPlate,
    totalRequestedCount,
  };
}

/**
 * Helper to validate that a Built-in Keycap staged plate does not violate
 * single-category plate isolation (A–Z letters and Charm keycaps must not mix on new plates).
 */
export function validateBuiltInPlateCategoryIsolation(
  plate: Pick<DraftPlatePreview, 'plateNumber' | 'letters' | 'charms'>,
  expectedMode: PlateGenerationMode
): { valid: boolean; error?: string } {
  const lCount = countLetters(plate.letters);
  const cCount = countCharms(plate.charms);

  if (lCount > 0 && cCount > 0) {
    return {
      valid: false,
      error: `Cross-category plate mixing blocked on Plate ${plate.plateNumber}: Alphabet Keycaps and Charm Keycaps belong to different categories and cannot share one plate.`,
    };
  }
  if (expectedMode === 'alphabet_only' && cCount > 0) {
    return {
      valid: false,
      error: `Plate ${plate.plateNumber} contains Charm Keycaps while planning Alphabet Keycaps.`,
    };
  }
  if (expectedMode === 'charm_only' && lCount > 0) {
    return {
      valid: false,
      error: `Plate ${plate.plateNumber} contains Alphabet Keycaps while planning Charm Keycaps.`,
    };
  }
  return { valid: true };
}
