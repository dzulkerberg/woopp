import { describe, expect, it } from 'vitest';
import {
  deleteField,
  GeoPoint,
  increment,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
import { createFreshWorkspaceV5 } from '../../constants';
import { MachineStatus, ProductionWorkspaceV5 } from '../../types';
import {
  applyMachineUpdate,
  createActivityLogEntry,
  pauseOrResumePrintingJob,
  transitionJobState,
} from '../productionEngine';
import {
  buildFirestoreSetDocPayload,
  findUndefinedPaths,
  FirestorePayloadValidationError,
  prepareWorkspaceForFirestore,
  reportDevUndefinedDiagnostics,
} from '../firestorePayload';

/**
 * Recursively asserts that an object tree has ZERO `undefined` own property values
 * and ZERO `undefined` array elements — matching Firestore's strict `setDoc()` check.
 */
function assertNoUndefinedOwnProperties(value: unknown, currentPath = '<root>'): void {
  expect(value, `Unexpected undefined at ${currentPath}`).not.toBeUndefined();
  if (value === null || typeof value !== 'object') return;
  if (value instanceof Date || value instanceof Timestamp || value instanceof GeoPoint) {
    return;
  }
  const maybeSentinel = value as Record<string, unknown>;
  if (typeof maybeSentinel._methodName === 'string') {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertNoUndefinedOwnProperties(item, `${currentPath}[${index}]`);
    });
    return;
  }
  for (const key of Object.keys(value)) {
    const record = value as Record<string, unknown>;
    expect(
      Object.prototype.hasOwnProperty.call(record, key) && record[key] === undefined,
      `Own property "${currentPath}.${key}" must not have value undefined`
    ).toBe(false);
    assertNoUndefinedOwnProperties(record[key], `${currentPath}.${key}`);
  }
}

describe('Machine status updates & Firestore v5_workspace persistence', () => {
  it('saves machine status transitions across Idle, Printing, Maintenance, Offline, and Completed with zero undefined fields', () => {
    let ws = createFreshWorkspaceV5('user-123');
    const targetMachineId = ws.machines[0].id;
    const baseTime = 1_760_000_000_000;

    const statusSequence: {
      status: MachineStatus;
      maintenanceUntilMs?: number | null;
    }[] = [
      { status: 'Maintenance', maintenanceUntilMs: baseTime + 7_200_000 },
      { status: 'Offline', maintenanceUntilMs: null },
      { status: 'Printing', maintenanceUntilMs: null },
      { status: 'Completed', maintenanceUntilMs: null },
      { status: 'Idle', maintenanceUntilMs: null },
    ];

    statusSequence.forEach((step, idx) => {
      const res = applyMachineUpdate(
        ws,
        targetMachineId,
        {
          status: step.status,
          maintenanceUntilMs: step.maintenanceUntilMs,
        },
        baseTime + idx * 60_000
      );

      expect(res.error).toBeUndefined();
      expect(res.nextWorkspace).toBeDefined();
      ws = res.nextWorkspace!;

      // Even before prepareWorkspaceForFirestore, the producer itself must not emit undefined
      expect(findUndefinedPaths(ws)).toEqual([]);

      const validated = prepareWorkspaceForFirestore(ws, 'user-123');
      const finalDoc = buildFirestoreSetDocPayload(
        {
          ...validated,
          serverUpdatedAt: serverTimestamp(),
        },
        'users/user-123/tracker/v5_workspace'
      );

      assertNoUndefinedOwnProperties(finalDoc);

      const savedMachine = validated.machines.find((m) => m.id === targetMachineId)!;
      expect(savedMachine.status).toBe(step.status);
      expect(savedMachine.activeJobId).toBeNull();
      if (step.status === 'Maintenance') {
        expect(savedMachine.maintenanceUntilMs).toBe(baseTime + 7_200_000);
      } else {
        expect(savedMachine.maintenanceUntilMs).toBeNull();
      }

      // Verify activity log entry omits optional `projectId` rather than setting `projectId: undefined`
      expect(validated.log[0].category).toBe('machine');
      expect('projectId' in validated.log[0]).toBe(false);
    });
  });

  it('prevents partial machine updates with undefined properties from corrupting fields', () => {
    const ws = createFreshWorkspaceV5('user-123');
    const machine = ws.machines[0];

    const res = applyMachineUpdate(ws, machine.id, {
      status: 'Offline',
      speedFactor: undefined,
      setupBufferMinutes: undefined,
      maintenanceUntilMs: undefined,
      notes: undefined,
    });

    expect(res.error).toBeUndefined();
    const validated = prepareWorkspaceForFirestore(res.nextWorkspace!, 'user-123');
    assertNoUndefinedOwnProperties(validated);

    const updated = validated.machines[0];
    expect(updated.status).toBe('Offline');
    expect(updated.speedFactor).toBe(1);
    expect(updated.setupBufferMinutes).toBe(0);
    expect(updated.maintenanceUntilMs).toBeNull();
    expect(updated.notes).toBe('');
  });

  it('blocks switching a machine with an active Printing plate to Maintenance, Offline, or Idle', () => {
    const ws = createFreshWorkspaceV5('user-123');
    const machineId = ws.machines[0].id;
    const jobId = ws.jobs[0].id;

    const started = transitionJobState(ws, jobId, 'Printing', {
      machineId,
      nowMs: 1_760_000_000_000,
    });
    expect(started.error).toBeUndefined();

    for (const blockedStatus of ['Maintenance', 'Offline', 'Idle'] as const) {
      const attempt = applyMachineUpdate(started.nextWorkspace!, machineId, {
        status: blockedStatus,
      });
      expect(attempt.error).toContain('before switching status');
      expect(attempt.nextWorkspace).toBeUndefined();
    }
  });
});

describe('Nested optional fields, null defaults, and absent property omission', () => {
  it('uses null for intentionally empty nullable fields and omits truly absent optional properties across jobs, logs, inventory, and settings', () => {
    const base = createFreshWorkspaceV5('user-abc');
    const machineId = base.machines[0].id;
    const jobId = base.jobs[0].id;

    // Start, pause, resume, and complete a job to exercise nested scheduling & inventory fields
    const started = transitionJobState(base, jobId, 'Printing', {
      machineId,
      nowMs: 1_760_000_000_000,
    }).nextWorkspace!;
    const paused = pauseOrResumePrintingJob(
      started,
      jobId,
      'pause',
      undefined,
      1_760_000_600_000
    ).nextWorkspace!;
    const resumed = pauseOrResumePrintingJob(
      paused,
      jobId,
      'resume',
      120,
      1_760_000_900_000
    ).nextWorkspace!;

    // Inject nested optional edge cases (undefined overrides, absent optional properties)
    const dirtyWorkspace: ProductionWorkspaceV5 = {
      ...resumed,
      machines: resumed.machines.map((m, idx) =>
        idx === 1
          ? {
              ...m,
              activeJobId: null,
              maintenanceUntilMs: undefined,
              speedFactor: undefined,
              setupBufferMinutes: undefined,
            }
          : m
      ),
      jobs: resumed.jobs.map((j, idx) =>
        idx === 1
          ? {
              ...j,
              machineId: null,
              stockTransactionId: null,
              completedIso: null,
              machineDurationOverrides: {
                [machineId]: 180,
                'unused-printer': undefined as unknown as number,
              },
              startedAtMs: undefined,
              isPaused: undefined,
            }
          : idx === 2
          ? {
              ...j,
              machineDurationOverrides: {
                'only-undefined': undefined as unknown as number,
              },
            }
          : j
      ),
      log: [
        createActivityLogEntry({
          category: 'system',
          msg: 'Global buffer changed',
          projectId: undefined,
        }),
        createActivityLogEntry({
          category: 'project',
          msg: 'Project updated',
          projectId: base.projects[0].id,
        }),
      ],
      settings: {
        defaultPlateCapacity: 138,
        defaultProductType: '3D Clicker Keycap',
        theme: 'light',
        turnaroundBufferMinutes: undefined,
        timezone: undefined,
      },
    };

    const validated = prepareWorkspaceForFirestore(dirtyWorkspace, 'user-abc', {
      isDev: false,
    });

    assertNoUndefinedOwnProperties(validated);

    // Machine[1]: intentionally empty nullable fields are `null`; absent optional numbers are omitted
    expect(validated.machines[1].activeJobId).toBeNull();
    expect(validated.machines[1].maintenanceUntilMs).toBeNull();
    expect('speedFactor' in validated.machines[1]).toBe(false);
    expect('setupBufferMinutes' in validated.machines[1]).toBe(false);

    // Job[0] (resumed active print): nullable pause timestamp is preserved as `null`
    expect(validated.jobs[0].pausedAtMs).toBeNull();
    expect(validated.jobs[0].remainingSecondsAtPause).toBeNull();
    expect(validated.jobs[0].isPaused).toBe(false);

    // Job[1]: valid machine override preserved, undefined override key omitted, unstarted timestamps omitted
    expect(validated.jobs[1].machineId).toBeNull();
    expect(validated.jobs[1].completedIso).toBeNull();
    expect(validated.jobs[1].machineDurationOverrides).toEqual({ [machineId]: 180 });
    expect('startedAtMs' in validated.jobs[1]).toBe(false);
    expect('isPaused' in validated.jobs[1]).toBe(false);

    // Job[2]: all-undefined overrides map omitted completely
    expect('machineDurationOverrides' in validated.jobs[2]).toBe(false);

    // Logs: absent projectId omitted, present projectId preserved
    expect('projectId' in validated.log[0]).toBe(false);
    expect(validated.log[1].projectId).toBe(base.projects[0].id);

    // Settings: absent optional scheduling properties omitted without inventing arbitrary values
    expect('turnaroundBufferMinutes' in validated.settings).toBe(false);
    expect('timezone' in validated.settings).toBe(false);
  });

  it('preserves Firebase Timestamp, native Date, GeoPoint, and Firestore FieldValue sentinels without JSON serialization', () => {
    const ts = Timestamp.fromMillis(1_760_000_123_000);
    const jsDate = new Date('2026-10-29T08:00:00.000Z');
    const serverTs = serverTimestamp();
    const inc = increment(1);
    const del = deleteField();
    const point = new GeoPoint(2.1896, 102.2501);

    const payload = buildFirestoreSetDocPayload(
      {
        createdAt: ts,
        localDate: jsDate,
        serverUpdatedAt: serverTs,
        counter: inc,
        obsoleteField: del,
        coords: point,
        absentOptional: undefined,
        nested: {
          keepNull: null,
          dropUndefined: undefined,
          innerTimestamp: ts,
        },
      },
      'test/special_values',
      { isDev: false }
    );

    expect(payload.createdAt).toBe(ts);
    expect(payload.createdAt).toBeInstanceOf(Timestamp);
    expect(payload.localDate).toBe(jsDate);
    expect(payload.localDate).toBeInstanceOf(Date);
    expect(payload.serverUpdatedAt).toBe(serverTs);
    expect(payload.counter).toBe(inc);
    expect(payload.obsoleteField).toBe(del);
    expect(payload.coords).toBe(point);
    expect('absentOptional' in payload).toBe(false);
    expect(payload.nested.keepNull).toBeNull();
    expect('dropUndefined' in payload.nested).toBe(false);
    expect(payload.nested.innerTimestamp).toBe(ts);
  });
});

describe('Development diagnostics & required field validation', () => {
  it('reports exact property paths containing undefined in development mode only', () => {
    const sample = {
      machines: [{ id: 'm1', maintenanceUntilMs: undefined }],
      log: [{ id: 'l1', projectId: undefined }],
      jobs: [{ id: 'j1', machineDurationOverrides: { m1: undefined } }],
      serverUpdatedAt: serverTimestamp(),
    };

    const capturedDevPaths: string[][] = [];
    const devResult = reportDevUndefinedDiagnostics(sample, 'users/u1/tracker/v5_workspace', {
      isDev: true,
      onReport: (paths) => capturedDevPaths.push(paths),
    });

    expect(devResult).toEqual([
      'machines[0].maintenanceUntilMs',
      'log[0].projectId',
      'jobs[0].machineDurationOverrides.m1',
    ]);
    expect(capturedDevPaths).toHaveLength(1);

    // Production mode skips diagnostic overhead and emits nothing
    const capturedProdPaths: string[][] = [];
    const prodResult = reportDevUndefinedDiagnostics(sample, 'users/u1/tracker/v5_workspace', {
      isDev: false,
      onReport: (paths) => capturedProdPaths.push(paths),
    });
    expect(prodResult).toEqual([]);
    expect(capturedProdPaths).toHaveLength(0);
  });

  it('rejects missing required fields and NaN values instead of silently dropping or inventing defaults', () => {
    const brokenMachineWs = createFreshWorkspaceV5('user-123');
    brokenMachineWs.machines[0] = {
      ...brokenMachineWs.machines[0],
      name: '',
    };

    expect(() =>
      prepareWorkspaceForFirestore(brokenMachineWs, 'user-123', { isDev: false })
    ).toThrowError(FirestorePayloadValidationError);

    const nanJobWs = createFreshWorkspaceV5('user-123');
    nanJobWs.jobs[0] = {
      ...nanJobWs.jobs[0],
      estimatedMinutes: Number.NaN,
    };

    expect(() =>
      prepareWorkspaceForFirestore(nanJobWs, 'user-123', { isDev: false })
    ).toThrow(/jobs\[0\]\.estimatedMinutes/);
  });
});

describe('Cloud-Only Mode: one-time unsynced local data backup & non-destructive migration', () => {
  it('inspects unsynced v5 and v1 browser records in strictly read-only mode without deleting or mutating localStorage', async () => {
    const {
      inspectUnsyncedLocalData,
      buildCloudWorkspaceFromLocalBackup,
    } = await import('../legacyLocalBackup');
    const { STORAGE_KEY_V1, STORAGE_KEY_V5 } = await import('../../constants');

    const localSample = createFreshWorkspaceV5('local-owner');
    const rawV5 = JSON.stringify(localSample);

    let setItemCalls = 0;
    let removeItemCalls = 0;
    let clearCalls = 0;

    const storeMap = new Map<string, string>([[STORAGE_KEY_V5, rawV5]]);
    const mockStorage = {
      getItem: (key: string) => storeMap.get(key) ?? null,
      setItem: () => {
        setItemCalls += 1;
      },
      removeItem: () => {
        removeItemCalls += 1;
      },
      clear: () => {
        clearCalls += 1;
      },
    };

    const detectedV5 = inspectUnsyncedLocalData(mockStorage);
    expect(detectedV5).not.toBeNull();
    expect(detectedV5!.format).toBe('v5');
    expect(detectedV5!.sourceKey).toBe(STORAGE_KEY_V5);
    expect(detectedV5!.projectCount).toBe(localSample.projects.length);
    expect(detectedV5!.jobCount).toBe(localSample.jobs.length);

    const cloudWsFromV5 = buildCloudWorkspaceFromLocalBackup(detectedV5!, 'firebase-uid-999');
    expect(cloudWsFromV5.ownerId).toBe('firebase-uid-999');
    assertNoUndefinedOwnProperties(cloudWsFromV5);

    // Existing browser local record must NEVER be modified or deleted automatically
    expect(setItemCalls).toBe(0);
    expect(removeItemCalls).toBe(0);
    expect(clearCalls).toBe(0);
    expect(storeMap.get(STORAGE_KEY_V5)).toBe(rawV5);

    // Verify legacy v1 local record detection & migration to Cloud v5
    storeMap.delete(STORAGE_KEY_V5);
    const rawV1 = JSON.stringify({
      colors: ['Pink', 'Lavender'],
      machines: ['Bambu P1S #1'],
      jobs: [
        {
          id: 'legacy-job-1',
          color: 0,
          plate: 1,
          letters: { A: 4, B: 2 },
          status: 'Siap',
          machine: 'Bambu P1S #1',
          notes: 'First batch',
        },
      ],
      log: [{ time: '29/10/2026', msg: 'Completed plate 1' }],
    });
    storeMap.set(STORAGE_KEY_V1, rawV1);

    const detectedV1 = inspectUnsyncedLocalData(mockStorage);
    expect(detectedV1).not.toBeNull();
    expect(detectedV1!.format).toBe('v1');
    expect(detectedV1!.sourceKey).toBe(STORAGE_KEY_V1);
    expect(detectedV1!.jobCount).toBe(1);

    const cloudWsFromV1 = buildCloudWorkspaceFromLocalBackup(detectedV1!, 'firebase-uid-999');
    expect(cloudWsFromV1.ownerId).toBe('firebase-uid-999');
    expect(cloudWsFromV1.schemaVersion).toBe(5);
    expect(cloudWsFromV1.inventory.physicalByColor['color-0'].A).toBe(4);
    expect(cloudWsFromV1.inventory.physicalByColor['color-0'].B).toBe(2);
    assertNoUndefinedOwnProperties(cloudWsFromV1);

    // Browser storage remains completely untouched
    expect(setItemCalls).toBe(0);
    expect(removeItemCalls).toBe(0);
    expect(clearCalls).toBe(0);
    expect(storeMap.get(STORAGE_KEY_V1)).toBe(rawV1);

    // Empty or malformed storage returns null cleanly
    storeMap.set(STORAGE_KEY_V1, '{invalid-json');
    expect(inspectUnsyncedLocalData(mockStorage)).toBeNull();
  });
});

describe('Charm Keycaps: Auto Plate Generator, Scheduling, Inventory Isolation & Firestore Compatibility', () => {
  it('defines the 5 stable Charm IDs, labels, and symbols and defaults charm maps to zero', async () => {
    const {
      CHARM_DEFINITIONS,
      countCharms,
      emptyCharmsMap,
      normalizeWorkspaceV5,
    } = await import('../../constants');

    expect(CHARM_DEFINITIONS).toEqual([
      { id: 'CHARM_LOVE', label: 'LOVE', symbol: '♥' },
      { id: 'CHARM_STAR', label: 'STAR', symbol: '★' },
      { id: 'CHARM_FLOWER', label: 'FLOWER', symbol: '✿' },
      { id: 'CHARM_HASH', label: 'HASHTAG', symbol: '#' },
      { id: 'CHARM_AT', label: 'AT SIGN', symbol: '@' },
    ]);

    const defaults = emptyCharmsMap();
    expect(defaults).toEqual({
      CHARM_LOVE: 0,
      CHARM_STAR: 0,
      CHARM_FLOWER: 0,
      CHARM_HASH: 0,
      CHARM_AT: 0,
    });
    expect(countCharms(defaults)).toBe(0);

    // Older Firestore v5 records without any charm fields load cleanly with 0 charm counts
    const legacyV5Doc = createFreshWorkspaceV5('legacy-owner');
    delete (legacyV5Doc.projects[0] as unknown as Record<string, unknown>).charmTargetsByColor;
    delete (legacyV5Doc.projects[0] as unknown as Record<string, unknown>).charmCarryForwardByColor;
    const reloaded = normalizeWorkspaceV5(legacyV5Doc, 'legacy-owner');

    expect(countCharms(reloaded.projects[0].charmTargetsByColor?.['color-0'])).toBe(0);
    expect(reloaded.jobs.every((j) => countCharms(j.charms) === 0)).toBe(true);
  });

  it('distributes Alphabet Only, Charm Only, and Mixed (Alphabet + Charm) plates strictly <= 138 pcs without adding unrequested keycaps', async () => {
    const {
      countCharms,
      countLetters,
      countPlateKeycaps,
      DEFAULT_PLATE_CAPACITY,
      emptyAlphabetMap,
      emptyCharmsMap,
    } = await import('../../constants');
    const {
      computeIntelligentPlates,
      shouldPreserveExistingJobOnRegenerate,
    } = await import('../productionEngine');

    expect(DEFAULT_PLATE_CAPACITY).toBe(138);

    const requestedLetters = {
      ...emptyAlphabetMap(),
      A: 100,
      B: 60,
    }; // 160 alphabet pcs
    const requestedCharms = {
      ...emptyCharmsMap(),
      CHARM_LOVE: 50,
      CHARM_STAR: 40,
      CHARM_FLOWER: 20,
      CHARM_HASH: 15,
      CHARM_AT: 11,
    }; // 136 charm pcs
    // Total mixed = 160 + 136 = 296 pcs -> 2 full plates (138 + 138 = 276) + 20 remainder (118 remaining capacity on incomplete plate)

    // 1. Mixed Mode (Alphabet + Charm)
    const mixedDist = computeIntelligentPlates(
      [],
      'proj-1',
      'color-0',
      requestedLetters,
      138,
      195,
      {
        requestedCharms,
        mode: 'mixed',
      }
    );

    expect(mixedDist.fullPlates).toHaveLength(2);
    for (const plate of mixedDist.fullPlates) {
      expect(countPlateKeycaps(plate)).toBe(138);
      expect(countPlateKeycaps(plate)).toBeLessThanOrEqual(138);
    }
    expect(mixedDist.remainderCount).toBe(20);
    expect(mixedDist.neededForNextFullPlate).toBe(118); // Remaining capacity for incomplete 3rd plate

    // Verify exact conservation: never adds unrequested letters or charms
    const distributedLettersTotal =
      mixedDist.fullPlates.reduce((s, p) => s + countLetters(p.letters), 0) +
      countLetters(mixedDist.remainder);
    const distributedCharmsTotal =
      mixedDist.fullPlates.reduce((s, p) => s + countCharms(p.charms), 0) +
      countCharms(mixedDist.remainderCharms);

    expect(distributedLettersTotal).toBe(160);
    expect(distributedCharmsTotal).toBe(136);
    expect(mixedDist.fullPlates.every((p) => (p.letters.C || 0) === 0)).toBe(true);

    // 2. Charm Only Mode (150 charms -> 1 full plate of 138 + 12 remainder with 126 remaining capacity)
    const charmOnlyReq = {
      ...emptyCharmsMap(),
      CHARM_LOVE: 60,
      CHARM_STAR: 50,
      CHARM_FLOWER: 40,
    };
    const charmOnlyDist = computeIntelligentPlates(
      [],
      'proj-1',
      'color-0',
      requestedLetters,
      138,
      195,
      {
        requestedCharms: charmOnlyReq,
        mode: 'charm_only',
      }
    );

    expect(charmOnlyDist.fullPlates).toHaveLength(1);
    expect(countLetters(charmOnlyDist.fullPlates[0].letters)).toBe(0);
    expect(countCharms(charmOnlyDist.fullPlates[0].charms)).toBe(138);
    expect(charmOnlyDist.fullPlates[0].plateMode).toBe('charm_only');
    expect(charmOnlyDist.remainderCount).toBe(12);
    expect(charmOnlyDist.neededForNextFullPlate).toBe(126);

    // 3. Alphabet Only Mode ignores charms and distributes only A–Z
    const alphaOnlyDist = computeIntelligentPlates(
      [],
      'proj-1',
      'color-0',
      requestedLetters,
      138,
      195,
      {
        requestedCharms: charmOnlyReq,
        mode: 'alphabet_only',
      }
    );
    expect(alphaOnlyDist.fullPlates).toHaveLength(1);
    expect(countLetters(alphaOnlyDist.fullPlates[0].letters)).toBe(138);
    expect(countCharms(alphaOnlyDist.fullPlates[0].charms)).toBe(0);
    expect(alphaOnlyDist.remainderCount).toBe(22);

    // 4. Preserves Completed, Printing, Failed / Reprint, and cross-category plates
    const ws = createFreshWorkspaceV5('u-1');
    const baseJob = ws.jobs[0];
    expect(
      shouldPreserveExistingJobOnRegenerate({ ...baseJob, stage: 'Completed' }, 'mixed')
    ).toBe(true);
    expect(
      shouldPreserveExistingJobOnRegenerate({ ...baseJob, stage: 'Printing' }, 'mixed')
    ).toBe(true);
    expect(
      shouldPreserveExistingJobOnRegenerate({ ...baseJob, stage: 'Failed / Reprint' }, 'mixed')
    ).toBe(true);
    expect(
      shouldPreserveExistingJobOnRegenerate(
        {
          ...baseJob,
          stage: 'Planned',
          letters: {},
          charms: { CHARM_LOVE: 50 },
        },
        'alphabet_only'
      )
    ).toBe(true);
  });

  it('supports Charm & Mixed plates in parallel Machine Scheduling, ETA calculation, Firestore persistence, and keeps Inventory isolated for Charm-Only plates', async () => {
    const {
      countCharms,
      countPlateKeycaps,
      normalizeWorkspaceV5,
    } = await import('../../constants');
    const { computeGlobalSchedule } = await import('../schedulingEngine');

    let ws = createFreshWorkspaceV5('user-charm');
    const project = ws.projects[0];
    const colorId = project.assignedColorIds[0];
    const machineA = ws.machines[0].id;
    const machineB = ws.machines[1].id;
    const nowMs = 1_760_500_000_000;

    // Add a Charm-Only plate and a Mixed Alphabet+Charm plate
    const charmPlateId = 'job-charm-only-1';
    const mixedPlateId = 'job-mixed-1';

    ws = {
      ...ws,
      projects: ws.projects.map((p, idx) =>
        idx === 0
          ? {
              ...p,
              charmTargetsByColor: {
                [colorId]: {
                  CHARM_LOVE: 80,
                  CHARM_STAR: 58,
                  CHARM_HASH: 20,
                  CHARM_AT: 18,
                },
              },
              charmCarryForwardByColor: {
                [colorId]: {
                  CHARM_FLOWER: 5,
                },
              },
            }
          : p
      ),
      jobs: [
        {
          id: charmPlateId,
          projectId: project.id,
          colorId,
          plateNumber: 10,
          plateCapacity: 138,
          letters: {},
          charms: { CHARM_LOVE: 80, CHARM_STAR: 58 },
          plateMode: 'charm_only',
          stage: 'Ready to Print',
          machineId: machineA,
          estimatedMinutes: 180,
          actualMinutes: 0,
          slicerVerified: true,
          stockApplied: false,
          stockTransactionId: null,
          failedCount: 0,
          failureReason: '',
          notes: 'Charm plate',
          createdIso: new Date(nowMs).toISOString(),
          updatedIso: new Date(nowMs).toISOString(),
          completedIso: null,
        },
        {
          id: mixedPlateId,
          projectId: project.id,
          colorId,
          plateNumber: 11,
          plateCapacity: 138,
          letters: { A: 60, E: 40 },
          charms: { CHARM_HASH: 20, CHARM_AT: 18 },
          plateMode: 'mixed',
          stage: 'Ready to Print',
          machineId: machineB,
          estimatedMinutes: 210,
          actualMinutes: 0,
          slicerVerified: true,
          stockApplied: false,
          stockTransactionId: null,
          failedCount: 0,
          failureReason: '',
          notes: 'Mixed plate',
          createdIso: new Date(nowMs).toISOString(),
          updatedIso: new Date(nowMs).toISOString(),
          completedIso: null,
        },
      ],
    };

    expect(countPlateKeycaps(ws.jobs[0])).toBe(138);
    expect(countPlateKeycaps(ws.jobs[1])).toBe(138);

    // Parallel scheduling ETA: 180m on Machine A vs 210m on Machine B -> Project ETA equals max(180m, 210m), NOT 390m!
    const scheduleBefore = computeGlobalSchedule(ws, nowMs);
    expect(scheduleBefore.slotsByJobId[charmPlateId].assignedMachineId).toBe(machineA);
    expect(scheduleBefore.slotsByJobId[mixedPlateId].assignedMachineId).toBe(machineB);
    expect(scheduleBefore.projectEtas[0].estimatedCompletionMs).toBe(nowMs + 210 * 60_000);

    // Start & complete the Charm-Only plate -> must NOT alter Inventory Management stock or movements!
    const invBefore = JSON.stringify(ws.inventory);
    const startedRes = transitionJobState(ws, charmPlateId, 'Printing', {
      machineId: machineA,
      nowMs,
    });
    expect(startedRes.error).toBeUndefined();

    const completedRes = transitionJobState(
      startedRes.nextWorkspace!,
      charmPlateId,
      'Completed',
      {
        machineId: machineA,
        nowMs: nowMs + 175 * 60_000,
      }
    );
    expect(completedRes.error).toBeUndefined();
    const afterCompleteWs = completedRes.nextWorkspace!;

    // Inventory remains 100% untouched for Charm-Only plates
    expect(JSON.stringify(afterCompleteWs.inventory)).toBe(invBefore);
    const completedCharmJob = afterCompleteWs.jobs.find((j) => j.id === charmPlateId)!;
    expect(completedCharmJob.stage).toBe('Completed');
    expect(completedCharmJob.actualMinutes).toBe(175);
    expect(completedCharmJob.completedIso).not.toBeNull();

    // Validate & serialize for Firestore setDoc() and reload via normalizeWorkspaceV5
    const validatedForFirestore = prepareWorkspaceForFirestore(
      afterCompleteWs,
      'user-charm',
      { isDev: false }
    );
    const firestoreSetPayload = buildFirestoreSetDocPayload(
      {
        ...validatedForFirestore,
        serverUpdatedAt: serverTimestamp(),
      },
      'users/user-charm/tracker/v5_workspace',
      { isDev: false }
    );

    assertNoUndefinedOwnProperties(firestoreSetPayload);

    const roundTripped = normalizeWorkspaceV5(validatedForFirestore, 'user-charm');
    expect(roundTripped.projects[0].charmTargetsByColor?.[colorId]).toEqual({
      CHARM_LOVE: 80,
      CHARM_STAR: 58,
      CHARM_HASH: 20,
      CHARM_AT: 18,
    });
    expect(roundTripped.projects[0].charmCarryForwardByColor?.[colorId]).toEqual({
      CHARM_FLOWER: 5,
    });
    expect(countCharms(roundTripped.jobs[0].charms)).toBe(138);
    expect(roundTripped.jobs[1].charms).toEqual({ CHARM_HASH: 20, CHARM_AT: 18 });
    expect(roundTripped.jobs[1].plateMode).toBe('mixed');
  });
});


