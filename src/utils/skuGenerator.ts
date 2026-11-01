/**
 * WOOPP 6.0 Automatic Collision-Resistant SKU Engine
 *
 * - Format: `WOOPP-XXXXXXXX` (8 uppercase Crockford alphanumeric characters)
 * - Uses Web Crypto CSPRNG (`crypto.getRandomValues`) — never `products.length + 1`
 * - Never embeds mutable category names so renaming or moving categories never breaks SKUs
 * - Preserves existing SKUs on product edit & category change; generates new SKU on duplicate
 */

const SKU_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 32 unambiguous uppercase chars (32^8 = 1.099 trillion combinations)
const SKU_PREFIX = 'WOOPP-';
const SKU_CODE_LENGTH = 8;
const VALID_SKU_REGEX = /^WOOPP-[A-Z0-9]{8}$/;

function fillRandomBytes(target: Uint8Array<ArrayBuffer>): void {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(target);
    return;
  }
  for (let i = 0; i < target.length; i += 1) {
    target[i] = Math.floor(Math.random() * 256);
  }
}

export function isValidWooppSku(sku: unknown): sku is string {
  return typeof sku === 'string' && VALID_SKU_REGEX.test(sku.trim());
}

/**
 * Generates a single random `WOOPP-XXXXXXXX` SKU using cryptographic randomness.
 */
export function generateRawWooppSku(): string {
  const bytes = new Uint8Array(new ArrayBuffer(SKU_CODE_LENGTH));
  fillRandomBytes(bytes);
  let code = '';
  for (let i = 0; i < SKU_CODE_LENGTH; i += 1) {
    // 256 is an exact multiple of 32 (256 / 32 = 8), so `bytes[i] & 31` has zero modulo bias!
    code += SKU_ALPHABET[bytes[i] & 31];
  }
  return `${SKU_PREFIX}${code}`;
}

/**
 * Generates a collision-resistant `WOOPP-XXXXXXXX` SKU verified not to exist
 * in `existingSkus` (case-insensitive check, returned in canonical uppercase).
 */
export function generateUniqueWooppSku(
  existingSkus?: Iterable<string>,
  maxAttempts = 64
): string {
  const normalizedTaken = new Set<string>();
  if (existingSkus) {
    for (const s of existingSkus) {
      if (typeof s === 'string' && s.trim().length > 0) {
        normalizedTaken.add(s.trim().toUpperCase());
      }
    }
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = generateRawWooppSku();
    if (!normalizedTaken.has(candidate)) {
      return candidate;
    }
  }

  throw new Error('Unable to generate a unique WOOPP SKU after maximum attempts.');
}

/**
 * Resolves the authoritative SKU for a product operation:
 * - `'create'`: keeps a valid pre-generated draft SKU if unused, otherwise generates a fresh unique SKU.
 * - `'edit'`: strictly preserves `existingProductSku` verbatim (never changes on edit or category move).
 * - `'duplicate'`: always generates a brand-new unique SKU distinct from `sourceProductSku` and all `existingSkus`.
 */
export function resolveProductOperationSku(params: {
  operation: 'create' | 'edit' | 'duplicate';
  existingSkus?: Iterable<string>;
  draftSku?: string | null;
  existingProductSku?: string;
  sourceProductSku?: string;
}): string {
  const taken = new Set<string>();
  if (params.existingSkus) {
    for (const s of params.existingSkus) {
      if (typeof s === 'string' && s.trim().length > 0) {
        taken.add(s.trim().toUpperCase());
      }
    }
  }

  if (params.operation === 'edit') {
    const preserved = params.existingProductSku?.trim().toUpperCase() || '';
    if (!isValidWooppSku(preserved)) {
      throw new Error(`Cannot edit product with invalid existing SKU "${String(params.existingProductSku)}".`);
    }
    return preserved;
  }

  if (params.operation === 'duplicate') {
    if (params.sourceProductSku) {
      taken.add(params.sourceProductSku.trim().toUpperCase());
    }
    return generateUniqueWooppSku(taken);
  }

  // operation === 'create'
  const candidateDraft = params.draftSku?.trim().toUpperCase() || '';
  if (isValidWooppSku(candidateDraft) && !taken.has(candidateDraft)) {
    return candidateDraft;
  }
  return generateUniqueWooppSku(taken);
}
