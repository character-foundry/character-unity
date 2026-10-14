import { useEffect, useRef, useState } from 'react';
import type { ContentClient, ContentKind, ContentPolicy, ContentPublicationSummary, SharedContent } from './client';
import { ContentPolicyFields } from './publisher';

const button = 'rounded-lg border border-nebula/30 px-3 py-1.5 text-sm hover:bg-cosmic-teal/30 disabled:opacity-50';
export function SharedContentList({ client,kind,mine,onOpen }: { client: ContentClient; kind: ContentKind; mine: boolean; onOpen(id: string): void }) {
  const [items,setItems] = useState<ContentPublicationSummary[]>([]), [next,setNext] = useState<string | null>(null), [after,setAfter] = useState(''), [attempt,setAttempt] = useState(0);
  const [loaded,setLoaded] = useState(false), [error,setError] = useState<string | null>(null), [selected,setSelected] = useState<SharedContent | null>(null);
  const [policy,setPolicy] = useState<ContentPolicy | null>(null), [busy,setBusy] = useState(false), [loading,setLoading] = useState(false);
  const lifetime = useRef<AbortController | null>(null), sequence = useRef(0);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); },[]);
  useEffect(() => {
    if (!client.sharing) return;
    const controller = new AbortController(); setError(null); setLoading(true);
    void client.publications({ kind,mine,afterId: after,signal: controller.signal }).then((page) => {
      if (!controller.signal.aborted) { setItems(page.items); setNext(page.nextAfter); setLoaded(true); setLoading(false); }
    }).catch((failure: unknown) => { if (!controller.signal.aborted) { setError(failure instanceof Error ? failure.message : 'Shared content could not be read.'); setLoading(false); } });
    return () => controller.abort();
  },[client,kind,mine,after,attempt]);
  async function open(id: string) {
    const current = ++sequence.current; setBusy(true); setError(null);
    try { const value = await client.publication(id,lifetime.current!.signal); if (!lifetime.current!.signal.aborted && current === sequence.current) {
      setSelected(value); setPolicy({ visibility: value.visibility,allowFork: value.allowFork,allowOriginal: value.allowOriginal });
    } } catch (failure) { if (!lifetime.current!.signal.aborted && current === sequence.current) setError(failure instanceof Error ? failure.message : 'Shared content could not be opened.'); }
    finally { if (!lifetime.current!.signal.aborted && current === sequence.current) setBusy(false); }
  }
  async function action(operation: () => Promise<void>) {
    if (busy) return; setBusy(true); setError(null);
    try { await operation(); } catch (failure) { if (!lifetime.current!.signal.aborted) setError(failure instanceof Error ? failure.message : 'Shared content action failed.'); }
    finally { if (!lifetime.current!.signal.aborted) setBusy(false); }
  }
  if (!client.sharing) return <p className="rounded-xl border border-nebula/20 p-4 text-sm text-starlight/60">Browser-owned content remains private. Connect to a configured server to browse or publish shared lorebooks, presets and personas.</p>;
  return <div className="space-y-4">
    <p className="text-sm text-starlight/60">Native JSON sharing only. Signed character-card federation does not carry these content types.</p>
    {error && <p role="alert" className="text-sm text-red-200">{error}</p>}
    <div className="flex gap-2"><button type="button" className={button} disabled={loading || busy} onClick={() => setAttempt((value) => value+1)}>Refresh shared content</button>
      {after && <button type="button" className={button} disabled={loading || busy} onClick={() => setAfter('')}>First page</button>}
      {next && <button type="button" className={button} disabled={loading || busy} onClick={() => setAfter(next)}>Next page</button>}</div>
    {loading ? <p role="status">Reading shared content…</p> : loaded && !items.length ? <p className="py-8 text-sm text-starlight/50">No visible shared items in this page.</p> : null}
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{items.map((item) => <button type="button" key={item.id} disabled={busy} onClick={() => { void open(item.id); }}
      className="min-w-0 rounded-xl border border-nebula/20 bg-deep-space/60 p-4 text-left hover:border-nebula/60 disabled:opacity-50">
      <span className="block break-words text-sm font-semibold">{item.title}</span><span className="mt-2 block text-xs text-starlight/50">{item.kind} · revision {item.sequence} · {item.visibility}{item.owned ? ' · yours' : ''}</span>
    </button>)}</div>
    {selected && <section className="space-y-4 rounded-xl border border-nebula/30 bg-deep-space/60 p-4"><div className="flex items-start justify-between gap-3"><div><h2 className="break-words text-lg font-semibold">{selected.title}</h2>
      <p className="mt-1 text-xs text-starlight/50">Shared revision {selected.sequence} · policy version {selected.policyVersion}</p></div><button type="button" className={button} disabled={busy} onClick={() => setSelected(null)}>Close detail</button></div>
      {selected.preview.reason && <p className="text-xs text-amber-200/80">{selected.preview.reason}</p>}
      <pre aria-label="Shared content JSON" className="max-h-96 overflow-auto rounded-lg bg-cosmic-teal/30 p-3 text-xs">{JSON.stringify(selected.json,null,2)}</pre>
      <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={busy || (!selected.allowFork && !selected.owned)} onClick={() => { void action(async () => {
        const fork = await client.forkPublication(selected.id,selected.policyVersion,lifetime.current!.signal); if (!lifetime.current!.signal.aborted) onOpen(fork.document.id);
      }); }}>Save private fork to this workspace</button>
        <button type="button" className={button} disabled={busy || (!selected.allowOriginal && !selected.owned)} onClick={() => { void action(async () => { await client.publicationOriginal(selected.id,`${selected.kind}-original.json`); }); }}>Download permitted original</button></div>
      {selected.owned && policy && <div className="max-w-lg space-y-3 border-t border-nebula/20 pt-4"><h3 className="text-sm font-semibold">Change sharing policy</h3>
        <ContentPolicyFields value={policy} onChange={setPolicy} disabled={busy} />
        <button type="button" className={button} disabled={busy} onClick={() => { void action(async () => {
          const changed = await client.policy(selected.id,selected.policyVersion,policy,lifetime.current!.signal);
          if (!lifetime.current!.signal.aborted) { setSelected(changed); setAttempt((value) => value+1); }
        }); }}>Save version-checked policy</button>
      </div>}
    </section>}
  </div>;
}
