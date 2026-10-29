import {
  Bytes,
  DocumentReference,
  FieldValue,
  GeoPoint,
  Timestamp,
} from 'firebase/firestore';
import {
  CHARM_IDS,
  KANBAN_STAGES,
  MACHINE_STATUSES,
  PLATE_GENERATION_MODES,
  PRIORITIES,
  SALES_CHANNELS,
} from '../constants';
import {
  ActivityLogEntry,
  AlphabetPreset,
  CharmId,
  CharmsMap,
  ColorOption,
  InventoryMovement,
  InventoryState,
  KanbanStage,
  LedgerMovementType,
  LettersMap,
  MachineStatus,
  PlateGenerationMode,
  PrinterMachine,
  ProductionJob,
  ProductionProject,
  ProductionWorkspaceV5,
  ProjectPriority,
  ProjectStatus,
  SalesChannel,
  WorkspaceSettings,
} from '../types';

const PROJECT_STATUSES: readonly ProjectStatus[] = ['Active', 'Completed', 'Archived'];
const LOG_CATEGORIES: readonly ActivityLogEntry['category'][] = [
  'project',
  'plate',
  'machine',
  'inventory',
  'system',
];
const LEDGER_MOVEMENT_TYPES: readonly LedgerMovementType[] = [
  'PRINT_COMPLETE',
  'PRINT_REVERSAL',
  'MIGRATION_IMPORT',
  'MANUAL_ADJUSTMENT',
  'WASTAGE_REJECT',
  'PROJECT_ALLOCATION',
];

export class FirestorePayloadValidationError extends Error {
  public readonly fieldPath: string;

  constructor(fieldPath: string, detail: string) {
    super(`Invalid Firestore field at "${fieldPath}": ${detail}`);
    this.name = 'FirestorePayloadValidationError';
    this.fieldPath = fieldPath;
  }
}

/**
 * Checks whether a value is a valid Firebase/Firestore special value or native Date
 * that must be preserved verbatim (never flattened, stripped, or JSON-serialized).
 */
export function isFirestoreSpecialValue(value: unknown): boolean {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  if (value instanceof Date) {
    return true;
  }

  if (
    value instanceof Timestamp ||
    value instanceof FieldValue ||
    value instanceof GeoPoint ||
    value instanceof Bytes ||
    value instanceof DocumentReference
  ) {
    return true;
  }

  // Structural checks for cross-bundle / SDK sentinel & Timestamp objects
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.seconds === 'number' &&
    typeof candidate.nanoseconds === 'number' &&
    typeof candidate.toMillis === 'function' &&
    typeof candidate.toDate === 'function'
  ) {
    return true;
  }

  if (typeof candidate._methodName === 'string') {
    return true;
  }

  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  if (Array.isArray(value) || isFirestoreSpecialValue(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function joinPath(base: string, key: string): string {
  return base ? `${base}.${key}` : key;
}

/**
 * Recursively inspects an arbitrary payload and returns the exact property/index paths
 * of every `undefined` value found, without mutating the input or descending into
 * Firebase Timestamp, Date, or FieldValue instances.
 */
export function findUndefinedPaths(value: unknown, currentPath = ''): string[] {
  if (value === undefined) {
    return [currentPath || '<root>'];
  }

  if (value === null || typeof value !== 'object' || isFirestoreSpecialValue(value)) {
    return [];
  }

  const paths: string[] = [];

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const itemPath = `${currentPath}[${i}]`;
      if (value[i] === undefined) {
        paths.push(itemPath);
      } else {
        paths.push(...findUndefinedPaths(value[i], itemPath));
      }
    }
    return paths;
  }

  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      const propPath = joinPath(currentPath, key);
      const propVal = value[key];
      if (propVal === undefined) {
        paths.push(propPath);
      } else {
        paths.push(...findUndefinedPaths(propVal, propPath));
      }
    }
  }

  return paths;
}

/**
 * Development-only diagnostic reporter that logs the exact property path(s)
 * containing `undefined` before any Firestore save occurs.
 */
export function reportDevUndefinedDiagnostics(
  value: unknown,
  documentLabel = 'users/{uid}/tracker/v5_workspace',
  options?: {
    isDev?: boolean;
    onReport?: (paths: string[], formattedMessage: string) => void;
  }
): string[] {
  const isDev =
    options?.isDev !== undefined
      ? options.isDev
      : Boolean(typeof import.meta !== 'undefined' && import.meta.env?.DEV);

  if (!isDev) {
    return [];
  }

  const paths = findUndefinedPaths(value);
  if (paths.length > 0) {
    const formatted = `[WOOPP Firestore Diagnostics] Detected ${paths.length} undefined field value(s) before saving "${documentLabel}": ${paths.join(', ')}`;
    if (options?.onReport) {
      options.onReport(paths, formatted);
    } else {
      console.warn(formatted);
    }
  }
  return paths;
}

/**
 * Recursively validates and constructs a Firestore-compatible value without using
 * JSON.stringify/JSON.parse:
 * - Preserves valid `Timestamp`, `Date`, `FieldValue` (`serverTimestamp()`, etc.), `GeoPoint`, `Bytes`, `DocumentReference`.
 * - Omits own properties on plain objects whose value is `undefined`.
 * - Preserves `null`, booleans, finite numbers, and strings.
 * - Throws `FirestorePayloadValidationError` on `undefined` array elements, `NaN`/`Infinity`, invalid `Date`, functions, or symbols.
 */
export function sanitizeFirestoreValue<T>(value: T, path = ''): T {
  if (value === undefined) {
    throw new FirestorePayloadValidationError(
      path || '<root>',
      'Value cannot be undefined at root or array element level.'
    );
  }

  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new FirestorePayloadValidationError(
        path || '<root>',
        `Numeric value must be finite (received ${String(value)}).`
      );
    }
    return value;
  }

  if (typeof value === 'object') {
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) {
        throw new FirestorePayloadValidationError(
          path || '<root>',
          'Invalid Date instance.'
        );
      }
      return value;
    }

    if (isFirestoreSpecialValue(value)) {
      return value;
    }

    if (Array.isArray(value)) {
      const out = value.map((item, idx) => {
        const itemPath = `${path}[${idx}]`;
        if (item === undefined) {
          throw new FirestorePayloadValidationError(
            itemPath,
            'Array elements cannot be undefined in Firestore.'
          );
        }
        return sanitizeFirestoreValue(item, itemPath);
      });
      return out as unknown as T;
    }

    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [key, propVal] of Object.entries(value)) {
        if (propVal === undefined) {
          // Omit truly absent optional properties on plain objects
          continue;
        }
        out[key] = sanitizeFirestoreValue(propVal, joinPath(path, key));
      }
      return out as T;
    }

    throw new FirestorePayloadValidationError(
      path || '<root>',
      `Unsupported custom class instance (${value.constructor?.name || 'Object'}).`
    );
  }

  throw new FirestorePayloadValidationError(
    path || '<root>',
    `Unsupported JavaScript type "${typeof value}".`
  );
}

// --- Domain-Specific Required & Optional Field Validators ---

function requireNonEmptyString(val: unknown, path: string): string {
  if (typeof val !== 'string' || val.trim().length === 0) {
    throw new FirestorePayloadValidationError(
      path,
      'Required non-empty string is missing or invalid.'
    );
  }
  return val;
}

function requireString(val: unknown, path: string): string {
  if (typeof val !== 'string') {
    throw new FirestorePayloadValidationError(
      path,
      `Expected string (received ${val === null ? 'null' : typeof val}).`
    );
  }
  return val;
}

function requireBoolean(val: unknown, path: string): boolean {
  if (typeof val !== 'boolean') {
    throw new FirestorePayloadValidationError(
      path,
      `Expected boolean (received ${val === null ? 'null' : typeof val}).`
    );
  }
  return val;
}

function requireFiniteNumber(
  val: unknown,
  path: string,
  opts?: { min?: number; max?: number }
): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new FirestorePayloadValidationError(
      path,
      `Expected finite number (received ${String(val)}).`
    );
  }
  if (opts?.min !== undefined && val < opts.min) {
    throw new FirestorePayloadValidationError(
      path,
      `Expected number >= ${opts.min} (received ${val}).`
    );
  }
  if (opts?.max !== undefined && val > opts.max) {
    throw new FirestorePayloadValidationError(
      path,
      `Expected number <= ${opts.max} (received ${val}).`
    );
  }
  return val;
}

function requireEnum<T extends string>(
  val: unknown,
  allowed: readonly T[],
  path: string
): T {
  if (typeof val !== 'string' || !allowed.includes(val as T)) {
    throw new FirestorePayloadValidationError(
      path,
      `Expected one of [${allowed.join(', ')}] (received ${String(val)}).`
    );
  }
  return val as T;
}

function normalizeNullableString(val: unknown, path: string): string | null {
  if (val === undefined || val === null || val === '') {
    return null;
  }
  if (typeof val !== 'string') {
    throw new FirestorePayloadValidationError(
      path,
      `Expected string or null (received ${typeof val}).`
    );
  }
  return val;
}

function normalizeNullableNumber(val: unknown, path: string): number | null {
  if (val === undefined || val === null) {
    return null;
  }
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new FirestorePayloadValidationError(
      path,
      `Expected finite number or null (received ${String(val)}).`
    );
  }
  return val;
}

function validateLettersMap(
  val: unknown,
  path: string,
  opts?: { allowNegative?: boolean }
): LettersMap {
  if (!isPlainObject(val)) {
    throw new FirestorePayloadValidationError(path, 'Expected letters map object.');
  }
  const out: LettersMap = {};
  for (const [k, rawQty] of Object.entries(val)) {
    if (rawQty === undefined) continue;
    const qty = requireFiniteNumber(
      rawQty,
      joinPath(path, k),
      opts?.allowNegative ? undefined : { min: 0 }
    );
    out[k] = qty;
  }
  return out;
}

function validateColorLettersMapRecord(
  val: unknown,
  path: string
): Record<string, LettersMap> {
  if (!isPlainObject(val)) {
    throw new FirestorePayloadValidationError(
      path,
      'Expected color-to-letters record object.'
    );
  }
  const out: Record<string, LettersMap> = {};
  for (const [colorId, mapVal] of Object.entries(val)) {
    if (mapVal === undefined) continue;
    out[colorId] = validateLettersMap(mapVal, joinPath(path, colorId));
  }
  return out;
}

function validateCharmsMap(val: unknown, path: string): CharmsMap {
  if (!isPlainObject(val)) {
    throw new FirestorePayloadValidationError(path, 'Expected charms map object.');
  }
  const out: CharmsMap = {};
  for (const [k, rawQty] of Object.entries(val)) {
    if (rawQty === undefined) continue;
    const charmId = requireEnum<CharmId>(k, CHARM_IDS, joinPath(path, k));
    const qty = requireFiniteNumber(rawQty, joinPath(path, charmId), { min: 0 });
    const floored = Math.floor(qty);
    if (floored > 0) {
      out[charmId] = floored;
    }
  }
  return out;
}

function validateColorCharmsMapRecord(
  val: unknown,
  path: string
): Record<string, CharmsMap> {
  if (!isPlainObject(val)) {
    throw new FirestorePayloadValidationError(
      path,
      'Expected color-to-charms record object.'
    );
  }
  const out: Record<string, CharmsMap> = {};
  for (const [colorId, mapVal] of Object.entries(val)) {
    if (mapVal === undefined) continue;
    out[requireNonEmptyString(colorId, path)] = validateCharmsMap(
      mapVal,
      joinPath(path, colorId)
    );
  }
  return out;
}

function validateColorOption(color: ColorOption, path: string): ColorOption {
  if (!isPlainObject(color)) {
    throw new FirestorePayloadValidationError(path, 'Expected color object.');
  }
  return {
    id: requireNonEmptyString(color.id, joinPath(path, 'id')),
    name: requireNonEmptyString(color.name, joinPath(path, 'name')),
    hex: requireNonEmptyString(color.hex, joinPath(path, 'hex')),
  };
}

function validatePrinterMachine(
  machine: PrinterMachine,
  path: string
): PrinterMachine {
  if (!isPlainObject(machine)) {
    throw new FirestorePayloadValidationError(path, 'Expected machine object.');
  }

  const normalized: PrinterMachine = {
    id: requireNonEmptyString(machine.id, joinPath(path, 'id')),
    name: requireNonEmptyString(machine.name, joinPath(path, 'name')),
    model: requireNonEmptyString(machine.model, joinPath(path, 'model')),
    status: requireEnum<MachineStatus>(
      machine.status,
      MACHINE_STATUSES,
      joinPath(path, 'status')
    ),
    plateCapacity: requireFiniteNumber(
      machine.plateCapacity,
      joinPath(path, 'plateCapacity'),
      { min: 1 }
    ),
    // Intentionally empty optional values default to `null`
    activeJobId: normalizeNullableString(
      machine.activeJobId,
      joinPath(path, 'activeJobId')
    ),
    totalCompletedPlates: requireFiniteNumber(
      machine.totalCompletedPlates,
      joinPath(path, 'totalCompletedPlates'),
      { min: 0 }
    ),
    totalFailedPlates: requireFiniteNumber(
      machine.totalFailedPlates,
      joinPath(path, 'totalFailedPlates'),
      { min: 0 }
    ),
    totalPrintMinutes: requireFiniteNumber(
      machine.totalPrintMinutes,
      joinPath(path, 'totalPrintMinutes'),
      { min: 0 }
    ),
    notes: requireString(machine.notes, joinPath(path, 'notes')),
    maintenanceUntilMs: normalizeNullableNumber(
      machine.maintenanceUntilMs,
      joinPath(path, 'maintenanceUntilMs')
    ),
  };

  // Truly absent optional scheduling properties are omitted; present ones are strictly validated
  if (machine.speedFactor !== undefined) {
    normalized.speedFactor = requireFiniteNumber(
      machine.speedFactor,
      joinPath(path, 'speedFactor'),
      { min: 0.01 }
    );
  }

  if (machine.setupBufferMinutes !== undefined) {
    normalized.setupBufferMinutes = requireFiniteNumber(
      machine.setupBufferMinutes,
      joinPath(path, 'setupBufferMinutes'),
      { min: 0 }
    );
  }

  return normalized;
}

function validateProductionProject(
  project: ProductionProject,
  path: string
): ProductionProject {
  if (!isPlainObject(project)) {
    throw new FirestorePayloadValidationError(path, 'Expected project object.');
  }
  if (!Array.isArray(project.assignedColorIds)) {
    throw new FirestorePayloadValidationError(
      joinPath(path, 'assignedColorIds'),
      'Expected array of assigned color IDs.'
    );
  }

  const normalized: ProductionProject = {
    id: requireNonEmptyString(project.id, joinPath(path, 'id')),
    name: requireNonEmptyString(project.name, joinPath(path, 'name')),
    salesChannel: requireEnum<SalesChannel>(
      project.salesChannel,
      SALES_CHANNELS,
      joinPath(path, 'salesChannel')
    ),
    priority: requireEnum<ProjectPriority>(
      project.priority,
      PRIORITIES,
      joinPath(path, 'priority')
    ),
    deadline: requireString(project.deadline, joinPath(path, 'deadline')),
    productType: requireNonEmptyString(
      project.productType,
      joinPath(path, 'productType')
    ),
    plateCapacity: requireFiniteNumber(
      project.plateCapacity,
      joinPath(path, 'plateCapacity'),
      { min: 1 }
    ),
    assignedColorIds: project.assignedColorIds.map((cid, idx) =>
      requireNonEmptyString(cid, `${joinPath(path, 'assignedColorIds')}[${idx}]`)
    ),
    targetQuantity: requireFiniteNumber(
      project.targetQuantity,
      joinPath(path, 'targetQuantity'),
      { min: 0 }
    ),
    targetsByColor: validateColorLettersMapRecord(
      project.targetsByColor,
      joinPath(path, 'targetsByColor')
    ),
    carryForwardByColor: validateColorLettersMapRecord(
      project.carryForwardByColor,
      joinPath(path, 'carryForwardByColor')
    ),
    allocatedStockByColor: validateColorLettersMapRecord(
      project.allocatedStockByColor,
      joinPath(path, 'allocatedStockByColor')
    ),
    status: requireEnum<ProjectStatus>(
      project.status,
      PROJECT_STATUSES,
      joinPath(path, 'status')
    ),
    notes: requireString(project.notes, joinPath(path, 'notes')),
    createdIso: requireNonEmptyString(
      project.createdIso,
      joinPath(path, 'createdIso')
    ),
    updatedIso: requireNonEmptyString(
      project.updatedIso,
      joinPath(path, 'updatedIso')
    ),
  };

  if (project.charmTargetsByColor !== undefined) {
    normalized.charmTargetsByColor = validateColorCharmsMapRecord(
      project.charmTargetsByColor,
      joinPath(path, 'charmTargetsByColor')
    );
  }

  if (project.charmCarryForwardByColor !== undefined) {
    normalized.charmCarryForwardByColor = validateColorCharmsMapRecord(
      project.charmCarryForwardByColor,
      joinPath(path, 'charmCarryForwardByColor')
    );
  }

  return normalized;
}

function validateProductionJob(job: ProductionJob, path: string): ProductionJob {
  if (!isPlainObject(job)) {
    throw new FirestorePayloadValidationError(path, 'Expected production job object.');
  }

  const normalized: ProductionJob = {
    id: requireNonEmptyString(job.id, joinPath(path, 'id')),
    projectId: requireNonEmptyString(job.projectId, joinPath(path, 'projectId')),
    colorId: requireNonEmptyString(job.colorId, joinPath(path, 'colorId')),
    plateNumber: requireFiniteNumber(
      job.plateNumber,
      joinPath(path, 'plateNumber'),
      { min: 1 }
    ),
    plateCapacity: requireFiniteNumber(
      job.plateCapacity,
      joinPath(path, 'plateCapacity'),
      { min: 1 }
    ),
    letters: validateLettersMap(job.letters, joinPath(path, 'letters')),
    stage: requireEnum<KanbanStage>(
      job.stage,
      KANBAN_STAGES,
      joinPath(path, 'stage')
    ),
    // Intentionally empty optional associations use `null`
    machineId: normalizeNullableString(job.machineId, joinPath(path, 'machineId')),
    estimatedMinutes: requireFiniteNumber(
      job.estimatedMinutes,
      joinPath(path, 'estimatedMinutes'),
      { min: 1 }
    ),
    actualMinutes: requireFiniteNumber(
      job.actualMinutes,
      joinPath(path, 'actualMinutes'),
      { min: 0 }
    ),
    slicerVerified: requireBoolean(
      job.slicerVerified,
      joinPath(path, 'slicerVerified')
    ),
    stockApplied: requireBoolean(job.stockApplied, joinPath(path, 'stockApplied')),
    stockTransactionId: normalizeNullableString(
      job.stockTransactionId,
      joinPath(path, 'stockTransactionId')
    ),
    failedCount: requireFiniteNumber(job.failedCount, joinPath(path, 'failedCount'), {
      min: 0,
    }),
    failureReason: requireString(job.failureReason, joinPath(path, 'failureReason')),
    notes: requireString(job.notes, joinPath(path, 'notes')),
    createdIso: requireNonEmptyString(job.createdIso, joinPath(path, 'createdIso')),
    updatedIso: requireNonEmptyString(job.updatedIso, joinPath(path, 'updatedIso')),
    completedIso: normalizeNullableString(
      job.completedIso,
      joinPath(path, 'completedIso')
    ),
  };

  if (job.charms !== undefined) {
    const cleanedCharms = validateCharmsMap(job.charms, joinPath(path, 'charms'));
    if (Object.keys(cleanedCharms).length > 0) {
      normalized.charms = cleanedCharms;
    }
  }

  if (job.plateMode !== undefined) {
    normalized.plateMode = requireEnum<PlateGenerationMode>(
      job.plateMode,
      PLATE_GENERATION_MODES,
      joinPath(path, 'plateMode')
    );
  }

  // Optional printer-specific duration overrides: omit if absent/empty, validate entries if present
  if (job.machineDurationOverrides !== undefined) {
    if (!isPlainObject(job.machineDurationOverrides)) {
      throw new FirestorePayloadValidationError(
        joinPath(path, 'machineDurationOverrides'),
        'Expected object mapping machineId to positive minutes.'
      );
    }
    const cleanedOverrides: Record<string, number> = {};
    for (const [mId, mins] of Object.entries(job.machineDurationOverrides)) {
      if (mins === undefined) continue;
      cleanedOverrides[requireNonEmptyString(mId, joinPath(path, 'machineDurationOverrides'))] =
        requireFiniteNumber(
          mins,
          joinPath(joinPath(path, 'machineDurationOverrides'), mId),
          { min: 1 }
        );
    }
    if (Object.keys(cleanedOverrides).length > 0) {
      normalized.machineDurationOverrides = cleanedOverrides;
    }
  }

  // Nullable scheduling timestamps: omit if truly never set (`undefined`), keep `null` or finite number if present
  const nullableTimingKeys = [
    'startedAtMs',
    'runResumedAtMs',
    'pausedAtMs',
    'remainingSecondsAtPause',
    'estimatedFinishAtMs',
    'actualCompletedAtMs',
  ] as const;

  for (const key of nullableTimingKeys) {
    const val = job[key];
    if (val !== undefined) {
      normalized[key] = normalizeNullableNumber(val, joinPath(path, key));
    }
  }

  if (job.isPaused !== undefined) {
    normalized.isPaused = requireBoolean(job.isPaused, joinPath(path, 'isPaused'));
  }

  if (job.accumulatedElapsedSeconds !== undefined) {
    normalized.accumulatedElapsedSeconds = requireFiniteNumber(
      job.accumulatedElapsedSeconds,
      joinPath(path, 'accumulatedElapsedSeconds'),
      { min: 0 }
    );
  }

  if (job.pendingServerStartSync !== undefined) {
    normalized.pendingServerStartSync = requireBoolean(
      job.pendingServerStartSync,
      joinPath(path, 'pendingServerStartSync')
    );
  }

  if (job.pendingServerCompleteSync !== undefined) {
    normalized.pendingServerCompleteSync = requireBoolean(
      job.pendingServerCompleteSync,
      joinPath(path, 'pendingServerCompleteSync')
    );
  }

  return normalized;
}

function validateAlphabetPreset(
  preset: AlphabetPreset,
  path: string
): AlphabetPreset {
  if (!isPlainObject(preset)) {
    throw new FirestorePayloadValidationError(path, 'Expected preset object.');
  }
  return {
    id: requireNonEmptyString(preset.id, joinPath(path, 'id')),
    name: requireNonEmptyString(preset.name, joinPath(path, 'name')),
    productType: requireNonEmptyString(
      preset.productType,
      joinPath(path, 'productType')
    ),
    plateCapacity: requireFiniteNumber(
      preset.plateCapacity,
      joinPath(path, 'plateCapacity'),
      { min: 1 }
    ),
    letters: validateLettersMap(preset.letters, joinPath(path, 'letters')),
    createdIso: requireNonEmptyString(
      preset.createdIso,
      joinPath(path, 'createdIso')
    ),
  };
}

function validateInventoryMovement(
  movement: InventoryMovement,
  path: string
): InventoryMovement {
  if (!isPlainObject(movement)) {
    throw new FirestorePayloadValidationError(
      path,
      'Expected inventory movement object.'
    );
  }
  return {
    id: requireNonEmptyString(movement.id, joinPath(path, 'id')),
    type: requireEnum<LedgerMovementType>(
      movement.type,
      LEDGER_MOVEMENT_TYPES,
      joinPath(path, 'type')
    ),
    jobId: normalizeNullableString(movement.jobId, joinPath(path, 'jobId')),
    projectId: normalizeNullableString(
      movement.projectId,
      joinPath(path, 'projectId')
    ),
    colorId: requireNonEmptyString(movement.colorId, joinPath(path, 'colorId')),
    deltas: validateLettersMap(movement.deltas, joinPath(path, 'deltas'), {
      allowNegative: true,
    }),
    reason: requireString(movement.reason, joinPath(path, 'reason')),
    timestampIso: requireNonEmptyString(
      movement.timestampIso,
      joinPath(path, 'timestampIso')
    ),
  };
}

function validateInventoryState(
  inventory: InventoryState,
  path: string
): InventoryState {
  if (!isPlainObject(inventory)) {
    throw new FirestorePayloadValidationError(path, 'Expected inventory object.');
  }
  if (!Array.isArray(inventory.movements)) {
    throw new FirestorePayloadValidationError(
      joinPath(path, 'movements'),
      'Expected movements array.'
    );
  }
  return {
    physicalByColor: validateColorLettersMapRecord(
      inventory.physicalByColor,
      joinPath(path, 'physicalByColor')
    ),
    wastageByColor: validateColorLettersMapRecord(
      inventory.wastageByColor,
      joinPath(path, 'wastageByColor')
    ),
    movements: inventory.movements
      .slice(0, 300)
      .map((mv, idx) =>
        validateInventoryMovement(mv, `${joinPath(path, 'movements')}[${idx}]`)
      ),
  };
}

function validateActivityLogEntry(
  entry: ActivityLogEntry,
  path: string
): ActivityLogEntry {
  if (!isPlainObject(entry)) {
    throw new FirestorePayloadValidationError(path, 'Expected log entry object.');
  }
  const normalized: ActivityLogEntry = {
    id: requireNonEmptyString(entry.id, joinPath(path, 'id')),
    at: requireNonEmptyString(entry.at, joinPath(path, 'at')),
    timestampIso: requireNonEmptyString(
      entry.timestampIso,
      joinPath(path, 'timestampIso')
    ),
    category: requireEnum(
      entry.category,
      LOG_CATEGORIES,
      joinPath(path, 'category')
    ),
    msg: requireString(entry.msg, joinPath(path, 'msg')),
  };

  // Omit truly absent optional `projectId` (never pass `projectId: undefined` to Firestore)
  if (typeof entry.projectId === 'string' && entry.projectId.trim().length > 0) {
    normalized.projectId = entry.projectId;
  } else if (entry.projectId !== undefined && entry.projectId !== '') {
    throw new FirestorePayloadValidationError(
      joinPath(path, 'projectId'),
      `Expected optional string (received ${typeof entry.projectId}).`
    );
  }

  return normalized;
}

function validateWorkspaceSettings(
  settings: WorkspaceSettings,
  path: string
): WorkspaceSettings {
  if (!isPlainObject(settings)) {
    throw new FirestorePayloadValidationError(path, 'Expected settings object.');
  }

  const normalized: WorkspaceSettings = {
    defaultPlateCapacity: requireFiniteNumber(
      settings.defaultPlateCapacity,
      joinPath(path, 'defaultPlateCapacity'),
      { min: 1 }
    ),
    defaultProductType: requireNonEmptyString(
      settings.defaultProductType,
      joinPath(path, 'defaultProductType')
    ),
    theme: requireEnum(settings.theme, ['light', 'dark'] as const, joinPath(path, 'theme')),
  };

  if (settings.turnaroundBufferMinutes !== undefined) {
    normalized.turnaroundBufferMinutes = requireFiniteNumber(
      settings.turnaroundBufferMinutes,
      joinPath(path, 'turnaroundBufferMinutes'),
      { min: 0 }
    );
  }

  if (
    typeof settings.timezone === 'string' &&
    settings.timezone.trim().length > 0
  ) {
    normalized.timezone = settings.timezone;
  } else if (settings.timezone !== undefined && settings.timezone !== '') {
    throw new FirestorePayloadValidationError(
      joinPath(path, 'timezone'),
      `Expected optional string (received ${typeof settings.timezone}).`
    );
  }

  return normalized;
}

/**
 * Validates and normalizes an entire `ProductionWorkspaceV5` before persistence:
 * 1. Emits development-only diagnostics reporting the exact path of any `undefined` property.
 * 2. Validates every required field across workspace, colors, machines, projects, jobs/plates,
 *    presets, inventory, logs, and scheduling settings (never silently dropping required fields).
 * 3. Uses `null` for intentionally empty optional fields and omits truly absent optional properties.
 * 4. Runs recursive Firestore compatibility verification without JSON.stringify/JSON.parse.
 */
export function prepareWorkspaceForFirestore(
  ws: ProductionWorkspaceV5,
  ownerId: string,
  options?: {
    documentLabel?: string;
    isDev?: boolean;
    onUndefinedDiagnostic?: (paths: string[], formattedMessage: string) => void;
  }
): ProductionWorkspaceV5 {
  const docLabel = options?.documentLabel || `users/${ownerId}/tracker/v5_workspace`;

  reportDevUndefinedDiagnostics(ws, docLabel, {
    isDev: options?.isDev,
    onReport: options?.onUndefinedDiagnostic,
  });

  if (!isPlainObject(ws)) {
    throw new FirestorePayloadValidationError('<root>', 'Workspace must be an object.');
  }

  const validOwnerId = requireNonEmptyString(ownerId, 'ownerId').slice(0, 128);

  if (ws.schemaVersion !== 5) {
    throw new FirestorePayloadValidationError(
      'schemaVersion',
      `Expected schemaVersion 5 (received ${String(ws.schemaVersion)}).`
    );
  }

  if (!Array.isArray(ws.colors)) {
    throw new FirestorePayloadValidationError('colors', 'Expected colors array.');
  }
  if (!Array.isArray(ws.machines)) {
    throw new FirestorePayloadValidationError('machines', 'Expected machines array.');
  }
  if (!Array.isArray(ws.projects)) {
    throw new FirestorePayloadValidationError('projects', 'Expected projects array.');
  }
  if (!Array.isArray(ws.jobs)) {
    throw new FirestorePayloadValidationError('jobs', 'Expected jobs array.');
  }
  if (!Array.isArray(ws.presets)) {
    throw new FirestorePayloadValidationError('presets', 'Expected presets array.');
  }
  if (!Array.isArray(ws.log)) {
    throw new FirestorePayloadValidationError('log', 'Expected log array.');
  }

  const normalized: ProductionWorkspaceV5 = {
    schemaVersion: 5,
    ownerId: validOwnerId,
    migratedFromV1: requireBoolean(Boolean(ws.migratedFromV1), 'migratedFromV1'),
    colors: ws.colors
      .slice(0, 50)
      .map((c, idx) => validateColorOption(c, `colors[${idx}]`)),
    machines: ws.machines
      .slice(0, 100)
      .map((m, idx) => validatePrinterMachine(m, `machines[${idx}]`)),
    projects: ws.projects
      .slice(0, 500)
      .map((p, idx) => validateProductionProject(p, `projects[${idx}]`)),
    jobs: ws.jobs
      .slice(0, 3000)
      .map((j, idx) => validateProductionJob(j, `jobs[${idx}]`)),
    presets: ws.presets
      .slice(0, 100)
      .map((pr, idx) => validateAlphabetPreset(pr, `presets[${idx}]`)),
    inventory: validateInventoryState(ws.inventory, 'inventory'),
    log: ws.log
      .slice(0, 200)
      .map((entry, idx) => validateActivityLogEntry(entry, `log[${idx}]`)),
    settings: validateWorkspaceSettings(ws.settings, 'settings'),
    updatedIso: new Date().toISOString(),
  };

  return sanitizeFirestoreValue(normalized);
}

/**
 * Prepares the final top-level Firestore document object passed directly to `setDoc()`,
 * preserving special Firestore values such as `serverTimestamp()`, `Timestamp`, and `Date`
 * while guaranteeing zero `undefined` values at any depth.
 */
export function buildFirestoreSetDocPayload<T extends Record<string, unknown>>(
  payload: T,
  documentLabel = 'users/{uid}/tracker/v5_workspace',
  options?: {
    isDev?: boolean;
    onUndefinedDiagnostic?: (paths: string[], formattedMessage: string) => void;
  }
): T {
  reportDevUndefinedDiagnostics(payload, documentLabel, {
    isDev: options?.isDev,
    onReport: options?.onUndefinedDiagnostic,
  });
  return sanitizeFirestoreValue(payload);
}
