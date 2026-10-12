import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { EditorDocument } from './controller.js';
import { createTokenAnalysis } from './tokens.js';
import type { EditorTokenPort } from './tokens.js';

export function TokenCounts({ port, document }: { port: EditorTokenPort; document: EditorDocument }) {
  const analysis = useMemo(() => createTokenAnalysis(port), [port]);
  const state = useSyncExternalStore(analysis.subscribe, analysis.getSnapshot, analysis.getSnapshot);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => { void analysis.update(document); }, 250);
    return () => { clearTimeout(timer); analysis.cancel(); };
  }, [analysis, document, retry]);
  const current = state.document === document;
  return <div className="editor-tokens">
    <p>Text tokens using <strong>{port.label}</strong>. Each field and greeting is counted separately. The total includes creator notes and enabled lorebook entry content.</p>
    <p className="editor-help">A chat app chooses greetings and lorebook entries, substitutes names, and adds prompt formatting, so its context usage will differ. Tags, metadata, assets and unlisted extensions are excluded.{port.local && ' Counting stays in this browser.'}</p>
    {(!current || state.status === 'loading' || state.status === 'idle') && <p aria-live="polite">Counting text…</p>}
    {current && state.status === 'error' && <><p role="alert" className="editor-error">{state.error}</p><button type="button" onClick={() => setRetry((value) => value + 1)}>Retry token count</button></>}
    {current && state.status === 'ready' && <>
      <p aria-live="polite"><strong>{state.omitted.length ? 'Counted text total' : 'Text total'}: {state.total.toLocaleString()} tokens</strong></p>
      {state.omitted.length > 0 && <p className="editor-help">Some values could not be counted and are preserved unchanged: {state.omitted.join(', ')}. The total excludes those values.</p>}
      {state.disabledLoreEntries > 0 && <p className="editor-help">{state.disabledLoreEntries} disabled lorebook {state.disabledLoreEntries === 1 ? 'entry excluded' : 'entries excluded'}.</p>}
      <table><caption>Draft text counts</caption><thead><tr><th scope="col">Field</th><th scope="col">Tokens</th></tr></thead>
        <tbody>{state.fields.map((field) => <tr key={field.label}><th scope="row">{field.label}</th><td>{field.count.toLocaleString()}</td></tr>)}</tbody></table>
    </>}
  </div>;
}
