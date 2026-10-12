import { useEffect, useId, useState } from 'react';
import { createSyncToken } from '@character-foundry/character-foundry/sync';
import type { SyncReadPublication } from '@character-foundry/character-foundry/sync';
import type { RemoteDescriptor, ReturnJobView } from '@character-unity/cards/connections';
import type { Revision } from '@character-unity/store';
import { api } from './api.js';
import type { OpenCard } from './api.js';

function field(document: Record<string, unknown>, name: string) {
  const data = document.data && typeof document.data === 'object' && !Array.isArray(document.data) ? document.data as Record<string, unknown> : document;
  return typeof data[name] === 'string' ? data[name] as string : '';
}
const title = (document: Record<string, unknown>) => field(document, 'name') || 'Untitled character';
interface Preparation { connectionId: string; cardId: string; revisionId: string; requestId: string; title: string; sequence: number }
function pendingPreparation(key: string): Preparation | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (Object.keys(item).length !== 6 || ['connectionId', 'cardId', 'revisionId', 'requestId', 'title'].some((key) => typeof item[key] !== 'string' || !(item[key] as string).length || (item[key] as string).length > 1024)
      || !/^[A-Za-z0-9_-]{43}$/.test(item.requestId as string) || !Number.isSafeInteger(item.sequence) || Number(item.sequence) < 1) return null;
    return item as unknown as Preparation;
  } catch { return null; }
}

export function RemoteHubs({ actorId, workspaceId, library, disabled, onBusy, onError, onPulled }: {
  actorId: string; workspaceId: string; library: OpenCard[]; disabled: boolean;
  onBusy(value: boolean): void; onError(error: unknown): void; onPulled(card: OpenCard): Promise<void>;
}) {
  const storageKey = `unity:return-preparation:v1:${actorId}:${workspaceId}`;
  const connectionSelectId = useId(), revisionSelectId = useId();
  const [connections, setConnections] = useState<RemoteDescriptor[]>([]), [connectionId, setConnectionId] = useState('');
  const [publications, setPublications] = useState<SyncReadPublication[]>([]), [nextPublication, setNextPublication] = useState<string | null>(null);
  const [browsed, setBrowsed] = useState(false), [loading, setLoading] = useState(true);
  const [jobs, setJobs] = useState<ReturnJobView[]>([]), [nextJob, setNextJob] = useState<string | null>(null);
  const [selected, setSelected] = useState<OpenCard | null>(null);
  const [pending, setPending] = useState<Preparation | null>(() => pendingPreparation(storageKey));
  const [review, setReview] = useState<{ job: ReturnJobView; revision: Revision } | null>(null);
  const [message, setMessage] = useState('');
  const busy = loading || disabled;
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([api.remotes.connections(controller.signal), api.remotes.jobs(workspaceId, '', controller.signal)])
      .then(([connections, page]) => { if (!controller.signal.aborted) {
        setConnections(connections); setJobs(page.jobs); setNextJob(page.nextAfter);
      } }).catch((error) => { if (!controller.signal.aborted) onError(error); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [workspaceId, actorId]);
  async function run(action: () => Promise<void>) {
    setLoading(true); onBusy(true); setMessage('');
    try { await action(); } catch (error) { onError(error); } finally { setLoading(false); onBusy(false); }
  }
  function remember(job: ReturnJobView) { setJobs((old) => [job, ...old.filter((value) => value.requestId !== job.requestId)]); }
  async function reviewJob(job: ReturnJobView) {
    const current = await api.remotes.job(workspaceId, job.requestId);
    const revision = await api.revision(workspaceId, current.cardId, current.revisionId);
    remember(current); setReview({ job: current, revision });
  }
  async function prepare(value: Preparation) {
    const job = await api.remotes.enqueue(workspaceId, value.connectionId, value.cardId, value.revisionId, value.requestId);
    sessionStorage.removeItem(storageKey); setPending(null); remember(job);
    await reviewJob(job); setMessage('Return prepared. Review this saved revision before sending it.');
  }
  const savedOptions = selected && !library.some((item) => item.revision.id === selected.revision.id) ? [selected, ...library] : library;
  const state = (job: ReturnJobView) => job.state === 'prepared' ? 'Ready to send' : job.state === 'uncertain' ? 'Outcome uncertain' : 'Acknowledged';
  return <section className="hub-panel hub-remotes" aria-label="Remote hubs">
    <div className="hub-row"><h2>Remote hubs</h2><button disabled={busy} onClick={() => { void run(async () => {
      const values = await api.remotes.connections(); setConnections(values);
      const page = await api.remotes.jobs(workspaceId); setJobs(page.jobs); setNextJob(page.nextAfter);
    }); }}>Refresh remote connections and returns</button></div>
    {message && <p role="status">{message}</p>}
    {!connections.length && !loading && <p>No remote hubs are connected to your account. Ask your hub operator to connect one.</p>}
    {!!connections.length && <>
      <label htmlFor={connectionSelectId}>Remote hub</label><select id={connectionSelectId} value={connectionId} disabled={busy || !!pending} onChange={(event) => {
        setConnectionId(event.target.value); setPublications([]); setNextPublication(null); setBrowsed(false); setReview(null);
      }}><option value="">Choose a connected hub</option>{connections.map((value) => <option value={value.id} key={value.id}>{value.name}</option>)}</select>
      {connectionId && <p className="hub-muted">{connections.find((value) => value.id === connectionId)?.baseUrl}</p>}
      <button disabled={busy || !connectionId} onClick={() => { void run(async () => {
        const page = await api.remotes.publications(connectionId, workspaceId); setPublications(page.publications); setNextPublication(page.nextAfter); setBrowsed(true);
      }); }}>Browse remote publications</button>
      {browsed && !publications.length && <p>No publications are visible on this remote hub.</p>}
      <ul className="hub-publications">{publications.map((value) => <li key={value.id}>
        <h3>{title(value.document)}</h3><p>{field(value.document, 'description')}</p>
        <button disabled={busy || !value.policy.allowFork} onClick={() => { void run(async () => {
          const pulled = await api.remotes.pull(connectionId, workspaceId, value.id); await onPulled(pulled);
          setMessage('Fork copied to your private workspace. Open it from the library to edit; any existing draft is unchanged.');
        }); }}>Pull fork of {title(value.document)}</button>
        {!value.policy.allowFork && <p>Forking is not allowed by this publication.</p>}
      </li>)}</ul>
      {nextPublication && <button disabled={busy} onClick={() => { void run(async () => {
        const page = await api.remotes.publications(connectionId, workspaceId, nextPublication); setPublications((old) => [...old, ...page.publications]); setNextPublication(page.nextAfter);
      }); }}>More remote publications</button>}
      <h3>Prepare a return</h3><p>Choose a saved revision of a fork pulled from this hub. Unsaved changes stay in your editor.</p>
      <label htmlFor={revisionSelectId}>Saved revision to return</label><select id={revisionSelectId} disabled={busy || !!pending} value={selected?.revision.id ?? ''} onChange={(event) => {
        setSelected(savedOptions.find((value) => value.revision.id === event.target.value) ?? null); setReview(null);
      }}><option value="">Choose a saved revision</option>{savedOptions.map((value) => <option value={value.revision.id} key={value.revision.id}>{title(value.revision.document)} · revision {value.revision.sequence}</option>)}</select>
      <button disabled={busy || !connectionId || !selected || !!pending} onClick={() => { if (selected) void run(async () => {
        const value = { connectionId, cardId: selected.card.id, revisionId: selected.revision.id, requestId: createSyncToken(), title: title(selected.revision.document).slice(0, 1024), sequence: selected.revision.sequence };
        // Retain intent before dispatch so response loss and reload cannot silently mint a new ID.
        sessionStorage.setItem(storageKey, JSON.stringify(value)); setPending(value); await prepare(value);
      }); }}>Prepare return</button>
    </>}
    {pending && <div role="group" aria-label="Pending preparation"><p>Preparation is not confirmed for {pending.title} · revision {pending.sequence}. Retry to recover the same return.</p>
      <button disabled={busy} onClick={() => { void run(() => prepare(pending)); }}>Retry preparation</button>
      <button disabled={busy} onClick={() => { sessionStorage.removeItem(storageKey); setPending(null); }}>Dismiss preparation</button>
      <p className="hub-muted">Dismissing this notice does not delete a return that may already be saved below.</p>
    </div>}
    <h3>Saved returns</h3>{!jobs.length && !loading && <p>No returns are queued in this workspace.</p>}
    <ul className="hub-publications">{jobs.map((job) => <li key={job.requestId}>
      <h4>{job.title} · revision {job.sequence}</h4><p>{job.destination} · {state(job)}</p>
      <button disabled={busy} onClick={() => { void run(() => reviewJob(job)); }}>Review return {job.title} · revision {job.sequence}</button>
    </li>)}</ul>
    {nextJob && <button disabled={busy} onClick={() => { void run(async () => {
      const page = await api.remotes.jobs(workspaceId, nextJob); setJobs((old) => [...old, ...page.jobs.filter((job) => !old.some((value) => value.requestId === job.requestId))]); setNextJob(page.nextAfter);
    }); }}>More saved returns</button>}
    {review && <section className="hub-panel" aria-label="Review remote return">
      <h3>{review.job.title} · revision {review.job.sequence}</h3>
      <p>Destination: {review.job.destination} ({review.job.baseUrl})</p>
      <p>{state(review.job)} · {(review.job.byteLength / 1024).toFixed(1)} KiB · {review.revision.assets.length} attached {review.revision.assets.length === 1 ? 'asset' : 'assets'}</p>
      <p className="hub-muted">Only this saved revision will be sent as a private draft. Later edits and unsaved changes are excluded. Publication is a separate action on the receiving hub.</p>
      <dl>{[['description', 'Description'], ['scenario', 'Scenario'], ['first_mes', 'First message']].map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{field(review.revision.document, key!) || '—'}</dd></div>)}</dl>
      {review.job.state === 'uncertain' && <p>The remote hub may already have accepted this return. Retrying reuses its saved operation and exact bytes.</p>}
      {review.job.receipt ? <p>Remote draft acknowledged. Card: <code>{review.job.receipt.cardId}</code>. Revision: <code>{review.job.receipt.revisionId}</code>.</p>
        : <button disabled={busy || !review.job.connectionId} onClick={() => { const current = review; void run(async () => {
          try { const job = await api.remotes.send(workspaceId, current.job.requestId); remember(job); setReview({ ...current, job }); setMessage('Remote hub acknowledged the private draft. Publish it there when ready.'); }
          catch (error) {
            try { const job = await api.remotes.job(workspaceId, current.job.requestId); remember(job); setReview({ ...current, job }); }
            catch (refreshError) { onError(refreshError); }
            throw error;
          }
        }); }}>{review.job.state === 'uncertain' ? 'Retry saved return' : 'Send saved return'}</button>}
      {!review.job.connectionId && <p>This connection is unavailable. Ask the operator to restore it before retrying.</p>}
      <button disabled={busy} onClick={() => setReview(null)}>Close return review</button>
    </section>}
  </section>;
}
