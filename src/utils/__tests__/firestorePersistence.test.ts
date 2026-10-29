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

