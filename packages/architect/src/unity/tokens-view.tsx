import { useEffect } from 'react';
import { useTokenStore } from '../store/token-store';
import { useEditorSession } from './context';

/** Counting is an explicit local tool. Its worker vocabulary is not loaded by
 * opening the editor, and an unavailable counter never masquerades as zero. */
export function NativeTokenCounts() {
  const session = useEditorSession();
  const state = useTokenStore();
  useEffect(() => {
    session.tokens.getState().enable();
    void session.tokens.getState().updateTokenCounts(session.cards.getState().currentCard);
  }, [session]);
  return <section aria-label="Draft text token counts" className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
    <h2 className="text-lg font-semibold">Text tokens · o200k_base</h2>
    <p className="text-sm text-dark-muted">Each field, greeting and enabled lorebook entry is counted separately in this browser. This is selected text, not a chat app’s complete prompt or context usage.</p>
    {state.status === 'loading' && <p role="status">Counting text…</p>}
    {state.status === 'error' && <><p role="alert" className="rounded-lg border border-red-500/50 bg-red-950/40 p-3 text-sm">{state.error}</p>
      <button type="button" className="btn-secondary" onClick={() => { void session.tokens.getState().updateTokenCounts(session.cards.getState().currentCard); }}>Retry token count</button></>}
    {state.status === 'ready' && <>
      <p aria-live="polite" className="text-lg font-semibold">{state.omitted.length ? 'Counted text total' : 'Text total'}: {state.tokenCounts.total.toLocaleString()} tokens</p>
      {state.omitted.length > 0 && <p className="text-sm text-dark-muted">Unsupported values are preserved unchanged and excluded: {state.omitted.join(', ')}.</p>}
      {state.disabledLoreEntries > 0 && <p className="text-sm text-dark-muted">{state.disabledLoreEntries} disabled lorebook {state.disabledLoreEntries === 1 ? 'entry excluded' : 'entries excluded'}.</p>}
      <table className="w-full text-sm"><caption className="pb-3 text-left font-medium">Draft text counts</caption>
        <thead><tr><th className="border-b py-2 text-left" scope="col">Field</th><th className="border-b py-2 text-right" scope="col">Tokens</th></tr></thead>
        <tbody>{state.fields.map((field) => <tr key={field.key}><th className="border-b py-2 text-left font-normal" scope="row">{field.label}</th><td className="border-b py-2 text-right">{field.count.toLocaleString()}</td></tr>)}</tbody>
      </table>
    </>}
    {state.status === 'idle' && <p className="text-sm text-dark-muted">Open a card to count its text.</p>}
  </section>;
}
