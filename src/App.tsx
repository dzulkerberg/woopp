import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, signOut, User } from 'firebase/auth';
import {
  doc,
  DocumentReference,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import {
  auth,
  buildFirestoreErrorInfo,
  db,
  OperationType,
} from './firebase';
import {
  ABC,
  compactLettersMap,
  countLetters,
  createFreshWorkspaceV5,
  emptyAlphabetMap,
  migrateFromLegacyV1,
  normalizeAlphabetMap,
  normalizeWorkspaceV5,
  STORAGE_KEY_V1,
  STORAGE_KEY_V5,
} from './constants';
import {
  AlphabetPreset,
  KanbanStage,
  LegacyTrackerState,
  LettersMap,
  NavSection,
  PrinterMachine,
  ProductionJob,
  ProductionProject,
  ProductionWorkspaceV5,
  ProjectStatus,
} from './types';
import {
  DraftPlatePreview,
  getAvailableStockForColor,
  getReservedStockForColor,
  pauseOrResumePrintingJob,
  transitionJobState,
} from './utils/productionEngine';
import {
  computeGlobalSchedule,
  getEffectivePrintMinutes,
} from './utils/schedulingEngine';
import {
  DEFAULT_TIMEZONE,
  formatDateDDMMYYYY,
  formatDateTimeDDMMYYYY,
} from './utils/dateFormat';
import { Sidebar, TopHeader } from './components/Sidebar';
import { AuthSection } from './components/AuthSection';
import { DashboardView } from './components/DashboardView';
import { EtaDashboardView } from './components/EtaDashboardView';
import { ProductionTimelineView } from './components/ProductionTimelineView';
import { ProjectsView } from './components/ProjectsView';
import { AutoPlannerView } from './components/AutoPlannerView';
import { KanbanQueueView } from './components/KanbanQueueView';
import { MachinesView } from './components/MachinesView';
import { InventoryView } from './components/InventoryView';
import { AnalyticsView } from './components/AnalyticsView';
import { SettingsView } from './components/SettingsView';
import { DialogModal, ModalConfig } from './components/DialogModal';

const SECTION_META: Record<NavSection, { title: string; subtitle: string }> = {
  dashboard: {
    title: 'Dashboard',
    subtitle: 'Active projects, fleet utilization, and production progress',
  },
  eta: {
    title: 'Smart ETA Dashboard',
    subtitle: 'Live countdowns, next free Bambu printer, and parallel project completion ETAs',
  },
  timeline: {
    title: 'Production Timeline',
    subtitle: 'Multi-project Gantt schedule, turnaround buffers, and deadline tracking',
  },
  projects: {
    title: 'Projects',
    subtitle: 'Multi-channel production plans, priorities, and deadlines',
  },
  planner: {
    title: 'Auto Plate Planner',
    subtitle: 'Custom A–Z alphabet grid and exact-capacity plate distribution',
  },
  queue: {
    title: 'Print Queue',
    subtitle: 'Visual Kanban workflow, Bambu Studio durations, and live print timers',
  },
  machines: {
    title: 'Machines',
    subtitle: 'Bambu fleet status, overlap guard, maintenance windows, and speed profiles',
  },
  inventory: {
    title: 'Inventory',
    subtitle: 'Produced, reserved, and available keycap stock with audit ledger',
  },
  analytics: {
    title: 'Analytics',
    subtitle: 'Filtered yield reports, machine runtime, and CSV export',
  },
  settings: {
    title: 'Settings',
    subtitle: 'Timezone, turnaround buffers, filament colors, and cloud/JSON backups',
  },
};

export const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const [localMode, setLocalMode] = useState<boolean>(false);
  const [authInitialized, setAuthInitialized] = useState<boolean>(false);
  const [ready, setReady] = useState<boolean>(false);
  const [syncStatus, setSyncStatus] = useState<string>('Connecting...');

  const [workspace, setWorkspace] = useState<ProductionWorkspaceV5>(() =>
    createFreshWorkspaceV5('local-owner')
  );
  const [activeNav, setActiveNav] = useState<NavSection>('dashboard');
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);
  const [modal, setModal] = useState<ModalConfig | null>(null);

  const v5Ref = useRef<DocumentReference | null>(null);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingWritesRef = useRef<number>(0);
  const serverClockOffsetMsRef = useRef<number>(0);
  const serverTimestampSupportedRef = useRef<boolean>(true);

  const getAuthoritativeNowMs = useCallback(
    () => Date.now() + serverClockOffsetMsRef.current,
    []
  );

  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  // 1-second live tick for active printing countdowns and real-time ETA recalculation
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now() + serverClockOffsetMsRef.current);
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Global multi-project Bambu fleet schedule (automatically updates on every state change & clock tick)
  const schedule = useMemo(
    () => computeGlobalSchedule(workspace, nowMs),
    [workspace, nowMs]
  );

  // Sync dark mode class on <html>
  useEffect(() => {
    const root = document.documentElement;
    if (workspace.settings.theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [workspace.settings.theme]);

  // Ensure selectedProjectId always points to a valid project when available
  useEffect(() => {
    const active = workspace.projects.filter((p) => p.status !== 'Archived');
    if (active.length > 0 && !workspace.projects.some((p) => p.id === selectedProjectId)) {
      setSelectedProjectId(active[0].id);
    }
  }, [workspace.projects, selectedProjectId]);

  const showAlert = useCallback((message: string, title?: string) => {
    setModal({
      type: 'alert',
      title,
      message,
      onClose: () => setModal(null),
    });
  }, []);

  const showConfirm = useCallback(
    (message: string, onConfirm: () => void, title?: string, confirmLabel?: string) => {
      setModal({
        type: 'confirm',
        title,
        message,
        confirmLabel,
        onConfirm,
        onClose: () => setModal(null),
      });
    },
    []
  );

  /**
   * Enforces strict schema & volumetric bounds matching `firebase-blueprint.json` and `firestore.rules`
   * before persisting to Firestore or localStorage.
   */
  const sanitizeForSave = (ws: ProductionWorkspaceV5, ownerId: string): ProductionWorkspaceV5 => {
    return {
      schemaVersion: 5,
      ownerId: ownerId.slice(0, 128),
      migratedFromV1: Boolean(ws.migratedFromV1),
      colors: ws.colors.slice(0, 50),
      machines: ws.machines.slice(0, 100),
      projects: ws.projects.slice(0, 500),
      jobs: ws.jobs.slice(0, 3000),
      presets: ws.presets.slice(0, 100),
      inventory: {
        physicalByColor: ws.inventory.physicalByColor,
        wastageByColor: ws.inventory.wastageByColor,
        movements: ws.inventory.movements.slice(0, 300),
      },
      log: ws.log.slice(0, 200),
      settings: ws.settings,
      updatedIso: new Date().toISOString(),
    };
  };

  const writeSnapshotWithServerTime = async (
    docRef: DocumentReference,
    snapshotPayload: ProductionWorkspaceV5
  ) => {
    if (serverTimestampSupportedRef.current) {
      try {
        await setDoc(docRef, {
          ...snapshotPayload,
          serverUpdatedAt: serverTimestamp(),
        });
        return;
      } catch (err: unknown) {
        const code =
          err && typeof err === 'object' && 'code' in err
            ? String((err as { code?: unknown }).code)
            : '';
        const msg = err instanceof Error ? err.message : String(err);
        if (
          code.includes('permission-denied') ||
          msg.toLowerCase().includes('missing or insufficient permissions')
        ) {
          // Live woopp-tracker rules may still enforce strict 12-key check before rules deploy; fall back cleanly
          serverTimestampSupportedRef.current = false;
        } else {
          throw err;
        }
      }
    }
    await setDoc(docRef, snapshotPayload);
  };

  const persistWorkspace = useCallback(
    (nextWs: ProductionWorkspaceV5) => {
      const authNowMs = Date.now() + serverClockOffsetMsRef.current;
      setNowMs(authNowMs);

      if (localMode) {
        const sanitized = sanitizeForSave(nextWs, 'local-owner');
        setWorkspace(sanitized);
        try {
          localStorage.setItem(STORAGE_KEY_V5, JSON.stringify(sanitized));
          setSyncStatus('Saved locally');
        } catch {
          setSyncStatus('Local storage full');
        }
        return;
      }

      if (!ready || !v5Ref.current || !user) {
        showAlert('Cloud connection is still initializing. Please try again in a moment.');
        return;
      }

      const sanitized = sanitizeForSave(nextWs, user.uid);
      setWorkspace(sanitized);
      const snapshotPayload = structuredClone(sanitized);
      const docRef = v5Ref.current;
      const docPath = `users/${user.uid}/tracker/v5_workspace`;

      pendingWritesRef.current += 1;
      setSyncStatus('Saving to Cloud...');

      writeQueueRef.current = writeQueueRef.current
        .catch(() => {})
        .then(() => writeSnapshotWithServerTime(docRef, snapshotPayload))
        .then(() => {
          pendingWritesRef.current -= 1;
          if (pendingWritesRef.current === 0) {
            setSyncStatus('Synced · Cloud Firestore');
          }
        })
        .catch((err: unknown) => {
          pendingWritesRef.current -= 1;
          const info = buildFirestoreErrorInfo(err, OperationType.WRITE, docPath);
          setSyncStatus('Queued / Sync error');
          showAlert(
            `Could not save workspace to Cloud Firestore: ${info.error}`,
            'Cloud Sync Notice'
          );
        });
    },
    [localMode, ready, user, showAlert]
  );

  // Firebase Auth & Non-Destructive v1 -> v5 Migration Lifecycle
  useEffect(() => {
    let unsubV5Snapshot: (() => void) | null = null;

    const unsubAuth = onAuthStateChanged(auth, async (firebaseUser) => {
      setAuthInitialized(true);
      if (unsubV5Snapshot) {
        unsubV5Snapshot();
        unsubV5Snapshot = null;
      }
      v5Ref.current = null;
      setReady(false);
      pendingWritesRef.current = 0;
      writeQueueRef.current = Promise.resolve();
      setUser(firebaseUser);

      if (!firebaseUser) {
        return;
      }

      setLocalMode(false);
      setSyncStatus('Loading workspace...');

      const v5Path = `users/${firebaseUser.uid}/tracker/v5_workspace`;
      const userV5DocRef = doc(db, 'users', firebaseUser.uid, 'tracker', 'v5_workspace');
      const userLegacyDocRef = doc(db, 'users', firebaseUser.uid, 'tracker', 'main');
      v5Ref.current = userV5DocRef;

      // Attach real-time listener to v5_workspace
      unsubV5Snapshot = onSnapshot(
        userV5DocRef,
        async (v5Snap) => {
          if (pendingWritesRef.current > 0) return;

          if (v5Snap.exists()) {
            const rawDoc = v5Snap.data() as Record<string, unknown>;
            const rawServerTs = rawDoc.serverUpdatedAt as
              | { toMillis?: () => number }
              | undefined;

            let resolvedServerMs: number | null = null;
            if (
              rawServerTs &&
              typeof rawServerTs.toMillis === 'function' &&
              !v5Snap.metadata.hasPendingWrites
            ) {
              resolvedServerMs = rawServerTs.toMillis();
              if (!v5Snap.metadata.fromCache) {
                serverClockOffsetMsRef.current = resolvedServerMs - Date.now();
                setNowMs(resolvedServerMs);
              }
            }

            let normalized = normalizeWorkspaceV5(
              rawDoc as unknown as ProductionWorkspaceV5,
              firebaseUser.uid
            );

            // Reconcile pending job start/completion timestamps with authoritative Firebase server time
            if (resolvedServerMs !== null) {
              let reconciledAny = false;
              const reconciledJobs = normalized.jobs.map((j) => {
                if (j.pendingServerStartSync && j.stage === 'Printing') {
                  reconciledAny = true;
                  const machine =
                    normalized.machines.find((m) => m.id === j.machineId) || null;
                  const effMins = getEffectivePrintMinutes(j, machine);
                  return {
                    ...j,
                    startedAtMs: resolvedServerMs,
                    runResumedAtMs: j.isPaused ? j.runResumedAtMs : resolvedServerMs,
                    estimatedFinishAtMs: j.isPaused
                      ? null
                      : resolvedServerMs + effMins * 60_000,
                    pendingServerStartSync: false,
                  };
                }
                if (j.pendingServerCompleteSync && j.stage === 'Completed') {
                  reconciledAny = true;
                  const calcActual =
                    (j.accumulatedElapsedSeconds || 0) > 0
                      ? Math.max(1, Math.round((j.accumulatedElapsedSeconds || 0) / 60))
                      : j.startedAtMs && resolvedServerMs > j.startedAtMs
                      ? Math.max(1, Math.round((resolvedServerMs - j.startedAtMs) / 60_000))
                      : j.actualMinutes;
                  return {
                    ...j,
                    actualCompletedAtMs: resolvedServerMs,
                    completedIso: new Date(resolvedServerMs).toISOString(),
                    actualMinutes: calcActual,
                    pendingServerCompleteSync: false,
                  };
                }
                return j;
              });

              if (reconciledAny) {
                normalized = sanitizeForSave(
                  { ...normalized, jobs: reconciledJobs },
                  firebaseUser.uid
                );
                pendingWritesRef.current += 1;
                writeQueueRef.current = writeQueueRef.current
                  .catch(() => {})
                  .then(() =>
                    writeSnapshotWithServerTime(userV5DocRef, structuredClone(normalized))
                  )
                  .finally(() => {
                    pendingWritesRef.current = Math.max(0, pendingWritesRef.current - 1);
                  });
              }
            }

            setWorkspace(normalized);
            setReady(true);
            setSyncStatus('Synced · Cloud Firestore');
            return;
          }

          // v5_workspace does not exist yet -> Check legacy v1 `tracker/main` without modifying it!
          try {
            setSyncStatus('Checking legacy v1 records...');
            const legacySnap = await getDoc(userLegacyDocRef);
            let bootstrapped: ProductionWorkspaceV5;

            if (legacySnap.exists()) {
              const legacyData = legacySnap.data() as LegacyTrackerState;
              bootstrapped = migrateFromLegacyV1(legacyData, firebaseUser.uid);
            } else {
              bootstrapped = createFreshWorkspaceV5(firebaseUser.uid);
            }

            const sanitized = sanitizeForSave(bootstrapped, firebaseUser.uid);
            setWorkspace(sanitized);
            setReady(true);

            pendingWritesRef.current += 1;
            setSyncStatus('Saving v5 migration...');
            writeQueueRef.current = writeQueueRef.current
              .catch(() => {})
              .then(() => setDoc(userV5DocRef, structuredClone(sanitized)))
              .then(() => {
                pendingWritesRef.current -= 1;
                if (pendingWritesRef.current === 0) {
                  setSyncStatus('Synced · Cloud Firestore');
                }
              })
              .catch(() => {
                pendingWritesRef.current -= 1;
                setSyncStatus('Read-only (check rules)');
              });
          } catch (legacyErr: unknown) {
            const msg = legacyErr instanceof Error ? legacyErr.message : String(legacyErr);
            if (msg.toLowerCase().includes('offline')) {
              const fallback = createFreshWorkspaceV5(firebaseUser.uid);
              setWorkspace(sanitizeForSave(fallback, firebaseUser.uid));
              setReady(true);
              setSyncStatus('Offline Cache Mode');
            } else {
              setSyncStatus('Firestore error');
              showAlert(
                `Could not read legacy production records: ${msg}`,
                'Database Connection Notice'
              );
            }
          }
        },
        (snapErr: unknown) => {
          const msg = snapErr instanceof Error ? snapErr.message : String(snapErr);
          // Fallback to legacy v1 read if v5_workspace rule hasn't been deployed yet on woopp-tracker
          getDoc(userLegacyDocRef)
            .then((legacySnap) => {
              if (legacySnap.exists()) {
                const migrated = migrateFromLegacyV1(
                  legacySnap.data() as LegacyTrackerState,
                  firebaseUser.uid
                );
                setWorkspace(sanitizeForSave(migrated, firebaseUser.uid));
                setReady(true);
                setSyncStatus('Loaded v1 · Deploy v5 rules to save');
              } else {
                setReady(false);
                setSyncStatus('Permission / Network notice');
              }
            })
            .catch(() => {
              setReady(false);
              setSyncStatus('Permission / Network notice');
            });

          showAlert(
            `Unable to subscribe to Cloud Firestore (${v5Path}):\n${msg}\n\nNote: If your woopp-tracker Firestore Security Rules only allow 'tracker/main', deploy the updated firestore.rules in your Firebase Console to enable v5 cloud writes.`,
            'Firestore Access Notice'
          );
        }
      );
    });

    return () => {
      unsubAuth();
      if (unsubV5Snapshot) unsubV5Snapshot();
    };
  }, [showAlert]);

  const enterLocalWorkspace = () => {
    try {
      const savedV5 = localStorage.getItem(STORAGE_KEY_V5);
      if (savedV5) {
        const parsed = JSON.parse(savedV5) as ProductionWorkspaceV5;
        setWorkspace(normalizeWorkspaceV5(parsed, 'local-owner'));
      } else {
        // Also check if user had local v1 data in browser storage!
        const savedV1 = localStorage.getItem(STORAGE_KEY_V1);
        if (savedV1) {
          const parsedV1 = JSON.parse(savedV1) as LegacyTrackerState;
          if (Array.isArray(parsedV1.jobs) && Array.isArray(parsedV1.colors)) {
            const migrated = migrateFromLegacyV1(parsedV1, 'local-owner');
            setWorkspace(migrated);
            localStorage.setItem(STORAGE_KEY_V5, JSON.stringify(migrated));
          } else {
            setWorkspace(createFreshWorkspaceV5('local-owner'));
          }
        } else {
          setWorkspace(createFreshWorkspaceV5('local-owner'));
        }
      }
    } catch {
      setWorkspace(createFreshWorkspaceV5('local-owner'));
    }
    setLocalMode(true);
    setReady(true);
    setSyncStatus('Local Browser Storage');
  };

  const handleSignOut = async () => {
    if (localMode) {
      setLocalMode(false);
      setReady(false);
      return;
    }
    await signOut(auth);
  };

  const appendLog = (
    currentLog: ProductionWorkspaceV5['log'],
    category: ProductionWorkspaceV5['log'][0]['category'],
    msg: string,
    projectId?: string
  ) => {
    const authNow = getAuthoritativeNowMs();
    const tz = workspace.settings.timezone || DEFAULT_TIMEZONE;
    return [
      {
        id: `log-${authNow}-${Math.random().toString(36).slice(2, 6)}`,
        at: formatDateTimeDDMMYYYY(authNow, tz),
        timestampIso: new Date(authNow).toISOString(),
        category,
        msg,
        projectId,
      },
      ...currentLog,
    ];
  };

  // --- Handlers for Projects ---
  const handleSaveProject = (project: ProductionProject, isNew: boolean) => {
    const nextProjects = isNew
      ? [project, ...workspace.projects]
      : workspace.projects.map((p) => (p.id === project.id ? project : p));

    const nextLog = appendLog(
      workspace.log,
      'project',
      `${isNew ? 'Created' : 'Updated'} project "${project.name}" (${project.salesChannel})`,
      project.id
    );

    setSelectedProjectId(project.id);
    persistWorkspace({
      ...workspace,
      projects: nextProjects,
      log: nextLog,
    });
  };

  const handleUpdateProjectStatus = (projectId: string, status: ProjectStatus) => {
    const target = workspace.projects.find((p) => p.id === projectId);
    if (!target) return;

    if (status === 'Archived') {
      const activePrints = workspace.jobs.some(
        (j) => j.projectId === projectId && j.stage === 'Printing'
      );
      if (activePrints) {
        showAlert(
          'Finish or pause active Printing jobs in this project before archiving.',
          'Active Print In Progress'
        );
        return;
      }
    }

    const nextProjects = workspace.projects.map((p) =>
      p.id === projectId ? { ...p, status, updatedIso: new Date().toISOString() } : p
    );
    const nextLog = appendLog(
      workspace.log,
      'project',
      `Project "${target.name}" marked as ${status}`,
      projectId
    );
    persistWorkspace({ ...workspace, projects: nextProjects, log: nextLog });
  };

  // --- Handlers for Auto Plate Planner & Presets ---
  const handleSavePreset = (preset: AlphabetPreset) => {
    const nextPresets = [preset, ...workspace.presets];
    const nextLog = appendLog(
      workspace.log,
      'system',
      `Saved alphabet preset "${preset.name}" (${countLetters(preset.letters)} pcs)`
    );
    persistWorkspace({ ...workspace, presets: nextPresets, log: nextLog });
  };

  const handleDeletePreset = (presetId: string) => {
    persistWorkspace({
      ...workspace,
      presets: workspace.presets.filter((p) => p.id !== presetId),
    });
  };

  const handleCommitGeneratedPlates = (params: {
    projectId: string;
    colorId: string;
    plateCapacity: number;
    targetLetters: LettersMap;
    carryForwardLetters: LettersMap;
    confirmedPlates: DraftPlatePreview[];
  }) => {
    const project = workspace.projects.find((p) => p.id === params.projectId);
    const color = workspace.colors.find((c) => c.id === params.colorId);
    if (!project || !color) return;

    const nowIso = new Date().toISOString();

    // Keep all jobs from other projects/colors, AND strictly preserve Completed + Printing jobs for this project+color!
    const keptJobs = workspace.jobs.filter((j) => {
      if (j.projectId !== params.projectId || j.colorId !== params.colorId) return true;
      return j.stage === 'Completed' || j.stage === 'Printing';
    });

    const createdJobs: ProductionJob[] = params.confirmedPlates.map((draft, idx) => ({
      id: `job-${Date.now()}-${idx}-${params.colorId}`,
      projectId: params.projectId,
      colorId: params.colorId,
      plateNumber: draft.plateNumber,
      plateCapacity: params.plateCapacity,
      letters: compactLettersMap(draft.letters),
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
    }));

    const nextTargetsByColor = {
      ...project.targetsByColor,
      [params.colorId]: params.targetLetters,
    };
    const nextCarryByColor = {
      ...project.carryForwardByColor,
      [params.colorId]: params.carryForwardLetters,
    };

    const updatedProjectTargetQty = project.assignedColorIds.reduce(
      (sum, cid) => sum + countLetters(nextTargetsByColor[cid]),
      0
    );

    const nextProjects = workspace.projects.map((p) =>
      p.id === project.id
        ? {
            ...p,
            plateCapacity: params.plateCapacity,
            targetsByColor: nextTargetsByColor,
            carryForwardByColor: nextCarryByColor,
            targetQuantity: updatedProjectTargetQty,
            updatedIso: nowIso,
          }
        : p
    );

    const carryCount = countLetters(params.carryForwardLetters);
    const nextLog = appendLog(
      workspace.log,
      'plate',
      `${project.name} · ${color.name}: Generated ${createdJobs.length} plate(s)${
        carryCount > 0 ? ` and carried forward ${carryCount} pcs` : ''
      }. Locked Completed/Printing plates preserved.`,
      project.id
    );

    persistWorkspace({
      ...workspace,
      projects: nextProjects,
      jobs: [...keptJobs, ...createdJobs],
      log: nextLog,
    });

    showAlert(
      `Saved ${createdJobs.length} plate(s) for ${project.name} (${color.name}).${
        carryCount > 0 ? `\nCarried forward ${carryCount} remainder keycaps.` : ''
      }`,
      'Plates Added to Queue'
    );
  };

  // --- Handlers for Kanban, Smart ETA Timers & Job Metadata ---
  const handleTransitionStage = (
    jobId: string,
    nextStage: KanbanStage,
    opts?: { machineId?: string | null; actualMinutes?: number; failureReason?: string }
  ) => {
    const result = transitionJobState(workspace, jobId, nextStage, {
      ...opts,
      nowMs: getAuthoritativeNowMs(),
    });
    if (result.error) {
      showAlert(result.error, 'Stage Transition Blocked');
      return;
    }
    if (result.nextWorkspace) {
      persistWorkspace(result.nextWorkspace);
    }
  };

  const handlePauseOrResume = (
    jobId: string,
    action: 'pause' | 'resume' | 'update_remaining',
    overrideRemainingMinutes?: number
  ) => {
    const result = pauseOrResumePrintingJob(
      workspace,
      jobId,
      action,
      overrideRemainingMinutes,
      getAuthoritativeNowMs()
    );
    if (result.error) {
      showAlert(result.error, 'Print Timer Notice');
      return;
    }
    if (result.nextWorkspace) {
      persistWorkspace(result.nextWorkspace);
    }
  };

  const handleUpdateJobMetadata = (
    jobId: string,
    updates: Partial<
      Pick<
        ProductionJob,
        | 'machineId'
        | 'estimatedMinutes'
        | 'actualMinutes'
        | 'notes'
        | 'slicerVerified'
        | 'failureReason'
        | 'machineDurationOverrides'
      >
    >
  ) => {
    const job = workspace.jobs.find((j) => j.id === jobId);
    if (!job) return;

    const authNow = getAuthoritativeNowMs();

    // If changing machine while job is actively Printing, enforce overlap & availability rules
    if (updates.machineId !== undefined && job.stage === 'Printing') {
      const result = transitionJobState(workspace, jobId, 'Printing', {
        machineId: updates.machineId,
        nowMs: authNow,
      });
      if (result.error) {
        showAlert(result.error, 'Machine Assignment Blocked');
        return;
      }
      if (result.nextWorkspace) {
        persistWorkspace(result.nextWorkspace);
      }
      return;
    }

    const nextJobs = workspace.jobs.map((j) => {
      if (j.id !== jobId) return j;
      const merged: ProductionJob = {
        ...j,
        ...updates,
        updatedIso: new Date(authNow).toISOString(),
      };

      // Recalculate live finish ETA if Bambu Studio duration or printer override was updated during an active print
      if (
        merged.stage === 'Printing' &&
        !merged.isPaused &&
        (updates.estimatedMinutes !== undefined ||
          updates.machineDurationOverrides !== undefined)
      ) {
        const machine =
          workspace.machines.find((m) => m.id === merged.machineId) || null;
        const effMins = getEffectivePrintMinutes(merged, machine);
        const alreadyElapsedSecs =
          (merged.accumulatedElapsedSeconds || 0) +
          (merged.runResumedAtMs
            ? Math.max(0, Math.floor((authNow - merged.runResumedAtMs) / 1000))
            : merged.startedAtMs
            ? Math.max(0, Math.floor((authNow - merged.startedAtMs) / 1000))
            : 0);
        const remSecs = Math.max(0, effMins * 60 - alreadyElapsedSecs);
        merged.estimatedFinishAtMs = authNow + remSecs * 1000;
      }

      return merged;
    });

    persistWorkspace({ ...workspace, jobs: nextJobs });
  };

  const handleCopyQueueSummary = (jobsToCopy: ProductionJob[]) => {
    const text = jobsToCopy
      .map((j) => {
        const p = workspace.projects.find((pr) => pr.id === j.projectId);
        const c = workspace.colors.find((cl) => cl.id === j.colorId);
        const m = workspace.machines.find((mc) => mc.id === j.machineId);
        const lettersStr = Object.entries(j.letters)
          .map(([k, v]) => `${k}${v}`)
          .join(' ');
        return `${p?.name || 'Project'} | ${c?.name || 'Color'} | Plate ${j.plateNumber} | ${
          j.stage
        } | ${m?.name || 'Unassigned'} | ${lettersStr}`;
      })
      .join('\n');

    if (navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(() => showAlert('Print queue summary copied to clipboard.'))
        .catch(() =>
          setModal({
            type: 'copy',
            title: 'Copy Print Queue',
            message: 'Select and copy the formatted queue text below:',
            copyText: text,
            onClose: () => setModal(null),
          })
        );
    } else {
      setModal({
        type: 'copy',
        title: 'Copy Print Queue',
        message: 'Select and copy the formatted queue text below:',
        copyText: text,
        onClose: () => setModal(null),
      });
    }
  };

  // --- Handlers for Printer Fleet ---
  const handleAddMachine = (name: string, model: string, capacity: number): boolean => {
    if (workspace.machines.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
      showAlert(`A printer named "${name}" already exists in your fleet.`);
      return false;
    }
    const newMachine: PrinterMachine = {
      id: `machine-${Date.now()}`,
      name,
      model,
      status: 'Idle',
      plateCapacity: capacity,
      activeJobId: null,
      totalCompletedPlates: 0,
      totalFailedPlates: 0,
      totalPrintMinutes: 0,
      notes: '',
      speedFactor: 1,
      setupBufferMinutes: 0,
      maintenanceUntilMs: null,
    };
    persistWorkspace({
      ...workspace,
      machines: [...workspace.machines, newMachine],
      log: appendLog(workspace.log, 'machine', `Added printer ${name} (${model})`),
    });
    return true;
  };

  const handleUpdateMachine = (
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
    >
  ) => {
    const machine = workspace.machines.find((m) => m.id === machineId);
    if (!machine) return;

    if (
      updates.status &&
      (updates.status === 'Maintenance' || updates.status === 'Offline') &&
      workspace.jobs.some((j) => j.machineId === machineId && j.stage === 'Printing')
    ) {
      showAlert(
        `Complete or reassign the active print on ${machine.name} before switching to ${updates.status}.`
      );
      return;
    }

    const nextMachines = workspace.machines.map((m) =>
      m.id === machineId ? { ...m, ...updates } : m
    );
    const nextLog =
      updates.status && updates.status !== machine.status
        ? appendLog(
            workspace.log,
            'machine',
            `${machine.name} status changed: ${machine.status} → ${updates.status}`
          )
        : workspace.log;

    persistWorkspace({ ...workspace, machines: nextMachines, log: nextLog });
  };

  const handleRemoveMachine = (machineId: string) => {
    const machine = workspace.machines.find((m) => m.id === machineId);
    if (!machine) return;
    if (workspace.jobs.some((j) => j.machineId === machineId)) {
      showAlert(
        `${machine.name} is still referenced by print jobs. Reassign those jobs before removing the printer.`
      );
      return;
    }
    showConfirm(
      `Remove printer "${machine.name}" from your fleet?`,
      () => {
        persistWorkspace({
          ...workspace,
          machines: workspace.machines.filter((m) => m.id !== machineId),
          log: appendLog(workspace.log, 'machine', `Removed printer ${machine.name}`),
        });
      },
      'Remove Printer',
      'Remove'
    );
  };

  // --- Handlers for Inventory Allocation, Wastage & Adjustments ---
  const handleManualStockAction = (params: {
    mode: 'adjustment' | 'wastage' | 'allocate';
    colorId: string;
    projectId?: string;
    letter: string;
    quantity: number;
    reason: string;
  }) => {
    const { mode, colorId, projectId, letter, quantity, reason } = params;
    if (!ABC.includes(letter) || quantity === 0) return;

    const nowIso = new Date().toISOString();
    const colorName = workspace.colors.find((c) => c.id === colorId)?.name || colorId;

    if (mode === 'allocate') {
      if (!projectId) {
        showAlert('Select an active project to allocate stock.');
        return;
      }
      const project = workspace.projects.find((p) => p.id === projectId);
      if (!project) return;

      const availableMap = getAvailableStockForColor(workspace, colorId);
      const currentProjAlloc =
        project.allocatedStockByColor?.[colorId]?.[letter] || 0;

      if (quantity > 0 && quantity > (availableMap[letter] || 0)) {
        showAlert(
          `Insufficient unallocated stock for letter ${letter} (${colorName}). Available: ${
            availableMap[letter] || 0
          } pcs.`
        );
        return;
      }
      if (quantity < 0 && Math.abs(quantity) > currentProjAlloc) {
        showAlert(
          `Cannot release ${Math.abs(quantity)} pcs — project "${
            project.name
          }" currently holds ${currentProjAlloc} pcs of letter ${letter}.`
        );
        return;
      }

      const nextAllocForColor = {
        ...normalizeAlphabetMap(project.allocatedStockByColor?.[colorId]),
        [letter]: currentProjAlloc + quantity,
      };

      const nextProjects = workspace.projects.map((p) =>
        p.id === projectId
          ? {
              ...p,
              allocatedStockByColor: {
                ...p.allocatedStockByColor,
                [colorId]: nextAllocForColor,
              },
              updatedIso: nowIso,
            }
          : p
      );

      persistWorkspace({
        ...workspace,
        projects: nextProjects,
        inventory: {
          ...workspace.inventory,
          movements: [
            {
              id: `tx-alloc-${Date.now()}`,
              type: 'PROJECT_ALLOCATION',
              jobId: null,
              projectId,
              colorId,
              deltas: { [letter]: quantity },
              reason: `${project.name} (${project.salesChannel}): ${reason}`,
              timestampIso: nowIso,
            },
            ...workspace.inventory.movements,
          ],
        },
        log: appendLog(
          workspace.log,
          'inventory',
          `${quantity > 0 ? 'Reserved' : 'Released'} ${Math.abs(quantity)}×${letter} (${colorName}) for ${project.name}`,
          projectId
        ),
      });
      return;
    }

    if (mode === 'wastage') {
      const rejectQty = Math.abs(quantity);
      const avail = getAvailableStockForColor(workspace, colorId)[letter] || 0;
      if (rejectQty > avail) {
        showAlert(
          `Cannot deduct ${rejectQty} pcs as wastage from available stock (${avail} pcs unreserved). Release reserved stock or perform a stock audit first.`
        );
        return;
      }

      const nextPhysColor = {
        ...normalizeAlphabetMap(workspace.inventory.physicalByColor[colorId]),
      };
      nextPhysColor[letter] = Math.max(0, (nextPhysColor[letter] || 0) - rejectQty);

      const nextWastageColor = {
        ...normalizeAlphabetMap(workspace.inventory.wastageByColor[colorId]),
      };
      nextWastageColor[letter] = (nextWastageColor[letter] || 0) + rejectQty;

      persistWorkspace({
        ...workspace,
        inventory: {
          physicalByColor: {
            ...workspace.inventory.physicalByColor,
            [colorId]: nextPhysColor,
          },
          wastageByColor: {
            ...workspace.inventory.wastageByColor,
            [colorId]: nextWastageColor,
          },
          movements: [
            {
              id: `tx-waste-${Date.now()}`,
              type: 'WASTAGE_REJECT',
              jobId: null,
              projectId: null,
              colorId,
              deltas: { [letter]: -rejectQty },
              reason,
              timestampIso: nowIso,
            },
            ...workspace.inventory.movements,
          ],
        },
        log: appendLog(
          workspace.log,
          'inventory',
          `Logged wastage: -${rejectQty}×${letter} (${colorName}) — ${reason}`
        ),
      });
      return;
    }

    // Manual Adjustment (+/-)
    const currentPhys =
      normalizeAlphabetMap(workspace.inventory.physicalByColor[colorId])[letter] || 0;
    const reserved = getReservedStockForColor(workspace, colorId)[letter] || 0;
    const afterAdjust = currentPhys + quantity;
    if (afterAdjust < reserved) {
      showAlert(
        `Adjustment would drop physical stock (${afterAdjust}) below reserved project allocations (${reserved} pcs) for letter ${letter}.`
      );
      return;
    }

    const nextPhysColor = {
      ...normalizeAlphabetMap(workspace.inventory.physicalByColor[colorId]),
      [letter]: Math.max(0, afterAdjust),
    };

    persistWorkspace({
      ...workspace,
      inventory: {
        ...workspace.inventory,
        physicalByColor: {
          ...workspace.inventory.physicalByColor,
          [colorId]: nextPhysColor,
        },
        movements: [
          {
            id: `tx-adj-${Date.now()}`,
            type: 'MANUAL_ADJUSTMENT',
            jobId: null,
            projectId: null,
            colorId,
            deltas: { [letter]: quantity },
            reason,
            timestampIso: nowIso,
          },
          ...workspace.inventory.movements,
        ],
      },
      log: appendLog(
        workspace.log,
        'inventory',
        `Stock adjustment: ${quantity > 0 ? `+${quantity}` : quantity}×${letter} (${colorName}) — ${reason}`
      ),
    });
  };

  // --- Handlers for Settings, Smart Scheduling Defaults, Colors & Backups ---
  const handleUpdateWorkspaceDefaults = (params: {
    defaultPlateCapacity: number;
    defaultProductType: string;
    turnaroundBufferMinutes: number;
    timezone: string;
  }) => {
    persistWorkspace({
      ...workspace,
      settings: {
        ...workspace.settings,
        defaultPlateCapacity: params.defaultPlateCapacity,
        defaultProductType: params.defaultProductType,
        turnaroundBufferMinutes: params.turnaroundBufferMinutes,
        timezone: params.timezone,
      },
      log: appendLog(
        workspace.log,
        'system',
        `Updated defaults: ${params.defaultPlateCapacity} pcs/plate, ${params.turnaroundBufferMinutes}m buffer, TZ ${params.timezone}`
      ),
    });
    showAlert('Production & scheduling settings updated.');
  };

  const handleUpdateBufferMinutes = (bufferMins: number) => {
    const clamped = Math.max(0, Math.min(240, Math.round(bufferMins)));
    persistWorkspace({
      ...workspace,
      settings: {
        ...workspace.settings,
        turnaroundBufferMinutes: clamped,
      },
      log: appendLog(
        workspace.log,
        'system',
        `Updated plate turnaround buffer to ${clamped}m`
      ),
    });
  };

  const handleAddColor = (name: string, hex: string) => {
    const newId = `color-${Date.now()}`;
    persistWorkspace({
      ...workspace,
      colors: [...workspace.colors, { id: newId, name, hex }],
      inventory: {
        ...workspace.inventory,
        physicalByColor: {
          ...workspace.inventory.physicalByColor,
          [newId]: emptyAlphabetMap(),
        },
        wastageByColor: {
          ...workspace.inventory.wastageByColor,
          [newId]: emptyAlphabetMap(),
        },
      },
      log: appendLog(workspace.log, 'system', `Added filament color "${name}"`),
    });
  };

  const handleRenameColor = (colorId: string, name: string, hex: string) => {
    persistWorkspace({
      ...workspace,
      colors: workspace.colors.map((c) => (c.id === colorId ? { ...c, name, hex } : c)),
    });
  };

  const handleExportBackup = () => {
    const blob = new Blob([JSON.stringify(workspace, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const todayStr = formatDateDDMMYYYY(new Date()).replace(/\//g, '-');
    a.download = `woopp-v5-backup-${todayStr}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleImportBackup = async (file: File) => {
    try {
      const rawText = await file.text();
      const parsed = JSON.parse(rawText);
      const currentOwner = user?.uid || 'local-owner';

      let importedWs: ProductionWorkspaceV5;
      if (parsed && parsed.schemaVersion === 5 && Array.isArray(parsed.projects)) {
        importedWs = normalizeWorkspaceV5(parsed as ProductionWorkspaceV5, currentOwner);
      } else if (parsed && Array.isArray(parsed.colors) && Array.isArray(parsed.jobs)) {
        // Legacy v1 JSON backup file -> seamlessly upgrade via migration engine!
        importedWs = migrateFromLegacyV1(parsed as LegacyTrackerState, currentOwner);
      } else {
        throw new Error('Unrecognized backup JSON format.');
      }

      showConfirm(
        `Restore backup containing ${importedWs.projects.length} project(s) and ${importedWs.jobs.length} plate(s)?`,
        () => {
          persistWorkspace(importedWs);
          setTimeout(() => showAlert('Workspace backup restored successfully.'), 60);
        },
        'Confirm Backup Restore',
        'Restore Data'
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Invalid file';
      showAlert(`Backup import failed: ${msg}`);
    }
  };

  const handleClearActivityLog = () => {
    showConfirm(
      'Clear activity log history? (Projects, plates, machines, and inventory ledger remain intact.)',
      () => {
        persistWorkspace({ ...workspace, log: [] });
      },
      'Clear Activity Log',
      'Clear Log'
    );
  };

  const handleToggleTheme = () => {
    const nextTheme = workspace.settings.theme === 'dark' ? 'light' : 'dark';
    persistWorkspace({
      ...workspace,
      settings: { ...workspace.settings, theme: nextTheme },
    });
  };

  const isAuthenticated = Boolean(user) || localMode;

  if (!authInitialized && !localMode) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#faf9fd] dark:bg-[#111018] text-sm text-neutral-500">
        Connecting to WOOPP Production System...
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <>
        <AuthSection onOfflineDemo={enterLocalWorkspace} />
        <DialogModal modal={modal} />
      </>
    );
  }

  const meta = SECTION_META[activeNav];

  const getHeaderPrimaryAction = () => {
    switch (activeNav) {
      case 'dashboard':
        return { label: 'Open ETA Dashboard', onClick: () => setActiveNav('eta') };
      case 'eta':
        return { label: 'Production Timeline', onClick: () => setActiveNav('timeline') };
      case 'timeline':
        return { label: 'Print Queue', onClick: () => setActiveNav('queue') };
      case 'projects':
        return { label: 'Open Plate Planner', onClick: () => setActiveNav('planner') };
      case 'planner':
        return { label: 'View Print Queue', onClick: () => setActiveNav('queue') };
      case 'queue':
        return { label: 'Production Timeline', onClick: () => setActiveNav('timeline') };
      default:
        return { label: 'Backup JSON', onClick: handleExportBackup };
    }
  };

  return (
    <div className="min-h-screen flex bg-[#faf9fd] dark:bg-[#111018] text-neutral-900 dark:text-neutral-100">
      <Sidebar
        activeNav={activeNav}
        onSelectNav={setActiveNav}
        theme={workspace.settings.theme}
        onToggleTheme={handleToggleTheme}
        syncStatus={syncStatus}
        userEmail={user?.email || ''}
        isLocalMode={localMode}
        onSignOut={handleSignOut}
        mobileOpen={mobileMenuOpen}
        onSetMobileOpen={setMobileMenuOpen}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        <TopHeader
          sectionTitle={meta.title}
          subtitle={meta.subtitle}
          onOpenMobileMenu={() => setMobileMenuOpen(true)}
          primaryAction={getHeaderPrimaryAction()}
        />

        <main className="flex-1 max-w-[1320px] w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
          {activeNav === 'dashboard' && (
            <DashboardView
              workspace={workspace}
              schedule={schedule}
              onNavigate={setActiveNav}
              onSelectProject={setSelectedProjectId}
            />
          )}

          {activeNav === 'eta' && (
            <EtaDashboardView
              workspace={workspace}
              schedule={schedule}
              onNavigate={setActiveNav}
              onSelectProject={setSelectedProjectId}
              onPauseOrResume={handlePauseOrResume}
              onTransitionStage={handleTransitionStage}
              onUpdateBufferMinutes={handleUpdateBufferMinutes}
            />
          )}

          {activeNav === 'timeline' && (
            <ProductionTimelineView
              workspace={workspace}
              schedule={schedule}
              onAssignMachineToQueuedJob={(jobId, machineId) =>
                handleUpdateJobMetadata(jobId, { machineId })
              }
            />
          )}

          {activeNav === 'projects' && (
            <ProjectsView
              workspace={workspace}
              selectedProjectId={selectedProjectId}
              onSelectProject={setSelectedProjectId}
              onSaveProject={handleSaveProject}
              onUpdateProjectStatus={handleUpdateProjectStatus}
              onNavigate={setActiveNav}
            />
          )}

          {activeNav === 'planner' && (
            <AutoPlannerView
              workspace={workspace}
              selectedProjectId={selectedProjectId}
              onSelectProject={setSelectedProjectId}
              onSavePreset={handleSavePreset}
              onDeletePreset={handleDeletePreset}
              onCommitGeneratedPlates={handleCommitGeneratedPlates}
              onAlert={showAlert}
            />
          )}

          {activeNav === 'queue' && (
            <KanbanQueueView
              workspace={workspace}
              schedule={schedule}
              selectedProjectId={selectedProjectId}
              onSelectProject={setSelectedProjectId}
              onTransitionStage={handleTransitionStage}
              onPauseOrResume={handlePauseOrResume}
              onUpdateJobMetadata={handleUpdateJobMetadata}
              onCopyQueueSummary={handleCopyQueueSummary}
            />
          )}

          {activeNav === 'machines' && (
            <MachinesView
              workspace={workspace}
              schedule={schedule}
              onAddMachine={handleAddMachine}
              onUpdateMachine={handleUpdateMachine}
              onRemoveMachine={handleRemoveMachine}
              onAssignAndStartJob={(jobId, machineId) =>
                handleTransitionStage(jobId, 'Printing', { machineId })
              }
              onPauseOrResume={handlePauseOrResume}
              onTransitionStage={handleTransitionStage}
            />
          )}

          {activeNav === 'inventory' && (
            <InventoryView
              workspace={workspace}
              onManualStockAction={handleManualStockAction}
            />
          )}

          {activeNav === 'analytics' && <AnalyticsView workspace={workspace} />}

          {activeNav === 'settings' && (
            <SettingsView
              workspace={workspace}
              onUpdateWorkspaceDefaults={handleUpdateWorkspaceDefaults}
              onAddColor={handleAddColor}
              onRenameColor={handleRenameColor}
              onExportBackup={handleExportBackup}
              onImportBackup={handleImportBackup}
              onClearActivityLog={handleClearActivityLog}
            />
          )}
        </main>
      </div>

      <DialogModal modal={modal} />
    </div>
  );
};

export default App;
