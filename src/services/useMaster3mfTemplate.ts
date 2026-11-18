import { useCallback, useEffect, useState } from 'react';
import { Master3mfTemplateAsset, Master3mfTemplateRecord } from '../types';
import {
  getMaster3mfRepository,
  Master3mfRepository,
  validateAndPrepareMaster3mf,
} from './master3mfStorage';

export interface UseMaster3mfTemplateResult {
  templateRecord: Master3mfTemplateRecord | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  refreshTemplate: () => Promise<void>;
  uploadMaster3mfFile: (
    file: File
  ) => Promise<
    { ok: true; record: Master3mfTemplateRecord } | { ok: false; error: string }
  >;
  removeMaster3mf: () => Promise<void>;
  getMaster3mfAsset: () => Promise<Master3mfTemplateAsset | null>;
}

export function useMaster3mfTemplate(
  ownerId: string | null | undefined,
  actorEmail?: string | null,
  repository?: Master3mfRepository
): UseMaster3mfTemplateResult {
  const repo = repository || getMaster3mfRepository();
  const cleanOwner = (ownerId || 'default').trim();

  const [templateRecord, setTemplateRecord] = useState<Master3mfTemplateRecord | null>(
    null
  );
  const [loading, setLoading] = useState<boolean>(true);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const refreshTemplate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const asset = await repo.getByOwner(cleanOwner);
      setTemplateRecord(asset ? asset.record : null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [cleanOwner, repo]);

  useEffect(() => {
    void refreshTemplate();
  }, [refreshTemplate]);

  const uploadMaster3mfFile = useCallback(
    async (
      file: File
    ): Promise<
      { ok: true; record: Master3mfTemplateRecord } | { ok: false; error: string }
    > => {
      setBusy(true);
      setError(null);
      try {
        const buffer = await file.arrayBuffer();
        const prep = await validateAndPrepareMaster3mf({
          fileName: file.name,
          buffer,
          uploadedBy: actorEmail ?? cleanOwner,
        });
        if (!prep.ok) {
          const failRes = prep as { ok: false; error: string };
          setError(failRes.error);
          return failRes;
        }
        await repo.putTemplate(cleanOwner, prep.asset);
        setTemplateRecord(prep.asset.record);
        return { ok: true, record: prep.asset.record };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        return { ok: false, error: msg };
      } finally {
        setBusy(false);
      }
    },
    [actorEmail, cleanOwner, repo]
  );

  const removeMaster3mf = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await repo.deleteTemplate(cleanOwner);
      setTemplateRecord(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }, [cleanOwner, repo]);

  const getMaster3mfAsset = useCallback(
    () => repo.getByOwner(cleanOwner),
    [cleanOwner, repo]
  );

  return {
    templateRecord,
    loading,
    busy,
    error,
    refreshTemplate,
    uploadMaster3mfFile,
    removeMaster3mf,
    getMaster3mfAsset,
  };
}
