import { useEffect, useId, useRef, useState } from 'react';
import { useCardStore } from '../../store/card-store';
import { useEditorSession } from '../context';
import { Dialog } from '../../components/ui/Dialog';
import type { Card } from '../../lib/types';
import type { LorebookImportReview } from './files';
import { characterBook, type EditorDocument } from './model';

/** Source reads never repin this draft's Save head; replacement is reviewed. */
export function LorebookLibraryImport({ attached }: { attached(): void }) {
  const session = useEditorSession(), state = useCardStore();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [cards, setCards] = useState<Card[]>([]), [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState(''), [search, setSearch] = useState('');
  const [page, setPage] = useState(1), [total, setTotal] = useState(0);
  const [pending, setPending] = useState<{ review: LorebookImportReview; card: Card } | null>(null);
  const operation = useRef<AbortController | null>(null);
  const searchId = useId(), pageSize = 50;
  useEffect(() => () => operation.current?.abort(), [session]);
  function begin() {
    operation.current?.abort(); const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError(null); setPending(null);
    return AbortSignal.any([controller.signal, session.liveSignal()]);
  }
  async function load(nextSearch: string, nextPage: number) {
    const signal = begin(); setSearch(nextSearch); setPage(nextPage); setCards([]); setTotal(0);
    try {
      const result = await session.api.listCards(nextSearch || undefined, nextPage, pageSize, false, { has: ['lorebook'], sort: 'name' }, { signal });
      signal.throwIfAborted();
      if (result.error || !result.data) throw new Error(result.error ?? 'The library did not answer');
      const lastPage = Math.max(1, Math.ceil(result.data.total / pageSize));
      if (nextPage > lastPage) { await load(nextSearch, lastPage); return; }
      setTotal(result.data.total);
      setCards(result.data.items.filter((card) => card.meta.id !== session.cards.getState().currentCard?.meta.id));
    } catch (failure) { if (!signal.aborted) setError(failure instanceof Error ? failure.message : 'Lorebooks could not be loaded'); }
    finally { if (!signal.aborted) setBusy(false); }
  }
  function show() { setOpen(true); setQuery(''); void load('', 1); }
  async function review(card: Card) {
    const signal = begin(), before = session.cards.getState().currentCard;
    try {
      const result = await session.api.getCard(card.meta.id, { signal, pinHead: false });
      signal.throwIfAborted();
      if (!before || before !== session.cards.getState().currentCard) throw new Error('The draft changed. Choose the source lorebook again.');
      if (result.error || !result.data) throw new Error(result.error ?? 'The source card could not be read');
      const book = characterBook(result.data.data as unknown as EditorDocument);
      if (!book) throw new Error('This card no longer has an embedded lorebook');
      const receipt = session.cards.getState().prepareLorebookImport(new TextEncoder().encode(JSON.stringify(book)));
      setPending({ review: receipt, card: before });
    } catch (failure) { if (!signal.aborted) setError(failure instanceof Error ? failure.message : 'Lorebook could not be reviewed'); }
    finally { if (!signal.aborted) setBusy(false); }
  }
  function close() { operation.current?.abort(); setOpen(false); setPending(null); setBusy(false); }
  const saving = state.isSaving || state.isRestoring;
  return <div className="editor-lore-files"><button type="button" disabled={saving} onClick={show}>Import from another card</button>
    {open && <Dialog label="Import lorebook from another card" onClose={close} className="w-[600px]">
      <div className="native-lorebook space-y-4"><h2 className="text-lg font-semibold">Import lorebook from another card</h2>
        <p className="editor-help">Choose a source to review. Only its lorebook replaces this draft; it does not save or change the source card.</p>
        <form onSubmit={(event) => { event.preventDefault(); void load(query.trim(), 1); }}>
          <div className="editor-field"><label htmlFor={searchId}>Search source cards</label>
            <input id={searchId} value={query} maxLength={200} data-autofocus onChange={(event) => setQuery(event.target.value)} /></div>
          <button type="submit" disabled={saving}>Search sources</button>
        </form>
        {busy && <p role="status">Loading lorebooks…</p>}
        {error && <p role="alert" className="editor-error">{error}</p>}
        {error && <button type="button" disabled={busy || saving} onClick={() => { void load(search, page); }}>Retry sources</button>}
        {!busy && !error && <p className="editor-help">Page {page} of {Math.max(1, Math.ceil(total / pageSize))} · {total} matching library cards. Up to {pageSize} shown; the current card is omitted.</p>}
        {!busy && !error && cards.length === 0 && <p>No other cards with embedded lorebooks found. Try another search.</p>}
        <div className="editor-lore-list">{cards.map((card) => <button key={card.meta.id} type="button" disabled={busy || saving} onClick={() => { void review(card); }}>{card.meta.name}</button>)}</div>
        <div className="editor-inline" aria-label="Source pages">
          <button type="button" disabled={busy || saving || page <= 1} onClick={() => { void load(search, page - 1); }}>Previous sources</button>
          <button type="button" disabled={busy || saving || page * pageSize >= total} onClick={() => { void load(search, page + 1); }}>Next sources</button>
        </div>
        {pending && <section aria-label="Library lorebook import review" className="editor-confirm">
          <p>{pending.review.name ?? 'Unnamed lorebook'} · {pending.review.entries} {pending.review.entries === 1 ? 'entry' : 'entries'}. This replaces the entire draft lorebook.</p>
          {pending.card !== state.currentCard && <p>The draft changed. Choose the source lorebook again.</p>}
          <button type="button" disabled={saving || busy || pending.card !== state.currentCard} onClick={() => {
            try { session.cards.getState().attachLorebook(pending.review); attached(); close(); }
            catch (failure) { setError(failure instanceof Error ? failure.message : 'Lorebook attach failed'); }
          }}>Replace draft lorebook</button>
        </section>}
        <button type="button" onClick={close}>Cancel library import</button>
      </div>
    </Dialog>}
  </div>;
}
