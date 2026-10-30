import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  MoreVertical,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  XCircle,
} from 'lucide-react';
import { countPlateKeycaps, formatPlateItemsText } from '../constants';
import { KanbanStage, ProductionJob, ProductionWorkspaceV5 } from '../types';
import {
  canArchivePlate,
  canCancelPrintingJob,
  canDeletePlate,
  canRestorePlate,
  getPlateCarryForwardImpact,
} from '../utils/productionEngine';

export interface PlateLifecycleMenuProps {
  job: ProductionJob;
  isAdmin: boolean;
  isBusy: boolean;
  onRequestDelete: (job: ProductionJob) => void;
  onRequestCancelPrinting: (job: ProductionJob) => void;
  onArchivePlate: (job: ProductionJob) => void;
  onRestorePlate: (job: ProductionJob) => void;
  onTransitionStage: (
    jobId: string,
    nextStage: KanbanStage,
    opts?: { machineId?: string | null; failureReason?: string }
  ) => void;
  onPauseOrResume: (
    jobId: string,
    action: 'pause' | 'resume' | 'update_remaining'
  ) => void;
}

export const PlateLifecycleMenu: React.FC<PlateLifecycleMenuProps> = ({
  job,
  isAdmin,
  isBusy,
  onRequestDelete,
  onRequestCancelPrinting,
  onArchivePlate,
  onRestorePlate,
  onTransitionStage,
  onPauseOrResume,
}) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleOutsideClick = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  const deletable = canDeletePlate(job);
  const cancellable = canCancelPrintingJob(job);
  const archivable = canArchivePlate(job);
  const restorable = canRestorePlate(job);

  return (
    <div ref={containerRef} className="relative inline-block text-left">
      <button
        type="button"
        disabled={isBusy}
        aria-label={`Actions for Plate ${job.plateNumber}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((prev) => !prev);
        }}
        className="p-1.5 rounded-lg border border-transparent hover:border-line hover:bg-elevated text-muted hover:text-ink disabled:opacity-40 transition-colors"
      >
        <MoreVertical className="w-4 h-4" />
      </button>

      {open && (
        <div
          role="menu"
          onClick={(e) => e.stopPropagation()}
          className="absolute right-0 mt-1.5 w-52 z-30 rounded-xl bg-surface border border-line shadow-lg py-1.5 text-xs"
        >
          <div className="px-3 py-1.5 border-b border-line">
            <div className="font-semibold text-ink font-mono-data">
              Plate {job.plateNumber}
            </div>
            <div className="text-[11px] text-muted truncate font-mono-data">
              {job.id}
            </div>
          </div>

          {/* Workflow shortcuts when active */}
          {!job.archived && job.stage === 'Planned' && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onTransitionStage(job.id, 'Ready to Print');
              }}
              className="w-full px-3 py-2 text-left flex items-center gap-2 text-ink hover:bg-elevated whitespace-nowrap transition-colors"
            >
              <Play className="w-3.5 h-3.5 text-brand-text shrink-0" />
              <span>Move to Ready to Print</span>
            </button>
          )}

          {!job.archived && job.stage === 'Ready to Print' && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onTransitionStage(job.id, 'Planned');
              }}
              className="w-full px-3 py-2 text-left flex items-center gap-2 text-ink hover:bg-elevated whitespace-nowrap transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5 text-muted shrink-0" />
              <span>Move Back to Planned</span>
            </button>
          )}

          {!job.archived && job.stage === 'Printing' && (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onPauseOrResume(job.id, job.isPaused ? 'resume' : 'pause');
                }}
                className="w-full px-3 py-2 text-left flex items-center gap-2 text-ink hover:bg-elevated whitespace-nowrap transition-colors"
              >
                {job.isPaused ? (
                  <Play className="w-3.5 h-3.5 text-brand-text shrink-0" />
                ) : (
                  <Pause className="w-3.5 h-3.5 text-warning-text shrink-0" />
                )}
                <span>{job.isPaused ? 'Resume Countdown' : 'Pause Countdown'}</span>
              </button>

              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onTransitionStage(job.id, 'Completed', {
                    machineId: job.machineId,
                  });
                }}
                className="w-full px-3 py-2 text-left flex items-center gap-2 text-brand-text hover:bg-elevated whitespace-nowrap transition-colors"
              >
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                <span>Mark Completed</span>
              </button>

              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onTransitionStage(job.id, 'Failed / Reprint', {
                    machineId: job.machineId,
                  });
                }}
                className="w-full px-3 py-2 text-left flex items-center gap-2 text-warning-text hover:bg-elevated whitespace-nowrap transition-colors"
              >
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span>Mark Failed / Reprint</span>
              </button>
            </>
          )}

          {!job.archived && job.stage === 'Failed / Reprint' && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onTransitionStage(job.id, 'Ready to Print');
              }}
              className="w-full px-3 py-2 text-left flex items-center gap-2 text-warning-text hover:bg-elevated whitespace-nowrap transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5 shrink-0" />
              <span>Reprint (Ready to Print)</span>
            </button>
          )}

          {/* Lifecycle Destructive / Archival Actions */}
          <div className="my-1 border-t border-line" />

          {cancellable && (
            <button
              type="button"
              role="menuitem"
              disabled={!isAdmin || isBusy}
              onClick={() => {
                setOpen(false);
                onRequestCancelPrinting(job);
              }}
              className="w-full px-3 py-2 text-left flex items-center gap-2 text-error-text hover:bg-error-soft disabled:opacity-45 font-medium whitespace-nowrap transition-colors"
            >
              <XCircle className="w-3.5 h-3.5 shrink-0" />
              <span>Cancel Printing...</span>
            </button>
          )}

          {archivable && (
            <button
              type="button"
              role="menuitem"
              disabled={!isAdmin || isBusy}
              onClick={() => {
                setOpen(false);
                onArchivePlate(job);
              }}
              className="w-full px-3 py-2 text-left flex items-center gap-2 text-ink hover:bg-elevated disabled:opacity-45 font-medium whitespace-nowrap transition-colors"
            >
              <Archive className="w-3.5 h-3.5 text-muted shrink-0" />
              <span>Archive Plate</span>
            </button>
          )}

          {restorable && (
            <button
              type="button"
              role="menuitem"
              disabled={!isAdmin || isBusy}
              onClick={() => {
                setOpen(false);
                onRestorePlate(job);
              }}
              className="w-full px-3 py-2 text-left flex items-center gap-2 text-brand-text hover:bg-brand-soft disabled:opacity-45 font-medium whitespace-nowrap transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5 shrink-0" />
              <span>Restore Plate</span>
            </button>
          )}

          {deletable ? (
            <button
              type="button"
              role="menuitem"
              disabled={!isAdmin || isBusy}
              onClick={() => {
                setOpen(false);
                onRequestDelete(job);
              }}
              className="w-full px-3 py-2 text-left flex items-center gap-2 text-error-text hover:bg-error-soft disabled:opacity-45 font-medium whitespace-nowrap transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5 shrink-0" />
              <span>Delete Plate...</span>
            </button>
          ) : (
            <div className="px-3 py-1.5 text-[11px] text-muted">
              {job.stage === 'Printing'
                ? 'Cannot delete while Printing'
                : job.stage === 'Completed'
                ? 'Completed record protected'
                : 'Delete disabled · Archive supported'}
            </div>
          )}

          {!isAdmin && (
            <div className="px-3 py-1.5 text-[11px] text-warning-text border-t border-line">
              Admin permission required
            </div>
          )}
        </div>
      )}
    </div>
  );
};

interface DeletePlateModalProps {
  job: ProductionJob | null;
  workspace: ProductionWorkspaceV5;
  isSaving: boolean;
  onClose: () => void;
  onConfirmDelete: (jobId: string) => Promise<void>;
}

export const DeletePlateConfirmModal: React.FC<DeletePlateModalProps> = ({
  job,
  workspace,
  isSaving,
  onClose,
  onConfirmDelete,
}) => {
  if (!job) return null;

  const project = workspace.projects.find((p) => p.id === job.projectId);
  const color = workspace.colors.find((c) => c.id === job.colorId);
  const machine = job.machineId
    ? workspace.machines.find((m) => m.id === job.machineId)
    : null;
  const totalKeycaps = countPlateKeycaps(job);
  const itemsPreview = formatPlateItemsText(job, true);
  const carryImpact = getPlateCarryForwardImpact(workspace, job);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 no-print"
      onClick={() => {
        if (!isSaving) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-plate-modal-title"
        onClick={(e) => e.stopPropagation()}
        className="bg-surface border border-line rounded-xl p-6 max-w-md w-full shadow-lg space-y-4"
      >
        <div>
          <div className="text-xs font-semibold text-error-text">
            Confirm Plate Deletion
          </div>
          <h3
            id="delete-plate-modal-title"
            className="text-base font-semibold text-ink mt-0.5"
          >
            Delete Plate {job.plateNumber} from Print Queue?
          </h3>
          <p className="text-xs text-ink-secondary mt-1">
            Only this selected plate will be removed from Cloud Firestore. Unrelated plates will not be regenerated or modified, and project queue &amp; ETA will update immediately.
          </p>
        </div>

        <div className="rounded-xl border border-line bg-recessed p-3.5 space-y-2 text-xs">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted">Plate ID</span>
            <span className="font-mono-data font-semibold text-ink text-right break-all">
              Plate {job.plateNumber} ({job.id})
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted">Project</span>
            <span className="font-medium text-ink text-right">
              {project?.name || 'Unknown Project'}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted">Color</span>
            <span className="font-medium text-ink flex items-center gap-1.5">
              {color && (
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0 border border-line"
                  style={{ backgroundColor: color.hex }}
                />
              )}
              <span>{color?.name || job.colorId}</span>
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted">Total Keycaps</span>
            <span className="font-mono-data font-semibold text-ink">
              {totalKeycaps.toLocaleString()} / {job.plateCapacity} pcs
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted">Assigned Machine</span>
            <span className="font-medium text-ink text-right">
              {machine ? machine.name : 'Unassigned (Auto-Schedule)'}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted">
              Remaining Active Plates (Color)
            </span>
            <span className="font-mono-data font-semibold text-ink">
              {carryImpact.remainingActivePlatesCount} plate(s) ·{' '}
              {carryImpact.remainingValidKeycaps.toLocaleString()} pcs
            </span>
          </div>
          {itemsPreview && (
            <div className="pt-2 border-t border-line text-[11px] font-mono-data text-muted truncate">
              {itemsPreview}
            </div>
          )}
        </div>

        {carryImpact.clearedCarryForwardCount > 0 && (
          <div className="p-3 rounded-xl bg-warning-soft border border-warning-border text-xs text-warning-text">
            <span className="font-semibold">Carry-Forward Sync:</span>{' '}
            <span className="font-mono-data font-semibold">
              {carryImpact.clearedCarryForwardCount.toLocaleString()} pcs
            </span>{' '}
            of incomplete-plate carry-forward from this planning session will also be cleared automatically so stale carry-forward records never persist after deletion.
          </div>
        )}

        <div className="flex justify-end gap-2.5 pt-1">
          <button
            type="button"
            disabled={isSaving}
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium rounded-lg border border-line bg-elevated text-ink hover:bg-recessed disabled:opacity-50 whitespace-nowrap transition-colors"
          >
            Keep Plate
          </button>
          <button
            type="button"
            disabled={isSaving}
            onClick={() => void onConfirmDelete(job.id)}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-status-error hover:opacity-90 text-white disabled:opacity-50 whitespace-nowrap transition-opacity"
          >
            {isSaving ? 'Deleting...' : 'Delete Plate'}
          </button>
        </div>
      </div>
    </div>
  );
};

interface CancelPrintingModalProps {
  job: ProductionJob | null;
  workspace: ProductionWorkspaceV5;
  isSaving: boolean;
  onClose: () => void;
  onConfirmCancel: (jobId: string, reason: string) => Promise<void>;
}

export const CancelPrintingConfirmModal: React.FC<CancelPrintingModalProps> = ({
  job,
  workspace,
  isSaving,
  onClose,
  onConfirmCancel,
}) => {
  const [reason, setReason] = useState('');

  useEffect(() => {
    setReason('');
  }, [job?.id]);

  if (!job) return null;

  const project = workspace.projects.find((p) => p.id === job.projectId);
  const color = workspace.colors.find((c) => c.id === job.colorId);
  const machine = job.machineId
    ? workspace.machines.find((m) => m.id === job.machineId)
    : null;
  const totalKeycaps = countPlateKeycaps(job);
  const carryImpact = getPlateCarryForwardImpact(workspace, job);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 no-print"
      onClick={() => {
        if (!isSaving) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cancel-print-modal-title"
        onClick={(e) => e.stopPropagation()}
        className="bg-surface border border-line rounded-xl p-6 max-w-lg w-full shadow-lg space-y-4"
      >
        <div>
          <div className="text-xs font-semibold text-error-text">
            Cancel Active Print Job
          </div>
          <h3
            id="cancel-print-modal-title"
            className="text-base font-semibold text-ink mt-0.5"
          >
            Cancel Printing Plate {job.plateNumber}?
          </h3>
          <p className="text-xs text-ink-secondary mt-1">
            This marks the job as <span className="font-semibold text-ink">Cancelled</span>, releases{' '}
            <span className="font-semibold text-ink">
              {machine ? machine.name : 'its assigned printer'}
            </span>{' '}
            back to Idle, recalculates remaining production ETA, and logs the cancellation in activity history.
          </p>
        </div>

        {/* Mandatory Physical Bambu Printer Notice */}
        <div className="p-3.5 rounded-xl bg-warning-soft border border-warning-border flex items-start gap-2.5 text-xs text-warning-text">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">
              Physical Bambu Printer Must Be Stopped Separately
            </div>
            <p className="mt-0.5 opacity-95">
              Cancelling this job in the WOOPP web app does <b>not</b> physically stop your Bambu Lab printer. Stop the active print directly on the printer screen, Bambu Handy, or Bambu Studio.
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-line bg-recessed p-3.5 space-y-1.5 text-xs">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted">Plate ID</span>
            <span className="font-mono-data font-semibold text-ink">
              Plate {job.plateNumber} ({job.id})
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted">Project &amp; Color</span>
            <span className="font-medium text-ink">
              {project?.name || 'Project'} · {color?.name || job.colorId}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted">Keycaps Affected</span>
            <span className="font-mono-data font-semibold text-ink">
              {totalKeycaps.toLocaleString()} pcs
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted">Printer Released</span>
            <span className="font-medium text-ink">
              {machine ? `${machine.name} → Idle` : 'Unassigned'}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted">
              Remaining Active Plates (Color)
            </span>
            <span className="font-mono-data font-semibold text-ink">
              {carryImpact.remainingActivePlatesCount} plate(s) ·{' '}
              {carryImpact.remainingValidKeycaps.toLocaleString()} pcs
            </span>
          </div>
        </div>

        {carryImpact.clearedCarryForwardCount > 0 && (
          <div className="p-3 rounded-xl bg-warning-soft border border-warning-border text-xs text-warning-text">
            <span className="font-semibold">Carry-Forward Sync:</span>{' '}
            <span className="font-mono-data font-semibold">
              {carryImpact.clearedCarryForwardCount.toLocaleString()} pcs
            </span>{' '}
            of incomplete-plate carry-forward from this planning session will also be invalidated.
          </div>
        )}

        <div>
          <label
            htmlFor="cancel-print-reason-input"
            className="block text-xs font-semibold text-ink-secondary mb-1"
          >
            Cancellation Reason <span className="font-normal text-muted">(Optional)</span>
          </label>
          <input
            id="cancel-print-reason-input"
            type="text"
            maxLength={200}
            placeholder="e.g. Bed adhesion issue, filament change, wrong plate started..."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={isSaving}
            className="w-full px-3 py-2 rounded-lg border border-line bg-input text-xs text-ink focus:border-brand focus:outline-none"
          />
        </div>

        <div className="flex justify-end gap-2.5 pt-1">
          <button
            type="button"
            disabled={isSaving}
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium rounded-lg border border-line bg-elevated text-ink hover:bg-recessed disabled:opacity-50 whitespace-nowrap transition-colors"
          >
            Keep Printing
          </button>
          <button
            type="button"
            disabled={isSaving}
            onClick={() => void onConfirmCancel(job.id, reason)}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-status-error hover:opacity-90 text-white disabled:opacity-50 whitespace-nowrap transition-opacity"
          >
            {isSaving ? 'Cancelling...' : 'Confirm Cancel Printing'}
          </button>
        </div>
      </div>
    </div>
  );
};

export type BulkQueueActionKind = 'bulk_delete' | 'bulk_archive' | 'bulk_restore';

interface BulkQueueActionModalProps {
  action: BulkQueueActionKind | null;
  jobs: ProductionJob[];
  workspace: ProductionWorkspaceV5;
  isSaving: boolean;
  onClose: () => void;
  onConfirmBulk: (action: BulkQueueActionKind, jobIds: string[]) => Promise<void>;
}

export const BulkQueueActionModal: React.FC<BulkQueueActionModalProps> = ({
  action,
  jobs,
  workspace,
  isSaving,
  onClose,
  onConfirmBulk,
}) => {
  if (!action || jobs.length === 0) return null;

  const totalKeycaps = jobs.reduce((sum, j) => sum + countPlateKeycaps(j), 0);

  const meta =
    action === 'bulk_delete'
      ? {
          badge: 'Bulk Delete Plates',
          badgeClass: 'text-error-text',
          title: `Delete ${jobs.length} Selected Plate${jobs.length === 1 ? '' : 's'}?`,
          description:
            'Permanently deletes the selected Planned / Ready to Print plates from Cloud Firestore. Unrelated plates remain untouched and project queue & completion ETAs will update.',
          confirmLabel: isSaving
            ? 'Deleting Plates...'
            : `Delete ${jobs.length} Plate${jobs.length === 1 ? '' : 's'}`,
          confirmClass: 'bg-status-error hover:opacity-90 text-white',
        }
      : action === 'bulk_archive'
      ? {
          badge: 'Bulk Archive Historical Plates',
          badgeClass: 'text-brand-text',
          title: `Archive ${jobs.length} Historical Plate${jobs.length === 1 ? '' : 's'}?`,
          description:
            'Moves selected Completed, Failed / Reprint, and Cancelled records out of the Active Queue into Archived. Completed keycap counts, inventory stock, actual print durations, and machine counters are strictly preserved.',
          confirmLabel: isSaving
            ? 'Archiving Plates...'
            : `Archive ${jobs.length} Plate${jobs.length === 1 ? '' : 's'}`,
          confirmClass: 'bg-brand hover:bg-brand-hover text-white',
        }
      : {
          badge: 'Bulk Restore Archived Plates',
          badgeClass: 'text-brand-text',
          title: `Restore ${jobs.length} Archived Plate${jobs.length === 1 ? '' : 's'}?`,
          description:
            'Restores selected plates from Archived back to their queue view without altering completed production counts or inventory stock.',
          confirmLabel: isSaving
            ? 'Restoring Plates...'
            : `Restore ${jobs.length} Plate${jobs.length === 1 ? '' : 's'}`,
          confirmClass: 'bg-brand hover:bg-brand-hover text-white',
        };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 no-print"
      onClick={() => {
        if (!isSaving) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-queue-modal-title"
        onClick={(e) => e.stopPropagation()}
        className="bg-surface border border-line rounded-xl p-6 max-w-lg w-full shadow-lg space-y-4"
      >
        <div>
          <div className={`text-xs font-semibold ${meta.badgeClass}`}>
            {meta.badge}
          </div>
          <h3
            id="bulk-queue-modal-title"
            className="text-base font-semibold text-ink mt-0.5"
          >
            {meta.title}
          </h3>
          <p className="text-xs text-ink-secondary mt-1">
            {meta.description}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 p-3.5 rounded-xl bg-recessed border border-line text-xs">
          <div>
            <div className="text-muted">Selected Plates</div>
            <div className="text-lg font-bold font-mono-data text-ink mt-0.5">
              {jobs.length}
            </div>
          </div>
          <div>
            <div className="text-muted">Total Keycaps Affected</div>
            <div className="text-lg font-bold font-mono-data text-ink mt-0.5">
              {totalKeycaps.toLocaleString()} pcs
            </div>
          </div>
        </div>

        <div className="max-h-48 overflow-y-auto rounded-xl border border-line divide-y divide-line text-xs">
          {jobs.map((j) => {
            const proj = workspace.projects.find((p) => p.id === j.projectId);
            const color = workspace.colors.find((c) => c.id === j.colorId);
            const machine = j.machineId
              ? workspace.machines.find((m) => m.id === j.machineId)
              : null;
            return (
              <div
                key={j.id}
                className="px-3.5 py-2 flex items-center justify-between gap-3 bg-surface"
              >
                <div className="min-w-0">
                  <div className="font-semibold text-ink font-mono-data truncate">
                    Plate {j.plateNumber} · {proj?.name || 'Project'} ({color?.name || j.colorId})
                  </div>
                  <div className="text-[11px] text-muted truncate font-mono-data">
                    {j.id} · {j.stage}
                    {machine ? ` · ${machine.name}` : ' · Unassigned'}
                  </div>
                </div>
                <span className="font-mono-data font-semibold text-ink-secondary whitespace-nowrap">
                  {countPlateKeycaps(j)} pcs
                </span>
              </div>
            );
          })}
        </div>

        <div className="flex justify-end gap-2.5 pt-1">
          <button
            type="button"
            disabled={isSaving}
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium rounded-lg border border-line bg-elevated text-ink hover:bg-recessed disabled:opacity-50 whitespace-nowrap transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isSaving}
            onClick={() =>
              void onConfirmBulk(
                action,
                jobs.map((j) => j.id)
              )
            }
            className={`px-4 py-2 text-xs font-semibold rounded-lg disabled:opacity-50 whitespace-nowrap transition-colors ${meta.confirmClass}`}
          >
            {meta.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
