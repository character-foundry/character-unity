import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useEditorSession } from '../../unity/context';
import { useCardStore } from '../../store/card-store';
import { useSettingsStore } from '../../store/settings-store';
import { createLocalTools, type ContextSnippet, type TextProposal, type ToolField } from './tools';
import { extractCardData } from '../../lib/card-utils';
import { getFieldById } from '../editor/config/field-definitions';
import { readFieldValue } from '../editor/components/field-value';
import { PreservedField } from '../editor/components/FieldRenderer';

const control = 'w-full rounded-lg border border-dark-border bg-dark-surface px-3 py-2 text-sm';
const button = 'rounded-lg border border-dark-border bg-dark-surface px-3 py-2 text-sm disabled:opacity-40';
const panel = 'rounded-xl border border-dark-border bg-dark-bg p-4 space-y-3';
type Workflow = Awaited<ReturnType<ReturnType<typeof createLocalTools>['workflow']>>;
type ImageProposal = Awaited<ReturnType<Workflow['readImage']>>;

export function LocalToolsSettings() {
  const session = useEditorSession();
  const id = useId();
  const serverUrl = useSettingsStore((state) => state.comfyUI.serverUrl);
  const setServerUrl = useSettingsStore((state) => state.setComfyUIServerUrl);
  if (!session.capabilities.browserLLM) return <p className="text-dark-muted">Local tools are unavailable on an account hub. Browser credentials and local network requests stay disabled.</p>;
  return <div className="space-y-4">
    <h3 className="settings-heading">Local tools</h3>
    <p className="settings-description">Archive context reads the existing Archive and its search index. Optimizer and names use your browser AI provider. Every result is reviewed before it changes a draft; Save is still separate.</p>
    <label htmlFor={id} className="block text-sm">ComfyUI loopback origin</label>
    <input id={id} value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} className={control} placeholder="http://127.0.0.1:8188" />
    <p className="text-sm text-dark-muted">Allow this app’s origin in your local ComfyUI CORS settings. Nothing connects until you explicitly run an uploaded API-format workflow. No Unity credentials are sent to ComfyUI.</p>
    <p className="text-sm text-dark-muted">Full Unity backups are operator-only: use <code>pnpm backup --help</code> on the host. The backup includes the real database and Unity-owned files, not another copy of Archive.</p>
  </div>;
}

export function LocalToolsTab() {
  const session = useEditorSession();
  const currentCard = useCardStore((state) => state.currentCard);
  const selection = useCardStore((state) => state.selectionVersion);
  const tools = useMemo(() => createLocalTools(session), [session]);
  const id = useId();
  const running = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [field, setField] = useState<ToolField>('description'), [guidance, setGuidance] = useState('');
  const [proposal, setProposal] = useState<TextProposal | null>(null);
  const [query, setQuery] = useState(''), [mode, setMode] = useState<'text' | 'hybrid' | 'semantic'>('hybrid');
  const [snippets, setSnippets] = useState<ContextSnippet[]>([]), [included, setIncluded] = useState<string[]>([]), [complete, setComplete] = useState(true);
  const [workflow, setWorkflow] = useState(''), [job, setJob] = useState<Workflow | null>(null);
  const [image, setImage] = useState<ImageProposal | null>(null), [preview, setPreview] = useState('');
  const serverUrl = useSettingsStore((state) => state.comfyUI.serverUrl);

  useEffect(() => {
    setProposal(null); setSnippets([]); setIncluded([]); setJob(null); setImage(null); setError(''); setNotice(''); setBusy(false);
    return () => { running.current?.abort(); running.current = null; };
  }, [session, selection]);
  useEffect(() => {
    if (!image) { setPreview(''); return; }
    const url = URL.createObjectURL(image.file); setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);
  function run(action: (signal: AbortSignal) => Promise<void>) {
    if (running.current || !session.capabilities.browserLLM) return;
    const controller = new AbortController(); running.current = controller; setBusy(true); setError(''); setNotice('');
    const signal = AbortSignal.any([controller.signal, session.liveSignal()]);
    void action(signal).catch((failure: unknown) => {
      if (!signal.aborted && running.current === controller) setError(failure instanceof Error ? failure.message : 'The local tool failed.');
    }).finally(() => {
      if (running.current === controller) { running.current = null; setBusy(false); }
    });
  }
  if (!session.capabilities.browserLLM) return <div className="p-6 text-dark-muted">Local tools are unavailable on an account hub. No browser provider credentials or local network requests are used.</div>;
  if (!currentCard) return <p className="p-6 text-dark-muted">Open a character to use local tools.</p>;
  const definition = getFieldById(field)!;
  const fieldState = readFieldValue(definition, extractCardData(currentCard) as unknown as Record<string, unknown>);
  return <div className="overflow-auto p-4 sm:p-6 space-y-5" aria-label="Local editor tools">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">Local tools</h2>
      <p className="mt-1 text-sm text-dark-muted">Read, generate, review, then apply to this draft. Save remains explicit.</p></div>
      {busy && <button type="button" className={button} onClick={() => {
        running.current?.abort(); running.current = null; setBusy(false); setNotice('Stopped the local request. A queued ComfyUI job may continue on its server; no other job was interrupted.');
      }}>Stop local request</button>}</header>
    {error && <p role="alert" className="rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-200">{error}</p>}
    {notice && <p role="status" className="rounded-lg border border-green-400/20 p-3 text-sm text-green-200">{notice}</p>}
    {busy && <p role="status" className="text-sm text-dark-muted">Working on this editor’s request…</p>}
    <div className="grid gap-5 xl:grid-cols-2">
      <section className={panel} aria-labelledby={`${id}-context-title`}><h3 id={`${id}-context-title`} className="font-semibold">Archive context</h3>
        <p className="text-xs text-dark-muted">Search the existing Archive/Lance index. Select the excerpts you want to send with a generation; nothing is copied into another database.</p>
        <label htmlFor={`${id}-query`} className="block text-sm">Context query</label>
        <input id={`${id}-query`} className={control} value={query} maxLength={500} onChange={(event) => setQuery(event.target.value)} />
        <label htmlFor={`${id}-mode`} className="block text-sm">Retrieval mode</label>
        <select id={`${id}-mode`} className={control} value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
          <option value="hybrid">Hybrid (text + semantic)</option><option value="semantic">Semantic</option><option value="text">Text</option>
        </select>
        <button type="button" className={button} disabled={busy || !query.trim()} onClick={() => run(async (signal) => {
          setSnippets([]); setIncluded([]); setComplete(true);
          const result = await tools.retrieve(query, mode, signal); signal.throwIfAborted();
          setSnippets(result.snippets); setIncluded([]); setComplete(result.complete);
          if (!result.snippets.length) setNotice('No context matched this query.');
        })}>Retrieve context</button>
        {!complete && <p className="text-xs text-amber-200">These results are partial. The Archive reported incomplete or stale search coverage.</p>}
        {snippets.map((value) => <article key={`${value.id}:${value.versionId}`} className="rounded-lg border border-dark-border p-3 space-y-2">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={included.includes(value.id)} onChange={(event) => setIncluded((old) => event.target.checked ? [...old, value.id] : old.filter((item) => item !== value.id))} />Use excerpt from {value.name}</label>
          <p className="break-all text-xs text-dark-muted">Source {value.id} · version {value.versionId}</p><p className="max-h-40 overflow-auto whitespace-pre-wrap text-sm">{value.excerpt || 'No text excerpt available.'}</p>
        </article>)}
      </section>
      <section className={panel} aria-labelledby={`${id}-writing-title`}><h3 id={`${id}-writing-title`} className="font-semibold">Writing & names</h3>
        <p className="text-xs text-dark-muted">Uses Settings → AI → Providers. Only the chosen field, guidance and selected reference excerpts are sent.</p>
        <label htmlFor={`${id}-field`} className="block text-sm">Field to optimize</label>
        <select id={`${id}-field`} className={control} value={field} onChange={(event) => setField(event.target.value as ToolField)}>
          {[['description', 'Description'], ['scenario', 'Scenario'], ['first_mes', 'First message'], ['personality', 'Personality'], ['mes_example', 'Example dialogue']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        {!fieldState.editable && <PreservedField label={definition.label} value={fieldState.value} />}
        <label htmlFor={`${id}-guidance`} className="block text-sm">Generation guidance</label>
        <textarea id={`${id}-guidance`} className={control} rows={3} maxLength={2000} value={guidance} onChange={(event) => setGuidance(event.target.value)} />
        <p className="text-xs text-dark-muted">{included.length} retrieved excerpts selected.</p>
        <div className="flex flex-wrap gap-2">{(['optimize', 'names'] as const).map((kind) => <button key={kind} type="button" className={button} disabled={busy} onClick={() => run(async (signal) => {
          setProposal(null);
          const result = await tools.propose({ kind, field, guidance, context: snippets.filter((value) => included.includes(value.id)) }, signal);
          signal.throwIfAborted(); setProposal(result);
        })}>{kind === 'optimize' ? 'Propose optimized text' : 'Generate names'}</button>)}</div>
        {proposal && <section className="space-y-3 rounded-lg border border-blue-400/30 p-3" aria-label="Review generated text">
          <h4 className="text-sm font-semibold">Review {proposal.field} proposal</h4><details><summary className="text-xs text-dark-muted">Current field at generation</summary><p className="max-h-40 overflow-auto whitespace-pre-wrap text-sm">{proposal.previous || '(empty)'}</p></details>
          {proposal.values.map((value, index) => <div key={index} className="space-y-2"><p className="max-h-60 overflow-auto whitespace-pre-wrap text-sm">{value}</p>
            <button type="button" className={button} disabled={busy} onClick={() => {
              try { proposal.apply(value); setProposal(null); setNotice('Applied to this draft only. Save when you are ready.'); } catch (failure) { setError(failure instanceof Error ? failure.message : 'The proposal could not be applied.'); }
            }}>{proposal.field === 'name' ? `Use name ${value}` : 'Apply reviewed text'}</button></div>)}
          <button type="button" className={button} onClick={() => setProposal(null)}>Discard text proposal</button>
        </section>}
      </section>
    </div>
    <section className={panel} aria-labelledby={`${id}-comfy-title`}><h3 id={`${id}-comfy-title`} className="font-semibold">ComfyUI portrait</h3>
      <p className="text-xs text-dark-muted">Configured origin: {serverUrl || '(not configured)'}. Upload an inspected Export (API) workflow containing SaveImage. The exact workflow runs on that server; it may use GPU resources. No requests happen while idle.</p>
      <label htmlFor={`${id}-workflow`} className="block text-sm">ComfyUI API workflow file</label>
      <input id={`${id}-workflow`} type="file" accept="application/json,.json" className={control} disabled={busy} onChange={(event) => {
        const file = event.target.files?.[0]; if (!file) return;
        run(async (signal) => { if (file.size > 1_048_576) throw new Error('The workflow exceeds 1 MiB.'); const value = await file.text(); signal.throwIfAborted(); setWorkflow(value); setJob(null); setImage(null); setNotice(`Loaded ${file.name}. Review it before running.`); });
      }} />
      {workflow && <details><summary className="text-sm">Review uploaded workflow</summary><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all p-3 text-xs">{workflow}</pre></details>}
      <button type="button" className={button} disabled={busy || !workflow || !serverUrl} onClick={() => run(async (signal) => {
        setJob(null); setImage(null); const result = await tools.workflow({ baseUrl: serverUrl, workflow }, signal); signal.throwIfAborted(); setJob(result);
      })}>Run reviewed workflow</button>
      {job && <div className="space-y-2"><p className="break-all text-xs text-dark-muted">Completed owned job: {job.jobId} · {job.origin}</p>
        <div className="flex flex-wrap gap-2">{job.images.map((value, index) => <button key={index} type="button" className={button} disabled={busy} onClick={() => run(async (signal) => {
          const result = await job.readImage(index, signal); signal.throwIfAborted(); setImage(result);
        })}>Review generated image {index + 1}: {value.filename}</button>)}</div></div>}
      {image && <section className="space-y-3" aria-label="Review generated portrait">
        {preview && <img src={preview} alt="Generated portrait proposal" className="max-h-72 max-w-full rounded-lg object-contain" />}
        <p className="text-xs text-dark-muted">Verified {image.file.type} · {image.file.size.toLocaleString()} bytes. Applying stages a portrait; no server revision is written until Save.</p>
        <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={busy} onClick={() => run(async (signal) => {
          await image.apply(signal); signal.throwIfAborted(); setImage(null); setNotice('Portrait staged in this draft. Save when you are ready.');
        })}>Stage reviewed portrait</button><button type="button" className={button} onClick={() => setImage(null)}>Discard portrait proposal</button></div>
      </section>}
    </section>
    <p className="text-xs text-dark-muted">Backups remain an operator command: <code>pnpm backup --help</code>. No privileged backup or restore endpoint is exposed in the editor.</p>
  </div>;
}
