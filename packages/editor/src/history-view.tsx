import { useEffect, useMemo, useRef, useState } from 'react';
import type { DocumentChange, EditorHistoryPort } from './history.js';
import { compareDocuments } from './history.js';
import type { EditorRevision, EditorState, JsonValue } from './controller.js';

function Value({ value }: { value: JsonValue | undefined }) {
  const [expanded, expand] = useState(false);
  const text = value === undefined ? '(not present)' : JSON.stringify(value, null, 2);
  return <><pre>{expanded ? text : text.slice(0, 2000)}</pre>{text.length > 2000 && <button type="button" onClick={() => expand(!expanded)}>{expanded ? 'Collapse value' : 'Show complete value'}</button>}</>;
}
function label(path: string[]) {
  const names: Record<string, string> = { data: 'Character', character_book: 'Lorebook', entries: 'Entries', first_mes: 'First message', mes_example: 'Example messages' };
  return path.map((part) => Object.hasOwn(names, part) ? names[part] : part.replaceAll('_', ' ')).join(' / ') || 'Document';
}
function metadata(change: DocumentChange) {
  if (change.path.slice(0, 3).join('/') !== 'data/extensions/foundry') return false;
  if (change.path[3] === 'lineage') return true;
  return change.path.length === 3 && [change.before, change.after].every((value) => value === undefined
    || (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => key === 'lineage')));
}
function Change({ change }: { change: DocumentChange }) {
  return <section className="editor-change" aria-label={label(change.path)}>
    <h4>{label(change.path)}</h4><div className="editor-change-values">
      <div><strong>Saved value</strong><Value value={change.before} /></div><div><strong>Draft value</strong><Value value={change.after} /></div>
    </div>
  </section>;
}
type Page = Awaited<ReturnType<EditorHistoryPort['list']>>;
export function RevisionHistory({ port, draft }: { port: EditorHistoryPort; draft: EditorState }) {
  const [loaded, setLoaded] = useState<{ port: EditorHistoryPort; baseRevisionId: string; page: Page } | null>(null);
  const [selected, setSelected] = useState<{ port: EditorHistoryPort; revision: EditorRevision; label: string } | null>(null);
  const [loading, setLoading] = useState(false), [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [offset, setOffset] = useState(0);
  const requests = useRef<{ list?: AbortController; read?: AbortController }>({});
  const page = loaded?.port === port ? loaded.page : null;
  const comparison = selected?.port === port ? selected : null;
  async function read(id: string, name: string) {
    requests.current.read?.abort(); const request = new AbortController(); requests.current.read = request;
    setReading(true); setSelected(null); setOffset(0); setError('');
    try {
      const revision = await port.read(id, request.signal);
      if (revision.revisionId !== id) throw new Error('The host returned a different revision. Refresh history and try again.');
      if (!request.signal.aborted) setSelected({ port, revision: structuredClone(revision), label: name });
    } catch (error) { if (!request.signal.aborted) setError(error instanceof Error ? error.message : 'Cannot read this revision. Try again.'); }
    finally { if (!request.signal.aborted) setReading(false); }
  }
  async function load(append: boolean) {
    requests.current.list?.abort(); const request = new AbortController(); requests.current.list = request;
    setLoading(true); setError('');
    if (!append) { requests.current.read?.abort(); setReading(false); setLoaded(null); setSelected(null); setOffset(0); }
    try {
      const next = structuredClone(await port.list(append && page?.nextAfter !== null && page
        ? { afterSequence: page.nextAfter, throughSequence: page.throughSequence } : {}, request.signal));
      if (request.signal.aborted) return;
      setLoaded({ port, baseRevisionId: draft.revisionId, page: append && page ? { ...page, revisions: [...page.revisions, ...next.revisions], nextAfter: next.nextAfter } : next });
      if (!append) void read(next.headRevisionId, `Revision ${next.throughSequence}`);
    } catch (error) { if (!request.signal.aborted) setError(error instanceof Error ? error.message : 'Cannot load history. Try again.'); }
    finally { if (!request.signal.aborted) setLoading(false); }
  }
  useEffect(() => {
    void load(false);
    const active = requests.current;
    return () => { active.list?.abort(); active.read?.abort(); };
    // Host ports are stable for the lifetime of a controller; a replacement starts fresh.
  }, [port, draft.revisionId]);
  useEffect(() => setOffset(0), [comparison?.revision.document, draft.document]);
  const difference = useMemo(() => comparison ? compareDocuments(comparison.revision.document, draft.document, 50, offset) : null,
    [comparison, draft.document, offset]);
  const metadataChanges = difference?.changes.filter(metadata) ?? [];
  return <div className="editor-history">
    <p>Your draft stays open while you compare. History does not replace or save it.</p>
    <div className="editor-inline"><button type="button" disabled={loading} onClick={() => { void load(false); }}>Refresh history</button>
      {page && <button type="button" disabled={reading} onClick={() => { void read(page.headRevisionId, `Revision ${page.throughSequence}`); }}>Compare latest saved revision</button>}</div>
    {loading && <p aria-live="polite">Loading history…</p>}{reading && <p aria-live="polite">Reading revision…</p>}
    {error && <p role="alert" className="editor-error">{error}</p>}
    {page && <>
      {loaded?.baseRevisionId === draft.revisionId && page.headRevisionId !== draft.revisionId && <p className="editor-help">A newer revision is saved. Your draft is still based on the version you opened. Finish or discard this draft, then reopen the card to use the latest version.</p>}
      <div className="editor-history-list" role="group" aria-label="Saved revisions">{page.revisions.map((item) => <button type="button" key={item.id}
        aria-pressed={comparison?.revision.revisionId === item.id} disabled={reading} onClick={() => { void read(item.id, `Revision ${item.sequence}`); }}>
        <strong>Revision {item.sequence}</strong><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>
        {item.id === draft.revisionId && <small>Draft base</small>}
      </button>)}</div>
      {page.nextAfter !== null && <button type="button" disabled={loading} onClick={() => { void load(true); }}>Load more revisions</button>}
      <p className="editor-help">History includes revisions through {page.throughSequence}. Refresh to include later saves.</p>
    </>}
    {comparison && difference && <section aria-label="Revision comparison">
      <h3>{comparison.label} compared with current draft</h3>
      <p className="editor-help">Lists compare by position. Revision metadata is available below.</p>
      {!difference.changes.length && <p>{offset ? 'No more changes on this page.' : 'No document changes.'}</p>}
      {difference.changes.filter((change) => !metadata(change)).map((change) => <Change change={change} key={JSON.stringify(change.path)} />)}
      {metadataChanges.length > 0 && <details className="editor-history-metadata"><summary>Revision metadata ({metadataChanges.length} {metadataChanges.length === 1 ? 'change' : 'changes'})</summary>
        {metadataChanges.map((change) => <Change change={change} key={JSON.stringify(change.path)} />)}
      </details>}
      <div className="editor-inline">
        {offset > 0 && <button type="button" onClick={() => setOffset(Math.max(0, offset - 50))}>Previous changes</button>}
        {difference.truncated && <button type="button" onClick={() => setOffset(offset + 50)}>Next changes</button>}
        {difference.changes.length > 0 && <span>Changes {offset + 1}–{offset + difference.changes.length}</span>}
      </div>
    </section>}
  </div>;
}
