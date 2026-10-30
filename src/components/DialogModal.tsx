import React from 'react';

export interface ModalConfig {
  type: 'alert' | 'confirm' | 'copy';
  title?: string;
  message: string;
  copyText?: string;
  confirmLabel?: string;
  onConfirm?: () => void;
  onClose: () => void;
}

interface DialogModalProps {
  modal: ModalConfig | null;
}

export const DialogModal: React.FC<DialogModalProps> = ({ modal }) => {
  if (!modal) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 no-print"
      onClick={modal.onClose}
    >
      <div
        className="bg-surface border border-line rounded-xl p-6 max-w-md w-full shadow-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {modal.title && (
          <h3 className="text-base font-semibold text-ink mb-2">
            {modal.title}
          </h3>
        )}
        <p className="text-sm text-ink-secondary whitespace-pre-line mb-5">
          {modal.message}
        </p>
        {modal.type === 'copy' && modal.copyText !== undefined && (
          <textarea
            className="w-full mb-4 p-3 rounded-lg border border-line bg-recessed text-xs font-mono-data text-ink h-36"
            readOnly
            value={modal.copyText}
            onFocus={(e) => e.currentTarget.select()}
          />
        )}
        <div className="flex justify-end gap-2.5">
          {modal.type === 'confirm' ? (
            <>
              <button
                type="button"
                onClick={modal.onClose}
                className="px-4 py-2 text-xs font-medium rounded-lg border border-line bg-surface hover:bg-elevated text-ink-secondary hover:text-ink transition-colors whitespace-nowrap"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  modal.onConfirm?.();
                  modal.onClose();
                }}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-brand hover:bg-brand-hover text-white transition-colors whitespace-nowrap"
              >
                {modal.confirmLabel || 'Confirm'}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={modal.onClose}
              className="px-4 py-2 text-xs font-semibold rounded-lg bg-brand hover:bg-brand-hover text-white transition-colors whitespace-nowrap"
            >
              OK
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
