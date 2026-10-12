import { useEffect, useRef, useState } from 'react';
import type { EditorController, EditorState } from './controller.js';
import { characterBook, loreObject } from './lorebook.js';
import { lorebookFileLimit } from './lorebook-files.js';
import type { LorebookImportReview } from './lorebook-files.js';

export function LorebookFiles({ editor, attached }: { editor: EditorController; attached(): void }) {
  const [pending, setPending] = useState<{ review: LorebookImportReview; state: EditorState; filename: string } | null>(null);
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, [editor]);
  const state = editor.getSnapshot(), saving = state.status === 'saving';
  const current = pending?.state === state;
  async function read(file: File) {
    const sequence = ++request.current, before = editor.getSnapshot();
    setPending(null); setError(''); setReading(true);
    try {
      if (file.size > lorebookFileLimit) throw new Error('Choose a lorebook JSON file no larger than 256 KiB.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (sequence !== request.current) return;
      if (before !== editor.getSnapshot()) throw new Error('The draft changed. Choose the lorebook file again to review it.');
      const review = editor.prepareLorebookImport(bytes);
      setPending({ review, state: before, filename: file.name });
    } catch (failure) {
      if (sequence === request.current) setError(failure instanceof Error ? failure.message : 'Lorebook import failed.');
    } finally { if (sequence === request.current) setReading(false); }
  }
  function download() {
    try {
      const blob = new Blob([editor.downloadLorebook()], { type: 'application/json' });
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = 'lorebook.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); setError('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Lorebook download failed.'); }
  }
  return <div className="editor-lore-files">
    <p className="editor-help">Import a native character-book JSON file, up to 256 KiB and 1,000 entries. Review it before attaching it to this draft. Save revision to keep the change.</p>
    <label className="editor-field">Import lorebook JSON<input type="file" accept=".json,application/json" disabled={saving}
      onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void read(file); }} /></label>
    <button type="button" disabled={!loreObject(characterBook(state.document))} onClick={download}>Download draft lorebook JSON</button>
    <p className="editor-help">Downloads include unsaved lorebook edits. Other lorebook formats require conversion before importing.</p>
    {reading && <p>Reading lorebook…</p>}
    {error && <p role="alert" className="editor-error">{error}</p>}
    {pending && <section className="editor-confirm" aria-label="Lorebook import review">
      <p>{pending.filename}: {pending.review.name || 'Unnamed lorebook'} · {pending.review.entries} {pending.review.entries === 1 ? 'entry' : 'entries'}.</p>
      <p>{pending.review.replacesExisting ? 'This replaces the entire lorebook in this draft, including its current unsaved edits.' : 'This adds a lorebook to this draft.'} Other card fields stay as they are. Earlier saved revisions remain available.</p>
      {!current && <p>The draft changed. Choose the lorebook file again to review it.</p>}
      <button type="button" disabled={saving || !current} onClick={() => {
        try { editor.attachLorebook(pending.review); setPending(null); setError(''); attached(); }
        catch (failure) { setError(failure instanceof Error ? failure.message : 'Lorebook attach failed.'); }
      }}>{pending.review.replacesExisting ? 'Replace draft lorebook' : 'Attach lorebook to draft'}</button>
      <button type="button" onClick={() => setPending(null)}>Cancel lorebook import</button>
    </section>}
  </div>;
}
