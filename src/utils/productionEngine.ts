import {
  ABC,
  CHARM_BY_ID,
  CHARM_IDS,
  compactCharmsMap,
  compactLettersMap,
  countCharms,
  countLetters,
  countPlateKeycaps,
  emptyAlphabetMap,
  emptyCharmsMap,
  normalizeAlphabetMap,
  normalizeCharmsMap,
  PRIMARY_ADMIN_EMAIL,
  sumAlphabetMaps,
  sumCharmsMaps,
} from '../constants';
import {
  ActivityLogEntry,
  AdminActorContext,
  CharmId,
  CharmsMap,
  InventoryMovement,
  InventoryState,
  KanbanStage,
  LettersMap,
  PlanningSessionRecord,
  PlateGenerationMode,
  PrinterMachine,
  ProductionJob,
  ProductionProject,
  ProductionWorkspaceV5,
  QueueLifecycleTab,
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
    Boolean(job.archived) ||
    job.stage === 'Completed' ||
    job.stage === 'Printing' ||
    job.stage === 'Failed / Reprint' ||
    job.stage === 'Cancelled'
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
    preserveQueuedPlates?: boolean;
  }
): PlateDistributionResult {
  const mode: PlateGenerationMode = options?.mode || 'mixed';
  const preserveQueued = Boolean(options?.preserveQueuedPlates);
  const safeCap = Math.max(1, Math.floor(capacity || 138));
  const safeMins = Math.max(1, Math.round(defaultMinutesPerPlate || 195));
  const projectColorJobs = jobs.filter(
    (j) => j.projectId === projectId && j.colorId === colorId
  );

  // Completed and Printing plates are strictly locked and count toward fulfilled targets.
  // When `preserveQueuedPlates` is enabled (e.g., generating replacement plates for unmet demand only),
  // active Planned and Ready to Print plates are also treated as locked allocations.
  const lockedJobs = projectColorJobs.filter((j) => {
    if (j.stage === 'Completed') return true;
    if (!j.archived && j.stage === 'Printing') return true;
    if (
      preserveQueued &&
      !j.archived &&
      (j.stage === 'Planned' || j.stage === 'Ready to Print')
    ) {
      return true;
    }
    return false;
  });

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

  // Avoid colliding with plate numbers of preserved Completed, Printing, Failed/Reprint, cross-category, or preserved queued plates
  const preservedJobs = projectColorJobs.filter(
    (j) =>
      shouldPreserveExistingJobOnRegenerate(j, mode) ||
      (preserveQueued &&
        !j.archived &&
        (j.stage === 'Planned' || j.stage === 'Ready to Print'))
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

  if (targetJob.archived) {
    return {
      error: 'Restore this archived plate before changing its workflow stage.',
    };
  }

  if (nextStage === 'Cancelled') {
    return {
      error:
        'Use "Cancel Printing" to cancel an active print job with confirmation and machine release.',
    };
  }

  if (targetJob.stage === 'Cancelled') {
    return {
      error:
        'Cancelled print records are preserved in audit history. Archive this plate or plan replacement plates in Auto Plate Planner.',
    };
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

  const reconciledProjects = reconcileProjectsForAffectedJobs(
    workspace.projects,
    nextJobs,
    [updatedJob],
    nowIso
  );

  return {
    nextWorkspace: {
      ...workspace,
      projects: reconciledProjects,
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

// ============================================================================
// Print Queue Lifecycle Management (Delete, Cancel Printing, Archive, Restore,
// Bulk Operations, Shared Filtering, Admin Authorization & Unmet Demand)
// ============================================================================

/**
 * Verifies whether an actor is an authorized admin allowed to execute destructive
 * or archival Print Queue Lifecycle mutations on `workspace`.
 */
export function isAuthorizedAdmin(
  actor: AdminActorContext | null | undefined,
  workspace: ProductionWorkspaceV5
): boolean {
  if (!actor || !actor.uid || actor.uid.trim().length === 0) {
    return false;
  }
  if (actor.isAnonymous) {
    return false;
  }
  if (actor.role === 'operator' || actor.role === 'viewer') {
    return false;
  }

  const normalizedEmail = actor.email?.trim().toLowerCase() || '';
  if (normalizedEmail === PRIMARY_ADMIN_EMAIL) {
    return true;
  }

  const configuredAdmins = workspace.settings?.adminEmails;
  if (Array.isArray(configuredAdmins) && configuredAdmins.length > 0) {
    return (
      normalizedEmail.length > 0 &&
      configuredAdmins.some((allowed) => allowed.trim().toLowerCase() === normalizedEmail)
    );
  }

  return actor.uid === workspace.ownerId;
}

function resolveLifecycleActor(
  actorOption: AdminActorContext | null | undefined,
  workspace: ProductionWorkspaceV5
): AdminActorContext | null {
  if (actorOption === undefined) {
    return {
      uid: workspace.ownerId,
      role: 'admin',
    };
  }
  return actorOption;
}

function formatActorLabel(actor: AdminActorContext): string {
  const email = actor.email?.trim();
  if (email && email.length > 0) return email;
  return actor.uid || 'admin';
}

/**
 * Eligibility Rule 1: Delete Plate
 * - Planned: Can delete
 * - Ready to Print: Can delete
 * - Printing: Cannot delete directly
 * - Completed: Cannot delete
 * - Failed / Reprint: Cannot permanently delete; can archive
 * - Cancelled: Cannot permanently delete; can archive
 * - Archived: Cannot delete
 */
export function canDeletePlate(job: ProductionJob): boolean {
  if (job.archived) return false;
  return job.stage === 'Planned' || job.stage === 'Ready to Print';
}

export function getDeleteIneligibilityReason(job: ProductionJob): string | null {
  if (canDeletePlate(job)) return null;
  if (job.archived) {
    return `Plate ${job.plateNumber} is archived and protected from permanent deletion.`;
  }
  switch (job.stage) {
    case 'Printing':
      return `Plate ${job.plateNumber} is actively Printing and cannot be deleted directly. Use "Cancel Printing" first.`;
    case 'Completed':
      return `Plate ${job.plateNumber} is Completed and cannot be deleted so production and inventory history remain intact. Use "Archive Plate" instead.`;
    case 'Failed / Reprint':
      return `Plate ${job.plateNumber} is marked Failed / Reprint and cannot be permanently deleted. Use "Archive Plate" to hide it from the active queue.`;
    case 'Cancelled':
      return `Plate ${job.plateNumber} is Cancelled and preserved for audit history. Use "Archive Plate" to move it to Archived.`;
    default:
      return `Plate ${job.plateNumber} cannot be deleted in stage "${job.stage}".`;
  }
}

/**
 * Eligibility Rule 2: Cancel Printing
 * Only non-archived actively `Printing` jobs can be cancelled.
 */
export function canCancelPrintingJob(job: ProductionJob): boolean {
  return !job.archived && job.stage === 'Printing';
}

/**
 * Eligibility Rule 3: Archive & Restore Plate
 * - Completed, Failed / Reprint, and Cancelled plates can be archived when not already archived.
 * - Archived plates can be restored to their stage.
 */
export function canArchivePlate(job: ProductionJob): boolean {
  if (job.archived) return false;
  return (
    job.stage === 'Completed' ||
    job.stage === 'Failed / Reprint' ||
    job.stage === 'Cancelled'
  );
}

export function getArchiveIneligibilityReason(job: ProductionJob): string | null {
  if (canArchivePlate(job)) return null;
  if (job.archived) {
    return `Plate ${job.plateNumber} is already archived.`;
  }
  return `Plate ${job.plateNumber} (${job.stage}) cannot be archived. Only Completed, Failed / Reprint, and Cancelled plates can be archived.`;
}

export function canRestorePlate(job: ProductionJob): boolean {
  return Boolean(job.archived);
}

/**
 * Permanently deletes a single eligible (`Planned` or `Ready to Print`) print plate.
 * Never modifies or regenerates any other plate or project.
 */
export function deletePrintPlate(
  workspace: ProductionWorkspaceV5,
  jobId: string,
  options?: {
    actor?: AdminActorContext | null;
    nowMs?: number;
  }
): { nextWorkspace?: ProductionWorkspaceV5; error?: string } {
  const actor = resolveLifecycleActor(options?.actor, workspace);
  if (!isAuthorizedAdmin(actor, workspace)) {
    return {
      error:
        'Unauthorized: Admin privileges are required to delete print queue plates.',
    };
  }

  const targetJob = workspace.jobs.find((j) => j.id === jobId);
  if (!targetJob) {
    return { error: 'Print plate not found (it may have already been removed).' };
  }

  const blockReason = getDeleteIneligibilityReason(targetJob);
  if (blockReason) {
    return { error: blockReason };
  }

  const nowMs = options?.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const timezone = workspace.settings?.timezone || DEFAULT_TIMEZONE;

  const projectName =
    workspace.projects.find((p) => p.id === targetJob.projectId)?.name || 'Project';
  const colorName =
    workspace.colors.find((c) => c.id === targetJob.colorId)?.name || 'Color';
  const machineName = targetJob.machineId
    ? workspace.machines.find((m) => m.id === targetJob.machineId)?.name || 'Assigned Printer'
    : 'Unassigned';
  const keycapQty = countPlateKeycaps(targetJob);

  const nextJobs = workspace.jobs.filter((j) => j.id !== jobId);
  const nextMachines = workspace.machines.map((m) =>
    m.activeJobId === jobId ? { ...m, activeJobId: null } : m
  );
  const nextProjects = reconcileProjectsForAffectedJobs(
    workspace.projects,
    nextJobs,
    [targetJob],
    nowIso
  );

  const logMsg = `Deleted Plate ${targetJob.plateNumber} (${targetJob.id}) · ${projectName} · ${colorName} · ${keycapQty} pcs · Machine: ${machineName}`;

  return {
    nextWorkspace: {
      ...workspace,
      projects: nextProjects,
      jobs: nextJobs,
      machines: nextMachines,
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
 * Atomically deletes multiple selected eligible (`Planned` and `Ready to Print`) plates.
 * Rejects the entire operation without mutating any record if any selected plate is ineligible.
 */
export function bulkDeletePrintPlates(
  workspace: ProductionWorkspaceV5,
  jobIds: string[],
  options?: {
    actor?: AdminActorContext | null;
    nowMs?: number;
  }
): { nextWorkspace?: ProductionWorkspaceV5; error?: string; deletedCount?: number } {
  const actor = resolveLifecycleActor(options?.actor, workspace);
  if (!isAuthorizedAdmin(actor, workspace)) {
    return {
      error:
        'Unauthorized: Admin privileges are required to bulk delete print plates.',
    };
  }

  const uniqueIds = Array.from(new Set(jobIds.filter(Boolean)));
  if (uniqueIds.length === 0) {
    return { error: 'Select at least one eligible plate to delete.' };
  }

  const targetJobs: ProductionJob[] = [];
  for (const id of uniqueIds) {
    const found = workspace.jobs.find((j) => j.id === id);
    if (!found) {
      return {
        error: `Plate "${id}" could not be found. Refresh queue selection and try again.`,
      };
    }
    const blockReason = getDeleteIneligibilityReason(found);
    if (blockReason) {
      return { error: blockReason };
    }
    targetJobs.push(found);
  }

  const nowMs = options?.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const timezone = workspace.settings?.timezone || DEFAULT_TIMEZONE;

  const idSet = new Set(uniqueIds);
  const totalKeycaps = targetJobs.reduce((sum, j) => sum + countPlateKeycaps(j), 0);
  const affectedProjects = Array.from(new Set(targetJobs.map((j) => j.projectId)));

  const nextJobs = workspace.jobs.filter((j) => !idSet.has(j.id));
  const nextMachines = workspace.machines.map((m) =>
    m.activeJobId && idSet.has(m.activeJobId) ? { ...m, activeJobId: null } : m
  );
  const nextProjects = reconcileProjectsForAffectedJobs(
    workspace.projects,
    nextJobs,
    targetJobs,
    nowIso
  );

  const singleProjectId = affectedProjects.length === 1 ? affectedProjects[0] : null;
  const plateLabels = targetJobs
    .slice(0, 5)
    .map((j) => `P${j.plateNumber}`)
    .join(', ');
  const moreSuffix =
    targetJobs.length > 5 ? ` +${targetJobs.length - 5} more` : '';

  const logMsg = `Bulk deleted ${targetJobs.length} plate(s) (${plateLabels}${moreSuffix}) totaling ${totalKeycaps} keycaps`;

  return {
    deletedCount: targetJobs.length,
    nextWorkspace: {
      ...workspace,
      projects: nextProjects,
      jobs: nextJobs,
      machines: nextMachines,
      log: [
        createActivityLogEntry({
          category: 'plate',
          msg: logMsg,
          projectId: singleProjectId,
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
 * Cancels an actively `Printing` job:
 * - Changes job stage to `'Cancelled'`
 * - Optionally records operator cancellation reason
 * - Releases the scheduled/active machine assignment (`machineId: null`, machine returns to `'Idle'`)
 * - Stops live countdown & preserves elapsed seconds printed prior to cancellation
 * - Preserves cancellation event in activity audit trail
 */
export function cancelPrintingJob(
  workspace: ProductionWorkspaceV5,
  jobId: string,
  options?: {
    reason?: string;
    actor?: AdminActorContext | null;
    nowMs?: number;
  }
): { nextWorkspace?: ProductionWorkspaceV5; error?: string } {
  const actor = resolveLifecycleActor(options?.actor, workspace);
  if (!isAuthorizedAdmin(actor, workspace)) {
    return {
      error:
        'Unauthorized: Admin privileges are required to cancel an active print job.',
    };
  }

  const targetJob = workspace.jobs.find((j) => j.id === jobId);
  if (!targetJob) {
    return { error: 'Print job not found.' };
  }

  if (!canCancelPrintingJob(targetJob)) {
    return {
      error: `Only actively Printing plates can be cancelled (Plate ${targetJob.plateNumber} is currently "${targetJob.stage}").`,
    };
  }

  const nowMs = options?.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const timezone = workspace.settings?.timezone || DEFAULT_TIMEZONE;
  const actorLabel = formatActorLabel(actor!);
  const trimmedReason = options?.reason?.trim() || '';

  const previousMachineId = targetJob.machineId ?? null;
  const previousMachine = previousMachineId
    ? workspace.machines.find((m) => m.id === previousMachineId) || null
    : null;

  let accumulatedElapsedSeconds = targetJob.accumulatedElapsedSeconds || 0;
  if (!targetJob.isPaused) {
    const anchorMs = targetJob.runResumedAtMs || targetJob.startedAtMs || nowMs;
    accumulatedElapsedSeconds += Math.max(0, Math.floor((nowMs - anchorMs) / 1000));
  }

  const updatedJob: ProductionJob = {
    ...targetJob,
    stage: 'Cancelled',
    machineId: null, // Release scheduled/active machine assignment
    isPaused: false,
    pausedAtMs: null,
    remainingSecondsAtPause: null,
    accumulatedElapsedSeconds,
    estimatedFinishAtMs: null,
    pendingServerStartSync: false,
    pendingServerCompleteSync: false,
    cancelledIso: nowIso,
    cancellationReason: trimmedReason.length > 0 ? trimmedReason : null,
    cancelledBy: actorLabel,
    cancelledFromMachineId: previousMachineId,
    updatedIso: nowIso,
  };

  const nextJobs = workspace.jobs.map((j) => (j.id === jobId ? updatedJob : j));

  // Release printer back to Idle (unless explicitly in Maintenance or Offline)
  const nextMachines: PrinterMachine[] = workspace.machines.map((m) => {
    const remainingActivePrint = nextJobs.find(
      (j) => !j.archived && j.machineId === m.id && j.stage === 'Printing'
    );

    if (m.id === previousMachineId || m.activeJobId === jobId) {
      const nextStatus =
        m.status === 'Maintenance' || m.status === 'Offline'
          ? m.status
          : remainingActivePrint
          ? 'Printing'
          : 'Idle';
      return {
        ...m,
        status: nextStatus,
        activeJobId: remainingActivePrint ? remainingActivePrint.id : null,
      };
    }
    return m;
  });

  const projectName =
    workspace.projects.find((p) => p.id === targetJob.projectId)?.name || 'Project';
  const colorName =
    workspace.colors.find((c) => c.id === targetJob.colorId)?.name || 'Color';
  const machineLabel = previousMachine ? previousMachine.name : 'Unassigned Printer';
  const reasonSuffix = trimmedReason ? ` — Reason: ${trimmedReason}` : '';

  const logMsg = `Cancelled printing Plate ${targetJob.plateNumber} (${projectName} · ${colorName}), released ${machineLabel}${reasonSuffix}`;

  const nextProjects = reconcileProjectsForAffectedJobs(
    workspace.projects,
    nextJobs,
    [updatedJob],
    nowIso
  );

  return {
    nextWorkspace: {
      ...workspace,
      projects: nextProjects,
      jobs: nextJobs,
      machines: nextMachines,
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
 * Archives an eligible historical plate (`Completed`, `Failed / Reprint`, or `Cancelled`).
 * Preserves the original record, completed production quantities, actual print duration,
 * inventory ledger stock, and machine counters.
 */
export function archivePrintPlate(
  workspace: ProductionWorkspaceV5,
  jobId: string,
  options?: {
    actor?: AdminActorContext | null;
    nowMs?: number;
  }
): { nextWorkspace?: ProductionWorkspaceV5; error?: string } {
  const actor = resolveLifecycleActor(options?.actor, workspace);
  if (!isAuthorizedAdmin(actor, workspace)) {
    return {
      error: 'Unauthorized: Admin privileges are required to archive print plates.',
    };
  }

  const targetJob = workspace.jobs.find((j) => j.id === jobId);
  if (!targetJob) {
    return { error: 'Print plate not found.' };
  }

  const blockReason = getArchiveIneligibilityReason(targetJob);
  if (blockReason) {
    return { error: blockReason };
  }

  const nowMs = options?.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const timezone = workspace.settings?.timezone || DEFAULT_TIMEZONE;
  const actorLabel = formatActorLabel(actor!);

  const updatedJob: ProductionJob = {
    ...targetJob,
    archived: true,
    archivedIso: nowIso,
    archivedBy: actorLabel,
    updatedIso: nowIso,
  };

  const projectName =
    workspace.projects.find((p) => p.id === targetJob.projectId)?.name || 'Project';
  const colorName =
    workspace.colors.find((c) => c.id === targetJob.colorId)?.name || 'Color';

  const nextJobs = workspace.jobs.map((j) => (j.id === jobId ? updatedJob : j));
  const nextProjects = reconcileProjectsForAffectedJobs(
    workspace.projects,
    nextJobs,
    [updatedJob],
    nowIso
  );

  return {
    nextWorkspace: {
      ...workspace,
      projects: nextProjects,
      jobs: nextJobs,
      log: [
        createActivityLogEntry({
          category: 'plate',
          msg: `Archived Plate ${targetJob.plateNumber} (${targetJob.stage}) · ${projectName} · ${colorName}`,
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
 * Restores an archived plate back to its workflow/history stage without altering
 * completed quantities or re-crediting inventory stock.
 */
export function restorePrintPlate(
  workspace: ProductionWorkspaceV5,
  jobId: string,
  options?: {
    actor?: AdminActorContext | null;
    nowMs?: number;
  }
): { nextWorkspace?: ProductionWorkspaceV5; error?: string } {
  const actor = resolveLifecycleActor(options?.actor, workspace);
  if (!isAuthorizedAdmin(actor, workspace)) {
    return {
      error: 'Unauthorized: Admin privileges are required to restore archived plates.',
    };
  }

  const targetJob = workspace.jobs.find((j) => j.id === jobId);
  if (!targetJob) {
    return { error: 'Print plate not found.' };
  }

  if (!canRestorePlate(targetJob)) {
    return { error: `Plate ${targetJob.plateNumber} is not currently archived.` };
  }

  const nowMs = options?.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const timezone = workspace.settings?.timezone || DEFAULT_TIMEZONE;

  const updatedJob: ProductionJob = {
    ...targetJob,
    archived: false,
    archivedIso: null,
    archivedBy: null,
    updatedIso: nowIso,
  };

  const projectName =
    workspace.projects.find((p) => p.id === targetJob.projectId)?.name || 'Project';
  const colorName =
    workspace.colors.find((c) => c.id === targetJob.colorId)?.name || 'Color';

  const nextJobs = workspace.jobs.map((j) => (j.id === jobId ? updatedJob : j));
  const nextProjects = reconcileProjectsForAffectedJobs(
    workspace.projects,
    nextJobs,
    [updatedJob],
    nowIso
  );

  return {
    nextWorkspace: {
      ...workspace,
      projects: nextProjects,
      jobs: nextJobs,
      log: [
        createActivityLogEntry({
          category: 'plate',
          msg: `Restored archived Plate ${targetJob.plateNumber} (${targetJob.stage}) · ${projectName} · ${colorName}`,
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
 * Atomically archives multiple eligible historical plates (`Completed`, `Failed / Reprint`, `Cancelled`).
 */
export function bulkArchivePrintPlates(
  workspace: ProductionWorkspaceV5,
  jobIds: string[],
  options?: {
    actor?: AdminActorContext | null;
    nowMs?: number;
  }
): { nextWorkspace?: ProductionWorkspaceV5; error?: string; archivedCount?: number } {
  const actor = resolveLifecycleActor(options?.actor, workspace);
  if (!isAuthorizedAdmin(actor, workspace)) {
    return {
      error: 'Unauthorized: Admin privileges are required to bulk archive plates.',
    };
  }

  const uniqueIds = Array.from(new Set(jobIds.filter(Boolean)));
  if (uniqueIds.length === 0) {
    return { error: 'Select at least one eligible historical plate to archive.' };
  }

  const targetJobs: ProductionJob[] = [];
  for (const id of uniqueIds) {
    const found = workspace.jobs.find((j) => j.id === id);
    if (!found) {
      return { error: `Plate "${id}" could not be found.` };
    }
    const blockReason = getArchiveIneligibilityReason(found);
    if (blockReason) {
      return { error: blockReason };
    }
    targetJobs.push(found);
  }

  const nowMs = options?.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const timezone = workspace.settings?.timezone || DEFAULT_TIMEZONE;
  const actorLabel = formatActorLabel(actor!);
  const idSet = new Set(uniqueIds);
  const totalKeycaps = targetJobs.reduce((sum, j) => sum + countPlateKeycaps(j), 0);
  const affectedProjects = Array.from(new Set(targetJobs.map((j) => j.projectId)));

  const nextJobs = workspace.jobs.map((j) =>
    idSet.has(j.id)
      ? {
          ...j,
          archived: true,
          archivedIso: nowIso,
          archivedBy: actorLabel,
          updatedIso: nowIso,
        }
      : j
  );

  const nextProjects = reconcileProjectsForAffectedJobs(
    workspace.projects,
    nextJobs,
    targetJobs,
    nowIso
  );

  return {
    archivedCount: targetJobs.length,
    nextWorkspace: {
      ...workspace,
      projects: nextProjects,
      jobs: nextJobs,
      log: [
        createActivityLogEntry({
          category: 'plate',
          msg: `Bulk archived ${targetJobs.length} historical plate(s) (${totalKeycaps} pcs preserved)`,
          projectId: affectedProjects.length === 1 ? affectedProjects[0] : null,
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
 * Atomically restores multiple archived plates.
 */
export function bulkRestorePrintPlates(
  workspace: ProductionWorkspaceV5,
  jobIds: string[],
  options?: {
    actor?: AdminActorContext | null;
    nowMs?: number;
  }
): { nextWorkspace?: ProductionWorkspaceV5; error?: string; restoredCount?: number } {
  const actor = resolveLifecycleActor(options?.actor, workspace);
  if (!isAuthorizedAdmin(actor, workspace)) {
    return {
      error: 'Unauthorized: Admin privileges are required to bulk restore plates.',
    };
  }

  const uniqueIds = Array.from(new Set(jobIds.filter(Boolean)));
  if (uniqueIds.length === 0) {
    return { error: 'Select at least one archived plate to restore.' };
  }

  const targetJobs: ProductionJob[] = [];
  for (const id of uniqueIds) {
    const found = workspace.jobs.find((j) => j.id === id);
    if (!found) {
      return { error: `Plate "${id}" could not be found.` };
    }
    if (!canRestorePlate(found)) {
      return { error: `Plate ${found.plateNumber} is not currently archived.` };
    }
    targetJobs.push(found);
  }

  const nowMs = options?.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const timezone = workspace.settings?.timezone || DEFAULT_TIMEZONE;
  const idSet = new Set(uniqueIds);
  const affectedProjects = Array.from(new Set(targetJobs.map((j) => j.projectId)));

  const nextJobs = workspace.jobs.map((j) =>
    idSet.has(j.id)
      ? {
          ...j,
          archived: false,
          archivedIso: null,
          archivedBy: null,
          updatedIso: nowIso,
        }
      : j
  );

  const nextProjects = reconcileProjectsForAffectedJobs(
    workspace.projects,
    nextJobs,
    targetJobs,
    nowIso
  );

  return {
    restoredCount: targetJobs.length,
    nextWorkspace: {
      ...workspace,
      projects: nextProjects,
      jobs: nextJobs,
      log: [
        createActivityLogEntry({
          category: 'plate',
          msg: `Bulk restored ${targetJobs.length} archived plate(s)`,
          projectId: affectedProjects.length === 1 ? affectedProjects[0] : null,
          nowMs,
          timezone,
        }),
        ...workspace.log,
      ].slice(0, 200),
      updatedIso: nowIso,
    },
  };
}

export interface QueueFilterCriteria {
  tab: QueueLifecycleTab;
  projectId: string; // 'ALL' or project.id
  colorId: string; // 'ALL' or color.id
  machineId: string; // 'ALL' | 'UNASSIGNED' | machine.id
  status: string; // 'ALL' or KanbanStage
}

/**
 * Single source-of-truth filter shared identically by Kanban Board and Table View.
 */
export function filterQueueJobs(
  jobs: ProductionJob[],
  criteria: QueueFilterCriteria
): ProductionJob[] {
  return jobs
    .filter((j) => {
      const isArchived = Boolean(j.archived);
      if (criteria.tab === 'active') {
        if (isArchived || j.stage === 'Cancelled') return false;
      } else if (criteria.tab === 'cancelled') {
        if (isArchived || j.stage !== 'Cancelled') return false;
      } else if (criteria.tab === 'archived') {
        if (!isArchived) return false;
      }

      if (criteria.projectId !== 'ALL' && j.projectId !== criteria.projectId) {
        return false;
      }
      if (criteria.colorId !== 'ALL' && j.colorId !== criteria.colorId) {
        return false;
      }
      if (criteria.machineId === 'UNASSIGNED') {
        if (j.machineId !== null && j.machineId !== '') return false;
      } else if (criteria.machineId !== 'ALL' && j.machineId !== criteria.machineId) {
        return false;
      }
      if (criteria.status !== 'ALL' && j.stage !== criteria.status) {
        return false;
      }
      return true;
    })
    .sort((a, b) => a.plateNumber - b.plateNumber);
}

export interface ColorDemandGap {
  colorId: string;
  colorName: string;
  targetKeycaps: number;
  coveredKeycaps: number;
  unmetKeycaps: number;
  carryForwardKeycaps: number;
}

export interface ProjectDemandSummary {
  projectId: string;
  projectName: string;
  targetKeycaps: number;
  completedKeycaps: number;
  queuedAndPrintingKeycaps: number;
  coveredKeycaps: number;
  unmetKeycaps: number;
  carryForwardKeycaps: number;
  cancelledPlatesCount: number;
  archivedPlatesCount: number;
  colorGaps: ColorDemandGap[];
}

/**
 * Determines whether a ProductionJob counts as a valid production allocation:
 * - Completed plates ALWAYS count (even when archived, preserving completed production history).
 * - Non-archived Planned, Ready to Print, and Printing plates count as active pipeline allocation.
 * - Cancelled, Failed / Reprint, and archived non-completed plates do NOT count.
 */
export function isValidProductionAllocationJob(job: ProductionJob): boolean {
  if (job.stage === 'Completed') {
    return true;
  }
  if (job.archived) {
    return false;
  }
  return (
    job.stage === 'Planned' ||
    job.stage === 'Ready to Print' ||
    job.stage === 'Printing'
  );
}

export interface ColorPlanningState {
  projectId: string;
  colorId: string;
  plateCapacity: number;
  // 1. User-defined target quantities
  userTargetLetters: LettersMap;
  userTargetCharms: Record<CharmId, number>;
  userTargetLettersCount: number;
  userTargetCharmsCount: number;
  userTargetTotal: number;
  // 2. Completed production quantities (including archived Completed plates)
  completedLetters: LettersMap;
  completedCharms: Record<CharmId, number>;
  completedLettersCount: number;
  completedCharmsCount: number;
  completedTotal: number;
  completedPlatesCount: number;
  // 3. Generated active plate quantities (Planned + Ready to Print + Printing, non-archived)
  activePlateLetters: LettersMap;
  activePlateCharms: Record<CharmId, number>;
  activePlateLettersCount: number;
  activePlateCharmsCount: number;
  activePlatesTotal: number;
  activePlatesCount: number;
  queuedPlatesCount: number;
  printingPlatesCount: number;
  // Combined valid production allocation (Completed + Active Generated Plates)
  validAllocatedLetters: LettersMap;
  validAllocatedCharms: Record<CharmId, number>;
  validAllocatedTotal: number;
  // 4. Remaining unfulfilled demand (max(0, Target - ValidProductionAllocation))
  remainingDemandLetters: LettersMap;
  remainingDemandCharms: Record<CharmId, number>;
  remainingDemandLettersCount: number;
  remainingDemandCharmsCount: number;
  remainingDemandTotal: number;
  // 5. Derived temporary carry-forward from incomplete plate allocation
  carryForwardLetters: LettersMap;
  carryForwardCharms: CharmsMap;
  carryForwardLettersCount: number;
  carryForwardCharmsCount: number;
  carryForwardTotal: number;
  validSessions: PlanningSessionRecord[];
  // Reserved warehouse stock allocated to this project/color (tracked distinctly)
  allocatedStockLetters: LettersMap;
  allocatedStockTotal: number;
}

interface ColorMutationContext {
  affectedSessionIds: Set<string>;
  hadLegacySessionlessInvalidation: boolean;
  invalidatedLettersCategory: boolean;
  invalidatedCharmsCategory: boolean;
}

function areLettersMapsEqual(a?: LettersMap | null, b?: LettersMap | null): boolean {
  const normA = normalizeAlphabetMap(a);
  const normB = normalizeAlphabetMap(b);
  return ABC.every((k) => normA[k] === normB[k]);
}

function areCharmsMapsEqual(
  a?: Partial<Record<string, number>> | null,
  b?: Partial<Record<string, number>> | null
): boolean {
  const normA = normalizeCharmsMap(a);
  const normB = normalizeCharmsMap(b);
  return CHARM_IDS.every((cid) => normA[cid] === normB[cid]);
}

function arePlanningSessionsEqual(
  a?: PlanningSessionRecord[],
  b?: PlanningSessionRecord[]
): boolean {
  const listA = a || [];
  const listB = b || [];
  if (listA.length !== listB.length) return false;
  for (let i = 0; i < listA.length; i += 1) {
    const sa = listA[i];
    const sb = listB[i];
    if (
      sa.sessionId !== sb.sessionId ||
      sa.colorId !== sb.colorId ||
      sa.mode !== sb.mode ||
      sa.plateCapacity !== sb.plateCapacity ||
      sa.generatedJobIds.length !== sb.generatedJobIds.length ||
      sa.generatedJobIds.some((id, idx) => id !== sb.generatedJobIds[idx]) ||
      !areLettersMapsEqual(sa.carryForwardLetters, sb.carryForwardLetters) ||
      !areCharmsMapsEqual(sa.carryForwardCharms, sb.carryForwardCharms)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Computes the complete, non-overlapping 5-quantity production planning state
 * for a single `(project, colorId)` pair, deriving valid carry-forward from
 * active intact planning sessions and current unfulfilled demand rather than
 * trusting independent stale snapshots.
 */
export function computeColorPlanningState(
  jobs: ProductionJob[],
  project: ProductionProject,
  colorId: string,
  mutationContext?: ColorMutationContext
): ColorPlanningState {
  const plateCapacity = Math.max(1, Math.floor(project.plateCapacity || 138));
  const projectColorJobs = jobs.filter(
    (j) => j.projectId === project.id && j.colorId === colorId
  );

  // 1. User-defined target quantities
  const userTargetLetters = normalizeAlphabetMap(project.targetsByColor?.[colorId]);
  const userTargetCharms = normalizeCharmsMap(project.charmTargetsByColor?.[colorId]);
  const userTargetLettersCount = countLetters(userTargetLetters);
  const userTargetCharmsCount = countCharms(userTargetCharms);
  const userTargetTotal = userTargetLettersCount + userTargetCharmsCount;

  // 2. Completed production quantities (Completed plates always count, even when archived)
  const completedJobs = projectColorJobs.filter((j) => j.stage === 'Completed');
  const completedLetters = sumAlphabetMaps(completedJobs.map((j) => j.letters));
  const completedCharms = sumCharmsMaps(completedJobs.map((j) => j.charms));
  const completedLettersCount = countLetters(completedLetters);
  const completedCharmsCount = countCharms(completedCharms);
  const completedTotal = completedLettersCount + completedCharmsCount;

  // 3. Generated active plate quantities (Planned + Ready to Print + Printing, non-archived)
  const activeJobs = projectColorJobs.filter(
    (j) =>
      !j.archived &&
      (j.stage === 'Planned' ||
        j.stage === 'Ready to Print' ||
        j.stage === 'Printing')
  );
  const queuedJobs = activeJobs.filter(
    (j) => j.stage === 'Planned' || j.stage === 'Ready to Print'
  );
  const printingJobs = activeJobs.filter((j) => j.stage === 'Printing');

  const activePlateLetters = sumAlphabetMaps(activeJobs.map((j) => j.letters));
  const activePlateCharms = sumCharmsMaps(activeJobs.map((j) => j.charms));
  const activePlateLettersCount = countLetters(activePlateLetters);
  const activePlateCharmsCount = countCharms(activePlateCharms);
  const activePlatesTotal = activePlateLettersCount + activePlateCharmsCount;

  // Valid production allocation = Completed + Active Generated Plates
  const validJobs = [...completedJobs, ...activeJobs];
  const validJobIdSet = new Set(validJobs.map((j) => j.id));
  const validAllocatedLetters = sumAlphabetMaps([
    completedLetters,
    activePlateLetters,
  ]);
  const validAllocatedCharms = sumCharmsMaps([
    completedCharms,
    activePlateCharms,
  ]);
  const validAllocatedTotal =
    countLetters(validAllocatedLetters) + countCharms(validAllocatedCharms);

  // 4. Remaining unfulfilled demand = max(0, Target - ValidProductionAllocation)
  const remainingDemandLetters = emptyAlphabetMap();
  for (const letter of ABC) {
    remainingDemandLetters[letter] = Math.max(
      0,
      (userTargetLetters[letter] || 0) - (validAllocatedLetters[letter] || 0)
    );
  }
  const remainingDemandCharms = emptyCharmsMap();
  for (const charmId of CHARM_IDS) {
    remainingDemandCharms[charmId] = Math.max(
      0,
      (userTargetCharms[charmId] || 0) - (validAllocatedCharms[charmId] || 0)
    );
  }
  const remainingDemandLettersCount = countLetters(remainingDemandLetters);
  const remainingDemandCharmsCount = countCharms(remainingDemandCharms);
  const remainingDemandTotal =
    remainingDemandLettersCount + remainingDemandCharmsCount;

  // 5. Temporary carry-forward derived from valid planning sessions & current state
  const existingColorSessions = (project.planningSessions || []).filter(
    (s) => s.colorId === colorId
  );

  const validSessions: PlanningSessionRecord[] = [];
  let derivedCarryLetters = emptyAlphabetMap();
  let derivedCarryCharms = emptyCharmsMap();

  if (existingColorSessions.length > 0) {
    for (const session of existingColorSessions) {
      const sCap = Math.max(1, Math.floor(session.plateCapacity || plateCapacity));
      const origGeneratedCount = session.generatedJobIds.length;
      const validGeneratedCount = session.generatedJobIds.filter((id) =>
        validJobIdSet.has(id)
      ).length;

      // If this session originally generated plates and ALL of them are now deleted/cancelled/failed,
      // the planning session is no longer applicable — clear its carry-forward record.
      if (origGeneratedCount > 0 && validGeneratedCount === 0) {
        continue;
      }

      const modeTargetCount =
        session.mode === 'alphabet_only'
          ? userTargetLettersCount
          : session.mode === 'charm_only'
          ? userTargetCharmsCount
          : userTargetTotal;

      const modeRemainingCount =
        session.mode === 'alphabet_only'
          ? remainingDemandLettersCount
          : session.mode === 'charm_only'
          ? remainingDemandCharmsCount
          : remainingDemandTotal;

      // If one or more generated plates in this session were deleted/cancelled/failed,
      // the session's pre-deletion incomplete-plate remainder is invalidated so stale carry-forward never persists.
      if (origGeneratedCount > 0 && validGeneratedCount < origGeneratedCount) {
        continue;
      }

      // Carry-only session (0 plates generated): invalidated if remaining demand grew to >= full plate
      if (
        origGeneratedCount === 0 &&
        modeTargetCount > 0 &&
        modeRemainingCount >= sCap
      ) {
        continue;
      }

      const effSessionLetters: LettersMap = {};
      if (session.mode !== 'charm_only') {
        for (const letter of ABC) {
          const rawVal = Math.max(
            0,
            Math.floor(Number(session.carryForwardLetters?.[letter] || 0))
          );
          if (rawVal <= 0) continue;
          const boundedVal =
            (userTargetLetters[letter] || 0) > 0
              ? Math.min(rawVal, remainingDemandLetters[letter] || 0)
              : rawVal;
          if (boundedVal > 0) {
            effSessionLetters[letter] = boundedVal;
          }
        }
      }

      const effSessionCharms: CharmsMap = {};
      if (session.mode !== 'alphabet_only') {
        for (const charmId of CHARM_IDS) {
          const rawVal = Math.max(
            0,
            Math.floor(Number(session.carryForwardCharms?.[charmId] || 0))
          );
          if (rawVal <= 0) continue;
          const boundedVal =
            (userTargetCharms[charmId] || 0) > 0
              ? Math.min(rawVal, remainingDemandCharms[charmId] || 0)
              : rawVal;
          if (boundedVal > 0) {
            effSessionCharms[charmId] = boundedVal;
          }
        }
      }

      const effTotal = countLetters(effSessionLetters) + countCharms(effSessionCharms);
      if (effTotal > 0 && effTotal < sCap) {
        validSessions.push({
          ...session,
          plateCapacity: sCap,
          carryForwardLetters: effSessionLetters,
          carryForwardCharms: effSessionCharms,
        });
        derivedCarryLetters = sumAlphabetMaps([
          derivedCarryLetters,
          effSessionLetters,
        ]);
        derivedCarryCharms = sumCharmsMaps([
          derivedCarryCharms,
          effSessionCharms,
        ]);
      }
    }
  } else {
    // Backward-compatible derivation for legacy workspaces without `planningSessions`
    const rawLegacyLetters = compactLettersMap(
      project.carryForwardByColor?.[colorId] || {}
    );
    const rawLegacyCharms = compactCharmsMap(
      project.charmCarryForwardByColor?.[colorId] || {}
    );
    const hasLegacyLetters = countLetters(rawLegacyLetters) > 0;
    const hasLegacyCharms = countCharms(rawLegacyCharms) > 0;

    if (hasLegacyLetters || hasLegacyCharms) {
      const validAlphabetPlatesCount = validJobs.filter(
        (j) => countLetters(j.letters) > 0
      ).length;
      const validCharmPlatesCount = validJobs.filter(
        (j) => countCharms(j.charms) > 0
      ).length;

      // Legacy carry-forward is orphaned if a legacy plate in that category was just invalidated
      // OR if 0 valid plates remain while total remaining demand can already fill a plate (>= capacity).
      const invalidateLegacyLetters =
        (Boolean(mutationContext?.hadLegacySessionlessInvalidation) &&
          (Boolean(mutationContext?.invalidatedLettersCategory) ||
            validAlphabetPlatesCount === 0 ||
            remainingDemandTotal >= plateCapacity)) ||
        (validJobs.length === 0 && remainingDemandTotal >= plateCapacity) ||
        (userTargetLettersCount > 0 && remainingDemandLettersCount >= plateCapacity);

      const invalidateLegacyCharms =
        (Boolean(mutationContext?.hadLegacySessionlessInvalidation) &&
          (Boolean(mutationContext?.invalidatedCharmsCategory) ||
            validCharmPlatesCount === 0 ||
            remainingDemandTotal >= plateCapacity)) ||
        (validJobs.length === 0 && remainingDemandTotal >= plateCapacity) ||
        (userTargetCharmsCount > 0 && remainingDemandCharmsCount >= plateCapacity);

      if (hasLegacyLetters && !invalidateLegacyLetters) {
        for (const letter of ABC) {
          const rawVal = rawLegacyLetters[letter] || 0;
          if (rawVal <= 0) continue;
          derivedCarryLetters[letter] =
            (userTargetLetters[letter] || 0) > 0
              ? Math.min(rawVal, remainingDemandLetters[letter] || 0)
              : rawVal;
        }
      }

      if (hasLegacyCharms && !invalidateLegacyCharms) {
        for (const charmId of CHARM_IDS) {
          const rawVal = rawLegacyCharms[charmId] || 0;
          if (rawVal <= 0) continue;
          derivedCarryCharms[charmId] =
            (userTargetCharms[charmId] || 0) > 0
              ? Math.min(rawVal, remainingDemandCharms[charmId] || 0)
              : rawVal;
        }
      }

      if (
        countLetters(derivedCarryLetters) + countCharms(derivedCarryCharms) >=
        plateCapacity
      ) {
        derivedCarryLetters = emptyAlphabetMap();
        derivedCarryCharms = emptyCharmsMap();
      }
    }
  }

  // Cap combined derived carry-forward per key so it never exceeds remaining unfulfilled demand when an explicit target exists for that key
  for (const letter of ABC) {
    if ((userTargetLetters[letter] || 0) > 0) {
      derivedCarryLetters[letter] = Math.min(
        derivedCarryLetters[letter] || 0,
        remainingDemandLetters[letter] || 0
      );
    }
  }
  for (const charmId of CHARM_IDS) {
    if ((userTargetCharms[charmId] || 0) > 0) {
      derivedCarryCharms[charmId] = Math.min(
        derivedCarryCharms[charmId] || 0,
        remainingDemandCharms[charmId] || 0
      );
    }
  }

  const compactedCarryLetters = compactLettersMap(derivedCarryLetters);
  const compactedCarryCharms = compactCharmsMap(derivedCarryCharms);
  const carryForwardLettersCount = countLetters(compactedCarryLetters);
  const carryForwardCharmsCount = countCharms(compactedCarryCharms);
  const carryForwardTotal = carryForwardLettersCount + carryForwardCharmsCount;

  const allocatedStockLetters = normalizeAlphabetMap(
    project.allocatedStockByColor?.[colorId]
  );
  const allocatedStockTotal = countLetters(allocatedStockLetters);

  return {
    projectId: project.id,
    colorId,
    plateCapacity,
    userTargetLetters,
    userTargetCharms,
    userTargetLettersCount,
    userTargetCharmsCount,
    userTargetTotal,
    completedLetters,
    completedCharms,
    completedLettersCount,
    completedCharmsCount,
    completedTotal,
    completedPlatesCount: completedJobs.length,
    activePlateLetters,
    activePlateCharms,
    activePlateLettersCount,
    activePlateCharmsCount,
    activePlatesTotal,
    activePlatesCount: activeJobs.length,
    queuedPlatesCount: queuedJobs.length,
    printingPlatesCount: printingJobs.length,
    validAllocatedLetters,
    validAllocatedCharms,
    validAllocatedTotal,
    remainingDemandLetters,
    remainingDemandCharms,
    remainingDemandLettersCount,
    remainingDemandCharmsCount,
    remainingDemandTotal,
    carryForwardLetters: compactedCarryLetters,
    carryForwardCharms: compactedCarryCharms,
    carryForwardLettersCount,
    carryForwardCharmsCount,
    carryForwardTotal,
    validSessions,
    allocatedStockLetters,
    allocatedStockTotal,
  };
}

/**
 * Reconciles carry-forward and planning session records ONLY for the `(projectId, colorId)`
 * pairs touched by `affectedJobs`.
 * - Strictly preserves unrelated projects (exact object reference) and unrelated colors.
 * - Preserves exact project object reference if derived carry-forward and sessions did not change.
 */
export function reconcileProjectsForAffectedJobs(
  projects: ProductionProject[],
  nextJobs: ProductionJob[],
  affectedJobs: ProductionJob[],
  nowIso: string
): ProductionProject[] {
  if (affectedJobs.length === 0) {
    return projects;
  }

  // Group affected jobs by projectId -> colorId
  const byProjectColor = new Map<string, Map<string, ProductionJob[]>>();
  for (const job of affectedJobs) {
    let colorMap = byProjectColor.get(job.projectId);
    if (!colorMap) {
      colorMap = new Map<string, ProductionJob[]>();
      byProjectColor.set(job.projectId, colorMap);
    }
    const list = colorMap.get(job.colorId) || [];
    list.push(job);
    colorMap.set(job.colorId, list);
  }

  const nextJobById = new Map(nextJobs.map((j) => [j.id, j]));

  return projects.map((project) => {
    const affectedColorsMap = byProjectColor.get(project.id);
    if (!affectedColorsMap) {
      // Unrelated project: strictly untouched
      return project;
    }

    let projectChanged = false;
    const nextTargetsByColor: Record<string, LettersMap> = {
      ...project.targetsByColor,
    };
    const nextCharmTargetsByColor: Record<string, CharmsMap> = {
      ...(project.charmTargetsByColor || {}),
    };
    const nextCarryByColor: Record<string, LettersMap> = {
      ...project.carryForwardByColor,
    };
    const nextCharmCarryByColor: Record<string, CharmsMap> = {
      ...(project.charmCarryForwardByColor || {}),
    };

    const untouchedSessions = (project.planningSessions || []).filter(
      (s) => !affectedColorsMap.has(s.colorId)
    );
    const reconciledAffectedSessions: PlanningSessionRecord[] = [];

    for (const [colorId, jobsForColor] of affectedColorsMap.entries()) {
      const affectedSessionIds = new Set<string>();
      let hadLegacySessionlessInvalidation = false;
      let invalidatedLettersCategory = false;
      let invalidatedCharmsCategory = false;
      let wasDeletedForColor = false;

      for (const aj of jobsForColor) {
        const currentInNext = nextJobById.get(aj.id);
        if (!currentInNext) {
          wasDeletedForColor = true;
        }
        const isNowInvalidated =
          !currentInNext || !isValidProductionAllocationJob(currentInNext);

        if (aj.planningSessionId) {
          if (isNowInvalidated) {
            affectedSessionIds.add(aj.planningSessionId);
          }
        } else {
          // Also check if any PlanningSessionRecord lists aj.id in generatedJobIds
          const matchingSession = (project.planningSessions || []).find(
            (s) => s.colorId === colorId && s.generatedJobIds.includes(aj.id)
          );
          if (matchingSession) {
            if (isNowInvalidated) {
              affectedSessionIds.add(matchingSession.sessionId);
            }
          } else if (isNowInvalidated) {
            hadLegacySessionlessInvalidation = true;
            if (countLetters(aj.letters) > 0) {
              invalidatedLettersCategory = true;
            }
            if (countCharms(aj.charms) > 0) {
              invalidatedCharmsCategory = true;
            }
          }
        }
      }

      const derived = computeColorPlanningState(nextJobs, project, colorId, {
        affectedSessionIds,
        hadLegacySessionlessInvalidation,
        invalidatedLettersCategory,
        invalidatedCharmsCategory,
      });

      const prevCarryL = project.carryForwardByColor?.[colorId];
      const nextNormalizedCarryL = normalizeAlphabetMap(derived.carryForwardLetters);
      if (!areLettersMapsEqual(prevCarryL, nextNormalizedCarryL)) {
        nextCarryByColor[colorId] = nextNormalizedCarryL;
        projectChanged = true;
      }

      const prevCarryC = project.charmCarryForwardByColor?.[colorId];
      const nextCompactCarryC = compactCharmsMap(derived.carryForwardCharms);
      if (!areCharmsMapsEqual(prevCarryC, nextCompactCarryC)) {
        if (Object.keys(nextCompactCarryC).length > 0) {
          nextCharmCarryByColor[colorId] = nextCompactCarryC;
        } else if (project.charmCarryForwardByColor && colorId in project.charmCarryForwardByColor) {
          nextCharmCarryByColor[colorId] = {};
        }
        projectChanged = true;
      }

      // When plates are deleted from Print Queue, reconcile color targets to remaining valid plates + valid carry-forward
      // so deleted plates and removed letters/charms are never automatically recreated from historical target quantities.
      if (wasDeletedForColor) {
        const reconciledTargetL = normalizeAlphabetMap(
          sumAlphabetMaps([derived.validAllocatedLetters, derived.carryForwardLetters])
        );
        if (!areLettersMapsEqual(project.targetsByColor?.[colorId], reconciledTargetL)) {
          nextTargetsByColor[colorId] = reconciledTargetL;
          projectChanged = true;
        }

        const reconciledTargetC = compactCharmsMap(
          sumCharmsMaps([derived.validAllocatedCharms, derived.carryForwardCharms])
        );
        if (!areCharmsMapsEqual(project.charmTargetsByColor?.[colorId], reconciledTargetC)) {
          if (Object.keys(reconciledTargetC).length > 0) {
            nextCharmTargetsByColor[colorId] = reconciledTargetC;
          } else if (project.charmTargetsByColor && colorId in project.charmTargetsByColor) {
            nextCharmTargetsByColor[colorId] = {};
          }
          projectChanged = true;
        }
      }

      reconciledAffectedSessions.push(
        ...derived.validSessions.map((s) =>
          areLettersMapsEqual(
            s.carryForwardLetters,
            (project.planningSessions || []).find(
              (orig) => orig.sessionId === s.sessionId
            )?.carryForwardLetters
          ) &&
          areCharmsMapsEqual(
            s.carryForwardCharms,
            (project.planningSessions || []).find(
              (orig) => orig.sessionId === s.sessionId
            )?.carryForwardCharms
          )
            ? s
            : { ...s, updatedIso: nowIso }
        )
      );
    }

    // Preserve deterministic order of sessions while keeping untouched colors verbatim
    const combinedSessions: PlanningSessionRecord[] = [];
    const seenSessionIds = new Set<string>();
    for (const orig of project.planningSessions || []) {
      if (!affectedColorsMap.has(orig.colorId)) {
        combinedSessions.push(orig);
        seenSessionIds.add(orig.sessionId);
      } else {
        const updatedMatch = reconciledAffectedSessions.find(
          (rs) => rs.sessionId === orig.sessionId
        );
        if (updatedMatch) {
          combinedSessions.push(updatedMatch);
          seenSessionIds.add(updatedMatch.sessionId);
        }
      }
    }
    for (const extra of [...untouchedSessions, ...reconciledAffectedSessions]) {
      if (!seenSessionIds.has(extra.sessionId)) {
        combinedSessions.push(extra);
        seenSessionIds.add(extra.sessionId);
      }
    }

    if (!arePlanningSessionsEqual(project.planningSessions, combinedSessions)) {
      projectChanged = true;
    }

    if (!projectChanged) {
      return project;
    }

    const updatedProject: ProductionProject = {
      ...project,
      targetsByColor: nextTargetsByColor,
      carryForwardByColor: nextCarryByColor,
      updatedIso: nowIso,
    };

    if (
      project.charmTargetsByColor !== undefined ||
      Object.values(nextCharmTargetsByColor).some((m) => countCharms(m) > 0)
    ) {
      updatedProject.charmTargetsByColor = nextCharmTargetsByColor;
    }

    if (
      project.charmCarryForwardByColor !== undefined ||
      Object.values(nextCharmCarryByColor).some((m) => countCharms(m) > 0)
    ) {
      updatedProject.charmCarryForwardByColor = nextCharmCarryByColor;
    }

    if (combinedSessions.length > 0) {
      updatedProject.planningSessions = combinedSessions;
    } else {
      delete updatedProject.planningSessions;
    }

    return updatedProject;
  });
}

/**
 * Inspects whether deleting or cancelling a specific `job` will invalidate
 * any active carry-forward quantities for `(job.projectId, job.colorId)`.
 */
export function getPlateCarryForwardImpact(
  workspace: ProductionWorkspaceV5,
  job: ProductionJob
): {
  beforeCarryForwardTotal: number;
  afterCarryForwardTotal: number;
  clearedCarryForwardCount: number;
  remainingActivePlatesCount: number;
  remainingValidKeycaps: number;
  remainingDemandAfter: number;
} {
  const project = workspace.projects.find((p) => p.id === job.projectId);
  if (!project) {
    return {
      beforeCarryForwardTotal: 0,
      afterCarryForwardTotal: 0,
      clearedCarryForwardCount: 0,
      remainingActivePlatesCount: 0,
      remainingValidKeycaps: 0,
      remainingDemandAfter: 0,
    };
  }

  const beforeState = computeColorPlanningState(
    workspace.jobs,
    project,
    job.colorId
  );
  const simulatedJobs = workspace.jobs.filter((j) => j.id !== job.id);
  const simulatedProjects = reconcileProjectsForAffectedJobs(
    workspace.projects,
    simulatedJobs,
    [job],
    workspace.updatedIso
  );
  const simulatedProject =
    simulatedProjects.find((p) => p.id === job.projectId) || project;
  const afterState = computeColorPlanningState(
    simulatedJobs,
    simulatedProject,
    job.colorId
  );

  return {
    beforeCarryForwardTotal: beforeState.carryForwardTotal,
    afterCarryForwardTotal: afterState.carryForwardTotal,
    clearedCarryForwardCount: Math.max(
      0,
      beforeState.carryForwardTotal - afterState.carryForwardTotal
    ),
    remainingActivePlatesCount: afterState.activePlatesCount,
    remainingValidKeycaps: afterState.validAllocatedTotal,
    remainingDemandAfter: afterState.remainingDemandTotal,
  };
}

/**
 * Pure domain handler that commits generated Auto Plate Planner plates and
 * associates them + any incomplete-plate carry-forward with a `PlanningSessionRecord`.
 * Preserves Completed, Printing, Failed / Reprint, Cancelled, Archived, cross-category,
 * and (when `preserveQueuedPlates` is true) existing active queued plates.
 */
export function commitGeneratedPlatesToWorkspace(
  workspace: ProductionWorkspaceV5,
  params: {
    projectId: string;
    colorId: string;
    plateCapacity: number;
    mode: PlateGenerationMode;
    targetLetters: LettersMap;
    targetCharms: CharmsMap;
    carryForwardLetters: LettersMap;
    carryForwardCharms: CharmsMap;
    confirmedPlates: DraftPlatePreview[];
    preserveQueuedPlates?: boolean;
    nowMs?: number;
  }
): {
  nextWorkspace?: ProductionWorkspaceV5;
  createdJobs?: ProductionJob[];
  sessionId?: string;
  error?: string;
} {
  const project = workspace.projects.find((p) => p.id === params.projectId);
  const color = workspace.colors.find((c) => c.id === params.colorId);
  if (!project || !color) {
    return { error: 'Project or filament color not found.' };
  }

  const nowMs = params.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const timezone = workspace.settings?.timezone || DEFAULT_TIMEZONE;
  const safeCap = Math.max(1, Math.floor(params.plateCapacity || 138));
  const preserveQueued = Boolean(params.preserveQueuedPlates);

  const sessionId = `plan-${nowMs}-${Math.random().toString(36).slice(2, 7)}`;

  const keptJobs = workspace.jobs.filter((j) => {
    if (j.projectId !== params.projectId || j.colorId !== params.colorId) {
      return true;
    }
    if (
      preserveQueued &&
      !j.archived &&
      (j.stage === 'Planned' || j.stage === 'Ready to Print')
    ) {
      return true;
    }
    return shouldPreserveExistingJobOnRegenerate(j, params.mode);
  });

  const createdJobs: ProductionJob[] = params.confirmedPlates.map((draft, idx) => {
    const compactedLetters = compactLettersMap(draft.letters);
    const compactedCharms = compactCharmsMap(draft.charms);
    const job: ProductionJob = {
      id: `job-${nowMs}-${idx}-${params.colorId}`,
      projectId: params.projectId,
      colorId: params.colorId,
      plateNumber: draft.plateNumber,
      plateCapacity: safeCap,
      letters: compactedLetters,
      plateMode: inferPlateMode(compactedLetters, compactedCharms),
      planningSessionId: sessionId,
      stage: draft.slicerVerified ? 'Ready to Print' : 'Planned',
      machineId: null,
      estimatedMinutes: Math.max(1, Math.round(draft.estimatedMinutes || 195)),
      actualMinutes: 0,
      slicerVerified: draft.slicerVerified,
      stockApplied: false,
      stockTransactionId: null,
      failedCount: 0,
      failureReason: '',
      notes: draft.notes || 'Generated via Auto Plate Planner',
      createdIso: nowIso,
      updatedIso: nowIso,
      completedIso: null,
    };
    if (Object.keys(compactedCharms).length > 0) {
      job.charms = compactedCharms;
    }
    return job;
  });

  const nextJobs = [...keptJobs, ...createdJobs];
  const nextNormalizedLetters = normalizeAlphabetMap(params.targetLetters);
  const nextCompactCharms = compactCharmsMap(params.targetCharms);
  const compactCarryL = compactLettersMap(params.carryForwardLetters);
  const compactCarryC = compactCharmsMap(params.carryForwardCharms);

  // Update planning sessions for `params.colorId` while strictly isolating other colors and cross-modes
  const retainedSessions: PlanningSessionRecord[] = [];
  for (const s of project.planningSessions || []) {
    if (s.colorId !== params.colorId) {
      retainedSessions.push(s);
      continue;
    }
    if (preserveQueued) {
      retainedSessions.push(s);
      continue;
    }
    if (params.mode === 'alphabet_only') {
      if (s.mode === 'charm_only') {
        retainedSessions.push(s);
      } else if (s.mode === 'mixed' && countCharms(s.carryForwardCharms) > 0) {
        retainedSessions.push({
          ...s,
          mode: 'charm_only',
          carryForwardLetters: {},
          updatedIso: nowIso,
        });
      }
    } else if (params.mode === 'charm_only') {
      if (s.mode === 'alphabet_only') {
        retainedSessions.push(s);
      } else if (s.mode === 'mixed' && countLetters(s.carryForwardLetters) > 0) {
        retainedSessions.push({
          ...s,
          mode: 'alphabet_only',
          carryForwardCharms: {},
          updatedIso: nowIso,
        });
      }
    }
    // In `mixed` mode without `preserveQueued`, prior sessions for `params.colorId` are superseded
  }

  const newCarryLettersForSession =
    params.mode === 'charm_only' ? {} : compactCarryL;
  const newCarryCharmsForSession =
    params.mode === 'alphabet_only' ? {} : compactCarryC;
  const newSessionCarryTotal =
    countLetters(newCarryLettersForSession) +
    countCharms(newCarryCharmsForSession);

  if (newSessionCarryTotal > 0) {
    retainedSessions.push({
      sessionId,
      colorId: params.colorId,
      mode: params.mode,
      plateCapacity: safeCap,
      generatedJobIds: createdJobs.map((j) => j.id),
      carryForwardLetters: newCarryLettersForSession,
      carryForwardCharms: newCarryCharmsForSession,
      createdIso: nowIso,
      updatedIso: nowIso,
    });
  }

  const nextTargetsByColor = {
    ...project.targetsByColor,
    [params.colorId]: nextNormalizedLetters,
  };
  const nextCharmTargetsByColor = {
    ...(project.charmTargetsByColor || {}),
    [params.colorId]: nextCompactCharms,
  };

  const draftProject: ProductionProject = {
    ...project,
    plateCapacity: safeCap,
    targetsByColor: nextTargetsByColor,
    carryForwardByColor: {
      ...project.carryForwardByColor,
      [params.colorId]: normalizeAlphabetMap(params.carryForwardLetters),
    },
    charmTargetsByColor: nextCharmTargetsByColor,
    charmCarryForwardByColor: {
      ...(project.charmCarryForwardByColor || {}),
      [params.colorId]: compactCarryC,
    },
    ...(retainedSessions.length > 0
      ? { planningSessions: retainedSessions }
      : {}),
    updatedIso: nowIso,
  };
  if (retainedSessions.length === 0) {
    delete draftProject.planningSessions;
  }

  // Derive authoritative carry-forward from the updated planning state
  const derivedColorState = computeColorPlanningState(
    nextJobs,
    draftProject,
    params.colorId
  );

  const otherColorSessions = retainedSessions.filter(
    (s) => s.colorId !== params.colorId
  );
  const finalSessions = [...otherColorSessions, ...derivedColorState.validSessions];

  const finalizedProject: ProductionProject = {
    ...draftProject,
    carryForwardByColor: {
      ...project.carryForwardByColor,
      [params.colorId]: normalizeAlphabetMap(
        derivedColorState.carryForwardLetters
      ),
    },
    charmCarryForwardByColor: {
      ...(project.charmCarryForwardByColor || {}),
      [params.colorId]: compactCharmsMap(derivedColorState.carryForwardCharms),
    },
  };
  if (finalSessions.length > 0) {
    finalizedProject.planningSessions = finalSessions;
  } else {
    delete finalizedProject.planningSessions;
  }

  const nextProjects = workspace.projects.map((p) =>
    p.id === project.id ? finalizedProject : p
  );

  const carryCount = derivedColorState.carryForwardTotal;
  const modeLabel =
    params.mode === 'alphabet_only'
      ? 'Alphabet Only'
      : params.mode === 'charm_only'
      ? 'Charm Only'
      : 'Alphabet + Charm';

  const logMsg = `${project.name} · ${color.name} (${modeLabel}): Generated ${createdJobs.length} plate(s)${
    carryCount > 0 ? ` and carried forward ${carryCount} pcs` : ''
  }. Completed, Failed & Printing plate history preserved.`;

  return {
    createdJobs,
    sessionId,
    nextWorkspace: {
      ...workspace,
      projects: nextProjects,
      jobs: nextJobs,
      log: [
        createActivityLogEntry({
          category: 'plate',
          msg: logMsg,
          projectId: project.id,
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
 * Explicitly clears temporary carry-forward for a single `(projectId, colorId)`
 * (and optionally a specific `mode`), optionally trimming the unplated carry-forward
 * remainder from the saved target while preserving all Completed & Active plates.
 */
export function clearProjectColorCarryForward(
  workspace: ProductionWorkspaceV5,
  params: {
    projectId: string;
    colorId: string;
    mode?: PlateGenerationMode;
    trimTargetRemainder?: boolean;
    nowMs?: number;
  }
): { nextWorkspace?: ProductionWorkspaceV5; clearedCount?: number; error?: string } {
  const project = workspace.projects.find((p) => p.id === params.projectId);
  const color = workspace.colors.find((c) => c.id === params.colorId);
  if (!project || !color) {
    return { error: 'Project or filament color not found.' };
  }

  const mode = params.mode || 'mixed';
  const nowMs = params.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const timezone = workspace.settings?.timezone || DEFAULT_TIMEZONE;

  const beforeState = computeColorPlanningState(
    workspace.jobs,
    project,
    params.colorId
  );

  const clearedLettersCount =
    mode === 'charm_only' ? 0 : beforeState.carryForwardLettersCount;
  const clearedCharmsCount =
    mode === 'alphabet_only' ? 0 : beforeState.carryForwardCharmsCount;
  const clearedCount = clearedLettersCount + clearedCharmsCount;

  const nextSessions: PlanningSessionRecord[] = [];
  for (const s of project.planningSessions || []) {
    if (s.colorId !== params.colorId) {
      nextSessions.push(s);
      continue;
    }
    if (mode === 'alphabet_only') {
      if (s.mode === 'charm_only') {
        nextSessions.push(s);
      } else if (countCharms(s.carryForwardCharms) > 0) {
        nextSessions.push({
          ...s,
          mode: 'charm_only',
          carryForwardLetters: {},
          updatedIso: nowIso,
        });
      }
    } else if (mode === 'charm_only') {
      if (s.mode === 'alphabet_only') {
        nextSessions.push(s);
      } else if (countLetters(s.carryForwardLetters) > 0) {
        nextSessions.push({
          ...s,
          mode: 'alphabet_only',
          carryForwardCharms: {},
          updatedIso: nowIso,
        });
      }
    }
  }

  const nextTargetsByColor = { ...project.targetsByColor };
  const nextCharmTargetsByColor = { ...(project.charmTargetsByColor || {}) };

  if (params.trimTargetRemainder) {
    if (mode !== 'charm_only' && clearedLettersCount > 0) {
      const trimmedLetters = emptyAlphabetMap();
      for (const letter of ABC) {
        const curTarget = beforeState.userTargetLetters[letter] || 0;
        const carryVal = beforeState.carryForwardLetters[letter] || 0;
        trimmedLetters[letter] = Math.max(
          beforeState.validAllocatedLetters[letter] || 0,
          curTarget - carryVal
        );
      }
      nextTargetsByColor[params.colorId] = trimmedLetters;
    }
    if (mode !== 'alphabet_only' && clearedCharmsCount > 0) {
      const trimmedCharms: CharmsMap = {};
      for (const charmId of CHARM_IDS) {
        const curTarget = beforeState.userTargetCharms[charmId] || 0;
        const carryVal = beforeState.carryForwardCharms[charmId] || 0;
        const nextVal = Math.max(
          beforeState.validAllocatedCharms[charmId] || 0,
          curTarget - carryVal
        );
        if (nextVal > 0) {
          trimmedCharms[charmId] = nextVal;
        }
      }
      nextCharmTargetsByColor[params.colorId] = trimmedCharms;
    }
  }

  const nextCarryByColor = {
    ...project.carryForwardByColor,
    [params.colorId]:
      mode === 'charm_only'
        ? normalizeAlphabetMap(beforeState.carryForwardLetters)
        : emptyAlphabetMap(),
  };
  const nextCharmCarryByColor = {
    ...(project.charmCarryForwardByColor || {}),
    [params.colorId]:
      mode === 'alphabet_only'
        ? compactCharmsMap(beforeState.carryForwardCharms)
        : {},
  };

  const updatedProject: ProductionProject = {
    ...project,
    targetsByColor: nextTargetsByColor,
    carryForwardByColor: nextCarryByColor,
    charmTargetsByColor: nextCharmTargetsByColor,
    charmCarryForwardByColor: nextCharmCarryByColor,
    updatedIso: nowIso,
  };
  if (nextSessions.length > 0) {
    updatedProject.planningSessions = nextSessions;
  } else {
    delete updatedProject.planningSessions;
  }

  return {
    clearedCount,
    nextWorkspace: {
      ...workspace,
      projects: workspace.projects.map((p) =>
        p.id === project.id ? updatedProject : p
      ),
      log: [
        createActivityLogEntry({
          category: 'plate',
          msg: `Cleared ${clearedCount} pcs carry-forward remainder for ${project.name} · ${color.name}`,
          projectId: project.id,
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
 * Calculates plate allocation & active carry-forward summary for a project
 * strictly from valid plate records and active planning sessions (never `targetQuantity`).
 */
export function computeProjectDemandSummary(
  workspace: ProductionWorkspaceV5,
  project: ProductionProject
): ProjectDemandSummary {
  const pJobs = workspace.jobs.filter((j) => j.projectId === project.id);
  const completedJobs = pJobs.filter((j) => j.stage === 'Completed');
  const activePipelineJobs = pJobs.filter(
    (j) =>
      !j.archived &&
      (j.stage === 'Planned' ||
        j.stage === 'Ready to Print' ||
        j.stage === 'Printing')
  );
  const cancelledJobs = pJobs.filter((j) => j.stage === 'Cancelled');
  const archivedJobs = pJobs.filter((j) => Boolean(j.archived));

  const completedKeycaps = completedJobs.reduce(
    (sum, j) => sum + countPlateKeycaps(j),
    0
  );
  const queuedAndPrintingKeycaps = activePipelineJobs.reduce(
    (sum, j) => sum + countPlateKeycaps(j),
    0
  );
  const coveredKeycaps = completedKeycaps + queuedAndPrintingKeycaps;

  const colorGaps: ColorDemandGap[] = [];
  let perColorTargetSum = 0;
  let perColorUnmetSum = 0;
  let totalCarryForwardKeycaps = 0;

  for (const cid of project.assignedColorIds || []) {
    const colorState = computeColorPlanningState(workspace.jobs, project, cid);
    perColorTargetSum += colorState.userTargetTotal;
    perColorUnmetSum += colorState.remainingDemandTotal;
    totalCarryForwardKeycaps += colorState.carryForwardTotal;

    if (colorState.remainingDemandTotal > 0) {
      const colorName =
        workspace.colors.find((c) => c.id === cid)?.name || cid;
      colorGaps.push({
        colorId: cid,
        colorName,
        targetKeycaps: colorState.userTargetTotal,
        coveredKeycaps: colorState.validAllocatedTotal,
        unmetKeycaps: colorState.remainingDemandTotal,
        carryForwardKeycaps: colorState.carryForwardTotal,
      });
    }
  }

  return {
    projectId: project.id,
    projectName: project.name,
    targetKeycaps: perColorTargetSum || coveredKeycaps,
    completedKeycaps,
    queuedAndPrintingKeycaps,
    coveredKeycaps,
    unmetKeycaps: perColorUnmetSum,
    carryForwardKeycaps: totalCarryForwardKeycaps,
    cancelledPlatesCount: cancelledJobs.length,
    archivedPlatesCount: archivedJobs.length,
    colorGaps,
  };
}
