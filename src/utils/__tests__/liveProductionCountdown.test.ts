import { describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase/firestore';
import {
  createFreshWorkspaceV5,
  emptyAlphabetMap,
  migrateFromLegacyV1,
  normalizeWorkspaceV5,
} from '../../constants';
import {
  LegacyTrackerState,
  ProductionJob,
  ProductionProject,
  ProductionWorkspaceV5,
} from '../../types';
import {
  formatCountdownHMS,
  formatDateTimeLocalInput,
  parseDateTimeLocalInputToUtcMs,
} from '../dateFormat';
import {
  buildFirestoreSetDocPayload,
  findUndefinedPaths,
  prepareWorkspaceForFirestore,
} from '../firestorePayload';
import {
  ETA_NEEDS_RECALIBRATION_LABEL,
  ETA_REACHED_LABEL,
  computeJobCountdownSnapshot,
  hydrateJobCountdownFields,
  parseUtcTimestampMs,
} from '../productionCountdown';
import {
  pauseOrResumePrintingJob,
  recalibratePrintingJobEta,
  transitionJobState,
} from '../productionEngine';
import { computeGlobalSchedule } from '../schedulingEngine';

/**
 * Simulates saving to Firebase Cloud Firestore (`users/{uid}/tracker/v5_workspace`)
 * and later opening/reloading the browser or logging in on another device.
 */
function simulateFirestoreRoundTrip(
  workspace: ProductionWorkspaceV5,
  uid = 'admin-woopp'
): ProductionWorkspaceV5 {
  const validated = prepareWorkspaceForFirestore(workspace, uid);
  expect(findUndefinedPaths(validated)).toEqual([]);
  const wireJson = JSON.parse(JSON.stringify(validated));
  return normalizeWorkspaceV5(wireJson, uid);
}

function seedWorkspaceWithQueuedJobs(): {
  workspace: ProductionWorkspaceV5;
  projectId: string;
  m1Id: string;
  m2Id: string;
  m3Id: string;
  m4Id: string;
  job4hId: string;
  queuedJob2Id: string;
  queuedJob3Id: string;
} {
  const ws = createFreshWorkspaceV5('admin-woopp');
  const colorId = ws.colors[0].id;
  const m1Id = ws.machines[0].id;
  const m2Id = ws.machines[1].id;
  const m3Id = ws.machines[2].id;
  const m4Id = ws.machines[3].id;

  const lettersPlate = { ...emptyAlphabetMap(), A: 50, B: 40, C: 40 };
  const projectId = 'proj-countdown-suite';

  const project: ProductionProject = {
    id: projectId,
    name: 'Keycap Batch — Live Countdown Suite',
    salesChannel: 'Klebang Walk',
    productType: 'Custom Keycap',
    priority: 'Normal',
    status: 'Active',
    deadline: '2026-11-10',
    plateCapacity: 138,
    assignedColorIds: [colorId],
    targetsByColor: {
      [colorId]: { ...emptyAlphabetMap(), A: 150, B: 120, C: 86 },
    },
    carryForwardByColor: {},
    allocatedStockByColor: {},
    notes: '',
    createdIso: '2026-10-30T05:00:00.000Z',
    updatedIso: '2026-10-30T05:00:00.000Z',
  };

  // Ensure all test printers have speedFactor = 1 and setupBufferMinutes = 0 for deterministic math
  const machines = ws.machines.map((m) => ({
    ...m,
    status: 'Idle' as const,
    activeJobId: null,
    speedFactor: 1,
    setupBufferMinutes: 0,
  }));

  const job4h: ProductionJob = {
    id: 'job-4h-plate-01',
    projectId,
    colorId,
    plateNumber: 1,
    plateCapacity: 138,
    letters: lettersPlate,
    stage: 'Ready to Print',
    machineId: m1Id,
    estimatedMinutes: 240, // 4 hours = 14,400,000 ms
    actualMinutes: 0,
    slicerVerified: true,
    stockApplied: false,
    stockTransactionId: null,
    failedCount: 0,
    failureReason: '',
    notes: '',
    createdIso: '2026-10-30T05:30:00.000Z',
    updatedIso: '2026-10-30T05:30:00.000Z',
    completedIso: null,
  };

  const job2: ProductionJob = {
    id: 'job-2h-plate-02',
    projectId,
    colorId,
    plateNumber: 2,
    plateCapacity: 138,
    letters: lettersPlate,
    stage: 'Ready to Print',
    machineId: m1Id,
    estimatedMinutes: 120, // 2 hours = 7,200,000 ms
    actualMinutes: 0,
    slicerVerified: true,
    stockApplied: false,
    stockTransactionId: null,
    failedCount: 0,
    failureReason: '',
    notes: '',
    createdIso: '2026-10-30T05:31:00.000Z',
    updatedIso: '2026-10-30T05:31:00.000Z',
    completedIso: null,
  };

  const job3: ProductionJob = {
    id: 'job-3h-plate-03',
    projectId,
    colorId,
    plateNumber: 3,
    plateCapacity: 138,
    letters: { ...emptyAlphabetMap(), A: 50, B: 40, C: 6 },
    stage: 'Ready to Print',
    machineId: m2Id,
    estimatedMinutes: 180, // 3 hours = 10,800,000 ms
    actualMinutes: 0,
    slicerVerified: true,
    stockApplied: false,
    stockTransactionId: null,
    failedCount: 0,
    failureReason: '',
    notes: '',
    createdIso: '2026-10-30T05:32:00.000Z',
    updatedIso: '2026-10-30T05:32:00.000Z',
    completedIso: null,
  };

  return {
    workspace: {
      ...ws,
      projects: [project],
      machines,
      jobs: [job4h, job2, job3],
      settings: {
        ...ws.settings,
        turnaroundBufferMinutes: 0,
        timezone: 'Asia/Kuala_Lumpur',
      },
    },
    projectId,
    m1Id,
    m2Id,
    m3Id,
    m4Id,
    job4hId: job4h.id,
    queuedJob2Id: job2.id,
    queuedJob3Id: job3.id,
  };
}

describe('Live Production Countdown — Timestamp-Based Wall-Clock Persistence', () => {
  // 2:00 PM Asia/Kuala_Lumpur (UTC+8) = 06:00:00.000Z
  const T_1400_START_MS = Date.parse('2026-10-30T06:00:00.000Z');
  // 3:00 PM Asia/Kuala_Lumpur (UTC+8) = 07:00:00.000Z (+1h)
  const T_1500_CLOSE_MS = Date.parse('2026-10-30T07:00:00.000Z');
  // 5:00 PM Asia/Kuala_Lumpur (UTC+8) = 09:00:00.000Z (+3h)
  const T_1700_REOPEN_MS = Date.parse('2026-10-30T09:00:00.000Z');
  // 6:00 PM Asia/Kuala_Lumpur (UTC+8) = 10:00:00.000Z (+4h exact finish)
  const T_1800_FINISH_MS = Date.parse('2026-10-30T10:00:00.000Z');
  // 6:45 PM Asia/Kuala_Lumpur (UTC+8) = 10:45:00.000Z (+4h45m past ETA)
  const T_1845_OVERDUE_MS = Date.parse('2026-10-30T10:45:00.000Z');

  it('Scenarios 1–3: Start a 4-hour print at 2:00 PM, close browser at 3:00 PM, reopen at 5:00 PM -> shows ~1 hour (01:00:00) remaining', () => {
    const { workspace, m1Id, job4hId } = seedWorkspaceWithQueuedJobs();

    // 1. Start 4-hour print at 2:00 PM
    const started = transitionJobState(workspace, job4hId, 'Printing', {
      machineId: m1Id,
      nowMs: T_1400_START_MS,
    });
    expect(started.error).toBeUndefined();
    expect(started.nextWorkspace).toBeDefined();

    const activeAtStart = started.nextWorkspace!.jobs.find(
      (j: ProductionJob) => j.id === job4hId
    )!;
    expect(activeAtStart.stage).toBe('Printing');
    expect(activeAtStart.actualStartedAt).toBe('2026-10-30T06:00:00.000Z');
    expect(activeAtStart.estimatedDurationMs).toBe(4 * 3_600_000); // 14,400,000 ms
    expect(activeAtStart.estimatedFinishAt).toBe('2026-10-30T10:00:00.000Z');
    expect(activeAtStart.pausedAt).toBeNull();
    expect(activeAtStart.remainingAtPauseMs).toBeNull();
    expect(activeAtStart.actualCompletedAt).toBeNull();

    // Verify countdown at 3:00 PM right before closing browser (3 hours left)
    const snapAt3pm = computeJobCountdownSnapshot(activeAtStart, T_1500_CLOSE_MS);
    expect(snapAt3pm.status).toBe('running');
    expect(snapAt3pm.remainingMs).toBe(3 * 3_600_000);
    expect(formatCountdownHMS(snapAt3pm.remainingSeconds)).toBe('03:00:00');

    // 2. Persist to Firestore & close browser (no countdown tick writes needed;
    //    even if an unrelated document save happened at 3:00 PM with serverUpdatedAt = 3:00 PM
    //    and legacy pendingServerStartSync flag, job timestamps remain untouched).
    const persisted = prepareWorkspaceForFirestore(
      started.nextWorkspace!,
      'admin-woopp'
    );
    const firestoreWireDoc = {
      ...JSON.parse(JSON.stringify(persisted)),
      serverUpdatedAt: Timestamp.fromMillis(T_1500_CLOSE_MS),
    };
    firestoreWireDoc.jobs[0].pendingServerStartSync = true;

    // 3. Reopen browser at 5:00 PM and hydrate from Firestore
    const reopenedWorkspace = normalizeWorkspaceV5(firestoreWireDoc, 'admin-woopp');
    const reopenedJob = reopenedWorkspace.jobs.find(
      (j: ProductionJob) => j.id === job4hId
    )!;

    // Start and finish timestamps MUST NOT be reset on reload/reopen
    expect(reopenedJob.actualStartedAt).toBe('2026-10-30T06:00:00.000Z');
    expect(reopenedJob.estimatedFinishAt).toBe('2026-10-30T10:00:00.000Z');
    expect(reopenedJob.isPaused).toBe(false);
    expect(reopenedJob.pendingServerStartSync).toBeUndefined();

    // Countdown immediately evaluates against 5:00 PM wall-clock time -> 1 hour remaining
    const snapAt5pm = computeJobCountdownSnapshot(reopenedJob, T_1700_REOPEN_MS);
    expect(snapAt5pm.status).toBe('running');
    expect(snapAt5pm.remainingMs).toBe(3_600_000);
    expect(snapAt5pm.remainingSeconds).toBe(3600);
    expect(formatCountdownHMS(snapAt5pm.remainingSeconds)).toBe('01:00:00');

    const scheduleAt5pm = computeGlobalSchedule(reopenedWorkspace, T_1700_REOPEN_MS);
    const slotAt5pm = scheduleAt5pm.slotsByJobId[job4hId];
    expect(slotAt5pm.remainingMsLive).toBe(3_600_000);
    expect(slotAt5pm.remainingSecondsLive).toBe(3600);
    expect(slotAt5pm.countdownStatus).toBe('running');
    expect(slotAt5pm.endMs).toBe(T_1800_FINISH_MS);
  });

  it('Scenario 4: Reopen after ETA has passed -> displays "ETA Reached — Awaiting Confirmation" and never auto-completes', () => {
    const { workspace, m1Id, job4hId } = seedWorkspaceWithQueuedJobs();
    const started = transitionJobState(workspace, job4hId, 'Printing', {
      machineId: m1Id,
      nowMs: T_1400_START_MS,
    }).nextWorkspace!;

    // Persist and reopen at 6:45 PM (45 minutes past the 6:00 PM ETA)
    const reopenedWorkspace = simulateFirestoreRoundTrip(started);
    const reopenedJob = reopenedWorkspace.jobs.find(
      (j: ProductionJob) => j.id === job4hId
    )!;

    // Stage MUST remain Printing until explicit user confirmation
    expect(reopenedJob.stage).toBe('Printing');
    expect(reopenedJob.stockApplied).toBe(false);
    expect(reopenedJob.actualCompletedAt).toBeNull();

    const snapOverdue = computeJobCountdownSnapshot(reopenedJob, T_1845_OVERDUE_MS);
    expect(snapOverdue.remainingMs).toBe(0);
    expect(snapOverdue.remainingSeconds).toBe(0);
    expect(snapOverdue.isAwaitingConfirmation).toBe(true);
    expect(snapOverdue.status).toBe('awaiting_confirmation');
    expect(ETA_REACHED_LABEL).toBe('ETA Reached — Awaiting Confirmation');

    const scheduleOverdue = computeGlobalSchedule(reopenedWorkspace, T_1845_OVERDUE_MS);
    const slot = scheduleOverdue.slotsByJobId[job4hId];
    expect(slot.isAwaitingConfirmation).toBe(true);
    expect(slot.countdownStatus).toBe('awaiting_confirmation');
    expect(slot.remainingSecondsLive).toBe(0);

    // Only when operator explicitly confirms completion does stage become Completed
    const confirmed = transitionJobState(reopenedWorkspace, job4hId, 'Completed', {
      machineId: m1Id,
      nowMs: T_1845_OVERDUE_MS,
    });
    expect(confirmed.error).toBeUndefined();
    const completedJob = confirmed.nextWorkspace!.jobs.find(
      (j: ProductionJob) => j.id === job4hId
    )!;
    expect(completedJob.stage).toBe('Completed');
    expect(completedJob.actualStartedAt).toBe('2026-10-30T06:00:00.000Z');
    expect(completedJob.actualCompletedAt).toBe('2026-10-30T10:45:00.000Z');
    expect(completedJob.estimatedFinishAt).toBeNull();
  });

  it('Scenarios 5 & 6: Pause freezes remaining time across browser close/reopen; Resume computes new estimatedFinishAt without counting paused duration', () => {
    const { workspace, m1Id, job4hId } = seedWorkspaceWithQueuedJobs();

    // Start 4h print at 2:00 PM (finish 6:00 PM)
    const startedWs = transitionJobState(workspace, job4hId, 'Printing', {
      machineId: m1Id,
      nowMs: T_1400_START_MS,
    }).nextWorkspace!;

    // Scenario 5: Pause at 3:00 PM (3 hours = 10,800,000 ms remaining)
    const pausedRes = pauseOrResumePrintingJob(
      startedWs,
      job4hId,
      'pause',
      undefined,
      T_1500_CLOSE_MS
    );
    expect(pausedRes.error).toBeUndefined();

    const pausedJob = pausedRes.nextWorkspace!.jobs.find(
      (j: ProductionJob) => j.id === job4hId
    )!;
    expect(pausedJob.isPaused).toBe(true);
    expect(pausedJob.pausedAt).toBe('2026-10-30T07:00:00.000Z');
    expect(pausedJob.remainingAtPauseMs).toBe(3 * 3_600_000);
    expect(pausedJob.estimatedFinishAt).toBeNull();
    expect(pausedJob.actualStartedAt).toBe('2026-10-30T06:00:00.000Z');

    // Close browser and reopen 4 hours later at 7:00 PM (11:00:00.000Z)
    const T_1900_MS = Date.parse('2026-10-30T11:00:00.000Z');
    const reopenedPausedWs = simulateFirestoreRoundTrip(pausedRes.nextWorkspace!);
    const reopenedPausedJob = reopenedPausedWs.jobs.find(
      (j: ProductionJob) => j.id === job4hId
    )!;

    const frozenSnap = computeJobCountdownSnapshot(reopenedPausedJob, T_1900_MS);
    expect(frozenSnap.status).toBe('paused');
    expect(frozenSnap.isPaused).toBe(true);
    expect(frozenSnap.remainingMs).toBe(3 * 3_600_000);
    expect(frozenSnap.remainingSeconds).toBe(10_800);
    expect(formatCountdownHMS(frozenSnap.remainingSeconds)).toBe('03:00:00');

    // Scenario 6: Resume at 7:00 PM -> new estimatedFinishAt = 7:00 PM + 3h = 10:00 PM (14:00:00.000Z)
    const resumedRes = pauseOrResumePrintingJob(
      reopenedPausedWs,
      job4hId,
      'resume',
      undefined,
      T_1900_MS
    );
    expect(resumedRes.error).toBeUndefined();

    const resumedJob = resumedRes.nextWorkspace!.jobs.find(
      (j: ProductionJob) => j.id === job4hId
    )!;
    expect(resumedJob.isPaused).toBe(false);
    expect(resumedJob.pausedAt).toBeNull();
    expect(resumedJob.remainingAtPauseMs).toBeNull();
    // Original 2:00 PM start time preserved; paused 4 hours NOT counted as active printing time
    expect(resumedJob.actualStartedAt).toBe('2026-10-30T06:00:00.000Z');
    expect(resumedJob.estimatedFinishAt).toBe('2026-10-30T14:00:00.000Z');

    // Check 30 minutes after resume (7:30 PM -> 2h 30m left)
    const T_1930_MS = Date.parse('2026-10-30T11:30:00.000Z');
    const postResumeSnap = computeJobCountdownSnapshot(resumedJob, T_1930_MS);
    expect(postResumeSnap.status).toBe('running');
    expect(postResumeSnap.remainingMs).toBe(2.5 * 3_600_000);
    expect(formatCountdownHMS(postResumeSnap.remainingSeconds)).toBe('02:30:00');
  });

  it('Scenario 7: Reload and login on a second device hydrates identical UTC timestamps and accurate remaining countdown', () => {
    const { workspace, m1Id, job4hId } = seedWorkspaceWithQueuedJobs();

    // Device A (Kuala Lumpur) starts 4h print at 2:00 PM MYT (06:00:00.000Z)
    const deviceAWs = transitionJobState(workspace, job4hId, 'Printing', {
      machineId: m1Id,
      nowMs: T_1400_START_MS,
    }).nextWorkspace!;

    const validatedForFirestore = prepareWorkspaceForFirestore(
      deviceAWs,
      'admin-woopp'
    );
    const firestorePayload = buildFirestoreSetDocPayload(
      validatedForFirestore as unknown as Record<string, unknown>
    );
    const serialized = JSON.parse(JSON.stringify(firestorePayload));

    // Device B logs into Firebase 2 hours 15 minutes later (08:15:00.000Z)
    const T_DEVICE_B_LOGIN_MS = Date.parse('2026-10-30T08:15:00.000Z');
    const deviceBWs = normalizeWorkspaceV5(serialized, 'admin-woopp');
    const deviceBJob = deviceBWs.jobs.find(
      (j: ProductionJob) => j.id === job4hId
    )!;

    expect(deviceBJob.actualStartedAt).toBe('2026-10-30T06:00:00.000Z');
    expect(deviceBJob.estimatedFinishAt).toBe('2026-10-30T10:00:00.000Z');
    expect(deviceBJob.estimatedDurationMs).toBe(14_400_000);

    const deviceBSnap = computeJobCountdownSnapshot(deviceBJob, T_DEVICE_B_LOGIN_MS);
    // 4h - 2h15m = 1h45m = 6,300,000 ms
    expect(deviceBSnap.remainingMs).toBe(6_300_000);
    expect(formatCountdownHMS(deviceBSnap.remainingSeconds)).toBe('01:45:00');
  });

  it('Scenario 8: Changing machine assignments does not reset unrelated timers and preserves progress when reassigning an active printer', () => {
    const {
      workspace,
      m1Id,
      m2Id,
      m3Id,
      m4Id,
      job4hId,
      queuedJob2Id,
      queuedJob3Id,
    } = seedWorkspaceWithQueuedJobs();

    // Start Job 1 (4h) on M1 at 2:00 PM, and Job 3 (3h) on M2 at 2:30 PM
    const T_1430_MS = Date.parse('2026-10-30T06:30:00.000Z');
    let ws = transitionJobState(workspace, job4hId, 'Printing', {
      machineId: m1Id,
      nowMs: T_1400_START_MS,
    }).nextWorkspace!;
    ws = transitionJobState(ws, queuedJob3Id, 'Printing', {
      machineId: m2Id,
      nowMs: T_1430_MS,
    }).nextWorkspace!;

    const job1Before = ws.jobs.find((j: ProductionJob) => j.id === job4hId)!;
    const job3Before = ws.jobs.find((j: ProductionJob) => j.id === queuedJob3Id)!;

    // At 3:30 PM, reassign queuedJob2 from M1 -> M3 via transitionJobState ('Ready to Print')
    const T_1530_MS = Date.parse('2026-10-30T07:30:00.000Z');
    ws = transitionJobState(ws, queuedJob2Id, 'Ready to Print', {
      machineId: m3Id,
      nowMs: T_1530_MS,
    }).nextWorkspace!;

    const job1AfterQueueChange = ws.jobs.find(
      (j: ProductionJob) => j.id === job4hId
    )!;
    const job3AfterQueueChange = ws.jobs.find(
      (j: ProductionJob) => j.id === queuedJob3Id
    )!;

    // Unrelated active timers are 100% untouched
    expect(job1AfterQueueChange.actualStartedAt).toBe(job1Before.actualStartedAt);
    expect(job1AfterQueueChange.estimatedFinishAt).toBe(job1Before.estimatedFinishAt);
    expect(job3AfterQueueChange.actualStartedAt).toBe(job3Before.actualStartedAt);
    expect(job3AfterQueueChange.estimatedFinishAt).toBe(job3Before.estimatedFinishAt);

    // Now move active Job 1 from M1 -> idle M4 (same speedFactor = 1) at 3:30 PM
    const reassigned = transitionJobState(ws, job4hId, 'Printing', {
      machineId: m4Id,
      nowMs: T_1530_MS,
    });
    expect(reassigned.error).toBeUndefined();

    const job1OnM4 = reassigned.nextWorkspace!.jobs.find(
      (j: ProductionJob) => j.id === job4hId
    )!;
    const job3Untouched = reassigned.nextWorkspace!.jobs.find(
      (j: ProductionJob) => j.id === queuedJob3Id
    )!;

    expect(job1OnM4.machineId).toBe(m4Id);
    // Job 1 MUST keep its 2:00 PM start and 6:00 PM finish (2h 30m left at 3:30 PM), NOT reset to 4h
    expect(job1OnM4.actualStartedAt).toBe('2026-10-30T06:00:00.000Z');
    expect(job1OnM4.estimatedFinishAt).toBe('2026-10-30T10:00:00.000Z');
    expect(computeJobCountdownSnapshot(job1OnM4, T_1530_MS).remainingMs).toBe(
      2.5 * 3_600_000
    );

    // Job 3 on M2 remains completely untouched
    expect(job3Untouched.actualStartedAt).toBe('2026-10-30T06:30:00.000Z');
    expect(job3Untouched.estimatedFinishAt).toBe('2026-10-30T09:30:00.000Z');
  });

  it('Scenario 9: Persists all required Firestore timestamp fields cleanly and safely migrates/recalibrates legacy jobs without inventing start times', () => {
    const { workspace, m1Id, job4hId } = seedWorkspaceWithQueuedJobs();

    // Verify full lifecycle persistence: Start -> Pause -> Resume -> Complete
    const startedWs = transitionJobState(workspace, job4hId, 'Printing', {
      machineId: m1Id,
      nowMs: T_1400_START_MS,
    }).nextWorkspace!;
    const validatedStart = prepareWorkspaceForFirestore(startedWs, 'admin-woopp');
    expect(findUndefinedPaths(validatedStart)).toEqual([]);
    const persistedStartJob = validatedStart.jobs.find(
      (j: ProductionJob) => j.id === job4hId
    )!;
    expect(persistedStartJob).toMatchObject({
      actualStartedAt: '2026-10-30T06:00:00.000Z',
      estimatedDurationMs: 14_400_000,
      estimatedFinishAt: '2026-10-30T10:00:00.000Z',
      pausedAt: null,
      remainingAtPauseMs: null,
      actualCompletedAt: null,
    });

    // Also verify Firestore Timestamp object compatibility in parseUtcTimestampMs / hydration
    const firestoreTsJob = hydrateJobCountdownFields({
      ...persistedStartJob,
      actualStartedAt: Timestamp.fromMillis(T_1400_START_MS) as unknown as string,
      estimatedFinishAt: Timestamp.fromMillis(T_1800_FINISH_MS) as unknown as string,
    });
    expect(parseUtcTimestampMs(Timestamp.fromMillis(T_1400_START_MS))).toBe(T_1400_START_MS);
    expect(firestoreTsJob.actualStartedAt).toBe('2026-10-30T06:00:00.000Z');
    expect(firestoreTsJob.estimatedFinishAt).toBe('2026-10-30T10:00:00.000Z');

    // Verify legacy v5 job that persisted startedAtMs + estimatedMinutes (without estimatedFinishAt) migrates cleanly
    const legacyV5WithStartOnly = hydrateJobCountdownFields({
      ...persistedStartJob,
      actualStartedAt: undefined,
      estimatedFinishAt: undefined,
      estimatedFinishAtMs: undefined,
      estimatedDurationMs: undefined,
      startedAtMs: T_1400_START_MS,
      estimatedMinutes: 240,
    });
    expect(legacyV5WithStartOnly.actualStartedAt).toBe('2026-10-30T06:00:00.000Z');
    expect(legacyV5WithStartOnly.estimatedFinishAt).toBe('2026-10-30T10:00:00.000Z');
    expect(legacyV5WithStartOnly.needsEtaRecalibration).toBeUndefined();

    // Verify legacy v1 migration does NOT invent historical start times for active prints
    const legacyV1State: LegacyTrackerState = {
      colors: ['White'],
      machines: ['Printer 1'],
      jobs: [
        {
          id: 'legacy-job-1',
          color: 0,
          plate: 1,
          letters: { ...emptyAlphabetMap(), A: 50, B: 40, C: 40 },
          status: 'Sedang print',
          machine: 'Printer 1',
          notes: '',
          updated: '30/10/2026',
        },
      ],
      log: [],
    };
    const migratedV1 = migrateFromLegacyV1(legacyV1State, 'admin-woopp');
    const legacyActiveJob = migratedV1.jobs[0];
    expect(legacyActiveJob.stage).toBe('Printing');
    expect(legacyActiveJob.actualStartedAt).toBeNull();
    expect(legacyActiveJob.estimatedFinishAt).toBeNull();
    expect(legacyActiveJob.needsEtaRecalibration).toBe(true);

    const uncalibratedSnap = computeJobCountdownSnapshot(legacyActiveJob, T_1700_REOPEN_MS);
    expect(uncalibratedSnap.status).toBe('needs_recalibration');
    expect(uncalibratedSnap.needsEtaRecalibration).toBe(true);
    expect(ETA_NEEDS_RECALIBRATION_LABEL).toBe('ETA needs recalibration');

    // Recalibrate Mode A: Enter remaining duration (90 minutes) -> sets estimatedFinishAt without inventing actualStartedAt
    const recalByRem = recalibratePrintingJobEta(
      migratedV1,
      legacyActiveJob.id,
      { mode: 'remaining_duration', remainingMinutes: 90 },
      T_1700_REOPEN_MS
    );
    expect(recalByRem.error).toBeUndefined();
    const recalRemJob = recalByRem.nextWorkspace!.jobs[0];
    expect(recalRemJob.needsEtaRecalibration).toBeUndefined();
    expect(recalRemJob.actualStartedAt).toBeNull();
    expect(recalRemJob.estimatedFinishAt).toBe(
      new Date(T_1700_REOPEN_MS + 90 * 60_000).toISOString()
    );
    expect(computeJobCountdownSnapshot(recalRemJob, T_1700_REOPEN_MS).remainingMs).toBe(
      90 * 60_000
    );

    // Recalibrate Mode B: Enter actual start time via workspace timezone input
    const localInputStr = formatDateTimeLocalInput(T_1500_CLOSE_MS, 'Asia/Kuala_Lumpur');
    expect(localInputStr).toBe('2026-10-30T15:00');
    const parsedUtcStartMs = parseDateTimeLocalInputToUtcMs(
      localInputStr,
      'Asia/Kuala_Lumpur'
    );
    expect(parsedUtcStartMs).toBe(T_1500_CLOSE_MS);

    const recalByStart = recalibratePrintingJobEta(
      migratedV1,
      legacyActiveJob.id,
      { mode: 'actual_start_time', actualStartedAtMs: parsedUtcStartMs! },
      T_1700_REOPEN_MS
    );
    expect(recalByStart.error).toBeUndefined();
    const recalStartJob = recalByStart.nextWorkspace!.jobs[0];
    expect(recalStartJob.needsEtaRecalibration).toBeUndefined();
    expect(recalStartJob.actualStartedAt).toBe('2026-10-30T07:00:00.000Z');
    // Legacy plate estimatedMinutes = 195m (3h 15m) -> finish at 10:15:00.000Z (1h 15m left at 5:00 PM)
    expect(recalStartJob.estimatedFinishAt).toBe('2026-10-30T10:15:00.000Z');
    expect(computeJobCountdownSnapshot(recalStartJob, T_1700_REOPEN_MS).remainingMs).toBe(
      75 * 60_000
    );
  });

  it('Scenario 10: Accurately computes global production ETA across active and queued jobs after browser reopen', () => {
    const {
      workspace,
      projectId,
      m1Id,
      m2Id,
      job4hId,
      queuedJob2Id,
      queuedJob3Id,
    } = seedWorkspaceWithQueuedJobs();

    // M1 starts 4h job4h at 2:00 PM (finishes 6:00 PM); queuedJob2 (2h) is queued behind it on M1 -> finishes 8:00 PM
    // M2 starts 3h queuedJob3 at 3:00 PM (finishes 6:00 PM)
    let ws = transitionJobState(workspace, job4hId, 'Printing', {
      machineId: m1Id,
      nowMs: T_1400_START_MS,
    }).nextWorkspace!;
    ws = transitionJobState(ws, queuedJob3Id, 'Printing', {
      machineId: m2Id,
      nowMs: T_1500_CLOSE_MS,
    }).nextWorkspace!;

    // Persist and reopen at 5:00 PM (09:00:00.000Z)
    const reopenedWs = simulateFirestoreRoundTrip(ws);
    const schedule = computeGlobalSchedule(reopenedWs, T_1700_REOPEN_MS);

    // M1 active job4h: 1h left -> ends 6:00 PM (10:00:00.000Z)
    expect(schedule.slotsByJobId[job4hId].remainingMsLive).toBe(3_600_000);
    expect(schedule.slotsByJobId[job4hId].endMs).toBe(T_1800_FINISH_MS);

    // M1 queued job2 (2h): starts immediately when M1 finishes at 6:00 PM -> ends 8:00 PM (12:00:00.000Z)
    const T_2000_MS = Date.parse('2026-10-30T12:00:00.000Z');
    expect(schedule.slotsByJobId[queuedJob2Id].startMs).toBe(T_1800_FINISH_MS);
    expect(schedule.slotsByJobId[queuedJob2Id].endMs).toBe(T_2000_MS);

    // M2 active job3 (3h started at 3:00 PM): 1h left at 5:00 PM -> ends 6:00 PM (10:00:00.000Z)
    expect(schedule.slotsByJobId[queuedJob3Id].remainingMsLive).toBe(3_600_000);
    expect(schedule.slotsByJobId[queuedJob3Id].endMs).toBe(T_1800_FINISH_MS);

    // Project ETA across all active + queued plates = 8:00 PM (12:00:00.000Z)
    const projectSummary = schedule.projectEtas.find((p) => p.project.id === projectId)!;
    expect(projectSummary).toBeDefined();
    expect(projectSummary.estimatedCompletionMs).toBe(T_2000_MS);
  });
});
