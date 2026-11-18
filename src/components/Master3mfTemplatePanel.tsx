import React, { useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Layers,
  Lock,
  Trash2,
  Upload,
} from 'lucide-react';
import { Master3mfTemplateRecord } from '../types';

export interface Master3mfTemplatePanelProps {
  isAdmin: boolean;
  templateRecord: Master3mfTemplateRecord | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  isOpen: boolean;
  onToggleOpen: () => void;
  onUploadMaster3mf: (
    file: File
  ) => Promise<
    { ok: true; record: Master3mfTemplateRecord } | { ok: false; error: string }
  >;
  onRemoveMaster3mf: () => Promise<void>;
}

export const Master3mfTemplatePanel: React.FC<Master3mfTemplatePanelProps> = ({
  isAdmin,
  templateRecord,
  loading,
  busy,
  error,
  isOpen,
  onToggleOpen,
  onUploadMaster3mf,
  onRemoveMaster3mf,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLocalError(null);
    const res = await onUploadMaster3mf(file);
    if (!res.ok) {
      setLocalError(res.error);
    }
    e.target.value = '';
  };

  const displayError = localError || error;
  const letterCount = templateRecord?.detectedLetters.length ?? 0;

  return (
    <section className="bg-surface border border-line rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={onToggleOpen}
        aria-expanded={isOpen}
        className="w-full px-5 py-3.5 flex flex-wrap items-center justify-between gap-3 bg-surface hover:bg-elevated transition-colors text-left cursor-pointer"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-recessed border border-line flex items-center justify-center shrink-0">
            <Layers className="w-4 h-4 text-brand-text" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-ink">
                Bambu Studio Master 3MF Template
              </h2>
              {templateRecord ? (
                <span
                  className={`text-xs font-mono-data font-semibold ${
                    letterCount === 26 ? 'text-brand-text' : 'text-warning-text'
                  }`}
                >
                  · {letterCount}/26 A–Z loaded
                </span>
              ) : (
                <span className="text-xs font-mono-data font-semibold text-warning-text">
                  · Not configured
                </span>
              )}
              {templateRecord && (
                <span className="text-[11px] font-mono-data text-muted">
                  · sha256:{templateRecord.sha256.slice(0, 8)}
                </span>
              )}
            </div>
            <p className="text-xs text-muted mt-0.5 truncate">
              Immutable Master .3mf preserving keycap objects, two-colour parts, prime tower, filament &amp; print profiles for .3MF export.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          {!isAdmin && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted">
              <Lock className="w-3 h-3" />
              <span>Admin-only edit</span>
            </span>
          )}
          <span className="inline-flex items-center gap-1 text-xs font-medium text-ink-secondary">
            <span>{isOpen ? 'Hide Template' : 'Manage Master 3MF'}</span>
            {isOpen ? (
              <ChevronUp className="w-4 h-4" />
            ) : (
              <ChevronDown className="w-4 h-4" />
            )}
          </span>
        </div>
      </button>

      {isOpen && (
        <div className="p-5 border-t border-line space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-ink-secondary space-y-0.5">
              <div>
                Upload a Bambu Studio <span className="font-mono-data font-semibold text-ink">.3mf</span> containing keycap objects named{' '}
                <span className="font-mono-data font-semibold text-ink">keycap-char-A</span>..
                <span className="font-mono-data font-semibold text-ink">keycap-char-Z</span> (or A..Z).
              </div>
              <div className="text-[11px] text-muted">
                The original Master 3MF file is stored read-only and never mutated; body &amp; raised letter extruders, prime tower, and slicer settings are cloned into every export.
              </div>
            </div>

            {isAdmin ? (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".3mf"
                  aria-label="Upload Bambu Studio Master 3MF template"
                  onChange={(e) => void handleFileChange(e)}
                  className="hidden"
                />
                <button
                  type="button"
                  disabled={busy || loading}
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-brand hover:bg-brand-hover disabled:opacity-50 text-white text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>
                    {busy
                      ? 'Inspecting .3MF...'
                      : templateRecord
                      ? 'Replace Master .3MF'
                      : 'Upload Master .3MF'}
                  </span>
                </button>
                {templateRecord && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void onRemoveMaster3mf()}
                    className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-error-border bg-surface hover:bg-error-soft text-error-text text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Remove</span>
                  </button>
                )}
              </div>
            ) : (
              <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-line bg-recessed text-xs text-muted">
                <Lock className="w-3.5 h-3.5" />
                <span>Admin permission required to upload Master 3MF</span>
              </div>
            )}
          </div>

          {displayError && (
            <div
              role="alert"
              className="p-3 rounded-lg border border-status-error bg-error-soft text-xs text-error-text flex items-start gap-2"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{displayError}</span>
            </div>
          )}

          {templateRecord && (
            <div className="p-4 rounded-xl border border-brand-border bg-elevated space-y-2.5 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 font-semibold text-ink">
                  <CheckCircle2 className="w-4 h-4 text-brand-text shrink-0" />
                  <span>{templateRecord.fileName}</span>
                </div>
                <span className="font-mono-data text-[11px] text-muted">
                  {(templateRecord.byteLength / 1024).toFixed(1)} KB
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 font-mono-data text-[11px]">
                <div className="p-2 rounded-lg bg-surface border border-line">
                  <div className="text-muted font-sans">A–Z Objects</div>
                  <div className="font-bold text-ink mt-0.5">
                    {templateRecord.detectedLetters.length} / 26
                  </div>
                </div>
                <div className="p-2 rounded-lg bg-surface border border-line">
                  <div className="text-muted font-sans">Parts / Keycap</div>
                  <div className="font-bold text-ink mt-0.5">
                    {templateRecord.multiMaterialPartCount}{' '}
                    {templateRecord.multiMaterialPartCount >= 2
                      ? '(Multi-colour)'
                      : '(Single)'}
                  </div>
                </div>
                <div className="p-2 rounded-lg bg-surface border border-line">
                  <div className="text-muted font-sans">Filaments</div>
                  <div className="font-bold text-ink mt-0.5 flex items-center gap-1">
                    <span>{templateRecord.filamentCount}</span>
                    {templateRecord.filamentColors.slice(0, 4).map((hex, idx) => (
                      <span
                        key={idx}
                        className="w-2.5 h-2.5 rounded-full border border-line inline-block"
                        style={{ backgroundColor: hex }}
                        aria-hidden="true"
                      />
                    ))}
                  </div>
                </div>
                <div className="p-2 rounded-lg bg-surface border border-line">
                  <div className="text-muted font-sans">Prime Tower</div>
                  <div className="font-bold text-ink mt-0.5">
                    {templateRecord.primeTowerEnabled ? 'Enabled' : 'As Configured'}
                  </div>
                </div>
              </div>

              <div className="text-[11px] font-mono-data text-muted">
                Detected letters:{' '}
                <span className="text-ink-secondary">
                  {templateRecord.detectedLetters.join(', ')}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
};
