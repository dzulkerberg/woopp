import {
  ActiveKanbanStage,
  AlphabetPreset,
  CharmDefinition,
  CharmId,
  CharmsMap,
  ColorOption,
  KanbanStage,
  LegacyJobStatus,
  LegacyTrackerState,
  LettersMap,
  MachineStatus,
  PlanningSessionRecord,
  PlateGenerationMode,
  PrinterMachine,
  ProductionJob,
  ProductionProject,
  ProductionWorkspaceV5,
  ProjectPriority,
  SalesChannel,
} from './types';
import { DEFAULT_TIMEZONE, formatDateTimeDDMMYYYY } from './utils/dateFormat';
import { hydrateJobCountdownFields } from './utils/productionCountdown';

export const STORAGE_KEY_V5 = 'woopp-print-tracker-v5';
export const STORAGE_KEY_V1 = 'woopp-print-tracker-v1';
export const DEFAULT_PLATE_CAPACITY = 138;
export const PRIMARY_ADMIN_EMAIL = 'hellodzul@gmail.com';
export const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

export const CHARM_DEFINITIONS: readonly CharmDefinition[] = [
  { id: 'CHARM_LOVE', label: 'LOVE', symbol: '♥' },
  { id: 'CHARM_STAR', label: 'STAR', symbol: '★' },
  { id: 'CHARM_FLOWER', label: 'FLOWER', symbol: '✿' },
  { id: 'CHARM_HASH', label: 'HASHTAG', symbol: '#' },
  { id: 'CHARM_AT', label: 'AT SIGN', symbol: '@' },
] as const;

export const CHARM_IDS: CharmId[] = CHARM_DEFINITIONS.map((c) => c.id);

export const CHARM_BY_ID: Record<CharmId, CharmDefinition> = {
  CHARM_LOVE: CHARM_DEFINITIONS[0],
  CHARM_STAR: CHARM_DEFINITIONS[1],
  CHARM_FLOWER: CHARM_DEFINITIONS[2],
  CHARM_HASH: CHARM_DEFINITIONS[3],
  CHARM_AT: CHARM_DEFINITIONS[4],
};

export const PLATE_GENERATION_MODES: readonly PlateGenerationMode[] = [
  'alphabet_only',
  'charm_only',
  'mixed',
] as const;

export const SALES_CHANNELS: SalesChannel[] = [
  'Klebang Walk',
  'Vintage Night Market',
  'Supply Kedai',
  'Corporate/Event',
  'Other',
];

export const PRIORITIES: ProjectPriority[] = ['Critical', 'High', 'Normal', 'Low'];

export const ACTIVE_KANBAN_STAGES: ActiveKanbanStage[] = [
  'Planned',
  'Ready to Print',
  'Printing',
  'Completed',
  'Failed / Reprint',
];

export const KANBAN_STAGES: KanbanStage[] = [
  ...ACTIVE_KANBAN_STAGES,
  'Cancelled',
];

export const MACHINE_STATUSES: MachineStatus[] = [
  'Idle',
  'Printing',
  'Completed',
  'Maintenance',
  'Offline',
];

export const DEFAULT_MACHINE_NAMES = [
  'Bambu P1S #1',
  'Bambu A1 - 01',
  'Bambu A1 - 02',
  'Bambu A1 - 03',
  'Bambu A1 - 04',
];

export const DEFAULT_COLOR_PALETTE = [
  '#7C5CFC',
  '#0F766E',
  '#DB2777',
  '#D97706',
  '#2563EB',
  '#475569',
];

export const PLATE_1: LettersMap = { A: 60, I: 40, N: 28, E: 10 };
export const PLATE_2: LettersMap = { E: 14, H: 24, M: 24, R: 24, S: 24, D: 18, L: 10 };
export const PLATE_3: LettersMap = {
  L: 8,
  U: 18,
  Y: 18,
  B: 9,
  F: 9,
  K: 9,
  T: 9,
  Z: 9,
  C: 7,
  G: 7,
  J: 7,
  O: 7,
  P: 7,
  Q: 3,
  V: 3,
  W: 3,
  X: 3,
  N: 2,
};

export const V1_TEMPLATES: LettersMap[] = [PLATE_1, PLATE_2, PLATE_3];

export function emptyAlphabetMap(): LettersMap {
  return Object.fromEntries(ABC.map((letter) => [letter, 0]));
}

export function normalizeAlphabetMap(map?: Partial<LettersMap> | null): LettersMap {
  const base = emptyAlphabetMap();
  if (!map) return base;
  for (const letter of ABC) {
    const val = Number(map[letter] || 0);
    base[letter] = Number.isFinite(val) && val > 0 ? Math.floor(val) : 0;
  }
  return base;
}

export function compactLettersMap(map: LettersMap): LettersMap {
  const out: LettersMap = {};
  for (const k of ABC) {
    const v = Math.floor(Number(map[k] || 0));
    if (v > 0) out[k] = v;
  }
  return out;
}

export function countLetters(letters?: LettersMap | null): number {
  if (!letters) return 0;
  return Object.values(letters).reduce((sum, val) => sum + Math.max(0, Math.floor(Number(val || 0))), 0);
}

export function sumAlphabetMaps(maps: (LettersMap | undefined)[]): LettersMap {
  const res = emptyAlphabetMap();
  for (const m of maps) {
    if (!m) continue;
    for (const [k, v] of Object.entries(m)) {
      if (ABC.includes(k)) {
        res[k] = (res[k] || 0) + Math.max(0, Math.floor(Number(v || 0)));
      }
    }
  }
  return res;
}

export function emptyCharmsMap(): Record<CharmId, number> {
  return {
    CHARM_LOVE: 0,
    CHARM_STAR: 0,
    CHARM_FLOWER: 0,
    CHARM_HASH: 0,
    CHARM_AT: 0,
  };
}

export function normalizeCharmsMap(
  map?: Partial<Record<string, number>> | null
): Record<CharmId, number> {
  const base = emptyCharmsMap();
  if (!map) return base;
  for (const charmId of CHARM_IDS) {
    const val = Number(map[charmId] || 0);
    base[charmId] = Number.isFinite(val) && val > 0 ? Math.floor(val) : 0;
  }
  return base;
}

export function compactCharmsMap(
  map?: Partial<Record<string, number>> | null
): CharmsMap {
  const out: CharmsMap = {};
  if (!map) return out;
  for (const charmId of CHARM_IDS) {
    const v = Math.floor(Number(map[charmId] || 0));
    if (v > 0) out[charmId] = v;
  }
  return out;
}

export function countCharms(charms?: Partial<Record<string, number>> | null): number {
  if (!charms) return 0;
  return CHARM_IDS.reduce(
    (sum, id) => sum + Math.max(0, Math.floor(Number(charms[id] || 0))),
    0
  );
}

export function sumCharmsMaps(
  maps: (Partial<Record<string, number>> | undefined | null)[]
): Record<CharmId, number> {
  const res = emptyCharmsMap();
  for (const m of maps) {
    if (!m) continue;
    for (const charmId of CHARM_IDS) {
      const val = Number(m[charmId] || 0);
      if (Number.isFinite(val) && val > 0) {
        res[charmId] += Math.floor(val);
      }
    }
  }
  return res;
}

/**
 * Counts total physical keycaps on a plate (1 letter = 1 pc, 1 charm = 1 pc).
 * Treats missing charm quantities on legacy records as 0.
 */
export function countPlateKeycaps(item: {
  letters?: LettersMap | null;
  charms?: Partial<Record<string, number>> | null;
}): number {
  return countLetters(item.letters) + countCharms(item.charms);
}

export interface ProjectPlateProgress {
  completedPlates: number;
  totalValidPlates: number;
  printingPlates: number;
  queuedPlates: number;
  producedKeycaps: number;
  plannedKeycaps: number;
  producedLetters: number;
  plannedLetters: number;
  producedCharms: number;
  plannedCharms: number;
  progressPct: number;
}

/**
 * Computes project production progress strictly from actual valid plate records
 * (`Completed` plates, including archived Completed history, plus active non-archived,
 * non-cancelled pipeline plates).
 */
export function computeProjectPlateProgress(
  jobs: ProductionJob[],
  projectId: string
): ProjectPlateProgress {
  const pJobs = jobs.filter((j) => j.projectId === projectId);
  const completedJobs = pJobs.filter((j) => j.stage === 'Completed');
  const printingJobs = pJobs.filter((j) => !j.archived && j.stage === 'Printing');
  const queuedJobs = pJobs.filter(
    (j) => !j.archived && (j.stage === 'Planned' || j.stage === 'Ready to Print')
  );
  const validJobs = pJobs.filter(
    (j) => j.stage === 'Completed' || (!j.archived && j.stage !== 'Cancelled')
  );

  const producedLetters = completedJobs.reduce(
    (sum, j) => sum + countLetters(j.letters),
    0
  );
  const producedCharms = completedJobs.reduce(
    (sum, j) => sum + countCharms(j.charms),
    0
  );
  const producedKeycaps = producedLetters + producedCharms;

  const plannedLetters = validJobs.reduce(
    (sum, j) => sum + countLetters(j.letters),
    0
  );
  const plannedCharms = validJobs.reduce(
    (sum, j) => sum + countCharms(j.charms),
    0
  );
  const plannedKeycaps = plannedLetters + plannedCharms;

  const progressPct =
    plannedKeycaps > 0
      ? Math.min(100, Math.round((producedKeycaps / plannedKeycaps) * 100))
      : 0;

  return {
    completedPlates: completedJobs.length,
    totalValidPlates: validJobs.length,
    printingPlates: printingJobs.length,
    queuedPlates: queuedJobs.length,
    producedKeycaps,
    plannedKeycaps,
    producedLetters,
    plannedLetters,
    producedCharms,
    plannedCharms,
    progressPct,
  };
}

/**
 * Formats a plate's Alphabet & Charm quantities into a clean plain-text summary
 * for queue clipboard exports, tooltips, and select dropdowns.
 */
export function formatPlateItemsText(
  item: {
    letters?: LettersMap | null;
    charms?: Partial<Record<string, number>> | null;
  },
  compact = false
): string {
  const letterParts: string[] = [];
  if (item.letters) {
    for (const k of ABC) {
      const v = Math.floor(Number(item.letters[k] || 0));
      if (v > 0) letterParts.push(compact ? `${k}${v}` : `${k}×${v}`);
    }
  }

  const charmParts: string[] = [];
  if (item.charms) {
    for (const def of CHARM_DEFINITIONS) {
      const v = Math.floor(Number(item.charms[def.id] || 0));
      if (v > 0) {
        charmParts.push(
          compact ? `${def.symbol}${v}` : `${def.symbol} ${def.label}×${v}`
        );
      }
    }
  }

  if (letterParts.length > 0 && charmParts.length > 0) {
    return `${letterParts.join(compact ? ' ' : ' · ')} | ${charmParts.join(
      compact ? ' ' : ' · '
    )}`;
  }
  if (charmParts.length > 0) {
    return charmParts.join(compact ? ' ' : ' · ');
  }
  return letterParts.join(compact ? ' ' : ' · ');
}

export function createStandard414Preset(): AlphabetPreset {
  const combined = sumAlphabetMaps(V1_TEMPLATES);
  return {
    id: 'preset-woopp-414',
    name: 'WOOPP Standard 3-Plate Set (414 pcs)',
    productType: '3D Clicker Keycap',
    plateCapacity: DEFAULT_PLATE_CAPACITY,
    letters: combined,
    createdIso: new Date().toISOString(),
  };
}

export function createEqualSetPreset(): AlphabetPreset {
  const letters = Object.fromEntries(ABC.map((l) => [l, 5]));
  return {
    id: 'preset-balanced-130',
    name: 'Balanced A–Z Starter (5 pcs / letter)',
    productType: '3D Clicker Keycap',
    plateCapacity: DEFAULT_PLATE_CAPACITY,
    letters,
    createdIso: new Date().toISOString(),
  };
}

export function buildDefaultFleet(existingNames: string[] = []): PrinterMachine[] {
  const mergedNames: string[] = [];
  for (const name of [...existingNames, ...DEFAULT_MACHINE_NAMES]) {
    const trimmed = name.trim();
    if (trimmed && !mergedNames.includes(trimmed)) {
      mergedNames.push(trimmed);
    }
  }

  return mergedNames.map((name, idx) => ({
    id: `machine-${idx + 1}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name,
    model: name.toLowerCase().includes('p1s') ? 'Bambu Lab P1S' : 'Bambu Lab A1',
    status: 'Idle',
    plateCapacity: DEFAULT_PLATE_CAPACITY,
    activeJobId: null,
    totalCompletedPlates: 0,
    totalFailedPlates: 0,
    totalPrintMinutes: 0,
    notes: '',
    speedFactor: 1,
    setupBufferMinutes: 0,
    maintenanceUntilMs: null,
  }));
}

export function mapLegacyStatusToKanban(status: LegacyJobStatus): KanbanStage {
  switch (status) {
    case 'Siap':
      return 'Completed';
    case 'Sedang print':
      return 'Printing';
    case 'Gagal / ulang':
      return 'Failed / Reprint';
    case 'Belum print':
    default:
      return 'Planned';
  }
}

/**
 * Non-destructively migrates a Legacy v1 TrackerState (`users/{uid}/tracker/main`)
 * into a rich WOOPP 5.0 Workspace (`users/{uid}/tracker/v5_workspace`).
 * Preserves all colors, machines, plate statuses, notes, logs, and completed inventory!
 */
export function migrateFromLegacyV1(
  legacy: LegacyTrackerState,
  ownerId: string
): ProductionWorkspaceV5 {
  const nowIso = new Date().toISOString();

  const colors: ColorOption[] = (legacy.colors?.length ? legacy.colors : ['Warna 1', 'Warna 2', 'Warna 3']).map(
    (name, idx) => ({
      id: `color-${idx}`,
      name: name?.trim() || `Warna ${idx + 1}`,
      hex: DEFAULT_COLOR_PALETTE[idx % DEFAULT_COLOR_PALETTE.length],
    })
  );

  const machines = buildDefaultFleet(legacy.machines || []);
  const machineByName = new Map(machines.map((m) => [m.name, m]));

  const legacyProjectId = 'proj-legacy-v1';

  const jobs: ProductionJob[] = (legacy.jobs || []).map((lj, index) => {
    const colorOpt = colors[lj.color] || colors[0];
    const stage = mapLegacyStatusToKanban(lj.status);
    const matchedMachine = lj.machine ? machineByName.get(lj.machine) : undefined;
    const isCompleted = stage === 'Completed';
    const isFailed = stage === 'Failed / Reprint';

    const isPrinting = stage === 'Printing';

    const migratedJob: ProductionJob = {
      id: lj.id || `legacy-job-${index}`,
      projectId: legacyProjectId,
      colorId: colorOpt.id,
      plateNumber: Number(lj.plate) || index + 1,
      plateCapacity: DEFAULT_PLATE_CAPACITY,
      letters: compactLettersMap(lj.letters || {}),
      stage,
      machineId: matchedMachine ? matchedMachine.id : null,
      estimatedMinutes: 195,
      actualMinutes: isCompleted ? 195 : 0,
      slicerVerified: isCompleted || isPrinting,
      stockApplied: isCompleted,
      stockTransactionId: isCompleted ? `mig-tx-${lj.id || index}` : null,
      failedCount: isFailed ? 1 : 0,
      failureReason: isFailed ? 'Imported from v1 status Gagal / ulang' : '',
      notes: lj.notes || '',
      createdIso: nowIso,
      updatedIso: nowIso,
      completedIso: isCompleted ? nowIso : null,
      ...(isCompleted
        ? {
            actualCompletedAt: nowIso,
            actualCompletedAtMs: Date.parse(nowIso),
          }
        : {}),
      ...(isPrinting
        ? {
            // Legacy v1 lacked print start timestamps: never invent a historical start time
            actualStartedAt: null,
            startedAtMs: null,
            estimatedDurationMs: 195 * 60_000,
            estimatedFinishAt: null,
            estimatedFinishAtMs: null,
            pausedAt: null,
            pausedAtMs: null,
            remainingAtPauseMs: null,
            remainingSecondsAtPause: null,
            actualCompletedAt: null,
            actualCompletedAtMs: null,
            isPaused: false,
            needsEtaRecalibration: true,
          }
        : {}),
    };

    return migratedJob;
  });

  // Update machine telemetry & active Printing status from migrated jobs
  for (const job of jobs) {
    if (!job.machineId) continue;
    const machine = machines.find((m) => m.id === job.machineId);
    if (!machine) continue;
    if (job.stage === 'Completed') {
      machine.totalCompletedPlates += 1;
      machine.totalPrintMinutes += job.actualMinutes || job.estimatedMinutes;
    } else if (job.stage === 'Failed / Reprint') {
      machine.totalFailedPlates += 1;
    } else if (job.stage === 'Printing' && !machine.activeJobId) {
      machine.status = 'Printing';
      machine.activeJobId = job.id;
    }
  }

  // Reconstruct targetsByColor and physical inventory from v1 jobs
  const targetsByColor: Record<string, LettersMap> = {};
  const carryForwardByColor: Record<string, LettersMap> = {};
  const allocatedStockByColor: Record<string, LettersMap> = {};
  const physicalByColor: Record<string, LettersMap> = {};
  const wastageByColor: Record<string, LettersMap> = {};

  for (const color of colors) {
    const jobsForColor = jobs.filter((j) => j.colorId === color.id);
    targetsByColor[color.id] = sumAlphabetMaps(jobsForColor.map((j) => j.letters));
    carryForwardByColor[color.id] = emptyAlphabetMap();
    allocatedStockByColor[color.id] = emptyAlphabetMap();
    const completedForColor = jobsForColor.filter((j) => j.stage === 'Completed');
    physicalByColor[color.id] = sumAlphabetMaps(completedForColor.map((j) => j.letters));
    wastageByColor[color.id] = emptyAlphabetMap();
  }

  const legacyProject: ProductionProject = {
    id: legacyProjectId,
    name: 'Legacy Production Plan (Migrated v1)',
    salesChannel: 'Klebang Walk',
    priority: 'High',
    deadline: '',
    productType: '3D Clicker Keycap',
    plateCapacity: DEFAULT_PLATE_CAPACITY,
    assignedColorIds: colors.map((c) => c.id),
    targetsByColor,
    carryForwardByColor,
    allocatedStockByColor,
    status: 'Active',
    notes: 'Automatically migrated from WOOPP Tracker v1 without modifying your original Firestore document.',
    createdIso: nowIso,
    updatedIso: nowIso,
  };

  const movements = jobs
    .filter((j) => j.stage === 'Completed')
    .map((j) => ({
      id: j.stockTransactionId || `mig-tx-${j.id}`,
      type: 'MIGRATION_IMPORT' as const,
      jobId: j.id,
      projectId: legacyProjectId,
      colorId: j.colorId,
      deltas: { ...j.letters },
      reason: `Migrated completed Plate ${j.plateNumber} from v1`,
      timestampIso: nowIso,
    }));

  const migratedLogs = (legacy.log || []).slice(0, 120).map((entry, idx) => ({
    id: `mig-log-${idx}`,
    at: entry.at || formatDateTimeDDMMYYYY(),
    timestampIso: nowIso,
    category: 'system' as const,
    msg: typeof entry.msg === 'string' ? entry.msg : '',
    projectId: legacyProjectId,
  }));

  migratedLogs.unshift({
    id: `mig-banner-${Date.now()}`,
    at: formatDateTimeDDMMYYYY(),
    timestampIso: nowIso,
    category: 'system',
    msg: `Upgraded to WOOPP 5.0: Preserved ${jobs.length} plates, ${colors.length} colors, and completed inventory from v1.`,
    projectId: legacyProjectId,
  });

  return {
    schemaVersion: 5,
    ownerId,
    migratedFromV1: true,
    colors,
    machines,
    projects: [legacyProject],
    jobs,
    presets: [createStandard414Preset(), createEqualSetPreset()],
    inventory: {
      physicalByColor,
      wastageByColor,
      movements,
    },
    log: migratedLogs,
    settings: {
      defaultPlateCapacity: DEFAULT_PLATE_CAPACITY,
      defaultProductType: '3D Clicker Keycap',
      theme: 'light',
      turnaroundBufferMinutes: 15,
      timezone: DEFAULT_TIMEZONE,
    },
    updatedIso: nowIso,
  };
}

/**
 * Creates a clean WOOPP 5.0 workspace for brand-new accounts that have no v1 data.
 * Note: Zero plates are marked completed automatically and stock starts strictly at 0.
 */
export function createFreshWorkspaceV5(ownerId: string): ProductionWorkspaceV5 {
  const nowIso = new Date().toISOString();
  const colors: ColorOption[] = [
    { id: 'color-0', name: 'Matte Lavender', hex: '#7C5CFC' },
    { id: 'color-1', name: 'Ivory White', hex: '#64748B' },
    { id: 'color-2', name: 'Charcoal Black', hex: '#1E293B' },
  ];

  const machines = buildDefaultFleet([]);
  const defaultProjectId = 'proj-initial-1';

  const targetsByColor: Record<string, LettersMap> = {};
  const carryForwardByColor: Record<string, LettersMap> = {};
  const allocatedStockByColor: Record<string, LettersMap> = {};
  const physicalByColor: Record<string, LettersMap> = {};
  const wastageByColor: Record<string, LettersMap> = {};

  const standardTarget = sumAlphabetMaps(V1_TEMPLATES);

  colors.forEach((c) => {
    targetsByColor[c.id] = { ...standardTarget };
    carryForwardByColor[c.id] = emptyAlphabetMap();
    allocatedStockByColor[c.id] = emptyAlphabetMap();
    physicalByColor[c.id] = emptyAlphabetMap();
    wastageByColor[c.id] = emptyAlphabetMap();
  });

  const jobs: ProductionJob[] = colors.flatMap((c) =>
    V1_TEMPLATES.map((tpl, idx) => ({
      id: `job-init-${c.id}-${idx + 1}`,
      projectId: defaultProjectId,
      colorId: c.id,
      plateNumber: idx + 1,
      plateCapacity: DEFAULT_PLATE_CAPACITY,
      letters: compactLettersMap(tpl),
      stage: 'Planned' as KanbanStage,
      machineId: null,
      estimatedMinutes: 195,
      actualMinutes: 0,
      slicerVerified: false,
      stockApplied: false,
      stockTransactionId: null,
      failedCount: 0,
      failureReason: '',
      notes: '',
      createdIso: nowIso,
      updatedIso: nowIso,
      completedIso: null,
    }))
  );

  const initialProject: ProductionProject = {
    id: defaultProjectId,
    name: 'Core Clicker Alphabet Batch',
    salesChannel: 'Klebang Walk',
    priority: 'Normal',
    deadline: '',
    productType: '3D Clicker Keycap',
    plateCapacity: DEFAULT_PLATE_CAPACITY,
    assignedColorIds: colors.map((c) => c.id),
    targetsByColor,
    carryForwardByColor,
    allocatedStockByColor,
    status: 'Active',
    notes: 'Default unprinted production plan (138 pcs/plate). Verify physical layout in Bambu Studio.',
    createdIso: nowIso,
    updatedIso: nowIso,
  };

  return {
    schemaVersion: 5,
    ownerId,
    migratedFromV1: false,
    colors,
    machines,
    projects: [initialProject],
    jobs,
    presets: [createStandard414Preset(), createEqualSetPreset()],
    inventory: {
      physicalByColor,
      wastageByColor,
      movements: [],
    },
    log: [
      {
        id: `log-init-${Date.now()}`,
        at: formatDateTimeDDMMYYYY(),
        timestampIso: nowIso,
        category: 'system',
        msg: 'Initialized WOOPP Print Production Management System 5.0 workspace.',
        projectId: defaultProjectId,
      },
    ],
    settings: {
      defaultPlateCapacity: DEFAULT_PLATE_CAPACITY,
      defaultProductType: '3D Clicker Keycap',
      theme: 'light',
      turnaroundBufferMinutes: 15,
      timezone: DEFAULT_TIMEZONE,
    },
    updatedIso: nowIso,
  };
}

/**
 * Ensures any loaded v5 workspace has all 5 required default machines available if missing,
 * and normalizes nested maps safely.
 */
export function normalizeWorkspaceV5(
  raw: ProductionWorkspaceV5,
  ownerId: string
): ProductionWorkspaceV5 {
  const existingMachineNames = new Set((raw.machines || []).map((m) => m.name));
  const additionalMachines: PrinterMachine[] = [];

  DEFAULT_MACHINE_NAMES.forEach((defaultName, idx) => {
    if (!existingMachineNames.has(defaultName)) {
      additionalMachines.push({
        id: `machine-auto-${idx + 1}-${defaultName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        name: defaultName,
        model: defaultName.toLowerCase().includes('p1s') ? 'Bambu Lab P1S' : 'Bambu Lab A1',
        status: 'Idle',
        plateCapacity: raw.settings?.defaultPlateCapacity || DEFAULT_PLATE_CAPACITY,
        activeJobId: null,
        totalCompletedPlates: 0,
        totalFailedPlates: 0,
        totalPrintMinutes: 0,
        notes: '',
        speedFactor: 1,
        setupBufferMinutes: 0,
        maintenanceUntilMs: null,
      });
    }
  });

  const colors = raw.colors?.length
    ? raw.colors
    : [{ id: 'color-0', name: 'Default Color', hex: '#7C5CFC' }];

  const physicalByColor = { ...(raw.inventory?.physicalByColor || {}) };
  const wastageByColor = { ...(raw.inventory?.wastageByColor || {}) };

  for (const c of colors) {
    physicalByColor[c.id] = normalizeAlphabetMap(physicalByColor[c.id]);
    wastageByColor[c.id] = normalizeAlphabetMap(wastageByColor[c.id]);
  }

  return {
    schemaVersion: 5,
    ownerId,
    migratedFromV1: Boolean(raw.migratedFromV1),
    colors,
    machines: [...(raw.machines || []), ...additionalMachines].map((m) => ({
      ...m,
      activeJobId: m.activeJobId ?? null,
      notes: typeof m.notes === 'string' ? m.notes : '',
      speedFactor:
        typeof m.speedFactor === 'number' && m.speedFactor > 0 ? m.speedFactor : 1,
      setupBufferMinutes:
        typeof m.setupBufferMinutes === 'number' && m.setupBufferMinutes >= 0
          ? m.setupBufferMinutes
          : 0,
      maintenanceUntilMs: m.maintenanceUntilMs ?? null,
    })),
    projects: Array.isArray(raw.projects)
      ? raw.projects.map((p) => {
          const normalizedProj: ProductionProject = {
            ...p,
            targetsByColor: p.targetsByColor || {},
            carryForwardByColor: p.carryForwardByColor || {},
            allocatedStockByColor: p.allocatedStockByColor || {},
          };
          if (
            typeof p.targetQuantity === 'number' &&
            Number.isFinite(p.targetQuantity) &&
            p.targetQuantity >= 0
          ) {
            normalizedProj.targetQuantity = Math.floor(p.targetQuantity);
          } else {
            delete normalizedProj.targetQuantity;
          }
          if (p.charmTargetsByColor && typeof p.charmTargetsByColor === 'object') {
            const cleanedCharmTargets: Record<string, CharmsMap> = {};
            for (const [cid, cMap] of Object.entries(p.charmTargetsByColor)) {
              if (cMap && typeof cMap === 'object') {
                cleanedCharmTargets[cid] = compactCharmsMap(cMap);
              }
            }
            normalizedProj.charmTargetsByColor = cleanedCharmTargets;
          }
          if (
            p.charmCarryForwardByColor &&
            typeof p.charmCarryForwardByColor === 'object'
          ) {
            const cleanedCharmCarry: Record<string, CharmsMap> = {};
            for (const [cid, cMap] of Object.entries(p.charmCarryForwardByColor)) {
              if (cMap && typeof cMap === 'object') {
                cleanedCharmCarry[cid] = compactCharmsMap(cMap);
              }
            }
            normalizedProj.charmCarryForwardByColor = cleanedCharmCarry;
          }
          if (Array.isArray(p.planningSessions)) {
            const cleanedSessions: PlanningSessionRecord[] = [];
            for (const s of p.planningSessions) {
              if (
                s &&
                typeof s === 'object' &&
                typeof s.sessionId === 'string' &&
                s.sessionId.trim().length > 0 &&
                typeof s.colorId === 'string' &&
                s.colorId.trim().length > 0
              ) {
                const modeVal: PlateGenerationMode = PLATE_GENERATION_MODES.includes(
                  s.mode
                )
                  ? s.mode
                  : 'mixed';
                const capVal =
                  typeof s.plateCapacity === 'number' && s.plateCapacity >= 1
                    ? Math.floor(s.plateCapacity)
                    : p.plateCapacity || DEFAULT_PLATE_CAPACITY;
                cleanedSessions.push({
                  sessionId: s.sessionId.trim(),
                  colorId: s.colorId.trim(),
                  mode: modeVal,
                  plateCapacity: capVal,
                  generatedJobIds: Array.isArray(s.generatedJobIds)
                    ? s.generatedJobIds.filter(
                        (id): id is string =>
                          typeof id === 'string' && id.trim().length > 0
                      )
                    : [],
                  carryForwardLetters: compactLettersMap(
                    s.carryForwardLetters || {}
                  ),
                  carryForwardCharms: compactCharmsMap(
                    s.carryForwardCharms || {}
                  ),
                  createdIso:
                    typeof s.createdIso === 'string' && s.createdIso.trim().length > 0
                      ? s.createdIso
                      : p.createdIso || new Date().toISOString(),
                  updatedIso:
                    typeof s.updatedIso === 'string' && s.updatedIso.trim().length > 0
                      ? s.updatedIso
                      : p.updatedIso || new Date().toISOString(),
                });
              }
            }
            if (cleanedSessions.length > 0) {
              normalizedProj.planningSessions = cleanedSessions;
            } else {
              delete normalizedProj.planningSessions;
            }
          } else {
            delete normalizedProj.planningSessions;
          }
          return normalizedProj;
        })
      : [],
    jobs: Array.isArray(raw.jobs)
      ? raw.jobs.map((j) => {
          const normalizedJob: ProductionJob = {
            ...j,
            letters: j.letters || {},
          };
          if (j.charms && typeof j.charms === 'object') {
            const compacted = compactCharmsMap(j.charms);
            if (Object.keys(compacted).length > 0) {
              normalizedJob.charms = compacted;
            } else {
              delete normalizedJob.charms;
            }
          } else {
            delete normalizedJob.charms;
          }
          if (
            j.plateMode &&
            PLATE_GENERATION_MODES.includes(j.plateMode)
          ) {
            normalizedJob.plateMode = j.plateMode;
          } else {
            delete normalizedJob.plateMode;
          }
          if (typeof j.archived === 'boolean') {
            normalizedJob.archived = j.archived;
          } else {
            delete normalizedJob.archived;
          }
          const lifecycleStringKeys = [
            'planningSessionId',
            'archivedIso',
            'archivedBy',
            'cancelledIso',
            'cancellationReason',
            'cancelledBy',
            'cancelledFromMachineId',
          ] as const;
          for (const key of lifecycleStringKeys) {
            const val = j[key];
            if (typeof val === 'string' && val.trim().length > 0) {
              normalizedJob[key] = val;
            } else if (val === null) {
              normalizedJob[key] = null;
            } else {
              delete normalizedJob[key];
            }
          }
          return hydrateJobCountdownFields(normalizedJob);
        })
      : [],
    presets: Array.isArray(raw.presets) && raw.presets.length > 0
      ? raw.presets
      : [createStandard414Preset(), createEqualSetPreset()],
    inventory: {
      physicalByColor,
      wastageByColor,
      movements: Array.isArray(raw.inventory?.movements)
        ? raw.inventory.movements.slice(0, 300)
        : [],
    },
    log: Array.isArray(raw.log)
      ? raw.log.slice(0, 200).map((entry) => {
          const cleanEntry = {
            id: entry.id,
            at: entry.at,
            timestampIso: entry.timestampIso,
            category: entry.category,
            msg: typeof entry.msg === 'string' ? entry.msg : '',
          };
          return typeof entry.projectId === 'string' && entry.projectId.trim().length > 0
            ? { ...cleanEntry, projectId: entry.projectId }
            : cleanEntry;
        })
      : [],
    settings: {
      defaultPlateCapacity: raw.settings?.defaultPlateCapacity || DEFAULT_PLATE_CAPACITY,
      defaultProductType: raw.settings?.defaultProductType || '3D Clicker Keycap',
      theme: raw.settings?.theme === 'dark' ? 'dark' : 'light',
      turnaroundBufferMinutes:
        typeof raw.settings?.turnaroundBufferMinutes === 'number' &&
        raw.settings.turnaroundBufferMinutes >= 0
          ? raw.settings.turnaroundBufferMinutes
          : 15,
      timezone: raw.settings?.timezone || DEFAULT_TIMEZONE,
      ...(Array.isArray(raw.settings?.adminEmails) &&
      raw.settings.adminEmails.some((e) => typeof e === 'string' && e.trim().length > 0)
        ? {
            adminEmails: raw.settings.adminEmails
              .filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
              .map((e) => e.trim().toLowerCase()),
          }
        : {}),
    },
    updatedIso: raw.updatedIso || new Date().toISOString(),
  };
}
