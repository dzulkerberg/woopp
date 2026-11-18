import React, { useRef, useState } from 'react';
import {
  AlertTriangle,
  Box,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Lock,
  Trash2,
  Upload,
} from 'lucide-react';
import { ABC } from '../constants';
import { StlModelAssetRecord } from '../types';
import { StlBulkUploadReport } from '../services/useStlModelLibrary';

export interface StlModelLibraryPanelProps {
  isAdmin: boolean;
  recordsByLetter: Record<string, StlModelAssetRecord>;
  uploadedCount: number;
  modelRevision: string;
  loading: boolean;
  busy: boolean;
  error: string | null;
  isOpen: boolean;
  onToggleOpen: () => void;
  onUploadSingleLetter: (
    letter: string,
    file: File
  ) => Promise<{ ok: true; record: StlModelAssetRecord } | { ok: false; error: string }>;
  onUploadBulkFiles: (files: FileList | readonly File[]) => Promise<StlBulkUploadReport>;
  onRemoveLetter: (letter: string) => Promise<void>;
}

export const StlModelLibraryPanel: React.FC<StlModelLibraryPanelProps> = ({
  isAdmin,
  recordsByLetter,
  uploadedCount,
  modelRevision,
  loading,
  busy,
  error,
  isOpen,
  onToggleOpen,
  onUploadSingleLetter,
  onUploadBulkFiles,
  onRemoveLetter,
}) => {
  const bulkInputRef = useRef<HTMLInputElement | null>(null);
  const perLetterInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [bulkReport, setBulkReport] = useState<StlBulkUploadReport | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleBulkSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setLocalError(null);
    const report = await onUploadBulkFiles(files);
    setBulkReport(report);
    e.target.value = '';
  };

  const handleSingleSelect = async (
    letter: string,
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLocalError(null);
    setBulkReport(null);
    const res = await onUploadSingleLetter(letter, file);
    if (!res.ok) {
      setLocalError(res.error);
    }
    e.target.value = '';
  };

  const displayError = localError || error;
  const allComplete = uploadedCount === 26;

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
            <Box className="w-4 h-4 text-brand-text" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-ink">
                STL Model Library (A–Z Master Keycaps)
              </h2>
              <span
                className={`text-xs font-mono-data font-semibold ${
                  allComplete ? 'text-brand-text' : 'text-warning-text'
                }`}
              >
                · {uploadedCount}/26 loaded
              </span>
              {uploadedCount > 0 && (
                <span className="text-[11px] font-mono-data text-muted">
                  · {modelRevision}
                </span>
              )}
            </div>
            <p className="text-xs text-muted mt-0.5 truncate">
              Original keycap STLs (base + raised letter preserved as one mesh) used by the Fast STL Export Engine.
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
            <span>{isOpen ? 'Hide Library' : 'Manage Models'}</span>
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
          {/* Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-ink-secondary space-y-0.5">
              <div>
                Upload authentic <span className="font-mono-data font-semibold text-ink">keycap-char-A.stl</span> through{' '}
                <span className="font-mono-data font-semibold text-ink">keycap-char-Z.stl</span>.
              </div>
              <div className="text-[11px] text-muted">
                Geometry is kept verbatim — raised letter relief and keycap base are never separated, simplified, or regenerated.
              </div>
            </div>

            {isAdmin ? (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={bulkInputRef}
                  type="file"
                  accept=".stl"
                  multiple
                  aria-label="Bulk upload keycap-char STL files"
                  onChange={(e) => void handleBulkSelect(e)}
                  className="hidden"
                />
                <button
                  type="button"
                  disabled={busy || loading}
                  onClick={() => bulkInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-brand hover:bg-brand-hover disabled:opacity-50 text-white text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>{busy ? 'Validating STL...' : 'Bulk Upload keycap-char-*.stl'}</span>
                </button>
              </div>
            ) : (
              <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-line bg-recessed text-xs text-muted">
                <Lock className="w-3.5 h-3.5" />
                <span>Admin permission required to upload or replace STL models</span>
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

          {bulkReport && (
            <div className="p-3 rounded-lg border border-line bg-recessed text-xs space-y-1">
              {bulkReport.uploadedLetters.length > 0 && (
                <div className="text-brand-text font-medium flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                  <span>
                    Saved {bulkReport.uploadedLetters.length} STL model(s):{' '}
                    <span className="font-mono-data">{bulkReport.uploadedLetters.join(', ')}</span>
                  </span>
                </div>
              )}
              {bulkReport.failedFiles.length > 0 && (
                <div className="text-error-text space-y-0.5">
                  {bulkReport.failedFiles.map((f, idx) => (
                    <div key={idx} className="font-mono-data text-[11px]">
                      Rejected {f.fileName}: {f.error}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 26-letter A–Z Authentic Asset Matrix */}
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-9 gap-2.5">
            {ABC.map((letter) => {
              const rec = recordsByLetter[letter];
              const isLoaded = Boolean(rec?.isValid);

              return (
                <div
                  key={letter}
                  data-testid={`stl-library-slot-${letter}`}
                  className={`rounded-lg border p-2.5 flex flex-col justify-between gap-2 ${
                    isLoaded
                      ? 'border-brand-border bg-elevated'
                      : 'border-line bg-recessed'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-sm font-bold font-mono-data text-ink">
                      {letter}
                    </span>
                    <span
                      className={`text-[10px] font-semibold ${
                        isLoaded ? 'text-brand-text' : 'text-muted'
                      }`}
                    >
                      {isLoaded ? 'Ready' : 'Missing'}
                    </span>
                  </div>

                  {isLoaded && rec ? (
                    <div className="text-[10px] font-mono-data text-muted space-y-0.5">
                      <div className="truncate text-ink-secondary" title={rec.fileName}>
                        {rec.fileName}
                      </div>
                      <div>{rec.triangleCount.toLocaleString()} tris</div>
                      <div>
                        {rec.bounds.widthMm.toFixed(1)}×{rec.bounds.depthMm.toFixed(1)}×
                        {rec.bounds.heightMm.toFixed(1)}mm
                      </div>
                      {rec.bounds.estimatedLetterStartZMm !== null && (
                        <div className="text-brand-text" title="Estimated height where raised letter starts">
                          Z-step ~{rec.bounds.estimatedLetterStartZMm.toFixed(2)}mm
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-[10px] font-mono-data text-muted">
                      keycap-char-{letter}.stl
                    </div>
                  )}

                  {isAdmin && (
                    <div className="flex items-center justify-between gap-1 pt-1 border-t border-line">
                      <input
                        ref={(el) => {
                          perLetterInputRefs.current[letter] = el;
                        }}
                        type="file"
                        accept=".stl"
                        aria-label={`Upload STL for letter ${letter}`}
                        onChange={(e) => void handleSingleSelect(letter, e)}
                        className="hidden"
                      />
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => perLetterInputRefs.current[letter]?.click()}
                        className="text-[11px] font-semibold text-brand-text hover:underline disabled:opacity-40 cursor-pointer"
                      >
                        {isLoaded ? 'Replace' : 'Upload'}
                      </button>
                      {isLoaded && (
                        <button
                          type="button"
                          disabled={busy}
                          aria-label={`Remove STL for letter ${letter}`}
                          onClick={() => void onRemoveLetter(letter)}
                          className="p-0.5 text-muted hover:text-error-text transition-colors cursor-pointer"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
};
