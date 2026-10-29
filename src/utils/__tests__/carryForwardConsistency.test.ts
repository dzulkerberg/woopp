import { describe, expect, it } from 'vitest';
import { serverTimestamp } from 'firebase/firestore';
import {
  compactCharmsMap,
  compactLettersMap,
  computeProjectPlateProgress,
  countCharms,
  countLetters,
  createFreshWorkspaceV5,
  emptyAlphabetMap,
  normalizeWorkspaceV5,
  PRIMARY_ADMIN_EMAIL,
  sumAlphabetMaps,
} from '../../constants';
import {
  AdminActorContext,
  CharmsMap,
  LettersMap,
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
  clearProjectColorCarryForward,
  commitGeneratedPlatesToWorkspace,
  computeColorPlanningState,
  computeIntelligentPlates,
  computeProjectDemandSummary,
  deletePrintPlate,
  getPlateCarryForwardImpact,
  restorePrintPlate,
  transitionJobState,
} from '../productionEngine';

const ADMIN_ACTOR: AdminActorContext = {
  uid: 'owner-uid-1',
  email: PRIMARY_ADMIN_EMAIL,
  role: 'admin',
};

const NOW_MS = Date.UTC(2026, 9, 29, 12, 0, 0);

function createMultiProjectTestWorkspace(): ProductionWorkspaceV5 {
  const ws = createFreshWorkspaceV5('owner-uid-1');

  const projAlpha: ProductionProject = {
    id: 'proj-alpha',
    name: 'Klebang Walk Batch',
    salesChannel: 'Klebang Walk',
    priority: 'High',
    deadline: '2026-11-10',
    productType: '3D Clicker Keycap',
    assignedColorIds: ['color-0', 'color-1'],
    plateCapacity: 138,
    status: 'Active',
    notes: '',
    targetsByColor: {
      'color-0': emptyAlphabetMap(),
      'color-1': emptyAlphabetMap(),
    },
    carryForwardByColor: {
      'color-0': emptyAlphabetMap(),
      'color-1': emptyAlphabetMap(),
    },
    charmTargetsByColor: {},
    charmCarryForwardByColor: {},
    allocatedStockByColor: {},
    createdIso: new Date(NOW_MS - 86_400_000).toISOString(),
    updatedIso: new Date(NOW_MS - 86_400_000).toISOString(),
  };

  const projBeta: ProductionProject = {
    id: 'proj-beta',
    name: 'Vintage Night Market Drop',
    salesChannel: 'Vintage Night Market',
    priority: 'Normal',
    deadline: '2026-11-20',
    productType: '3D Clicker Keycap',
    assignedColorIds: ['color-0', 'color-1'],
    plateCapacity: 138,
    status: 'Active',
    notes: '',
    targetsByColor: {
      'color-0': { ...emptyAlphabetMap(), B: 200 },
    },
    carryForwardByColor: {
      'color-0': { ...emptyAlphabetMap(), B: 62 },
    },
    charmTargetsByColor: {
      'color-0': { CHARM_STAR: 20 },
    },
    charmCarryForwardByColor: {
      'color-0': { CHARM_STAR: 20 },
    },
    planningSessions: [
      {
        sessionId: 'beta-session-1',
        colorId: 'color-0',
        mode: 'mixed',
        plateCapacity: 138,
        generatedJobIds: ['job-beta-1'],
        carryForwardLetters: { B: 62 },
        carryForwardCharms: { CHARM_STAR: 20 },
        createdIso: new Date(NOW_MS - 3_600_000).toISOString(),
        updatedIso: new Date(NOW_MS - 3_600_000).toISOString(),
      },
    ],
    allocatedStockByColor: {},
    createdIso: new Date(NOW_MS - 86_400_000).toISOString(),
    updatedIso: new Date(NOW_MS - 86_400_000).toISOString(),
  };

  return {
    ...ws,
    projects: [projAlpha, projBeta],
    jobs: [
      {
        id: 'job-beta-1',
        projectId: 'proj-beta',
        colorId: 'color-0',
        plateNumber: 1,
        plateCapacity: 138,
        letters: { B: 138 },
        plateMode: 'alphabet_only',
        planningSessionId: 'beta-session-1',
        stage: 'Planned',
        machineId: null,
        estimatedMinutes: 195,
        actualMinutes: 0,
        slicerVerified: false,
        stockApplied: false,
        stockTransactionId: null,
        failedCount: 0,
        failureReason: '',
        notes: 'Beta untouched plate',
        createdIso: new Date(NOW_MS - 3_600_000).toISOString(),
        updatedIso: new Date(NOW_MS - 3_600_000).toISOString(),
        completedIso: null,
      },
    ],
  };
}

describe('Carry-Forward & Auto Plate Planner Data Consistency', () => {
  it('1. clears associated alphabet & charm carry-forward (including spilled-over items not on the plate) when a generated plate is deleted, and recalculates Remaining Demand = Target - Valid Allocation', () => {
    const ws = createMultiProjectTestWorkspace();

    // Request 138 'A' + 25 'Z' + 15 CHARM_LOVE + 10 CHARM_STAR = 188 pcs (1 full plate of 138 'A', carry-forward: Z=25, CHARM_LOVE=15, CHARM_STAR=10 = 50 pcs)
    // Notice that Z, CHARM_LOVE, and CHARM_STAR are NOT on Plate 1 at all! Naive subtraction of Plate 1's items would fail to clear them.
    const reqLetters: LettersMap = { ...emptyAlphabetMap(), A: 138, Z: 25 };
    const reqCharms: CharmsMap = { CHARM_LOVE: 15, CHARM_STAR: 10 };

    const dist = computeIntelligentPlates(
      ws.jobs,
      'proj-alpha',
      'color-0',
      reqLetters,
      138,
      195,
      { requestedCharms: reqCharms, mode: 'mixed' }
    );
    expect(dist.fullPlates).toHaveLength(1);
    expect(dist.fullPlates[0].letters).toEqual({ A: 138 });
    expect(dist.remainder).toEqual({ Z: 25 });
    expect(dist.remainderCharms).toEqual({ CHARM_LOVE: 15, CHARM_STAR: 10 });
    expect(dist.remainderCount).toBe(50);

    const committed = commitGeneratedPlatesToWorkspace(ws, {
      projectId: 'proj-alpha',
      colorId: 'color-0',
      plateCapacity: 138,
      mode: 'mixed',
      targetLetters: reqLetters,
      targetCharms: reqCharms,
      carryForwardLetters: dist.remainder,
      carryForwardCharms: dist.remainderCharms,
      confirmedPlates: dist.fullPlates,
      nowMs: NOW_MS,
    });
    expect(committed.error).toBeUndefined();
    const wsWithPlate = committed.nextWorkspace!;
    const createdPlate = committed.createdJobs![0];
    expect(createdPlate.planningSessionId).toBe(committed.sessionId);

    const alphaBefore = wsWithPlate.projects.find((p) => p.id === 'proj-alpha')!;
    // Planner never auto-syncs quantities into Initial Target Quantity (`targetQuantity`)
    expect('targetQuantity' in alphaBefore).toBe(false);

    const stateBefore = computeColorPlanningState(
      wsWithPlate.jobs,
      alphaBefore,
      'color-0'
    );
    expect(stateBefore.userTargetTotal).toBe(188);
    expect(stateBefore.activePlatesTotal).toBe(138);
    expect(stateBefore.completedTotal).toBe(0);
    expect(stateBefore.carryForwardTotal).toBe(50);
    expect(stateBefore.carryForwardLetters.Z).toBe(25);
    expect(stateBefore.carryForwardCharms.CHARM_LOVE).toBe(15);
    expect(stateBefore.carryForwardCharms.CHARM_STAR).toBe(10);

    // Preview impact before deletion
    const impact = getPlateCarryForwardImpact(wsWithPlate, createdPlate);
    expect(impact.beforeCarryForwardTotal).toBe(50);
    expect(impact.afterCarryForwardTotal).toBe(0);
    expect(impact.clearedCarryForwardCount).toBe(50);
    expect(impact.remainingActivePlatesCount).toBe(0);
    expect(impact.remainingValidKeycaps).toBe(0);

    // Delete Plate 1
    const delRes = deletePrintPlate(wsWithPlate, createdPlate.id, {
      actor: ADMIN_ACTOR,
      nowMs: NOW_MS + 5_000,
    });
    expect(delRes.error).toBeUndefined();
    const wsAfterDelete = delRes.nextWorkspace!;

    const alphaAfter = wsAfterDelete.projects.find((p) => p.id === 'proj-alpha')!;
    const stateAfter = computeColorPlanningState(
      wsAfterDelete.jobs,
      alphaAfter,
      'color-0'
    );

    // Stale carry-forward (Z: 25, CHARM_LOVE: 15, CHARM_STAR: 10) is completely cleared and NOT restored!
    expect(stateAfter.carryForwardTotal).toBe(0);
    expect(countLetters(alphaAfter.carryForwardByColor['color-0'])).toBe(0);
    expect(countCharms(alphaAfter.charmCarryForwardByColor?.['color-0'])).toBe(0);
    expect(alphaAfter.planningSessions).toBeUndefined();

    // Deleted plate historical targets are cleared so deleted plates and missing letters/charms are NEVER auto-recreated
    expect(stateAfter.userTargetTotal).toBe(0);
    expect(stateAfter.validAllocatedTotal).toBe(0);
    expect(stateAfter.remainingDemandTotal).toBe(0);
    expect(countLetters(alphaAfter.targetsByColor['color-0'])).toBe(0);
    expect(countCharms(alphaAfter.charmTargetsByColor?.['color-0'])).toBe(0);

    // Planning a fresh batch (e.g. B: 138) only plates B: 138 and never adds deleted A, Z, or charms
    const freshPlan = computeIntelligentPlates(
      wsAfterDelete.jobs,
      'proj-alpha',
      'color-0',
      { ...emptyAlphabetMap(), B: 138 },
      138,
      195,
      {
        requestedCharms: {},
        mode: 'mixed',
      }
    );
    expect(freshPlan.totalNetCount).toBe(138);
    expect(freshPlan.fullPlates).toHaveLength(1);
    expect(freshPlan.fullPlates[0].letters).toEqual({ B: 138 });
    expect(freshPlan.remainderCount).toBe(0);
  });

  it('2. invalidates incomplete-plate carry-forward when 1 plate of a 2-plate planning session is deleted while keeping the surviving plate intact', () => {
    const ws = createMultiProjectTestWorkspace();

    // 288 pcs target => Plate 1 (138) + Plate 2 (138) + Carry-Forward (12)
    const reqLetters: LettersMap = { ...emptyAlphabetMap(), K: 288 };
    const dist = computeIntelligentPlates(
      ws.jobs,
      'proj-alpha',
      'color-0',
      reqLetters,
      138,
      195,
      { mode: 'alphabet_only' }
    );
    expect(dist.fullPlates).toHaveLength(2);
    expect(dist.remainderCount).toBe(12);

    const committed = commitGeneratedPlatesToWorkspace(ws, {
      projectId: 'proj-alpha',
      colorId: 'color-0',
      plateCapacity: 138,
      mode: 'alphabet_only',
      targetLetters: reqLetters,
      targetCharms: {},
      carryForwardLetters: dist.remainder,
      carryForwardCharms: {},
      confirmedPlates: dist.fullPlates,
      nowMs: NOW_MS,
    });
    const ws2 = committed.nextWorkspace!;
    const [plate1, plate2] = committed.createdJobs!;

    // Delete Plate 2 only
    const delRes = deletePrintPlate(ws2, plate2.id, {
      actor: ADMIN_ACTOR,
      nowMs: NOW_MS + 1_000,
    });
    expect(delRes.error).toBeUndefined();
    const ws3 = delRes.nextWorkspace!;

    // Plate 1 remains untouched in queue
    expect(ws3.jobs.some((j) => j.id === plate1.id)).toBe(true);
    expect(ws3.jobs.some((j) => j.id === plate2.id)).toBe(false);

    const alpha = ws3.projects.find((p) => p.id === 'proj-alpha')!;
    const state = computeColorPlanningState(ws3.jobs, alpha, 'color-0');
    expect(state.userTargetTotal).toBe(138); // Reconciled strictly to surviving Plate 1 (deleted Plate 2 is never recreated automatically)
    expect(state.activePlatesTotal).toBe(138);
    expect(state.remainingDemandTotal).toBe(0);
    expect(state.carryForwardTotal).toBe(0); // Stale 12-pc remainder invalidated because session is incomplete

    // When operator explicitly enters a new total (288 K) with `preserveQueuedPlates: true`, surviving Plate 1 stays locked and 1 additional plate + 12 carry-forward is created
    const replacementDist = computeIntelligentPlates(
      ws3.jobs,
      'proj-alpha',
      'color-0',
      { ...emptyAlphabetMap(), K: 288 },
      138,
      195,
      { mode: 'alphabet_only', preserveQueuedPlates: true }
    );
    expect(replacementDist.lockedTotals.K).toBe(138);
    expect(replacementDist.totalNetCount).toBe(150);
    expect(replacementDist.fullPlates).toHaveLength(1);
    expect(replacementDist.remainderCount).toBe(12);

    const recommitted = commitGeneratedPlatesToWorkspace(ws3, {
      projectId: 'proj-alpha',
      colorId: 'color-0',
      plateCapacity: 138,
      mode: 'alphabet_only',
      targetLetters: compactLettersMap(
        sumAlphabetMaps([
          replacementDist.lockedTotals,
          sumAlphabetMaps(replacementDist.fullPlates.map((p) => p.letters)),
          replacementDist.remainder,
        ])
      ),
      targetCharms: {},
      carryForwardLetters: replacementDist.remainder,
      carryForwardCharms: {},
      confirmedPlates: replacementDist.fullPlates,
      preserveQueuedPlates: true,
      nowMs: NOW_MS + 2_000,
    });
    const ws4 = recommitted.nextWorkspace!;
    expect(ws4.jobs.some((j) => j.id === plate1.id)).toBe(true);
    const alphaFinal = ws4.projects.find((p) => p.id === 'proj-alpha')!;
    const finalState = computeColorPlanningState(ws4.jobs, alphaFinal, 'color-0');
    expect(finalState.userTargetTotal).toBe(288);
    expect(finalState.activePlatesTotal).toBe(276); // 2 full plates
    expect(finalState.remainingDemandTotal).toBe(12);
    expect(finalState.carryForwardTotal).toBe(12);
  });

  it('3. strictly isolates unrelated projects, unrelated colors, and independent cross-mode planning sessions on the same color', () => {
    const ws = createMultiProjectTestWorkspace();
    const originalBetaRef = ws.projects.find((p) => p.id === 'proj-beta')!;

    // 1) Color-1 in proj-alpha: 150 'M' => 1 plate (138) + 12 carry-forward
    const distColor1 = computeIntelligentPlates(
      ws.jobs,
      'proj-alpha',
      'color-1',
      { ...emptyAlphabetMap(), M: 150 },
      138,
      195,
      { mode: 'alphabet_only' }
    );
    const step1 = commitGeneratedPlatesToWorkspace(ws, {
      projectId: 'proj-alpha',
      colorId: 'color-1',
      plateCapacity: 138,
      mode: 'alphabet_only',
      targetLetters: { ...emptyAlphabetMap(), M: 150 },
      targetCharms: {},
      carryForwardLetters: distColor1.remainder,
      carryForwardCharms: {},
      confirmedPlates: distColor1.fullPlates,
      nowMs: NOW_MS,
    }).nextWorkspace!;

    // 2) Color-0 in proj-alpha (Alphabet Only session): 160 'A' => 1 plate (138) + 22 A carry-forward
    const distAlphaSession = computeIntelligentPlates(
      step1.jobs,
      'proj-alpha',
      'color-0',
      { ...emptyAlphabetMap(), A: 160 },
      138,
      195,
      { mode: 'alphabet_only' }
    );
    const step2 = commitGeneratedPlatesToWorkspace(step1, {
      projectId: 'proj-alpha',
      colorId: 'color-0',
      plateCapacity: 138,
      mode: 'alphabet_only',
      targetLetters: { ...emptyAlphabetMap(), A: 160 },
      targetCharms: {},
      carryForwardLetters: distAlphaSession.remainder,
      carryForwardCharms: {},
      confirmedPlates: distAlphaSession.fullPlates,
      nowMs: NOW_MS + 100,
    });
    const alphabetJob = step2.createdJobs![0];

    // 3) Color-0 in proj-alpha (Charm Only session): 155 CHARM_FLOWER => 1 plate (138) + 17 CHARM_FLOWER carry-forward
    const distCharmSession = computeIntelligentPlates(
      step2.nextWorkspace!.jobs,
      'proj-alpha',
      'color-0',
      { ...emptyAlphabetMap(), A: 160 },
      138,
      195,
      {
        requestedCharms: { CHARM_FLOWER: 155 },
        mode: 'charm_only',
      }
    );
    const step3 = commitGeneratedPlatesToWorkspace(step2.nextWorkspace!, {
      projectId: 'proj-alpha',
      colorId: 'color-0',
      plateCapacity: 138,
      mode: 'charm_only',
      targetLetters: { ...emptyAlphabetMap(), A: 160 },
      targetCharms: { CHARM_FLOWER: 155 },
      carryForwardLetters: distAlphaSession.remainder,
      carryForwardCharms: distCharmSession.remainderCharms,
      confirmedPlates: distCharmSession.fullPlates,
      nowMs: NOW_MS + 200,
    });
    const charmJob = step3.createdJobs![0];
    const wsBeforeDelete = step3.nextWorkspace!;

    // Delete ONLY the Charm Only plate on (proj-alpha, color-0)
    const delCharmRes = deletePrintPlate(wsBeforeDelete, charmJob.id, {
      actor: ADMIN_ACTOR,
      nowMs: NOW_MS + 500,
    });
    expect(delCharmRes.error).toBeUndefined();
    const wsAfterDelete = delCharmRes.nextWorkspace!;

    // Verify proj-beta was never touched (exact object reference preserved + carry-forward intact)
    const betaAfter = wsAfterDelete.projects.find((p) => p.id === 'proj-beta')!;
    expect(betaAfter).toBe(wsBeforeDelete.projects.find((p) => p.id === 'proj-beta'));
    expect(betaAfter.carryForwardByColor['color-0'].B).toBe(62);
    expect(betaAfter.charmCarryForwardByColor?.['color-0']?.CHARM_STAR).toBe(20);
    expect(originalBetaRef.id).toBe('proj-beta');

    // Verify Color-1 in proj-alpha still has its 12 'M' carry-forward untouched
    const alphaAfter = wsAfterDelete.projects.find((p) => p.id === 'proj-alpha')!;
    const color1State = computeColorPlanningState(
      wsAfterDelete.jobs,
      alphaAfter,
      'color-1'
    );
    expect(color1State.carryForwardTotal).toBe(12);
    expect(color1State.carryForwardLetters.M).toBe(12);

    // Verify Color-0 in proj-alpha: Charm carry-forward (17) is cleared, while Alphabet session carry-forward (22 'A') is preserved!
    const color0State = computeColorPlanningState(
      wsAfterDelete.jobs,
      alphaAfter,
      'color-0'
    );
    expect(color0State.carryForwardCharmsCount).toBe(0);
    expect(color0State.carryForwardLettersCount).toBe(22);
    expect(color0State.carryForwardLetters.A).toBe(22);
    expect(wsAfterDelete.jobs.some((j) => j.id === alphabetJob.id)).toBe(true);
  });

  it('4. reconciles bulk deletion, active print cancellation, and archive/restore lifecycle transitions while preserving Completed plate history', () => {
    const ws = createMultiProjectTestWorkspace();

    // Generate 2 plates + 24 carry-forward on proj-alpha color-0 (300 'C' total)
    const reqLetters: LettersMap = { ...emptyAlphabetMap(), C: 300 };
    const dist = computeIntelligentPlates(
      ws.jobs,
      'proj-alpha',
      'color-0',
      reqLetters,
      138,
      195,
      { mode: 'alphabet_only' }
    );
    const committed = commitGeneratedPlatesToWorkspace(ws, {
      projectId: 'proj-alpha',
      colorId: 'color-0',
      plateCapacity: 138,
      mode: 'alphabet_only',
      targetLetters: reqLetters,
      targetCharms: {},
      carryForwardLetters: dist.remainder,
      carryForwardCharms: {},
      confirmedPlates: dist.fullPlates,
      nowMs: NOW_MS,
    });
    const [plate1, plate2] = committed.createdJobs!;
    let curWs = committed.nextWorkspace!;

    // Start & Complete Plate 1 on machine-1
    curWs = transitionJobState(curWs, plate1.id, 'Printing', {
      machineId: curWs.machines[0].id,
      nowMs: NOW_MS + 1_000,
    }).nextWorkspace!;
    curWs = transitionJobState(curWs, plate1.id, 'Completed', {
      machineId: curWs.machines[0].id,
      nowMs: NOW_MS + 120 * 60_000,
    }).nextWorkspace!;

    // Archive Completed Plate 1: carry-forward (24) and completed count (138) MUST stay intact!
    curWs = archivePrintPlate(curWs, plate1.id, {
      actor: ADMIN_ACTOR,
      nowMs: NOW_MS + 121 * 60_000,
    }).nextWorkspace!;

    let alpha = curWs.projects.find((p) => p.id === 'proj-alpha')!;
    let state = computeColorPlanningState(curWs.jobs, alpha, 'color-0');
    expect(state.completedTotal).toBe(138);
    expect(state.activePlatesTotal).toBe(138);
    expect(state.carryForwardTotal).toBe(24);
    expect(state.remainingDemandTotal).toBe(24);

    // Restore Completed Plate 1: state remains identical
    curWs = restorePrintPlate(curWs, plate1.id, {
      actor: ADMIN_ACTOR,
      nowMs: NOW_MS + 122 * 60_000,
    }).nextWorkspace!;
    alpha = curWs.projects.find((p) => p.id === 'proj-alpha')!;
    state = computeColorPlanningState(curWs.jobs, alpha, 'color-0');
    expect(state.completedTotal).toBe(138);
    expect(state.carryForwardTotal).toBe(24);

    // Now start Plate 2 Printing, then Cancel Printing Plate 2!
    curWs = transitionJobState(curWs, plate2.id, 'Printing', {
      machineId: curWs.machines[0].id,
      nowMs: NOW_MS + 125 * 60_000,
    }).nextWorkspace!;
    curWs = cancelPrintingJob(curWs, plate2.id, {
      reason: 'Filament tangle',
      actor: ADMIN_ACTOR,
      nowMs: NOW_MS + 140 * 60_000,
    }).nextWorkspace!;

    alpha = curWs.projects.find((p) => p.id === 'proj-alpha')!;
    state = computeColorPlanningState(curWs.jobs, alpha, 'color-0');
    // Completed Plate 1 (138) is preserved; Cancelled Plate 2 is no longer valid allocation; session carry-forward (24) is invalidated!
    expect(state.completedTotal).toBe(138);
    expect(state.activePlatesTotal).toBe(0);
    expect(state.carryForwardTotal).toBe(0);
    expect(state.remainingDemandTotal).toBe(162); // 300 target - 138 completed

    // Bulk archive Completed Plate 1 + Cancelled Plate 2 and Bulk restore them: completed history & remaining demand stay consistent
    const bulkArch = bulkArchivePrintPlates(curWs, [plate1.id, plate2.id], {
      actor: ADMIN_ACTOR,
      nowMs: NOW_MS + 145 * 60_000,
    });
    expect(bulkArch.error).toBeUndefined();
    const afterArchAlpha = bulkArch.nextWorkspace!.projects.find(
      (p) => p.id === 'proj-alpha'
    )!;
    const afterArchState = computeColorPlanningState(
      bulkArch.nextWorkspace!.jobs,
      afterArchAlpha,
      'color-0'
    );
    expect(afterArchState.completedTotal).toBe(138);
    expect(afterArchState.remainingDemandTotal).toBe(162);
    expect(afterArchState.carryForwardTotal).toBe(0);

    const bulkRest = bulkRestorePrintPlates(
      bulkArch.nextWorkspace!,
      [plate1.id, plate2.id],
      {
        actor: ADMIN_ACTOR,
        nowMs: NOW_MS + 146 * 60_000,
      }
    );
    expect(bulkRest.error).toBeUndefined();
    expect(
      computeProjectDemandSummary(
        bulkRest.nextWorkspace!,
        bulkRest.nextWorkspace!.projects.find((p) => p.id === 'proj-alpha')!
      ).unmetKeycaps
    ).toBe(162);

    // Also test bulkDeletePrintPlates on proj-beta's Planned plate
    const bulkDel = bulkDeletePrintPlates(bulkRest.nextWorkspace!, ['job-beta-1'], {
      actor: ADMIN_ACTOR,
      nowMs: NOW_MS + 150 * 60_000,
    });
    expect(bulkDel.error).toBeUndefined();
    const betaAfterBulkDel = bulkDel.nextWorkspace!.projects.find(
      (p) => p.id === 'proj-beta'
    )!;
    const betaState = computeColorPlanningState(
      bulkDel.nextWorkspace!.jobs,
      betaAfterBulkDel,
      'color-0'
    );
    expect(betaState.carryForwardTotal).toBe(0);
    expect(betaState.remainingDemandTotal).toBe(0);
    expect(
      computeProjectPlateProgress(bulkDel.nextWorkspace!.jobs, 'proj-beta').plannedKeycaps
    ).toBe(0);
  });

  it('5. handles legacy pre-session Firestore workspaces and validates zero-undefined Firestore persistence round-trips', () => {
    const ws = createMultiProjectTestWorkspace();

    // Simulate a legacy workspace document from Firestore without `planningSessions` or `planningSessionId`
    const legacyProject: ProductionProject = {
      ...ws.projects[0],
      targetQuantity: 190,
      targetsByColor: {
        'color-0': { ...emptyAlphabetMap(), L: 190 },
      },
      carryForwardByColor: {
        'color-0': { ...emptyAlphabetMap(), L: 52 },
      },
    };
    delete legacyProject.planningSessions;

    const legacyWs: ProductionWorkspaceV5 = {
      ...ws,
      projects: [legacyProject, ws.projects[1]],
      jobs: [
        {
          id: 'legacy-job-1',
          projectId: 'proj-alpha',
          colorId: 'color-0',
          plateNumber: 1,
          plateCapacity: 138,
          letters: { L: 138 },
          stage: 'Ready to Print',
          machineId: null,
          estimatedMinutes: 195,
          actualMinutes: 0,
          slicerVerified: true,
          stockApplied: false,
          stockTransactionId: null,
          failedCount: 0,
          failureReason: '',
          notes: 'Legacy plate without planningSessionId',
          createdIso: new Date(NOW_MS).toISOString(),
          updatedIso: new Date(NOW_MS).toISOString(),
          completedIso: null,
        },
        ...ws.jobs,
      ],
    };

    // While legacy-job-1 is active, legacy carry-forward (52) is valid
    const stateBefore = computeColorPlanningState(
      legacyWs.jobs,
      legacyProject,
      'color-0'
    );
    expect(stateBefore.carryForwardTotal).toBe(52);
    expect(stateBefore.remainingDemandTotal).toBe(52);

    // Deleting legacy-job-1 clears orphaned legacy carry-forward and historical deleted target while non-destructively preserving legacy Firestore fields like `targetQuantity`
    const delLegacy = deletePrintPlate(legacyWs, 'legacy-job-1', {
      actor: ADMIN_ACTOR,
      nowMs: NOW_MS + 2_000,
    });
    expect(delLegacy.error).toBeUndefined();
    const afterLegacyWs = delLegacy.nextWorkspace!;
    const alphaAfter = afterLegacyWs.projects.find((p) => p.id === 'proj-alpha')!;
    const stateAfter = computeColorPlanningState(
      afterLegacyWs.jobs,
      alphaAfter,
      'color-0'
    );
    expect(stateAfter.carryForwardTotal).toBe(0);
    expect(stateAfter.remainingDemandTotal).toBe(0);
    // Legacy Firestore record's `targetQuantity` is preserved non-destructively in storage, while progress uses valid plate records (0 pcs)
    expect(alphaAfter.targetQuantity).toBe(190);
    expect(
      computeProjectPlateProgress(afterLegacyWs.jobs, 'proj-alpha').plannedKeycaps
    ).toBe(0);

    // Also test explicit Dismiss Carry-Forward on proj-beta while keeping job-beta-1 untouched
    const clearedBeta = clearProjectColorCarryForward(afterLegacyWs, {
      projectId: 'proj-beta',
      colorId: 'color-0',
      mode: 'mixed',
      trimTargetRemainder: true,
      nowMs: NOW_MS + 3_000,
    });
    expect(clearedBeta.error).toBeUndefined();
    expect(clearedBeta.clearedCount).toBe(82); // 62 B + 20 CHARM_STAR

    const finalWs = clearedBeta.nextWorkspace!;
    const betaFinal = finalWs.projects.find((p) => p.id === 'proj-beta')!;
    expect('targetQuantity' in betaFinal).toBe(false);
    const betaState = computeColorPlanningState(finalWs.jobs, betaFinal, 'color-0');
    expect(betaState.carryForwardTotal).toBe(0);
    expect(betaState.activePlatesTotal).toBe(138);
    expect(betaState.userTargetTotal).toBe(138);
    expect(betaState.remainingDemandTotal).toBe(0);

    // Validate Firestore payload serialization & normalization round-trip (both with legacy `targetQuantity` and without `targetQuantity`)
    const validated = prepareWorkspaceForFirestore(finalWs, 'owner-uid-1', {
      documentLabel: 'users/owner-uid-1/tracker/v5_workspace',
    });
    const payload = buildFirestoreSetDocPayload(
      {
        ...validated,
        serverUpdatedAt: serverTimestamp(),
      },
      'users/owner-uid-1/tracker/v5_workspace',
      { isDev: false }
    );
    expect(findUndefinedPaths(payload)).toEqual([]);

    const reloaded = normalizeWorkspaceV5(validated, 'owner-uid-1');
    const reloadedAlpha = reloaded.projects.find((p) => p.id === 'proj-alpha')!;
    const reloadedBeta = reloaded.projects.find((p) => p.id === 'proj-beta')!;
    expect(reloadedAlpha.targetQuantity).toBe(190);
    expect('targetQuantity' in reloadedBeta).toBe(false);
    expect(
      computeColorPlanningState(reloaded.jobs, reloadedAlpha, 'color-0')
        .carryForwardTotal
    ).toBe(0);
    expect(
      compactCharmsMap(reloadedAlpha.charmCarryForwardByColor?.['color-0'])
    ).toEqual({});
  });
});
