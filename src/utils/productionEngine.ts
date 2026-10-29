import {
  ABC,
  CHARM_BY_ID,
  CHARM_IDS,
  compactCharmsMap,
  compactLettersMap,
  countCharms,
  countLetters,
  emptyAlphabetMap,
  emptyCharmsMap,
  normalizeAlphabetMap,
  normalizeCharmsMap,
  sumAlphabetMaps,
  sumCharmsMaps,
} from '../constants';
import {
  ActivityLogEntry,
  CharmId,
  CharmsMap,
  InventoryMovement,
  InventoryState,
  KanbanStage,
  LettersMap,
  PlateGenerationMode,
  PrinterMachine,
  ProductionJob,
  ProductionWorkspaceV5,
} from '../types';
import { DEFAULT_TIMEZONE, formatDateTimeDDMMYYYY } from './dateFormat';
import { getEffectivePrintMinutes, getLiveRemainingSeconds } from './schedulingEngine';

/**
 * Constructs a Firestore-compatible ActivityLogEntry.
 * Strictly omits optional `projectId` when absent instead of assigning `projectId: undefined`.
 */
export function createActivityLogEntry(params: {
  category: ActivityLogEntry['category'];
  msg: string;
  projectId?: string | null;
  nowMs?: number;
  timezone?: string;
}): ActivityLogEntry {
  const nowMs = params.nowMs ?? Date.now();
  const tz = params.timezone || DEFAULT_TIMEZONE;
  const entry: ActivityLogEntry = {
    id: `log-${nowMs}-${Math.random().toString(36).slice(2, 6)}`,
    at: formatDateTimeDDMMYYYY(nowMs, tz),
    timestampIso: new Date(nowMs).toISOString(),
    category: params.category,
    msg: params.msg,
  };

  if (typeof params.projectId === 'string' && params.projectId.trim().length > 0) {
    entry.projectId = params.projectId;
  }

  return entry;
}

export interface DraftPlatePreview {
  tempId: string;
  plateNumber: number;
  capacity: number;
  letters: LettersMap;
  charms: CharmsMap;
  plateMode: PlateGenerationMode;
  estimatedMinutes: number;
  slicerVerified: boolean;
  notes: string;
}

export interface PlateDistributionResult {
  mode: PlateGenerationMode;
  lockedTotals: LettersMap;
  lockedCharms: Record<CharmId, number>;
  netRequired: LettersMap;
  netRequiredCharms: Record<CharmId, number>;
  netAlphabetCount: number;
  netCharmCount: number;
  totalNetCount: number;
  fullPlates: DraftPlatePreview[];
  remainder: LettersMap;
  remainderCharms: CharmsMap;
  remainderCount: number;
  neededForNextFullPlate: number;
  underLockedLetters: string[];
  underLockedCharms: CharmId[];
  underLockedLabels: string[];
}

export function inferPlateMode(
  letters?: LettersMap | null,
  charms?: CharmsMap | null
): PlateGenerationMode {
  const lCount = countLetters(letters);
  const cCount = countCharms(charms);
  if (lCount > 0 && cCount > 0) return 'mixed';
  if (cCount > 0) return 'charm_only';
  return 'alphabet_only';
}

/**
 * Determines which existing plates for `(projectId, colorId)` must be preserved
 * untouched when committing newly generated plates:
 * - Always preserves `Completed`, `Printing`, and `Failed / Reprint` plate history.
 * - In `alphabet_only` mode, also preserves queued pure-charm plates.
 * - In `charm_only` mode, also preserves queued pure-alphabet plates.
 */
export function shouldPreserveExistingJobOnRegenerate(
  job: ProductionJob,
  mode: PlateGenerationMode
): boolean {
  if (
    job.stage === 'Completed' ||
    job.stage === 'Printing' ||
    job.stage === 'Failed / Reprint'
  ) {
    return true;
  }
  if (mode === 'alphabet_only') {
    return countLetters(job.letters) === 0 && countCharms(job.charms) > 0;
  }
  if (mode === 'charm_only') {
    return countCharms(job.charms) === 0 && countLetters(job.letters) > 0;
  }
  return false;
}

export function computeIntelligentPlates(
  jobs: ProductionJob[],
  projectId: string,
  colorId: string,
  requestedTarget: LettersMap,
  capacity: number,
  defaultMinutesPerPlate: number = 195,
  options?: {
    requestedCharms?: CharmsMap;
    mode?: PlateGenerationMode;
  }
): PlateDistributionResult {
  const mode: PlateGenerationMode = options?.mode || 'mixed';
  const safeCap = Math.max(1, Math.floor(capacity || 138));
  const safeMins = Math.max(1, Math.round(defaultMinutesPerPlate || 195));
  const projectColorJobs = jobs.filter(
    (j) => j.projectId === projectId && j.colorId === colorId
  );

  // Completed and Printing plates are strictly locked and count toward fulfilled targets
  const lockedJobs = projectColorJobs.filter(
    (j) => j.stage === 'Completed' || j.stage === 'Printing'
  );

  const lockedTotals = sumAlphabetMaps(lockedJobs.map((j) => j.letters));
  const lockedCharms = sumCharmsMaps(lockedJobs.map((j) => j.charms));

  const normalizedTarget = normalizeAlphabetMap(requestedTarget);
  const normalizedCharms = normalizeCharmsMap(options?.requestedCharms);

  const underLockedLetters =
    mode === 'charm_only'
      ? []
      : ABC.filter((letter) => (normalizedTarget[letter] || 0) < (lockedTotals[letter] || 0));

  const underLockedCharms =
    mode === 'alphabet_only'
      ? []
      : CHARM_IDS.filter(
          (charmId) => (normalizedCharms[charmId] || 0) < (lockedCharms[charmId] || 0)
        );

  const underLockedLabels = [
    ...underLockedLetters,
    ...underLockedCharms.map((cid) => `${CHARM_BY_ID[cid].symbol} ${CHARM_BY_ID[cid].label}`),
  ];

  const netRequired = emptyAlphabetMap();
  if (mode !== 'charm_only') {
    for (const letter of ABC) {
      netRequired[letter] = Math.max(
        0,
        (normalizedTarget[letter] || 0) - (lockedTotals[letter] || 0)
      );
    }
  }

  const netRequiredCharms = emptyCharmsMap();
  if (mode !== 'alphabet_only') {
    for (const charmId of CHARM_IDS) {
      netRequiredCharms[charmId] = Math.max(
        0,
        (normalizedCharms[charmId] || 0) - (lockedCharms[charmId] || 0)
      );
    }
  }

  const netAlphabetCount = countLetters(netRequired);
  const netCharmCount = countCharms(netRequiredCharms);
  const totalNetCount = netAlphabetCount + netCharmCount;

  const fullPlateCount = Math.floor(totalNetCount / safeCap);
  const remainderCount = totalNetCount % safeCap;
  const neededForNextFullPlate = remainderCount === 0 ? 0 : safeCap - remainderCount;

  const letterPool: LettersMap = { ...netRequired };
  const charmPool: Record<CharmId, number> = { ...netRequiredCharms };

  // Avoid colliding with plate numbers of preserved Completed, Printing, Failed/Reprint, or cross-category plates
  const preservedJobs = projectColorJobs.filter((j) =>
    shouldPreserveExistingJobOnRegenerate(j, mode)
  );
  const usedNumbers = new Set(preservedJobs.map((j) => j.plateNumber));
  let nextPlateNum = 1;
  const getNextPlateNumber = () => {
    while (usedNumbers.has(nextPlateNum)) {
      nextPlateNum += 1;
    }
    const chosen = nextPlateNum;
    usedNumbers.add(chosen);
    nextPlateNum += 1;
    return chosen;
  };

  type PoolCandidate =
    | { kind: 'letter'; key: string; orderIdx: number; remaining: number }
    | { kind: 'charm'; key: CharmId; orderIdx: number; remaining: number };

  const getActiveCandidates = (): PoolCandidate[] => {
    const list: PoolCandidate[] = [];
    ABC.forEach((letter, idx) => {
      if ((letterPool[letter] || 0) > 0) {
        list.push({
          kind: 'letter',
          key: letter,
          orderIdx: idx,
          remaining: letterPool[letter],
        });
      }
    });
    CHARM_IDS.forEach((charmId, idx) => {
      if ((charmPool[charmId] || 0) > 0) {
        list.push({
          kind: 'charm',
          key: charmId,
          orderIdx: 100 + idx,
          remaining: charmPool[charmId],
        });
      }
    });
    return list.sort(
      (a, b) => b.remaining - a.remaining || a.orderIdx - b.orderIdx
    );
  };

  const fullPlates: DraftPlatePreview[] = [];

  for (let p = 0; p < fullPlateCount; p++) {
    let room = safeCap;
    const plateLetters: LettersMap = {};
    const plateCharms: CharmsMap = {};
    const candidates = getActiveCandidates();

    for (const item of candidates) {
      if (room <= 0) break;
      const available =
        item.kind === 'letter'
          ? letterPool[item.key] || 0
          : charmPool[item.key] || 0;
      const take = Math.min(available, room);
      if (take > 0) {
        if (item.kind === 'letter') {
          plateLetters[item.key] = take;
          letterPool[item.key] -= take;
        } else {
          plateCharms[item.key] = take;
          charmPool[item.key] -= take;
        }
        room -= take;
      }
    }

    const compactedL = compactLettersMap(plateLetters);
    const compactedC = compactCharmsMap(plateCharms);

    fullPlates.push({
      tempId: `draft-${Date.now()}-${p}`,
      plateNumber: getNextPlateNumber(),
      capacity: safeCap,
      letters: compactedL,
      charms: compactedC,
      plateMode: inferPlateMode(compactedL, compactedC),
      estimatedMinutes: safeMins,
      slicerVerified: false,
      notes: '',
    });
  }

  const remainder = compactLettersMap(letterPool);
  const remainderCharms = compactCharmsMap(charmPool);

  return {
    mode,
    lockedTotals,
    lockedCharms,
    netRequired,
    netRequiredCharms,
    netAlphabetCount,
    netCharmCount,
    totalNetCount,
    fullPlates,
    remainder,
    remainderCharms,
    remainderCount,
    neededForNextFullPlate,
    underLockedLetters,
    underLockedCharms,
    underLockedLabels,
  };
}

/**
 * Transitions a ProductionJob to a new stage with:
 * 1. Machine overlap prevention (cannot set two jobs to Printing on the same machine, or print on Maintenance/Offline machine).
 * 2. Start/Finish timestamp tracking + actual print duration calculation on completion.
 * 3. Idempotent Inventory Ledger (`stockApplied` boolean + reversal movement if moving out of Completed).
 */
export function transitionJobState(
  workspace: ProductionWorkspaceV5,
  jobId: string,
  nextStage: KanbanStage,
  options?: {
    machineId?: string | null;
    actualMinutes?: number;
    failureReason?: string;
    nowMs?: number;
  }
): { nextWorkspace?: ProductionWorkspaceV5; error?: string } {
  const targetJob = workspace.jobs.find((j) => j.id === jobId);
  if (!targetJob) {
    return { error: 'Print job not found.' };
  }

  const nowMs = options?.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const timezone = workspace.settings?.timezone || DEFAULT_TIMEZONE;

  const nextMachineId =
    options?.machineId !== undefined ? options.machineId : targetJob.machineId;

  const selectedMachine =
    workspace.machines.find((m) => m.id === nextMachineId) || null;

  // Validate Machine Assignment & Overlap Rules when entering Printing
  if (nextStage === 'Printing') {
    if (!nextMachineId || !selectedMachine) {
      return {
        error: 'Assign an available printer before starting a print job.',
      };
    }
    if (selectedMachine.status === 'Maintenance' || selectedMachine.status === 'Offline') {
      return {
        error: `${selectedMachine.name} is currently marked ${selectedMachine.status} and cannot accept active prints.`,
      };
    }
    const conflictingJob = workspace.jobs.find(
      (j) => j.id !== jobId && j.machineId === nextMachineId && j.stage === 'Printing'
    );
    if (conflictingJob) {
      return {
        error: `Machine overlap prevented: ${selectedMachine.name} is already printing Plate ${conflictingJob.plateNumber}. Complete or reassign that job first.`,
      };
    }
  }

  // Clone inventory maps for idempotent updates
  const nextPhysical: Record<string, LettersMap> = {};
  for (const [cid, map] of Object.entries(workspace.inventory.physicalByColor)) {
    nextPhysical[cid] = { ...normalizeAlphabetMap(map) };
  }
  if (!nextPhysical[targetJob.colorId]) {
    nextPhysical[targetJob.colorId] = emptyAlphabetMap();
  }

  const nextWastage: Record<string, LettersMap> = {};
  for (const [cid, map] of Object.entries(workspace.inventory.wastageByColor)) {
    nextWastage[cid] = { ...normalizeAlphabetMap(map) };
  }
  if (!nextWastage[targetJob.colorId]) {
    nextWastage[targetJob.colorId] = emptyAlphabetMap();
  }

  const nextMovements: InventoryMovement[] = [...workspace.inventory.movements];

  let nextStockApplied = targetJob.stockApplied;
  let nextTxId = targetJob.stockTransactionId;
  let completedIso = targetJob.completedIso;

  const hasAlphabetLetters = countLetters(targetJob.letters) > 0;

  // Case A: Entering Completed AND stock has NOT been credited yet -> Credit A–Z letters once (Charm-only plates leave Inventory untouched)
  if (nextStage === 'Completed' && !targetJob.stockApplied) {
    if (hasAlphabetLetters) {
      const txId = `tx-comp-${jobId}-${nowMs}`;
      for (const [letter, qty] of Object.entries(targetJob.letters)) {
        nextPhysical[targetJob.colorId][letter] =
          (nextPhysical[targetJob.colorId][letter] || 0) + Number(qty || 0);
      }
      nextMovements.unshift({
        id: txId,
        type: 'PRINT_COMPLETE',
        jobId: targetJob.id,
        projectId: targetJob.projectId,
        colorId: targetJob.colorId,
        deltas: { ...targetJob.letters },
        reason: `Completed Plate ${targetJob.plateNumber}`,
        timestampIso: nowIso,
      });
      nextStockApplied = true;
      nextTxId = txId;
    }
    completedIso = nowIso;
  }

  // Case B: Leaving Completed -> Safely reverse credited A–Z stock if any was applied
  if (targetJob.stage === 'Completed' && nextStage !== 'Completed') {
    if (targetJob.stockApplied && hasAlphabetLetters) {
      const reservedForColor = getReservedStockForColor(workspace, targetJob.colorId);
      for (const [letter, qty] of Object.entries(targetJob.letters)) {
        const currentPhys = nextPhysical[targetJob.colorId][letter] || 0;
        const afterRev = currentPhys - Number(qty || 0);
        if (afterRev < 0) {
          return {
            error: `Cannot reverse Completed status: Letter ${letter} physical stock (${currentPhys}) is already consumed below plate quantity (${qty}). Adjust stock first.`,
          };
        }
        if (afterRev < (reservedForColor[letter] || 0)) {
          return {
            error: `Cannot reverse Completed status: ${reservedForColor[letter]} pcs of letter ${letter} are currently reserved by projects. Release allocation first.`,
          };
        }
      }

      const revDeltas: LettersMap = {};
      for (const [letter, qty] of Object.entries(targetJob.letters)) {
        const amount = Number(qty || 0);
        nextPhysical[targetJob.colorId][letter] = Math.max(
          0,
          (nextPhysical[targetJob.colorId][letter] || 0) - amount
        );
        revDeltas[letter] = -amount;
      }

      nextMovements.unshift({
        id: `tx-rev-${jobId}-${nowMs}`,
        type: 'PRINT_REVERSAL',
        jobId: targetJob.id,
        projectId: targetJob.projectId,
        colorId: targetJob.colorId,
        deltas: revDeltas,
        reason: `Reversed Plate ${targetJob.plateNumber} (${targetJob.stage} -> ${nextStage})`,
        timestampIso: nowIso,
      });
    }
    nextStockApplied = false;
    nextTxId = null;
    completedIso = null;
  }

  // Smart Timing & Server Timestamp Reconciliation State
  let startedAtMs = targetJob.startedAtMs ?? null;
  let runResumedAtMs = targetJob.runResumedAtMs ?? null;
  let isPaused = Boolean(targetJob.isPaused);
  let pausedAtMs = targetJob.pausedAtMs ?? null;
  let remainingSecondsAtPause = targetJob.remainingSecondsAtPause ?? null;
  let accumulatedElapsedSeconds = targetJob.accumulatedElapsedSeconds || 0;
  let estimatedFinishAtMs = targetJob.estimatedFinishAtMs ?? null;
  let actualCompletedAtMs = targetJob.actualCompletedAtMs ?? null;
  let pendingServerStartSync = false;
  let pendingServerCompleteSync = false;

  const effPrintMins = getEffectivePrintMinutes(targetJob, selectedMachine);

  if (nextStage === 'Printing' && targetJob.stage !== 'Printing') {
    // Fresh start of printing
    startedAtMs = nowMs;
    runResumedAtMs = nowMs;
    isPaused = false;
    pausedAtMs = null;
    remainingSecondsAtPause = null;
    accumulatedElapsedSeconds = 0;
    estimatedFinishAtMs = nowMs + effPrintMins * 60_000;
    actualCompletedAtMs = null;
    pendingServerStartSync = true;
  } else if (nextStage === 'Printing' && targetJob.stage === 'Printing') {
    // Reassigning machine while already printing: recalculate finish time from remaining seconds
    const currentRemSecs = getLiveRemainingSeconds(targetJob, nowMs, selectedMachine);
    if (!isPaused) {
      estimatedFinishAtMs = nowMs + currentRemSecs * 1000;
    }
  } else if (nextStage === 'Completed') {
    actualCompletedAtMs = nowMs;
    pendingServerCompleteSync = targetJob.stage !== 'Completed';
    if (!isPaused && runResumedAtMs) {
      accumulatedElapsedSeconds += Math.max(0, Math.floor((nowMs - runResumedAtMs) / 1000));
    }
    isPaused = false;
    pausedAtMs = null;
    remainingSecondsAtPause = 0;
    estimatedFinishAtMs = null;
  } else {
    // Planned, Ready to Print, or Failed / Reprint -> reset active timer
    isPaused = false;
    pausedAtMs = null;
    remainingSecondsAtPause = null;
    estimatedFinishAtMs = null;
    if (nextStage === 'Planned' || nextStage === 'Ready to Print') {
      startedAtMs = null;
      runResumedAtMs = null;
      accumulatedElapsedSeconds = 0;
      actualCompletedAtMs = null;
    }
  }

  // Calculate actual print duration (minutes) on completion
  let actualMins = targetJob.actualMinutes;
  if (options?.actualMinutes !== undefined) {
    actualMins = Math.max(0, Math.round(options.actualMinutes));
  } else if (nextStage === 'Completed') {
    if (accumulatedElapsedSeconds > 0) {
      actualMins = Math.max(1, Math.round(accumulatedElapsedSeconds / 60));
    } else if (startedAtMs && actualCompletedAtMs && actualCompletedAtMs > startedAtMs) {
      actualMins = Math.max(1, Math.round((actualCompletedAtMs - startedAtMs) / 60_000));
    } else if (targetJob.actualMinutes === 0) {
      actualMins = effPrintMins;
    }
  }

  const isEnteringFailed =
    nextStage === 'Failed / Reprint' && targetJob.stage !== 'Failed / Reprint';

  const updatedJob: ProductionJob = {
    ...targetJob,
    stage: nextStage,
    machineId: nextMachineId,
    actualMinutes: actualMins,
    stockApplied: nextStockApplied,
    stockTransactionId: nextTxId,
    completedIso,
    failedCount: isEnteringFailed ? targetJob.failedCount + 1 : targetJob.failedCount,
    failureReason:
      options?.failureReason !== undefined
        ? options.failureReason
        : isEnteringFailed && !targetJob.failureReason
        ? 'Print interrupted / adhesion issue'
        : targetJob.failureReason,
    startedAtMs,
    runResumedAtMs,
    isPaused,
    pausedAtMs,
    remainingSecondsAtPause,
    accumulatedElapsedSeconds,
    estimatedFinishAtMs,
    actualCompletedAtMs,
    pendingServerStartSync,
    pendingServerCompleteSync,
    updatedIso: nowIso,
  };

  const nextJobs = workspace.jobs.map((j) => (j.id === jobId ? updatedJob : j));

  // Synchronize machine statuses & lifetime counters
  const nextMachines: PrinterMachine[] = workspace.machines.map((m) => {
    const activePrintingJob = nextJobs.find(
      (j) => j.machineId === m.id && j.stage === 'Printing'
    );

    let completedPlates = m.totalCompletedPlates;
    let failedPlates = m.totalFailedPlates;
    let printMinutes = m.totalPrintMinutes;

    if (m.id === nextMachineId) {
      if (nextStage === 'Completed' && targetJob.stage !== 'Completed') {
        completedPlates += 1;
        printMinutes += actualMins || effPrintMins;
      } else if (targetJob.stage === 'Completed' && nextStage !== 'Completed') {
        completedPlates = Math.max(0, completedPlates - 1);
        printMinutes = Math.max(
          0,
          printMinutes - (targetJob.actualMinutes || effPrintMins)
        );
      }
      if (isEnteringFailed) {
        failedPlates += 1;
      }
    }

    let status = m.status;
    if (status !== 'Maintenance' && status !== 'Offline') {
      if (activePrintingJob) {
        status = 'Printing';
      } else if (m.id === nextMachineId && nextStage === 'Completed') {
        status = 'Completed';
      } else {
        status = 'Idle';
      }
    }

    return {
      ...m,
      status,
      activeJobId: activePrintingJob ? activePrintingJob.id : null,
      totalCompletedPlates: completedPlates,
      totalFailedPlates: failedPlates,
      totalPrintMinutes: printMinutes,
    };
  });

  const projectName =
    workspace.projects.find((p) => p.id === targetJob.projectId)?.name || 'Project';
  const colorName =
    workspace.colors.find((c) => c.id === targetJob.colorId)?.name || 'Color';

  const logMsg = `${projectName} · ${colorName} · Plate ${targetJob.plateNumber}: ${targetJob.stage} → ${nextStage}`;

  const nextInventory: InventoryState = {
    physicalByColor: nextPhysical,
    wastageByColor: nextWastage,
    movements: nextMovements.slice(0, 300),
  };

  return {
    nextWorkspace: {
      ...workspace,
      jobs: nextJobs,
      machines: nextMachines,
      inventory: nextInventory,
      log: [
        createActivityLogEntry({
          category: 'plate',
          msg: logMsg,
          projectId: targetJob.projectId,
          nowMs,
          timezone,
        }),
        ...workspace.log,
      ].slice(0, 200),
      updatedIso: nowIso,
    },
  };
}

/**
 * Pauses, updates remaining time while paused, or resumes an actively Printing plate.
 * Guarantees countdown NEVER decreases while `isPaused` is true.
 */
export function pauseOrResumePrintingJob(
  workspace: ProductionWorkspaceV5,
  jobId: string,
  action: 'pause' | 'resume' | 'update_remaining',
  overrideRemainingMinutes?: number,
  nowMs: number = Date.now()
): { nextWorkspace?: ProductionWorkspaceV5; error?: string } {
  const job = workspace.jobs.find((j) => j.id === jobId);
  if (!job || job.stage !== 'Printing') {
    return { error: 'Only actively Printing plates can be paused or resumed.' };
  }

  const machine = workspace.machines.find((m) => m.id === job.machineId) || null;
  const timezone = workspace.settings?.timezone || DEFAULT_TIMEZONE;
  const nowIso = new Date(nowMs).toISOString();

  let updatedJob: ProductionJob = { ...job, updatedIso: nowIso };
  let actionLabel = '';

  if (action === 'pause') {
    const currentRemSecs =
      overrideRemainingMinutes !== undefined
        ? Math.max(0, Math.round(overrideRemainingMinutes * 60))
        : getLiveRemainingSeconds(job, nowMs, machine);

    const anchorMs = job.runResumedAtMs || job.startedAtMs || nowMs;
    const addElapsed = job.isPaused ? 0 : Math.max(0, Math.floor((nowMs - anchorMs) / 1000));

    updatedJob = {
      ...updatedJob,
      isPaused: true,
      pausedAtMs: nowMs,
      remainingSecondsAtPause: currentRemSecs,
      accumulatedElapsedSeconds: (job.accumulatedElapsedSeconds || 0) + addElapsed,
      estimatedFinishAtMs: null,
    };
    actionLabel = `Paused Plate ${job.plateNumber} (${Math.ceil(currentRemSecs / 60)}m remaining)`;
  } else if (action === 'update_remaining') {
    const nextRemSecs = Math.max(0, Math.round((overrideRemainingMinutes ?? 0) * 60));
    if (job.isPaused) {
      updatedJob = {
        ...updatedJob,
        remainingSecondsAtPause: nextRemSecs,
        estimatedFinishAtMs: null,
      };
    } else {
      updatedJob = {
        ...updatedJob,
        runResumedAtMs: nowMs,
        estimatedFinishAtMs: nowMs + nextRemSecs * 1000,
      };
    }
    actionLabel = `Updated Plate ${job.plateNumber} remaining time to ${Math.round(
      nextRemSecs / 60
    )}m`;
  } else if (action === 'resume') {
    const frozenSecs =
      overrideRemainingMinutes !== undefined
        ? Math.max(0, Math.round(overrideRemainingMinutes * 60))
        : typeof job.remainingSecondsAtPause === 'number'
        ? job.remainingSecondsAtPause
        : getLiveRemainingSeconds(job, nowMs, machine);

    updatedJob = {
      ...updatedJob,
      isPaused: false,
      pausedAtMs: null,
      runResumedAtMs: nowMs,
      remainingSecondsAtPause: null,
      estimatedFinishAtMs: nowMs + frozenSecs * 1000,
    };
    actionLabel = `Resumed Plate ${job.plateNumber} (ETA +${Math.ceil(frozenSecs / 60)}m)`;
  }

  return {
    nextWorkspace: {
      ...workspace,
      jobs: workspace.jobs.map((j) => (j.id === jobId ? updatedJob : j)),
      log: [
        createActivityLogEntry({
          category: 'plate',
          msg: actionLabel,
          projectId: job.projectId,
          nowMs,
          timezone,
        }),
        ...workspace.log,
      ].slice(0, 200),
      updatedIso: nowIso,
    },
  };
}

/**
 * Pure, Firestore-safe machine update handler supporting status changes
 * (`Idle`, `Printing`, `Completed`, `Maintenance`, `Offline`), speed factors,
 * setup buffers, and maintenance downtime windows without ever introducing `undefined`.
 */
export function applyMachineUpdate(
  workspace: ProductionWorkspaceV5,
  machineId: string,
  updates: Partial<
    Pick<
      PrinterMachine,
      | 'name'
      | 'model'
      | 'status'
      | 'plateCapacity'
      | 'notes'
      | 'speedFactor'
      | 'setupBufferMinutes'
      | 'maintenanceUntilMs'
    >
  >,
  nowMs: number = Date.now()
): { nextWorkspace?: ProductionWorkspaceV5; error?: string } {
  const machine = workspace.machines.find((m) => m.id === machineId);
  if (!machine) {
    return { error: 'Printer machine not found.' };
  }

  const activePrintingJob = workspace.jobs.find(
    (j) => j.machineId === machineId && j.stage === 'Printing'
  );

  if (
    updates.status !== undefined &&
    updates.status !== 'Printing' &&
    activePrintingJob
  ) {
    return {
      error: `Complete, cancel, or reassign active Plate ${activePrintingJob.plateNumber} on ${machine.name} before switching status to ${updates.status}.`,
    };
  }

  const nextStatus = updates.status !== undefined ? updates.status : machine.status;

  let nextMaintenanceUntilMs: number | null;
  if (updates.maintenanceUntilMs !== undefined) {
    nextMaintenanceUntilMs =
      updates.maintenanceUntilMs === null
        ? null
        : Math.round(updates.maintenanceUntilMs);
  } else if (updates.status !== undefined && updates.status !== 'Maintenance') {
    nextMaintenanceUntilMs = null;
  } else {
    nextMaintenanceUntilMs = machine.maintenanceUntilMs ?? null;
  }

  const nextMachine: PrinterMachine = {
    ...machine,
    name: updates.name !== undefined ? updates.name : machine.name,
    model: updates.model !== undefined ? updates.model : machine.model,
    status: nextStatus,
    plateCapacity:
      updates.plateCapacity !== undefined
        ? Math.max(1, Math.round(updates.plateCapacity))
        : machine.plateCapacity,
    activeJobId: activePrintingJob ? activePrintingJob.id : null,
    notes: updates.notes !== undefined ? updates.notes : machine.notes,
    maintenanceUntilMs: nextMaintenanceUntilMs,
  };

  if (updates.speedFactor !== undefined) {
    nextMachine.speedFactor = updates.speedFactor;
  } else if (machine.speedFactor !== undefined) {
    nextMachine.speedFactor = machine.speedFactor;
  }

  if (updates.setupBufferMinutes !== undefined) {
    nextMachine.setupBufferMinutes = Math.max(0, Math.round(updates.setupBufferMinutes));
  } else if (machine.setupBufferMinutes !== undefined) {
    nextMachine.setupBufferMinutes = machine.setupBufferMinutes;
  }

  const nextMachines = workspace.machines.map((m) =>
    m.id === machineId ? nextMachine : m
  );

  const tz = workspace.settings?.timezone || DEFAULT_TIMEZONE;
  const nextLog =
    updates.status !== undefined && updates.status !== machine.status
      ? [
          createActivityLogEntry({
            category: 'machine',
            msg: `${nextMachine.name} status changed: ${machine.status} → ${updates.status}`,
            nowMs,
            timezone: tz,
          }),
          ...workspace.log,
        ].slice(0, 200)
      : workspace.log;

  return {
    nextWorkspace: {
      ...workspace,
      machines: nextMachines,
      log: nextLog,
      updatedIso: new Date(nowMs).toISOString(),
    },
  };
}

export function getReservedStockForColor(
  workspace: ProductionWorkspaceV5,
  colorId: string
): LettersMap {
  const activeProjects = workspace.projects.filter((p) => p.status !== 'Archived');
  return sumAlphabetMaps(
    activeProjects.map((p) => p.allocatedStockByColor?.[colorId])
  );
}

export function getAvailableStockForColor(
  workspace: ProductionWorkspaceV5,
  colorId: string
): LettersMap {
  const physical = normalizeAlphabetMap(workspace.inventory.physicalByColor[colorId]);
  const reserved = getReservedStockForColor(workspace, colorId);
  const avail = emptyAlphabetMap();
  for (const letter of ABC) {
    avail[letter] = Math.max(0, (physical[letter] || 0) - (reserved[letter] || 0));
  }
  return avail;
}
