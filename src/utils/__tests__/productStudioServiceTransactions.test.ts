import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDoc = vi.fn((_db: unknown, ...segments: string[]) => ({
  path: segments.join('/'),
}));
const mockCollection = vi.fn((_db: unknown, ...segments: string[]) => ({
  path: segments.join('/'),
}));
const mockWhere = vi.fn((field: string, op: string, value: unknown) => ({
  field,
  op,
  value,
}));
const mockQuery = vi.fn((colRef: { path: string }, ...constraints: unknown[]) => ({
  type: 'query',
  path: colRef.path,
  constraints,
}));
const mockRunTransaction = vi.fn();
const mockUpdateDoc = vi.fn();
const mockSetDoc = vi.fn();
const mockOnSnapshot = vi.fn();
const mockWriteBatch = vi.fn();

vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  return {
    ...actual,
    collection: (...args: [unknown, ...string[]]) => mockCollection(...args),
    doc: (...args: [unknown, ...string[]]) => mockDoc(...args),
    where: (...args: [string, string, unknown]) => mockWhere(...args),
    query: (...args: [{ path: string }, ...unknown[]]) => mockQuery(...args),
    runTransaction: (...args: unknown[]) => mockRunTransaction(...args),
    updateDoc: (...args: unknown[]) => mockUpdateDoc(...args),
    setDoc: (...args: unknown[]) => mockSetDoc(...args),
    onSnapshot: (...args: unknown[]) => mockOnSnapshot(...args),
    writeBatch: (...args: unknown[]) => mockWriteBatch(...args),
  };
});

import {
  createOrDuplicateCatalogProductInFirestore,
  subscribeToProductStudioCatalog,
  updateCatalogProductInFirestore,
} from '../../services/productStudioService';
import type { CatalogProduct } from '../../types';

describe('Product Studio Firestore Transaction & Query Service Compliance', () => {
  const OWNER_UID = 'owner-woopp-admin';
  const NOW_ISO = '2026-10-31T08:00:00.000Z';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('subscribes to catalogCategories, catalogProducts, and catalogPlateSettings using ownerId == uid filtered queries', () => {
    mockOnSnapshot.mockReturnValue(() => undefined);

    const unsub = subscribeToProductStudioCatalog(OWNER_UID, () => undefined);
    expect(mockOnSnapshot).toHaveBeenCalledTimes(3);

    const subscribedPaths = mockOnSnapshot.mock.calls.map(
      (call) => (call[0] as { path: string }).path
    );
    expect(subscribedPaths).toEqual([
      `users/${OWNER_UID}/catalogCategories`,
      `users/${OWNER_UID}/catalogProducts`,
      `users/${OWNER_UID}/catalogPlateSettings`,
    ]);

    for (const call of mockOnSnapshot.mock.calls) {
      const q = call[0] as {
        type: string;
        constraints: Array<{ field: string; op: string; value: unknown }>;
      };
      expect(q.type).toBe('query');
      expect(q.constraints).toEqual([
        { field: 'ownerId', op: '==', value: OWNER_UID },
      ]);
    }

    unsub();
  });

  it('executes atomic runTransaction reading category, product, and SKU before writing matching catalogSkus + catalogProducts', async () => {
    const txSetCalls: Array<{ path: string; data: Record<string, unknown> }> = [];

    mockRunTransaction.mockImplementation(async (_db: unknown, cb: (tx: unknown) => Promise<boolean>) => {
      const tx = {
        get: vi.fn(async (ref: { path: string }) => {
          if (ref.path.includes('/catalogCategories/')) {
            return {
              exists: () => true,
              data: () => ({ id: 'cat-charms', ownerId: OWNER_UID, status: 'active' }),
            };
          }
          return {
            exists: () => false,
            data: () => undefined,
          };
        }),
        set: vi.fn((ref: { path: string }, data: Record<string, unknown>) => {
          txSetCalls.push({ path: ref.path, data });
        }),
      };
      return cb(tx);
    });

    const created = await createOrDuplicateCatalogProductInFirestore({
      ownerId: OWNER_UID,
      operation: 'create',
      draftProduct: {
        id: 'prod-charm-1',
        ownerId: OWNER_UID,
        name: 'Star Charm',
        description: '3D printed star charm',
        categoryId: 'cat-charms',
        priceMyr: 12.5,
        images: ['https://cdn.woopp.my/products/star.webp'],
        options: [],
        variants: [],
        status: 'active',
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
    });

    expect(mockRunTransaction).toHaveBeenCalledTimes(1);
    expect(created.sku).toMatch(/^WOOPP-[A-Z0-9]{8}$/);
    expect(txSetCalls).toHaveLength(2);
    expect(txSetCalls[0].path).toBe(`users/${OWNER_UID}/catalogSkus/${created.sku}`);
    expect(txSetCalls[0].data).toMatchObject({
      sku: created.sku,
      ownerId: OWNER_UID,
      productId: 'prod-charm-1',
    });
    expect(txSetCalls[1].path).toBe(`users/${OWNER_UID}/catalogProducts/prod-charm-1`);
    expect(txSetCalls[1].data).toMatchObject({
      id: 'prod-charm-1',
      sku: created.sku,
      ownerId: OWNER_UID,
      categoryId: 'cat-charms',
    });
  });

  it('retries with a fresh unique SKU on transaction SKU collision and rejects archived categories or existing product overwrites', async () => {
    let txAttempt = 0;
    mockRunTransaction.mockImplementation(async (_db: unknown, cb: (tx: unknown) => Promise<boolean>) => {
      txAttempt += 1;
      const currentAttempt = txAttempt;
      const tx = {
        get: vi.fn(async (ref: { path: string }) => {
          if (ref.path.includes('/catalogCategories/')) {
            return {
              exists: () => true,
              data: () => ({ id: 'cat-charms', ownerId: OWNER_UID, status: 'active' }),
            };
          }
          if (ref.path.includes('/catalogSkus/') && currentAttempt === 1) {
            // Simulate concurrent SKU collision on attempt 1
            return {
              exists: () => true,
              data: () => ({ sku: 'COLLIDED', ownerId: OWNER_UID, productId: 'other-prod' }),
            };
          }
          return { exists: () => false, data: () => undefined };
        }),
        set: vi.fn(),
      };
      return cb(tx);
    });

    const retried = await createOrDuplicateCatalogProductInFirestore({
      ownerId: OWNER_UID,
      operation: 'create',
      draftProduct: {
        id: 'prod-retry-1',
        ownerId: OWNER_UID,
        name: 'Retry Charm',
        description: '',
        categoryId: 'cat-charms',
        priceMyr: null,
        images: [],
        options: [],
        variants: [],
        status: 'active',
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
    });
    expect(txAttempt).toBe(2);
    expect(retried.sku).toMatch(/^WOOPP-[A-Z0-9]{8}$/);

    // Reject product creation inside an archived category
    mockRunTransaction.mockImplementationOnce(async (_db: unknown, cb: (tx: unknown) => Promise<boolean>) => {
      const tx = {
        get: vi.fn(async (ref: { path: string }) => {
          if (ref.path.includes('/catalogCategories/')) {
            return {
              exists: () => true,
              data: () => ({ id: 'cat-archived', ownerId: OWNER_UID, status: 'archived' }),
            };
          }
          return { exists: () => false, data: () => undefined };
        }),
        set: vi.fn(),
      };
      return cb(tx);
    });

    await expect(
      createOrDuplicateCatalogProductInFirestore({
        ownerId: OWNER_UID,
        operation: 'create',
        draftProduct: {
          id: 'prod-in-arch',
          ownerId: OWNER_UID,
          name: 'Blocked Product',
          description: '',
          categoryId: 'cat-archived',
          priceMyr: null,
          images: [],
          options: [],
          variants: [],
          status: 'active',
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
        },
      })
    ).rejects.toThrow(/archived category/i);

    // Reject overwriting an already-existing product document
    mockRunTransaction.mockImplementationOnce(async (_db: unknown, cb: (tx: unknown) => Promise<boolean>) => {
      const tx = {
        get: vi.fn(async (ref: { path: string }) => {
          if (ref.path.includes('/catalogCategories/')) {
            return {
              exists: () => true,
              data: () => ({ id: 'cat-charms', ownerId: OWNER_UID, status: 'active' }),
            };
          }
          if (ref.path.includes('/catalogProducts/')) {
            return {
              exists: () => true,
              data: () => ({ id: 'prod-existing', sku: 'WOOPP-OLD12345' }),
            };
          }
          return { exists: () => false, data: () => undefined };
        }),
        set: vi.fn(),
      };
      return cb(tx);
    });

    await expect(
      createOrDuplicateCatalogProductInFirestore({
        ownerId: OWNER_UID,
        operation: 'create',
        draftProduct: {
          id: 'prod-existing',
          ownerId: OWNER_UID,
          name: 'Overwrite Attempt',
          description: '',
          categoryId: 'cat-charms',
          priceMyr: null,
          images: [],
          options: [],
          variants: [],
          status: 'active',
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
        },
      })
    ).rejects.toThrow(/already exists/i);
  });

  it('updates existing products via updateDoc with mutable fields only while preserving immutable SKU', async () => {
    mockUpdateDoc.mockResolvedValueOnce(undefined);

    const existingProduct: CatalogProduct = {
      id: 'prod-immutable-1',
      ownerId: OWNER_UID,
      sku: 'WOOPP-KEEP8899',
      name: 'Original Name',
      description: 'Original desc',
      categoryId: 'cat-charms',
      priceMyr: 10,
      images: ['https://cdn.woopp.my/original.webp'],
      options: [],
      variants: [],
      status: 'active',
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    };

    const result = await updateCatalogProductInFirestore({
      ownerId: OWNER_UID,
      existingProduct,
      updatedDraft: {
        ...existingProduct,
        sku: 'WOOPP-TAMPERED', // Attempted SKU mutation is ignored and preserved as WOOPP-KEEP8899
        name: 'Updated Name',
        priceMyr: 15,
      },
    });

    expect(result.sku).toBe('WOOPP-KEEP8899');
    expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
    const [docRef, payload] = mockUpdateDoc.mock.calls[0] as [
      { path: string },
      Record<string, unknown>,
    ];
    expect(docRef.path).toBe(`users/${OWNER_UID}/catalogProducts/prod-immutable-1`);
    expect(Object.keys(payload).sort()).toEqual([
      'categoryId',
      'description',
      'images',
      'name',
      'options',
      'priceMyr',
      'status',
      'updatedAt',
      'variants',
    ]);
    expect(payload).not.toHaveProperty('sku');
    expect(payload).not.toHaveProperty('id');
    expect(payload).not.toHaveProperty('ownerId');
    expect(payload).not.toHaveProperty('createdAt');
  });

  it('handles concurrent Promise.all product creations with contended SKU and rolls back failed transactions cleanly', async () => {
    const inMemoryStore = new Map<string, Record<string, unknown>>([
      [
        `users/${OWNER_UID}/catalogCategories/cat-charms`,
        { id: 'cat-charms', ownerId: OWNER_UID, status: 'active' },
      ],
    ]);

    // Deterministic serialized optimistic-concurrency transaction runner (mirrors Firestore server OCC):
    // When two concurrent callers attempt to commit the same SKU key, the second commits against
    // the updated store and sees the SKU already reserved, triggering clean retry without corrupting state.
    let commitChain = Promise.resolve();
    mockRunTransaction.mockImplementation(
      (_db: unknown, updateFn: (tx: unknown) => Promise<unknown>) => {
        const next = commitChain.then(async () => {
          const stagedWrites: Array<{ path: string; data: Record<string, unknown> }> = [];
          const tx = {
            get: vi.fn(async (ref: { path: string }) => {
              const found = inMemoryStore.get(ref.path);
              return {
                exists: () => Boolean(found),
                data: () => found,
              };
            }),
            set: vi.fn((ref: { path: string }, data: Record<string, unknown>) => {
              stagedWrites.push({ path: ref.path, data });
            }),
          };
          const res = await updateFn(tx);
          // Only commit staged writes if updateFn succeeded and returned truthy (not false on SKU retry)
          if (res !== false) {
            for (const w of stagedWrites) {
              inMemoryStore.set(w.path, w.data);
            }
          }
          return res;
        });
        commitChain = next.then(
          () => undefined,
          () => undefined
        );
        return next;
      }
    );

    const [createdA, createdB] = await Promise.all([
      createOrDuplicateCatalogProductInFirestore({
        ownerId: OWNER_UID,
        operation: 'create',
        draftProduct: {
          id: 'prod-concurrent-a',
          ownerId: OWNER_UID,
          name: 'Concurrent Charm A',
          description: 'Batch A',
          categoryId: 'cat-charms',
          priceMyr: 14,
          images: ['https://cdn.woopp.my/a.webp'],
          options: [],
          variants: [],
          status: 'active',
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
        },
      }),
      createOrDuplicateCatalogProductInFirestore({
        ownerId: OWNER_UID,
        operation: 'create',
        draftProduct: {
          id: 'prod-concurrent-b',
          ownerId: OWNER_UID,
          name: 'Concurrent Charm B',
          description: 'Batch B',
          categoryId: 'cat-charms',
          priceMyr: 16,
          images: ['https://cdn.woopp.my/b.webp'],
          options: [],
          variants: [],
          status: 'active',
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
        },
      }),
    ]);

    expect(createdA.sku).toMatch(/^WOOPP-[A-Z0-9]{8}$/);
    expect(createdB.sku).toMatch(/^WOOPP-[A-Z0-9]{8}$/);
    expect(createdA.sku).not.toBe(createdB.sku);
    expect(inMemoryStore.get(`users/${OWNER_UID}/catalogSkus/${createdA.sku}`)).toMatchObject({
      sku: createdA.sku,
      productId: 'prod-concurrent-a',
      ownerId: OWNER_UID,
    });
    expect(inMemoryStore.get(`users/${OWNER_UID}/catalogSkus/${createdB.sku}`)).toMatchObject({
      sku: createdB.sku,
      productId: 'prod-concurrent-b',
      ownerId: OWNER_UID,
    });

    // Verify failed transaction leaves zero orphaned SKU or product documents in the store
    const sizeBeforeFailed = inMemoryStore.size;
    await expect(
      createOrDuplicateCatalogProductInFirestore({
        ownerId: OWNER_UID,
        operation: 'create',
        draftProduct: {
          id: 'prod-failed-tx',
          ownerId: OWNER_UID,
          name: 'Invalid Image Tx',
          description: '',
          categoryId: 'cat-missing',
          priceMyr: 10,
          images: [],
          options: [],
          variants: [],
          status: 'active',
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
        },
      })
    ).rejects.toThrow(/category does not exist/i);
    expect(inMemoryStore.size).toBe(sizeBeforeFailed);
  });
});
