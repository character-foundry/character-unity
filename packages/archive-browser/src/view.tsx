import { useEffect, useId, useRef, useState } from 'react';
import type { ArchiveHost } from './host.js';
import { indexSearchOrders, isIndexSearchSort, isSearchSort } from '@character-unity/archive-client/contract';
import type { SearchMatch, SearchSort, ArchiveStatus, CardPage, SearchPage, SelectionManifest } from '@character-unity/archive-client';
import type { ArchiveImportResult } from '@character-unity/cards/archive';
interface Query { mode: 'metadata' | 'lexical' | 'indexed' | 'semantic' | 'hybrid'; q: string; filter: string; provider: string; tag: string; sort: SearchSort }
type Page = CardPage & { total?: number; matches?: (SearchMatch | null)[] };
function viewPage(value: CardPage | SearchPage): Page {
  const { version, archiveId, snapshot, cards, nextCursor } = value;
  return { version, archiveId, snapshot, cards, nextCursor, ...('total' in value ? { total: value.total } : {}), ...('matches' in value && value.matches ? { matches: value.matches } : {}) };
}

export function ArchiveBrowser({ host, workspace, disabled, onBusy, onImported, onError }: {
  host: ArchiveHost; workspace: string; disabled: boolean; onBusy(busy: boolean): void;
  onImported(result: ArchiveImportResult): Promise<void>;
  onError?(error: unknown): void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState<Query>({ mode: 'metadata', q: '', filter: '', provider: '', tag: '', sort: 'relevance' });
  const [applied, setApplied] = useState<Query>(query);
  const [status, setStatus] = useState<ArchiveStatus | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [review, setReview] = useState<SelectionManifest | null>(null);
  const [result, setResult] = useState<ArchiveImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const guideId = useId();
  useEffect(() => () => controller.current?.abort(), []);
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (disabled || controller.current) return;
    const pending = new AbortController(); controller.current = pending;
    setBusy(true); onBusy(true); setError(null);
    try { await action(pending.signal); }
    catch (failure) { if (!pending.signal.aborted) { setError(failure instanceof Error ? failure.message : 'Archive request failed.'); onError?.(failure); } }
    finally { if (!pending.signal.aborted) { controller.current = null; setBusy(false); onBusy(false); } }
  }
  function readPage(applied: Query, snapshot: string, signal: AbortSignal, cursor?: string) {
    const params = { provider: applied.provider, tag: applied.tag, snapshot, limit: 10, ...(cursor ? { cursor } : {}) };
    return applied.mode !== 'metadata'
      ? host.search(workspace, { ...params, text: applied.mode === 'indexed' ? '' : applied.q, ...(applied.mode === 'indexed' ? { mode: 'browse' as const } : applied.mode === 'semantic' || applied.mode === 'hybrid' ? { mode: applied.mode } : {}), ...(applied.filter.trim() ? { filter: applied.filter } : {}), sort: applied.sort }, signal)
      : host.list(workspace, { ...params, q: applied.q }, signal);
  }
  async function search(signal: AbortSignal) {
    const submitted = { ...query };
    setSelected([]); setReview(null); setResult(null); setPage(null);
    const current = await host.status(workspace, signal); signal.throwIfAborted(); setStatus(current);
    if (submitted.mode !== 'metadata' && current.search !== 'lance-fts-v1') {
      setQuery((previous) => ({ ...previous, mode: 'metadata' }));
      throw new Error('Card text search is no longer available. Choose a metadata query and search again.');
    }
    if ((submitted.mode === 'semantic' || submitted.mode === 'hybrid') && !current.semantic) {
      setQuery((previous) => ({ ...previous, mode: 'lexical' }));
      throw new Error('Semantic search is no longer available. Choose a search mode and retry.');
    }
    if (submitted.mode === 'indexed' && current.browse !== 'lance-filter-v1') {
      setQuery((previous) => ({ ...previous, mode: 'metadata' }));
      throw new Error('Indexed browsing is no longer available. Choose a search mode and retry.');
    }
    if (submitted.mode !== 'metadata' && isIndexSearchSort(submitted.sort) && !current.sorts?.includes(submitted.sort)) throw new Error('This result order is no longer available. Choose another order and retry.');
    if (submitted.mode !== 'metadata' && submitted.filter.trim() && !current.filterFields?.length) throw new Error('Advanced filters are no longer available. Clear the filter and search again.');
    const next = await readPage(submitted, current.snapshot, signal); signal.throwIfAborted();
    if (next.archiveId !== current.archiveId || next.snapshot !== current.snapshot) throw new Error('Archive snapshot changed');
    setApplied(submitted); setPage(viewPage(next));
  }
  return <section className="archive-browser" aria-label="Archive import">
    <button disabled={disabled} onClick={() => {
      if (open) setOpen(false);
      else { setOpen(true); void run(search); }
    }}>{open ? 'Close Archive browser' : 'Browse Archive'}</button>
    {open && <div className="archive-content">
      <h2>Choose from Archive</h2><p>Import copies of selected originals into this workspace. Archive keeps its originals.</p>
      <form onSubmit={(event) => { event.preventDefault(); void run(search); }}>
        <fieldset className="archive-filters" disabled={disabled || busy}>
        {status?.search === 'lance-fts-v1' && <label>Search mode<select value={query.mode} onChange={(event) => {
          const mode = event.target.value === 'semantic' ? 'semantic' : event.target.value === 'hybrid' ? 'hybrid' : event.target.value === 'indexed' ? 'indexed' : event.target.value === 'lexical' ? 'lexical' : 'metadata';
          setQuery({ ...query, mode, sort: mode === 'indexed' && query.sort === 'relevance' ? 'id' : query.sort });
        }}>
          <option value="metadata">Titles and tags</option><option value="lexical">Card text</option>
          {status.semantic && <><option value="semantic">Semantic</option><option value="hybrid">Hybrid</option></>}
          {status.browse === 'lance-filter-v1' && <option value="indexed">Filters only</option>}
        </select></label>}
        {query.mode !== 'indexed' && <label>Search Archive<input value={query.q} maxLength={query.mode !== 'metadata' ? 2048 : 200} aria-describedby={guideId}
          required={query.mode !== 'metadata'} onChange={(event) => setQuery({ ...query, q: event.target.value })} /></label>}
        <label>Provider<input value={query.provider} maxLength={128} onChange={(event) => setQuery({ ...query, provider: event.target.value })} /></label>
        <label>Tag<input value={query.tag} maxLength={128} onChange={(event) => setQuery({ ...query, tag: event.target.value })} /></label>
        {query.mode !== 'metadata' && <label>Result order<select value={query.sort} onChange={(event) => { if (isSearchSort(event.target.value)) setQuery({ ...query, sort: event.target.value }); }}>
          {query.mode !== 'indexed' && <option value="relevance">Relevance</option>}<option value="title">Title</option><option value="id">ID</option>
          {status?.sorts?.map((sort) => <option key={sort} value={sort}>{indexSearchOrders[sort].label}</option>)}
          {isIndexSearchSort(query.sort) && !status?.sorts?.includes(query.sort) && <option value={query.sort} disabled>Unavailable: {indexSearchOrders[query.sort].label}</option>}
        </select></label>}
        {query.mode !== 'metadata' && (!!status?.filterFields?.length || !!query.filter) && <label>Advanced filter<input value={query.filter} maxLength={4096} aria-describedby={`${guideId}-filters`} onChange={(event) => setQuery({ ...query, filter: event.target.value })} /></label>}
        <button disabled={disabled || busy || (query.mode !== 'metadata' && query.mode !== 'indexed' && !query.q.trim())}>Search</button>
        </fieldset>
      </form>
      <p id={guideId} className="archive-muted">{query.mode === 'lexical'
        ? 'Search indexed card text. Use quoted phrases, AND, OR, NOT and parentheses; for example: "silver forest" OR ocean.'
        : query.mode === 'semantic' ? 'Search by meaning using the configured embedding provider. Your query is sent to that provider.' : query.mode === 'hybrid' ? 'Combine meaning and keywords (40% semantic weight), with literal title matches first. Use plain text; your query is sent to the configured provider.' : query.mode === 'indexed' ? 'Browse by indexed fields. Leave filters blank to include the full selection.' : 'Search titles, source IDs and tags. Provider and tag filters match exactly.'}</p>
      {query.mode !== 'metadata' && (!!status?.filterFields?.length || !!query.filter) && <p id={`${guideId}-filters`} className="archive-muted archive-query">Optional filter: use comparisons, IN lists, ranges (10 TO 20), EXISTS, AND, OR and NOT. Available fields: {status?.filterFields?.map((field) => `${field.name} (${field.type})`).join(', ') || 'none; clear the filter to retry'}.</p>}
      {(query.mode === 'semantic' || query.mode === 'hybrid') && status?.semantic && <p className="archive-muted">Model: {status.semantic.model}. Vector coverage: {status.semantic.indexedCards} of {status.cardCount} cards.</p>}
      {error && <p role="alert" className="archive-error">{error} If the snapshot changed, search again and reselect.</p>}
      {busy && <p role="status">Reading Archive…</p>}
      {page && <>
        <p className="archive-muted">Source: {page.archiveId}. {selected.length} selected.</p>
        {applied.mode === 'lexical' && <p className="archive-muted archive-query">Card text results for “{applied.q}”: {page.total} {page.total === 1 ? 'match' : 'matches'} · {page.cards.length} shown.</p>}
        {(applied.mode === 'semantic' || applied.mode === 'hybrid') && <p className="archive-muted archive-query">{applied.mode === 'semantic' ? 'Semantic' : 'Hybrid'} results for “{applied.q}”: {page.total} {page.total === 1 ? 'match' : 'matches'} · {page.cards.length} shown.</p>}
        {applied.mode === 'indexed' && <p className="archive-muted archive-query">Indexed results: {page.total} {page.total === 1 ? 'match' : 'matches'} · {page.cards.length} shown.</p>}
        {applied.mode !== 'metadata' && applied.filter && <p className="archive-muted archive-query">Applied filter: {applied.filter}</p>}
        {!page.cards.length && <p>No Archive cards match these filters.</p>}
        <ul className="archive-cards">{page.cards.map((card, index) => <li key={card.id}>
          <label><input type="checkbox" checked={selected.includes(card.id)} disabled={disabled || busy || (selected.length >= 100 && !selected.includes(card.id))} onChange={(event) => {
            setSelected(event.target.checked ? [...selected, card.id] : selected.filter((id) => id !== card.id)); setReview(null); setResult(null);
          }} />{card.title}</label><span className="archive-muted">{card.source.provider} · {card.tags.join(', ') || 'No tags'}
            {card.assets.some((asset) => asset.availability === 'unavailable') && ' · Some source assets unavailable'}</span>
          {page.matches?.[index] && <details><summary>Matched {page.matches[index]!.section || 'card'}</summary><p className="archive-query">{page.matches[index]!.text}</p></details>}
        </li>)}</ul>
        {page.nextCursor && <button disabled={disabled || busy} onClick={() => { void run(async (signal) => {
          const next = viewPage(await readPage(applied, page.snapshot, signal, page.nextCursor!)); signal.throwIfAborted();
          if (next.archiveId !== page.archiveId || next.snapshot !== page.snapshot) throw new Error('Archive snapshot changed');
          if (next.total !== page.total || next.cards.some((card) => page.cards.some((previous) => previous.id === card.id))) throw new Error('Archive page changed; search again');
          setPage({ ...next, cards: [...page.cards, ...next.cards], ...(page.matches && next.matches ? { matches: [...page.matches, ...next.matches] } : {}) });
        }); }}>Load more from Archive</button>}
        <button disabled={disabled || busy || !selected.length} onClick={() => { void run(async (signal) => {
          const selection = await host.select(workspace, page, selected, signal); signal.throwIfAborted(); setReview(selection); setResult(null);
        }); }}>Review selection ({selected.length})</button>
      </>}
      {review && <section className="archive-review" aria-label="Selected originals">
        <h3>Import {review.cards.length} selected original{review.cards.length === 1 ? '' : 's'}</h3>
        <ul>{review.cards.map((card) => <li key={card.id}>{card.title} <span className="archive-muted">({card.original.byteLength.toLocaleString()} bytes)</span></li>)}</ul>
        <button disabled={disabled || busy} onClick={() => { void run(async (signal) => {
          const imported = await host.import(workspace, review, review.cards.map((card) => card.id), signal);
          signal.throwIfAborted();
          setResult(imported); setReview(null);
          setSelected((previous) => previous.filter((id) => !imported.imported.some((item) => item.archiveCardId === id)));
          await onImported(imported);
        }); }}>Import selected originals</button>
      </section>}
      {result && <div role="status"><p>Imported {result.imported.length} of {result.manifest.cards.length} selected originals.</p>
        {result.interrupted && <p>The batch stopped. Completed cards are in your library; review the remaining selection before retrying.</p>}
        {result.failures.map((failure) => <p key={failure.archiveCardId}>{failure.archiveCardId}: {failure.message}</p>)}
      </div>}
    </div>}
  </section>;
}
