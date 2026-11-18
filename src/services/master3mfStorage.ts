import { Master3mfTemplateAsset, Master3mfTemplateRecord } from '../types';
import {
  buildMasterTemplateSummaryFromParsed,
  inspectMaster3mfArchive,
} from '../utils/bambu3mfEngine';
import { computeBufferSha256Hex } from './stlLibraryStorage';

const DB_NAME = 'woopp-master-3mf-v1';
const DB_VERSION = 1;
const STORE_NAME = 'master_templates';

export interface Master3mfRepository {
  getByOwner(ownerId: string): Promise<Master3mfTemplateAsset | null>;
  putTemplate(ownerId: string, asset: Master3mfTemplateAsset): Promise<void>;
  deleteTemplate(ownerId: string): Promise<void>;
}

/**
 * Validates and inspects an uploaded Bambu Studio Master `.3mf` archive.
 * Copies source bytes into a standalone immutable ArrayBuffer so the original file is never modified.
 */
export async function validateAndPrepareMaster3mf(params: {
  fileName: string;
  buffer: ArrayBuffer;
  uploadedBy?: string | null;
  uploadedAt?: string;
}): Promise<
  { ok: true; asset: Master3mfTemplateAsset } | { ok: false; error: string }
> {
  const cleanFileName = params.fileName.trim();
  if (!/\.3mf$/i.test(cleanFileName)) {
    return {
      ok: false,
      error: `Invalid file "${cleanFileName}": only Bambu Studio .3mf template files are allowed.`,
    };
  }

  try {
    // Deep-copy into clean standalone ArrayBuffer to guarantee immutability
    const rawCopy = params.buffer.slice(0);
    const parsed = await inspectMaster3mfArchive(rawCopy);
    const sha256 = await computeBufferSha256Hex(rawCopy);

    const record: Master3mfTemplateRecord = buildMasterTemplateSummaryFromParsed({
      templateId: `master-3mf-${sha256.slice(0, 12)}`,
      fileName: cleanFileName,
      byteLength: rawCopy.byteLength,
      sha256,
      uploadedAt: params.uploadedAt || new Date().toISOString(),
      uploadedBy: params.uploadedBy ?? null,
      parsed,
    });

    return {
      ok: true,
      asset: {
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

interface StoredMaster3mfRow {
  ownerId: string;
  record: Master3mfTemplateRecord;
  buffer: ArrayBuffer;
}

function openMaster3mfIndexedDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('Browser IndexedDB is unavailable in this environment.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'ownerId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error || new Error('Failed to open Master 3MF Template database.'));
  });
}

export function createIndexedDbMaster3mfRepository(): Master3mfRepository {
  return {
    async getByOwner(ownerId: string): Promise<Master3mfTemplateAsset | null> {
      const db = await openMaster3mfIndexedDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(ownerId.trim());
        req.onsuccess = () => {
          const row = req.result as StoredMaster3mfRow | undefined;
          if (!row || !row.buffer || !row.record) {
            resolve(null);
            return;
          }
          resolve({ record: row.record, buffer: row.buffer });
        };
        req.onerror = () =>
          reject(req.error || new Error('Failed to load Master 3MF template.'));
      });
    },

    async putTemplate(ownerId: string, asset: Master3mfTemplateAsset): Promise<void> {
      const db = await openMaster3mfIndexedDb();
      const row: StoredMaster3mfRow = {
        ownerId: ownerId.trim(),
        record: asset.record,
        buffer: asset.buffer.slice(0),
      };
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.put(row);
        req.onsuccess = () => resolve();
        req.onerror = () =>
          reject(
            req.error || new Error(`Failed to persist Master 3MF "${asset.record.fileName}".`)
          );
      });
    },

    async deleteTemplate(ownerId: string): Promise<void> {
      const db = await openMaster3mfIndexedDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.delete(ownerId.trim());
        req.onsuccess = () => resolve();
        req.onerror = () =>
          reject(req.error || new Error('Failed to remove Master 3MF template.'));
      });
    },
  };
}

export function createInMemoryMaster3mfRepository(
  initialEntries: readonly { ownerId: string; asset: Master3mfTemplateAsset }[] = []
): Master3mfRepository {
  const map = new Map<string, Master3mfTemplateAsset>();
  for (const item of initialEntries) {
    map.set(item.ownerId.trim(), {
      record: item.asset.record,
      buffer: item.asset.buffer.slice(0),
    });
  }

  return {
    async getByOwner(ownerId: string): Promise<Master3mfTemplateAsset | null> {
      const hit = map.get(ownerId.trim());
      if (!hit) return null;
      return {
        record: hit.record,
        buffer: hit.buffer.slice(0),
      };
    },
    async putTemplate(ownerId: string, asset: Master3mfTemplateAsset): Promise<void> {
      map.set(ownerId.trim(), {
        record: asset.record,
        buffer: asset.buffer.slice(0),
      });
    },
    async deleteTemplate(ownerId: string): Promise<void> {
      map.delete(ownerId.trim());
    },
  };
}

let sharedMaster3mfRepo: Master3mfRepository | null = null;

export function getMaster3mfRepository(): Master3mfRepository {
  if (!sharedMaster3mfRepo) {
    sharedMaster3mfRepo =
      typeof indexedDB !== 'undefined'
        ? createIndexedDbMaster3mfRepository()
        : createInMemoryMaster3mfRepository();
  }
  return sharedMaster3mfRepo;
}
