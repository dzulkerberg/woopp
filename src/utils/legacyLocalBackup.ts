import {
  migrateFromLegacyV1,
  normalizeWorkspaceV5,
  STORAGE_KEY_V1,
  STORAGE_KEY_V5,
} from '../constants';
import { LegacyTrackerState, ProductionWorkspaceV5 } from '../types';
import { formatDateDDMMYYYY } from './dateFormat';
import { prepareWorkspaceForFirestore } from './firestorePayload';

export interface LegacyLocalDataSummary {
  sourceKey: typeof STORAGE_KEY_V5 | typeof STORAGE_KEY_V1;
  format: 'v5' | 'v1';
  projectCount: number;
  jobCount: number;
  colorCount: number;
  updatedIso: string | null;
  rawJson: string;
}

/**
 * Strictly read-only inspection of legacy browser `localStorage` keys (`woopp-print-tracker-v5`
 * and `woopp-print-tracker-v1`) so users who previously used the retired Local Workspace
 * can export a one-time JSON backup or migrate their records into Cloud Firestore.
 *
 * Never modifies or deletes any existing browser `localStorage` keys.
 */
export function inspectUnsyncedLocalData(
  storage?: Pick<Storage, 'getItem'> | null
): LegacyLocalDataSummary | null {
  const targetStorage =
    storage !== undefined
      ? storage
      : typeof window !== 'undefined'
      ? window.localStorage
      : null;

  if (!targetStorage) return null;

  try {
    const rawV5 = targetStorage.getItem(STORAGE_KEY_V5);
    if (rawV5) {
      const parsed = JSON.parse(rawV5) as Partial<ProductionWorkspaceV5>;
      if (
        parsed &&
        parsed.schemaVersion === 5 &&
        Array.isArray(parsed.projects) &&
        Array.isArray(parsed.jobs)
      ) {
        return {
          sourceKey: STORAGE_KEY_V5,
          format: 'v5',
          projectCount: parsed.projects.length,
          jobCount: parsed.jobs.length,
          colorCount: Array.isArray(parsed.colors) ? parsed.colors.length : 0,
          updatedIso: typeof parsed.updatedIso === 'string' ? parsed.updatedIso : null,
          rawJson: rawV5,
        };
      }
    }
  } catch {
    // Ignore malformed v5 entry and check v1 below
  }

  try {
    const rawV1 = targetStorage.getItem(STORAGE_KEY_V1);
    if (rawV1) {
      const parsedV1 = JSON.parse(rawV1) as Partial<LegacyTrackerState>;
      if (
        parsedV1 &&
        Array.isArray(parsedV1.colors) &&
        parsedV1.colors.every((c) => typeof c === 'string') &&
        Array.isArray(parsedV1.jobs) &&
        parsedV1.jobs.length > 0
      ) {
        return {
          sourceKey: STORAGE_KEY_V1,
          format: 'v1',
          projectCount: 1,
          jobCount: parsedV1.jobs.length,
          colorCount: parsedV1.colors.length,
          updatedIso: null,
          rawJson: rawV1,
        };
      }
    }
  } catch {
    // Ignore malformed v1 entry
  }

  return null;
}

/**
 * Converts detected unsynced local browser data into a validated `ProductionWorkspaceV5`
 * bound to the authenticated Firebase user's `uid` without mutating or deleting `localStorage`.
 */
export function buildCloudWorkspaceFromLocalBackup(
  summary: LegacyLocalDataSummary,
  firebaseUid: string
): ProductionWorkspaceV5 {
  const parsed = JSON.parse(summary.rawJson);
  const converted =
    summary.format === 'v5'
      ? normalizeWorkspaceV5(parsed as ProductionWorkspaceV5, firebaseUid)
      : migrateFromLegacyV1(parsed as LegacyTrackerState, firebaseUid);

  return prepareWorkspaceForFirestore(converted, firebaseUid, {
    documentLabel: `users/${firebaseUid}/tracker/v5_workspace`,
  });
}

/**
 * Triggers a one-time JSON file download of unsynced local browser records
 * while leaving the browser's `localStorage` untouched.
 */
export function downloadUnsyncedLocalBackupJson(summary: LegacyLocalDataSummary): void {
  const blob = new Blob([summary.rawJson], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const todayStr = formatDateDDMMYYYY(new Date()).replace(/\//g, '-');
  a.href = url;
  a.download = `woopp-local-${summary.format}-backup-${todayStr}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
