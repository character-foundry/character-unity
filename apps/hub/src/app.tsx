import { useEffect, useRef, useState } from 'react';
import { CardEditor, createEditor } from '@character-unity/editor';
import { createWorkerTokenizer } from '@character-unity/editor/worker-tokenizer';
import type { EditorController, EditorRevision, EditorAssetPlan } from '@character-unity/editor';
import type { Workspace, CardDocument } from '@character-unity/store';
import type { PublicationPolicy } from '@character-unity/store/hub';
import { ExportControls } from '@character-unity/ui';
import { ArchiveBrowser } from '@character-unity/archive-browser';
import { api, ApiError } from './api.js';
import type { Session, OpenCard, Publication, LineagePage } from './api.js';
import { LineageGraph } from './lineage.js';
import { RemoteHubs } from './remotes.js';

function title(document: CardDocument) {
  const data = document.data;
  return data && typeof data === 'object' && !Array.isArray(data) && typeof data.name === 'string' && data.name.trim() ? data.name : 'Untitled character';
}
interface Pane { card: OpenCard; editor: EditorController }
const initialPolicy: PublicationPolicy = { visibility: 'members', allowFork: true, allowOriginal: false };

export function Hub() {
  const [session, setSession] = useState<Session | null>(null);
  const [locked, setLocked] = useState(true);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspace, setWorkspace] = useState('');
  const [workspaceName, setWorkspaceName] = useState('My characters');
  const [library, setLibrary] = useState<OpenCard[]>([]);
  const [moreLibrary, setMoreLibrary] = useState(false);
  const [selected, setSelected] = useState<OpenCard[]>([]);
  const [policy, setPolicy] = useState<PublicationPolicy>({ ...initialPolicy });
  const [review, setReview] = useState(false);
  const [publications, setPublications] = useState<Publication[]>([]);
  const [morePublications, setMorePublications] = useState(false);
  const [parent, setParent] = useState('');
  const [graph, setGraph] = useState<LineagePage | null>(null);
  const [pane, setPane] = useState<Pane | null>(null);
  const [discardAction, setDiscardAction] = useState<(() => Promise<void>) | null>(null);
  const [editorSaving, setEditorSaving] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const disabled = busy || editorSaving;
  function failure(value: unknown) {
    if (value instanceof ApiError && (value.status === 401 || value.code === 'ACCOUNT_CHANGED')) setLocked(true);
    setError(value instanceof Error ? value.message : 'The request failed. Try again.');
  }
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(''); setMessage('');
    try { await action(); } catch (value) { failure(value); } finally { setBusy(false); }
  }
  async function loadPublications(append = false, parentId = parent) {
    const values = await api.publications(append ? publications.at(-1)?.id : '', parentId);
    setPublications((old) => append ? [...old, ...values] : values); setMorePublications(values.length === 20);
  }
  async function loadLibrary(id: string, append = false) {
    const values = await api.library(id, append ? library.at(-1)?.card.id : '');
    setLibrary((old) => append ? [...old, ...values] : values); setMoreLibrary(values.length === 10);
  }
  async function loadLineage(id: string, append = false) {
    try {
      const next = await api.lineage(id, append ? graph?.nextAfter ?? '' : '');
      setGraph((previous) => ({ ...next, nodes: append && previous?.anchorId === id ? [...previous.nodes, ...next.nodes] : next.nodes }));
    } catch (error) { setGraph(null); throw error; }
  }
  async function connect(value: Session) {
    if (session && value.actor.id !== session.actor.id) {
      await api.logout(); throw new Error(`Sign in as ${session.name} to recover this draft, or reload to switch accounts.`);
    }
    setSession(value); setLocked(false);
    setWorkspaces(await api.workspaces()); await loadPublications();
  }
  useEffect(() => {
    if (discardAction) dialog.current?.showModal();
  }, [discardAction]);
  useEffect(() => {
    let active = true;
    void api.session().then(async (value) => {
      const [spaces, shared] = await Promise.all([api.workspaces(), api.publications()]);
      if (active) { setSession(value); setLocked(false); setWorkspaces(spaces); setPublications(shared); setMorePublications(shared.length === 20); }
    }).catch((value) => { if (active && (!(value instanceof ApiError) || value.status !== 401)) setError(value instanceof ApiError && value.status === 404 ? 'Hub sign-in is unavailable. Ask the operator to check the service.' : 'Cannot reach this hub. Try signing in again.'); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!pane) { setEditorSaving(false); return; }
    const update = () => setEditorSaving(pane.editor.getSnapshot().status === 'saving');
    update(); return pane.editor.subscribe(update);
  }, [pane]);
  useEffect(() => {
    function leaving(event: BeforeUnloadEvent) {
      if (pane?.editor.getSnapshot().dirty || pane?.editor.getSnapshot().status === 'saving') { event.preventDefault(); event.returnValue = ''; }
    }
    window.addEventListener('beforeunload', leaving);
    return () => window.removeEventListener('beforeunload', leaving);
  }, [pane]);
  function changing(action: () => Promise<void>) {
    if (pane?.editor.getSnapshot().status === 'saving') return;
    if (pane?.editor.getSnapshot().dirty) { setDiscardAction(() => action); return; }
    void run(action);
  }
  function open(value: OpenCard) {
    async function save(input: EditorRevision, plan?: EditorAssetPlan) {
      try {
        const revision = await (plan ? api.saveAssets(value.card.workspaceId, value.card.id, input.revisionId, input.document, plan) : api.save(value.card.workspaceId, value.card.id, input.revisionId, input.document));
        setLibrary((old) => old.map((item) => item.card.id === value.card.id ? { card: { ...item.card, headRevisionId: revision.id }, revision } : item));
        setSelected((old) => old.filter((item) => item.card.id !== value.card.id)); setReview(false);
        return { revisionId: revision.id, document: revision.document };
      } catch (error) { failure(error); throw error; }
    }
    const editor = createEditor({ revisionId: value.revision.id, document: value.revision.document }, {
      tokens: createWorkerTokenizer(),
      history: {
        async list(options, signal) {
          try { return await api.history(value.card.workspaceId, value.card.id, options, signal); }
          catch (error) { if (!signal.aborted) failure(error); throw error; }
        },
        async read(id, signal) {
          try {
            const revision = await api.revision(value.card.workspaceId, value.card.id, id, signal);
            return { revisionId: revision.id, document: revision.document };
          } catch (error) { if (!signal.aborted) failure(error); throw error; }
        },
      }, save,
      assets: {
        async list(revisionId, signal) {
          try { return await api.assetList(value.card.workspaceId, value.card.id, revisionId, signal); }
          catch (error) { if (!signal.aborted) failure(error); throw error; }
        },
        async read(revisionId, path, signal) {
          try { return await api.asset(value.card.workspaceId, value.card.id, revisionId, path, signal); }
          catch (error) { if (!signal.aborted) failure(error); throw error; }
        },
        save,
      },
    });
    setPane({ card: value, editor });
  }
  async function chooseWorkspace(id: string) {
    await loadLibrary(id); setWorkspace(id); setPane(null); setSelected([]); setReview(false);
  }
  async function logout() {
    await api.logout(); setSession(null); setLocked(true); setPane(null); setWorkspaces([]); setWorkspace('');
    setLibrary([]); setSelected([]); setPublications([]); setParent(''); setReview(false); setGraph(null);
  }
  return <div className="hub-shell">
    <header><span className="unity-mark" aria-hidden="true">u.</span><strong>Character Unity</strong><span className="unity-app">Hub</span>
      {session && !locked && <><span>{session.name}</span><button disabled={disabled} onClick={() => changing(logout)}>Sign out</button></>}
    </header>
    <main>
      <p className="unity-eyebrow">A home for your characters</p><h1>Stories grow together.</h1>
      {error && <p className="hub-error" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
      {locked && <section className="hub-panel" aria-label="Sign in">
        <h2>{session ? `Reconnect as ${session.name}` : 'Sign in to your hub'}</h2>
        <p>{session ? 'Your draft is still here. Sign in with the same account to continue.' : 'Use the access key provided by your hub operator.'}</p>
        <form onSubmit={(event) => { event.preventDefault(); const value = key.trim(); setKey(''); void run(async () => connect(await api.login(value))); }}>
          <label>Access key<input type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} /></label>
          <button disabled={busy || !key.trim()}>Sign in</button>
        </form>
      </section>}
      <div hidden={locked}>
        <section className="hub-panel" aria-label="Your workspace">
          <h2>Your workspace</h2>
          <div className="hub-row">
            <label>Workspace<select value={workspace} disabled={disabled} onChange={(event) => { const id = event.target.value; changing(() => chooseWorkspace(id)); }}>
              <option value="" disabled>Choose a workspace</option>{workspaces.map((value) => <option key={value.id} value={value.id}>{value.name}</option>)}
            </select></label>
            <form onSubmit={(event) => { event.preventDefault(); changing(async () => { const value = await api.createWorkspace(workspaceName.trim()); setWorkspaces((old) => [...old, value]); await chooseWorkspace(value.id); }); }}>
              <label>New workspace<input value={workspaceName} maxLength={120} onChange={(event) => setWorkspaceName(event.target.value)} /></label><button disabled={disabled || !workspaceName.trim()}>Create workspace</button>
            </form>
          </div>
          {workspace && <>
            <label>Import a card<input type="file" accept=".json,.png,.charx" disabled={disabled} onChange={(event) => {
              const file = event.target.files?.[0]; event.target.value = '';
              if (file) changing(async () => { const value = await api.import(workspace, file); await loadLibrary(workspace); open(value); });
            }} /></label>
            <p className="hub-muted">JSON, PNG or CharX · up to 32 MiB. Your library and edits stay private until you publish them.</p>
            <button disabled={disabled} onClick={() => { void run(() => loadLibrary(workspace)); }}>Refresh library</button>
            {!library.length && <p>Your workspace is empty.</p>}
            <ul className="hub-list">{library.map((value) => <li key={value.card.id}>
              <label><input type="checkbox" checked={selected.some((item) => item.revision.id === value.revision.id)} disabled={disabled || review} onChange={(event) => {
                const checked = event.target.checked;
                setSelected((old) => checked ? [...old, value] : old.filter((item) => item.revision.id !== value.revision.id));
              }} />Select {title(value.revision.document)} · revision {value.revision.sequence}</label>
              <button disabled={disabled} onClick={() => changing(async () => open(await api.open(workspace, value.card.id)))}>Edit {title(value.revision.document)}</button>
            </li>)}</ul>
            {moreLibrary && <button disabled={disabled} onClick={() => { void run(() => loadLibrary(workspace, true)); }}>More library cards</button>}
            <button disabled={disabled || !selected.length || selected.length > 20 || review} onClick={() => setReview(true)}>Review {selected.length} selected</button>
          </>}
        </section>
        {workspace && <ArchiveBrowser key={workspace} host={api.archive} workspace={workspace} disabled={disabled}
          onBusy={setBusy} onError={failure} onImported={async (result) => {
            await loadLibrary(workspace);
            const first = result.imported[0];
            if (!pane && first) open(await api.open(workspace, first.card.id));
            setMessage(`Imported ${result.imported.length} Archive copies. ${pane ? 'Your open draft is unchanged; open an imported card from the library.' : 'Edit and publish a saved revision when ready.'}`);
          }} />}
        {workspace && session && <RemoteHubs key={`${session.actor.id}:${workspace}`} actorId={session.actor.id} workspaceId={workspace}
          library={library} disabled={disabled || locked} onBusy={(value) => { setBusy(value); if (value) setError(''); }} onError={failure} onPulled={async () => {
            await loadLibrary(workspace);
          }} />}
        {review && <section className="hub-panel" aria-label="Review publication">
          <h2>Publish selected revisions</h2><p>Only these saved revisions will be shared. Unsaved drafts and future edits stay private.</p>
          <ul>{selected.map((value) => <li key={value.revision.id}>{title(value.revision.document)} · revision {value.revision.sequence}</li>)}</ul>
          <label>Who can read<select value={policy.visibility} disabled={disabled} onChange={(event) => setPolicy({ ...policy, visibility: event.target.value as PublicationPolicy['visibility'] })}>
            <option value="private">Only me</option><option value="members">Hub members</option><option value="public">Public when enabled by the host</option>
          </select></label>
          <label><input type="checkbox" disabled={disabled} checked={policy.allowFork} onChange={(event) => setPolicy({ ...policy, allowFork: event.target.checked })} />Allow forks</label>
          <label><input type="checkbox" disabled={disabled} checked={policy.allowOriginal} onChange={(event) => setPolicy({ ...policy, allowOriginal: event.target.checked })} />Allow original-file downloads</label>
          <p className="hub-muted">An original file can include local metadata removed from the published card. Enable downloads only after reviewing that file.</p>
          <div className="hub-row"><button disabled={disabled} onClick={() => { void run(async () => {
            const result = await api.publish(workspace, selected.map((value) => value.revision.id), policy);
            setSelected([]); setReview(false); setMessage(`Published ${result.publications.length} revisions.`); await loadPublications(false, ''); setParent('');
          }); }}>Publish selected revisions</button><button disabled={disabled} onClick={() => setReview(false)}>Cancel publication</button></div>
        </section>}
        {pane && <section className="hub-panel" aria-label="Character editor"><div className="hub-row"><h2>Character editor</h2>
          <button disabled={disabled} onClick={() => changing(async () => { setPane(null); })}>Close editor</button></div>
          <fieldset className="hub-editor" disabled={busy || locked}><CardEditor editor={pane.editor} /><ExportControls disabled={disabled} onBusy={setBusy} onError={failure}
            download={(format) => api.export(pane.card.card.workspaceId, pane.card.card.id, pane.editor.getSnapshot().revisionId, format)} /></fieldset>
        </section>}
        <section className="hub-panel" aria-label="Published characters">
          <div className="hub-row"><h2>{parent ? 'Published forks' : 'Published characters'}</h2><button disabled={disabled} onClick={() => { void run(() => loadPublications()); }}>Refresh publications</button>
            {parent && <button disabled={disabled} onClick={() => { void run(async () => { await loadPublications(false, ''); setParent(''); }); }}>All publications</button>}</div>
          {!publications.length && <p>No publications are visible here yet.</p>}
          <ul className="hub-publications">{publications.map((value) => <li key={value.id}>
            <h3>{title(value.document)}</h3><p className="hub-muted">{value.visibility} · {value.parentId ? 'Fork' : 'Original publication'}</p>
            <div className="hub-row"><button disabled={disabled || !workspace || (!value.allowFork && value.ownerId !== session?.actor.id)} onClick={() => changing(async () => {
              const fork = await api.fork(value.id, workspace); await loadLibrary(workspace); open(fork); setMessage('Fork copied to your workspace. Edit and publish it when ready.');
            })}>Fork {title(value.document)}</button>
              <button disabled={disabled} onClick={() => { void run(async () => { await loadPublications(false, value.id); setParent(value.id); }); }}>View forks of {title(value.document)}</button>
              <button disabled={disabled} onClick={() => { void run(() => loadLineage(value.id)); }}>View lineage of {title(value.document)}</button>
              {(value.allowOriginal || value.ownerId === session?.actor.id) && <a href={`/api/hub/publications/${encodeURIComponent(value.id)}/original`}>Download original</a>}
              {value.ownerId === session?.actor.id && value.visibility !== 'private' && <button disabled={disabled} onClick={() => { void run(async () => {
                await api.policy(value.id, value.policyVersion, { ...value, visibility: 'private' }); setGraph(null); await loadPublications();
              }); }}>Make {title(value.document)} private</button>}
            </div>
          </li>)}</ul>
          {morePublications && <button disabled={disabled} onClick={() => { void run(() => loadPublications(true)); }}>More publications</button>}
          {!workspace && <p className="hub-muted">Choose or create a workspace to keep your forks.</p>}
        </section>
        {graph && <LineageGraph graph={graph} busy={disabled}
          onMore={() => { void run(() => loadLineage(graph.anchorId, true)); }}
          onRefresh={() => { void run(() => loadLineage(graph.anchorId)); }} onClose={() => setGraph(null)} />}
      </div>
      {discardAction && <dialog ref={dialog} className="hub-panel" role="alertdialog" aria-label="Discard unsaved changes?" onCancel={() => setDiscardAction(null)}>
        <h2>Discard unsaved changes?</h2><p>Your saved revisions will remain. The open draft has changes that have not been saved.</p>
        <button disabled={disabled} onClick={() => { const action = discardAction; setDiscardAction(null); pane?.editor.discard(); void run(action); }}>Discard and continue</button>
        <button onClick={() => setDiscardAction(null)}>Keep editing</button>
      </dialog>}
    </main>
  </div>;
}
