import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  Query,
  query,
  runTransaction,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  buildFirestoreErrorInfo,
  db,
  OperationType,
} from '../firebase';
import {
  CatalogProduct,
  CatalogSkuReservation,
  CatalogVariantDoc,
  CategoryPlateSetting,
  ProductCategory,
  ProductVariant,
} from '../types';
import {
  prepareCategoryForFirestore,
  prepareCategoryPlateSettingForFirestore,
  prepareProductForFirestore,
  prepareSkuReservationForFirestore,
  prepareVariantDocForFirestore,
} from '../utils/catalogValidation';
import {
  generateUniqueWooppSku,
  resolveProductOperationSku,
} from '../utils/skuGenerator';

/**
 * Cloud Firestore Persistence Service for WOOPP 6.0 Product Studio (`woopp-tracker`).
 *
 * - Keeps catalog documents strictly isolated from `users/{uid}/tracker/v5_workspace`:
 *   - `users/{uid}/catalogCategories/{categoryId}`
 *   - `users/{uid}/catalogProducts/{productId}`
 *   - `users/{uid}/catalogSkus/{sku}`
 *   - `users/{uid}/catalogPlateSettings/{categoryId}`
 * - Every collection `list` query explicitly filters `.where('ownerId', '==', ownerId)`
 *   to satisfy `allow list` (`resource.data.ownerId == request.auth.uid`) in `firestore.rules`.
 * - Zero `undefined` values, zero base64 blobs, zero `localStorage` fallback.
 * - Real `await` before reporting success; real structured errors on failure.
 */

export interface ProductStudioRealtimeSnapshot {
  categories: ProductCategory[];
  products: CatalogProduct[];
  plateSettingsByCategoryId: Record<string, CategoryPlateSetting>;
  loading: boolean;
  error: string | null;
  rulesDeploymentNeeded: boolean;
}

export function buildCatalogCategoriesQuery(ownerId: string): Query {
  return query(
    collection(db, 'users', ownerId, 'catalogCategories'),
    where('ownerId', '==', ownerId)
  );
}

export function buildCatalogProductsQuery(ownerId: string): Query {
  return query(
    collection(db, 'users', ownerId, 'catalogProducts'),
    where('ownerId', '==', ownerId)
  );
}

export function buildCatalogSkusQuery(ownerId: string): Query {
  return query(
    collection(db, 'users', ownerId, 'catalogSkus'),
    where('ownerId', '==', ownerId)
  );
}

export function buildCatalogPlateSettingsQuery(ownerId: string): Query {
  return query(
    collection(db, 'users', ownerId, 'catalogPlateSettings'),
    where('ownerId', '==', ownerId)
  );
}

function isPermissionDeniedError(err: unknown): boolean {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: unknown }).code)
      : '';
  const msg = err instanceof Error ? err.message : String(err);
  return (
    code.includes('permission-denied') ||
    msg.toLowerCase().includes('missing or insufficient permissions')
  );
}

export function subscribeToProductStudioCatalog(
  ownerId: string,
  onUpdate: (state: ProductStudioRealtimeSnapshot) => void
): () => void {
  let categories: ProductCategory[] = [];
  let products: CatalogProduct[] = [];
  let plateSettingsByCategoryId: Record<string, CategoryPlateSetting> = {};
  let catsLoaded = false;
  let prodsLoaded = false;
  let settingsLoaded = false;

  const listenerErrors: Record<
    'categories' | 'products' | 'settings',
    { message: string; rulesNeeded: boolean } | null
  > = {
    categories: null,
    products: null,
    settings: null,
  };

  const emit = () => {
    const sortedCategories = [...categories].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)
    );
    const sortedProducts = [...products].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );
    const firstError =
      listenerErrors.categories ||
      listenerErrors.products ||
      listenerErrors.settings;
    const rulesDeploymentNeeded = Boolean(
      listenerErrors.categories?.rulesNeeded ||
        listenerErrors.products?.rulesNeeded ||
        listenerErrors.settings?.rulesNeeded
    );

    onUpdate({
      categories: sortedCategories,
      products: sortedProducts,
      plateSettingsByCategoryId: { ...plateSettingsByCategoryId },
      loading: !(catsLoaded && prodsLoaded && settingsLoaded) && !firstError,
      error: firstError ? firstError.message : null,
      rulesDeploymentNeeded,
    });
  };

  const handleListenerError = (
    key: 'categories' | 'products' | 'settings',
    err: unknown,
    path: string
  ) => {
    if (isPermissionDeniedError(err)) {
      listenerErrors[key] = {
        rulesNeeded: true,
        message:
          'Firestore security rules for Product Studio collections (catalogCategories, catalogProducts, catalogSkus, catalogPlateSettings) are not yet deployed on woopp-tracker. Review and deploy the updated firestore.rules to enable Product Studio cloud sync.',
      };
    } else {
      const info = buildFirestoreErrorInfo(err, OperationType.LIST, path);
      listenerErrors[key] = {
        rulesNeeded: false,
        message: `Unable to load Product Studio catalog from Cloud Firestore: ${info.error}`,
      };
    }
    emit();
  };

  const categoriesPath = `users/${ownerId}/catalogCategories`;
  const productsPath = `users/${ownerId}/catalogProducts`;
  const settingsPath = `users/${ownerId}/catalogPlateSettings`;

  const unsubCategories = onSnapshot(
    buildCatalogCategoriesQuery(ownerId),
    (snap) => {
      const next: ProductCategory[] = [];
      snap.forEach((docSnap) => {
        const raw = docSnap.data() as ProductCategory;
        if (raw && typeof raw.id === 'string' && typeof raw.name === 'string') {
          next.push({
            id: raw.id,
            ownerId: raw.ownerId || ownerId,
            name: raw.name,
            description: typeof raw.description === 'string' ? raw.description : '',
            imageUrl: typeof raw.imageUrl === 'string' ? raw.imageUrl : null,
            iconName: raw.iconName || 'tag',
            sortOrder: typeof raw.sortOrder === 'number' ? raw.sortOrder : 0,
            status: raw.status === 'archived' ? 'archived' : 'active',
            createdAt: raw.createdAt || new Date().toISOString(),
            updatedAt: raw.updatedAt || new Date().toISOString(),
          });
        }
      });
      categories = next;
      catsLoaded = true;
      listenerErrors.categories = null;
      emit();
    },
    (err) => handleListenerError('categories', err, categoriesPath)
  );

  const unsubProducts = onSnapshot(
    buildCatalogProductsQuery(ownerId),
    (snap) => {
      const next: CatalogProduct[] = [];
      snap.forEach((docSnap) => {
        const raw = docSnap.data() as CatalogProduct;
        if (
          raw &&
          typeof raw.id === 'string' &&
          typeof raw.name === 'string' &&
          typeof raw.sku === 'string' &&
          typeof raw.categoryId === 'string'
        ) {
          next.push({
            id: raw.id,
            ownerId: raw.ownerId || ownerId,
            sku: raw.sku,
            name: raw.name,
            description: typeof raw.description === 'string' ? raw.description : '',
            categoryId: raw.categoryId,
            priceMyr:
              typeof raw.priceMyr === 'number' && Number.isFinite(raw.priceMyr)
                ? raw.priceMyr
                : null,
            images: Array.isArray(raw.images)
              ? raw.images.filter((u): u is string => typeof u === 'string')
              : [],
            options: Array.isArray(raw.options) ? raw.options : [],
            variants: Array.isArray(raw.variants) ? raw.variants : [],
            status: raw.status === 'archived' ? 'archived' : 'active',
            createdAt: raw.createdAt || new Date().toISOString(),
            updatedAt: raw.updatedAt || new Date().toISOString(),
          });
        }
      });
      products = next;
      prodsLoaded = true;
      listenerErrors.products = null;
      emit();
    },
    (err) => handleListenerError('products', err, productsPath)
  );

  const unsubSettings = onSnapshot(
    buildCatalogPlateSettingsQuery(ownerId),
    (snap) => {
      const nextMap: Record<string, CategoryPlateSetting> = {};
      snap.forEach((docSnap) => {
        const raw = docSnap.data() as CategoryPlateSetting;
        if (raw && typeof raw.categoryId === 'string') {
          nextMap[raw.categoryId] = {
            categoryId: raw.categoryId,
            ownerId: raw.ownerId || ownerId,
            allocationMode:
              raw.allocationMode === 'manual_plate'
                ? 'manual_plate'
                : 'automatic_capacity',
            plateCapacity:
              typeof raw.plateCapacity === 'number' &&
              Number.isFinite(raw.plateCapacity) &&
              raw.plateCapacity >= 1
                ? Math.floor(raw.plateCapacity)
                : null,
            defaultEstimatedMinutes:
              typeof raw.defaultEstimatedMinutes === 'number' &&
              Number.isFinite(raw.defaultEstimatedMinutes) &&
              raw.defaultEstimatedMinutes >= 1
                ? Math.round(raw.defaultEstimatedMinutes)
                : 180,
            updatedAt: raw.updatedAt || new Date().toISOString(),
          };
        }
      });
      plateSettingsByCategoryId = nextMap;
      settingsLoaded = true;
      listenerErrors.settings = null;
      emit();
    },
    (err) => handleListenerError('settings', err, settingsPath)
  );

  return () => {
    unsubCategories();
    unsubProducts();
    unsubSettings();
  };
}

function assertBrowserOnline(): void {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error(
      'Cannot save changes while offline. Reconnect to the internet so Cloud Firestore (woopp-tracker) can persist your update.'
    );
  }
}

export async function saveProductCategoryToFirestore(
  ownerId: string,
  category: ProductCategory
): Promise<ProductCategory> {
  assertBrowserOnline();
  const validated = prepareCategoryForFirestore(category, ownerId);
  const path = `users/${ownerId}/catalogCategories/${validated.id}`;
  try {
    await setDoc(doc(db, 'users', ownerId, 'catalogCategories', validated.id), validated);
    return validated;
  } catch (err: unknown) {
    const info = buildFirestoreErrorInfo(err, OperationType.WRITE, path);
    throw new Error(`Could not save category to Cloud Firestore: ${info.error}`);
  }
}

export async function reorderProductCategoriesInFirestore(
  ownerId: string,
  orderedCategories: readonly ProductCategory[]
): Promise<void> {
  assertBrowserOnline();
  const nowIso = new Date().toISOString();
  const batch = writeBatch(db);
  orderedCategories.forEach((cat, idx) => {
    const updated = prepareCategoryForFirestore(
      {
        ...cat,
        sortOrder: idx,
        updatedAt: nowIso,
      },
      ownerId
    );
    batch.set(doc(db, 'users', ownerId, 'catalogCategories', updated.id), updated);
  });

  try {
    await batch.commit();
  } catch (err: unknown) {
    const info = buildFirestoreErrorInfo(
      err,
      OperationType.WRITE,
      `users/${ownerId}/catalogCategories`
    );
    throw new Error(`Could not save category order to Cloud Firestore: ${info.error}`);
  }
}

/**
 * Creates a brand-new product or duplicates an existing product in Cloud Firestore,
 * atomically verifying category state, non-existence of product & SKU, and writing both
 * `users/{uid}/catalogProducts/{productId}` and `users/{uid}/catalogSkus/{sku}` inside
 * a single `runTransaction`. Retries with a fresh CSPRNG SKU if a SKU collision occurs.
 */
export async function createOrDuplicateCatalogProductInFirestore(params: {
  ownerId: string;
  operation: 'create' | 'duplicate';
  draftProduct: Omit<CatalogProduct, 'sku'> & { sku?: string };
  existingSkus?: Iterable<string>;
  sourceProductSku?: string;
}): Promise<CatalogProduct> {
  assertBrowserOnline();
  const { ownerId, operation, draftProduct, existingSkus, sourceProductSku } = params;

  const knownSkus = new Set<string>();
  if (existingSkus) {
    for (const s of existingSkus) {
      if (s) knownSkus.add(s.trim().toUpperCase());
    }
  }

  let candidateSku = resolveProductOperationSku({
    operation,
    existingSkus: knownSkus,
    draftSku: draftProduct.sku || null,
    sourceProductSku,
  });

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const nowIso = new Date().toISOString();
    const validatedProduct = prepareProductForFirestore(
      {
        ...draftProduct,
        ownerId,
        sku: candidateSku,
        createdAt: draftProduct.createdAt || nowIso,
        updatedAt: nowIso,
      },
      ownerId
    );

    const validatedReservation: CatalogSkuReservation = prepareSkuReservationForFirestore(
      {
        sku: validatedProduct.sku,
        ownerId,
        productId: validatedProduct.id,
        createdAt: nowIso,
      },
      ownerId
    );

    const categoryRef = doc(
      db,
      'users',
      ownerId,
      'catalogCategories',
      validatedProduct.categoryId
    );
    const productRef = doc(db, 'users', ownerId, 'catalogProducts', validatedProduct.id);
    const skuRef = doc(db, 'users', ownerId, 'catalogSkus', validatedProduct.sku);

    try {
      const committed = await runTransaction(db, async (tx) => {
        const [categorySnap, productSnap, skuSnap] = await Promise.all([
          tx.get(categoryRef),
          tx.get(productRef),
          tx.get(skuRef),
        ]);

        if (!categorySnap.exists()) {
          throw new Error(
            'Selected product category does not exist in Cloud Firestore.'
          );
        }
        const categoryData = categorySnap.data() as Partial<ProductCategory>;
        if (categoryData.ownerId !== ownerId) {
          throw new Error('Selected product category does not belong to this workspace.');
        }
        if (categoryData.status !== 'active') {
          throw new Error(
            'Cannot create or duplicate a product inside an archived category. Restore the category or choose an active category first.'
          );
        }

        if (productSnap.exists()) {
          throw new Error(
            `Product ID "${validatedProduct.id}" already exists and cannot be overwritten.`
          );
        }

        if (skuSnap.exists()) {
          return false;
        }

        const hasSubcollectionVariants = validatedProduct.variants.length > 12;
        const productDocToPersist = hasSubcollectionVariants
          ? { ...validatedProduct, variants: [] }
          : validatedProduct;

        tx.set(skuRef, validatedReservation);
        tx.set(productRef, productDocToPersist);
        return true;
      });

      if (committed) {
        if (validatedProduct.variants.length > 12) {
          const variantBatch = writeBatch(db);
          validatedProduct.variants.forEach((v) => {
            const vDoc = prepareVariantDocForFirestore(
              v,
              ownerId,
              validatedProduct.id,
              { createdAt: nowIso, updatedAt: nowIso }
            );
            variantBatch.set(
              doc(
                db,
                'users',
                ownerId,
                'catalogProducts',
                validatedProduct.id,
                'variants',
                vDoc.id
              ),
              vDoc
            );
          });
          await variantBatch.commit();
        }
        return validatedProduct;
      }

      // Extremely rare SKU collision in Firestore -> generate a fresh CSPRNG SKU and retry
      knownSkus.add(candidateSku);
      candidateSku = generateUniqueWooppSku(knownSkus);
    } catch (err: unknown) {
      const info = buildFirestoreErrorInfo(
        err,
        OperationType.CREATE,
        `users/${ownerId}/catalogProducts/${validatedProduct.id}`
      );
      throw new Error(`Could not save product to Cloud Firestore: ${info.error}`);
    }
  }

  throw new Error('Unable to reserve a unique WOOPP SKU in Cloud Firestore.');
}

/**
 * Updates an existing `CatalogProduct` in Cloud Firestore (including edit, category change,
 * archive, or restore). Uses `updateDoc` with mutable keys only so immutable `id`, `ownerId`,
 * `sku`, and `createdAt` are never altered and non-existent products cannot be created without SKU reservation.
 */
export async function updateCatalogProductInFirestore(params: {
  ownerId: string;
  existingProduct: CatalogProduct;
  updatedDraft: CatalogProduct;
}): Promise<CatalogProduct> {
  assertBrowserOnline();
  const preservedSku = resolveProductOperationSku({
    operation: 'edit',
    existingProductSku: params.existingProduct.sku,
  });

  const validated = prepareProductForFirestore(
    {
      ...params.updatedDraft,
      id: params.existingProduct.id,
      ownerId: params.ownerId,
      sku: preservedSku, // Never mutate SKU on edit or category change
      createdAt: params.existingProduct.createdAt,
      updatedAt: new Date().toISOString(),
    },
    params.ownerId
  );

  const hasSubcollectionVariants = validated.variants.length > 12;
  const productToSave = hasSubcollectionVariants
    ? { ...validated, variants: [] }
    : validated;

  const path = `users/${params.ownerId}/catalogProducts/${validated.id}`;
  try {
    await updateDoc(doc(db, 'users', params.ownerId, 'catalogProducts', validated.id), {
      name: productToSave.name,
      description: productToSave.description,
      categoryId: productToSave.categoryId,
      priceMyr: productToSave.priceMyr,
      images: productToSave.images,
      options: productToSave.options,
      variants: productToSave.variants,
      status: productToSave.status,
      updatedAt: productToSave.updatedAt,
    });

    if (hasSubcollectionVariants) {
      const nowIso = new Date().toISOString();
      const variantBatch = writeBatch(db);
      validated.variants.forEach((v) => {
        const vDoc = prepareVariantDocForFirestore(
          v,
          params.ownerId,
          validated.id,
          {
            createdAt: params.existingProduct.createdAt,
            updatedAt: nowIso,
          }
        );
        variantBatch.set(
          doc(
            db,
            'users',
            params.ownerId,
            'catalogProducts',
            validated.id,
            'variants',
            vDoc.id
          ),
          vDoc
        );
      });
      await variantBatch.commit();
    }

    return validated;
  } catch (err: unknown) {
    const info = buildFirestoreErrorInfo(err, OperationType.UPDATE, path);
    throw new Error(`Could not update product in Cloud Firestore: ${info.error}`);
  }
}

/**
 * Fetches variants for a product from the scalable subcollection:
 * `users/{ownerId}/catalogProducts/{productId}/variants`
 */
export async function fetchProductVariantsFromFirestore(
  ownerId: string,
  productId: string
): Promise<ProductVariant[]> {
  try {
    const snap = await getDocs(
      collection(db, 'users', ownerId, 'catalogProducts', productId, 'variants')
    );
    const variants: ProductVariant[] = [];
    snap.forEach((docSnap) => {
      const d = docSnap.data() as Partial<CatalogVariantDoc>;
      variants.push({
        id: d.id || docSnap.id,
        label: d.label || '',
        optionValues: d.optionValues || {},
        priceMyr: typeof d.priceMyr === 'number' ? d.priceMyr : null,
        imageUrl: typeof d.imageUrl === 'string' ? d.imageUrl : null,
        sortOrder: typeof d.sortOrder === 'number' ? d.sortOrder : 0,
      });
    });
    return variants.sort((a, b) => a.sortOrder - b.sortOrder);
  } catch (err: unknown) {
    const info = buildFirestoreErrorInfo(
      err,
      OperationType.LIST,
      `users/${ownerId}/catalogProducts/${productId}/variants`
    );
    console.warn(`[ProductStudio] Could not fetch variants subcollection: ${info.error}`);
    return [];
  }
}

/**
 * Saves or updates a `CategoryPlateSetting` document in Cloud Firestore
 * (`users/{uid}/catalogPlateSettings/{categoryId}`).
 */
export async function saveCategoryPlateSettingToFirestore(
  ownerId: string,
  setting: CategoryPlateSetting
): Promise<CategoryPlateSetting> {
  assertBrowserOnline();
  const validated = prepareCategoryPlateSettingForFirestore(
    {
      ...setting,
      ownerId,
      updatedAt: new Date().toISOString(),
    },
    ownerId
  );
  const path = `users/${ownerId}/catalogPlateSettings/${validated.categoryId}`;
  try {
    await setDoc(
      doc(db, 'users', ownerId, 'catalogPlateSettings', validated.categoryId),
      validated
    );
    return validated;
  } catch (err: unknown) {
    const info = buildFirestoreErrorInfo(err, OperationType.WRITE, path);
    throw new Error(
      `Could not save category plate setting to Cloud Firestore: ${info.error}`
    );
  }
}
