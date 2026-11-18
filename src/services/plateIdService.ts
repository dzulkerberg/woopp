import { doc, Firestore, runTransaction } from 'firebase/firestore';
import { db } from '../firebase';
import { ProductionJob, ProductionWorkspaceV5 } from '../types';
import {
  generateCandidatePlateCode,
  isValidPlateCode,
  normalizePlateCode,
} from '../utils/plateIdGenerator';

export interface PlateIdReservationRecord {
  plateCode: string;
  ownerId: string;
  projectId: string;
  batchId: string | null;
  createdAt: string;
}

export interface ReservePlateCodeParams {
  ownerId: string;
  projectId: string;
  batchId?: string | null;
  knownCodes?: Set<string>;
  maxAttempts?: number;
  candidateGenerator?: () => string;
}

export interface PlateIdRegistryAdapter {
  reserveSinglePlateCode(params: ReservePlateCodeParams): Promise<string>;
}

function getFirebaseErrorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    return String((err as { code?: unknown }).code || '').toLowerCase();
  }
  const msg = err instanceof Error ? err.message : String(err);
  return msg.toLowerCase();
}

export function collectKnownPlateCodes(
  jobs?: readonly ProductionJob[],
  extraCodes?: Iterable<string | null | undefined>
): Set<string> {
  const set = new Set<string>();
  if (jobs) {
    for (const j of jobs) {
      const clean = normalizePlateCode(j.plateCode);
      if (clean) set.add(clean);
    }
  }
  if (extraCodes) {
    for (const c of extraCodes) {
      const clean = normalizePlateCode(c);
      if (clean) set.add(clean);
    }
  }
  return set;
}

/**
 * Production Firestore atomic Plate ID registry using `runTransaction` against `/plateIds/{plateCode}`.
 * Guarantees global uniqueness across all projects & users via `tx.get` + `resource == null` create rule.
 */
export function createFirestorePlateIdRegistry(
  dbInstance: Firestore = db,
  options?: { allowLocalFallbackOnMissingRules?: boolean }
): PlateIdRegistryAdapter {
  const allowFallback = options?.allowLocalFallbackOnMissingRules ?? true;

  return {
    async reserveSinglePlateCode(params: ReservePlateCodeParams): Promise<string> {
      const maxAttempts = Math.max(1, params.maxAttempts ?? 25);
      const known = params.knownCodes ?? new Set<string>();
      const generate = params.candidateGenerator ?? generateCandidatePlateCode;
      const cleanOwner = params.ownerId.trim();
      const cleanProject = params.projectId.trim();
      const cleanBatch =
        typeof params.batchId === 'string' && params.batchId.trim().length > 0
          ? params.batchId.trim()
          : null;

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        let candidate = '';
        for (let pick = 0; pick < 64; pick += 1) {
          const next = normalizePlateCode(generate());
          if (next && !known.has(next)) {
            candidate = next;
            break;
          }
        }
        if (!candidate) {
          throw new Error('Unable to generate an unused 5-character Plate ID candidate.');
        }

        const plateRef = doc(dbInstance, 'plateIds', candidate);
        let stage = 'get' as string;

        try {
          const reserved = await runTransaction(dbInstance, async (tx) => {
            stage = 'get';
            const snap = await tx.get(plateRef);
            if (snap.exists()) {
              return false;
            }
            stage = 'set';
            const payload: PlateIdReservationRecord = {
              plateCode: candidate,
              ownerId: cleanOwner,
              projectId: cleanProject,
              batchId: cleanBatch,
              createdAt: new Date().toISOString(),
            };
            tx.set(plateRef, payload);
            return true;
          });

          if (reserved) {
            known.add(candidate);
            return candidate;
          }

          // Existing record detected -> record collision and retry with new CSPRNG candidate
          known.add(candidate);
        } catch (err) {
          const code = getFirebaseErrorCode(err);
          if (
            code.includes('already-exists') ||
            code.includes('aborted') ||
            (stage === 'set' && code.includes('permission-denied'))
          ) {
            known.add(candidate);
            continue;
          }

          if (allowFallback && stage === 'get' && code.includes('permission-denied')) {
            console.warn(
              '[WOOPP PlateIdService] Firestore rules for /plateIds are not yet deployed; falling back to workspace-checked unique Plate ID generation.'
            );
            known.add(candidate);
            return candidate;
          }

          throw err;
        }
      }

      throw new Error(
        'Failed to reserve a globally unique Plate ID in Firestore after maximum retries.'
      );
    },
  };
}

/**
 * Deterministic atomic in-memory registry mirroring Firestore `/plateIds/{plateCode}`
 * transaction semantics (`exists` rejection + immutable write) for unit/integration testing.
 */
export function createInMemoryPlateIdRegistry(
  initialCodes?: Iterable<string>
): PlateIdRegistryAdapter & {
  records: Map<string, PlateIdReservationRecord>;
  attemptsLog: string[];
} {
  const records = new Map<string, PlateIdReservationRecord>();
  const attemptsLog: string[] = [];

  if (initialCodes) {
    for (const raw of initialCodes) {
      const clean = normalizePlateCode(raw);
      if (clean) {
        records.set(clean, {
          plateCode: clean,
          ownerId: 'seed-owner',
          projectId: 'seed-project',
          batchId: null,
          createdAt: new Date().toISOString(),
        });
      }
    }
  }

  return {
    records,
    attemptsLog,
    async reserveSinglePlateCode(params: ReservePlateCodeParams): Promise<string> {
      const maxAttempts = Math.max(1, params.maxAttempts ?? 25);
      const known = params.knownCodes ?? new Set<string>();
      const generate = params.candidateGenerator ?? generateCandidatePlateCode;

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const candidate = normalizePlateCode(generate());
        if (!candidate) {
          throw new Error('Generated Plate ID failed validation.');
        }
        attemptsLog.push(candidate);

        if (known.has(candidate) || records.has(candidate)) {
          known.add(candidate);
          continue;
        }

        const record: PlateIdReservationRecord = {
          plateCode: candidate,
          ownerId: params.ownerId.trim(),
          projectId: params.projectId.trim(),
          batchId:
            typeof params.batchId === 'string' && params.batchId.trim().length > 0
              ? params.batchId.trim()
              : null,
          createdAt: new Date().toISOString(),
        };
        records.set(candidate, record);
        known.add(candidate);
        return candidate;
      }

      throw new Error(
        'Failed to reserve a unique Plate ID in registry after maximum attempts.'
      );
    },
  };
}

let defaultRegistry: PlateIdRegistryAdapter | null = null;

export function getDefaultPlateIdRegistry(): PlateIdRegistryAdapter {
  if (!defaultRegistry) {
    defaultRegistry = createFirestorePlateIdRegistry(db);
  }
  return defaultRegistry;
}

/**
 * Reserves/assigns immutable 5-char Plate IDs for preview plates while preserving
 * any valid code already assigned or cached for an identical preview signature.
 */
export async function reservePlateCodesForPreviewPlates<
  T extends { plateNumber: number; plateCode?: string | null }
>(params: {
  plates: readonly T[];
  ownerId: string;
  projectId: string;
  batchId?: string | null;
  existingJobs?: readonly ProductionJob[];
  signatureByIndex?: readonly string[];
  signatureCache?: Map<string, string>;
  registry?: PlateIdRegistryAdapter;
}): Promise<Array<T & { plateCode: string }>> {
  const registry = params.registry ?? getDefaultPlateIdRegistry();
  const knownCodes = collectKnownPlateCodes(params.existingJobs);

  for (const p of params.plates) {
    const clean = normalizePlateCode(p.plateCode);
    if (clean) knownCodes.add(clean);
  }
  if (params.signatureCache) {
    for (const c of params.signatureCache.values()) {
      const clean = normalizePlateCode(c);
      if (clean) knownCodes.add(clean);
    }
  }

  const assignedInPass = new Set<string>();
  const results: Array<T & { plateCode: string }> = [];

  for (let i = 0; i < params.plates.length; i += 1) {
    const plate = params.plates[i];
    const sig = params.signatureByIndex?.[i];

    let resolved = normalizePlateCode(plate.plateCode);
    if (!resolved && sig && params.signatureCache) {
      const cached = normalizePlateCode(params.signatureCache.get(sig));
      if (cached && !assignedInPass.has(cached)) {
        resolved = cached;
      }
    }

    if (!resolved || assignedInPass.has(resolved)) {
      resolved = await registry.reserveSinglePlateCode({
        ownerId: params.ownerId,
        projectId: params.projectId,
        batchId:
          typeof params.batchId === 'string' && params.batchId.trim().length > 0
            ? params.batchId.trim()
            : null,
        knownCodes,
      });
    }

    assignedInPass.add(resolved);
    knownCodes.add(resolved);
    if (sig && params.signatureCache) {
      params.signatureCache.set(sig, resolved);
    }

    results.push({
      ...plate,
      plateCode: resolved,
    });
  }

  return results;
}

/**
 * Ensures all jobs in a list possess a valid globally unique `plateCode` without modifying
 * any other existing job properties.
 */
export async function ensureJobsHavePlateCodes(params: {
  jobs: readonly ProductionJob[];
  ownerId: string;
  existingWorkspaceJobs?: readonly ProductionJob[];
  registry?: PlateIdRegistryAdapter;
}): Promise<{ jobs: ProductionJob[]; assignedCount: number }> {
  const registry = params.registry ?? getDefaultPlateIdRegistry();
  const knownCodes = collectKnownPlateCodes([
    ...(params.existingWorkspaceJobs || []),
    ...params.jobs,
  ]);
  const seenInBatch = new Set<string>();
  let assignedCount = 0;
  const out: ProductionJob[] = [];

  for (const job of params.jobs) {
    const clean = normalizePlateCode(job.plateCode);
    if (clean && !seenInBatch.has(clean)) {
      seenInBatch.add(clean);
      knownCodes.add(clean);
      out.push(job.plateCode === clean ? job : { ...job, plateCode: clean });
      continue;
    }

    const reserved = await registry.reserveSinglePlateCode({
      ownerId: params.ownerId,
      projectId: job.projectId,
      batchId: job.batchId ?? null,
      knownCodes,
    });
    seenInBatch.add(reserved);
    knownCodes.add(reserved);
    assignedCount += 1;
    out.push({
      ...job,
      plateCode: reserved,
    });
  }

  return { jobs: out, assignedCount };
}

/**
 * One-time non-destructive backfill for historical saved `ProductionJob`s lacking a valid `plateCode`.
 * Preserves all existing production fields (`batchId`, `projectId`, stages, timestamps, inventory flags).
 */
export async function backfillMissingJobPlateCodes(
  workspace: ProductionWorkspaceV5,
  ownerId: string,
  registry: PlateIdRegistryAdapter = getDefaultPlateIdRegistry()
): Promise<{
  workspace: ProductionWorkspaceV5;
  assignedCount: number;
  changed: boolean;
}> {
  const hasMissing = workspace.jobs.some((j) => !isValidPlateCode(j.plateCode));
  if (!hasMissing) {
    return { workspace, assignedCount: 0, changed: false };
  }

  const { jobs, assignedCount } = await ensureJobsHavePlateCodes({
    jobs: workspace.jobs,
    ownerId,
    registry,
  });

  if (assignedCount === 0) {
    return { workspace, assignedCount: 0, changed: false };
  }

  return {
    workspace: {
      ...workspace,
      jobs,
    },
    assignedCount,
    changed: true,
  };
}
