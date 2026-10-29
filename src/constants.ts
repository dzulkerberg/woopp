import {
  AlphabetPreset,
  ColorOption,
  KanbanStage,
  LegacyJobStatus,
  LegacyTrackerState,
  LettersMap,
  MachineStatus,
  PrinterMachine,
  ProductionJob,
  ProductionProject,
  ProductionWorkspaceV5,
  ProjectPriority,
  SalesChannel,
} from './types';
import { DEFAULT_TIMEZONE, formatDateTimeDDMMYYYY } from './utils/dateFormat';

export const STORAGE_KEY_V5 = 'woopp-print-tracker-v5';
export const STORAGE_KEY_V1 = 'woopp-print-tracker-v1';
export const DEFAULT_PLATE_CAPACITY = 138;
export const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

export const SALES_CHANNELS: SalesChannel[] = [
  'Klebang Walk',
  'Vintage Night Market',
  'Supply Kedai',
  'Corporate/Event',
  'Other',
];

export const PRIORITIES: ProjectPriority[] = ['Critical', 'High', 'Normal', 'Low'];

export const KANBAN_STAGES: KanbanStage[] = [
  'Planned',
  'Ready to Print',
  'Printing',
  'Completed',
  'Failed / Reprint',
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

    return {
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
      slicerVerified: isCompleted || stage === 'Printing',
      stockApplied: isCompleted,
      stockTransactionId: isCompleted ? `mig-tx-${lj.id || index}` : null,
      failedCount: isFailed ? 1 : 0,
      failureReason: isFailed ? 'Imported from v1 status Gagal / ulang' : '',
      notes: lj.notes || '',
      createdIso: nowIso,
      updatedIso: nowIso,
      completedIso: isCompleted ? nowIso : null,
    };
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

  const totalTargetQty = Object.values(targetsByColor).reduce(
    (sum, map) => sum + countLetters(map),
    0
  );

  const legacyProject: ProductionProject = {
    id: legacyProjectId,
    name: 'Legacy Production Plan (Migrated v1)',
    salesChannel: 'Klebang Walk',
    priority: 'High',
    deadline: '',
    productType: '3D Clicker Keycap',
    plateCapacity: DEFAULT_PLATE_CAPACITY,
    assignedColorIds: colors.map((c) => c.id),
    targetQuantity: totalTargetQty,
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
    msg: entry.msg,
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
    targetQuantity: countLetters(standardTarget) * colors.length,
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
      speedFactor:
        typeof m.speedFactor === 'number' && m.speedFactor > 0 ? m.speedFactor : 1,
      setupBufferMinutes:
        typeof m.setupBufferMinutes === 'number' && m.setupBufferMinutes >= 0
          ? m.setupBufferMinutes
          : 0,
      maintenanceUntilMs: m.maintenanceUntilMs ?? null,
    })),
    projects: Array.isArray(raw.projects) ? raw.projects : [],
    jobs: Array.isArray(raw.jobs) ? raw.jobs : [],
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
    log: Array.isArray(raw.log) ? raw.log.slice(0, 200) : [],
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
    },
    updatedIso: raw.updatedIso || new Date().toISOString(),
  };
}
