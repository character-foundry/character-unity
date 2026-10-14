import { useEffect, useRef, useState } from 'react';
import { useCardStore } from '../../store/card-store';
import { useEditorSession } from '../context';
import type { Card } from '../../lib/types';
import { characterBook, loreObject, type EditorDocument } from './model';
import { lorebookFileLimit, type LorebookImportReview } from './files';

export function LorebookFiles({ attached }: { attached(): void }) {
  const session = useEditorSession();
  const state = useCardStore();
  const [pending, setPending] = useState<{ review: LorebookImportReview; card: Card; filename: string } | null>(null);
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, [session]);
  const saving = state.isSaving || state.isRestoring;
  const current = pending?.card === state.currentCard;
  async function read(file: File) {
    const sequence = ++request.current, before = session.cards.getState().currentCard;
    setPending(null); setError(''); setReading(true);
    try {
      if (file.size > lorebookFileLimit) throw new Error('Choose a lorebook JSON file no larger than 256 KiB.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (sequence !== request.current || session.signal.aborted) return;
      if (!before || before !== session.cards.getState().currentCard) throw new Error('The draft changed. Choose the lorebook file again to review it.');
      const review = session.cards.getState().prepareLorebookImport(bytes);
      setPending({ review, card: before, filename: file.name });
    } catch (failure) {
      if (sequence === request.current && !session.signal.aborted) setError(failure instanceof Error ? failure.message : 'Lorebook import failed.');
    } finally { if (sequence === request.current && !session.signal.aborted) setReading(false); }
  }
  function download() {
    try {
      const blob = new Blob([session.cards.getState().downloadLorebook()], { type: 'application/json' });
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = 'lorebook.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); setError('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Lorebook download failed.'); }
  }
  return <div className="editor-lore-files">
    <p className="editor-help">Import native character-book JSON, up to 256 KiB and 1,000 entries. Review it before replacing this draft’s lorebook; Save keeps the change.</p>
    <label className="editor-field">Import lorebook JSON<input type="file" accept=".json,application/json" disabled={saving}
      onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void read(file); }} /></label>
    <button type="button" disabled={!state.currentCard || !loreObject(characterBook(state.currentCard.data as unknown as EditorDocument))} onClick={download}>Download draft lorebook JSON</button>
    {reading && <p role="status">Reading lorebook…</p>}
    {error && <p role="alert" className="editor-error">{error}</p>}
    {pending && <section className="editor-confirm" aria-label="Lorebook import review">
      <p>{pending.filename}: {pending.review.name || 'Unnamed lorebook'} · {pending.review.entries} {pending.review.entries === 1 ? 'entry' : 'entries'}.</p>
      <p>{pending.review.replacesExisting ? 'This replaces the entire lorebook in this draft, including its current unsaved edits.' : 'This adds a lorebook to this draft.'} Other card fields and saved revisions stay unchanged.</p>
      {!current && <p>The draft changed. Choose the lorebook file again to review it.</p>}
      <button type="button" disabled={saving || !current} onClick={() => {
        try { session.cards.getState().attachLorebook(pending.review); setPending(null); setError(''); attached(); }
        catch (failure) { setError(failure instanceof Error ? failure.message : 'Lorebook attach failed.'); }
      }}>{pending.review.replacesExisting ? 'Replace draft lorebook' : 'Attach lorebook to draft'}</button>
      <button type="button" onClick={() => setPending(null)}>Cancel lorebook import</button>
    </section>}
  </div>;
}
