import React from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';

export type ToastVariant = 'success' | 'warning' | 'error' | 'info';

export interface ToastMessage {
  id: string;
  variant: ToastVariant;
  message: string;
}

export interface ToastStackProps {
  toasts: readonly ToastMessage[];
  onDismiss: (id: string) => void;
}

export const ToastStack: React.FC<ToastStackProps> = ({ toasts, onDismiss }) => {
  if (toasts.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none px-3 sm:px-0"
    >
      {toasts.map((t) => {
        const toneClass =
          t.variant === 'error'
            ? 'border-error-border bg-surface text-error-text'
            : t.variant === 'warning'
            ? 'border-warning-border bg-surface text-warning-text'
            : t.variant === 'success'
            ? 'border-brand-border bg-surface text-brand-text'
            : 'border-line bg-surface text-ink';

        const Icon =
          t.variant === 'error'
            ? XCircle
            : t.variant === 'warning'
            ? AlertTriangle
            : t.variant === 'success'
            ? CheckCircle2
            : Info;

        return (
          <div
            key={t.id}
            data-testid={`toast-${t.variant}`}
            className={`pointer-events-auto flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 shadow-lg text-xs ${toneClass}`}
          >
            <Icon className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="flex-1 text-ink leading-snug">{t.message}</div>
            <button
              type="button"
              onClick={() => onDismiss(t.id)}
              aria-label="Dismiss notification"
              className="text-muted hover:text-ink transition-colors shrink-0 p-0.5 rounded"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
};
