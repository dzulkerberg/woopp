import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { KanbanQueueView } from '../../components/KanbanQueueView';
import { createFreshWorkspaceV5, emptyAlphabetMap } from '../../constants';
import { ProductionJob, ProductionWorkspaceV5 } from '../../types';
import { computeGlobalSchedule } from '../schedulingEngine';

function buildQueueLayoutWorkspace(isPaused = false): ProductionWorkspaceV5 {
  const base = createFreshWorkspaceV5('owner-uid');
  const project = base.projects[0];
  const colorId = base.colors[0].id;
  const machineId = base.machines[0].id;
  const nowMs = Date.parse('2026-10-30T12:00:00.000Z');
  const startMs = nowMs - 30 * 60_000;
  const durationMs = 180 * 60_000;
  const finishMs = startMs + durationMs;

  const letters = { ...emptyAlphabetMap(), A: 69, B: 69 };

  const printingJob: ProductionJob = {
    id: 'job-printing-1',
    projectId: project.id,
    colorId,
    plateNumber: 1,
    plateCapacity: 138,
    letters,
    stage: 'Printing',
    machineId,
    estimatedMinutes: 180,
    actualMinutes: 0,
    actualStartedAt: new Date(startMs).toISOString(),
    estimatedDurationMs: durationMs,
    estimatedFinishAt: new Date(finishMs).toISOString(),
    pausedAt: isPaused ? new Date(nowMs - 5 * 60_000).toISOString() : null,
    remainingAtPauseMs: isPaused ? 145 * 60_000 : null,
    actualCompletedAt: null,
    isPaused,
    slicerVerified: true,
    stockApplied: false,
    stockTransactionId: null,
    completedIso: null,
    failedCount: 0,
    failureReason: '',
    notes: '',
    createdIso: new Date(startMs).toISOString(),
    updatedIso: new Date(nowMs).toISOString(),
  };

  const plannedJob: ProductionJob = {
    ...printingJob,
    id: 'job-planned-2',
    plateNumber: 2,
    stage: 'Planned',
    machineId: null,
    actualStartedAt: null,
    estimatedFinishAt: null,
    pausedAt: null,
    remainingAtPauseMs: null,
    isPaused: false,
  };

  const failedJob: ProductionJob = {
    ...printingJob,
    id: 'job-failed-3',
    plateNumber: 3,
    stage: 'Failed / Reprint',
    machineId: null,
    actualStartedAt: null,
    estimatedFinishAt: null,
    pausedAt: null,
    remainingAtPauseMs: null,
    isPaused: false,
    failedCount: 1,
    failureReason: 'Bed adhesion issue',
  };

  return {
    ...base,
    machines: base.machines.map((m, idx) =>
      idx === 0 ? { ...m, status: 'Printing', activeJobId: printingJob.id } : m
    ),
    jobs: [printingJob, plannedJob, failedJob],
  };
}

describe('Print Queue Card Responsive Overflow Protection', () => {
  it('renders Pause Countdown and Cancel Print inside a responsive flex-wrap container without nowrap overflow', () => {
    const nowMs = Date.parse('2026-10-30T12:00:00.000Z');
    const workspace = buildQueueLayoutWorkspace(false);
    const schedule = computeGlobalSchedule(workspace, nowMs);

    const html = renderToStaticMarkup(
      <KanbanQueueView
        workspace={workspace}
        schedule={schedule}
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

    expect(html).toContain('Pause Countdown');
    expect(html).toContain('Cancel Print');

    // Match the action container wrapping Pause Countdown & Cancel Print
    const actionBlockMatch = html.match(
      /<div class="([^"]*)"><button[^>]*class="([^"]*)"[^>]*>Pause Countdown<\/button><button[^>]*class="([^"]*)"[^>]*>Cancel Print<\/button><\/div>/
    );
    expect(actionBlockMatch).not.toBeNull();

    const [, containerClass, pauseBtnClass, cancelBtnClass] = actionBlockMatch!;
    expect(containerClass).toContain('flex-wrap');
    expect(containerClass).toContain('min-w-0');
    expect(containerClass).not.toContain('flex-nowrap');

    for (const btnClass of [pauseBtnClass, cancelBtnClass]) {
      expect(btnClass).toContain('w-full');
      expect(btnClass).toContain('sm:w-auto');
      expect(btnClass).toContain('min-w-0');
      expect(btnClass).toContain('break-words');
      expect(btnClass).not.toContain('whitespace-nowrap');
    }

    // Every Kanban card article enforces min-w-0 width constraint
    const articles = [...html.matchAll(/<article class="([^"]*)"/g)];
    expect(articles.length).toBeGreaterThanOrEqual(3);
    for (const [, articleClass] of articles) {
      expect(articleClass).toContain('min-w-0');
    }
  });

  it('renders Paused printing actions (Resume Print & Cancel) with responsive flex-wrap sizing', () => {
    const nowMs = Date.parse('2026-10-30T12:00:00.000Z');
    const workspace = buildQueueLayoutWorkspace(true);
    const schedule = computeGlobalSchedule(workspace, nowMs);

    const html = renderToStaticMarkup(
      <KanbanQueueView
        workspace={workspace}
        schedule={schedule}
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

    const pausedActionMatch = html.match(
      /<div class="([^"]*)"><button[^>]*class="([^"]*)"[^>]*>Resume Print<\/button><button[^>]*class="([^"]*)"[^>]*>Cancel<\/button><\/div>/
    );
    expect(pausedActionMatch).not.toBeNull();

    const [, containerClass, resumeBtnClass, cancelBtnClass] = pausedActionMatch!;
    expect(containerClass).toContain('flex-wrap');
    expect(containerClass).toContain('min-w-0');
    expect(resumeBtnClass).toContain('w-full');
    expect(resumeBtnClass).toContain('sm:w-auto');
    expect(resumeBtnClass).not.toContain('whitespace-nowrap');
    expect(cancelBtnClass).toContain('w-full');
    expect(cancelBtnClass).toContain('sm:w-auto');
    expect(cancelBtnClass).not.toContain('whitespace-nowrap');
  });
});
