import { useCallback, useEffect, useRef, useState } from 'react';
import { libraryIndexStatus, retryLibraryIndex } from '@/lib/unity';
import type { LibraryIndexStatus as Status } from '@/lib/unity';
import type { ArchiveStatus } from '@/lib/archive-search';

/** One read per search/capability refresh, plus explicit retry. Never polls. */
export function LibraryIndexStatus({ archive, searchKey }: { archive: ArchiveStatus | null; searchKey: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0), pending = useRef<AbortController | null>(null);
  const load = useCallback(async (retry = false) => {
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    const request = ++generation.current;
    setBusy(true); setError(null);
    try {
      const result = await (retry ? retryLibraryIndex(controller.signal) : libraryIndexStatus(controller.signal));
      if (request === generation.current && !controller.signal.aborted) setStatus(result);
    } catch (failure) {
      if (request === generation.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Indexing status could not be loaded');
    } finally { if (request === generation.current && !controller.signal.aborted) setBusy(false); }
  }, []);
  useEffect(() => {
    if (archive) void load();
    return () => { generation.current++; pending.current?.abort(); };
  }, [archive, searchKey, load]);
  if (!archive) return null;
  return <section aria-label="Saved-card search indexing" className="border-b border-nebula/20 px-3 py-2 text-[12px] text-starlight/60 sm:px-4">
    {status && <>
      <p>{status.enabled ? 'Saved-card search indexing' : 'Saved-card search indexing disabled'}:
        {!status.enabled && <> {status.reason || 'This host has not enabled it'}.</>}
        {' '}{status.bounded ? 'At least ' : ''}{status.pending} queued changes; {status.bounded ? 'at least ' : ''}{status.failed} failed in the reported batch.
        {status.running && ' Delivery is running.'}
      </p>
      <p className="mt-1 text-starlight/45">Only delivered changes join the shared Archive search index. Existing library coverage is not counted.
        {status.semantic === false ? ' Saved-card semantic indexing is unavailable.' : status.semantic === null ? ' Saved-card semantic coverage has not been reported.' : ''}
      </p>
      {status.lastError && <p role="alert" className="mt-1 break-words text-red-300">Indexing needs attention: {status.lastError}</p>}
    </>}
    {error && <p role="alert" className="break-words text-red-300">Saved-card indexing status unavailable: {error}</p>}
    <div className="mt-1 flex flex-wrap items-center gap-3">
      <button type="button" disabled={busy} onClick={() => { void load(); }} className="text-nebula disabled:opacity-50">Refresh saved-card indexing</button>
      {status?.enabled && (status.pending > 0 || status.lastError) && <button type="button" disabled={busy} onClick={() => { void load(true); }} className="text-nebula disabled:opacity-50">Retry saved-card indexing</button>}
      {busy && <span role="status">Checking saved-card indexing…</span>}
    </div>
  </section>;
}
