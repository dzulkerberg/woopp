import { ABC } from '../constants';
import { StlModelAssetEntry, StlModelAssetRecord } from '../types';
import { parseAndValidateStlBuffer } from '../utils/stlBinaryEngine';

const DB_NAME = 'woopp-stl-library-v1';
const DB_VERSION = 1;
const STORE_NAME = 'stl_models';

export interface StlLibraryRepository {
  getAllByOwner(ownerId: string): Promise<StlModelAssetEntry[]>;
  getByOwnerAndLetters(
    ownerId: string,
    letters: readonly string[]
  ): Promise<Record<string, StlModelAssetEntry>>;
  putAsset(ownerId: string, entry: StlModelAssetEntry): Promise<void>;
  deleteAsset(ownerId: string, letter: string): Promise<void>;
}

function makeCompositeKey(ownerId: string, letter: string): string {
  return `${ownerId.trim()}::${letter.trim().toUpperCase()}`;
}

/**
 * Parses canonical letter from uploaded filename such as `keycap-char-P.stl` (case-insensitive).
 * Rejects ambiguous names during bulk upload so wrong STL files are never silently assigned.
 */
export function matchLetterFromStlFileName(fileName: string): string | null {
  const trimmed = fileName.trim();
  const canonicalMatch = trimmed.match(/(?:^|[\\/])keycap-char-([A-Za-z])\.stl$/i);
  if (canonicalMatch) {
    const letter = canonicalMatch[1].toUpperCase();
    return ABC.includes(letter as any) ? letter : null;
  }
  // Also support exact standalone filename e.g. "keycap-char-P (1).stl" only if unambiguous?
  // Wait: strictly require `keycap-char-A.stl` .. `keycap-char-Z.stl` for bulk match to protect integrity.
  return null;
}

/**
 * Computes a lowercase hex SHA-256 hash over an ArrayBuffer (uses Web Crypto when available,
 * with FNV-1a 64-bit deterministic fallback in constrained environments).
 */
export async function computeBufferSha256Hex(buffer: ArrayBuffer): Promise<string> {
  try {
    if (
      typeof globalThis.crypto !== 'undefined' &&
      globalThis.crypto.subtle &&
      typeof globalThis.crypto.subtle.digest === 'function'
    ) {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
      const bytes = new Uint8Array(digest);
      let hex = '';
      for (let i = 0; i < bytes.length; i += 1) {
        hex += bytes[i].toString(16).padStart(2, '0');
      }
      return hex;
    }
  } catch {
    // Fallback below
  }

  // Deterministic multi-pass FNV fallback when subtle crypto is absent
  const view = new Uint8Array(buffer);
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < view.length; i += 1) {
    h1 ^= view[i];
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= view[i] ^ (i & 0xff);
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Computes an aggregate short revision identifier across a set of STL model records.
 */
export function computeLibraryModelRevision(
  records: readonly Pick<StlModelAssetRecord, 'letter' | 'sha256'>[]
): string {
  if (!records || records.length === 0) return 'unconfigured';
  const parts = [...records]
    .sort((a, b) => a.letter.localeCompare(b.letter))
    .map((r) => `${r.letter}:${r.sha256.slice(0, 8)}`);
  let h = 2166136261;
  const joined = parts.join('|');
  for (let i = 0; i < joined.length; i += 1) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `rev-${(h >>> 0).toString(16).padStart(8, '0')}-${records.length}ch`;
}

/**
 * Validates and inspects an uploaded `.stl` binary/ASCII file for a specific letter slot (A–Z).
 * Preserves the exact raw immutable `ArrayBuffer` without modifying mesh geometry.
 */
export async function validateAndPrepareStlAsset(params: {
  fileName: string;
  buffer: ArrayBuffer;
  expectedLetter?: string | null;
  uploadedBy?: string | null;
  uploadedAt?: string;
}): Promise<{ ok: true; entry: StlModelAssetEntry } | { ok: false; error: string }> {
  const cleanFileName = params.fileName.trim();
  if (!/\.stl$/i.test(cleanFileName)) {
    return {
      ok: false,
      error: `Invalid file "${cleanFileName}": only .stl 3D model files are allowed.`,
    };
  }

  let resolvedLetter = (params.expectedLetter || '').trim().toUpperCase();
  if (!resolvedLetter) {
    const matched = matchLetterFromStlFileName(cleanFileName);
    if (!matched) {
      return {
        ok: false,
        error: `Filename "${cleanFileName}" does not match expected pattern keycap-char-A.stl through keycap-char-Z.stl.`,
      };
    }
    resolvedLetter = matched;
  }

  if (!ABC.includes(resolvedLetter as any)) {
    return {
      ok: false,
      error: `Invalid keycap letter "${resolvedLetter}". Must be an uppercase letter A through Z.`,
    };
  }

  try {
    // Copy into clean standalone ArrayBuffer to guarantee immutability even if caller mutates source
    const rawCopy = params.buffer.slice(0);
    const parsed = parseAndValidateStlBuffer({
      buffer: rawCopy,
      letter: resolvedLetter,
      fileName: cleanFileName,
    });
    const sha256 = await computeBufferSha256Hex(rawCopy);

    const record: StlModelAssetRecord = {
      letter: resolvedLetter,
      fileName: cleanFileName,
      byteLength: rawCopy.byteLength,
      triangleCount: parsed.triangleCount,
      format: parsed.format,
      sha256,
      bounds: parsed.bounds,
      isValid: true,
      uploadedAt: params.uploadedAt || new Date().toISOString(),
      uploadedBy: params.uploadedBy ?? null,
    };

    return {
      ok: true,
      entry: {
        record,
        buffer: rawCopy,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: msg,
    };
  }
}

interface StoredIndexedDbRow {
  compositeKey: string;
  ownerId: string;
  letter: string;
  record: StlModelAssetRecord;
  buffer: ArrayBuffer;
}

function openStlIndexedDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('Browser IndexedDB is unavailable in this environment.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'compositeKey' });
        store.createIndex('by_owner', 'ownerId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error || new Error('Failed to open STL Model Library database.'));
  });
}

export function createIndexedDbStlLibraryRepository(): StlLibraryRepository {
  return {
    async getAllByOwner(ownerId: string): Promise<StlModelAssetEntry[]> {
      const db = await openStlIndexedDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const index = store.index('by_owner');
        const req = index.getAll(ownerId.trim());
        req.onsuccess = () => {
          const rows = (req.result || []) as StoredIndexedDbRow[];
          resolve(
            rows
              .map((r) => ({ record: r.record, buffer: r.buffer }))
              .sort((a, b) => a.record.letter.localeCompare(b.record.letter))
          );
        };
        req.onerror = () =>
          reject(req.error || new Error('Failed to load STL Model Library records.'));
      });
    },

    async getByOwnerAndLetters(
      ownerId: string,
      letters: readonly string[]
    ): Promise<Record<string, StlModelAssetEntry>> {
      const db = await openStlIndexedDb();
      const uniqueLetters = Array.from(
        new Set(letters.map((l) => l.trim().toUpperCase()).filter((l) => ABC.includes(l as any)))
      );
      if (uniqueLetters.length === 0) return {};

      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const result: Record<string, StlModelAssetEntry> = {};
        let remaining = uniqueLetters.length;

        for (const letter of uniqueLetters) {
          const req = store.get(makeCompositeKey(ownerId, letter));
          req.onsuccess = () => {
            const row = req.result as StoredIndexedDbRow | undefined;
            if (row && row.buffer && row.record) {
              result[letter] = { record: row.record, buffer: row.buffer };
            }
            remaining -= 1;
            if (remaining === 0) resolve(result);
          };
          req.onerror = () =>
            reject(req.error || new Error(`Failed to read STL asset for letter "${letter}".`));
        }
      });
    },

    async putAsset(ownerId: string, entry: StlModelAssetEntry): Promise<void> {
      const db = await openStlIndexedDb();
      const row: StoredIndexedDbRow = {
        compositeKey: makeCompositeKey(ownerId, entry.record.letter),
        ownerId: ownerId.trim(),
        letter: entry.record.letter,
        record: entry.record,
        buffer: entry.buffer,
      };
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.put(row);
        req.onsuccess = () => resolve();
        req.onerror = () =>
          reject(req.error || new Error(`Failed to persist STL asset ${entry.record.fileName}.`));
      });
    },

    async deleteAsset(ownerId: string, letter: string): Promise<void> {
      const db = await openStlIndexedDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.delete(makeCompositeKey(ownerId, letter));
        req.onsuccess = () => resolve();
        req.onerror = () =>
          reject(req.error || new Error(`Failed to remove STL asset for letter "${letter}".`));
      });
    },
  };
}

/**
 * In-memory STL repository primarily for Vitest unit/integration tests and SSR fallback.
 */
export function createInMemoryStlLibraryRepository(
  initialEntries: readonly { ownerId: string; entry: StlModelAssetEntry }[] = []
): StlLibraryRepository {
  const map = new Map<string, StlModelAssetEntry>();
  for (const item of initialEntries) {
    map.set(makeCompositeKey(item.ownerId, item.entry.record.letter), item.entry);
  }

  return {
    async getAllByOwner(ownerId: string): Promise<StlModelAssetEntry[]> {
      const prefix = `${ownerId.trim()}::`;
      const out: StlModelAssetEntry[] = [];
      for (const [key, val] of map.entries()) {
        if (key.startsWith(prefix)) {
          out.push(val);
        }
      }
      return out.sort((a, b) => a.record.letter.localeCompare(b.record.letter));
    },

    async getByOwnerAndLetters(
      ownerId: string,
      letters: readonly string[]
    ): Promise<Record<string, StlModelAssetEntry>> {
      const out: Record<string, StlModelAssetEntry> = {};
      for (const l of letters) {
        const clean = l.trim().toUpperCase();
        const hit = map.get(makeCompositeKey(ownerId, clean));
        if (hit) out[clean] = hit;
      }
      return out;
    },

    async putAsset(ownerId: string, entry: StlModelAssetEntry): Promise<void> {
      map.set(makeCompositeKey(ownerId, entry.record.letter), entry);
    },

    async deleteAsset(ownerId: string, letter: string): Promise<void> {
      map.delete(makeCompositeKey(ownerId, letter));
    },
  };
}

let sharedRepoInstance: StlLibraryRepository | null = null;

export function getStlLibraryRepository(): StlLibraryRepository {
  if (!sharedRepoInstance) {
    sharedRepoInstance =
      typeof indexedDB !== 'undefined'
        ? createIndexedDbStlLibraryRepository()
        : createInMemoryStlLibraryRepository();
  }
  return sharedRepoInstance;
}
