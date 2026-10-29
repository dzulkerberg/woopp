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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 no-print"
      onClick={modal.onClose}
    >
      <div
        className="bg-white dark:bg-[#1a1826] border border-neutral-200 dark:border-neutral-800 rounded-2xl p-6 max-w-md w-full shadow-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {modal.title && (
          <h3 className="text-base font-semibold text-neutral-900 dark:text-white mb-2">
            {modal.title}
          </h3>
        )}
        <p className="text-sm text-neutral-600 dark:text-neutral-300 whitespace-pre-line mb-5">
          {modal.message}
        </p>
        {modal.type === 'copy' && modal.copyText !== undefined && (
          <textarea
            className="w-full mb-4 p-3 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 text-xs font-mono-data text-neutral-800 dark:text-neutral-200 h-36"
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
                className="px-4 py-2 text-xs font-medium rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors whitespace-nowrap"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  modal.onConfirm?.();
                  modal.onClose();
                }}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-[#6c4ce6] hover:bg-[#5b3cc4] text-white transition-colors whitespace-nowrap"
              >
                {modal.confirmLabel || 'Confirm'}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={modal.onClose}
              className="px-4 py-2 text-xs font-semibold rounded-lg bg-[#6c4ce6] hover:bg-[#5b3cc4] text-white transition-colors whitespace-nowrap"
            >
              OK
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
