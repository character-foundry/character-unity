import { useEffect, useRef, useState } from 'react';
import type { ContentClient, ContentRecord, OpenedContent } from './client';
import { clearContentDraft, readContentDraft, writeContentDraft, type ContentDraft } from './recovery';
import { ContentPublisher } from './publisher';

const button = 'rounded-lg border border-nebula/30 px-3 py-1.5 text-sm hover:bg-cosmic-teal/30 disabled:opacity-50';
export function ContentEditor({ client,id,onBack,onOpen }: { client: ContentClient; id: string; onBack(): void; onOpen(id: string): void }) {
  const [opened,setOpened] = useState<OpenedContent | null>(null), [error,setError] = useState<string | null>(null), [attempt,setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setOpened(null); setError(null);
    void client.open(id,controller.signal).then((value) => { if (!controller.signal.aborted) setOpened(value); }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Content could not be opened.');
    }); return () => controller.abort();
  },[client,id,attempt]);
  if (error) return <div className="space-y-3"><p role="alert" className="text-red-200">{error}</p><button type="button" className={button} onClick={() => setAttempt((value) => value+1)}>Retry content</button><button type="button" className={button} onClick={onBack}>Back to content</button></div>;
  if (!opened) return <p role="status" className="py-10 text-center text-starlight/60">Opening standalone content…</p>;
  return <LoadedEditor key={`${id}:${opened.record.revision.id}`} client={client} opened={opened} onBack={onBack} onOpen={onOpen} onReload={() => setAttempt((value) => value+1)} />;
}
function LoadedEditor({ client,opened,onBack,onOpen,onReload }: { client: ContentClient; opened: OpenedContent; onBack(): void; onOpen(id: string): void; onReload(): void }) {
  const { document,revision } = opened.record, key = client.draftKey(document.id);
  const [draft,setDraft] = useState<ContentDraft>({ version: 1,key,expectedHead: revision.id,title: revision.title,text: JSON.stringify(revision.json,null,2),id: crypto.randomUUID() });
  const [dirty,setDirty] = useState(false), [recoveryError,setRecoveryError] = useState<string | null>(null), [error,setError] = useState<string | null>(null), [notice,setNotice] = useState<string | null>(null);
  const [busy,setBusy] = useState(false), [history,setHistory] = useState<Awaited<ReturnType<ContentClient['history']>> | null>(null);
  const [selected,setSelected] = useState(revision.id), [review,setReview] = useState(opened), [reviewBusy,setReviewBusy] = useState(false);
  const [publishing,setPublishing] = useState<ContentRecord | null>(null);
  const lifecycle = useRef<AbortController | null>(null), selection = useRef(0), running = useRef(false);
  useEffect(() => {
    const controller = new AbortController(); lifecycle.current = controller;
    try { const recovered = readContentDraft(sessionStorage,key); if (recovered) { setDraft(recovered); setDirty(true); setNotice('Recovered this account/workspace’s unsaved JSON draft.'); } }
    catch (failure) { setRecoveryError(failure instanceof Error ? failure.message : 'Recovery is unavailable.'); }
    void client.history(document.id,0,controller.signal).then((value) => { if (!controller.signal.aborted) setHistory(value); }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'History unavailable.');
    }); return () => controller.abort();
  },[client,document.id,key]);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload',beforeUnload); return () => window.removeEventListener('beforeunload',beforeUnload);
  },[dirty]);
  const stale = draft.expectedHead !== document.headRevisionId;
  function update(changes: Partial<Pick<ContentDraft,'title'|'text'|'expectedHead'>>) {
    const next = { ...draft,...changes }; setDraft(next); setDirty(true); setNotice(null);
    try { writeContentDraft(sessionStorage,next); setRecoveryError(null); } catch (failure) { setRecoveryError(failure instanceof Error ? failure.message : 'Recovery write failed.'); }
  }
  async function action(operation: () => Promise<void>) {
    if (running.current) return; running.current = true; setBusy(true); setError(null);
    try { await operation(); } catch (failure) { if (!lifecycle.current!.signal.aborted) setError(failure instanceof Error ? failure.message : 'Content action failed.'); }
    finally { running.current = false; if (!lifecycle.current!.signal.aborted) setBusy(false); }
  }
  async function choose(revisionId: string) {
    const turn = ++selection.current; setSelected(revisionId); setReviewBusy(true); setError(null);
    try { const value = await client.review(document.id,revisionId,lifecycle.current!.signal); if (!lifecycle.current!.signal.aborted && turn === selection.current) setReview(value); }
    catch (failure) { if (!lifecycle.current!.signal.aborted && turn === selection.current) setError(failure instanceof Error ? failure.message : 'Revision review failed.'); }
    finally { if (!lifecycle.current!.signal.aborted && turn === selection.current) setReviewBusy(false); }
  }
  function discard() {
    if (dirty && !window.confirm('Discard this unsaved content draft and reload the saved head?')) return;
    try { clearContentDraft(sessionStorage,key,draft.id); } catch (failure) { setRecoveryError(failure instanceof Error ? failure.message : 'Recovery could not be cleared.'); return; }
    setDirty(false); onReload();
  }
  function save() {
    void action(async () => {
      await client.save(document.id,draft.expectedHead,draft.title,draft.text,lifecycle.current!.signal);
      if (lifecycle.current!.signal.aborted) return;
      clearContentDraft(sessionStorage,key,draft.id); setDirty(false); onReload();
    });
  }
  return <div className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><button type="button" className="mb-2 text-sm text-starlight/60 hover:underline" onClick={onBack}>← Back to content</button>
      <h1 className="break-words text-xl font-semibold">{revision.title}</h1><p className="mt-1 text-xs text-starlight/50">{document.kind} · saved head revision {revision.sequence}{document.forkedFromRevisionId ? ' · owned fork' : ''}</p></div>
      <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={busy} onClick={() => { void action(async () => { await client.original(document.id,`${document.kind}-original.json`); }); }}>Download original</button>
        <button type="button" className={button} disabled={busy || reviewBusy || review.record.revision.id !== selected} onClick={() => { void action(async () => { await client.export(document.id,selected,`${document.kind}-revision-${review.record.revision.sequence}.json`); }); }}>Export selected JSON</button></div>
    </div>
    {(error || recoveryError) && <div role="alert" className="space-y-1 rounded-lg border border-red-400/30 p-3 text-sm text-red-200">{error && <p>{error}</p>}{recoveryError && <p>Draft recovery: {recoveryError}</p>}</div>}
    {notice && <p role="status" className="text-sm text-nebula">{notice}</p>}
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
      <section className="min-w-0 space-y-3 rounded-xl border border-nebula/20 bg-deep-space/60 p-4"><h2 className="font-semibold">Lossless JSON editor</h2>
        <p className="text-xs leading-relaxed text-starlight/50">Edit the original shape directly. Unknown fields are preserved; no card wrapper, normalized format conversion or provider execution is added. Recovery drafts stay in this tab under this account/workspace.</p>
        <div className="sticky top-14 z-10 flex flex-wrap gap-2 rounded-lg bg-deep-space py-2"><button type="button" disabled={busy || !dirty || stale} className="btn-primary px-4 py-2 disabled:opacity-50" onClick={save}>Save content revision</button>
          <button type="button" className={button} disabled={busy} onClick={discard}>Reload saved head</button></div>
        <label className="block space-y-1 text-sm"><span>Library title</span><input aria-label="Content title" value={draft.title} disabled={busy} maxLength={500} onChange={(event) => update({ title: event.target.value })} className="block w-full rounded-lg px-3 py-2" /></label>
        <label className="block space-y-1 text-sm"><span>Complete JSON</span><textarea aria-label="Content JSON" value={draft.text} disabled={busy} onChange={(event) => update({ text: event.target.value })} spellCheck={false}
          className="min-h-[26rem] w-full rounded-lg p-3 font-mono text-xs leading-relaxed" /></label>
        {stale && <div role="alert" className="space-y-2 rounded-lg border border-amber-400/30 p-3 text-sm text-amber-200"><p>This recovery draft is based on an older head. Compare it with the current saved JSON before changing its base.</p>
          <details><summary>Compare current saved JSON</summary><pre className="mt-2 max-h-64 overflow-auto text-xs">{JSON.stringify(revision.json,null,2)}</pre></details>
          <button type="button" disabled={busy} className={button} onClick={() => { if (window.confirm('Use the current saved head as the base? Saving will replace its JSON with your reviewed draft, while keeping both revisions in history.')) update({ expectedHead: revision.id }); }}>Use reviewed current head as base</button></div>}
      </section>
      <aside className="min-w-0 space-y-4">
        <section className="space-y-3 rounded-xl border border-nebula/20 bg-deep-space/60 p-4"><h2 className="font-semibold">Saved revision actions</h2>
          <p className="text-xs text-starlight/50">History selection never replaces your unsaved editor draft.</p>
          <label className="block space-y-1 text-sm"><span>Exact saved revision</span><select aria-label="Content revision" value={selected} disabled={busy || reviewBusy} className="block w-full rounded-lg px-3 py-2" onChange={(event) => { void choose(event.target.value); }}>
            {![...(history?.revisions ?? [])].some((item) => item.id === revision.id) && <option value={revision.id}>Revision {revision.sequence} · current head</option>}
            {(history?.revisions ?? []).map((item) => <option value={item.id} key={item.id}>Revision {item.sequence} · {item.title}</option>)}
          </select></label>
          {history?.nextAfter !== null && history?.nextAfter !== undefined && <button type="button" className={button} disabled={busy} onClick={() => { void action(async () => {
            const page = await client.history(document.id,history.nextAfter!,lifecycle.current!.signal); if (!lifecycle.current!.signal.aborted) setHistory({ revisions: [...history.revisions,...page.revisions],nextAfter: page.nextAfter });
          }); }}>Load more history</button>}
          {reviewBusy ? <p role="status" className="text-xs">Reviewing saved revision…</p> : <><p className="text-xs text-starlight/50">{review.preview.format}{review.preview.entryCount !== null ? ` · ${review.preview.entryCount} lorebook entries` : ''}</p>
            {review.preview.reason && <p className="text-xs leading-relaxed text-amber-200/80">{review.preview.reason}</p>}
            <details><summary className="cursor-pointer text-sm">Read selected saved JSON</summary><pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-cosmic-teal/30 p-2 text-xs">{JSON.stringify(review.record.revision.json,null,2)}</pre></details>
            <button type="button" className={button} disabled={busy || review.record.revision.id !== selected} onClick={() => { void action(async () => {
              const fork = await client.fork(document.id,selected,lifecycle.current!.signal); if (!lifecycle.current!.signal.aborted) onOpen(fork.document.id);
            }); }}>Fork selected revision</button>
            {client.sharing ? <button type="button" className={button} disabled={busy || review.record.revision.id !== selected} onClick={() => setPublishing(structuredClone(review.record))}>Review sharing</button>
              : <p className="text-xs text-starlight/50">Sharing requires a configured server; browser-owned content stays private.</p>}
          </>}
        </section>
        <section className="space-y-3 rounded-xl border border-nebula/20 p-4"><h2 className="text-sm font-semibold">Remove from library</h2><p className="text-xs text-starlight/50">Retained sources and revisions remain available to saved forks and publications.</p>
          <button type="button" disabled={busy} className={`${button} text-red-200`} onClick={() => { if (!window.confirm('Remove this content from your library? Its retained history is not erased.')) return;
            void action(async () => { await client.remove(document.id,lifecycle.current!.signal); if (!lifecycle.current!.signal.aborted) { clearContentDraft(sessionStorage,key,draft.id); onBack(); } });
          }}>Remove content</button></section>
      </aside>
    </div>
    {publishing && <ContentPublisher client={client} record={publishing} onClose={() => setPublishing(null)} />}
  </div>;
}
