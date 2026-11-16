import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AnalyticsView } from '../../components/AnalyticsView';
import { CompletedArchivePanel } from '../../components/CompletedArchivePanel';
import { KanbanQueueView } from '../../components/KanbanQueueView';
import {
  computeProjectPlateProgress,
  createFreshWorkspaceV5,
  emptyAlphabetMap,
  normalizeWorkspaceV5,
} from '../../constants';
import { ProductionJob, ProductionWorkspaceV5 } from '../../types';
import {
  compareCompletedJobsNewestFirst,
  COMPLETED_AUTO_ARCHIVE_MS,
  computeSuccessfulCompletedUnits,
  extractCompletedPlateBreakdown,
  filterCompletedArchiveJobs,
  getCompletionCalendarDateMY,
  isCompletedArchivedJob,
  isCompletedAutoArchived,
  resolveCompletedTimestampLabel,
} from '../completedPlateUtils';
import { MALAYSIA_TIMEZONE } from '../dateFormat';
import { prepareWorkspaceForFirestore } from '../firestorePayload';
import { hydrateJobCountdownFields } from '../productionCountdown';
import {
  computeProjectDemandSummary,
  filterQueueJobs,
  transitionJobState,
} from '../productionEngine';
import { computeGlobalSchedule } from '../schedulingEngine';

const OWNER_UID = 'owner-archive-test';

function makeCompletedJob(
  base: ProductionWorkspaceV5,
  overrides: Partial<ProductionJob> & { id: string; plateNumber: number }
): ProductionJob {
  const defaultCompletedIso = '2026-11-16T00:00:00.000Z';
  const defaultCompletedMs = Date.parse(defaultCompletedIso);
  return {
    projectId: base.projects[0].id,
    colorId: base.colors[0].id,
    plateCapacity: 138,
    letters: { ...emptyAlphabetMap(), X: 40, Y: 50, Z: 30 },
    plateMode: 'catalog_category',
    categoryId: 'cat-keycaps',
    categoryNameSnapshot: 'Keycaps',
    catalogItems: [
      {
        productId: 'prod-keycap-letter',
        productName: 'Keycap Letter',
        sku: 'KEY-AZ',
        categoryId: 'cat-keycaps',
        categoryName: 'Keycaps',
        variantId: 'var-x',
        variantLabel: 'X',
        colorId: base.colors[0].id,
        colorName: base.colors[0].name,
        quantity: 40,
      },
      {
        productId: 'prod-keycap-letter',
        productName: 'Keycap Letter',
        sku: 'KEY-AZ',
        categoryId: 'cat-keycaps',
        categoryName: 'Keycaps',
        variantId: 'var-y',
        variantLabel: 'Y',
        colorId: base.colors[0].id,
        colorName: base.colors[0].name,
        quantity: 50,
      },
      {
        productId: 'prod-keycap-letter',
        productName: 'Keycap Letter',
        sku: 'KEY-AZ',
        categoryId: 'cat-keycaps',
        categoryName: 'Keycaps',
        variantId: 'var-z',
        variantLabel: 'Z',
        colorId: base.colors[0].id,
        colorName: base.colors[0].name,
        quantity: 30,
      },
    ],
    stage: 'Completed',
    machineId: base.machines[0].id,
    estimatedMinutes: 180,
    actualMinutes: 175,
    actualCompletedAt: defaultCompletedIso,
    actualCompletedAtMs: defaultCompletedMs,
    completedIso: defaultCompletedIso,
    slicerVerified: true,
    stockApplied: true,
    stockTransactionId: null,
    failedCount: 0,
    failureReason: '',
    notes: '',
    createdIso: '2026-11-15T12:00:00.000Z',
    updatedIso: defaultCompletedIso,
    ...overrides,
  };
}

describe('WOOPP 6.0 — Completed Queue Sorting & Automatic 3-Day (72h) Archive', () => {
  it('1, 2 & 20. Sorts Completed plates newest-first by completion timestamp, ignores created/updated/plate numbers, and breaks ties stably', () => {
    const base = createFreshWorkspaceV5(OWNER_UID);

    const oldest = makeCompletedJob(base, {
      id: 'job-c-oldest',
      plateNumber: 10, // Higher plate number & newer updatedIso should NOT overtake actual completion time
      actualCompletedAt: '2026-11-14T08:00:00.000Z',
      actualCompletedAtMs: Date.parse('2026-11-14T08:00:00.000Z'),
      completedIso: '2026-11-14T08:00:00.000Z',
      updatedIso: '2026-11-16T23:59:00.000Z',
    });

    const middleA = makeCompletedJob(base, {
      id: 'job-b-tie-2',
      plateNumber: 2,
      actualCompletedAt: '2026-11-15T10:00:00.000Z',
      actualCompletedAtMs: Date.parse('2026-11-15T10:00:00.000Z'),
      completedIso: '2026-11-15T10:00:00.000Z',
    });

    const middleB = makeCompletedJob(base, {
      id: 'job-a-tie-1',
      plateNumber: 1,
      actualCompletedAt: '2026-11-15T10:00:00.000Z',
      actualCompletedAtMs: Date.parse('2026-11-15T10:00:00.000Z'),
      completedIso: '2026-11-15T10:00:00.000Z',
    });

    const newest = makeCompletedJob(base, {
      id: 'job-d-newest',
      plateNumber: 3,
      actualCompletedAt: '2026-11-16T09:00:00.000Z',
      actualCompletedAtMs: Date.parse('2026-11-16T09:00:00.000Z'),
      completedIso: '2026-11-16T09:00:00.000Z',
      updatedIso: '2026-11-16T09:00:00.000Z',
    });

    const missingTs = makeCompletedJob(base, {
      id: 'job-e-legacy',
      plateNumber: 0,
      actualCompletedAt: null,
      actualCompletedAtMs: null,
      completedIso: null,
      updatedIso: '2026-11-16T12:00:00.000Z',
    });

    const sorted = [oldest, missingTs, middleA, newest, middleB].sort(
      compareCompletedJobsNewestFirst
    );

    // Newest first -> Tie broken stably by plateNumber (1 before 2) -> Oldest -> Legacy without timestamp
    expect(sorted.map((j) => j.id)).toEqual([
      'job-d-newest',
      'job-a-tie-1',
      'job-b-tie-2',
      'job-c-oldest',
      'job-e-legacy',
    ]);
  });

  it('3, 4 & 5. Enforces exact 72-hour threshold (active at 71h59m, archived at 72h00m+, exact MYT prompt examples)', () => {
    const base = createFreshWorkspaceV5(OWNER_UID);

    // Example 1: Completed 16 Nov 2026, 8:00 AM MYT (= 2026-11-16T00:00:00.000Z)
    const morningDoneIso = '2026-11-16T00:00:00.000Z';
    const morningDoneMs = Date.parse(morningDoneIso);
    const morningJob = makeCompletedJob(base, {
      id: 'job-morning',
      plateNumber: 1,
      actualCompletedAt: morningDoneIso,
      actualCompletedAtMs: morningDoneMs,
      completedIso: morningDoneIso,
    });

    // At 71 hours and 59 minutes later -> still active!
    const at71h59m = morningDoneMs + 71 * 3600_000 + 59 * 60_000;
    expect(isCompletedAutoArchived(morningJob, at71h59m)).toBe(false);
    expect(isCompletedArchivedJob(morningJob, at71h59m)).toBe(false);

    // At 19 Nov 2026, 8:00 AM MYT (exact 72 hours elapsed) -> auto-archived!
    const at19Nov8amMYT = Date.parse('2026-11-19T00:00:00.000Z');
    expect(at19Nov8amMYT - morningDoneMs).toBe(COMPLETED_AUTO_ARCHIVE_MS);
    expect(isCompletedAutoArchived(morningJob, at19Nov8amMYT)).toBe(true);
    expect(isCompletedArchivedJob(morningJob, at19Nov8amMYT)).toBe(true);

    // Example 2: Completed 16 Nov 2026, 11:30 PM MYT (= 2026-11-16T15:30:00.000Z)
    const nightDoneIso = '2026-11-16T15:30:00.000Z';
    const nightDoneMs = Date.parse(nightDoneIso);
    const nightJob = makeCompletedJob(base, {
      id: 'job-night',
      plateNumber: 2,
      actualCompletedAt: nightDoneIso,
      actualCompletedAtMs: nightDoneMs,
      completedIso: nightDoneIso,
    });

    // 19 Nov 2026, 8:00 AM MYT is < 72h for 11:30 PM plate (only 56.5h, NOT calendar days!)
    expect(isCompletedAutoArchived(nightJob, at19Nov8amMYT)).toBe(false);
    // 19 Nov 2026, 11:29 PM MYT -> still active
    const at19Nov1129pmMYT = Date.parse('2026-11-19T15:29:00.000Z');
    expect(isCompletedAutoArchived(nightJob, at19Nov1129pmMYT)).toBe(false);
    // 19 Nov 2026, 11:30 PM MYT -> archived!
    const at19Nov1130pmMYT = Date.parse('2026-11-19T15:30:00.000Z');
    expect(isCompletedAutoArchived(nightJob, at19Nov1130pmMYT)).toBe(true);
  });

  it('6, 7, 8, 9, 10 & 11. Derived archive preserves Firestore job, timestamps, breakdowns, and analytics without double-counting while Active Queue excludes archived plates', () => {
    const base = createFreshWorkspaceV5(OWNER_UID);
    const doneOldMs = Date.parse('2026-11-10T04:00:00.000Z'); // > 72h before nowCheckMs
    const doneNewMs = Date.parse('2026-11-15T10:00:00.000Z'); // < 72h before nowCheckMs
    const nowCheckMs = Date.parse('2026-11-16T00:00:00.000Z');

    const oldCompleted = makeCompletedJob(base, {
      id: 'job-arch-old',
      plateNumber: 1,
      actualCompletedAt: new Date(doneOldMs).toISOString(),
      actualCompletedAtMs: doneOldMs,
      completedIso: new Date(doneOldMs).toISOString(),
    });
    const newCompleted = makeCompletedJob(base, {
      id: 'job-active-new',
      plateNumber: 2,
      letters: { ...emptyAlphabetMap(), A: 50 },
      catalogItems: [
        {
          productId: 'prod-keycap-letter',
          productName: 'Keycap Letter',
          sku: 'KEY-AZ',
          categoryId: 'cat-keycaps',
          categoryName: 'Keycaps',
          variantId: 'var-a',
          variantLabel: 'A',
          colorId: base.colors[0].id,
          colorName: base.colors[0].name,
          quantity: 50,
        },
      ],
      actualCompletedAt: new Date(doneNewMs).toISOString(),
      actualCompletedAtMs: doneNewMs,
      completedIso: new Date(doneNewMs).toISOString(),
    });

    const ws: ProductionWorkspaceV5 = {
      ...base,
      jobs: [oldCompleted, newCompleted],
    };

    // Underlying Firestore payload stays untouched (`stage: 'Completed'`, same timestamps & snapshots)
    const firestoreDoc = prepareWorkspaceForFirestore(ws, OWNER_UID);
    const fsOld = firestoreDoc.jobs.find((j) => j.id === oldCompleted.id)!;
    expect(fsOld.stage).toBe('Completed');
    expect(fsOld.actualCompletedAt).toBe(oldCompleted.actualCompletedAt);
    expect(extractCompletedPlateBreakdown(fsOld).totalQuantity).toBe(120);

    // Active Queue tab excludes old 72h+ completed job; Completed Archive tab includes it cleanly
    const activeJobs = filterQueueJobs(ws.jobs, {
      tab: 'active',
      projectId: 'ALL',
      colorId: 'ALL',
      machineId: 'ALL',
      status: 'ALL',
      nowMs: nowCheckMs,
    });
    expect(activeJobs.map((j) => j.id)).toEqual(['job-active-new']);

    const archiveSummary = filterCompletedArchiveJobs(ws.jobs, {
      workspace: ws,
      nowMs: nowCheckMs,
    });
    expect(archiveSummary.totalArchivedPlates).toBe(1);
    expect(archiveSummary.totalArchivedUnits).toBe(120);
    expect(archiveSummary.jobs[0].id).toBe('job-arch-old');

    // Analytics & Project Progress retain BOTH (120 + 50 = 170 pcs) with zero double counting
    expect(computeSuccessfulCompletedUnits(ws.jobs)).toBe(170);
    const projProgress = computeProjectPlateProgress(ws.jobs, base.projects[0].id);
    expect(projProgress.completedPlates).toBe(2);
    expect(projProgress.producedKeycaps).toBe(170);

    const demand = computeProjectDemandSummary(ws, base.projects[0]);
    expect(demand.completedKeycaps).toBe(170);

    const analyticsHtml = renderToStaticMarkup(<AnalyticsView workspace={ws} />);
    expect(analyticsHtml).toContain('170 pcs');
    expect(analyticsHtml).toContain('2 / 2 plates');
  });

  it('12 & 13. Missing or invalid completion timestamps never cause accidental archival', () => {
    const base = createFreshWorkspaceV5(OWNER_UID);
    const farFutureMs = Date.parse('2030-01-01T00:00:00.000Z');

    const missingTsJob = makeCompletedJob(base, {
      id: 'job-missing-ts',
      plateNumber: 1,
      actualCompletedAt: null,
      actualCompletedAtMs: null,
      completedIso: null,
      updatedIso: '2026-10-01T00:00:00.000Z',
    });

    const invalidTsJob = makeCompletedJob(base, {
      id: 'job-invalid-ts',
      plateNumber: 2,
      actualCompletedAt: 'not-a-timestamp',
      actualCompletedAtMs: Number.NaN,
      completedIso: 'invalid-iso',
    });

    expect(isCompletedAutoArchived(missingTsJob, farFutureMs)).toBe(false);
    expect(isCompletedAutoArchived(invalidTsJob, farFutureMs)).toBe(false);
    expect(resolveCompletedTimestampLabel(missingTsJob)).toBe('Not recorded');
    expect(resolveCompletedTimestampLabel(invalidTsJob)).toBe('Not recorded');

    const activeJobs = filterQueueJobs([missingTsJob, invalidTsJob], {
      tab: 'active',
      projectId: 'ALL',
      colorId: 'ALL',
      machineId: 'ALL',
      status: 'ALL',
      nowMs: farFutureMs,
    });
    expect(activeJobs).toHaveLength(2);
  });

  it('14 & 15. Archive updates both after reload/hydration AND live in UI when wall-clock crosses 72 hours', () => {
    const base = createFreshWorkspaceV5(OWNER_UID);
    const doneMs = Date.parse('2026-11-16T00:00:00.000Z');
    const plate = makeCompletedJob(base, {
      id: 'job-live-transition',
      plateNumber: 7,
      actualCompletedAt: new Date(doneMs).toISOString(),
      actualCompletedAtMs: doneMs,
      completedIso: new Date(doneMs).toISOString(),
    });
    const ws: ProductionWorkspaceV5 = { ...base, jobs: [plate] };

    // Simulate Firestore save + reload/hydration
    const roundTripped = normalizeWorkspaceV5(
      JSON.parse(JSON.stringify(prepareWorkspaceForFirestore(ws, OWNER_UID))),
      OWNER_UID
    );
    const hydratedWs: ProductionWorkspaceV5 = {
      ...roundTripped,
      jobs: roundTripped.jobs.map((j) => hydrateJobCountdownFields(j)),
    };

    // 71h 59m elapsed -> Active Queue tab count 1, Completed Archive count 0, plate in Completed column
    const msBefore = doneMs + COMPLETED_AUTO_ARCHIVE_MS - 60_000;
    const htmlBefore = renderToStaticMarkup(
      <KanbanQueueView
        workspace={hydratedWs}
        schedule={computeGlobalSchedule(hydratedWs, msBefore)}
        selectedProjectId="ALL"
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
    expect(htmlBefore).toContain('Plate 7');
    expect(htmlBefore).toContain('Completed Archive</span><span');

    // Page stays open, clock ticks past 72h00m -> automatically leaves Active Queue and moves into Completed Archive
    const msAfter = doneMs + COMPLETED_AUTO_ARCHIVE_MS;
    const htmlAfterActive = renderToStaticMarkup(
      <KanbanQueueView
        workspace={hydratedWs}
        schedule={computeGlobalSchedule(hydratedWs, msAfter)}
        selectedProjectId="ALL"
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
    expect(htmlAfterActive).toContain('No plates in Completed');

    const htmlAfterArchive = renderToStaticMarkup(
      <KanbanQueueView
        workspace={hydratedWs}
        schedule={computeGlobalSchedule(hydratedWs, msAfter)}
        selectedProjectId="ALL"
        isAdmin={true}
        busyJobIds={new Set()}
        initialLifecycleTab="completed_archive"
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
    expect(htmlAfterArchive).toContain('Plate 7');
    expect(htmlAfterArchive).toContain('Auto-Archived (72h+)');
    expect(htmlAfterArchive).toContain('120 pcs');
  });

  it('16 & 17. Reopened jobs and Failed / Reprint jobs are never classified as Completed Archive even with old timestamps', () => {
    const base = createFreshWorkspaceV5(OWNER_UID);
    const veryOldMs = Date.parse('2026-10-01T00:00:00.000Z');
    const nowMs = Date.parse('2026-11-20T00:00:00.000Z');

    const completedJob = makeCompletedJob(base, {
      id: 'job-reopen',
      plateNumber: 1,
      letters: emptyAlphabetMap(),
      stockApplied: false,
      actualCompletedAt: new Date(veryOldMs).toISOString(),
      actualCompletedAtMs: veryOldMs,
      completedIso: new Date(veryOldMs).toISOString(),
    });
    const ws = { ...base, jobs: [completedJob] };

    // Reopen to Ready to Print
    const reopenedWs = transitionJobState(ws, completedJob.id, 'Ready to Print', {
      machineId: null,
      nowMs,
    }).nextWorkspace!;
    expect(isCompletedAutoArchived(reopenedWs.jobs[0], nowMs)).toBe(false);
    expect(isCompletedArchivedJob(reopenedWs.jobs[0], nowMs)).toBe(false);

    // Failed / Reprint even if stale completion timestamp exists on record
    const failedJobWithStaleTs: ProductionJob = {
      ...completedJob,
      id: 'job-failed-stale',
      stage: 'Failed / Reprint',
      failedCount: 1,
    };
    expect(isCompletedAutoArchived(failedJobWithStaleTs, nowMs)).toBe(false);
    expect(isCompletedArchivedJob(failedJobWithStaleTs, nowMs)).toBe(false);
    const activeAfterFail = filterQueueJobs([failedJobWithStaleTs], {
      tab: 'active',
      projectId: 'ALL',
      colorId: 'ALL',
      machineId: 'ALL',
      status: 'ALL',
      nowMs,
    });
    expect(activeAfterFail.map((j) => j.id)).toEqual(['job-failed-stale']);
  });

  it('18, 19 & 21. Archive search (project, product, filament color), Malaysia calendar date filtering (UTC boundary), and full UI field rendering work together cleanly', () => {
    const base = createFreshWorkspaceV5(OWNER_UID);
    const projA = { ...base.projects[0], id: 'proj-alpha', name: 'Mydin Klebang' };
    const projB = { ...base.projects[0], id: 'proj-beta', name: 'Vintage Night' };
    const colorPink = { id: 'col-pink', name: 'Bubblegum Pink', hex: '#EC4899' };
    const colorBlack = { id: 'col-black', name: 'Matte Black', hex: '#111827' };

    // Completed at 2026-11-12T17:30:00.000Z = 13 Nov 2026, 1:30 AM MYT! (UTC date is Nov 12, MYT date is Nov 13!)
    const boundaryUtcIso = '2026-11-12T17:30:00.000Z';
    const job1 = makeCompletedJob(base, {
      id: 'arch-1',
      plateNumber: 1,
      projectId: projA.id,
      colorId: colorPink.id,
      machineId: base.machines[0].id,
      actualMinutes: 145,
      actualCompletedAt: boundaryUtcIso,
      actualCompletedAtMs: Date.parse(boundaryUtcIso),
      completedIso: boundaryUtcIso,
      catalogItems: [
        {
          productId: 'p-base',
          productName: 'Base V1',
          sku: 'BASE-01',
          categoryId: 'cat-1',
          categoryName: 'Bases',
          variantId: 'v-mat',
          variantLabel: 'Matte',
          colorId: colorPink.id,
          colorName: colorPink.name,
          quantity: 60,
        },
      ],
      letters: emptyAlphabetMap(),
    });

    // Completed at 2026-11-10T04:00:00.000Z = 10 Nov 2026, 12:00 PM MYT
    const olderIso = '2026-11-10T04:00:00.000Z';
    const job2 = makeCompletedJob(base, {
      id: 'arch-2',
      plateNumber: 2,
      projectId: projB.id,
      colorId: colorBlack.id,
      actualCompletedAt: olderIso,
      actualCompletedAtMs: Date.parse(olderIso),
      completedIso: olderIso,
    });

    const ws: ProductionWorkspaceV5 = {
      ...base,
      projects: [projA, projB],
      colors: [colorPink, colorBlack],
      jobs: [job1, job2],
    };

    const nowMs = Date.parse('2026-11-20T00:00:00.000Z');

    // Verify MYT calendar date extraction crosses midnight correctly
    expect(getCompletionCalendarDateMY(job1, MALAYSIA_TIMEZONE)).toBe('2026-11-13');
    expect(getCompletionCalendarDateMY(job2, MALAYSIA_TIMEZONE)).toBe('2026-11-10');

    // Search by project name
    expect(
      filterCompletedArchiveJobs(ws.jobs, { workspace: ws, nowMs, searchQuery: 'klebang' })
        .jobs.map((j) => j.id)
    ).toEqual(['arch-1']);

    // Search by product name
    expect(
      filterCompletedArchiveJobs(ws.jobs, { workspace: ws, nowMs, searchQuery: 'Base V1' })
        .jobs.map((j) => j.id)
    ).toEqual(['arch-1']);

    // Search by filament color name
    expect(
      filterCompletedArchiveJobs(ws.jobs, { workspace: ws, nowMs, searchQuery: 'matte black' })
        .jobs.map((j) => j.id)
    ).toEqual(['arch-2']);

    // Date filter using MYT date (filtering 2026-11-13 to 2026-11-13 matches job1 despite UTC Nov 12!)
    const dateFiltered = filterCompletedArchiveJobs(ws.jobs, {
      workspace: ws,
      nowMs,
      dateFrom: '2026-11-13',
      dateTo: '2026-11-13',
    });
    expect(dateFiltered.jobs.map((j) => j.id)).toEqual(['arch-1']);
    expect(dateFiltered.totalArchivedPlates).toBe(2);
    expect(dateFiltered.totalArchivedUnits).toBe(180);
    expect(dateFiltered.filteredUnits).toBe(60);

    // Search + Date range combined
    expect(
      filterCompletedArchiveJobs(ws.jobs, {
        workspace: ws,
        nowMs,
        searchQuery: 'Bubblegum Pink',
        dateFrom: '2026-11-13',
        dateTo: '2026-11-13',
      }).jobs.map((j) => j.id)
    ).toEqual(['arch-1']);

    // Render CompletedArchivePanel and assert all required fields appear cleanly
    const archiveHtml = renderToStaticMarkup(
      <CompletedArchivePanel
        workspace={ws}
        nowMs={nowMs}
        projectFilter="ALL"
        colorFilter="ALL"
        machineFilter="ALL"
      />
    );
    expect(archiveHtml).toContain('Completed Archive (3+ Days / 72h+)');
    expect(archiveHtml).toContain('Plate 1');
    expect(archiveHtml).toContain('Mydin Klebang');
    expect(archiveHtml).toContain('Base V1');
    expect(archiveHtml).toContain('Bubblegum Pink');
    expect(archiveHtml).toContain('13 Nov 2026 · 1:30 AM');
    expect(archiveHtml).toContain(base.machines[0].name);
    expect(archiveHtml).toContain('2h 25m');
    expect(archiveHtml).toContain('180 pcs');
  });
});
