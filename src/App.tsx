import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, signOut, User } from 'firebase/auth';
import {
  doc,
  DocumentReference,
  getDocFromServer,
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
  countCharms,
  countLetters,
  countPlateKeycaps,
  createFreshWorkspaceV5,
  emptyAlphabetMap,
  formatPlateItemsText,
  migrateFromLegacyV1,
  normalizeAlphabetMap,
  normalizeWorkspaceV5,
} from './constants';
import {
  AdminActorContext,
  AlphabetPreset,
  CharmsMap,
  EtaRecalibrationInput,
  KanbanStage,
  LegacyTrackerState,
  LettersMap,
  NavSection,
  PlateGenerationMode,
  PrinterMachine,
  ProductionJob,
  ProductionProject,
  ProductionWorkspaceV5,
  ProjectStatus,
} from './types';
import {
  applyMachineUpdate,
  archivePrintPlate,
  bulkArchivePrintPlates,
  bulkDeletePrintPlates,
  bulkRestorePrintPlates,
  cancelPrintingJob,
  clearProjectColorCarryForward,
  commitGeneratedPlatesToWorkspace,
  createActivityLogEntry,
  deletePrintPlate,
  DraftPlatePreview,
  getAvailableStockForColor,
  getReservedStockForColor,
  isAuthorizedAdmin,
  pauseOrResumePrintingJob,
  recalibratePrintingJobEta,
  restorePrintPlate,
  transitionJobState,
} from './utils/productionEngine';
import {
  buildFirestoreSetDocPayload,
  prepareWorkspaceForFirestore,
} from './utils/firestorePayload';
import {
  buildCloudWorkspaceFromLocalBackup,
  downloadUnsyncedLocalBackupJson,
  inspectUnsyncedLocalData,
} from './utils/legacyLocalBackup';
import {
  computeEffectiveDurationMs,
  computeJobCountdownSnapshot,
  resolveJobTimingFields,
  toUtcTimestampIso,
} from './utils/productionCountdown';
import { computeGlobalSchedule } from './utils/schedulingEngine';
import {
  DEFAULT_TIMEZONE,
  formatDateDDMMYYYY,
} from './utils/dateFormat';
import { Sidebar, TopHeader } from './components/Sidebar';
import { AuthSection } from './components/AuthSection';
import { EtaDashboardView } from './components/EtaDashboardView';
import { ProjectsView } from './components/ProjectsView';
import { AutoPlannerView } from './components/AutoPlannerView';
import { KanbanQueueView } from './components/KanbanQueueView';
import { MachinesView } from './components/MachinesView';
import { InventoryView } from './components/InventoryView';
import { AnalyticsView } from './components/AnalyticsView';
import { SettingsView } from './components/SettingsView';
import { DialogModal, ModalConfig } from './components/DialogModal';
import {
  BulkQueueActionKind,
  BulkQueueActionModal,
  CancelPrintingConfirmModal,
  DeletePlateConfirmModal,
} from './components/QueueLifecycleModals';

import {
  buildNavHash,
  resolveNavSection,
  SECTION_META,
} from './utils/navigation';

export const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const [authInitialized, setAuthInitialized] = useState<boolean>(false);
  const [ready, setReady] = useState<boolean>(false);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [connectionAttempt, setConnectionAttempt] = useState<number>(0);
  const [syncStatus, setSyncStatus] = useState<string>('Connecting to Cloud...');
  const [legacyBannerDismissed, setLegacyBannerDismissed] = useState<boolean>(false);

  // Read-only check for any prior unsynced browser data (never written to or deleted)
  const legacyLocalData = useMemo(() => inspectUnsyncedLocalData(), []);

  const initialWorkspace = useMemo(() => createFreshWorkspaceV5('pending-cloud-auth'), []);
  const [workspace, setWorkspace] = useState<ProductionWorkspaceV5>(initialWorkspace);
  const [activeNav, setActiveNav] = useState<NavSection>(() => {
    if (typeof window === 'undefined') return 'dashboard';
    return resolveNavSection(window.location.hash || window.location.pathname);
  });
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);
  const [modal, setModal] = useState<ModalConfig | null>(null);

  // Print Queue Lifecycle modal & concurrency state
  const [pendingDeleteJobId, setPendingDeleteJobId] = useState<string | null>(null);
  const [pendingCancelJobId, setPendingCancelJobId] = useState<string | null>(null);
  const [pendingBulkState, setPendingBulkState] = useState<{
    action: BulkQueueActionKind;
    jobIds: string[];
  } | null>(null);
  const [isLifecycleSaving, setIsLifecycleSaving] = useState<boolean>(false);
  const [busyJobIds, setBusyJobIds] = useState<Set<string>>(() => new Set());
  const busyJobIdsRef = useRef<Set<string>>(new Set());

  const v5Ref = useRef<DocumentReference | null>(null);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingWritesRef = useRef<number>(0);
  const lastConfirmedWorkspaceRef = useRef<ProductionWorkspaceV5>(initialWorkspace);
  const latestWorkspaceRef = useRef<ProductionWorkspaceV5>(initialWorkspace);
  const serverClockOffsetMsRef = useRef<number>(0);
  const serverTimestampSupportedRef = useRef<boolean>(true);
  const lastLocalWriteWindowRef = useRef<{
    startedClientMs: number;
    updatedIso: string;
    awaitingCalibration: boolean;
  } | null>(null);

  useEffect(() => {
    latestWorkspaceRef.current = workspace;
  }, [workspace]);

  const actorContext = useMemo<AdminActorContext>(
    () => ({
      uid: user?.uid ?? null,
      email: user?.email ?? null,
      isAnonymous: user?.isAnonymous ?? null,
    }),
    [user?.uid, user?.email, user?.isAnonymous]
  );

  const isAdmin = useMemo(
    () => isAuthorizedAdmin(actorContext, workspace),
    [actorContext, workspace]
  );

  const lockJobIds = useCallback((ids: string[]): boolean => {
    for (const id of ids) {
      if (busyJobIdsRef.current.has(id)) {
        return false;
      }
    }
    const next = new Set(busyJobIdsRef.current);
    for (const id of ids) {
      next.add(id);
    }
    busyJobIdsRef.current = next;
    setBusyJobIds(next);
    return true;
  }, []);

  const unlockJobIds = useCallback((ids: string[]) => {
    const next = new Set(busyJobIdsRef.current);
    for (const id of ids) {
      next.delete(id);
    }
    busyJobIdsRef.current = next;
    setBusyJobIds(next);
  }, []);

  const getAuthoritativeNowMs = useCallback(
    () => Date.now() + serverClockOffsetMsRef.current,
    []
  );

  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  // 1-second UI re-render tick + immediate wall-clock resync on tab visibility, focus, and wake from sleep
  useEffect(() => {
    const refreshWallClockNow = () => {
      setNowMs(Date.now() + serverClockOffsetMsRef.current);
    };

    const handleVisibilityChange = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        refreshWallClockNow();
      }
    };

    const timer = window.setInterval(refreshWallClockNow, 1000);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', refreshWallClockNow);
    window.addEventListener('pageshow', refreshWallClockNow);
    window.addEventListener('online', refreshWallClockNow);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', refreshWallClockNow);
      window.removeEventListener('pageshow', refreshWallClockNow);
      window.removeEventListener('online', refreshWallClockNow);
    };
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

  const handleNavigate = useCallback((target: NavSection | string) => {
    const resolved = resolveNavSection(target);
    setActiveNav(resolved);
    if (typeof window !== 'undefined') {
      const cleanPath = window.location.pathname.replace(
        /^\/(eta|eta-dashboard|smart-eta|timeline|production-timeline)\/?$/i,
        '/'
      );
      const nextHash = buildNavHash(resolved);
      const nextUrl = `${cleanPath}${window.location.search}${nextHash}`;
      const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (nextUrl !== currentUrl) {
        window.history.replaceState(null, '', nextUrl);
      }
    }
  }, []);

  // Preserve Dashboard bookmarks and redirect legacy #eta / /eta / #timeline links to Dashboard
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const syncFromLocation = () => {
      const raw = window.location.hash || window.location.pathname;
      const resolved = resolveNavSection(raw);
      setActiveNav(resolved);

      const lowerHash = window.location.hash.toLowerCase();
      const lowerPath = window.location.pathname.toLowerCase();
      const isLegacyRoute =
        lowerHash.includes('eta') ||
        lowerHash.includes('timeline') ||
        lowerHash === '#dashboard' ||
        lowerHash === '#/dashboard' ||
        /^\/(eta|eta-dashboard|smart-eta|timeline|production-timeline)\/?$/.test(lowerPath);

      if (isLegacyRoute) {
        const cleanPath = window.location.pathname.replace(
          /^\/(eta|eta-dashboard|smart-eta|timeline|production-timeline)\/?$/i,
          '/'
        );
        const nextHash = buildNavHash(resolved);
        window.history.replaceState(null, '', `${cleanPath}${window.location.search}${nextHash}`);
      }
    };

    syncFromLocation();
    window.addEventListener('hashchange', syncFromLocation);
    window.addEventListener('popstate', syncFromLocation);
    return () => {
      window.removeEventListener('hashchange', syncFromLocation);
      window.removeEventListener('popstate', syncFromLocation);
    };
  }, []);

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

  const writeSnapshotWithServerTime = async (
    docRef: DocumentReference,
    validatedPayload: ProductionWorkspaceV5,
    docPath: string
  ) => {
    if (serverTimestampSupportedRef.current) {
      try {
        const docWithServerTime = buildFirestoreSetDocPayload(
          {
            ...validatedPayload,
            serverUpdatedAt: serverTimestamp(),
          },
          docPath
        );
        lastLocalWriteWindowRef.current = {
          startedClientMs: Date.now(),
          updatedIso: validatedPayload.updatedIso,
          awaitingCalibration: true,
        };
        await setDoc(docRef, docWithServerTime);
        return;
      } catch (err: unknown) {
        lastLocalWriteWindowRef.current = null;
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
    const cleanDoc = buildFirestoreSetDocPayload({ ...validatedPayload }, docPath);
    await setDoc(docRef, cleanDoc);
  };

  /**
   * Validates, normalizes, and persists workspace changes exclusively to Firebase Cloud Firestore (`woopp-tracker`).
   * - Never writes to `localStorage` or falls back to local mode.
   * - Never passes `undefined` to `setDoc()`.
   * - Never displays failed saves as successful: rolls back UI state to `lastConfirmedWorkspaceRef` if persistence fails.
   */
  const persistWorkspace = useCallback(
    async (nextWs: ProductionWorkspaceV5): Promise<boolean> => {
      const authNowMs = Date.now() + serverClockOffsetMsRef.current;
      setNowMs(authNowMs);

      if (!ready || !v5Ref.current || !user) {
        setSyncStatus('Save failed · Not connected to Cloud');
        showAlert(
          'Cloud Firestore connection is not ready. Verify your internet connection and sign-in status before saving.',
          'Cloud Connection Required'
        );
        return false;
      }

      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setWorkspace(lastConfirmedWorkspaceRef.current);
        setSyncStatus('Save failed · Offline');
        showAlert(
          'Cannot save changes while offline. Reconnect to the internet so Cloud Firestore (woopp-tracker) can persist your update.',
          'Cloud Connection Unavailable'
        );
        return false;
      }

      const docRef = v5Ref.current;
      const docPath = `users/${user.uid}/tracker/v5_workspace`;

      let validated: ProductionWorkspaceV5;
      try {
        validated = prepareWorkspaceForFirestore(nextWs, user.uid, {
          documentLabel: docPath,
        });
      } catch (validationErr: unknown) {
        const msg =
          validationErr instanceof Error
            ? validationErr.message
            : String(validationErr);
        setWorkspace(lastConfirmedWorkspaceRef.current);
        setSyncStatus('Save failed · Invalid data');
        showAlert(
          `Workspace validation failed before saving to Cloud Firestore: ${msg}`,
          'Validation Error'
        );
        return false;
      }

      setWorkspace(validated);
      pendingWritesRef.current += 1;
      setSyncStatus('Saving to Cloud...');

      const currentWriteTask = writeQueueRef.current
        .catch(() => {})
        .then(async () => {
          await writeSnapshotWithServerTime(docRef, validated, docPath);
          lastConfirmedWorkspaceRef.current = validated;
          pendingWritesRef.current = Math.max(0, pendingWritesRef.current - 1);
          if (pendingWritesRef.current === 0) {
            setSyncStatus('Synced · Cloud Firestore');
          }
          return true;
        })
        .catch((err: unknown) => {
          pendingWritesRef.current = Math.max(0, pendingWritesRef.current - 1);
          if (pendingWritesRef.current === 0) {
            // Roll back unpersisted optimistic state so failed saves never appear succeeded
            setWorkspace(lastConfirmedWorkspaceRef.current);
          }
          const info = buildFirestoreErrorInfo(err, OperationType.WRITE, docPath);
          setSyncStatus('Save failed · Not synced');
          showAlert(
            `Could not save workspace to Cloud Firestore: ${info.error}`,
            'Cloud Sync Failed'
          );
          return false;
        });

      writeQueueRef.current = currentWriteTask.then(() => undefined);
      return currentWriteTask;
    },
    [ready, user, showAlert]
  );

  // Firebase Auth & Cloud-Only Non-Destructive v1 -> v5 Lifecycle (no local fallback)
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
      setCloudError(null);
      pendingWritesRef.current = 0;
      writeQueueRef.current = Promise.resolve();
      setUser(firebaseUser);

      if (!firebaseUser) {
        setSyncStatus('Signed out');
        return;
      }

      setSyncStatus('Loading Cloud Firestore...');

      const v5Path = `users/${firebaseUser.uid}/tracker/v5_workspace`;
      const userV5DocRef = doc(db, 'users', firebaseUser.uid, 'tracker', 'v5_workspace');
      const userLegacyDocRef = doc(db, 'users', firebaseUser.uid, 'tracker', 'main');
      v5Ref.current = userV5DocRef;

      // Attach real-time listener to Cloud Firestore v5_workspace
      unsubV5Snapshot = onSnapshot(
        userV5DocRef,
        async (v5Snap) => {
          // Measure minor server clock skew ONLY for a write initiated in this live session
          // (never from historical `serverUpdatedAt` on page load / browser reopen!).
          if (v5Snap.exists() && !v5Snap.metadata.hasPendingWrites && !v5Snap.metadata.fromCache) {
            const rawCheck = v5Snap.data() as Record<string, unknown>;
            const rawServerTs = rawCheck.serverUpdatedAt as
              | { toMillis?: () => number }
              | undefined;
            const writeWin = lastLocalWriteWindowRef.current;
            if (
              writeWin?.awaitingCalibration &&
              rawCheck.updatedIso === writeWin.updatedIso &&
              rawServerTs &&
              typeof rawServerTs.toMillis === 'function'
            ) {
              const finishedClientMs = Date.now();
              const rttMs = finishedClientMs - writeWin.startedClientMs;
              writeWin.awaitingCalibration = false;
              if (rttMs >= 0 && rttMs <= 15_000) {
                const midpointMs = writeWin.startedClientMs + Math.round(rttMs / 2);
                const resolvedServerMs = rawServerTs.toMillis();
                const skewMs = resolvedServerMs - midpointMs;
                // Guard against anomalous offsets > 10 minutes
                if (Math.abs(skewMs) <= 10 * 60_000) {
                  serverClockOffsetMsRef.current = skewMs;
                }
              }
            }
          }

          if (pendingWritesRef.current > 0) return;

          if (v5Snap.exists()) {
            const rawDoc = v5Snap.data() as Record<string, unknown>;

            // Hydrate workspace and persisted job timestamps without ever resetting
            // actualStartedAt or estimatedFinishAt on reload, login, or browser reopen
            const normalized = normalizeWorkspaceV5(
              rawDoc as unknown as ProductionWorkspaceV5,
              firebaseUser.uid
            );

            lastConfirmedWorkspaceRef.current = normalized;
            setWorkspace(normalized);
            setNowMs(Date.now() + serverClockOffsetMsRef.current);
            setCloudError(null);
            setReady(true);
            setSyncStatus('Synced · Cloud Firestore');
            return;
          }

          // If !v5Snap.exists() came from an empty local cache because Cloud Firestore backend could not be reached,
          // do NOT fall back to local mode or initialize a blank workspace — surface a clear connection error instead.
          if (v5Snap.metadata.fromCache) {
            setReady(false);
            setSyncStatus('Cloud Firestore unavailable');
            setCloudError(
              `Could not reach Cloud Firestore (woopp-tracker) to load ${v5Path}. Verify your internet connection and retry.`
            );
            return;
          }

          // v5_workspace confirmed absent on Cloud server -> Check legacy v1 `tracker/main` on Cloud Firestore without modifying it!
          try {
            setSyncStatus('Checking legacy v1 records...');
            const legacySnap = await getDocFromServer(userLegacyDocRef);
            let bootstrapped: ProductionWorkspaceV5;

            if (legacySnap.exists()) {
              const legacyData = legacySnap.data() as LegacyTrackerState;
              bootstrapped = migrateFromLegacyV1(legacyData, firebaseUser.uid);
            } else {
              bootstrapped = createFreshWorkspaceV5(firebaseUser.uid);
            }

            const validated = prepareWorkspaceForFirestore(
              bootstrapped,
              firebaseUser.uid,
              { documentLabel: v5Path }
            );

            pendingWritesRef.current += 1;
            setSyncStatus('Initializing Cloud Workspace...');
            try {
              await writeSnapshotWithServerTime(userV5DocRef, validated, v5Path);
              pendingWritesRef.current = Math.max(0, pendingWritesRef.current - 1);
              lastConfirmedWorkspaceRef.current = validated;
              setWorkspace(validated);
              setCloudError(null);
              setReady(true);
              setSyncStatus('Synced · Cloud Firestore');
            } catch (initWriteErr: unknown) {
              pendingWritesRef.current = Math.max(0, pendingWritesRef.current - 1);
              const writeMsg =
                initWriteErr instanceof Error ? initWriteErr.message : String(initWriteErr);
              setReady(false);
              setSyncStatus('Cloud write error');
              setCloudError(
                `Unable to initialize Cloud Firestore document (${v5Path}): ${writeMsg}`
              );
            }
          } catch (legacyErr: unknown) {
            const msg = legacyErr instanceof Error ? legacyErr.message : String(legacyErr);
            setReady(false);
            setSyncStatus('Cloud Firestore unavailable');
            setCloudError(
              `Could not reach Cloud Firestore (woopp-tracker) to load your production records: ${msg}`
            );
          }
        },
        (snapErr: unknown) => {
          const msg = snapErr instanceof Error ? snapErr.message : String(snapErr);
          setReady(false);
          setSyncStatus('Cloud connection error');
          setCloudError(
            `Unable to connect to Cloud Firestore (${v5Path}): ${msg}`
          );
        }
      );
    });

    return () => {
      unsubAuth();
      if (unsubV5Snapshot) unsubV5Snapshot();
    };
  }, [connectionAttempt]);

  const handleSignOut = async () => {
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
      createActivityLogEntry({
        category,
        msg,
        projectId,
        nowMs: authNow,
        timezone: tz,
      }),
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

  const handleCommitGeneratedPlates = async (params: {
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
    onSuccess?: () => void;
  }) => {
    const latestWs = latestWorkspaceRef.current;
    const project = latestWs.projects.find((p) => p.id === params.projectId);
    const color = latestWs.colors.find((c) => c.id === params.colorId);
    if (!project || !color) return;

    const result = commitGeneratedPlatesToWorkspace(latestWs, {
      projectId: params.projectId,
      colorId: params.colorId,
      plateCapacity: params.plateCapacity,
      mode: params.mode,
      targetLetters: params.targetLetters,
      targetCharms: params.targetCharms,
      carryForwardLetters: params.carryForwardLetters,
      carryForwardCharms: params.carryForwardCharms,
      confirmedPlates: params.confirmedPlates,
      preserveQueuedPlates: params.preserveQueuedPlates,
      nowMs: getAuthoritativeNowMs(),
    });

    if (result.error || !result.nextWorkspace || !result.createdJobs) {
      showAlert(
        result.error || 'Could not generate plates for this project.',
        'Plate Generation Blocked'
      );
      return;
    }

    const carryCount =
      countLetters(params.carryForwardLetters) + countCharms(params.carryForwardCharms);

    const saved = await persistWorkspace(result.nextWorkspace);

    if (saved) {
      params.onSuccess?.();
      showAlert(
        `Saved ${result.createdJobs.length} plate(s) for ${project.name} (${color.name}).${
          carryCount > 0 ? `\nCarried forward ${carryCount} remainder keycaps.` : ''
        }`,
        'Plates Added to Queue'
      );
    }
  };

  const handleClearCarryForward = useCallback(
    (params: {
      projectId: string;
      colorId: string;
      mode: PlateGenerationMode;
      trimTargetRemainder: boolean;
    }) => {
      const currentWs = latestWorkspaceRef.current;
      const project = currentWs.projects.find((p) => p.id === params.projectId);
      const color = currentWs.colors.find((c) => c.id === params.colorId);
      if (!project || !color) return;

      showConfirm(
        `Dismiss active carry-forward remainder for ${project.name} (${color.name})?\n` +
          `Completed, Printing, and Queued plates will remain untouched.`,
        () => {
          const latestWs = latestWorkspaceRef.current;
          const res = clearProjectColorCarryForward(latestWs, {
            projectId: params.projectId,
            colorId: params.colorId,
            mode: params.mode,
            trimTargetRemainder: params.trimTargetRemainder,
            nowMs: getAuthoritativeNowMs(),
          });
          if (res.error || !res.nextWorkspace) {
            showAlert(
              res.error || 'Could not clear carry-forward remainder.',
              'Carry-Forward Notice'
            );
            return;
          }
          void persistWorkspace(res.nextWorkspace);
        },
        'Dismiss Carry-Forward Remainder',
        'Dismiss Carry-Forward'
      );
    },
    [getAuthoritativeNowMs, persistWorkspace, showAlert, showConfirm]
  );

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

  const handleRecalibrateJobEta = (jobId: string, input: EtaRecalibrationInput) => {
    const result = recalibratePrintingJobEta(
      workspace,
      jobId,
      input,
      getAuthoritativeNowMs()
    );
    if (result.error) {
      showAlert(result.error, 'ETA Recalibration Notice');
      return;
    }
    if (result.nextWorkspace) {
      void persistWorkspace(result.nextWorkspace);
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
    if (job.archived) {
      showAlert(
        `Plate ${job.plateNumber} is archived. Restore it before editing metadata.`,
        'Archived Plate Read-Only'
      );
      return;
    }

    const authNow = getAuthoritativeNowMs();

    // If changing machine while job is actively Printing, enforce overlap & availability rules
    // while preserving active timestamps on this and all other jobs
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
        void persistWorkspace(result.nextWorkspace);
      }
      return;
    }

    const definedUpdates = Object.fromEntries(
      Object.entries(updates).filter(([, val]) => val !== undefined)
    ) as typeof updates;

    const nextJobs = workspace.jobs.map((j) => {
      if (j.id !== jobId) return j;
      const merged: ProductionJob = {
        ...j,
        ...definedUpdates,
        machineId:
          definedUpdates.machineId !== undefined ? definedUpdates.machineId : j.machineId,
        updatedIso: new Date(authNow).toISOString(),
      };

      // Recalculate live finish ETA if Bambu Studio duration or printer override was updated during a calibrated active print
      if (
        merged.stage === 'Printing' &&
        (definedUpdates.estimatedMinutes !== undefined ||
          definedUpdates.machineDurationOverrides !== undefined)
      ) {
        const machine =
          workspace.machines.find((m) => m.id === merged.machineId) || null;
        const resolvedPrev = resolveJobTimingFields(j, machine);
        const newDurationMs = computeEffectiveDurationMs(merged, machine);
        merged.estimatedDurationMs = newDurationMs;

        if (!resolvedPrev.needsEtaRecalibration) {
          const prevSnap = computeJobCountdownSnapshot(j, authNow, machine);
          const elapsedWorkMs = Math.max(
            0,
            resolvedPrev.estimatedDurationMs - prevSnap.remainingMs
          );
          const nextRemMs = Math.max(0, newDurationMs - elapsedWorkMs);
          if (resolvedPrev.isPaused) {
            merged.remainingAtPauseMs = nextRemMs;
            merged.remainingSecondsAtPause = Math.ceil(nextRemMs / 1000);
            merged.estimatedFinishAt = null;
            merged.estimatedFinishAtMs = null;
          } else {
            const nextFinishMs = authNow + nextRemMs;
            merged.estimatedFinishAt = toUtcTimestampIso(nextFinishMs);
            merged.estimatedFinishAtMs = nextFinishMs;
          }
        }
      }

      return merged;
    });

    void persistWorkspace({ ...workspace, jobs: nextJobs });
  };

  const handleCopyQueueSummary = (jobsToCopy: ProductionJob[]) => {
    const text = jobsToCopy
      .map((j) => {
        const p = workspace.projects.find((pr) => pr.id === j.projectId);
        const c = workspace.colors.find((cl) => cl.id === j.colorId);
        const m = workspace.machines.find((mc) => mc.id === j.machineId);
        const itemsStr = formatPlateItemsText(j, true);
        return `${p?.name || 'Project'} | ${c?.name || 'Color'} | Plate ${j.plateNumber} (${countPlateKeycaps(
          j
        )}/${j.plateCapacity}) | ${j.stage} | ${m?.name || 'Unassigned'} | ${itemsStr}`;
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

  // --- Handlers for Print Queue Lifecycle Management (Delete, Cancel, Archive, Restore & Bulk) ---
  const handleRequestDeletePlate = useCallback(
    (job: ProductionJob) => {
      if (!isAdmin) {
        showAlert(
          'Admin privileges are required to delete print plates.',
          'Unauthorized Action'
        );
        return;
      }
      if (busyJobIdsRef.current.has(job.id)) return;
      setPendingDeleteJobId(job.id);
    },
    [isAdmin, showAlert]
  );

  const handleConfirmDeletePlate = useCallback(
    async (jobId: string) => {
      if (!lockJobIds([jobId])) return;
      setIsLifecycleSaving(true);
      try {
        const currentWs = latestWorkspaceRef.current;
        const result = deletePrintPlate(currentWs, jobId, {
          actor: actorContext,
          nowMs: getAuthoritativeNowMs(),
        });
        if (result.error || !result.nextWorkspace) {
          showAlert(result.error || 'Unable to delete plate.', 'Delete Plate Blocked');
          return;
        }
        const saved = await persistWorkspace(result.nextWorkspace);
        if (saved) {
          setPendingDeleteJobId(null);
        }
      } finally {
        setIsLifecycleSaving(false);
        unlockJobIds([jobId]);
      }
    },
    [actorContext, getAuthoritativeNowMs, lockJobIds, persistWorkspace, showAlert, unlockJobIds]
  );

  const handleRequestCancelPrinting = useCallback(
    (job: ProductionJob) => {
      if (!isAdmin) {
        showAlert(
          'Admin privileges are required to cancel an active print job.',
          'Unauthorized Action'
        );
        return;
      }
      if (busyJobIdsRef.current.has(job.id)) return;
      setPendingCancelJobId(job.id);
    },
    [isAdmin, showAlert]
  );

  const handleConfirmCancelPrinting = useCallback(
    async (jobId: string, reason: string) => {
      if (!lockJobIds([jobId])) return;
      setIsLifecycleSaving(true);
      try {
        const currentWs = latestWorkspaceRef.current;
        const result = cancelPrintingJob(currentWs, jobId, {
          reason,
          actor: actorContext,
          nowMs: getAuthoritativeNowMs(),
        });
        if (result.error || !result.nextWorkspace) {
          showAlert(result.error || 'Unable to cancel print job.', 'Cancel Printing Blocked');
          return;
        }
        const saved = await persistWorkspace(result.nextWorkspace);
        if (saved) {
          setPendingCancelJobId(null);
        }
      } finally {
        setIsLifecycleSaving(false);
        unlockJobIds([jobId]);
      }
    },
    [actorContext, getAuthoritativeNowMs, lockJobIds, persistWorkspace, showAlert, unlockJobIds]
  );

  const handleArchivePlate = useCallback(
    async (job: ProductionJob) => {
      if (!isAdmin) {
        showAlert(
          'Admin privileges are required to archive print plates.',
          'Unauthorized Action'
        );
        return;
      }
      if (!lockJobIds([job.id])) return;
      try {
        const currentWs = latestWorkspaceRef.current;
        const result = archivePrintPlate(currentWs, job.id, {
          actor: actorContext,
          nowMs: getAuthoritativeNowMs(),
        });
        if (result.error || !result.nextWorkspace) {
          showAlert(result.error || 'Unable to archive plate.', 'Archive Plate Blocked');
          return;
        }
        await persistWorkspace(result.nextWorkspace);
      } finally {
        unlockJobIds([job.id]);
      }
    },
    [actorContext, getAuthoritativeNowMs, isAdmin, lockJobIds, persistWorkspace, showAlert, unlockJobIds]
  );

  const handleRestorePlate = useCallback(
    async (job: ProductionJob) => {
      if (!isAdmin) {
        showAlert(
          'Admin privileges are required to restore archived print plates.',
          'Unauthorized Action'
        );
        return;
      }
      if (!lockJobIds([job.id])) return;
      try {
        const currentWs = latestWorkspaceRef.current;
        const result = restorePrintPlate(currentWs, job.id, {
          actor: actorContext,
          nowMs: getAuthoritativeNowMs(),
        });
        if (result.error || !result.nextWorkspace) {
          showAlert(result.error || 'Unable to restore plate.', 'Restore Plate Blocked');
          return;
        }
        await persistWorkspace(result.nextWorkspace);
      } finally {
        unlockJobIds([job.id]);
      }
    },
    [actorContext, getAuthoritativeNowMs, isAdmin, lockJobIds, persistWorkspace, showAlert, unlockJobIds]
  );

  const handleRequestBulkAction = useCallback(
    (action: BulkQueueActionKind, jobs: ProductionJob[]) => {
      if (!isAdmin) {
        showAlert(
          'Admin privileges are required for bulk queue actions.',
          'Unauthorized Action'
        );
        return;
      }
      if (jobs.length === 0) return;
      setPendingBulkState({
        action,
        jobIds: jobs.map((j) => j.id),
      });
    },
    [isAdmin, showAlert]
  );

  const handleConfirmBulkAction = useCallback(
    async (action: BulkQueueActionKind, jobIds: string[]) => {
      if (jobIds.length === 0) return;
      if (!lockJobIds(jobIds)) return;
      setIsLifecycleSaving(true);
      try {
        const currentWs = latestWorkspaceRef.current;
        const nowMsVal = getAuthoritativeNowMs();
        const result =
          action === 'bulk_delete'
            ? bulkDeletePrintPlates(currentWs, jobIds, {
                actor: actorContext,
                nowMs: nowMsVal,
              })
            : action === 'bulk_archive'
            ? bulkArchivePrintPlates(currentWs, jobIds, {
                actor: actorContext,
                nowMs: nowMsVal,
              })
            : bulkRestorePrintPlates(currentWs, jobIds, {
                actor: actorContext,
                nowMs: nowMsVal,
              });

        if (result.error || !result.nextWorkspace) {
          showAlert(result.error || 'Bulk queue action blocked.', 'Bulk Action Blocked');
          return;
        }
        const saved = await persistWorkspace(result.nextWorkspace);
        if (saved) {
          setPendingBulkState(null);
        }
      } finally {
        setIsLifecycleSaving(false);
        unlockJobIds(jobIds);
      }
    },
    [actorContext, getAuthoritativeNowMs, lockJobIds, persistWorkspace, showAlert, unlockJobIds]
  );

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
    const result = applyMachineUpdate(
      workspace,
      machineId,
      updates,
      getAuthoritativeNowMs()
    );
    if (result.error) {
      showAlert(result.error, 'Machine Status Blocked');
      return;
    }
    if (result.nextWorkspace) {
      void persistWorkspace(result.nextWorkspace);
    }
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
  const handleUpdateWorkspaceDefaults = async (params: {
    defaultPlateCapacity: number;
    defaultProductType: string;
    turnaroundBufferMinutes: number;
    timezone: string;
  }) => {
    const saved = await persistWorkspace({
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
    if (saved) {
      showAlert('Production & scheduling settings updated.');
    }
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
    if (!user) {
      showAlert('Sign in to Firebase Authentication before importing a backup.');
      return;
    }
    try {
      const rawText = await file.text();
      const parsed = JSON.parse(rawText);
      const currentOwner = user.uid;

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
        `Restore backup containing ${importedWs.projects.length} project(s) and ${importedWs.jobs.length} plate(s) into Cloud Firestore?`,
        () => {
          void persistWorkspace(importedWs).then((saved) => {
            if (saved) {
              setTimeout(() => showAlert('Workspace backup restored to Cloud Firestore.'), 60);
            }
          });
        },
        'Confirm Backup Restore',
        'Restore to Cloud'
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Invalid file';
      showAlert(`Backup import failed: ${msg}`);
    }
  };

  const handleMigrateLegacyLocalToCloud = () => {
    if (!legacyLocalData || !user) return;
    showConfirm(
      `Migrate ${legacyLocalData.projectCount} project(s) and ${legacyLocalData.jobCount} plate(s) from this browser's previous local storage into your Cloud Firestore workspace (users/${user.uid}/tracker/v5_workspace)?\n\nYour existing local browser copy will not be deleted.`,
      () => {
        try {
          const migrated = buildCloudWorkspaceFromLocalBackup(legacyLocalData, user.uid);
          const withMigrationLog: ProductionWorkspaceV5 = {
            ...migrated,
            log: appendLog(
              migrated.log,
              'system',
              `Migrated ${legacyLocalData.projectCount} project(s) and ${legacyLocalData.jobCount} plate(s) from browser ${legacyLocalData.format} storage to Cloud Firestore.`
            ),
          };
          void persistWorkspace(withMigrationLog).then((saved) => {
            if (saved) {
              setLegacyBannerDismissed(true);
              setTimeout(
                () =>
                  showAlert(
                    'Unsynced browser data migrated and saved to Cloud Firestore (woopp-tracker). Your local browser record was left untouched.',
                    'Cloud Migration Complete'
                  ),
                60
              );
            }
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          showAlert(`Could not migrate local browser data: ${msg}`, 'Migration Failed');
        }
      },
      'Migrate Local Data to Cloud',
      'Migrate to Cloud'
    );
  };

  const handleClearActivityLog = () => {
    showConfirm(
      'Clear activity log history? (Projects, plates, machines, and inventory ledger remain intact.)',
      () => {
        void persistWorkspace({ ...workspace, log: [] });
      },
      'Clear Activity Log',
      'Clear Log'
    );
  };

  const handleToggleTheme = () => {
    const nextTheme = workspace.settings.theme === 'dark' ? 'light' : 'dark';
    void persistWorkspace({
      ...workspace,
      settings: { ...workspace.settings, theme: nextTheme },
    });
  };

  if (!authInitialized) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#faf9fd] dark:bg-[#111018] text-sm text-neutral-500">
        Connecting to WOOPP Cloud Authentication...
      </div>
    );
  }

  // Strictly require Firebase Authentication before accessing the admin dashboard
  if (!user) {
    return (
      <>
        <AuthSection legacyLocalData={legacyLocalData} />
        <DialogModal modal={modal} />
      </>
    );
  }

  // Show an explicit Cloud Firestore connection error instead of falling back to local mode
  if (cloudError) {
    return (
      <div className="min-h-screen flex flex-col justify-center items-center px-4 py-12 bg-[#faf9fd] dark:bg-[#111018]">
        <div className="w-full max-w-lg bg-white dark:bg-[#171522] border border-red-200 dark:border-red-900/60 rounded-2xl p-8 space-y-5">
          <div>
            <div className="text-xs font-semibold text-red-600 dark:text-red-400 mb-1">
              CLOUD FIRESTORE CONNECTION ERROR
            </div>
            <h1 className="text-xl font-bold text-neutral-900 dark:text-white">
              Unable to Load Production Workspace
            </h1>
            <p className="text-sm text-neutral-600 dark:text-neutral-300 mt-1.5">
              WOOPP Production System 5.0 runs exclusively in Cloud-Only Mode (<span className="font-mono-data">woopp-tracker</span>) to protect inventory and scheduling integrity. Offline/local fallback is disabled.
            </p>
          </div>

          <div className="p-3.5 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200/80 dark:border-red-900/60 text-xs font-mono-data text-red-800 dark:text-red-200 break-words">
            {cloudError}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <button
              type="button"
              onClick={() => setConnectionAttempt((n) => n + 1)}
              className="px-4 py-2.5 rounded-xl bg-[#6c4ce6] hover:bg-[#5b3cc4] text-white text-xs font-semibold transition-colors"
            >
              Retry Cloud Connection
            </button>
            <button
              type="button"
              onClick={handleSignOut}
              className="px-4 py-2.5 rounded-xl border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 text-xs font-medium transition-colors"
            >
              Sign out ({user.email})
            </button>
          </div>
        </div>
        <DialogModal modal={modal} />
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-[#faf9fd] dark:bg-[#111018] px-4 text-center">
        <div className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
          {syncStatus}
        </div>
        <div className="text-xs text-neutral-500 dark:text-neutral-400">
          Authenticated as {user.email} · Project: woopp-tracker
        </div>
      </div>
    );
  }

  const meta = SECTION_META[activeNav];

  return (
    <div className="min-h-screen flex bg-[#faf9fd] dark:bg-[#111018] text-neutral-900 dark:text-neutral-100">
      <Sidebar
        activeNav={activeNav}
        onSelectNav={handleNavigate}
        theme={workspace.settings.theme}
        onToggleTheme={handleToggleTheme}
        syncStatus={syncStatus}
        userEmail={user.email || ''}
        onSignOut={handleSignOut}
        mobileOpen={mobileMenuOpen}
        onSetMobileOpen={setMobileMenuOpen}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        <TopHeader
          sectionTitle={meta.title}
          subtitle={meta.subtitle}
          onOpenMobileMenu={() => setMobileMenuOpen(true)}
        />

        <main className="flex-1 max-w-[1320px] w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
          {legacyLocalData && !legacyBannerDismissed && (
            <div className="mb-6 p-4 rounded-xl bg-amber-50/90 dark:bg-amber-950/35 border border-amber-200 dark:border-amber-800/70 flex flex-wrap items-center justify-between gap-3 no-print">
              <div className="text-xs text-amber-900 dark:text-amber-200">
                <span className="font-semibold">Unsynced browser data found:</span>{' '}
                {legacyLocalData.projectCount} project(s) and {legacyLocalData.jobCount} plate(s) from the retired Local Workspace exist in this browser. Export a JSON backup or migrate them into Cloud Firestore.
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => downloadUnsyncedLocalBackupJson(legacyLocalData)}
                  className="px-3 py-1.5 rounded-lg border border-amber-300 dark:border-amber-700 bg-white dark:bg-[#171522] text-xs font-semibold text-amber-900 dark:text-amber-200 whitespace-nowrap"
                >
                  Export Backup (.json)
                </button>
                <button
                  type="button"
                  onClick={handleMigrateLegacyLocalToCloud}
                  className="px-3 py-1.5 rounded-lg bg-[#6c4ce6] hover:bg-[#5b3cc4] text-xs font-semibold text-white whitespace-nowrap"
                >
                  Migrate to Cloud
                </button>
                <button
                  type="button"
                  onClick={() => setLegacyBannerDismissed(true)}
                  className="px-2 py-1.5 text-xs text-amber-800 dark:text-amber-300 hover:underline"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
          {activeNav === 'dashboard' && (
            <EtaDashboardView
              workspace={workspace}
              schedule={schedule}
              isAdmin={isAdmin}
              busyJobIds={busyJobIds}
              onNavigate={handleNavigate}
              onSelectProject={setSelectedProjectId}
              onPauseOrResume={handlePauseOrResume}
              onRecalibrateJobEta={handleRecalibrateJobEta}
              onTransitionStage={handleTransitionStage}
              onRequestCancelPrinting={handleRequestCancelPrinting}
              onUpdateBufferMinutes={handleUpdateBufferMinutes}
            />
          )}

          {activeNav === 'projects' && (
            <ProjectsView
              workspace={workspace}
              selectedProjectId={selectedProjectId}
              onSelectProject={setSelectedProjectId}
              onSaveProject={handleSaveProject}
              onUpdateProjectStatus={handleUpdateProjectStatus}
              onNavigate={handleNavigate}
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
              onClearCarryForward={handleClearCarryForward}
              onAlert={showAlert}
            />
          )}

          {activeNav === 'queue' && (
            <KanbanQueueView
              workspace={workspace}
              schedule={schedule}
              selectedProjectId={selectedProjectId}
              isAdmin={isAdmin}
              busyJobIds={busyJobIds}
              onSelectProject={setSelectedProjectId}
              onTransitionStage={handleTransitionStage}
              onPauseOrResume={handlePauseOrResume}
              onRecalibrateJobEta={handleRecalibrateJobEta}
              onUpdateJobMetadata={handleUpdateJobMetadata}
              onCopyQueueSummary={handleCopyQueueSummary}
              onRequestDeletePlate={handleRequestDeletePlate}
              onRequestCancelPrinting={handleRequestCancelPrinting}
              onArchivePlate={handleArchivePlate}
              onRestorePlate={handleRestorePlate}
              onRequestBulkAction={handleRequestBulkAction}
            />
          )}

          {activeNav === 'machines' && (
            <MachinesView
              workspace={workspace}
              schedule={schedule}
              isAdmin={isAdmin}
              busyJobIds={busyJobIds}
              onAddMachine={handleAddMachine}
              onUpdateMachine={handleUpdateMachine}
              onRemoveMachine={handleRemoveMachine}
              onAssignAndStartJob={(jobId, machineId) =>
                handleTransitionStage(jobId, 'Printing', { machineId })
              }
              onPauseOrResume={handlePauseOrResume}
              onRecalibrateJobEta={handleRecalibrateJobEta}
              onTransitionStage={handleTransitionStage}
              onRequestCancelPrinting={handleRequestCancelPrinting}
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
              legacyLocalData={legacyLocalData}
              onExportLegacyLocalBackup={
                legacyLocalData
                  ? () => downloadUnsyncedLocalBackupJson(legacyLocalData)
                  : undefined
              }
              onMigrateLegacyLocalToCloud={
                legacyLocalData ? handleMigrateLegacyLocalToCloud : undefined
              }
            />
          )}
        </main>
      </div>

      <DeletePlateConfirmModal
        job={
          pendingDeleteJobId
            ? workspace.jobs.find((j) => j.id === pendingDeleteJobId) || null
            : null
        }
        workspace={workspace}
        isSaving={isLifecycleSaving}
        onClose={() => {
          if (!isLifecycleSaving) setPendingDeleteJobId(null);
        }}
        onConfirmDelete={handleConfirmDeletePlate}
      />

      <CancelPrintingConfirmModal
        job={
          pendingCancelJobId
            ? workspace.jobs.find((j) => j.id === pendingCancelJobId) || null
            : null
        }
        workspace={workspace}
        isSaving={isLifecycleSaving}
        onClose={() => {
          if (!isLifecycleSaving) setPendingCancelJobId(null);
        }}
        onConfirmCancel={handleConfirmCancelPrinting}
      />

      <BulkQueueActionModal
        action={pendingBulkState?.action || null}
        jobs={
          pendingBulkState
            ? pendingBulkState.jobIds
                .map((id) => workspace.jobs.find((j) => j.id === id))
                .filter((j): j is ProductionJob => Boolean(j))
            : []
        }
        workspace={workspace}
        isSaving={isLifecycleSaving}
        onClose={() => {
          if (!isLifecycleSaving) setPendingBulkState(null);
        }}
        onConfirmBulk={handleConfirmBulkAction}
      />

      <DialogModal modal={modal} />
    </div>
  );
};

export default App;
