import { useEffect, useRef, useState } from 'react';
import type { EditorController, EditorState } from './controller.js';
import { descriptors, initialAssetPlan, rasterTypes } from './assets.js';
import type { AssetEdit, EditorAssetBinding, EditorAssetPort, EditorAssetSnapshot } from './assets.js';

function Portrait({ port, revisionId, source, file }: { port: EditorAssetPort; revisionId: string; source: EditorAssetBinding['source']; file?: Blob }) {
  const [preview, setPreview] = useState<{ url: string; key: string; file: Blob | undefined } | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify(source);
  const path = source.kind === 'existing' ? source.path : '';
  useEffect(() => {
    const abort = new AbortController(); let url: string | undefined;
    void (async () => {
      try {
        const blob = file ?? await port.read(revisionId, path, abort.signal);
        if (abort.signal.aborted) return;
        if (!rasterTypes.includes(blob.type)) throw new Error('This portrait has no supported image preview. Its bytes remain unchanged.');
        url = URL.createObjectURL(blob); setPreview({ url, key, file }); setError('');
      } catch (failure) { if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : 'Portrait preview failed.'); }
    })();
    return () => { abort.abort(); if (url) URL.revokeObjectURL(url); };
  }, [port, revisionId, key, path, file, attempt]);
  return <>{preview?.key === key && preview.file === file && <img className="editor-portrait" alt="Draft portrait" src={preview.url} onError={() => setError('This file could not be decoded as an image. Its bytes remain unchanged.')} />}
    {error && <><p className="editor-help">{error}</p><button onClick={() => setAttempt((value) => value + 1)}>Retry portrait preview</button></>}</>;
}

export function AssetEditor({ editor, state }: { editor: EditorController; state: EditorState }) {
  const port = editor.assets!;
  const [snapshot, setSnapshot] = useState<EditorAssetSnapshot | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [pendingRemoval, setConfirmation] = useState<{ edit: AssetEdit; document: EditorState['document']; plan: EditorState['assetPlan'] } | null>(null);
  const [downloading, setDownloading] = useState(false);
  const downloads = useRef(new AbortController());
  useEffect(() => {
    const abort = new AbortController(); downloads.current = abort;
    return () => abort.abort();
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    void port.list(state.revisionId, abort.signal).then((value) => {
      if (!abort.signal.aborted) { setSnapshot(structuredClone(value)); setError(''); }
    }).catch((failure: unknown) => { if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : 'Asset list failed.'); });
    return () => abort.abort();
  }, [port, state.revisionId, attempt]);
  const items = descriptors(state.document);
  const ready = snapshot?.revisionId === state.revisionId;
  const plan = state.assetPlan ?? (ready ? initialAssetPlan(snapshot) : null);
  const disabled = state.status === 'saving' || !ready || !items;
  const portrait = plan?.bindings.find((binding) => binding.path === 'portrait')?.source;
  const confirmation = pendingRemoval?.document === state.document && pendingRemoval.plan === state.assetPlan ? pendingRemoval.edit : null;
  function confirm(edit: AssetEdit) { setConfirmation({ edit, document: state.document, plan: state.assetPlan }); }
  function edit(action: AssetEdit) {
    if (!snapshot) return;
    try { editor.editAssets(snapshot, action); setError(''); setConfirmation(null); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Asset edit failed.'); }
  }
  async function download(path: string, filename: string) {
    const source = plan?.bindings.find((binding) => binding.path === path)?.source;
    if (!source || !plan) return;
    setDownloading(true); setError('');
    try {
      const blob = source.kind === 'upload' ? plan.files[source.index]! : await port.read(state.revisionId, source.path, downloads.current.signal);
      if (downloads.current.signal.aborted) return;
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = filename; link.click();
      // Give the browser its download task before releasing the temporary URL.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) { if (!downloads.current.signal.aborted) setError(failure instanceof Error ? failure.message : 'Asset download failed.'); }
    finally { if (!downloads.current.signal.aborted) setDownloading(false); }
  }
  return <div className="editor-assets">
    <p className="editor-help">Asset changes stay in this draft until you save a revision. Uploaded files keep their exact bytes.</p>
    {error && <p role="alert" className="editor-error">{error}</p>}
    {!ready && <><p>Loading saved assets…</p><button onClick={() => setAttempt((value) => value + 1)}>Retry asset list</button></>}
    {ready && !items && <p>This form cannot edit these asset descriptors. They will be preserved.</p>}
    <fieldset className="editor-field editor-asset-card" disabled={disabled}>
      <legend>Portrait</legend>
      {portrait ? <><Portrait port={port} revisionId={state.revisionId} source={portrait} {...(portrait.kind === 'upload' ? { file: plan!.files[portrait.index]! } : {})} />
        <div className="editor-inline"><button disabled={downloading} onClick={() => { void download('portrait', 'portrait'); }}>Download portrait</button>
          <button onClick={() => confirm({ kind: 'remove-portrait' })}>Remove portrait</button></div></> : <p>No portrait in this draft.</p>}
      <label>Choose portrait<input type="file" accept={rasterTypes.join(',')} onChange={(event) => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) edit({ kind: 'portrait', file });
      }} /></label>
    </fieldset>
    {confirmation && <div className="editor-confirm"><p>{confirmation.kind === 'remove-portrait'
      ? 'Remove the portrait and its linked asset descriptors from this draft? Earlier revisions keep their bytes.'
      : 'Remove this attachment from the draft? Earlier revisions keep its bytes.'}</p>
      <button disabled={disabled} onClick={() => edit(confirmation)}>Confirm removal</button><button onClick={() => setConfirmation(null)}>Keep asset</button></div>}
    {items?.map((item, index) => <fieldset className="editor-field editor-asset-card" key={index} disabled={disabled}>
      <legend>Attachment {index + 1}</legend>
      {(['name', 'type'] as const).map((field) => typeof item[field] === 'string' || item[field] === undefined
        ? <label key={field}>{field === 'name' ? 'Asset name' : 'Asset type'}<input maxLength={1024} value={String(item[field] ?? '')} onChange={(event) => edit({ kind: 'metadata', index, field, value: event.target.value })} /></label>
        : <p key={field}>{field} has an unsupported value and will be preserved.</p>)}
      <p className="editor-help">{String(item.ext ?? 'Unknown extension')} · {String(item.uri)}</p>
      <label>Replace attachment {index + 1}<input type="file" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) edit({ kind: 'replace', index, file }); }} /></label>
      <div className="editor-inline">
        <button disabled={downloading} onClick={() => { void download(`declared/${index}`, `${String(item.name ?? 'attachment')}.${String(item.ext ?? 'bin')}`); }}>Download attachment {index + 1}</button>
        <button onClick={() => confirm({ kind: 'remove', index })}>Remove attachment {index + 1}</button>
        <button disabled={index === 0} onClick={() => edit({ kind: 'move', index, delta: -1 })}>Move attachment {index + 1} up</button>
        <button disabled={index === items.length - 1} onClick={() => edit({ kind: 'move', index, delta: 1 })}>Move attachment {index + 1} down</button>
      </div>
    </fieldset>)}
    {state.document.spec === 'chara_card_v3' && <fieldset className="editor-field" disabled={disabled}>
      <label>Add attachment<input type="file" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) edit({ kind: 'add', file }); }} /></label>
    </fieldset>}
  </div>;
}
