import { useCallback, useEffect, useMemo, useState } from 'react';
import { ABC } from '../constants';
import { StlModelAssetEntry, StlModelAssetRecord } from '../types';
import {
  computeLibraryModelRevision,
  getStlLibraryRepository,
  matchLetterFromStlFileName,
  validateAndPrepareStlAsset,
} from './stlLibraryStorage';

export interface StlBulkUploadReport {
  uploadedLetters: string[];
  failedFiles: { fileName: string; error: string }[];
}

export function useStlModelLibrary(ownerId: string | null | undefined, actorEmail?: string | null) {
  const effectiveOwnerId = (ownerId || 'local-operator').trim();
  const repo = useMemo(() => getStlLibraryRepository(), []);

  const [recordsByLetter, setRecordsByLetter] = useState<Record<string, StlModelAssetRecord>>({});
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  const refreshLibrary = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const entries = await repo.getAllByOwner(effectiveOwnerId);
      const map: Record<string, StlModelAssetRecord> = {};
      for (const entry of entries) {
        if (entry.record?.letter) {
          map[entry.record.letter.toUpperCase()] = entry.record;
        }
      }
      setRecordsByLetter(map);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Failed to load STL Model Library: ${msg}`);
    } finally {
      setLoading(false);
    }
  }, [effectiveOwnerId, repo]);

  useEffect(() => {
    void refreshLibrary();
  }, [refreshLibrary]);

  const uploadSingleLetterFile = useCallback(
    async (
      letter: string,
      file: File
    ): Promise<{ ok: true; record: StlModelAssetRecord } | { ok: false; error: string }> => {
      setBusy(true);
      setError(null);
      try {
        const buffer = await file.arrayBuffer();
        const prep = await validateAndPrepareStlAsset({
          fileName: file.name,
          buffer,
          expectedLetter: letter,
          uploadedBy: actorEmail ?? null,
        });
        if (!prep.ok) {
          setError(prep.error);
          return prep;
        }
        await repo.putAsset(effectiveOwnerId, prep.entry);
        setRecordsByLetter((prev) => ({
          ...prev,
          [prep.entry.record.letter]: prep.entry.record,
        }));
        return { ok: true, record: prep.entry.record };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        return { ok: false, error: msg };
      } finally {
        setBusy(false);
      }
    },
    [actorEmail, effectiveOwnerId, repo]
  );

  const uploadBulkFiles = useCallback(
    async (files: FileList | readonly File[]): Promise<StlBulkUploadReport> => {
      setBusy(true);
      setError(null);
      const uploadedLetters: string[] = [];
      const failedFiles: { fileName: string; error: string }[] = [];
      const updates: Record<string, StlModelAssetRecord> = {};

      try {
        const fileList = Array.from(files);
        for (const file of fileList) {
          const matchedLetter = matchLetterFromStlFileName(file.name);
          if (!matchedLetter) {
            failedFiles.push({
              fileName: file.name,
              error: 'Filename must match keycap-char-A.stl through keycap-char-Z.stl.',
            });
            continue;
          }
          const buffer = await file.arrayBuffer();
          const prep = await validateAndPrepareStlAsset({
            fileName: file.name,
            buffer,
            expectedLetter: matchedLetter,
            uploadedBy: actorEmail ?? null,
          });
          if (!prep.ok) {
            failedFiles.push({ fileName: file.name, error: prep.error });
            continue;
          }
          await repo.putAsset(effectiveOwnerId, prep.entry);
          updates[prep.entry.record.letter] = prep.entry.record;
          uploadedLetters.push(prep.entry.record.letter);
        }

        if (Object.keys(updates).length > 0) {
          setRecordsByLetter((prev) => ({ ...prev, ...updates }));
        }
        if (failedFiles.length > 0) {
          setError(
            `${failedFiles.length} file(s) rejected: ${failedFiles[0].fileName} (${failedFiles[0].error})`
          );
        }
        return { uploadedLetters, failedFiles };
      } finally {
        setBusy(false);
      }
    },
    [actorEmail, effectiveOwnerId, repo]
  );

  const removeLetterModel = useCallback(
    async (letter: string) => {
      const clean = letter.trim().toUpperCase();
      setBusy(true);
      setError(null);
      try {
        await repo.deleteAsset(effectiveOwnerId, clean);
        setRecordsByLetter((prev) => {
          const next = { ...prev };
          delete next[clean];
          return next;
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        setBusy(false);
      }
    },
    [effectiveOwnerId, repo]
  );

  const getAssetsByLetters = useCallback(
    (letters: readonly string[]): Promise<Record<string, StlModelAssetEntry>> => {
      return repo.getByOwnerAndLetters(effectiveOwnerId, letters);
    },
    [effectiveOwnerId, repo]
  );

  const uploadedCount = useMemo(
    () => ABC.filter((l) => Boolean(recordsByLetter[l]?.isValid)).length,
    [recordsByLetter]
  );

  const missingLetters = useMemo(
    () => ABC.filter((l) => !recordsByLetter[l]?.isValid),
    [recordsByLetter]
  );

  const modelRevision = useMemo(
    () => computeLibraryModelRevision(Object.values(recordsByLetter)),
    [recordsByLetter]
  );

  return {
    recordsByLetter,
    uploadedCount,
    missingLetters,
    modelRevision,
    loading,
    busy,
    error,
    setError,
    refreshLibrary,
    uploadSingleLetterFile,
    uploadBulkFiles,
    removeLetterModel,
    getAssetsByLetters,
  };
}
