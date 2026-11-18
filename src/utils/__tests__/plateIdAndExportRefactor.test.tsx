import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AutoPlannerView } from '../../components/AutoPlannerView';
import { CompletedPlateExpandedDetails } from '../../components/CompletedPlateDetails';
import { KanbanQueueView } from '../../components/KanbanQueueView';
import { SettingsView } from '../../components/SettingsView';
import { ToastStack, ToastVariant } from '../../components/ToastStack';
import { createFreshWorkspaceV5, normalizeWorkspaceV5 } from '../../constants';
import {
  backfillMissingJobPlateCodes,
  createInMemoryPlateIdRegistry,
  reservePlateCodesForPreviewPlates,
} from '../../services/plateIdService';
import { validateAndPrepareStlAsset } from '../../services/stlLibraryStorage';
import { ProductionJob, ProductionWorkspaceV5, StlModelAssetEntry } from '../../types';
import { generateIndependentKeycapBatchPreviews } from '../catalogPlannerEngine';
import { prepareWorkspaceForFirestore } from '../firestorePayload';
import {
  formatWpPlateId,
  formatWpPlateStlFilename,
  generateCandidatePlateCode,
  isValidPlateCode,
  PLATE_ID_ALPHABET,
} from '../plateIdGenerator';
import { exportSinglePreviewPlateStl } from '../platePreviewHelper';
import { commitGeneratedPlatesToWorkspace } from '../productionEngine';
import { computeGlobalSchedule } from '../schedulingEngine';
import { exportSinglePlateStl } from '../stlExportEngine';

function makeSimpleBinaryKeycapStl(widthMm = 18.0, depthMm = 18.0): ArrayBuffer {
  const tris: number[] = [];
  const pushTri = (
    nx: number,
    ny: number,
    nz: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number
  ) => {
    tris.push(nx, ny, nz, ax, ay, az, bx, by, bz, cx, cy, cz);
  };
  const minX = -widthMm / 2;
  const maxX = widthMm / 2;
  const minY = -depthMm / 2;
  const maxY = depthMm / 2;
  const minZ = 0;
  const maxZ = 8.8;
  pushTri(0, 0, -1, minX, minY, minZ, maxX, maxY, minZ, maxX, minY, minZ);
  pushTri(0, 0, -1, minX, minY, minZ, minX, maxY, minZ, maxX, maxY, minZ);
  pushTri(0, 0, 1, minX, minY, maxZ, maxX, minY, maxZ, maxX, maxY, maxZ);
  pushTri(0, 0, 1, minX, minY, maxZ, maxX, maxY, maxZ, minX, maxY, maxZ);
  pushTri(0, -1, 0, minX, minY, minZ, maxX, minY, minZ, maxX, minY, maxZ);
  pushTri(0, -1, 0, minX, minY, minZ, maxX, minY, maxZ, minX, minY, maxZ);
  pushTri(0, 1, 0, minX, maxY, minZ, maxX, maxY, maxZ, maxX, maxY, minZ);
  pushTri(0, 1, 0, minX, maxY, minZ, minX, maxY, maxZ, maxX, maxY, maxZ);
  pushTri(-1, 0, 0, minX, minY, minZ, minX, minY, maxZ, minX, maxY, maxZ);
  pushTri(-1, 0, 0, minX, minY, minZ, minX, maxY, maxZ, minX, maxY, minZ);
  pushTri(1, 0, 0, maxX, minY, minZ, maxX, maxY, maxZ, maxX, minY, maxZ);
  pushTri(1, 0, 0, maxX, minY, minZ, maxX, maxY, minZ, maxX, maxY, maxZ);

  const triCount = tris.length / 12;
  const bytes = new Uint8Array(84 + triCount * 50);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, triCount, true);
  let offset = 84;
  for (let t = 0; t < triCount; t += 1) {
    for (let f = 0; f < 12; f += 1) {
      view.setFloat32(offset + f * 4, tris[t * 12 + f], true);
    }
    offset += 50;
  }
  return bytes.buffer;
}

describe('Globally Unique Plate ID & Compact Per-Plate STL Export Refactor', () => {
  it('generates 5-char CSPRNG Plate IDs strictly excluding O, 0, I, 1 and formats WP-{PLATE_ID}.stl', () => {
    expect(PLATE_ID_ALPHABET).not.toMatch(/[O0I1]/);
    expect(PLATE_ID_ALPHABET).toHaveLength(32);

    const seen = new Set<string>();
    for (let i = 0; i < 250; i += 1) {
      const code = generateCandidatePlateCode();
      expect(code).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}$/);
      expect(code).not.toMatch(/[O0I1]/);
      expect(isValidPlateCode(code)).toBe(true);
      expect(formatWpPlateId(code)).toBe(`WP-${code}`);
      expect(formatWpPlateStlFilename(code)).toBe(`WP-${code}.stl`);
      seen.add(code);
    }
    expect(seen.size).toBeGreaterThan(240);

    // Invalid formats
    for (const invalid of ['K7O2Q', 'K702Q', 'K7I2Q', 'K712Q', 'ABCD', 'ABCDEF', '']) {
      expect(isValidPlateCode(invalid)).toBe(false);
    }
  });

  it('retries cleanly on collision and blocks duplicate reservation in atomic registry', async () => {
    const registry = createInMemoryPlateIdRegistry(['DUP22', 'DUP33']);
    const sequence = ['DUP22', 'DUP33', 'VAL4D'];
    let idx = 0;

    const reserved = await registry.reserveSinglePlateCode({
      ownerId: 'owner-1',
      projectId: 'proj-1',
      batchId: 'batch-1',
      candidateGenerator: () => sequence[idx++] || 'FALL9',
    });

    expect(reserved).toBe('VAL4D');
    expect(registry.attemptsLog).toEqual(['DUP22', 'DUP33', 'VAL4D']);
    expect(registry.records.get('VAL4D')).toMatchObject({
      plateCode: 'VAL4D',
      ownerId: 'owner-1',
      projectId: 'proj-1',
      batchId: 'batch-1',
    });
  });

  it('keeps Plate ID stable across preview re-export & confirmation, while assigning fresh IDs to new plates', async () => {
    const registry = createInMemoryPlateIdRegistry();
    const ws = createFreshWorkspaceV5('owner-1');
    const projectId = ws.projects[0].id;
    const colorId = ws.colors[0].id;

    // Generate 3 plates (414 keycaps = 1 batch)
    const previewA = generateIndependentKeycapBatchPreviews({
      existingJobs: ws.jobs,
      projectId,
      mode: 'alphabet_only',
      batchLetters: { A: 200, B: 214 },
      capacity: 138,
      defaultMinutesPerPlate: 195,
    });

    const reservedA = await reservePlateCodesForPreviewPlates({
      plates: previewA.fullPlates,
      ownerId: 'owner-1',
      projectId,
      existingJobs: ws.jobs,
      registry,
    });

    expect(reservedA).toHaveLength(3);
    const codesA = reservedA.map((p) => p.plateCode);
    expect(new Set(codesA).size).toBe(3);

    // Re-running reservation on already-assigned preview plates preserves exact same codes
    const reReservedA = await reservePlateCodesForPreviewPlates({
      plates: reservedA,
      ownerId: 'owner-1',
      projectId,
      existingJobs: ws.jobs,
      registry,
    });
    expect(reReservedA.map((p) => p.plateCode)).toEqual(codesA);

    // Confirm batch: preserves 1 batchId across 3 plates AND carries each plate's immutable plateCode
    const commitRes = commitGeneratedPlatesToWorkspace(ws, {
      projectId,
      colorId,
      plateCapacity: 138,
      mode: 'alphabet_only',
      targetLetters: { A: 200, B: 214 },
      targetCharms: {},
      carryForwardLetters: {},
      carryForwardCharms: {},
      confirmedPlates: reservedA,
      preserveQueuedPlates: true,
      nowMs: 1731840000000,
    });

    expect(commitRes.createdJobs).toHaveLength(3);
    const createdJobs = commitRes.createdJobs!;
    expect(new Set(createdJobs.map((j) => j.batchId)).size).toBe(1);
    expect(createdJobs.map((j) => j.plateCode)).toEqual(codesA);

    // Firestore prepare & normalize round-trip preserves plateCode
    const prepared = prepareWorkspaceForFirestore(commitRes.nextWorkspace!, 'owner-1');
    const normalized = normalizeWorkspaceV5(prepared, 'owner-1');
    expect(normalized.jobs.slice(-3).map((j) => j.plateCode)).toEqual(codesA);

    // Generating a brand-new set of plates with identical inputs yields brand-new Plate IDs
    const previewB = generateIndependentKeycapBatchPreviews({
      existingJobs: normalized.jobs,
      projectId,
      mode: 'alphabet_only',
      batchLetters: { A: 200, B: 214 },
      capacity: 138,
      defaultMinutesPerPlate: 195,
    });
    const reservedB = await reservePlateCodesForPreviewPlates({
      plates: previewB.fullPlates,
      ownerId: 'owner-1',
      projectId,
      existingJobs: normalized.jobs,
      registry,
    });
    const codesB = reservedB.map((p) => p.plateCode);
    expect(new Set([...codesA, ...codesB]).size).toBe(6);
  });

  it('performs one-time non-destructive backfill for historical jobs lacking plateCode without changing production data', async () => {
    const registry = createInMemoryPlateIdRegistry();
    const base = createFreshWorkspaceV5('owner-1');
    const legacyJob: ProductionJob = {
      id: 'legacy-job-1',
      projectId: base.projects[0].id,
      colorId: base.colors[0].id,
      plateNumber: 1,
      plateCapacity: 138,
      letters: { A: 100, B: 38 },
      batchId: 'batch-legacy-999',
      stage: 'Completed',
      machineId: 'm1',
      estimatedMinutes: 195,
      actualMinutes: 190,
      slicerVerified: true,
      stockApplied: true,
      stockTransactionId: 'tx-1',
      failedCount: 0,
      failureReason: '',
      notes: 'Original notes',
      createdIso: '2026-10-01T10:00:00.000Z',
      updatedIso: '2026-10-01T13:10:00.000Z',
      completedIso: '2026-10-01T13:10:00.000Z',
    };
    const wsWithLegacy: ProductionWorkspaceV5 = {
      ...base,
      jobs: [legacyJob],
    };

    const firstPass = await backfillMissingJobPlateCodes(wsWithLegacy, 'owner-1', registry);
    expect(firstPass.changed).toBe(true);
    expect(firstPass.assignedCount).toBe(1);
    const updatedJob = firstPass.workspace.jobs[0];
    expect(isValidPlateCode(updatedJob.plateCode)).toBe(true);
    // Every other field must remain identical
    expect({ ...updatedJob, plateCode: undefined }).toEqual({
      ...legacyJob,
      plateCode: undefined,
    });

    // Second pass is an exact idempotent no-op
    const secondPass = await backfillMissingJobPlateCodes(
      firstPass.workspace,
      'owner-1',
      registry
    );
    expect(secondPass.changed).toBe(false);
    expect(secondPass.assignedCount).toBe(0);
    expect(secondPass.workspace.jobs[0].plateCode).toBe(updatedJob.plateCode);
  });

  it('exports ONLY the selected plate as WP-{PLATE_ID}.stl and emits dense-bed / error notifications strictly via toast', async () => {
    const prepA = await validateAndPrepareStlAsset({
      fileName: 'keycap-char-A.stl',
      buffer: makeSimpleBinaryKeycapStl(),
    });
    const prepP = await validateAndPrepareStlAsset({
      fileName: 'keycap-char-P.stl',
      buffer: makeSimpleBinaryKeycapStl(),
    });
    if (!prepA.ok || !prepP.ok) throw new Error('Prep failed');

    const assetsByLetter: Record<string, StlModelAssetEntry> = {
      A: prepA.entry,
      P: prepP.entry,
    };

    // Exporting Plate 2 in a 3-plate batch exports ONLY Plate 2 (P x 138, 0 x A) with WP-{CODE}.stl
    const plate2Only = await exportSinglePlateStl({
      plate: {
        plateNumber: 2,
        plateCode: 'R4T9P',
        capacity: 138,
        letters: { P: 138 },
      },
      assetsByLetter,
    });
    expect(plate2Only.fileName).toBe('WP-R4T9P.stl');
    expect(plate2Only.keycapCount).toBe(138);
    expect(plate2Only.letterBreakdown).toEqual({ P: 138 });
    expect(plate2Only.validation.warnings.length).toBeGreaterThan(0);

    // Helper missing-STL check surfaces ONLY via toast without throwing unhandled
    const toasts: Array<{ variant: ToastVariant; message: string }> = [];
    await exportSinglePreviewPlateStl({
      plateNumber: 1,
      plateCode: 'K7M2Q',
      capacity: 138,
      letters: { Z: 10 },
      recordsByLetter: { A: prepA.entry.record },
      getAssetsByLetters: async () => ({ A: prepA.entry }),
      onToast: (variant, message) => toasts.push({ variant, message }),
    });
    expect(toasts).toHaveLength(1);
    expect(toasts[0].variant).toBe('error');
    expect(toasts[0].message).toContain('keycap-char-Z.stl');
  });

  it('removes standalone Confirmed Batch STL Export and STL Model Library from AutoPlannerView, hosts STL Library in SettingsView, and shows WP-{PLATE_ID} in Queue', () => {
    const ws = createFreshWorkspaceV5('owner-ui');
    ws.jobs = [
      {
        id: 'job-queue-1',
        projectId: ws.projects[0].id,
        colorId: ws.colors[0].id,
        plateNumber: 1,
        plateCode: 'K7M2Q',
        plateCapacity: 138,
        letters: { A: 138 },
        batchId: 'batch-ui-1',
        stage: 'Completed',
        machineId: null,
        estimatedMinutes: 195,
        actualMinutes: 195,
        slicerVerified: true,
        stockApplied: true,
        stockTransactionId: 'tx-ui',
        failedCount: 0,
        failureReason: '',
        notes: '',
        createdIso: '2026-11-17T08:00:00.000Z',
        updatedIso: '2026-11-17T11:00:00.000Z',
        completedIso: '2026-11-17T11:00:00.000Z',
        actualCompletedAt: '2026-11-17T11:00:00.000Z',
      },
    ];

    // 1. AutoPlannerView no longer renders Confirmed Batch STL Export or STL Model Library
    const plannerHtml = renderToStaticMarkup(
      <AutoPlannerView
        workspace={ws}
        selectedProjectId={ws.projects[0].id}
        isAdmin={true}
        ownerId="owner-ui"
        onSelectProject={vi.fn()}
        onSavePreset={vi.fn()}
        onDeletePreset={vi.fn()}
        onCommitGeneratedPlates={vi.fn()}
        onAlert={vi.fn()}
        onToast={vi.fn()}
      />
    );
    expect(plannerHtml).not.toContain('Confirmed Batch STL Export');
    expect(plannerHtml).not.toContain('STL Model Library (A–Z)');

    // 2. SettingsView renders STL Model Library for admins
    const settingsHtml = renderToStaticMarkup(
      <SettingsView
        workspace={ws}
        isAdmin={true}
        ownerId="owner-ui"
        onUpdateWorkspaceDefaults={vi.fn()}
        onAddColor={vi.fn()}
        onRenameColor={vi.fn()}
        onExportBackup={vi.fn()}
        onImportBackup={vi.fn()}
        onClearActivityLog={vi.fn()}
      />
    );
    expect(settingsHtml).toContain('STL Model Library (A–Z Master Keycaps)');

    // 3. KanbanQueueView & CompletedPlateExpandedDetails discreetly display WP-K7M2Q
    const schedule = computeGlobalSchedule(ws, Date.now());
    const queueHtml = renderToStaticMarkup(
      <KanbanQueueView
        workspace={ws}
        schedule={schedule}
        selectedProjectId={ws.projects[0].id}
        isAdmin={true}
        busyJobIds={new Set()}
        onSelectProject={vi.fn()}
        onTransitionStage={vi.fn()}
        onPauseOrResume={vi.fn()}
        onRecalibrateJobEta={vi.fn()}
        onUpdateJobMetadata={vi.fn()}
        onCopyQueueSummary={vi.fn()}
        onRequestDeletePlate={vi.fn()}
        onRequestCancelPrinting={vi.fn()}
        onArchivePlate={vi.fn()}
        onRestorePlate={vi.fn()}
        onRequestBulkAction={vi.fn()}
      />
    );
    expect(queueHtml).toContain('WP-K7M2Q');

    const detailsHtml = renderToStaticMarkup(
      <CompletedPlateExpandedDetails
        job={ws.jobs[0]}
        project={ws.projects[0]}
        color={ws.colors[0]}
        machine={null}
      />
    );
    expect(detailsHtml).toContain('WP-K7M2Q');

    // 4. ToastStack renders non-blocking warning/error/success notifications
    const toastHtml = renderToStaticMarkup(
      <ToastStack
        toasts={[
          { id: 't1', variant: 'success', message: 'Exported WP-K7M2Q.stl' },
          { id: 't2', variant: 'warning', message: 'Tight prime tower clearance' },
        ]}
        onDismiss={vi.fn()}
      />
    );
    expect(toastHtml).toContain('Exported WP-K7M2Q.stl');
    expect(toastHtml).toContain('Tight prime tower clearance');
  });
});
