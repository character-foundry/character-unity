import { useEffect, useState } from 'react';
import { CardEditor, createEditor } from '@character-unity/editor';
import { createWorkerTokenizer } from '@character-unity/editor/worker-tokenizer';
import type { EditorController, EditorRevision, EditorAssetPlan } from '@character-unity/editor';
import type { Workspace } from '@character-unity/store';
import type { ArchitectHost, OpenCard } from './api.js';
import { ExportControls } from '@character-unity/ui';
import { ArchiveBrowser } from '@character-unity/archive-browser';

interface Pane { id: string; title: string; card: OpenCard; editor: EditorController }
function name(value: OpenCard) {
  const data = value.revision.document.data;
  return data && typeof data === 'object' && !Array.isArray(data) && typeof data.name === 'string' && data.name.trim() ? data.name : 'Untitled character';
}

export function Architect({ api }: { api: ArchitectHost }) {
  const browser = api.kind === 'browser';
  const [connected, setConnected] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspace, setWorkspace] = useState('');
  const [workspaceName, setWorkspaceName] = useState('My characters');
  const [library, setLibrary] = useState<OpenCard[]>([]);
  const [more, setMore] = useState(false);
  const [panes, setPanes] = useState<Pane[]>([]);
  const [closeId, setCloseId] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    void api.workspaces().then((items) => {
      if (!active) return;
      setConnected(items !== null); setWorkspaces(items ?? []);
    }).catch((failure: Error) => { if (active) setError(failure.message); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [api]);
  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      if (panes.some((pane) => pane.editor.getSnapshot().dirty)) { event.preventDefault(); event.returnValue = ''; }
    }
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [panes]);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(null); setMessage('');
    try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'The request failed. Try again.'); }
    finally { setBusy(false); }
  }
  async function loadLibrary(id: string, append = false) {
    const cards = await api.list(id, append ? library.at(-1)?.card.id : undefined);
    const entries = await Promise.all(cards.map((card) => api.open(id, card.id)));
    setLibrary((previous) => append ? [...previous, ...entries] : entries); setMore(cards.length === 10);
  }
  function openPane(value: OpenCard) {
    if (panes.length >= 2) { setMessage('Close an editor to open another character.'); return; }
    const id = crypto.randomUUID();
    async function save(input: EditorRevision, plan?: EditorAssetPlan) {
        const revision = await (plan ? api.saveAssets(value.card.workspaceId, value.card.id, input.revisionId, input.document, plan) : api.save(value.card.workspaceId, value.card.id, input.revisionId, input.document));
        const updated = { ...value, revision, card: { ...value.card, headRevisionId: revision.id } };
        setLibrary((previous) => previous.map((entry) => entry.card.id === value.card.id ? updated : entry));
        setPanes((previous) => previous.map((pane) => pane.id === id ? { ...pane, title: name(updated) } : pane));
        return { revisionId: revision.id, document: revision.document };
    }
    const editor = createEditor({ revisionId: value.revision.id, document: value.revision.document }, {
      tokens: createWorkerTokenizer(),
      history: {
        list: (options, signal) => api.history(value.card.workspaceId, value.card.id, options, signal),
        async read(id, signal) {
          const revision = await api.revision(value.card.workspaceId, value.card.id, id, signal);
          return { revisionId: revision.id, document: revision.document };
        },
      },
      save,
      assets: {
        list: (revisionId, signal) => api.assetList(value.card.workspaceId, value.card.id, revisionId, signal),
        read: (revisionId, path, signal) => api.asset(value.card.workspaceId, value.card.id, revisionId, path, signal),
        save,
      },
    });
    setPanes((previous) => [...previous, { id, title: name(value), card: value, editor }]);
  }
  async function selectWorkspace(id: string) {
    await loadLibrary(id); setWorkspace(id);
  }
  function close(pane: Pane) {
    const state = pane.editor.getSnapshot();
    if (state.status === 'saving') { setMessage('Wait for the save to finish before closing this editor.'); return; }
    if (state.dirty) { setCloseId(pane.id); return; }
    setPanes((previous) => previous.filter((item) => item.id !== pane.id));
  }
  return <div className="architect-shell">
    <header><a className="architect-brand" href="/" aria-label="Character Unity home"><span className="unity-mark" aria-hidden="true">u.</span>Character Unity</a><span className="unity-app">Architect</span></header>
    <main className="architect-main">
      <div className="architect-heading"><div><p className="unity-eyebrow">Your character workshop</p><h1>Room for a new story.</h1></div>
        <div className="architect-connection"><span className="architect-profile">{browser ? 'Stored in this browser' : 'Local workspace'}</span>{connected && !browser && <button disabled={busy} onClick={() => { void run(async () => { await api.session(); setWorkspaces(await api.workspaces() ?? []); setMessage('Local session reconnected. Your open drafts are unchanged.'); }); }}>Reconnect session</button>}</div>
      </div>
      {error && <div className="architect-error" role="alert"><p>{error}</p><button disabled={busy} onClick={() => { void run(async () => { await api.session(); setConnected(true); setWorkspaces(await api.workspaces() ?? []); }); }}>{browser ? 'Try storage again' : 'Reconnect'}</button></div>}
      {message && <p role="status">{message}</p>}
      {!connected ? <section className="architect-welcome" aria-label="Connect to your library">
        <p className="unity-eyebrow">A space of your own</p><h2>Bring your characters with you.</h2>
        <p>Open a workspace to import cards, refine their stories and save new revisions. Your original files stay available to download.</p>
        <button className="architect-primary" disabled={busy} onClick={() => { void run(async () => { await api.session(); setWorkspaces(await api.workspaces() ?? []); setConnected(true); }); }}>{busy ? 'Connecting…' : browser ? 'Open browser library' : 'Connect to local library'}</button>
        <p className="architect-muted">{browser ? 'Your browser must allow site storage.' : 'The local API must be running on this computer.'}</p>
      </section> : <>
        {browser && <p className="architect-muted">Cards stay in this browser profile for this site. Clearing site data removes this library. Keep copies of your original files.</p>}
        <section className="architect-workspaces" aria-label="Workspaces">
          {workspaces.length > 0 && <label>Workspace<select value={workspace} disabled={busy} onChange={(event) => { const id = event.target.value; if (id) void run(() => selectWorkspace(id)); }}>
            <option value="" disabled>Choose a workspace</option>{workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label>}
          <form onSubmit={(event) => { event.preventDefault(); void run(async () => { const item = await api.createWorkspace(workspaceName.trim()); setWorkspaces((old) => [...old, item]); await selectWorkspace(item.id); }); }}>
            <label>New workspace<input value={workspaceName} maxLength={120} onChange={(event) => setWorkspaceName(event.target.value)} /></label>
            <button disabled={busy || !workspaceName.trim()}>Create workspace</button>
          </form>
        </section>
        {workspace && api.archive && <ArchiveBrowser key={workspace} host={api.archive} workspace={workspace} disabled={busy} onBusy={setBusy}
          onImported={async (result) => {
            await loadLibrary(workspace);
            const first = result.imported[0]; if (first) openPane(await api.open(workspace, first.card.id));
          }} />}
        {workspace && <div className="architect-workbench">
          <aside className="architect-library" aria-label="Character library">
            <div className="architect-library-heading"><h2>Library</h2><button disabled={busy} onClick={() => { void run(() => loadLibrary(workspace)); }}>Refresh</button></div>
            <label className="architect-import">Import a card<input type="file" accept=".json,.png,.charx" disabled={busy} onChange={(event) => {
              const file = event.target.files?.[0]; event.target.value = '';
              if (file) void run(async () => { const imported = await api.import(workspace, file); await loadLibrary(workspace); openPane(await api.open(workspace, imported.card.id)); });
            }} /></label><p className="architect-muted">JSON, PNG or CharX · up to 32 MiB</p>
            {busy && <p role="status">Loading…</p>}
            {!busy && library.length === 0 && <p className="architect-muted">Your library is empty. Import a character card to begin.</p>}
            <ul>{library.map((entry) => <li key={entry.card.id}>
              <strong>{name(entry)}</strong><span className="architect-muted">Revision {entry.revision.sequence}</span>
              <button disabled={busy || panes.length >= 2} onClick={() => { void run(async () => openPane(await api.open(workspace, entry.card.id))); }}>Open {name(entry)}</button>
            </li>)}</ul>
            {more && <button disabled={busy} onClick={() => { void run(() => loadLibrary(workspace, true)); }}>Load more characters</button>}
          </aside>
          <div className="architect-editors">
            {panes.length === 0 && <section className="architect-empty"><span aria-hidden="true">✦</span><h2>A character begins with a voice.</h2><p>Import a card or open one from your library. You can work on two drafts side by side.</p></section>}
            {panes.map((pane, index) => <section className="architect-pane" key={pane.id} aria-label={`Editor ${index + 1}`}>
              <div className="architect-pane-heading"><div><p className="unity-eyebrow">Editor {index + 1}</p><h2>{pane.title}</h2></div><button onClick={() => close(pane)}>Close editor</button></div>
              {closeId === pane.id && <div className="editor-confirm"><p>Close this editor and discard its unsaved changes?</p><button onClick={() => {
                if (pane.editor.getSnapshot().status === 'saving') return;
                setPanes((old) => old.filter((item) => item.id !== pane.id)); setCloseId(null);
              }}>Discard and close</button><button onClick={() => setCloseId(null)}>Keep editing</button></div>}
              <CardEditor editor={pane.editor} />
              <ExportControls disabled={busy} onBusy={setBusy} onError={(error) => setError(error instanceof Error ? error.message : 'Export failed')}
                download={(format) => api.export(pane.card.card.workspaceId, pane.card.card.id, pane.editor.getSnapshot().revisionId, format)} />
              {pane.card.source && <button className="architect-original" disabled={busy} onClick={() => { void run(async () => {
                const blob = await api.downloadOriginal(pane.card.card.workspaceId, pane.card.card.id);
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a'); link.href = url; link.download = 'original'; link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }); }}>Download accepted original</button>}
            </section>)}
          </div>
        </div>}
      </>}
    </main><footer>Character Unity · A home for characters and their stories.</footer>
  </div>;
}
