import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { AppShell } from '@/components/layout';
import { useLibraryClient } from '@/lib/library-client';
import { createContentClient, type ContentClient, type ContentKind, type ContentSummary } from './client';
import { ContentEditor } from './editor';
import { SharedContentList } from './shared';
import { Modal } from '@/components/ui/modal';

const kinds = ['lorebook','preset','persona'] as const;
const labels = { lorebook: 'Lorebooks',preset: 'Presets',persona: 'Personas' };
const button = 'rounded-lg border border-nebula/30 px-3 py-1.5 text-sm hover:bg-cosmic-teal/30 disabled:opacity-50';
export default function ContentPage() {
  const library = useLibraryClient(), client = useMemo(() => createContentClient(library),[library]);
  return <AppShell><ContentPageBody key={client.scopeKey} client={client} /></AppShell>;
}
function ContentPageBody({ client }: { client: ContentClient }) {
  const [params,setParams] = useSearchParams(), rawKind = params.get('kind');
  const kind: ContentKind = kinds.includes(rawKind as ContentKind) ? rawKind as ContentKind : 'lorebook';
  const mode = params.get('mode') === 'shared' ? 'shared' : params.get('mode') === 'mine' ? 'mine' : 'library', id = params.get('item');
  const open = (item: string) => setParams({ kind,item });
  return <div className="mx-auto max-w-6xl space-y-5">
    {id ? <ContentEditor key={id} client={client} id={id} onBack={() => setParams({ kind })} onOpen={open} /> : <>
      <div><h1 className="text-xl font-semibold">Lorebooks, presets &amp; personas</h1><p className="mt-1 max-w-3xl text-sm leading-relaxed text-starlight/60">Standalone JSON, kept in the same Unity library database. Original bytes stay immutable; saved edits and source-linked forks are separate revisions. These are not character cards or a second Archive copy.</p></div>
      <nav aria-label="Content kinds" className="flex flex-wrap gap-2">{kinds.map((value) => <button type="button" key={value} aria-pressed={kind === value}
        className={`${button} ${kind === value ? 'bg-nebula/20 text-nebula' : 'text-starlight/60'}`} onClick={() => setParams({ kind: value,mode })}>{labels[value]}</button>)}</nav>
      <nav aria-label="Content collections" className="flex flex-wrap gap-4 border-b border-nebula/20 pb-3 text-sm">
        {([['library','Your library'],['shared','Browse shared'],['mine','My shared items']] as const).map(([value,label]) => <button type="button" key={value} aria-pressed={mode === value}
          className={mode === value ? 'text-nebula' : 'text-starlight/60'} onClick={() => setParams({ kind,mode: value })}>{label}</button>)}
      </nav>
      {mode === 'library' ? <ContentLibrary key={kind} client={client} kind={kind} onOpen={open} /> : <SharedContentList key={`${kind}:${mode}`} client={client} kind={kind} mine={mode === 'mine'} onOpen={open} />}
    </>}
  </div>;
}
function ContentLibrary({ client,kind,onOpen }: { client: ContentClient; kind: ContentKind; onOpen(id: string): void }) {
  const [items,setItems] = useState<ContentSummary[]>([]), [total,setTotal] = useState<number | null>(null), [next,setNext] = useState<string | null>(null), [after,setAfter] = useState('');
  const [text,setText] = useState(''), [query,setQuery] = useState(''), [attempt,setAttempt] = useState(0), [creating,setCreating] = useState(false);
  const [error,setError] = useState<string | null>(null), [loading,setLoading] = useState(true), [busy,setBusy] = useState(false), [notice,setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null), lifetime = useRef<AbortController | null>(null);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); },[]);
  useEffect(() => {
    const controller = new AbortController(); setError(null); setLoading(true);
    void client.list({ kind,q: query,afterId: after,signal: controller.signal }).then((page) => {
      if (!controller.signal.aborted) { setItems(page.items); setTotal(page.total); setNext(page.nextAfter); setLoading(false); }
    }).catch((failure: unknown) => { if (!controller.signal.aborted) { setError(failure instanceof Error ? failure.message : 'Content library unavailable.'); setLoading(false); } });
    return () => controller.abort();
  },[client,kind,query,after,attempt]);
  async function importFile(file: File) {
    if (busy) return; setBusy(true); setError(null); setNotice(null);
    try {
      if (file.size > 1_048_576) throw new Error('Standalone JSON files are limited to 1 MiB.');
      const result = await client.import(kind,file,lifetime.current!.signal);
      if (!lifetime.current!.signal.aborted) {
        if (result.created) onOpen(result.record.document.id);
        else { setCreating(false); setNotice('Already in your library; no duplicate stored.'); setAttempt((value) => value+1); }
      }
    } catch (failure) { if (!lifetime.current!.signal.aborted) setError(failure instanceof Error ? failure.message : 'Import failed.'); }
    finally { if (!lifetime.current!.signal.aborted) setBusy(false); }
  }
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><form className="flex min-w-0 gap-2" onSubmit={(event) => { event.preventDefault(); setAfter(''); setQuery(text.trim()); }}>
      <input aria-label="Search standalone content" type="search" placeholder={`Search ${labels[kind].toLowerCase()}…`} value={text} onChange={(event) => setText(event.target.value)} className="min-w-0 rounded-lg px-3 py-1.5 text-sm" maxLength={500} />
      <button type="submit" disabled={loading || busy} className={button}>Search</button></form>
      <div className="flex flex-wrap gap-2"><input type="file" accept=".json,.risulorebook,application/json" ref={fileInput} className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = ''; }} />
        <button type="button" className={button} disabled={busy} onClick={() => fileInput.current?.click()}>{busy ? 'Importing…' : `Import ${kind} JSON`}</button>
        <button type="button" className={button} disabled={busy} onClick={() => setCreating(true)}>Create JSON</button>
        <button type="button" className={button} disabled={loading || busy} onClick={() => setAttempt((value) => value+1)}>Refresh content</button></div>
    </div>
    {error && <p role="alert" className="text-sm text-red-200">{error}</p>}{notice && <p role="status" className="text-sm text-nebula">{notice}</p>}
    {loading ? <p role="status" className="py-10 text-center text-starlight/60">Reading {labels[kind].toLowerCase()}…</p> : <>
      {total !== null && <p className="text-xs text-starlight/50">{total.toLocaleString()} {labels[kind].toLowerCase()} in this workspace{query ? ' matching your search' : ''}</p>}
      {!items.length && !error && <p className="rounded-xl border border-nebula/20 p-8 text-center text-sm text-starlight/50">No {labels[kind].toLowerCase()} here yet. Import or create JSON to begin.</p>}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{items.map((item) => <button type="button" key={item.id} onClick={() => onOpen(item.id)}
        className="min-w-0 rounded-xl border border-nebula/20 bg-deep-space/60 p-4 text-left hover:border-nebula/60">
        <span className="block break-words text-sm font-semibold">{item.title}</span><span className="mt-2 block text-xs text-starlight/50">{item.kind} · {item.revisionCount} revision{item.revisionCount === 1 ? '' : 's'}{item.forkedFromRevisionId ? ' · fork' : ''}</span>
      </button>)}</div>
      <div className="flex gap-2">{after && <button type="button" className={button} onClick={() => setAfter('')}>First page</button>}{next && <button type="button" className={button} onClick={() => setAfter(next)}>Next page</button>}</div>
    </>}
    {creating && <CreateContent kind={kind} busy={busy} onClose={() => { if (!busy) setCreating(false); }} onImport={(file) => { void importFile(file); }} error={error} />}
  </div>;
}
function CreateContent({ kind,busy,onClose,onImport,error }: { kind: ContentKind; busy: boolean; onClose(): void; onImport(file: File): void; error: string | null }) {
  const initial = kind === 'lorebook' ? { name: 'New lorebook',entries: [] } : kind === 'persona' ? { name: 'New persona',description: '' } : { name: 'New preset',temperature: 0.7 };
  const [text,setText] = useState(JSON.stringify(initial,null,2));
  return <Modal isOpen onClose={onClose} label="Create standalone JSON content" size="lg"><div className="space-y-4 p-5">
    <div className="flex items-start justify-between gap-3"><h2 className="text-lg font-semibold">Create {kind} JSON</h2><button type="button" disabled={busy} onClick={onClose} aria-label="Close content creation">×</button></div>
    <p className="text-xs leading-relaxed text-starlight/50">This exact JSON becomes the retained initial source. Edit its name and fields before creating. Existing equal content is deduplicated; no provider runs or character-card wrappers are added.</p>
    <label className="block space-y-1 text-sm"><span>Initial complete JSON</span><textarea aria-label="New content JSON" disabled={busy} value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} className="min-h-72 w-full rounded-lg p-3 font-mono text-xs" /></label>
    {error && <p role="alert" className="text-sm text-red-200">{error}</p>}
    <button type="button" disabled={busy} className="btn-primary px-4 py-2 disabled:opacity-50" onClick={() => onImport(new File([text],`${kind}.json`,{ type: 'application/json' }))}>{busy ? 'Creating…' : 'Create from this JSON'}</button>
  </div></Modal>;
}
