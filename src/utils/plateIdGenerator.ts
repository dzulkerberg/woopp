/**
 * WOOPP 6.0 Globally Unique Immutable Plate ID Utility
 *
 * - Format: 5 uppercase alphanumeric characters excluding visually ambiguous O, 0, I, 1
 *   (`23456789ABCDEFGHJKLMNPQRSTUVWXYZ` — 32 chars = 33,554,432 combinations).
 * - Uses Web Crypto CSPRNG (`crypto.getRandomValues`) with zero modulo bias (`bytes[i] & 31`).
 * - Displayed as `WP-{PLATE_ID}` and exported strictly as `WP-{PLATE_ID}.stl`.
 */

export const PLATE_ID_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const PLATE_ID_LENGTH = 5;
export const VALID_PLATE_CODE_REGEX = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}$/;

function fillRandomBytes(target: Uint8Array<ArrayBuffer>): void {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.getRandomValues === 'function'
  ) {
    globalThis.crypto.getRandomValues(target);
    return;
  }
  for (let i = 0; i < target.length; i += 1) {
    target[i] = Math.floor(Math.random() * 256);
  }
}

export function normalizePlateCode(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  const trimmed = code.trim().toUpperCase();
  const stripped = trimmed.startsWith('WP-') ? trimmed.slice(3) : trimmed;
  return VALID_PLATE_CODE_REGEX.test(stripped) ? stripped : null;
}

export function isValidPlateCode(code: unknown): code is string {
  return typeof code === 'string' && VALID_PLATE_CODE_REGEX.test(code.trim().toUpperCase());
}

/**
 * Generates a single 5-character CSPRNG Plate ID candidate excluding O, 0, I, 1.
 */
export function generateCandidatePlateCode(): string {
  const bytes = new Uint8Array(new ArrayBuffer(PLATE_ID_LENGTH));
  fillRandomBytes(bytes);
  let code = '';
  for (let i = 0; i < PLATE_ID_LENGTH; i += 1) {
    // 256 is an exact multiple of 32 (256 / 32 = 8), so `bytes[i] & 31` has zero modulo bias.
    code += PLATE_ID_ALPHABET[bytes[i] & 31];
  }
  return code;
}

/**
 * Generates a collision-resistant 5-character Plate ID not present in `existingCodes`.
 */
export function generateUniqueCandidatePlateCode(
  existingCodes?: Iterable<string>,
  maxAttempts = 64
): string {
  const taken = new Set<string>();
  if (existingCodes) {
    for (const raw of existingCodes) {
      const normalized = normalizePlateCode(raw);
      if (normalized) taken.add(normalized);
    }
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = generateCandidatePlateCode();
    if (!taken.has(candidate)) {
      return candidate;
    }
  }

  throw new Error('Unable to generate a unique Plate ID after maximum attempts.');
}

export function formatWpPlateId(plateCode: string): string {
  const clean = normalizePlateCode(plateCode);
  if (!clean) {
    throw new Error(`Invalid Plate ID "${String(plateCode)}".`);
  }
  return `WP-${clean}`;
}

export function formatWpPlateStlFilename(plateCode: string): string {
  return `${formatWpPlateId(plateCode)}.stl`;
}

export function formatWpPlate3mfFilename(plateCode: string): string {
  return `${formatWpPlateId(plateCode)}.3mf`;
}

export function formatBatch3mfFilename(batchId: string): string {
  const safeBatchId = batchId
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-');
  if (!safeBatchId) {
    throw new Error('Batch ID is required to format a batch .3mf filename.');
  }
  return `WOOPP-Batch-${safeBatchId}.3mf`;
}

export function generateStableBatchId(nowMs: number = Date.now()): string {
  const bytes = new Uint8Array(new ArrayBuffer(4));
  fillRandomBytes(bytes);
  let suffix = '';
  for (let i = 0; i < bytes.length; i += 1) {
    suffix += PLATE_ID_ALPHABET[bytes[i] & 31];
  }
  return `batch-${nowMs}-${suffix.toLowerCase()}`;
}

