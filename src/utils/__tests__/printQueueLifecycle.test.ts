import { describe, expect, it } from 'vitest';
import {
  computeProjectPlateProgress,
  countLetters,
  countPlateKeycaps,
  createFreshWorkspaceV5,
  emptyAlphabetMap,
  normalizeWorkspaceV5,
  PRIMARY_ADMIN_EMAIL,
} from '../../constants';
import {
  AdminActorContext,
  ProductionJob,
  ProductionProject,
  ProductionWorkspaceV5,
} from '../../types';
import {
  buildFirestoreSetDocPayload,
  findUndefinedPaths,
  prepareWorkspaceForFirestore,
} from '../firestorePayload';
import {
  archivePrintPlate,
  bulkArchivePrintPlates,
  bulkDeletePrintPlates,
  bulkRestorePrintPlates,
  cancelPrintingJob,
  computeIntelligentPlates,
  computeProjectDemandSummary,
  deletePrintPlate,
  filterQueueJobs,
  isAuthorizedAdmin,
  restorePrintPlate,
  transitionJobState,
} from '../productionEngine';
import { computeGlobalSchedule } from '../schedulingEngine';

const ADMIN_UID = 'owner-woopp-uid';
const ADMIN_ACTOR: AdminActorContext = {
  uid: ADMIN_UID,
  email: PRIMARY_ADMIN_EMAIL,
  isAnonymous: false,
};

function createTestWorkspace(): ProductionWorkspaceV5 {
  const base = createFreshWorkspaceV5(ADMIN_UID);
  const nowIso = '2026-10-29T08:00:00.000Z';

  const targetMapProjectA = {
    ...emptyAlphabetMap(),
    A: 138,
    B: 138,
    C: 100,
  };
  const targetMapProjectB = {
    ...emptyAlphabetMap(),
    Z: 138,
  };

  const projectA: ProductionProject = {
    id: 'proj-alpha',
    name: 'Klebang Walk Batch',
    salesChannel: 'Klebang Walk',
    priority: 'High',
    deadline: '2026-11-05',
    productType: '3D Clicker Keycap',
    assignedColorIds: ['color-0', 'color-1'],
    plateCapacity: 138,
    status: 'Active',
    notes: 'Main batch',
    targetsByColor: {
      'color-0': targetMapProjectA,
      'color-1': emptyAlphabetMap(),
    },
    carryForwardByColor: {
      'color-0': emptyAlphabetMap(),
      'color-1': emptyAlphabetMap(),
    },
    charmTargetsByColor: {
      'color-0': { CHARM_LOVE: 20, CHARM_STAR: 18 },
    },
    charmCarryForwardByColor: {},
    allocatedStockByColor: {
      'color-0': emptyAlphabetMap(),
      'color-1': emptyAlphabetMap(),
    },
    createdIso: nowIso,
    updatedIso: nowIso,
  };

  const projectB: ProductionProject = {
    id: 'proj-beta',
    name: 'Corporate Gift Order',
    salesChannel: 'Corporate/Event',
    priority: 'Normal',
    deadline: '2026-11-10',
    productType: '3D Clicker Keycap',
    assignedColorIds: ['color-1'],
    plateCapacity: 138,
    status: 'Active',
    notes: 'Unrelated project',
    targetsByColor: {
      'color-1': targetMapProjectB,
    },
    carryForwardByColor: {
      'color-1': emptyAlphabetMap(),
    },
    charmTargetsByColor: {},
    charmCarryForwardByColor: {},
    allocatedStockByColor: {
      'color-1': emptyAlphabetMap(),
    },
    createdIso: nowIso,
    updatedIso: nowIso,
  };

  const makeJob = (
    overrides: Partial<ProductionJob> & { id: string; plateNumber: number }
  ): ProductionJob => {
    const job: ProductionJob = {
      id: overrides.id,
      projectId: overrides.projectId ?? 'proj-alpha',
      colorId: overrides.colorId ?? 'color-0',
      plateNumber: overrides.plateNumber,
      plateCapacity: overrides.plateCapacity ?? 138,
      letters: overrides.letters ?? { A: 138 },
      plateMode: overrides.plateMode ?? 'alphabet_only',
      stage: overrides.stage ?? 'Planned',
      machineId: overrides.machineId ?? null,
      estimatedMinutes: overrides.estimatedMinutes ?? 180,
      actualMinutes: overrides.actualMinutes ?? 0,
      slicerVerified: overrides.slicerVerified ?? false,
      stockApplied: overrides.stockApplied ?? false,
      stockTransactionId: overrides.stockTransactionId ?? null,
      failedCount: overrides.failedCount ?? 0,
      failureReason: overrides.failureReason ?? '',
      notes: overrides.notes ?? '',
      createdIso: nowIso,
      updatedIso: nowIso,
      completedIso: overrides.completedIso ?? null,
    };
    if (overrides.charms) {
      job.charms = overrides.charms;
    }
    return job;
  };

  const plannedJob = makeJob({
    id: 'job-planned-1',
    plateNumber: 1,
    stage: 'Planned',
    letters: { A: 138 },
  });

  const readyJob = makeJob({
    id: 'job-ready-2',
    plateNumber: 2,
    stage: 'Ready to Print',
    slicerVerified: true,
    letters: { B: 138 },
    machineId: base.machines[1].id,
  });

  const mixedPlannedJob = makeJob({
    id: 'job-mixed-3',
    plateNumber: 3,
    stage: 'Planned',
    letters: { C: 100 },
    charms: { CHARM_LOVE: 20, CHARM_STAR: 18 },
    plateMode: 'mixed',
  });

  const unrelatedJob = makeJob({
    id: 'job-unrelated-b1',
    projectId: 'proj-beta',
    colorId: 'color-1',
    plateNumber: 1,
    stage: 'Ready to Print',
    slicerVerified: true,
    letters: { Z: 138 },
  });

  return {
    ...base,
    projects: [projectA, projectB],
    jobs: [plannedJob, readyJob, mixedPlannedJob, unrelatedJob],
  };
}

describe('Print Queue Lifecycle Management', () => {
  it('1. Deletes a Planned plate cleanly without regenerating or altering other plates', () => {
    const ws = createTestWorkspace();
    const res = deletePrintPlate(ws, 'job-planned-1', {
      actor: ADMIN_ACTOR,
      nowMs: 1_761_720_000_000,
    });

    expect(res.error).toBeUndefined();
    expect(res.nextWorkspace).toBeDefined();
    const nextWs = res.nextWorkspace!;

    expect(nextWs.jobs.find((j) => j.id === 'job-planned-1')).toBeUndefined();
    expect(nextWs.jobs).toHaveLength(3);
    expect(nextWs.log[0].msg).toContain('Deleted Plate 1');
  });

  it('2. Deletes a Ready to Print plate cleanly and updates remaining queue', () => {
    const ws = createTestWorkspace();
    const res = deletePrintPlate(ws, 'job-ready-2', {
      actor: ADMIN_ACTOR,
      nowMs: 1_761_720_000_000,
    });

    expect(res.error).toBeUndefined();
    const nextWs = res.nextWorkspace!;
    expect(nextWs.jobs.find((j) => j.id === 'job-ready-2')).toBeUndefined();
    expect(nextWs.jobs.map((j) => j.id)).toEqual([
      'job-planned-1',
      'job-mixed-3',
      'job-unrelated-b1',
    ]);
  });

  it('3. Prevents deletion of an actively Printing plate', () => {
    const ws = createTestWorkspace();
    const m0 = ws.machines[0].id;
    const started = transitionJobState(ws, 'job-ready-2', 'Printing', {
      machineId: m0,
      nowMs: 1_761_720_000_000,
    }).nextWorkspace!;

    const attempt = deletePrintPlate(started, 'job-ready-2', {
      actor: ADMIN_ACTOR,
      nowMs: 1_761_720_060_000,
    });

    expect(attempt.nextWorkspace).toBeUndefined();
    expect(attempt.error).toMatch(/actively printing/i);
    expect(started.jobs.find((j) => j.id === 'job-ready-2')?.stage).toBe('Printing');
  });

  it('4. Cancels an active Printing job, records reason & audit trail, and releases machine assignment', () => {
    const startMs = 1_761_720_000_000;
    const ws = createTestWorkspace();
    const m0 = ws.machines[0].id;
    const printingWs = transitionJobState(ws, 'job-ready-2', 'Printing', {
      machineId: m0,
      nowMs: startMs,
    }).nextWorkspace!;

    expect(printingWs.machines.find((m) => m.id === m0)?.status).toBe('Printing');
    expect(printingWs.machines.find((m) => m.id === m0)?.activeJobId).toBe(
      'job-ready-2'
    );

    const cancelMs = startMs + 25 * 60_000; // 25 minutes into print
    const cancelledRes = cancelPrintingJob(printingWs, 'job-ready-2', {
      reason: 'Nozzle clog detected on layer 14',
      actor: ADMIN_ACTOR,
      nowMs: cancelMs,
    });

    expect(cancelledRes.error).toBeUndefined();
    const afterCancel = cancelledRes.nextWorkspace!;

    const cancelledJob = afterCancel.jobs.find((j) => j.id === 'job-ready-2')!;
    expect(cancelledJob.stage).toBe('Cancelled');
    expect(cancelledJob.machineId).toBeNull();
    expect(cancelledJob.cancelledFromMachineId).toBe(m0);
    expect(cancelledJob.cancellationReason).toBe('Nozzle clog detected on layer 14');
    expect(cancelledJob.cancelledBy).toBe(PRIMARY_ADMIN_EMAIL);
    expect(cancelledJob.cancelledIso).toBe(new Date(cancelMs).toISOString());
    expect(cancelledJob.estimatedFinishAtMs).toBeNull();
    expect(cancelledJob.accumulatedElapsedSeconds).toBe(25 * 60);

    const releasedMachine = afterCancel.machines.find((m) => m.id === m0)!;
    expect(releasedMachine.status).toBe('Idle');
    expect(releasedMachine.activeJobId).toBeNull();

    // Cancelled job is hidden from Active Queue tab and visible in Cancelled tab
    expect(
      filterQueueJobs(afterCancel.jobs, {
        tab: 'active',
        projectId: 'ALL',
        colorId: 'ALL',
        machineId: 'ALL',
        status: 'ALL',
      }).some((j) => j.id === 'job-ready-2')
    ).toBe(false);
    expect(
      filterQueueJobs(afterCancel.jobs, {
        tab: 'cancelled',
        projectId: 'ALL',
        colorId: 'ALL',
        machineId: 'ALL',
        status: 'ALL',
      }).map((j) => j.id)
    ).toEqual(['job-ready-2']);

    // Activity history preserves cancellation
    expect(afterCancel.log[0].msg).toContain('Cancelled printing Plate 2');
    expect(afterCancel.log[0].msg).toContain('Nozzle clog detected on layer 14');
  });

  it('5. Archives and restores a Completed plate while strictly preserving inventory stock, duration, and machine counters', () => {
    const startMs = 1_761_720_000_000;
    const doneMs = startMs + 170 * 60_000;
    const ws = createTestWorkspace();
    const m0 = ws.machines[0].id;

    const printingWs = transitionJobState(ws, 'job-ready-2', 'Printing', {
      machineId: m0,
      nowMs: startMs,
    }).nextWorkspace!;
    const completedWs = transitionJobState(printingWs, 'job-ready-2', 'Completed', {
      machineId: m0,
      nowMs: doneMs,
    }).nextWorkspace!;

    const stockBeforeArchive = countLetters(completedWs.inventory.physicalByColor['color-0']);
    const machineBeforeArchive = completedWs.machines.find((m) => m.id === m0)!;
    expect(stockBeforeArchive).toBe(138);
    expect(machineBeforeArchive.totalCompletedPlates).toBe(1);
    expect(machineBeforeArchive.totalPrintMinutes).toBe(170);

    // Archive Completed plate
    const archivedRes = archivePrintPlate(completedWs, 'job-ready-2', {
      actor: ADMIN_ACTOR,
      nowMs: doneMs + 5000,
    });
    expect(archivedRes.error).toBeUndefined();
    const archivedWs = archivedRes.nextWorkspace!;

    const archivedJob = archivedWs.jobs.find((j) => j.id === 'job-ready-2')!;
    expect(archivedJob.archived).toBe(true);
    expect(archivedJob.archivedBy).toBe(PRIMARY_ADMIN_EMAIL);
    expect(archivedJob.stage).toBe('Completed');
    expect(archivedJob.actualMinutes).toBe(170);
    expect(countPlateKeycaps(archivedJob)).toBe(138);

    // Inventory physical stock, project progress, and machine counters remain untouched
    expect(countLetters(archivedWs.inventory.physicalByColor['color-0'])).toBe(138);
    expect(archivedWs.machines.find((m) => m.id === m0)?.totalCompletedPlates).toBe(1);
    expect(archivedWs.machines.find((m) => m.id === m0)?.totalPrintMinutes).toBe(170);
    const demandWhileArchived = computeProjectDemandSummary(
      archivedWs,
      archivedWs.projects[0]
    );
    expect(demandWhileArchived.completedKeycaps).toBe(138);
    expect(demandWhileArchived.unmetKeycaps).toBe(0);

    // Hidden from Active Queue, shown in Archived view
    expect(
      filterQueueJobs(archivedWs.jobs, {
        tab: 'active',
        projectId: 'ALL',
        colorId: 'ALL',
        machineId: 'ALL',
        status: 'ALL',
      }).some((j) => j.id === 'job-ready-2')
    ).toBe(false);
    expect(
      filterQueueJobs(archivedWs.jobs, {
        tab: 'archived',
        projectId: 'ALL',
        colorId: 'ALL',
        machineId: 'ALL',
        status: 'ALL',
      }).map((j) => j.id)
    ).toEqual(['job-ready-2']);

    // Restore archived plate without double-crediting stock
    const restoredRes = restorePrintPlate(archivedWs, 'job-ready-2', {
      actor: ADMIN_ACTOR,
      nowMs: doneMs + 10_000,
    });
    expect(restoredRes.error).toBeUndefined();
    const restoredWs = restoredRes.nextWorkspace!;
    expect(restoredWs.jobs.find((j) => j.id === 'job-ready-2')?.archived).toBe(false);
    expect(countLetters(restoredWs.inventory.physicalByColor['color-0'])).toBe(138);
  });

  it('6. Bulk deletes multiple eligible plates atomically and blocks mixed ineligible selections', () => {
    const ws = createTestWorkspace();
    const m0 = ws.machines[0].id;

    // Mixed selection containing a Completed plate must be rejected atomically without deleting Planned plates
    const completedWs = transitionJobState(ws, 'job-ready-2', 'Completed', {
      machineId: m0,
      nowMs: 1_761_720_000_000,
    }).nextWorkspace!;

    const mixedAttempt = bulkDeletePrintPlates(
      completedWs,
      ['job-planned-1', 'job-ready-2'],
      { actor: ADMIN_ACTOR }
    );
    expect(mixedAttempt.nextWorkspace).toBeUndefined();
    expect(mixedAttempt.error).toMatch(/Completed and cannot be deleted/i);

    // Eligible Planned + Ready to Print bulk delete succeeds atomically
    const validBulk = bulkDeletePrintPlates(
      ws,
      ['job-planned-1', 'job-ready-2', 'job-mixed-3'],
      { actor: ADMIN_ACTOR, nowMs: 1_761_720_000_000 }
    );
    expect(validBulk.error).toBeUndefined();
    expect(validBulk.deletedCount).toBe(3);
    expect(validBulk.nextWorkspace!.jobs.map((j) => j.id)).toEqual(['job-unrelated-b1']);

    // Bulk archive + bulk restore on historical plates
    const bulkArch = bulkArchivePrintPlates(completedWs, ['job-ready-2'], {
      actor: ADMIN_ACTOR,
    });
    expect(bulkArch.archivedCount).toBe(1);
    const bulkRest = bulkRestorePrintPlates(bulkArch.nextWorkspace!, ['job-ready-2'], {
      actor: ADMIN_ACTOR,
    });
    expect(bulkRest.restoredCount).toBe(1);
  });

  it('7. Prevents permanent deletion of Completed, Failed, Cancelled, and Archived records and enforces Admin authorization', () => {
    const ws = createTestWorkspace();
    const m0 = ws.machines[0].id;
    const m1 = ws.machines[1].id;
    const completedWs = transitionJobState(ws, 'job-ready-2', 'Completed', {
      machineId: m0,
    }).nextWorkspace!;
    const failedWs = transitionJobState(completedWs, 'job-planned-1', 'Failed / Reprint', {
      failureReason: 'Layer shift',
    }).nextWorkspace!;
    const printingWs = transitionJobState(failedWs, 'job-mixed-3', 'Printing', {
      machineId: m1,
    }).nextWorkspace!;
    const cancelledWs = cancelPrintingJob(printingWs, 'job-mixed-3', {
      actor: ADMIN_ACTOR,
      reason: 'Filament tangled',
    }).nextWorkspace!;

    // Completed cannot be deleted
    expect(
      deletePrintPlate(cancelledWs, 'job-ready-2', { actor: ADMIN_ACTOR }).error
    ).toMatch(/Completed and cannot be deleted/i);

    // Failed cannot be permanently deleted (must be archived)
    expect(
      deletePrintPlate(cancelledWs, 'job-planned-1', { actor: ADMIN_ACTOR }).error
    ).toMatch(/Archive Plate/i);

    // Cancelled cannot be permanently deleted (must be archived)
    expect(
      deletePrintPlate(cancelledWs, 'job-mixed-3', { actor: ADMIN_ACTOR }).error
    ).toMatch(/Archive Plate/i);

    // Unauthorized anonymous or mismatched-UID actor is blocked
    const anonActor: AdminActorContext = {
      uid: ADMIN_UID,
      email: PRIMARY_ADMIN_EMAIL,
      isAnonymous: true,
    };
    const intruderActor: AdminActorContext = {
      uid: 'other-user-uid',
      email: 'intruder@example.com',
      isAnonymous: false,
    };
    expect(isAuthorizedAdmin(anonActor, ws)).toBe(false);
    expect(isAuthorizedAdmin(intruderActor, ws)).toBe(false);
    expect(
      deletePrintPlate(ws, 'job-planned-1', { actor: intruderActor }).error
    ).toMatch(/Unauthorized/i);
  });

  it('8. Persists Cancelled and Archived lifecycle metadata through Firestore validation & reload normalization with zero undefined fields', () => {
    const nowMs = 1_761_720_000_000;
    const ws = createTestWorkspace();
    const m0 = ws.machines[0].id;
    const printingWs = transitionJobState(ws, 'job-ready-2', 'Printing', {
      machineId: m0,
      nowMs,
    }).nextWorkspace!;
    const cancelledWs = cancelPrintingJob(printingWs, 'job-ready-2', {
      reason: 'Stop test',
      actor: ADMIN_ACTOR,
      nowMs: nowMs + 600_000,
    }).nextWorkspace!;
    const archivedWs = archivePrintPlate(cancelledWs, 'job-ready-2', {
      actor: ADMIN_ACTOR,
      nowMs: nowMs + 900_000,
    }).nextWorkspace!;

    const prepared = prepareWorkspaceForFirestore(archivedWs, ADMIN_UID, {
      documentLabel: `users/${ADMIN_UID}/tracker/v5_workspace`,
    });
    const payload = buildFirestoreSetDocPayload(
      { ...prepared },
      `users/${ADMIN_UID}/tracker/v5_workspace`
    );

    // Zero undefined values anywhere in Firestore payload
    expect(findUndefinedPaths(payload)).toEqual([]);

    // Simulated Firestore reload round-trip
    const reloaded = normalizeWorkspaceV5(
      JSON.parse(JSON.stringify(payload)) as ProductionWorkspaceV5,
      ADMIN_UID
    );
    const reloadedJob = reloaded.jobs.find((j) => j.id === 'job-ready-2')!;
    expect(reloadedJob.stage).toBe('Cancelled');
    expect(reloadedJob.archived).toBe(true);
    expect(reloadedJob.cancellationReason).toBe('Stop test');
    expect(reloadedJob.cancelledBy).toBe(PRIMARY_ADMIN_EMAIL);
    expect(reloadedJob.cancelledFromMachineId).toBe(m0);
    expect(reloadedJob.archivedBy).toBe(PRIMARY_ADMIN_EMAIL);
  });

  it('9. Updates global schedule ETA and plate-based project progress on delete/cancel without auto-recreating deleted plates or restoring historical targets', () => {
    const nowMs = 1_761_720_000_000;
    // Narrow to a single online printer so sequential queue ETA changes deterministically
    const baseWs = createTestWorkspace();
    const m0 = baseWs.machines[0].id;
    const singlePrinterWs: ProductionWorkspaceV5 = {
      ...baseWs,
      machines: [baseWs.machines[0]],
    };

    const scheduleBefore = computeGlobalSchedule(singlePrinterWs, nowMs);
    const alphaEtaBefore = scheduleBefore.projectEtas.find(
      (pe) => pe.project.id === 'proj-alpha'
    )!;
    expect(alphaEtaBefore.outstandingPlates).toBe(3);
    expect(
      computeProjectPlateProgress(singlePrinterWs.jobs, 'proj-alpha').plannedKeycaps
    ).toBe(414);

    // Delete Plate 3 (138 pcs mixed) -> queue drops to 2 plates (276 pcs), ETA moves earlier, and deleted C/charms are NOT kept as historical targets
    const afterDelete = deletePrintPlate(singlePrinterWs, 'job-mixed-3', {
      actor: ADMIN_ACTOR,
      nowMs,
    }).nextWorkspace!;

    expect(afterDelete.jobs.filter((j) => j.projectId === 'proj-alpha')).toHaveLength(2);
    const progressAfterDelete = computeProjectPlateProgress(
      afterDelete.jobs,
      'proj-alpha'
    );
    expect(progressAfterDelete.totalValidPlates).toBe(2);
    expect(progressAfterDelete.plannedKeycaps).toBe(276);

    const scheduleAfterDelete = computeGlobalSchedule(afterDelete, nowMs);
    const alphaEtaAfterDelete = scheduleAfterDelete.projectEtas.find(
      (pe) => pe.project.id === 'proj-alpha'
    )!;
    expect(alphaEtaAfterDelete.outstandingPlates).toBe(2);
    expect(alphaEtaAfterDelete.estimatedCompletionMs!).toBeLessThan(
      alphaEtaBefore.estimatedCompletionMs!
    );

    // Deleted letter C and charms from Plate 3 are NOT retained to recreate deleted plates
    expect(afterDelete.projects[0].targetsByColor['color-0'].C).toBe(0);
    expect(afterDelete.projects[0].charmTargetsByColor?.['color-0']).toEqual({});

    // Start Plate 2 on m0 and then Cancel Printing -> machine becomes immediately free for Plate 1!
    const printingWs = transitionJobState(afterDelete, 'job-ready-2', 'Printing', {
      machineId: m0,
      nowMs,
    }).nextWorkspace!;
    const afterCancel = cancelPrintingJob(printingWs, 'job-ready-2', {
      actor: ADMIN_ACTOR,
      reason: 'User cancelled',
      nowMs: nowMs + 60_000,
    }).nextWorkspace!;

    const scheduleAfterCancel = computeGlobalSchedule(afterCancel, nowMs + 60_000);
    const alphaEtaAfterCancel = scheduleAfterCancel.projectEtas.find(
      (pe) => pe.project.id === 'proj-alpha'
    )!;
    expect(alphaEtaAfterCancel.outstandingPlates).toBe(1);
    expect(alphaEtaAfterCancel.cancelledPlates).toBe(1);
    expect(scheduleAfterCancel.nextAvailableMachine?.waitSeconds).toBe(0);

    // Regenerating from surviving valid plates never adds deleted Plate 3's letters/charms back
    const survivingLetters = afterCancel.jobs
      .filter((j) => j.projectId === 'proj-alpha' && j.stage !== 'Cancelled')
      .reduce((acc, j) => ({ ...acc, ...j.letters }), emptyAlphabetMap());
    const regenPlan = computeIntelligentPlates(
      afterCancel.jobs,
      'proj-alpha',
      'color-0',
      survivingLetters,
      138,
      180,
      {
        requestedCharms: {},
        mode: 'mixed',
      }
    );
    expect(regenPlan.totalNetCount).toBe(138);
    expect(regenPlan.fullPlates).toHaveLength(1);
    expect(regenPlan.fullPlates[0].letters.C || 0).toBe(0);
  });

  it('10. Leaves unrelated projects, plates, targets, and machines completely unchanged', () => {
    const ws = createTestWorkspace();
    const betaProjectSnapshot = JSON.stringify(
      ws.projects.find((p) => p.id === 'proj-beta')
    );
    const betaJobSnapshot = JSON.stringify(
      ws.jobs.find((j) => j.id === 'job-unrelated-b1')
    );

    const afterDelete = deletePrintPlate(ws, 'job-planned-1', {
      actor: ADMIN_ACTOR,
    }).nextWorkspace!;

    expect(
      JSON.stringify(afterDelete.projects.find((p) => p.id === 'proj-beta'))
    ).toBe(betaProjectSnapshot);
    expect(
      JSON.stringify(afterDelete.jobs.find((j) => j.id === 'job-unrelated-b1'))
    ).toBe(betaJobSnapshot);
  });
});
