import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArchitectEditorHost, createEditorSession, type EditorSession } from '@character-unity/architect/host';
// Use the shipped host stylesheet: it compiles Architect's public Tailwind
// fragment with the same theme/utilities as the real application.
import '../../apps/web/src/styles.css';

const params = new URLSearchParams(window.location.search);
const fixtures = ['Alpha', 'Beta'] as const;
type Pane = typeof fixtures[number];
const workspace = (pane: Pane) => params.get(`${pane.toLowerCase()}Workspace`) ?? '';
const initialCard = (pane: Pane) => params.get(`${pane.toLowerCase()}Card`) ?? '';

function EditorPane({ pane, onClose }: { pane: Pane; onClose(): void }) {
  const [session] = useState<EditorSession>(() => createEditorSession({ workspaceId: workspace(pane) }));
  const [selection, setSelection] = useState<{ cardId: string; forkOf?: string }>({ cardId: initialCard(pane) });
  const [flushed, setFlushed] = useState(0);
  const [ready, setReady] = useState(!params.has('ai'));
  useEffect(() => {
    let active = true;
    if (params.has('ai')) {
      void session.llm.getState().saveSettings({ providers: [{ id: 'qa-provider', name: 'Fixture provider', kind: 'openai-compatible',
        baseURL: `${window.location.origin}/qa-ai`, apiKey: '', defaultModel: 'qa-model' }], activeProviderId: 'qa-provider' })
        .then(() => { if (active) setReady(true); });
    }
    return () => { active = false; session.dispose(); };
  }, [session]);
  return <section aria-label={`Editor ${pane}`} style={{ minWidth: 0, border: '1px solid #4d426c', borderRadius: 8, overflow: 'hidden' }}>
    <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '8px 12px', background: '#1b1729' }}>
      <h2 style={{ margin: 0, fontSize: 16 }}>{pane} editor</h2>
      <button type="button" onClick={onClose}>Close {pane} editor</button>
      {params.has(`${pane.toLowerCase()}Alternate`) && <button type="button" onClick={() => setSelection({ cardId: params.get(`${pane.toLowerCase()}Alternate`)! })}>Open {pane} alternate</button>}
      {params.has(`${pane.toLowerCase()}Fork`) && <button type="button" onClick={() => setSelection({ cardId: '', forkOf: params.get(`${pane.toLowerCase()}Fork`)! })}>Start {pane} fork</button>}
      {(params.has(`${pane.toLowerCase()}Alternate`) || params.has(`${pane.toLowerCase()}Fork`)) && <button type="button" onClick={() => setSelection({ cardId: initialCard(pane) })}>Return {pane} original</button>}
      {params.has('recovery') && <><button type="button" onClick={() => { void session.recovery.flush().then(() => setFlushed((value) => value + 1)); }}>Flush {pane} recovery</button><output aria-label={`${pane} recovery flushes`}>{flushed}</output></>}
    </header>
    <div style={{ height: 'calc(100vh - 112px)', minHeight: 600 }}>
      {ready ? <ArchitectEditorHost config={{ workspaceId: workspace(pane) }} session={session} cardId={selection.cardId} forkOf={selection.forkOf}
        onCreated={(cardId) => setSelection({ cardId })} onExit={() => undefined} /> : <p role="status">Preparing {pane} editor…</p>}
    </div>
  </section>;
}

function Fixture() {
  const [mounted, setMounted] = useState({ Alpha: true, Beta: true });
  return <main style={{ padding: 12 }}>
    <h1 style={{ margin: '0 0 10px', fontSize: 18 }}>Two independent native Architect hosts</h1>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
      {fixtures.map((pane) => mounted[pane]
        ? <EditorPane key={pane} pane={pane} onClose={() => setMounted((current) => ({ ...current, [pane]: false }))} />
        : <section key={pane} aria-label={`Closed ${pane} editor`}><button type="button" onClick={() => setMounted((current) => ({ ...current, [pane]: true }))}>Reopen {pane} editor</button></section>)}
    </div>
  </main>;
}

document.body.style.cssText = 'margin:0;background:#11101b;color:#e6e2ef;font:14px system-ui,sans-serif';
const root = document.getElementById('root');
if (!root) throw new Error('Missing isolation fixture root');
createRoot(root).render(<Fixture />);
