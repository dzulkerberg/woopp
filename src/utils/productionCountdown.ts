import {
  ActiveCountdownStatus,
  EtaRecalibrationInput,
  PrinterMachine,
  ProductionJob,
} from '../types';

export const ETA_REACHED_LABEL = 'ETA Reached — Awaiting Confirmation';
export const ETA_NEEDS_RECALIBRATION_LABEL = 'ETA needs recalibration';

export interface JobCountdownSnapshot {
  status: ActiveCountdownStatus;
  remainingMs: number;
  remainingSeconds: number;
  actualStartedAtMs: number | null;
  estimatedDurationMs: number;
  estimatedFinishAtMs: number | null;
  pausedAtMs: number | null;
  remainingAtPauseMs: number | null;
  actualCompletedAtMs: number | null;
  isPaused: boolean;
  isAwaitingConfirmation: boolean;
  needsEtaRecalibration: boolean;
}

/**
 * Parses a Firestore-persisted timestamp value (UTC ISO-8601 string, Firestore Timestamp,
 * native Date, or UTC epoch milliseconds) into UTC epoch milliseconds.
 * Never invents a timestamp when absent or invalid.
 */
export function parseUtcTimestampMs(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
  }

  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : null;
  }

  if (typeof value === 'object') {
    const candidate = value as {
      toMillis?: () => number;
      seconds?: number;
      nanoseconds?: number;
    };
    if (typeof candidate.toMillis === 'function') {
      const ms = candidate.toMillis();
      return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : null;
    }
    if (typeof candidate.seconds === 'number' && Number.isFinite(candidate.seconds)) {
      const nanos =
        typeof candidate.nanoseconds === 'number' && Number.isFinite(candidate.nanoseconds)
          ? candidate.nanoseconds
          : 0;
      const ms = candidate.seconds * 1000 + Math.round(nanos / 1_000_000);
      return ms > 0 ? ms : null;
    }
  }

  return null;
}

/**
 * Formats UTC epoch milliseconds into a canonical Firestore-compatible ISO-8601 UTC timestamp.
 */
export function toUtcTimestampIso(epochMs: number | null | undefined): string | null {
  if (epochMs === null || epochMs === undefined || !Number.isFinite(epochMs) || epochMs <= 0) {
    return null;
  }
  return new Date(Math.round(epochMs)).toISOString();
}

/**
 * Computes effective print duration in milliseconds for a job on an optional printer,
 * honoring printer-specific overrides and speed multipliers.
 */
export function computeEffectiveDurationMs(
  job: Pick<ProductionJob, 'estimatedMinutes' | 'machineId' | 'machineDurationOverrides'>,
  machine?: PrinterMachine | null
): number {
  const baseMins = Math.max(1, Math.round(job.estimatedMinutes || 195));
  if (!machine) {
    return baseMins * 60_000;
  }
  const override = job.machineDurationOverrides?.[machine.id];
  if (typeof override === 'number' && override > 0) {
    return Math.max(1, Math.round(override)) * 60_000;
  }
  const factor =
    typeof machine.speedFactor === 'number' && machine.speedFactor > 0
      ? machine.speedFactor
      : 1;
  return Math.max(1, Math.round(baseMins * factor)) * 60_000;
}

/**
 * Resolves the authoritative UTC millisecond timestamps and durations stored on a job,
 * bridging both canonical ISO fields (`actualStartedAt`, `estimatedFinishAt`, `pausedAt`,
 * `remainingAtPauseMs`, `actualCompletedAt`, `estimatedDurationMs`) and legacy companion fields.
 */
export function resolveJobTimingFields(
  job: ProductionJob,
  machine?: PrinterMachine | null
): {
  actualStartedAtMs: number | null;
  estimatedDurationMs: number;
  estimatedFinishAtMs: number | null;
  pausedAtMs: number | null;
  remainingAtPauseMs: number | null;
  actualCompletedAtMs: number | null;
  isPaused: boolean;
  needsEtaRecalibration: boolean;
} {
  const actualStartedAtMs =
    parseUtcTimestampMs(job.actualStartedAt) ??
    parseUtcTimestampMs(job.startedAtMs);

  const pausedAtMs =
    parseUtcTimestampMs(job.pausedAt) ??
    parseUtcTimestampMs(job.pausedAtMs);

  const isPaused =
    job.stage === 'Printing' &&
    (Boolean(job.isPaused) || pausedAtMs !== null);

  let remainingAtPauseMs: number | null = null;
  if (
    typeof job.remainingAtPauseMs === 'number' &&
    Number.isFinite(job.remainingAtPauseMs) &&
    job.remainingAtPauseMs >= 0
  ) {
    remainingAtPauseMs = Math.round(job.remainingAtPauseMs);
  } else if (
    typeof job.remainingSecondsAtPause === 'number' &&
    Number.isFinite(job.remainingSecondsAtPause) &&
    job.remainingSecondsAtPause >= 0
  ) {
    remainingAtPauseMs = Math.round(job.remainingSecondsAtPause * 1000);
  }

  const explicitFinishAtMs = isPaused
    ? null
    : parseUtcTimestampMs(job.estimatedFinishAt) ??
      parseUtcTimestampMs(job.estimatedFinishAtMs);

  const actualCompletedAtMs =
    parseUtcTimestampMs(job.actualCompletedAt) ??
    parseUtcTimestampMs(job.actualCompletedAtMs) ??
    parseUtcTimestampMs(job.completedIso);

  const fallbackDurationMs = computeEffectiveDurationMs(job, machine);
  let estimatedDurationMs = fallbackDurationMs;
  if (
    typeof job.estimatedDurationMs === 'number' &&
    Number.isFinite(job.estimatedDurationMs) &&
    job.estimatedDurationMs > 0
  ) {
    estimatedDurationMs = Math.round(job.estimatedDurationMs);
  } else if (
    actualStartedAtMs !== null &&
    explicitFinishAtMs !== null &&
    explicitFinishAtMs > actualStartedAtMs &&
    !job.accumulatedElapsedSeconds
  ) {
    estimatedDurationMs = explicitFinishAtMs - actualStartedAtMs;
  }

  // If a legacy active job persisted a real start timestamp + duration (and no unrecorded pause gap),
  // derive estimatedFinishAtMs deterministically without inventing any historical start time.
  const estimatedFinishAtMs = isPaused
    ? null
    : explicitFinishAtMs ??
      (!job.needsEtaRecalibration &&
      actualStartedAtMs !== null &&
      !(job.accumulatedElapsedSeconds && job.accumulatedElapsedSeconds > 0)
        ? actualStartedAtMs + estimatedDurationMs
        : null);

  let needsEtaRecalibration = false;
  if (job.stage === 'Printing' && !job.archived) {
    if (job.needsEtaRecalibration === true) {
      needsEtaRecalibration = true;
    } else if (isPaused) {
      needsEtaRecalibration = remainingAtPauseMs === null;
    } else {
      needsEtaRecalibration = estimatedFinishAtMs === null;
    }
  }

  return {
    actualStartedAtMs,
    estimatedDurationMs,
    estimatedFinishAtMs,
    pausedAtMs,
    remainingAtPauseMs,
    actualCompletedAtMs,
    isPaused,
    needsEtaRecalibration,
  };
}

/**
 * Pure, wall-clock UTC countdown evaluator.
 * - Active running job: `remainingMs = Math.max(0, estimatedFinishAtMs - currentWallClockMs)`
 * - Paused job: `remainingMs = Math.max(0, remainingAtPauseMs)`
 * - Reached zero while Printing: status `'awaiting_confirmation'` (never auto-completes)
 * - Missing/insufficient timestamps while Printing: status `'needs_recalibration'` (never invents start times)
 */
export function computeJobCountdownSnapshot(
  job: ProductionJob,
  currentWallClockMs: number,
  machine?: PrinterMachine | null
): JobCountdownSnapshot {
  const resolved = resolveJobTimingFields(job, machine);

  if (job.stage !== 'Printing' || job.archived) {
    const inactiveRemMs =
      job.stage === 'Completed' || job.stage === 'Cancelled'
        ? 0
        : computeEffectiveDurationMs(job, machine);
    return {
      status: 'inactive',
      remainingMs: inactiveRemMs,
      remainingSeconds: inactiveRemMs > 0 ? Math.ceil(inactiveRemMs / 1000) : 0,
      actualStartedAtMs: resolved.actualStartedAtMs,
      estimatedDurationMs: resolved.estimatedDurationMs,
      estimatedFinishAtMs: resolved.estimatedFinishAtMs,
      pausedAtMs: resolved.pausedAtMs,
      remainingAtPauseMs: resolved.remainingAtPauseMs,
      actualCompletedAtMs: resolved.actualCompletedAtMs,
      isPaused: false,
      isAwaitingConfirmation: false,
      needsEtaRecalibration: false,
    };
  }

  if (resolved.needsEtaRecalibration) {
    return {
      status: 'needs_recalibration',
      remainingMs: 0,
      remainingSeconds: 0,
      actualStartedAtMs: resolved.actualStartedAtMs,
      estimatedDurationMs: resolved.estimatedDurationMs,
      estimatedFinishAtMs: null,
      pausedAtMs: resolved.pausedAtMs,
      remainingAtPauseMs: resolved.remainingAtPauseMs,
      actualCompletedAtMs: resolved.actualCompletedAtMs,
      isPaused: resolved.isPaused,
      isAwaitingConfirmation: false,
      needsEtaRecalibration: true,
    };
  }

  if (resolved.isPaused) {
    const frozenMs = Math.max(0, resolved.remainingAtPauseMs ?? 0);
    return {
      status: 'paused',
      remainingMs: frozenMs,
      remainingSeconds: frozenMs > 0 ? Math.ceil(frozenMs / 1000) : 0,
      actualStartedAtMs: resolved.actualStartedAtMs,
      estimatedDurationMs: resolved.estimatedDurationMs,
      estimatedFinishAtMs: null,
      pausedAtMs: resolved.pausedAtMs,
      remainingAtPauseMs: frozenMs,
      actualCompletedAtMs: resolved.actualCompletedAtMs,
      isPaused: true,
      isAwaitingConfirmation: false,
      needsEtaRecalibration: false,
    };
  }

  // Authoritative timestamp-based countdown formula:
  // remainingMs = Math.max(0, estimatedFinishAt - currentWallClockTime)
  const finishMs = resolved.estimatedFinishAtMs!;
  const remainingMs = Math.max(0, finishMs - currentWallClockMs);
  const isAwaitingConfirmation = remainingMs === 0;

  return {
    status: isAwaitingConfirmation ? 'awaiting_confirmation' : 'running',
    remainingMs,
    remainingSeconds: remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0,
    actualStartedAtMs: resolved.actualStartedAtMs,
    estimatedDurationMs: resolved.estimatedDurationMs,
    estimatedFinishAtMs: finishMs,
    pausedAtMs: null,
    remainingAtPauseMs: null,
    actualCompletedAtMs: resolved.actualCompletedAtMs,
    isPaused: false,
    isAwaitingConfirmation,
    needsEtaRecalibration: false,
  };
}

/**
 * Hydrates a persisted ProductionJob loaded from Firestore or a backup without
 * resetting active timestamps or inventing historical start times for legacy jobs.
 */
export function hydrateJobCountdownFields(job: ProductionJob): ProductionJob {
  const hasAnyTimingData =
    job.stage === 'Printing' ||
    job.actualStartedAt !== undefined ||
    job.estimatedDurationMs !== undefined ||
    job.estimatedFinishAt !== undefined ||
    job.pausedAt !== undefined ||
    job.remainingAtPauseMs !== undefined ||
    job.actualCompletedAt !== undefined ||
    job.startedAtMs !== undefined ||
    job.estimatedFinishAtMs !== undefined ||
    job.pausedAtMs !== undefined ||
    job.remainingSecondsAtPause !== undefined ||
    job.actualCompletedAtMs !== undefined ||
    job.needsEtaRecalibration !== undefined;

  if (!hasAnyTimingData) {
    return job;
  }

  const resolved = resolveJobTimingFields(job, null);
  const hydrated: ProductionJob = { ...job };

  // Never keep legacy pendingServer*Sync flags that could overwrite persisted timestamps on reload
  delete hydrated.pendingServerStartSync;
  delete hydrated.pendingServerCompleteSync;

  if (job.stage === 'Printing' && !job.archived) {
    hydrated.actualStartedAt = toUtcTimestampIso(resolved.actualStartedAtMs);
    hydrated.startedAtMs = resolved.actualStartedAtMs;
    hydrated.estimatedDurationMs = resolved.estimatedDurationMs;
    hydrated.isPaused = resolved.isPaused;
    hydrated.pausedAt = resolved.isPaused ? toUtcTimestampIso(resolved.pausedAtMs) : null;
    hydrated.pausedAtMs = resolved.isPaused ? resolved.pausedAtMs : null;
    hydrated.remainingAtPauseMs = resolved.isPaused ? resolved.remainingAtPauseMs : null;
    hydrated.remainingSecondsAtPause =
      resolved.isPaused && resolved.remainingAtPauseMs !== null
        ? Math.ceil(resolved.remainingAtPauseMs / 1000)
        : null;
    hydrated.estimatedFinishAt = resolved.isPaused
      ? null
      : toUtcTimestampIso(resolved.estimatedFinishAtMs);
    hydrated.estimatedFinishAtMs = resolved.isPaused ? null : resolved.estimatedFinishAtMs;
    hydrated.actualCompletedAt = null;
    hydrated.actualCompletedAtMs = null;

    if (resolved.needsEtaRecalibration) {
      hydrated.needsEtaRecalibration = true;
    } else {
      delete hydrated.needsEtaRecalibration;
    }
    return hydrated;
  }

  // Non-printing stages that carry historical or explicit null timing fields
  if (job.actualStartedAt !== undefined || job.startedAtMs !== undefined) {
    hydrated.actualStartedAt = toUtcTimestampIso(resolved.actualStartedAtMs);
    hydrated.startedAtMs = resolved.actualStartedAtMs;
  }
  if (job.estimatedDurationMs !== undefined) {
    hydrated.estimatedDurationMs =
      job.estimatedDurationMs === null ? null : resolved.estimatedDurationMs;
  }
  if (job.estimatedFinishAt !== undefined || job.estimatedFinishAtMs !== undefined) {
    hydrated.estimatedFinishAt =
      job.stage === 'Completed' || job.stage === 'Cancelled'
        ? null
        : toUtcTimestampIso(resolved.estimatedFinishAtMs);
    hydrated.estimatedFinishAtMs =
      job.stage === 'Completed' || job.stage === 'Cancelled'
        ? null
        : resolved.estimatedFinishAtMs;
  }
  if (job.pausedAt !== undefined || job.pausedAtMs !== undefined) {
    hydrated.pausedAt = null;
    hydrated.pausedAtMs = null;
  }
  if (job.remainingAtPauseMs !== undefined || job.remainingSecondsAtPause !== undefined) {
    hydrated.remainingAtPauseMs =
      job.stage === 'Completed' && job.remainingAtPauseMs === 0 ? 0 : null;
    hydrated.remainingSecondsAtPause =
      job.stage === 'Completed' && job.remainingSecondsAtPause === 0 ? 0 : null;
  }
  if (
    job.stage === 'Completed' ||
    job.actualCompletedAt !== undefined ||
    job.actualCompletedAtMs !== undefined
  ) {
    hydrated.actualCompletedAt = toUtcTimestampIso(resolved.actualCompletedAtMs);
    hydrated.actualCompletedAtMs = resolved.actualCompletedAtMs;
  }
  delete hydrated.needsEtaRecalibration;

  return hydrated;
}

/**
 * Produces timestamp fields when a job newly enters `Printing`.
 */
export function buildStartedPrintingTiming(
  estimatedDurationMs: number,
  nowMs: number
): Partial<ProductionJob> {
  const safeNowMs = Math.round(nowMs);
  const safeDurMs = Math.max(60_000, Math.round(estimatedDurationMs));
  const finishMs = safeNowMs + safeDurMs;

  return {
    actualStartedAt: toUtcTimestampIso(safeNowMs),
    startedAtMs: safeNowMs,
    runResumedAtMs: safeNowMs,
    estimatedDurationMs: safeDurMs,
    estimatedFinishAt: toUtcTimestampIso(finishMs),
    estimatedFinishAtMs: finishMs,
    isPaused: false,
    pausedAt: null,
    pausedAtMs: null,
    remainingAtPauseMs: null,
    remainingSecondsAtPause: null,
    accumulatedElapsedSeconds: 0,
    actualCompletedAt: null,
    actualCompletedAtMs: null,
  };
}

/**
 * Produces timestamp fields when pausing an active `Printing` job.
 * Freezes remaining duration at `nowMs` and clears `estimatedFinishAt`.
 */
export function buildPausedPrintingTiming(
  job: ProductionJob,
  nowMs: number,
  overrideRemainingMs?: number,
  machine?: PrinterMachine | null
): { timing: Partial<ProductionJob>; remainingAtPauseMs: number } {
  const safeNowMs = Math.round(nowMs);
  const snap = computeJobCountdownSnapshot(job, safeNowMs, machine);

  const capturedRemainingMs =
    overrideRemainingMs !== undefined
      ? Math.max(0, Math.round(overrideRemainingMs))
      : snap.needsEtaRecalibration
      ? computeEffectiveDurationMs(job, machine)
      : snap.remainingMs;

  const anchorMs = job.runResumedAtMs ?? snap.actualStartedAtMs;
  const addElapsedSecs =
    !snap.isPaused && anchorMs !== null && safeNowMs > anchorMs
      ? Math.max(0, Math.floor((safeNowMs - anchorMs) / 1000))
      : 0;

  return {
    remainingAtPauseMs: capturedRemainingMs,
    timing: {
      actualStartedAt: toUtcTimestampIso(snap.actualStartedAtMs),
      startedAtMs: snap.actualStartedAtMs,
      estimatedDurationMs: snap.estimatedDurationMs,
      isPaused: true,
      pausedAt: toUtcTimestampIso(safeNowMs),
      pausedAtMs: safeNowMs,
      remainingAtPauseMs: capturedRemainingMs,
      remainingSecondsAtPause: Math.ceil(capturedRemainingMs / 1000),
      estimatedFinishAt: null,
      estimatedFinishAtMs: null,
      actualCompletedAt: null,
      actualCompletedAtMs: null,
      accumulatedElapsedSeconds: (job.accumulatedElapsedSeconds || 0) + addElapsedSecs,
    },
  };
}

/**
 * Produces timestamp fields when resuming a paused `Printing` job.
 * Calculates new `estimatedFinishAt` from `nowMs + remainingAtPauseMs` so paused duration
 * is never counted as active printing time, while preserving `actualStartedAt`.
 */
export function buildResumedPrintingTiming(
  job: ProductionJob,
  nowMs: number,
  overrideRemainingMs?: number,
  machine?: PrinterMachine | null
): { timing: Partial<ProductionJob>; resumedRemainingMs: number } {
  const safeNowMs = Math.round(nowMs);
  const resolved = resolveJobTimingFields(job, machine);

  const resumedRemainingMs =
    overrideRemainingMs !== undefined
      ? Math.max(0, Math.round(overrideRemainingMs))
      : resolved.remainingAtPauseMs !== null
      ? Math.max(0, resolved.remainingAtPauseMs)
      : computeJobCountdownSnapshot(job, safeNowMs, machine).remainingMs;

  const nextFinishMs = safeNowMs + resumedRemainingMs;

  return {
    resumedRemainingMs,
    timing: {
      actualStartedAt: toUtcTimestampIso(resolved.actualStartedAtMs),
      startedAtMs: resolved.actualStartedAtMs,
      runResumedAtMs: safeNowMs,
      estimatedDurationMs: Math.max(resolved.estimatedDurationMs, resumedRemainingMs),
      estimatedFinishAt: toUtcTimestampIso(nextFinishMs),
      estimatedFinishAtMs: nextFinishMs,
      isPaused: false,
      pausedAt: null,
      pausedAtMs: null,
      remainingAtPauseMs: null,
      remainingSecondsAtPause: null,
      actualCompletedAt: null,
      actualCompletedAtMs: null,
    },
  };
}

/**
 * Recalibrates an active `Printing` job using either an explicit remaining duration
 * or the operator-supplied actual UTC start time. Never invents historical start times.
 */
export function buildRecalibratedPrintingTiming(
  job: ProductionJob,
  input: EtaRecalibrationInput,
  nowMs: number,
  machine?: PrinterMachine | null
): { timing: Partial<ProductionJob>; error?: string } {
  const safeNowMs = Math.round(nowMs);
  const resolved = resolveJobTimingFields(job, machine);
  const baseEffDurationMs = computeEffectiveDurationMs(job, machine);

  if (input.mode === 'remaining_duration') {
    if (!Number.isFinite(input.remainingMinutes) || input.remainingMinutes < 0) {
      return { timing: {}, error: 'Enter a valid non-negative remaining duration.' };
    }
    const nextRemMs = Math.round(input.remainingMinutes * 60_000);
    const nextEstDurationMs = Math.max(
      resolved.estimatedDurationMs || baseEffDurationMs,
      nextRemMs
    );

    if (resolved.isPaused) {
      const pauseStamp = resolved.pausedAtMs ?? safeNowMs;
      return {
        timing: {
          // Preserve existing actualStartedAt if known; never invent a historical start time
          actualStartedAt: toUtcTimestampIso(resolved.actualStartedAtMs),
          startedAtMs: resolved.actualStartedAtMs,
          estimatedDurationMs: nextEstDurationMs,
          isPaused: true,
          pausedAt: toUtcTimestampIso(pauseStamp),
          pausedAtMs: pauseStamp,
          remainingAtPauseMs: nextRemMs,
          remainingSecondsAtPause: Math.ceil(nextRemMs / 1000),
          estimatedFinishAt: null,
          estimatedFinishAtMs: null,
          actualCompletedAt: null,
          actualCompletedAtMs: null,
        },
      };
    }

    const nextFinishMs = safeNowMs + nextRemMs;
    return {
      timing: {
        // Preserve existing actualStartedAt if known; never invent a historical start time
        actualStartedAt: toUtcTimestampIso(resolved.actualStartedAtMs),
        startedAtMs: resolved.actualStartedAtMs,
        runResumedAtMs: safeNowMs,
        estimatedDurationMs: nextEstDurationMs,
        estimatedFinishAt: toUtcTimestampIso(nextFinishMs),
        estimatedFinishAtMs: nextFinishMs,
        isPaused: false,
        pausedAt: null,
        pausedAtMs: null,
        remainingAtPauseMs: null,
        remainingSecondsAtPause: null,
        actualCompletedAt: null,
        actualCompletedAtMs: null,
      },
    };
  }

  // Mode: actual_start_time
  const startMs = Math.round(input.actualStartedAtMs);
  if (!Number.isFinite(startMs) || startMs <= 0) {
    return { timing: {}, error: 'Enter a valid actual start date and time.' };
  }
  if (startMs > safeNowMs + 60_000) {
    return {
      timing: {},
      error: 'Actual start time cannot be in the future.',
    };
  }

  const durationMs = baseEffDurationMs;
  const finishMs = startMs + durationMs;

  if (resolved.isPaused) {
    const pauseRefMs =
      resolved.pausedAtMs !== null && resolved.pausedAtMs >= startMs
        ? resolved.pausedAtMs
        : safeNowMs;
    const remAtPauseMs = Math.max(0, finishMs - pauseRefMs);
    return {
      timing: {
        actualStartedAt: toUtcTimestampIso(startMs),
        startedAtMs: startMs,
        runResumedAtMs: startMs,
        estimatedDurationMs: durationMs,
        isPaused: true,
        pausedAt: toUtcTimestampIso(pauseRefMs),
        pausedAtMs: pauseRefMs,
        remainingAtPauseMs: remAtPauseMs,
        remainingSecondsAtPause: Math.ceil(remAtPauseMs / 1000),
        estimatedFinishAt: null,
        estimatedFinishAtMs: null,
        actualCompletedAt: null,
        actualCompletedAtMs: null,
        accumulatedElapsedSeconds: Math.max(0, Math.floor((pauseRefMs - startMs) / 1000)),
      },
    };
  }

  return {
    timing: {
      actualStartedAt: toUtcTimestampIso(startMs),
      startedAtMs: startMs,
      runResumedAtMs: startMs,
      estimatedDurationMs: durationMs,
      estimatedFinishAt: toUtcTimestampIso(finishMs),
      estimatedFinishAtMs: finishMs,
      isPaused: false,
      pausedAt: null,
      pausedAtMs: null,
      remainingAtPauseMs: null,
      remainingSecondsAtPause: null,
      actualCompletedAt: null,
      actualCompletedAtMs: null,
      accumulatedElapsedSeconds: 0,
    },
  };
}
