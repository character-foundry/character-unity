import { useEffect, useRef, useState } from 'react';
import { Modal } from '@/components/ui/modal';
import type { CardSummary } from '@/lib/unity';
import type { HistoryPage } from '@character-unity/cards';
import type { SharingClient } from './client';

export function RevisionPicker({ client, card, onClose, onChoose }: {
  client: Pick<SharingClient, 'history'>; card: Pick<CardSummary, 'id' | 'name'>; onClose(): void; onChoose(revision: HistoryPage['revisions'][number]): void;
}) {
  const [page, setPage] = useState<HistoryPage | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const more = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController(); setPage(null); setLoading(true); setError('');
    void client.history(card.id, { signal: controller.signal }).then((value) => { if (!controller.signal.aborted) setPage(value); })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Revision history is unavailable.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); more.current?.abort(); };
  }, [client, card.id, attempt]);
  async function loadMore() {
    if (!page?.nextAfter || more.current) return;
    const controller = new AbortController(); more.current = controller; setLoading(true); setError('');
    try {
      const next = await client.history(card.id, { afterSequence: page.nextAfter, throughSequence: page.throughSequence, signal: controller.signal });
      if (!controller.signal.aborted) setPage((old) => ({ ...next, revisions: [...old?.revisions ?? [], ...next.revisions] }));
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Revision history is unavailable.'); }
    finally { if (more.current === controller) more.current = null; if (!controller.signal.aborted) setLoading(false); }
  }
  return <Modal isOpen onClose={onClose} label="Choose saved revision" size="md"><div className="space-y-4 p-5">
    <div className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">Choose saved revision</h2>
      <p className="mt-1 text-sm text-starlight/50">{card.name} · Choose an immutable saved revision, not an unsaved draft.</p></div>
      <button type="button" aria-label="Close revision picker" onClick={onClose} className="rounded-lg border border-nebula/20 px-3 py-1.5 text-sm">Close</button></div>
    {error && <p role="alert" className="text-sm text-red-200">{error}</p>}
    {page && <ul className="max-h-80 divide-y divide-nebula/10 overflow-y-auto">{page.revisions.map((value) => <li key={value.id} className="flex items-center justify-between gap-3 py-3">
      <div className="min-w-0"><span className="text-sm font-medium">Revision {value.sequence}</span>{value.id === page.headRevisionId && <span className="ml-2 text-xs text-nebula">Latest at load</span>}
        <p className="mt-1 text-xs text-starlight/45">{new Date(value.createdAt).toLocaleString()}</p></div>
      <button type="button" disabled={loading} onClick={() => onChoose(value)} className="rounded-lg border border-nebula/20 px-3 py-1.5 text-sm disabled:opacity-40">Select revision {value.sequence}</button>
    </li>)}</ul>}
    {loading && <p role="status" className="text-sm text-starlight/50">Loading revisions…</p>}
    {!loading && !page && error && <button type="button" onClick={() => setAttempt((value) => value + 1)} className="rounded-lg border border-nebula/20 px-3 py-2 text-sm">Retry revision history</button>}
    {!loading && page?.nextAfter && <button type="button" onClick={() => void loadMore()} className="rounded-lg border border-nebula/20 px-3 py-2 text-sm">More revisions</button>}
    {page && !page.nextAfter && <p className="text-xs text-starlight/40">End of saved revision history.</p>}
  </div></Modal>;
}
