import {
  ActiveCountdownStatus,
  PrinterMachine,
  ProductionJob,
  ProductionProject,
  ProductionWorkspaceV5,
  ProjectPriority,
} from '../types';
import { DEFAULT_TIMEZONE, getDeadlineEndOfDayMs } from './dateFormat';
import { computeJobCountdownSnapshot } from './productionCountdown';

export interface ScheduledJobSlot {
  job: ProductionJob;
  project: ProductionProject | undefined;
  colorName: string;
  assignedMachineId: string | null; // Explicit or virtual best-fit machine
  assignedMachineName: string;
  isVirtualAssignment: boolean; // True when auto-routed across pool because machineId was unassigned
  isActivePrinting: boolean;
  isPaused: boolean;
  countdownStatus: ActiveCountdownStatus;
  needsEtaRecalibration: boolean;
  isAwaitingConfirmation: boolean;
  effectivePrintMinutes: number;
  setupAndBufferMinutes: number;
  startMs: number | null;
  endMs: number | null;
  remainingMsLive: number;
  remainingSecondsLive: number;
  exceedsProjectDeadline: boolean;
}

export interface MachineScheduleSummary {
  machine: PrinterMachine;
  isAvailableForScheduling: boolean;
  activeSlot: ScheduledJobSlot | null;
  queuedSlots: ScheduledJobSlot[];
  nextFreeAtMs: number | null; // Null if Offline with no return time
  utilizationMinutesScheduled: number;
}

export interface ProjectEtaSummary {
  project: ProductionProject;
  totalPlates: number;
  completedPlates: number;
  activePrintingPlates: number;
  outstandingPlates: number;
  cancelledPlates: number;
  estimatedCompletionMs: number | null; // Max endMs of all outstanding plates (parallel-aware!)
  deadlineEndOfDayMs: number | null;
  isDeadlineExceeded: boolean;
  slackMinutes: number | null; // Positive = ahead of deadline, Negative = late
  unschedulablePlatesCount: number;
}

export interface GlobalScheduleResult {
  nowMs: number;
  turnaroundBufferMinutes: number;
  timezone: string;
  slotsByJobId: Record<string, ScheduledJobSlot>;
  machineSchedules: MachineScheduleSummary[];
  projectEtas: ProjectEtaSummary[];
  nextAvailableMachine: {
    machine: PrinterMachine;
    freeAtMs: number;
    waitSeconds: number;
  } | null;
  activePrintingSlots: ScheduledJobSlot[];
  deadlineWarningsCount: number;
}

const PRIORITY_WEIGHT: Record<ProjectPriority, number> = {
  Critical: 0,
  High: 1,
  Normal: 2,
  Low: 3,
};

/**
 * Calculates effective print duration (minutes) on a specific printer, honoring:
 * 1. Explicit Bambu Studio per-machine override (`job.machineDurationOverrides[machine.id]`) if set.
 * 2. Otherwise `job.estimatedMinutes * machine.speedFactor`.
 */
export function getEffectivePrintMinutes(
  job: ProductionJob,
  machine?: PrinterMachine | null
): number {
  const base = Math.max(1, Math.round(job.estimatedMinutes || 195));
  if (!machine) return base;
  const override = job.machineDurationOverrides?.[machine.id];
  if (typeof override === 'number' && override > 0) {
    return Math.round(override);
  }
  const factor =
    typeof machine.speedFactor === 'number' && machine.speedFactor > 0
      ? machine.speedFactor
      : 1;
  return Math.max(1, Math.round(base * factor));
}

/**
 * Calculates live remaining milliseconds for an actively Printing job using UTC timestamps:
 * - Active running job: `Math.max(0, estimatedFinishAtMs - nowMs)`
 * - Paused job: `Math.max(0, remainingAtPauseMs)` (frozen)
 * - Uncalibrated legacy job: `0` (flagged via `needsEtaRecalibration`)
 */
export function getLiveRemainingMs(
  job: ProductionJob,
  nowMs: number,
  machine?: PrinterMachine | null
): number {
  return computeJobCountdownSnapshot(job, nowMs, machine).remainingMs;
}

/**
 * Calculates live remaining seconds for an actively Printing job from persisted UTC timestamps.
 */
export function getLiveRemainingSeconds(
  job: ProductionJob,
  nowMs: number,
  machine?: PrinterMachine | null
): number {
  return computeJobCountdownSnapshot(job, nowMs, machine).remainingSeconds;
}

/**
 * Multi-Project Parallel Machine Scheduling Engine.
 * Considers ALL active projects together, prevents machine overlaps, respects printer-specific
 * setup times, turnaround buffers, maintenance windows, priorities, and deadlines, and computes
 * each project's ETA from its FINAL outstanding plate across parallel printers.
 */
export function computeGlobalSchedule(
  workspace: ProductionWorkspaceV5,
  nowMs: number = Date.now()
): GlobalScheduleResult {
  const turnaroundBuffer = Math.max(
    0,
    Math.round(workspace.settings?.turnaroundBufferMinutes ?? 15)
  );
  const timezone = workspace.settings?.timezone || DEFAULT_TIMEZONE;

  const projectMap = new Map<string, ProductionProject>(
    workspace.projects.map((p) => [p.id, p])
  );
  const colorMap = new Map<string, string>(
    workspace.colors.map((c) => [c.id, c.name])
  );

  // Track each machine's rolling availability cursor (epoch ms)
  const machineCursorMs = new Map<string, number | null>();
  const machineActiveSlot = new Map<string, ScheduledJobSlot | null>();
  const machineQueuedSlots = new Map<string, ScheduledJobSlot[]>();
  const machineUtilMinutes = new Map<string, number>();

  for (const m of workspace.machines) {
    machineActiveSlot.set(m.id, null);
    machineQueuedSlots.set(m.id, []);
    machineUtilMinutes.set(m.id, 0);

    if (m.status === 'Offline') {
      machineCursorMs.set(m.id, null);
    } else if (m.status === 'Maintenance') {
      if (typeof m.maintenanceUntilMs === 'number' && m.maintenanceUntilMs > nowMs) {
        machineCursorMs.set(m.id, m.maintenanceUntilMs);
      } else {
        // Indefinite maintenance until cleared or timestamp provided
        machineCursorMs.set(m.id, null);
      }
    } else {
      machineCursorMs.set(m.id, nowMs);
    }
  }

  const slotsByJobId: Record<string, ScheduledJobSlot> = {};
  const activePrintingSlots: ScheduledJobSlot[] = [];

  // Consider jobs belonging to non-archived projects
  const relevantJobs = workspace.jobs.filter((j) => {
    const proj = projectMap.get(j.projectId);
    return !proj || proj.status !== 'Archived';
  });

  // Step 1: Anchor all currently Printing jobs onto their assigned machines first (strictly non-overlapping)
  const printingJobs = relevantJobs.filter((j) => !j.archived && j.stage === 'Printing');
  for (const job of printingJobs) {
    const proj = projectMap.get(job.projectId);
    const machine = workspace.machines.find((m) => m.id === job.machineId) || null;
    const effMins = getEffectivePrintMinutes(job, machine);
    const countdown = computeJobCountdownSnapshot(job, nowMs, machine);
    const setupBuf = (machine?.setupBufferMinutes || 0) + turnaroundBuffer;

    // Never invent historical start times or finish times when a legacy active job needs recalibration
    const startMs = countdown.actualStartedAtMs;
    const finishMs = countdown.needsEtaRecalibration
      ? null
      : countdown.isPaused
      ? nowMs + countdown.remainingMs
      : countdown.estimatedFinishAtMs;

    const deadlineMs = proj?.deadline
      ? getDeadlineEndOfDayMs(proj.deadline, timezone)
      : null;

    const slot: ScheduledJobSlot = {
      job,
      project: proj,
      colorName: colorMap.get(job.colorId) || 'Color',
      assignedMachineId: machine?.id || null,
      assignedMachineName: machine?.name || 'Unassigned Printer',
      isVirtualAssignment: false,
      isActivePrinting: true,
      isPaused: countdown.isPaused,
      countdownStatus: countdown.status,
      needsEtaRecalibration: countdown.needsEtaRecalibration,
      isAwaitingConfirmation: countdown.isAwaitingConfirmation,
      effectivePrintMinutes: Math.max(1, Math.round(countdown.estimatedDurationMs / 60_000)) || effMins,
      setupAndBufferMinutes: setupBuf,
      startMs,
      endMs: finishMs,
      remainingMsLive: countdown.remainingMs,
      remainingSecondsLive: countdown.remainingSeconds,
      exceedsProjectDeadline: Boolean(
        deadlineMs &&
          (finishMs !== null
            ? Math.max(finishMs, countdown.isAwaitingConfirmation ? nowMs : finishMs) > deadlineMs
            : false)
      ),
    };

    slotsByJobId[job.id] = slot;
    activePrintingSlots.push(slot);

    if (machine) {
      machineActiveSlot.set(machine.id, slot);
      // Reserve printer until active print finishes (or conservative effective duration if uncalibrated,
      // or current wall-clock if awaiting operator confirmation) + turnaround buffer
      const machineOccupancyEndMs = countdown.needsEtaRecalibration
        ? nowMs + effMins * 60_000
        : finishMs !== null
        ? Math.max(nowMs, finishMs)
        : nowMs;
      const nextReadyMs = machineOccupancyEndMs + turnaroundBuffer * 60_000;
      const existingCursor = machineCursorMs.get(machine.id);
      machineCursorMs.set(
        machine.id,
        existingCursor !== null && existingCursor !== undefined
          ? Math.max(existingCursor, nextReadyMs)
          : nextReadyMs
      );
      const utilRemMins = countdown.needsEtaRecalibration
        ? effMins
        : Math.ceil(countdown.remainingSeconds / 60);
      machineUtilMinutes.set(
        machine.id,
        (machineUtilMinutes.get(machine.id) || 0) + utilRemMins
      );
    }
  }

  // Step 2: Sort all outstanding queued jobs across ALL projects globally by:
  // Stage readiness (Ready to Print before Planned before Failed/Reprint) -> Project Priority -> Earliest Project Deadline -> Plate Number
  // Cancelled and Archived plates are strictly excluded from active machine scheduling.
  const queuedJobs = relevantJobs
    .filter(
      (j) =>
        !j.archived &&
        j.stage !== 'Completed' &&
        j.stage !== 'Printing' &&
        j.stage !== 'Cancelled'
    )
    .sort((a, b) => {
      const stageRank = (st: ProductionJob['stage']) =>
        st === 'Ready to Print' ? 0 : st === 'Planned' ? 1 : 2;
      const srDiff = stageRank(a.stage) - stageRank(b.stage);
      if (srDiff !== 0) return srDiff;

      const projA = projectMap.get(a.projectId);
      const projB = projectMap.get(b.projectId);
      const prioA = projA ? PRIORITY_WEIGHT[projA.priority] : 2;
      const prioB = projB ? PRIORITY_WEIGHT[projB.priority] : 2;
      if (prioA !== prioB) return prioA - prioB;

      const dlA = projA?.deadline
        ? getDeadlineEndOfDayMs(projA.deadline, timezone) ?? Number.MAX_SAFE_INTEGER
        : Number.MAX_SAFE_INTEGER;
      const dlB = projB?.deadline
        ? getDeadlineEndOfDayMs(projB.deadline, timezone) ?? Number.MAX_SAFE_INTEGER
        : Number.MAX_SAFE_INTEGER;
      if (dlA !== dlB) return dlA - dlB;

      return a.plateNumber - b.plateNumber;
    });

  // Step 3: Schedule each queued job without overlap
  for (const job of queuedJobs) {
    const proj = projectMap.get(job.projectId);
    const deadlineMs = proj?.deadline
      ? getDeadlineEndOfDayMs(proj.deadline, timezone)
      : null;

    let chosenMachine: PrinterMachine | null = null;
    let isVirtual = false;

    if (job.machineId) {
      const explicitMachine = workspace.machines.find((m) => m.id === job.machineId) || null;
      if (explicitMachine && machineCursorMs.get(explicitMachine.id) !== null) {
        chosenMachine = explicitMachine;
        isVirtual = false;
      }
    }

    // If unassigned (or assigned machine is offline/indefinite maintenance), pick earliest-completing available printer
    if (!chosenMachine) {
      let bestFinishMs = Number.MAX_SAFE_INTEGER;
      for (const candidate of workspace.machines) {
        const cursor = machineCursorMs.get(candidate.id);
        if (cursor === null || cursor === undefined) continue;
        const setupMins = candidate.setupBufferMinutes || 0;
        const effMins = getEffectivePrintMinutes(job, candidate);
        const candidateFinish = cursor + (setupMins + effMins) * 60_000;
        if (candidateFinish < bestFinishMs) {
          bestFinishMs = candidateFinish;
          chosenMachine = candidate;
          isVirtual = true;
        }
      }
    }

    if (!chosenMachine) {
      // No schedulable machines online right now
      const effMins = getEffectivePrintMinutes(job, null);
      slotsByJobId[job.id] = {
        job,
        project: proj,
        colorName: colorMap.get(job.colorId) || 'Color',
        assignedMachineId: job.machineId,
        assignedMachineName: 'No Online Printer',
        isVirtualAssignment: true,
        isActivePrinting: false,
        isPaused: false,
        countdownStatus: 'inactive',
        needsEtaRecalibration: false,
        isAwaitingConfirmation: false,
        effectivePrintMinutes: effMins,
        setupAndBufferMinutes: turnaroundBuffer,
        startMs: null,
        endMs: null,
        remainingMsLive: effMins * 60_000,
        remainingSecondsLive: effMins * 60,
        exceedsProjectDeadline: false,
      };
      continue;
    }

    const cursor = machineCursorMs.get(chosenMachine.id) ?? nowMs;
    const machineSetupMins = chosenMachine.setupBufferMinutes || 0;
    const effMins = getEffectivePrintMinutes(job, chosenMachine);

    const startMs = cursor + machineSetupMins * 60_000;
    const endMs = startMs + effMins * 60_000;

    // Advance machine cursor by endMs + turnaroundBuffer (plate removal, cleaning & restart)
    machineCursorMs.set(chosenMachine.id, endMs + turnaroundBuffer * 60_000);
    machineUtilMinutes.set(
      chosenMachine.id,
      (machineUtilMinutes.get(chosenMachine.id) || 0) + effMins + machineSetupMins
    );

    const slot: ScheduledJobSlot = {
      job,
      project: proj,
      colorName: colorMap.get(job.colorId) || 'Color',
      assignedMachineId: chosenMachine.id,
      assignedMachineName: chosenMachine.name,
      isVirtualAssignment: isVirtual,
      isActivePrinting: false,
      isPaused: false,
      countdownStatus: 'inactive',
      needsEtaRecalibration: false,
      isAwaitingConfirmation: false,
      effectivePrintMinutes: effMins,
      setupAndBufferMinutes: machineSetupMins + turnaroundBuffer,
      startMs,
      endMs,
      remainingMsLive: effMins * 60_000,
      remainingSecondsLive: effMins * 60,
      exceedsProjectDeadline: Boolean(deadlineMs && endMs > deadlineMs),
    };

    slotsByJobId[job.id] = slot;
    machineQueuedSlots.get(chosenMachine.id)?.push(slot);
  }

  // Step 4: Build Machine Schedule Summaries & Find Next Available Machine
  const machineSchedules: MachineScheduleSummary[] = workspace.machines.map((m) => {
    const activeSlot = machineActiveSlot.get(m.id) || null;
    const queuedSlots = machineQueuedSlots.get(m.id) || [];
    const cursor = machineCursorMs.get(m.id);

    // Next immediate opening to accept a brand-new urgent job (either now if Idle, or right after active print + turnaround, or maintenance end)
    let immediateOpeningMs: number | null = null;
    if (m.status === 'Offline') {
      immediateOpeningMs = null;
    } else if (m.status === 'Maintenance') {
      immediateOpeningMs =
        typeof m.maintenanceUntilMs === 'number' && m.maintenanceUntilMs > nowMs
          ? m.maintenanceUntilMs
          : null;
    } else if (activeSlot) {
      const occupancyEndMs = activeSlot.needsEtaRecalibration
        ? nowMs + activeSlot.effectivePrintMinutes * 60_000
        : activeSlot.endMs !== null
        ? Math.max(nowMs, activeSlot.endMs)
        : nowMs;
      immediateOpeningMs = occupancyEndMs + turnaroundBuffer * 60_000;
    } else {
      immediateOpeningMs = nowMs;
    }

    return {
      machine: m,
      isAvailableForScheduling: cursor !== null && cursor !== undefined,
      activeSlot,
      queuedSlots,
      nextFreeAtMs: immediateOpeningMs,
      utilizationMinutesScheduled: machineUtilMinutes.get(m.id) || 0,
    };
  });

  let nextAvailableMachine: GlobalScheduleResult['nextAvailableMachine'] = null;
  for (const ms of machineSchedules) {
    if (ms.nextFreeAtMs === null) continue;
    if (!nextAvailableMachine || ms.nextFreeAtMs < nextAvailableMachine.freeAtMs) {
      nextAvailableMachine = {
        machine: ms.machine,
        freeAtMs: ms.nextFreeAtMs,
        waitSeconds: Math.max(0, Math.round((ms.nextFreeAtMs - nowMs) / 1000)),
      };
    }
  }

  // Step 5: Compute Project ETAs from the FINAL outstanding job (max endMs across parallel printers, never summing parallel durations!)
  const projectEtas: ProjectEtaSummary[] = workspace.projects
    .filter((p) => p.status !== 'Archived')
    .map((proj) => {
      const pJobs = workspace.jobs.filter((j) => j.projectId === proj.id);
      // Completed plates remain counted even when archived to preserve production history & progress
      const completed = pJobs.filter((j) => j.stage === 'Completed');
      const active = pJobs.filter((j) => !j.archived && j.stage === 'Printing');
      const outstanding = pJobs.filter(
        (j) => !j.archived && j.stage !== 'Completed' && j.stage !== 'Cancelled'
      );
      const cancelled = pJobs.filter((j) => j.stage === 'Cancelled');

      let maxEndMs: number | null = null;
      let unschedulable = 0;

      for (const oj of outstanding) {
        const slot = slotsByJobId[oj.id];
        if (slot && slot.endMs !== null) {
          if (maxEndMs === null || slot.endMs > maxEndMs) {
            maxEndMs = slot.endMs;
          }
        } else {
          unschedulable += 1;
        }
      }

      const deadlineMs = proj.deadline
        ? getDeadlineEndOfDayMs(proj.deadline, timezone)
        : null;

      const isExceeded = Boolean(
        deadlineMs !== null && maxEndMs !== null && maxEndMs > deadlineMs
      );

      const slackMinutes =
        deadlineMs !== null && maxEndMs !== null
          ? Math.round((deadlineMs - maxEndMs) / 60_000)
          : null;

      return {
        project: proj,
        totalPlates: completed.length + outstanding.length,
        completedPlates: completed.length,
        activePrintingPlates: active.length,
        outstandingPlates: outstanding.length,
        cancelledPlates: cancelled.length,
        estimatedCompletionMs: maxEndMs,
        deadlineEndOfDayMs: deadlineMs,
        isDeadlineExceeded: isExceeded,
        slackMinutes,
        unschedulablePlatesCount: unschedulable,
      };
    });

  const deadlineWarningsCount = projectEtas.filter((pe) => pe.isDeadlineExceeded).length;

  return {
    nowMs,
    turnaroundBufferMinutes: turnaroundBuffer,
    timezone,
    slotsByJobId,
    machineSchedules,
    projectEtas,
    nextAvailableMachine,
    activePrintingSlots,
    deadlineWarningsCount,
  };
}
