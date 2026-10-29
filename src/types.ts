export type LettersMap = Record<string, number>;

export type SalesChannel =
  | 'Klebang Walk'
  | 'Vintage Night Market'
  | 'Supply Kedai'
  | 'Corporate/Event'
  | 'Other';

export type ProjectPriority = 'Critical' | 'High' | 'Normal' | 'Low';

export type ProjectStatus = 'Active' | 'Completed' | 'Archived';

export type KanbanStage =
  | 'Planned'
  | 'Ready to Print'
  | 'Printing'
  | 'Completed'
  | 'Failed / Reprint';

export type MachineStatus = 'Idle' | 'Printing' | 'Completed' | 'Maintenance' | 'Offline';

export interface ColorOption {
  id: string;
  name: string;
  hex: string;
}

export interface PrinterMachine {
  id: string;
  name: string;
  model: string;
  status: MachineStatus;
  plateCapacity: number;
  activeJobId: string | null;
  totalCompletedPlates: number;
  totalFailedPlates: number;
  totalPrintMinutes: number;
  notes: string;
  // Smart Scheduling & Printer-Specific Parameters (additive, backward-compatible)
  speedFactor?: number; // Multiplier on base Bambu Studio duration (default 1.0)
  setupBufferMinutes?: number; // Extra machine-specific bed prep / calibration minutes
  maintenanceUntilMs?: number | null; // Epoch ms when scheduled maintenance ends
}

export interface ProductionProject {
  id: string;
  name: string;
  salesChannel: SalesChannel;
  priority: ProjectPriority;
  deadline: string; // YYYY-MM-DD or ''
  productType: string;
  plateCapacity: number;
  assignedColorIds: string[];
  targetQuantity: number;
  // colorId -> { A..Z -> qty }
  targetsByColor: Record<string, LettersMap>;
  // colorId -> { A..Z -> carry-forward unplated remainder }
  carryForwardByColor: Record<string, LettersMap>;
  // colorId -> { A..Z -> reserved physical inventory allocated to this project }
  allocatedStockByColor: Record<string, LettersMap>;
  status: ProjectStatus;
  notes: string;
  createdIso: string;
  updatedIso: string;
}

export interface ProductionJob {
  id: string;
  projectId: string;
  colorId: string;
  plateNumber: number;
  plateCapacity: number;
  letters: LettersMap;
  stage: KanbanStage;
  machineId: string | null;
  estimatedMinutes: number; // Base manual Bambu Studio duration (hours * 60 + mins)
  actualMinutes: number;
  slicerVerified: boolean;
  // Idempotent guard: true iff this plate's letters are currently credited in physicalStock
  stockApplied: boolean;
  stockTransactionId: string | null;
  failedCount: number;
  failureReason: string;
  notes: string;
  createdIso: string;
  updatedIso: string;
  completedIso: string | null;
  // Smart Production ETA & Live Countdown Fields (additive, backward-compatible)
  machineDurationOverrides?: Record<string, number>; // machineId -> custom minutes from Bambu Studio for specific printer
  startedAtMs?: number | null; // Initial print start epoch ms (synced via Firebase serverTimestamp)
  runResumedAtMs?: number | null; // Epoch ms of current active printing segment
  isPaused?: boolean; // True when paused; countdown freezes until resumed
  pausedAtMs?: number | null; // Epoch ms when paused
  remainingSecondsAtPause?: number | null; // Remaining seconds frozen at pause or manually updated by operator
  accumulatedElapsedSeconds?: number; // Seconds printed prior to latest resume/pause
  estimatedFinishAtMs?: number | null; // Projected completion epoch ms while actively printing
  actualCompletedAtMs?: number | null; // Actual completion epoch ms (synced via Firebase serverTimestamp)
  pendingServerStartSync?: boolean; // Reconciles startedAtMs with Firestore serverUpdatedAt snapshot
  pendingServerCompleteSync?: boolean; // Reconciles actualCompletedAtMs with Firestore serverUpdatedAt snapshot
}

export interface AlphabetPreset {
  id: string;
  name: string;
  productType: string;
  plateCapacity: number;
  letters: LettersMap;
  createdIso: string;
}

export type LedgerMovementType =
  | 'PRINT_COMPLETE'
  | 'PRINT_REVERSAL'
  | 'MIGRATION_IMPORT'
  | 'MANUAL_ADJUSTMENT'
  | 'WASTAGE_REJECT'
  | 'PROJECT_ALLOCATION';

export interface InventoryMovement {
  id: string;
  type: LedgerMovementType;
  jobId: string | null;
  projectId: string | null;
  colorId: string;
  deltas: LettersMap;
  reason: string;
  timestampIso: string;
}

export interface InventoryState {
  // colorId -> { A..Z -> total physically produced & adjusted net stock }
  physicalByColor: Record<string, LettersMap>;
  // colorId -> { A..Z -> cumulative wastage/rejected parts recorded }
  wastageByColor: Record<string, LettersMap>;
  movements: InventoryMovement[];
}

export interface ActivityLogEntry {
  id: string;
  at: string;
  timestampIso: string;
  category: 'project' | 'plate' | 'machine' | 'inventory' | 'system';
  msg: string;
  projectId?: string;
}

export interface WorkspaceSettings {
  defaultPlateCapacity: number;
  defaultProductType: string;
  theme: 'light' | 'dark';
  // Smart ETA & Scheduling Settings (additive, backward-compatible)
  turnaroundBufferMinutes?: number; // Plate removal, bed cleaning & restart buffer (default 15 mins)
  timezone?: string; // User timezone, defaults to 'Asia/Kuala_Lumpur'
}

export interface ProductionWorkspaceV5 {
  schemaVersion: number;
  ownerId: string;
  migratedFromV1: boolean;
  colors: ColorOption[];
  machines: PrinterMachine[];
  projects: ProductionProject[];
  jobs: ProductionJob[];
  presets: AlphabetPreset[];
  inventory: InventoryState;
  log: ActivityLogEntry[];
  settings: WorkspaceSettings;
  updatedIso: string;
}

// Legacy v1 types for backward-compatible reading & non-destructive migration
export type LegacyJobStatus = 'Belum print' | 'Sedang print' | 'Siap' | 'Gagal / ulang';

export interface LegacyPrintJob {
  id: string;
  color: number;
  plate: number;
  letters: LettersMap;
  status: LegacyJobStatus;
  machine: string;
  notes: string;
  updated: string;
}

export interface LegacyTrackerState {
  colors: string[];
  machines: string[];
  jobs: LegacyPrintJob[];
  log: { at: string; msg: string }[];
}

export type NavSection =
  | 'dashboard'
  | 'eta'
  | 'timeline'
  | 'projects'
  | 'planner'
  | 'queue'
  | 'machines'
  | 'inventory'
  | 'analytics'
  | 'settings';
