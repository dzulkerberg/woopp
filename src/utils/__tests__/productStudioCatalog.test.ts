import { describe, expect, it } from 'vitest';
import {
  prepareCategoryForFirestore,
  prepareCategoryPlateSettingForFirestore,
  prepareProductForFirestore,
  prepareSkuReservationForFirestore,
  syncVariantsFromOptions,
  validateHttpsImageUrl,
} from '../catalogValidation';
import { findUndefinedPaths } from '../firestorePayload';
import {
  generateRawWooppSku,
  generateUniqueWooppSku,
  isValidWooppSku,
  resolveProductOperationSku,
} from '../skuGenerator';

describe('Product Studio 6.0 — Auto SKU, HTTPS Image Validation & Firestore Payload Suite', () => {
  it('generates collision-resistant WOOPP-XXXXXXXX SKUs and preserves/regenerates SKUs properly across lifecycle operations', () => {
    const generated = new Set<string>();
    for (let i = 0; i < 1500; i += 1) {
      const sku = generateUniqueWooppSku(generated);
      expect(isValidWooppSku(sku)).toBe(true);
      expect(sku).toMatch(/^WOOPP-[A-Z0-9]{8}$/);
      expect(generated.has(sku)).toBe(false);
      generated.add(sku);
    }
    expect(generated.size).toBe(1500);

    const originalSku = generateRawWooppSku();
    // Edit / category reassignment strictly preserves existing SKU
    const editedSku = resolveProductOperationSku({
      operation: 'edit',
      existingProductSku: originalSku,
    });
    expect(editedSku).toBe(originalSku);

    // Duplication MUST generate a brand-new SKU distinct from sourceProductSku
    const duplicatedSku = resolveProductOperationSku({
      operation: 'duplicate',
      existingSkus: [originalSku],
      sourceProductSku: originalSku,
      draftSku: originalSku,
    });
    expect(isValidWooppSku(duplicatedSku)).toBe(true);
    expect(duplicatedSku).not.toBe(originalSku);
  });

  it('enforces external HTTPS-only image URLs and rejects base64 data URIs or insecure links', () => {
    expect(validateHttpsImageUrl('')).toEqual({ valid: true, normalizedUrl: null });
    expect(validateHttpsImageUrl(null)).toEqual({ valid: true, normalizedUrl: null });
    expect(
      validateHttpsImageUrl('  https://cdn.example.com/products/charm-moon.webp  ')
    ).toEqual({
      valid: true,
      normalizedUrl: 'https://cdn.example.com/products/charm-moon.webp',
    });

    // Reject base64 data URIs
    const base64Result = validateHttpsImageUrl(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA'
    );
    expect(base64Result.valid).toBe(false);
    expect(base64Result.error).toMatch(/Base64/i);

    // Reject insecure http:// and relative paths
    expect(validateHttpsImageUrl('http://cdn.example.com/img.jpg').valid).toBe(false);
    expect(validateHttpsImageUrl('/assets/local.png').valid).toBe(false);
    expect(validateHttpsImageUrl('blob:https://example.com/123').valid).toBe(false);
  });

  it('builds cartesian product variations and preserves custom per-variant MYR prices and HTTPS images on option edits', () => {
    const initialOptions = [
      { id: 'opt-size', name: 'Size', values: ['Small', 'Large'], sortOrder: 0 },
      { id: 'opt-finish', name: 'Finish', values: ['Matte', 'Glossy'], sortOrder: 1 },
    ];
    const initialVariants = syncVariantsFromOptions(initialOptions, []);
    expect(initialVariants).toHaveLength(4);
    expect(initialVariants.map((v) => v.label)).toEqual([
      'Small / Matte',
      'Small / Glossy',
      'Large / Matte',
      'Large / Glossy',
    ]);

    // Customize price and image on "Large / Matte"
    const customized = initialVariants.map((v) =>
      v.label === 'Large / Matte'
        ? {
            ...v,
            priceMyr: 18.5,
            imageUrl: 'https://cdn.example.com/large-matte.jpg',
          }
        : v
    );

    // Add a new Size value "XL" and verify "Large / Matte" keeps its custom price & image
    const updatedVariants = syncVariantsFromOptions(
      [
        { id: 'opt-size', name: 'Size', values: ['Small', 'Large', 'XL'], sortOrder: 0 },
        { id: 'opt-finish', name: 'Finish', values: ['Matte', 'Glossy'], sortOrder: 1 },
      ],
      customized
    );
    expect(updatedVariants).toHaveLength(6);
    const preserved = updatedVariants.find((v) => v.label === 'Large / Matte');
    expect(preserved?.priceMyr).toBe(18.5);
    expect(preserved?.imageUrl).toBe('https://cdn.example.com/large-matte.jpg');
  });

  it('sanitizes all 4 Product Studio Firestore documents with zero undefined values', () => {
    const ownerId = 'owner-woopp-test';
    const nowIso = '2026-10-30T08:00:00.000Z';
    const sku = generateRawWooppSku();

    const cleanCategory = prepareCategoryForFirestore(
      {
        id: 'cat-charms',
        ownerId,
        name: '  Charm Keycaps  ',
        description: '  Cute 3D printed keycaps  ',
        imageUrl: null,
        iconName: 'sparkles',
        sortOrder: 0,
        status: 'active',
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      ownerId
    );
    expect(findUndefinedPaths(cleanCategory)).toEqual([]);
    expect(cleanCategory.name).toBe('Charm Keycaps');

    const cleanProduct = prepareProductForFirestore(
      {
        id: 'prod-charm-moon',
        ownerId,
        sku,
        name: '  Charm Moon  ',
        description: 'Crescent moon clicker keycap',
        categoryId: 'cat-charms',
        priceMyr: 12.9,
        images: ['https://cdn.example.com/moon-main.jpg'],
        options: [],
        variants: [],
        status: 'active',
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      ownerId
    );
    expect(findUndefinedPaths(cleanProduct)).toEqual([]);
    expect(cleanProduct.sku).toBe(sku);

    const cleanReservation = prepareSkuReservationForFirestore(
      {
        sku,
        ownerId,
        productId: 'prod-charm-moon',
        createdAt: nowIso,
      },
      ownerId
    );
    expect(findUndefinedPaths(cleanReservation)).toEqual([]);

    const cleanSetting = prepareCategoryPlateSettingForFirestore(
      {
        categoryId: 'cat-charms',
        ownerId,
        allocationMode: 'automatic_capacity',
        plateCapacity: null, // Must NOT default to 138!
        defaultEstimatedMinutes: 180,
        updatedAt: nowIso,
      },
      ownerId
    );
    expect(findUndefinedPaths(cleanSetting)).toEqual([]);
    expect(cleanSetting.plateCapacity).toBeNull();
  });
});
