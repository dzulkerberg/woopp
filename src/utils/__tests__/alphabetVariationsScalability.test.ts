import { describe, expect, it } from 'vitest';
import {
  ALPHABET_A_TO_Z,
  MAX_OPTION_COMPLEXITY_BUDGET,
  MAX_PRODUCT_OPTION_VALUES,
  MAX_PRODUCT_VARIANTS,
  prepareProductForFirestore,
  prepareVariantDocForFirestore,
  syncVariantsFromOptions,
} from '../catalogValidation';
import { CatalogProduct, ProductOptionDefinition, ProductVariant } from '../../types';

describe('WOOPP Products 6.0 — Scalable Alphabet A–Z Option Values & Variant Generation', () => {
  const OWNER_ID = 'test-owner-alphabet';
  const CATEGORY_ID = 'cat-keychains';

  it('allows adding the 13th value ("M") and all 26 letters ("A" through "Z") to the same option group', () => {
    // 1. User reproduction scenario: starts with A through L (12 values)
    const initial12 = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];
    expect(initial12.length).toBe(12);

    const initialOption: ProductOptionDefinition = {
      id: 'opt-letter',
      name: 'Letter',
      values: initial12,
      sortOrder: 0,
    };

    // Verify limit constant is at least 26 (now 60)
    expect(MAX_PRODUCT_OPTION_VALUES).toBeGreaterThanOrEqual(26);
    expect(MAX_OPTION_COMPLEXITY_BUDGET).toBeGreaterThanOrEqual(60);

    // 2. Add 'M' (the 13th value)
    const withM: ProductOptionDefinition = {
      ...initialOption,
      values: [...initialOption.values, 'M'],
    };
    expect(withM.values.length).toBe(13);
    expect(withM.values[12]).toBe('M');

    // 3. Add all remaining letters up to 'Z' (26 total values)
    const remainingLetters = ['N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'];
    const fullAlphabetOption: ProductOptionDefinition = {
      ...initialOption,
      values: [...initialOption.values, 'M', ...remainingLetters],
    };
    expect(fullAlphabetOption.values.length).toBe(26);
    expect(fullAlphabetOption.values).toEqual(ALPHABET_A_TO_Z);

    // 4. Generate variants from the 26-letter option group
    const existingVariants: ProductVariant[] = [];
    const generatedVariants = syncVariantsFromOptions([fullAlphabetOption], existingVariants);

    expect(generatedVariants.length).toBe(26);
    expect(generatedVariants[0].label).toBe('A');
    expect(generatedVariants[0].optionValues).toEqual({ Letter: 'A' });
    expect(generatedVariants[12].label).toBe('M');
    expect(generatedVariants[12].optionValues).toEqual({ Letter: 'M' });
    expect(generatedVariants[25].label).toBe('Z');
    expect(generatedVariants[25].optionValues).toEqual({ Letter: 'Z' });
  });

  it('validates and prepares a 26-letter Alphabet product for Firestore without throwing', () => {
    const alphabetProduct: CatalogProduct = {
      id: 'prod-alphabet-full',
      ownerId: OWNER_ID,
      sku: 'WOOPP-ALPHAFUL',
      name: 'WOOPP 3D Alphabet Keychains',
      description: 'Full collection of 3D-printed letters from A to Z.',
      categoryId: CATEGORY_ID,
      priceMyr: 15.9,
      images: ['https://cdn.wooppartcraft.com/alphabet/cover.webp'],
      options: [
        {
          id: 'opt-letter',
          name: 'Letter',
          values: [...ALPHABET_A_TO_Z],
          sortOrder: 0,
        },
      ],
      variants: [], // Using scalable subcollection architecture
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const sanitized = prepareProductForFirestore(alphabetProduct, OWNER_ID);
    expect(sanitized.options[0].values.length).toBe(26);
    expect(sanitized.options[0].values[0]).toBe('A');
    expect(sanitized.options[0].values[12]).toBe('M');
    expect(sanitized.options[0].values[25]).toBe('Z');
  });

  it('prepares individual CatalogVariantDoc objects matching the 10-key schema for subcollections', () => {
    const letters = ['A', 'M', 'Z'];
    letters.forEach((letter, idx) => {
      const vDoc = prepareVariantDocForFirestore(
        {
          id: `var-letter-${letter.toLowerCase()}`,
          label: `Letter ${letter}`,
          optionValues: { Letter: letter },
          priceMyr: 15.0,
          imageUrl: `https://cdn.wooppartcraft.com/alphabet/${letter}.webp`,
          sortOrder: idx,
        },
        OWNER_ID,
        'prod-alphabet-full',
        {
          createdAt: '2026-11-06T00:00:00.000Z',
          updatedAt: '2026-11-06T00:00:00.000Z',
        }
      );

      // Exactly 10 keys required by firestore.rules
      const keys = Object.keys(vDoc).sort();
      expect(keys).toEqual([
        'createdAt',
        'id',
        'imageUrl',
        'label',
        'optionValues',
        'ownerId',
        'priceMyr',
        'productId',
        'sortOrder',
        'updatedAt',
      ]);
      expect(Object.keys(vDoc).length).toBe(10);
      expect(vDoc.label).toBe(`Letter ${letter}`);
      expect(vDoc.optionValues).toEqual({ Letter: letter });
    });
  });

  it('caps Cartesian explosion at MAX_PRODUCT_VARIANTS when multiple option groups exist (e.g. 26 letters x 5 colors)', () => {
    const options: ProductOptionDefinition[] = [
      {
        id: 'opt-letter',
        name: 'Letter',
        values: [...ALPHABET_A_TO_Z], // 26
        sortOrder: 0,
      },
      {
        id: 'opt-color',
        name: 'Color',
        values: ['White', 'Black', 'Red', 'Blue', 'Gold'], // 5 -> 26 x 5 = 130 combinations
        sortOrder: 1,
      },
    ];

    const variants = syncVariantsFromOptions(options, []);

    // Must be capped at MAX_PRODUCT_VARIANTS (60) without throwing or crashing
    expect(variants.length).toBe(MAX_PRODUCT_VARIANTS);
    expect(variants.length).toBe(60);
    expect(variants[0].label).toBe('A / White');
    expect(variants[0].optionValues).toEqual({ Letter: 'A', Color: 'White' });
  });
});
