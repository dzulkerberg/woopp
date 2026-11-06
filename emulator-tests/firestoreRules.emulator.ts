import fs from 'node:fs';
import path from 'node:path';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshWorkspaceV5, emptyAlphabetMap, emptyCharmsMap } from '../src/constants';
import {
  CatalogProduct,
  CatalogSkuReservation,
  CatalogVariantDoc,
  CategoryPlateSetting,
  LegacyTrackerState,
  ProductCategory,
  ProductionJob,
  ProductionProject,
} from '../src/types';
import {
  prepareCategoryForFirestore,
  prepareCategoryPlateSettingForFirestore,
  prepareProductForFirestore,
  prepareSkuReservationForFirestore,
  prepareVariantDocForFirestore,
} from '../src/utils/catalogValidation';
import {
  buildFirestoreSetDocPayload,
  prepareWorkspaceForFirestore,
} from '../src/utils/firestorePayload';

const PROJECT_ID = 'demo-woopp-6';
const OWNER_UID = 'owner-woopp-admin-1';
const ATTACKER_UID = 'attacker-other-user-2';
const ANON_UID = 'anon-visitor-3';
const NOW_ISO = '2026-10-31T09:00:00.000Z';
const LATER_ISO = '2026-10-31T10:30:00.000Z';

let testEnv: RulesTestEnvironment;

function ownerDb() {
  return testEnv
    .authenticatedContext(OWNER_UID, {
      email: 'hellodzul@gmail.com',
      firebase: { sign_in_provider: 'password' },
    })
    .firestore();
}

function attackerDb() {
  return testEnv
    .authenticatedContext(ATTACKER_UID, {
      email: 'intruder@example.com',
      firebase: { sign_in_provider: 'password' },
    })
    .firestore();
}

function anonymousDb() {
  return testEnv
    .authenticatedContext(ANON_UID, {
      firebase: { sign_in_provider: 'anonymous' },
    })
    .firestore();
}

function unauthDb() {
  return testEnv.unauthenticatedContext().firestore();
}

function makeValidCategory(overrides: Partial<ProductCategory> = {}): ProductCategory {
  return prepareCategoryForFirestore(
    {
      id: 'cat-keychains',
      ownerId: OWNER_UID,
      name: '3D Printed Keychains',
      description: 'Custom dual-color and multi-layer keychains',
      imageUrl: 'https://cdn.wooppartcraft.com/categories/keychains.webp',
      iconName: 'key',
      sortOrder: 0,
      status: 'active',
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
      ...overrides,
    },
    OWNER_UID
  );
}

function makeValidProduct(overrides: Partial<CatalogProduct> = {}): CatalogProduct {
  return prepareProductForFirestore(
    {
      id: 'prod-floral-tag',
      ownerId: OWNER_UID,
      sku: 'WOOPP-AB12CD34',
      name: 'Floral Name Keyring',
      description: 'Custom 3D printed keyring with raised pastel lettering.',
      categoryId: 'cat-keychains',
      priceMyr: 18.5,
      images: [
        'https://cdn.wooppartcraft.com/products/floral-1.jpg',
        'https://cdn.wooppartcraft.com/products/floral-2.jpg',
      ],
      options: [
        {
          id: 'opt-size',
          name: 'Size',
          values: ['Standard', 'Large'],
          sortOrder: 0,
        },
      ],
      variants: [
        {
          id: 'var-standard',
          label: 'Standard',
          optionValues: { Size: 'Standard' },
          priceMyr: 18.5,
          imageUrl: 'https://cdn.wooppartcraft.com/products/floral-std.jpg',
          sortOrder: 0,
        },
        {
          id: 'var-large',
          label: 'Large',
          optionValues: { Size: 'Large' },
          priceMyr: 22.0,
          imageUrl: null,
          sortOrder: 1,
        },
      ],
      status: 'active',
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
      ...overrides,
    },
    OWNER_UID
  );
}

function makeValidSkuReservation(
  sku: string,
  productId: string,
  overrides: Partial<CatalogSkuReservation> = {}
): CatalogSkuReservation {
  return prepareSkuReservationForFirestore(
    {
      sku,
      ownerId: OWNER_UID,
      productId,
      createdAt: NOW_ISO,
      ...overrides,
    },
    OWNER_UID
  );
}

beforeAll(async () => {
  const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
  const rules = fs.readFileSync(rulesPath, 'utf8');
  const envHostPort = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:18080';
  const [host, rawPort] = envHostPort.split(':');
  const port = Number(rawPort) || 18080;

  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host,
      port,
      rules,
    },
  });
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

afterAll(async () => {
  if (testEnv) {
    await testEnv.cleanup();
  }
});

describe('Official Firebase Firestore Emulator Verification — WOOPP Products 6.0', () => {
  // ---------------------------------------------------------------------------
  // 1. Rules Compilation & Default-Deny Verification
  // ---------------------------------------------------------------------------
  describe('1. Firestore Rules Loading & Global Default-Deny', () => {
    it('loads actual firestore.rules into the emulator and enforces global default-deny on unknown paths', async () => {
      const db = ownerDb();
      await assertFails(getDoc(doc(db, 'systemConfig', 'secrets')));
      await assertFails(setDoc(doc(db, 'systemConfig', 'secrets'), { ok: true }));
      await assertFails(getDoc(doc(db, 'users', OWNER_UID, 'unknownCollection', 'doc-1')));
      await assertFails(
        setDoc(doc(db, 'users', OWNER_UID, 'unknownCollection', 'doc-1'), { ok: true })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Category, Plate Settings & Product Creation / Update Verification
  // ---------------------------------------------------------------------------
  describe('2. Category Creation, Plate Settings & Product Lifecycle', () => {
    it('creates, reads, lists, updates, archives, and restores product categories', async () => {
      const db = ownerDb();
      const category = makeValidCategory();
      const catRef = doc(db, 'users', OWNER_UID, 'catalogCategories', category.id);

      await assertSucceeds(setDoc(catRef, category));

      const snap = await assertSucceeds(getDoc(catRef));
      expect(snap.exists()).toBe(true);
      expect(snap.data()?.name).toBe('3D Printed Keychains');

      // Filtered list query matching productStudioService.ts
      const listSnap = await assertSucceeds(
        getDocs(
          query(
            collection(db, 'users', OWNER_UID, 'catalogCategories'),
            where('ownerId', '==', OWNER_UID)
          )
        )
      );
      expect(listSnap.size).toBe(1);

      // Update & archive category preserving immutable id, ownerId, createdAt
      await assertSucceeds(
        updateDoc(catRef, {
          name: 'Custom Keychains & Tags',
          sortOrder: 2,
          status: 'archived',
          updatedAt: LATER_ISO,
        })
      );

      // Restore category back to active
      await assertSucceeds(
        updateDoc(catRef, {
          status: 'active',
          updatedAt: '2026-10-31T11:00:00.000Z',
        })
      );
    });

    it('creates and updates catalogPlateSettings for an owned category (including when category is later archived)', async () => {
      const db = ownerDb();
      const category = makeValidCategory();
      const catRef = doc(db, 'users', OWNER_UID, 'catalogCategories', category.id);
      await assertSucceeds(setDoc(catRef, category));

      const plateSetting: CategoryPlateSetting = prepareCategoryPlateSettingForFirestore(
        {
          categoryId: category.id,
          ownerId: OWNER_UID,
          allocationMode: 'automatic_capacity',
          plateCapacity: 24,
          defaultEstimatedMinutes: 195,
          updatedAt: NOW_ISO,
        },
        OWNER_UID
      );
      const settingRef = doc(
        db,
        'users',
        OWNER_UID,
        'catalogPlateSettings',
        category.id
      );

      await assertSucceeds(setDoc(settingRef, plateSetting));

      // Archive category and verify existing plate setting remains updatable
      await assertSucceeds(
        updateDoc(catRef, { status: 'archived', updatedAt: LATER_ISO })
      );
      await assertSucceeds(
        updateDoc(settingRef, {
          allocationMode: 'manual_plate',
          plateCapacity: null,
          defaultEstimatedMinutes: 210,
          updatedAt: LATER_ISO,
        })
      );
    });

    it('creates a max-bound product (12 HTTPS images, 4 options within budget, 12 variants) within real emulator expression/depth limits and supports updates', async () => {
      const db = ownerDb();
      const cat1 = makeValidCategory({ id: 'cat-1' });
      const cat2 = makeValidCategory({ id: 'cat-2', name: 'Desk Organizers', sortOrder: 1 });
      await assertSucceeds(
        setDoc(doc(db, 'users', OWNER_UID, 'catalogCategories', cat1.id), cat1)
      );
      await assertSucceeds(
        setDoc(doc(db, 'users', OWNER_UID, 'catalogCategories', cat2.id), cat2)
      );

      const twelveImages = Array.from(
        { length: 12 },
        (_, i) => `https://cdn.wooppartcraft.com/gallery/img-${i + 1}.webp`
      );
      const fourOptions = [
        { id: 'opt-1', name: 'Size', values: ['S', 'M', 'L'], sortOrder: 0 },
        { id: 'opt-2', name: 'Finish', values: ['Matte', 'Silk', 'Gloss'], sortOrder: 1 },
        { id: 'opt-3', name: 'Ring', values: ['Gold', 'Silver'], sortOrder: 2 },
        { id: 'opt-4', name: 'Box', values: ['Standard', 'Gift'], sortOrder: 3 }, // total values = 3+3+2+2 = 10 <= budget 10
      ];
      const twelveVariants = Array.from({ length: 12 }, (_, idx) => ({
        id: `var-max-${idx + 1}`,
        label: `Combo #${idx + 1}`,
        optionValues: {
          Size: idx % 2 === 0 ? 'S' : 'M',
          Finish: 'Matte',
          Ring: 'Gold',
          Box: 'Gift',
        },
        priceMyr: 15 + idx * 1.5,
        imageUrl:
          idx % 2 === 0
            ? `https://cdn.wooppartcraft.com/variants/v-${idx + 1}.jpg`
            : null,
        sortOrder: idx,
      }));

      const maxProduct = makeValidProduct({
        id: 'prod-max-bounds',
        categoryId: cat1.id,
        sku: 'WOOPP-MAX99999',
        images: twelveImages,
        options: fourOptions,
        variants: twelveVariants,
      });
      const skuRes = makeValidSkuReservation(maxProduct.sku, maxProduct.id);

      const batch = writeBatch(db);
      batch.set(doc(db, 'users', OWNER_UID, 'catalogProducts', maxProduct.id), maxProduct);
      batch.set(doc(db, 'users', OWNER_UID, 'catalogSkus', maxProduct.sku), skuRes);
      await assertSucceeds(batch.commit());

      // Update product: edit mutable fields, move to active cat2, archive & restore
      const prodRef = doc(db, 'users', OWNER_UID, 'catalogProducts', maxProduct.id);
      await assertSucceeds(
        updateDoc(prodRef, {
          name: 'Updated Max Bounds Product',
          description: 'Updated description after atomic creation.',
          categoryId: cat2.id,
          priceMyr: 29.9,
          status: 'archived',
          updatedAt: LATER_ISO,
        })
      );

      const updatedSnap = await assertSucceeds(getDoc(prodRef));
      expect(updatedSnap.data()?.sku).toBe('WOOPP-MAX99999');
      expect(updatedSnap.data()?.categoryId).toBe(cat2.id);
      expect(updatedSnap.data()?.status).toBe('archived');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Atomic Product + SKU Transactions & Integrity
  // ---------------------------------------------------------------------------
  describe('3. Atomic Product + SKU Transactions & Two-Way Integrity', () => {
    beforeEach(async () => {
      const db = ownerDb();
      const cat = makeValidCategory();
      await setDoc(doc(db, 'users', OWNER_UID, 'catalogCategories', cat.id), cat);
    });

    it('commits atomic runTransaction creating catalogProducts + catalogSkus together (exact client flow)', async () => {
      const db = ownerDb();
      const product = makeValidProduct({
        id: 'prod-tx-1',
        sku: 'WOOPP-TX000001',
      });
      const reservation = makeValidSkuReservation(product.sku, product.id);

      const catRef = doc(db, 'users', OWNER_UID, 'catalogCategories', product.categoryId);
      const prodRef = doc(db, 'users', OWNER_UID, 'catalogProducts', product.id);
      const skuRef = doc(db, 'users', OWNER_UID, 'catalogSkus', product.sku);

      await assertSucceeds(
        runTransaction(db, async (tx) => {
          const [catSnap, prodSnap, skuSnap] = await Promise.all([
            tx.get(catRef),
            tx.get(prodRef),
            tx.get(skuRef),
          ]);
          expect(catSnap.exists()).toBe(true);
          expect(prodSnap.exists()).toBe(false);
          expect(skuSnap.exists()).toBe(false);

          tx.set(skuRef, reservation);
          tx.set(prodRef, product);
        })
      );

      const [savedProd, savedSku] = await Promise.all([
        getDoc(prodRef),
        getDoc(skuRef),
      ]);
      expect(savedProd.exists()).toBe(true);
      expect(savedSku.exists()).toBe(true);
      expect(savedSku.data()?.productId).toBe(product.id);
      expect(savedProd.data()?.sku).toBe(product.sku);
    });

    it('rejects standalone product creation without atomic SKU reservation', async () => {
      const db = ownerDb();
      const product = makeValidProduct({
        id: 'prod-standalone',
        sku: 'WOOPP-ORPHAN01',
      });
      await assertFails(
        setDoc(doc(db, 'users', OWNER_UID, 'catalogProducts', product.id), product)
      );
    });

    it('rejects standalone orphaned SKU reservation without atomic product creation', async () => {
      const db = ownerDb();
      const reservation = makeValidSkuReservation('WOOPP-ORPHAN02', 'prod-missing');
      await assertFails(
        setDoc(doc(db, 'users', OWNER_UID, 'catalogSkus', reservation.sku), reservation)
      );
    });

    it('rejects atomic batch when SKU registry productId mismatches the created product ID', async () => {
      const db = ownerDb();
      const product = makeValidProduct({
        id: 'prod-real-id',
        sku: 'WOOPP-MISMATCH',
      });
      const mismatchedReservation = makeValidSkuReservation(
        'WOOPP-MISMATCH',
        'prod-wrong-id'
      );

      const batch = writeBatch(db);
      batch.set(doc(db, 'users', OWNER_UID, 'catalogProducts', product.id), product);
      batch.set(
        doc(db, 'users', OWNER_UID, 'catalogSkus', mismatchedReservation.sku),
        mismatchedReservation
      );
      await assertFails(batch.commit());
    });

    it('rejects duplicate SKU reuse on a second product and preserves original product & SKU', async () => {
      const db = ownerDb();
      const firstProduct = makeValidProduct({
        id: 'prod-first',
        sku: 'WOOPP-DUP00001',
      });
      const firstSku = makeValidSkuReservation('WOOPP-DUP00001', 'prod-first');

      const b1 = writeBatch(db);
      b1.set(doc(db, 'users', OWNER_UID, 'catalogProducts', firstProduct.id), firstProduct);
      b1.set(doc(db, 'users', OWNER_UID, 'catalogSkus', firstSku.sku), firstSku);
      await assertSucceeds(b1.commit());

      // Attempt second product hijacking WOOPP-DUP00001
      const secondProduct = makeValidProduct({
        id: 'prod-second',
        sku: 'WOOPP-DUP00001',
      });
      const hijackedSku = makeValidSkuReservation('WOOPP-DUP00001', 'prod-second');

      const b2 = writeBatch(db);
      b2.set(
        doc(db, 'users', OWNER_UID, 'catalogProducts', secondProduct.id),
        secondProduct
      );
      b2.set(doc(db, 'users', OWNER_UID, 'catalogSkus', hijackedSku.sku), hijackedSku);
      await assertFails(b2.commit());

      // Verify original SKU reservation still points to prod-first
      const skuSnap = await assertSucceeds(
        getDoc(doc(db, 'users', OWNER_UID, 'catalogSkus', 'WOOPP-DUP00001'))
      );
      expect(skuSnap.data()?.productId).toBe('prod-first');
    });

    it('handles concurrent transactions safely (same SKU -> exactly 1 succeeds; distinct SKUs -> both succeed)', async () => {
      const db = ownerDb();

      // Case A: Two concurrent transactions racing for the exact same SKU
      const pA = makeValidProduct({ id: 'prod-race-a', sku: 'WOOPP-RACE0001' });
      const pB = makeValidProduct({ id: 'prod-race-b', sku: 'WOOPP-RACE0001' });

      const raceResults = await Promise.allSettled([
        runTransaction(db, async (tx) => {
          const skuRef = doc(db, 'users', OWNER_UID, 'catalogSkus', 'WOOPP-RACE0001');
          const prodRef = doc(db, 'users', OWNER_UID, 'catalogProducts', pA.id);
          const skuSnap = await tx.get(skuRef);
          if (skuSnap.exists()) throw new Error('SKU already exists');
          tx.set(skuRef, makeValidSkuReservation('WOOPP-RACE0001', pA.id));
          tx.set(prodRef, pA);
        }),
        runTransaction(db, async (tx) => {
          const skuRef = doc(db, 'users', OWNER_UID, 'catalogSkus', 'WOOPP-RACE0001');
          const prodRef = doc(db, 'users', OWNER_UID, 'catalogProducts', pB.id);
          const skuSnap = await tx.get(skuRef);
          if (skuSnap.exists()) throw new Error('SKU already exists');
          tx.set(skuRef, makeValidSkuReservation('WOOPP-RACE0001', pB.id));
          tx.set(prodRef, pB);
        }),
      ]);

      const fulfilled = raceResults.filter((r) => r.status === 'fulfilled');
      const rejected = raceResults.filter((r) => r.status === 'rejected');
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      // Case B: Two concurrent transactions with distinct SKUs both succeed
      const pC = makeValidProduct({ id: 'prod-conc-c', sku: 'WOOPP-CONC0001' });
      const pD = makeValidProduct({ id: 'prod-conc-d', sku: 'WOOPP-CONC0002' });

      await assertSucceeds(
        Promise.all([
          runTransaction(db, async (tx) => {
            const skuRef = doc(db, 'users', OWNER_UID, 'catalogSkus', pC.sku);
            const prodRef = doc(db, 'users', OWNER_UID, 'catalogProducts', pC.id);
            await tx.get(skuRef);
            tx.set(skuRef, makeValidSkuReservation(pC.sku, pC.id));
            tx.set(prodRef, pC);
          }),
          runTransaction(db, async (tx) => {
            const skuRef = doc(db, 'users', OWNER_UID, 'catalogSkus', pD.sku);
            const prodRef = doc(db, 'users', OWNER_UID, 'catalogProducts', pD.id);
            await tx.get(skuRef);
            tx.set(skuRef, makeValidSkuReservation(pD.sku, pD.id));
            tx.set(prodRef, pD);
          }),
        ])
      );
    });

    it('enforces SKU immutability on both catalogSkus and catalogProducts', async () => {
      const db = ownerDb();
      const prod = makeValidProduct({ id: 'prod-imm', sku: 'WOOPP-IMMUT001' });
      const skuRes = makeValidSkuReservation(prod.sku, prod.id);

      const batch = writeBatch(db);
      batch.set(doc(db, 'users', OWNER_UID, 'catalogProducts', prod.id), prod);
      batch.set(doc(db, 'users', OWNER_UID, 'catalogSkus', prod.sku), skuRes);
      await assertSucceeds(batch.commit());

      // Cannot update or delete SKU registry entry
      await assertFails(
        updateDoc(doc(db, 'users', OWNER_UID, 'catalogSkus', prod.sku), {
          productId: 'other-prod',
        })
      );
      await assertFails(deleteDoc(doc(db, 'users', OWNER_UID, 'catalogSkus', prod.sku)));

      // Cannot mutate SKU on existing product
      await assertFails(
        updateDoc(doc(db, 'users', OWNER_UID, 'catalogProducts', prod.id), {
          sku: 'WOOPP-IMMUT999',
          updatedAt: LATER_ISO,
        })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Unauthorized Access & Invalid Data Rejection
  // ---------------------------------------------------------------------------
  describe('4. Unauthorized Access & Invalid Data Rejection', () => {
    beforeEach(async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const adminDb = ctx.firestore();
        const cat = makeValidCategory();
        const prod = makeValidProduct();
        const skuRes = makeValidSkuReservation(prod.sku, prod.id);
        await setDoc(doc(adminDb, 'users', OWNER_UID, 'catalogCategories', cat.id), cat);
        await setDoc(doc(adminDb, 'users', OWNER_UID, 'catalogProducts', prod.id), prod);
        await setDoc(doc(adminDb, 'users', OWNER_UID, 'catalogSkus', skuRes.sku), skuRes);
      });
    });

    it('rejects unauthenticated access across all legacy, workspace, and Product Studio paths', async () => {
      const db = unauthDb();
      await assertFails(getDoc(doc(db, 'users', OWNER_UID, 'tracker', 'main')));
      await assertFails(getDoc(doc(db, 'users', OWNER_UID, 'tracker', 'v5_workspace')));
      await assertFails(
        getDoc(doc(db, 'users', OWNER_UID, 'catalogCategories', 'cat-keychains'))
      );
      await assertFails(
        getDoc(doc(db, 'users', OWNER_UID, 'catalogProducts', 'prod-floral-tag'))
      );
      await assertFails(
        getDoc(doc(db, 'users', OWNER_UID, 'catalogSkus', 'WOOPP-AB12CD34'))
      );
      await assertFails(
        getDocs(
          query(
            collection(db, 'users', OWNER_UID, 'catalogProducts'),
            where('ownerId', '==', OWNER_UID)
          )
        )
      );
    });

    it('rejects anonymous Firebase Auth accounts even on their own UID path', async () => {
      const db = anonymousDb();
      await assertFails(
        setDoc(doc(db, 'users', ANON_UID, 'tracker', 'main'), {
          colors: [],
          machines: [],
          jobs: [],
          log: [],
        })
      );
      await assertFails(
        setDoc(doc(db, 'users', ANON_UID, 'catalogCategories', 'cat-anon'), {
          id: 'cat-anon',
          ownerId: ANON_UID,
          name: 'Anon Cat',
          description: '',
          imageUrl: null,
          iconName: 'tag',
          sortOrder: 0,
          status: 'active',
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
        })
      );
    });

    it('rejects cross-UID reads, list queries, and writes from another signed-in user', async () => {
      const db = attackerDb();
      await assertFails(
        getDoc(doc(db, 'users', OWNER_UID, 'catalogCategories', 'cat-keychains'))
      );
      await assertFails(
        getDoc(doc(db, 'users', OWNER_UID, 'catalogProducts', 'prod-floral-tag'))
      );
      await assertFails(
        getDocs(
          query(
            collection(db, 'users', OWNER_UID, 'catalogProducts'),
            where('ownerId', '==', OWNER_UID)
          )
        )
      );
      await assertFails(
        updateDoc(doc(db, 'users', OWNER_UID, 'catalogProducts', 'prod-floral-tag'), {
          name: 'Tampered Name',
          updatedAt: LATER_ISO,
        })
      );
      await assertFails(getDoc(doc(db, 'users', OWNER_UID, 'tracker', 'v5_workspace')));
    });

    it('rejects base64 data: URIs, http:// URLs, and invalid fields at BOTH index 0 and index 11 of images & variants', async () => {
      const db = ownerDb();

      // 1. Base64 image in category
      const badCategory = {
        ...makeValidCategory({ id: 'cat-bad-img' }),
        imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA',
      };
      await assertFails(
        setDoc(doc(db, 'users', OWNER_UID, 'catalogCategories', 'cat-bad-img'), badCategory)
      );

      // 2. Insecure http:// URL at images[11] (last slot of 12-image gallery)
      const imagesBadAt11 = Array.from(
        { length: 12 },
        (_, i) =>
          i === 11
            ? 'http://insecure.example.com/bad-slot-12.jpg'
            : `https://cdn.wooppartcraft.com/products/ok-${i}.jpg`
      );
      const prodBadImg11 = {
        ...makeValidProduct({ id: 'prod-bad-img11', sku: 'WOOPP-BADIMG11' }),
        images: imagesBadAt11,
      };
      const bImg = writeBatch(db);
      bImg.set(
        doc(db, 'users', OWNER_UID, 'catalogProducts', prodBadImg11.id),
        prodBadImg11
      );
      bImg.set(
        doc(db, 'users', OWNER_UID, 'catalogSkus', prodBadImg11.sku),
        makeValidSkuReservation(prodBadImg11.sku, prodBadImg11.id)
      );
      await assertFails(bImg.commit());

      // 3. Invalid variant at variants[11] (e.g. negative priceMyr or http:// imageUrl)
      const variantsBadAt11 = Array.from({ length: 12 }, (_, idx) => ({
        id: `var-check-${idx}`,
        label: `Option ${idx}`,
        optionValues: { Size: 'Standard' },
        priceMyr: idx === 11 ? -5 : 15,
        imageUrl: null,
        sortOrder: idx,
      }));
      const prodBadVar11 = {
        ...makeValidProduct({ id: 'prod-bad-var11', sku: 'WOOPP-BADVAR11' }),
        variants: variantsBadAt11,
      };
      const bVar = writeBatch(db);
      bVar.set(
        doc(db, 'users', OWNER_UID, 'catalogProducts', prodBadVar11.id),
        prodBadVar11
      );
      bVar.set(
        doc(db, 'users', OWNER_UID, 'catalogSkus', prodBadVar11.sku),
        makeValidSkuReservation(prodBadVar11.sku, prodBadVar11.id)
      );
      await assertFails(bVar.commit());
    });

    it('rejects invalid option definitions, archived/missing target categories, shadow keys, and delete operations', async () => {
      const db = ownerDb();

      // Create an archived category
      const archivedCat = makeValidCategory({
        id: 'cat-archived',
        status: 'archived',
      });
      await assertSucceeds(
        setDoc(doc(db, 'users', OWNER_UID, 'catalogCategories', archivedCat.id), archivedCat)
      );

      // Cannot create product inside an archived category
      const prodInArchived = makeValidProduct({
        id: 'prod-in-arch',
        sku: 'WOOPP-ARCH0001',
        categoryId: archivedCat.id,
      });
      const bArch = writeBatch(db);
      bArch.set(
        doc(db, 'users', OWNER_UID, 'catalogProducts', prodInArchived.id),
        prodInArchived
      );
      bArch.set(
        doc(db, 'users', OWNER_UID, 'catalogSkus', prodInArchived.sku),
        makeValidSkuReservation(prodInArchived.sku, prodInArchived.id)
      );
      await assertFails(bArch.commit());

      // Cannot reassign an existing product to an archived category
      await assertFails(
        updateDoc(doc(db, 'users', OWNER_UID, 'catalogProducts', 'prod-floral-tag'), {
          categoryId: archivedCat.id,
          updatedAt: LATER_ISO,
        })
      );

      // Cannot inject invalid option (e.g. non-integer sortOrder or empty values)
      await assertFails(
        updateDoc(doc(db, 'users', OWNER_UID, 'catalogProducts', 'prod-floral-tag'), {
          options: [
            {
              id: 'opt-bad',
              name: 'Material',
              values: [],
              sortOrder: 0,
            },
          ],
          updatedAt: LATER_ISO,
        })
      );

      // Cannot inject unexpected shadow field on category or product
      await assertFails(
        updateDoc(doc(db, 'users', OWNER_UID, 'catalogCategories', 'cat-keychains'), {
          isAdminOverride: true,
          updatedAt: LATER_ISO,
        })
      );

      // Delete operations are strictly denied across catalogCategories & catalogProducts
      await assertFails(
        deleteDoc(doc(db, 'users', OWNER_UID, 'catalogCategories', 'cat-keychains'))
      );
      await assertFails(
        deleteDoc(doc(db, 'users', OWNER_UID, 'catalogProducts', 'prod-floral-tag'))
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Existing tracker/main and tracker/v5_workspace Read/Write Compatibility
  // ---------------------------------------------------------------------------
  describe('5. Legacy tracker/main & WOOPP 5.0/6.0 tracker/v5_workspace Compatibility', () => {
    it('preserves full read, create, and update compatibility on users/{uid}/tracker/main while blocking deletes & invalid keys', async () => {
      const db = ownerDb();
      const mainRef = doc(db, 'users', OWNER_UID, 'tracker', 'main');

      // Initial boot read when document does not yet exist must succeed
      const emptySnap = await assertSucceeds(getDoc(mainRef));
      expect(emptySnap.exists()).toBe(false);

      const legacyPayload: LegacyTrackerState = {
        colors: [{ id: 'col-black', name: 'Matte Black', hex: '#181B1B' }],
        machines: [{ id: 'm1', name: 'Bambu P1S #1', status: 'Idle' }],
        jobs: [
          {
            id: 'legacy-job-1',
            plate: 1,
            color: 'col-black',
            machine: 'm1',
            letters: emptyAlphabetMap(),
            done: false,
            note: 'Legacy v1 plate',
            created: '31/10/2026',
          },
        ],
        log: [{ t: '31/10/2026 09:00', m: 'Created legacy job' }],
      };

      await assertSucceeds(setDoc(mainRef, legacyPayload));

      const readSnap = await assertSucceeds(getDoc(mainRef));
      expect(readSnap.exists()).toBe(true);
      expect(readSnap.data()?.jobs).toHaveLength(1);

      // Update legacy job completion
      await assertSucceeds(
        updateDoc(mainRef, {
          jobs: [{ ...legacyPayload.jobs[0], done: true }],
          log: [
            ...legacyPayload.log,
            { t: '31/10/2026 09:45', m: 'Completed legacy job' },
          ],
        })
      );

      // Reject unexpected extra key or delete
      await assertFails(
        setDoc(mainRef, {
          ...legacyPayload,
          extraField: 'not-allowed',
        })
      );
      await assertFails(deleteDoc(mainRef));
    });

    it('preserves full read, create, and update compatibility on users/{uid}/tracker/v5_workspace (with & without serverTimestamp and with WOOPP 6.0 catalogItems jobs)', async () => {
      const db = ownerDb();
      const v5Ref = doc(db, 'users', OWNER_UID, 'tracker', 'v5_workspace');

      // 1. Initial boot read on non-existent v5_workspace must succeed
      const initialSnap = await assertSucceeds(getDoc(v5Ref));
      expect(initialSnap.exists()).toBe(false);

      // 2. Create fresh v5_workspace using exact production serializer + serverTimestamp()
      const freshWs = createFreshWorkspaceV5(OWNER_UID);
      const validatedCreate = prepareWorkspaceForFirestore(freshWs, OWNER_UID, {
        documentLabel: v5Ref.path,
      });
      const createPayload = buildFirestoreSetDocPayload(
        {
          ...validatedCreate,
          serverUpdatedAt: serverTimestamp(),
        },
        v5Ref.path
      );
      await assertSucceeds(setDoc(v5Ref, createPayload));

      const createdSnap = await assertSucceeds(getDoc(v5Ref));
      expect(createdSnap.exists()).toBe(true);
      expect(createdSnap.data()?.schemaVersion).toBe(5);
      expect(createdSnap.data()?.ownerId).toBe(OWNER_UID);
      const existingServerTime = createdSnap.data()?.serverUpdatedAt;
      expect(existingServerTime).toBeTruthy();

      // 3. Update v5_workspace containing a project and WOOPP 6.0 catalogItems job
      const primaryColor = freshWs.colors[0];
      const sampleProject: ProductionProject = {
        id: 'proj-oct-1',
        name: 'Klebang Weekend Batch',
        salesChannel: 'Klebang Walk',
        priority: 'High',
        deadline: '2026-11-05',
        productType: '3D Printed Keychains',
        plateCapacity: 24,
        assignedColorIds: [primaryColor.id],
        targetsByColor: {
          [primaryColor.id]: { ...emptyAlphabetMap(), A: 12, B: 8 },
        },
        carryForwardByColor: {},
        allocatedStockByColor: {},
        status: 'Active',
        notes: 'Urgent weekend dispatch',
        createdIso: NOW_ISO,
        updatedIso: LATER_ISO,
      };

      const catalogPlateJob: ProductionJob = {
        id: 'job-cat-plate-1',
        projectId: sampleProject.id,
        colorId: primaryColor.id,
        plateNumber: 1,
        plateCapacity: 24,
        letters: emptyAlphabetMap(),
        stage: 'Ready to Print',
        machineId: freshWs.machines[0].id,
        estimatedMinutes: 180,
        actualMinutes: 0,
        slicerVerified: true,
        stockApplied: false,
        stockTransactionId: null,
        failedCount: 0,
        failureReason: '',
        notes: 'Catalog-planned plate',
        createdIso: NOW_ISO,
        updatedIso: LATER_ISO,
        completedIso: null,
        plateMode: 'catalog_category',
        categoryId: 'cat-keychains',
        categoryNameSnapshot: '3D Printed Keychains',
        catalogItems: [
          {
            productId: 'prod-floral-tag',
            sku: 'WOOPP-AB12CD34',
            productName: 'Floral Name Keyring',
            categoryId: 'cat-keychains',
            categoryName: '3D Printed Keychains',
            variantId: 'var-standard',
            variantLabel: 'Standard',
            colorId: primaryColor.id,
            colorName: primaryColor.name,
            quantity: 12,
          },
        ],
      };

      const updatedWs = prepareWorkspaceForFirestore(
        {
          ...freshWs,
          projects: [sampleProject],
          jobs: [catalogPlateJob],
          updatedIso: LATER_ISO,
        },
        OWNER_UID,
        { documentLabel: v5Ref.path }
      );

      // 3a. Update with fresh serverTimestamp()
      await assertSucceeds(
        setDoc(
          v5Ref,
          buildFirestoreSetDocPayload(
            { ...updatedWs, serverUpdatedAt: serverTimestamp() },
            v5Ref.path
          )
        )
      );

      // 3b. Update preserving current serverUpdatedAt Timestamp on document
      const afterStep3aSnap = await assertSucceeds(getDoc(v5Ref));
      const currentServerTime = afterStep3aSnap.data()?.serverUpdatedAt;
      expect(currentServerTime).toBeTruthy();

      await assertSucceeds(
        setDoc(
          v5Ref,
          buildFirestoreSetDocPayload(
            { ...updatedWs, serverUpdatedAt: currentServerTime },
            v5Ref.path
          )
        )
      );

      // 3c. Update omitting serverUpdatedAt (12-key fallback mode)
      await assertSucceeds(
        setDoc(v5Ref, buildFirestoreSetDocPayload({ ...updatedWs }, v5Ref.path))
      );

      // 4. Reject spoofed arbitrary serverUpdatedAt Timestamp, tampered ownerId, and delete
      await assertFails(
        setDoc(v5Ref, {
          ...updatedWs,
          serverUpdatedAt: Timestamp.fromMillis(946684800000), // forged year 2000 timestamp
        })
      );
      await assertFails(
        setDoc(v5Ref, {
          ...updatedWs,
          ownerId: ATTACKER_UID,
        })
      );
      await assertFails(deleteDoc(v5Ref));
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Focused Adversarial Security Audit — List.join() & hasOnly() Batching
  // ---------------------------------------------------------------------------
  describe('6. Focused Adversarial Audit — List.join() & hasOnly() Batching (Options 0..3 & Variants 0..11)', () => {
    beforeEach(async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const adminDb = ctx.firestore();
        const cat = makeValidCategory();
        const prod = makeValidProduct();
        const skuRes = makeValidSkuReservation(prod.sku, prod.id);
        await setDoc(doc(adminDb, 'users', OWNER_UID, 'catalogCategories', cat.id), cat);
        await setDoc(doc(adminDb, 'users', OWNER_UID, 'catalogProducts', prod.id), prod);
        await setDoc(doc(adminDb, 'users', OWNER_UID, 'catalogSkus', skuRes.sku), skuRes);
      });
    });

    it('rejects delimiter injection, whitespace/CR/LF tricks, List.join() ToString type coercion, and invalid sortOrder at EVERY option position 0..3 and value positions 0..11', async () => {
      const db = ownerDb();
      const prodRef = doc(db, 'users', OWNER_UID, 'catalogProducts', 'prod-floral-tag');

      const baseFourOptions = [
        { id: 'opt-0', name: 'Color', values: ['Black', 'White'], sortOrder: 0 },
        { id: 'opt-1', name: 'Size', values: ['S', 'M', 'L'], sortOrder: 1 },
        { id: 'opt-2', name: 'Finish', values: ['Matte', 'Silk'], sortOrder: 2 },
        { id: 'opt-3', name: 'Ring', values: ['Gold', 'Silver'], sortOrder: 3 },
      ];

      // Baseline valid 4-option update succeeds
      await assertSucceeds(
        updateDoc(prodRef, { options: baseFourOptions, updatedAt: LATER_ISO })
      );

      // Adversarial mutations tested at EVERY option index 0, 1, 2, 3 (in 4-option batching mode)
      const optionAttacks: Array<{
        label: string;
        mutate: (o: Record<string, unknown>) => Record<string, unknown>;
      }> = [
        // Delimiter injection (\n, \r, trailing-empty split trick)
        {
          label: 'newline delimiter injection in option.id',
          mutate: (o) => ({ ...o, id: 'opt-ok\n10000\nopt-fake' }),
        },
        {
          label: 'newline record-forging injection in option.name',
          mutate: (o) => ({ ...o, name: 'ValidName\n10000\nopt-forged\nForged' }),
        },
        {
          label: 'carriage-return injection in option.name',
          mutate: (o) => ({ ...o, name: 'Size\rInjected' }),
        },
        {
          label: 'newline injection inside option.values',
          mutate: (o) => ({ ...o, values: ['S\nM', 'L'] }),
        },
        {
          label: 'carriage-return injection inside option.values',
          mutate: (o) => ({ ...o, values: ['S\rM', 'L'] }),
        },
        {
          label: 'split("\\n") trailing-empty-element bypass attempt ["A\\nB", ""]',
          mutate: (o) => ({ ...o, values: ['S\nM', ''] }),
        },
        // Whitespace attacks
        {
          label: 'whitespace-only option.name',
          mutate: (o) => ({ ...o, name: '   ' }),
        },
        {
          label: 'tab-only option.name',
          mutate: (o) => ({ ...o, name: '\t' }),
        },
        {
          label: 'untrimmed leading/trailing space in option.name',
          mutate: (o) => ({ ...o, name: ' Size ' }),
        },
        {
          label: 'whitespace-only option value',
          mutate: (o) => ({ ...o, values: ['S', '   '] }),
        },
        {
          label: 'untrimmed leading/trailing space in option value',
          mutate: (o) => ({ ...o, values: [' S ', 'M'] }),
        },
        // Unexpected field types (CEL List.join() ToString coercion attacks!)
        {
          label: 'integer option.id (ToString coercion)',
          mutate: (o) => ({ ...o, id: 12345 }),
        },
        {
          label: 'boolean option.id (ToString coercion)',
          mutate: (o) => ({ ...o, id: true }),
        },
        {
          label: 'null option.id (ToString coercion)',
          mutate: (o) => ({ ...o, id: null }),
        },
        {
          label: 'integer option.name (ToString coercion)',
          mutate: (o) => ({ ...o, name: 999 }),
        },
        {
          label: 'boolean option.name (ToString coercion)',
          mutate: (o) => ({ ...o, name: false }),
        },
        {
          label: 'null option.name (ToString coercion)',
          mutate: (o) => ({ ...o, name: null }),
        },
        {
          label: 'integer inside option.values (ToString coercion)',
          mutate: (o) => ({ ...o, values: ['S', 123] }),
        },
        {
          label: 'boolean inside option.values (ToString coercion)',
          mutate: (o) => ({ ...o, values: [true, 'M'] }),
        },
        {
          label: 'null inside option.values (ToString coercion)',
          mutate: (o) => ({ ...o, values: ['S', null] }),
        },
        {
          label: 'nested map inside option.values',
          mutate: (o) => ({ ...o, values: ['S', { bad: 'map' }] }),
        },
        {
          label: 'non-list string option.values',
          mutate: (o) => ({ ...o, values: 'S,M' }),
        },
        // Invalid sortOrder values & shadow/missing keys
        {
          label: 'negative sortOrder (-1)',
          mutate: (o) => ({ ...o, sortOrder: -1 }),
        },
        {
          label: 'out-of-range sortOrder (10001)',
          mutate: (o) => ({ ...o, sortOrder: 10001 }),
        },
        {
          label: 'float sortOrder (1.5)',
          mutate: (o) => ({ ...o, sortOrder: 1.5 }),
        },
        {
          label: 'string sortOrder ("0")',
          mutate: (o) => ({ ...o, sortOrder: '0' }),
        },
        {
          label: 'boolean sortOrder (true)',
          mutate: (o) => ({ ...o, sortOrder: true }),
        },
        {
          label: 'null sortOrder',
          mutate: (o) => ({ ...o, sortOrder: null }),
        },
        {
          label: 'extra shadow key on option',
          mutate: (o) => ({ ...o, shadowKey: 'x' }),
        },
      ];

      for (const optIdx of [0, 1, 2, 3]) {
        await Promise.all(
          optionAttacks.map(async (attack) => {
            const mutated = baseFourOptions.map((opt, idx) =>
              idx === optIdx ? attack.mutate({ ...opt }) : opt
            );
            await assertFails(
              updateDoc(prodRef, { options: mutated, updatedAt: LATER_ISO })
            );
          })
        );
      }

      // Also test single-option path (sz <= 3 -> isValidProductOptionAt) at values[0] AND values[11]
      const twelveValidVals = Array.from({ length: 12 }, (_, i) => `Style-${i + 1}`);
      await assertSucceeds(
        updateDoc(prodRef, {
          options: [{ id: 'opt-12v', name: 'Style', values: twelveValidVals, sortOrder: 0 }],
          updatedAt: LATER_ISO,
        })
      );

      for (const valIdx of [0, 5, 11]) {
        for (const badVal of [123, true, null, '', '   ', 'Bad\nVal', 'Bad\rVal', 'X'.repeat(81)]) {
          const vals = twelveValidVals.map((v, i) => (i === valIdx ? badVal : v));
          await assertFails(
            updateDoc(prodRef, {
              options: [{ id: 'opt-12v', name: 'Style', values: vals, sortOrder: 0 }],
              updatedAt: LATER_ISO,
            })
          );
        }
      }
    });

    it('rejects delimiter injection, whitespace, ToString type coercion, invalid prices/sortOrder, and malformed nested optionValues at EVERY variant position 0..11', async () => {
      const db = ownerDb();
      const prodRef = doc(db, 'users', OWNER_UID, 'catalogProducts', 'prod-floral-tag');

      const buildTwelveVariants = () =>
        Array.from({ length: 12 }, (_, idx) => ({
          id: `var-slot-${idx}`,
          label: `Combo Slot ${idx}`,
          optionValues: {
            Size: idx % 2 === 0 ? 'Standard' : 'Large',
            Finish: 'Matte',
          },
          priceMyr: idx % 3 === 0 ? null : 18.5 + idx,
          imageUrl:
            idx % 2 === 0
              ? `https://cdn.wooppartcraft.com/variants/slot-${idx}.webp`
              : null,
          sortOrder: idx,
        }));

      // Baseline valid 12-variant update succeeds
      await assertSucceeds(
        updateDoc(prodRef, { variants: buildTwelveVariants(), updatedAt: LATER_ISO })
      );

      const overlongHttpsUrl =
        'https://cdn.wooppartcraft.com/variants/' + 'a'.repeat(2020) + '.webp'; // > 2048 chars

      const variantAttacks: Array<{
        label: string;
        mutate: (v: Record<string, unknown>) => Record<string, unknown>;
      }> = [
        // 1. Delimiter injection (\n, \r, spaces)
        {
          label: 'newline record-forging injection in variant.label',
          mutate: (v) => ({
            ...v,
            label: 'Valid\n10000\nvar-forged\n10\nnull\nForged Label',
          }),
        },
        {
          label: 'carriage-return injection in variant.label',
          mutate: (v) => ({ ...v, label: 'Combo\rInjected' }),
        },
        {
          label: 'newline injection in variant.id',
          mutate: (v) => ({ ...v, id: 'var-ok\n10000' }),
        },
        {
          label: 'space injection in variant.imageUrl',
          mutate: (v) => ({
            ...v,
            imageUrl: 'https://cdn.wooppartcraft.com/a.jpg https://evil.example.com/b.jpg',
          }),
        },
        // 2. Whitespace & length overflows
        {
          label: 'whitespace-only variant.label',
          mutate: (v) => ({ ...v, label: '    ' }),
        },
        {
          label: 'tab-only variant.label',
          mutate: (v) => ({ ...v, label: '\t' }),
        },
        {
          label: 'untrimmed leading/trailing space in variant.label',
          mutate: (v) => ({ ...v, label: ' Combo ' }),
        },
        {
          label: 'variant.label > 200 chars',
          mutate: (v) => ({ ...v, label: 'L'.repeat(201) }),
        },
        {
          label: 'variant.imageUrl > 2048 chars',
          mutate: (v) => ({ ...v, imageUrl: overlongHttpsUrl }),
        },
        {
          label: 'space delimiter injection in variant.imageUrl',
          mutate: (v) => ({
            ...v,
            imageUrl: 'https://cdn.wooppartcraft.com/ok.jpg 10000 0 null',
          }),
        },
        // 3. Unexpected field types (including CEL List.join() ToString coercion!)
        {
          label: 'integer variant.id (ToString coercion)',
          mutate: (v) => ({ ...v, id: 12345 }),
        },
        {
          label: 'boolean variant.id (ToString coercion)',
          mutate: (v) => ({ ...v, id: true }),
        },
        {
          label: 'null variant.id (ToString coercion)',
          mutate: (v) => ({ ...v, id: null }),
        },
        {
          label: 'integer variant.label (ToString coercion)',
          mutate: (v) => ({ ...v, label: 999 }),
        },
        {
          label: 'boolean variant.label (ToString coercion)',
          mutate: (v) => ({ ...v, label: false }),
        },
        {
          label: 'null variant.label (ToString coercion)',
          mutate: (v) => ({ ...v, label: null }),
        },
        {
          label: 'string variant.priceMyr ("18.5")',
          mutate: (v) => ({ ...v, priceMyr: '18.5' }),
        },
        {
          label: 'string "null" variant.priceMyr',
          mutate: (v) => ({ ...v, priceMyr: 'null' }),
        },
        {
          label: 'boolean variant.priceMyr',
          mutate: (v) => ({ ...v, priceMyr: true }),
        },
        {
          label: 'string "null" variant.imageUrl',
          mutate: (v) => ({ ...v, imageUrl: 'null' }),
        },
        {
          label: 'integer variant.imageUrl',
          mutate: (v) => ({ ...v, imageUrl: 123 }),
        },
        {
          label: 'boolean variant.imageUrl',
          mutate: (v) => ({ ...v, imageUrl: false }),
        },
        // 4. Invalid prices & invalid sortOrder values
        {
          label: 'negative variant.priceMyr (-0.01)',
          mutate: (v) => ({ ...v, priceMyr: -0.01 }),
        },
        {
          label: 'excessive variant.priceMyr (10000001)',
          mutate: (v) => ({ ...v, priceMyr: 10000001 }),
        },
        {
          label: 'negative variant.sortOrder (-1)',
          mutate: (v) => ({ ...v, sortOrder: -1 }),
        },
        {
          label: 'excessive variant.sortOrder (10001)',
          mutate: (v) => ({ ...v, sortOrder: 10001 }),
        },
        {
          label: 'float variant.sortOrder (1.5)',
          mutate: (v) => ({ ...v, sortOrder: 1.5 }),
        },
        {
          label: 'string variant.sortOrder ("0")',
          mutate: (v) => ({ ...v, sortOrder: '0' }),
        },
        {
          label: 'boolean variant.sortOrder (true)',
          mutate: (v) => ({ ...v, sortOrder: true }),
        },
        {
          label: 'null variant.sortOrder',
          mutate: (v) => ({ ...v, sortOrder: null }),
        },
        // 5. Malformed nested variant.optionValues
        {
          label: 'non-map string optionValues',
          mutate: (v) => ({ ...v, optionValues: 'Size=Standard' }),
        },
        {
          label: 'non-map array optionValues',
          mutate: (v) => ({ ...v, optionValues: ['Standard'] }),
        },
        {
          label: 'null optionValues',
          mutate: (v) => ({ ...v, optionValues: null }),
        },
        {
          label: '>4 keys in optionValues',
          mutate: (v) => ({
            ...v,
            optionValues: { O1: 'A', O2: 'B', O3: 'C', O4: 'D', O5: 'E' },
          }),
        },
        {
          label: 'integer value inside optionValues (ToString coercion)',
          mutate: (v) => ({ ...v, optionValues: { Size: 123 } }),
        },
        {
          label: 'boolean value inside optionValues (ToString coercion)',
          mutate: (v) => ({ ...v, optionValues: { Size: true } }),
        },
        {
          label: 'null value inside optionValues (ToString coercion)',
          mutate: (v) => ({ ...v, optionValues: { Size: null } }),
        },
        {
          label: 'nested object inside optionValues',
          mutate: (v) => ({ ...v, optionValues: { Size: { nested: 'S' } } }),
        },
        {
          label: 'nested array inside optionValues',
          mutate: (v) => ({ ...v, optionValues: { Size: ['S'] } }),
        },
        {
          label: 'untrimmed leading/trailing space key in optionValues',
          mutate: (v) => ({ ...v, optionValues: { ' Size ': 'Standard' } }),
        },
        {
          label: 'whitespace-only key in optionValues',
          mutate: (v) => ({ ...v, optionValues: { '   ': 'Standard' } }),
        },
        {
          label: 'empty string value in optionValues',
          mutate: (v) => ({ ...v, optionValues: { Size: '' } }),
        },
        {
          label: 'whitespace-only value in optionValues',
          mutate: (v) => ({ ...v, optionValues: { Size: '   ' } }),
        },
        {
          label: 'newline injection in optionValues key',
          mutate: (v) => ({ ...v, optionValues: { 'Size\nColor': 'Standard' } }),
        },
        {
          label: 'newline injection in optionValues value',
          mutate: (v) => ({ ...v, optionValues: { Size: 'Standard\nLarge' } }),
        },
        {
          label: 'carriage-return injection in optionValues value',
          mutate: (v) => ({ ...v, optionValues: { Size: 'Standard\rLarge' } }),
        },
        {
          label: 'oversized >60-char key in optionValues',
          mutate: (v) => ({ ...v, optionValues: { ['K'.repeat(61)]: 'Standard' } }),
        },
        {
          label: 'oversized >80-char value in optionValues',
          mutate: (v) => ({ ...v, optionValues: { Size: 'V'.repeat(81) } }),
        },
        {
          label: 'extra shadow key on variant',
          mutate: (v) => ({ ...v, shadowVariantField: 1 }),
        },
      ];

      // Test EVERY SINGLE variant index 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11!
      for (let varIdx = 0; varIdx < 12; varIdx += 1) {
        await Promise.all(
          variantAttacks.map(async (attack) => {
            const mutated = buildTwelveVariants().map((v, idx) =>
              idx === varIdx ? attack.mutate({ ...v }) : v
            );
            await assertFails(
              updateDoc(prodRef, { variants: mutated, updatedAt: LATER_ISO })
            );
          })
        );
      }
    }, 30000);

    it('enforces identical validation across non-12 variant counts (1, 4, 5, 11), gallery/product-level edge cases, and preserves <1,000-expression headroom on max-bound 11- and 12-variant products', async () => {
      const db = ownerDb();
      const prodRef = doc(db, 'users', OWNER_UID, 'catalogProducts', 'prod-floral-tag');

      // 1. Test non-12 variant counts (sz = 1, 4, 5, 11) against malformed last-slot optionValues & non-string label
      for (const count of [1, 4, 5, 11]) {
        const validN = Array.from({ length: count }, (_, idx) => ({
          id: `var-n${count}-${idx}`,
          label: `Variant ${idx + 1}`,
          optionValues: { Size: 'Standard' },
          priceMyr: 19.9,
          imageUrl: null,
          sortOrder: idx,
        }));
        await assertSucceeds(
          updateDoc(prodRef, { variants: validN, updatedAt: LATER_ISO })
        );

        const badOptionValAtLast = validN.map((v, idx) =>
          idx === count - 1 ? { ...v, optionValues: { Size: 123 } } : v
        );
        await assertFails(
          updateDoc(prodRef, { variants: badOptionValAtLast, updatedAt: LATER_ISO })
        );

        const badLabelTypeAtLast = validN.map((v, idx) =>
          idx === count - 1 ? { ...v, label: 42 } : v
        );
        await assertFails(
          updateDoc(prodRef, { variants: badLabelTypeAtLast, updatedAt: LATER_ISO })
        );
      }

      // 2. Product-level & gallery delimiter / non-list / ToString coercion edge cases
      await assertFails(
        updateDoc(prodRef, {
          images: [
            'https://cdn.wooppartcraft.com/a.jpg https://cdn.wooppartcraft.com/b.jpg',
            '',
          ],
          updatedAt: LATER_ISO,
        })
      );
      await assertFails(updateDoc(prodRef, { images: '', updatedAt: LATER_ISO }));
      await assertFails(updateDoc(prodRef, { options: '', updatedAt: LATER_ISO }));
      await assertFails(updateDoc(prodRef, { variants: '', updatedAt: LATER_ISO }));
      await assertFails(updateDoc(prodRef, { name: '   ', updatedAt: LATER_ISO }));
      await assertFails(updateDoc(prodRef, { name: 'Line1\nLine2', updatedAt: LATER_ISO }));
      await assertFails(updateDoc(prodRef, { categoryId: 123, updatedAt: LATER_ISO }));
      await assertFails(updateDoc(prodRef, { priceMyr: '19.90', updatedAt: LATER_ISO }));

      // 3. Max-bound 11-variant AND 12-variant products (with 12 HTTPS images, 4 options, and 4 optionValues per variant)
      //    both create atomically AND update cleanly below the 1,000-expression limit!
      const twelveImages = Array.from(
        { length: 12 },
        (_, i) => `https://cdn.wooppartcraft.com/max-audit/img-${i + 1}.webp`
      );
      const fourMaxOptions = [
        {
          id: 'opt-a',
          name: 'Primary Color',
          values: ['Ivory', 'Charcoal', 'Sage', 'Blush'],
          sortOrder: 0,
        },
        { id: 'opt-b', name: 'Size', values: ['Small', 'Large'], sortOrder: 1 },
        { id: 'opt-c', name: 'Finish', values: ['Matte', 'Silk'], sortOrder: 2 },
        { id: 'opt-d', name: 'Hardware', values: ['Gold Ring', 'Silver Clasp'], sortOrder: 3 },
      ];

      for (const variantCount of [11, 12]) {
        const pid = `prod-audit-max-${variantCount}`;
        const sku = `WOOPP-AUD000${variantCount}`;
        const fullVariants = Array.from({ length: variantCount }, (_, idx) => ({
          id: `var-aud-${variantCount}-${idx}`,
          label: `Ivory / Small / Matte / Gold #${idx + 1}`,
          optionValues: {
            'Primary Color': 'Ivory',
            Size: idx % 2 === 0 ? 'Small' : 'Large',
            Finish: 'Matte',
            Hardware: 'Gold Ring',
          },
          priceMyr: 24.9 + idx,
          imageUrl: `https://cdn.wooppartcraft.com/max-audit/var-${idx + 1}.webp`,
          sortOrder: idx,
        }));

        const maxProd = makeValidProduct({
          id: pid,
          sku,
          images: twelveImages,
          options: fourMaxOptions,
          variants: fullVariants,
        });
        const skuDoc = makeValidSkuReservation(sku, pid);

        const batch = writeBatch(db);
        batch.set(doc(db, 'users', OWNER_UID, 'catalogProducts', pid), maxProd);
        batch.set(doc(db, 'users', OWNER_UID, 'catalogSkus', sku), skuDoc);
        await assertSucceeds(batch.commit());

        await assertSucceeds(
          updateDoc(doc(db, 'users', OWNER_UID, 'catalogProducts', pid), {
            name: `Verified Hardened Max ${variantCount}`,
            updatedAt: LATER_ISO,
          })
        );
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Scalable Alphabet A–Z & Multi-Color Variations (Subcollection & 26+ Option Values)
  // ---------------------------------------------------------------------------
  describe('7. Scalable Alphabet A–Z & Multi-Color Variations', () => {
    it('creates an Alphabet product with 26 letters (A–Z) and multiple colors, storing all 26 variants in the subcollection safely within emulator expression limits', async () => {
      const db = ownerDb();
      const cat = makeValidCategory({ id: 'cat-alphabet-keychains' });
      await assertSucceeds(
        setDoc(doc(db, 'users', OWNER_UID, 'catalogCategories', cat.id), cat)
      );

      const alphabetLetters = Array.from({ length: 26 }, (_, i) =>
        String.fromCharCode(65 + i)
      );
      const colors = ['White', 'Black', 'Red', 'Blue', 'Gold'];

      const alphabetProduct = makeValidProduct({
        id: 'prod-alphabet-series',
        sku: 'WOOPP-ALPHA026',
        categoryId: cat.id,
        name: 'WOOPP Alphabet Keychains (A–Z Collection)',
        options: [
          {
            id: 'opt-alphabet',
            name: 'Letter',
            values: alphabetLetters,
            sortOrder: 0,
          },
          {
            id: 'opt-colors',
            name: 'Filament Color',
            values: colors,
            sortOrder: 1,
          },
        ],
        variants: [], // Stored in dedicated subcollection for scalable architecture
      });

      const skuDoc = makeValidSkuReservation('WOOPP-ALPHA026', 'prod-alphabet-series');

      // 1. Atomically create product and SKU
      const productBatch = writeBatch(db);
      productBatch.set(
        doc(db, 'users', OWNER_UID, 'catalogProducts', alphabetProduct.id),
        alphabetProduct
      );
      productBatch.set(
        doc(db, 'users', OWNER_UID, 'catalogSkus', alphabetProduct.sku),
        skuDoc
      );
      await assertSucceeds(productBatch.commit());

      // 2. Create all 26 letter variants as individual documents in the subcollection
      const variantBatch = writeBatch(db);
      alphabetLetters.forEach((letter, idx) => {
        const vId = `var-letter-${letter.toLowerCase()}`;
        const vDoc = prepareVariantDocForFirestore(
          {
            id: vId,
            label: `Letter ${letter}`,
            optionValues: {
              Letter: letter,
              'Filament Color': colors[idx % colors.length],
            },
            priceMyr: 15.0 + (idx % 5),
            imageUrl: `https://cdn.wooppartcraft.com/alphabet/${letter}.webp`,
            sortOrder: idx,
          },
          OWNER_UID,
          alphabetProduct.id,
          { createdAt: NOW_ISO, updatedAt: NOW_ISO }
        );
        variantBatch.set(
          doc(
            db,
            'users',
            OWNER_UID,
            'catalogProducts',
            alphabetProduct.id,
            'variants',
            vId
          ),
          vDoc
        );
      });
      await assertSucceeds(variantBatch.commit());

      // 3. Read back and verify variant count and data
      const variantsSnap = await assertSucceeds(
        getDocs(
          collection(
            db,
            'users',
            OWNER_UID,
            'catalogProducts',
            alphabetProduct.id,
            'variants'
          )
        )
      );
      expect(variantsSnap.size).toBe(26);

      const zDocSnap = await assertSucceeds(
        getDoc(
          doc(
            db,
            'users',
            OWNER_UID,
            'catalogProducts',
            alphabetProduct.id,
            'variants',
            'var-letter-z'
          )
        )
      );
      expect(zDocSnap.exists()).toBe(true);
      expect(zDocSnap.data()?.label).toBe('Letter Z');

      // 4. Update variant in subcollection
      await assertSucceeds(
        updateDoc(
          doc(
            db,
            'users',
            OWNER_UID,
            'catalogProducts',
            alphabetProduct.id,
            'variants',
            'var-letter-z'
          ),
          {
            priceMyr: 19.99,
            imageUrl: 'https://cdn.wooppartcraft.com/alphabet/Z-gold.webp',
            updatedAt: LATER_ISO,
          }
        )
      );

      // 5. Security isolation: Attacker cannot read or write variants
      const badDb = attackerDb();
      await assertFails(
        getDoc(
          doc(
            badDb,
            'users',
            OWNER_UID,
            'catalogProducts',
            alphabetProduct.id,
            'variants',
            'var-letter-a'
          )
        )
      );
      await assertFails(
        setDoc(
          doc(
            badDb,
            'users',
            OWNER_UID,
            'catalogProducts',
            alphabetProduct.id,
            'variants',
            'var-hack'
          ),
          {
            id: 'var-hack',
            ownerId: ATTACKER_UID,
            productId: alphabetProduct.id,
            label: 'Hacked',
          }
        )
      );

      // 6. Security rejection: Invalid variant (negative price, non-HTTPS image, missing fields) rejected
      await assertFails(
        setDoc(
          doc(
            db,
            'users',
            OWNER_UID,
            'catalogProducts',
            alphabetProduct.id,
            'variants',
            'var-invalid'
          ),
          {
            id: 'var-invalid',
            ownerId: OWNER_UID,
            productId: alphabetProduct.id,
            label: 'Invalid',
            optionValues: {},
            priceMyr: -10,
            imageUrl: 'http://insecure.com/pic.jpg',
            sortOrder: 0,
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
          }
        )
      );
    });

    it('explicitly verifies atomic product + SKU creation across 12, 13, and 26 option values and distinguishes option values from variants', async () => {
      const db = ownerDb();
      const cat = makeValidCategory({ id: 'cat-boundary-test' });
      await assertSucceeds(
        setDoc(doc(db, 'users', OWNER_UID, 'catalogCategories', cat.id), cat)
      );

      const letters12 = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];
      const letters13 = [...letters12, 'M'];
      const letters26 = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));

      // 1. Boundary Test: Exactly 12 option values (12 embedded variants)
      const p12 = makeValidProduct({
        id: 'prod-opt-12',
        sku: 'WOOPP-OPT12001',
        categoryId: cat.id,
        options: [{ id: 'opt-l12', name: 'Letter', values: letters12, sortOrder: 0 }],
        variants: letters12.map((l, i) => ({
          id: `var-12-${i + 1}`,
          label: `Letter ${l}`,
          optionValues: { Letter: l },
          priceMyr: 10,
          imageUrl: null,
          sortOrder: i,
        })),
      });
      const s12 = makeValidSkuReservation(p12.sku, p12.id);

      const b12 = writeBatch(db);
      b12.set(doc(db, 'users', OWNER_UID, 'catalogProducts', p12.id), p12);
      b12.set(doc(db, 'users', OWNER_UID, 'catalogSkus', p12.sku), s12);
      await assertSucceeds(b12.commit());

      // 2. Boundary Test: Exactly 13 option values (crossing the old 12-value limit)
      // Note: With >12 variants, variants are saved in subcollection, leaving parent variants: []
      const p13 = makeValidProduct({
        id: 'prod-opt-13',
        sku: 'WOOPP-OPT13001',
        categoryId: cat.id,
        options: [{ id: 'opt-l13', name: 'Letter', values: letters13, sortOrder: 0 }],
        variants: [], // Scalable architecture: parent doc carries []
      });
      const s13 = makeValidSkuReservation(p13.sku, p13.id);

      const b13 = writeBatch(db);
      b13.set(doc(db, 'users', OWNER_UID, 'catalogProducts', p13.id), p13);
      b13.set(doc(db, 'users', OWNER_UID, 'catalogSkus', p13.sku), s13);
      await assertSucceeds(b13.commit());

      // Store 13th variant in subcollection
      const v13Doc = prepareVariantDocForFirestore(
        {
          id: 'var-13-m',
          label: 'Letter M',
          optionValues: { Letter: 'M' },
          priceMyr: 12,
          imageUrl: null,
          sortOrder: 12,
        },
        OWNER_UID,
        p13.id,
        { createdAt: NOW_ISO, updatedAt: NOW_ISO }
      );
      await assertSucceeds(
        setDoc(
          doc(db, 'users', OWNER_UID, 'catalogProducts', p13.id, 'variants', v13Doc.id),
          v13Doc
        )
      );

      // 3. Boundary Test: Exactly 26 option values (Full A–Z Alphabet)
      const p26 = makeValidProduct({
        id: 'prod-opt-26',
        sku: 'WOOPP-OPT26001',
        categoryId: cat.id,
        options: [{ id: 'opt-l26', name: 'Letter', values: letters26, sortOrder: 0 }],
        variants: [],
      });
      const s26 = makeValidSkuReservation(p26.sku, p26.id);

      const b26 = writeBatch(db);
      b26.set(doc(db, 'users', OWNER_UID, 'catalogProducts', p26.id), p26);
      b26.set(doc(db, 'users', OWNER_UID, 'catalogSkus', p26.sku), s26);
      await assertSucceeds(b26.commit());

      // 4. Distinction Test: Attempting 13 EMBEDDED variants on parent document
      // (Should be rejected by rules because parent document caps embedded variants at 12)
      const p13EmbeddedVariants = makeValidProduct({
        id: 'prod-opt-13-bad',
        sku: 'WOOPP-OPT13BAD',
        categoryId: cat.id,
        options: [{ id: 'opt-bad', name: 'Letter', values: letters13, sortOrder: 0 }],
        variants: letters13.map((l, i) => ({
          id: `var-bad-${i + 1}`,
          label: `Letter ${l}`,
          optionValues: { Letter: l },
          priceMyr: 10,
          imageUrl: null,
          sortOrder: i,
        })),
      });
      const s13Bad = makeValidSkuReservation(p13EmbeddedVariants.sku, p13EmbeddedVariants.id);
      const b13Bad = writeBatch(db);
      b13Bad.set(
        doc(db, 'users', OWNER_UID, 'catalogProducts', p13EmbeddedVariants.id),
        p13EmbeddedVariants
      );
      b13Bad.set(doc(db, 'users', OWNER_UID, 'catalogSkus', p13EmbeddedVariants.sku), s13Bad);
      // Rules correctly reject >12 embedded variants on parent doc to prevent 1,000-expression limit:
      await assertFails(b13Bad.commit());
    });
  });
});

