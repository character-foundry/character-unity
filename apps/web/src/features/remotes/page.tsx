import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { CardSummary } from '@character-unity/cards';
import { AppShell } from '@/components/layout';
import { useLibraryClient } from '@/lib/library-client';
import { remoteListingPolicy } from '@/lib/sync-policy';
import { createRemotesClient, type RemoteDescriptor, type RemotesClient, type ReturnJobView, type SyncReadPublication } from './client';
import { clearPreparation, createPreparation, loadPreparation, type ReturnPreparation } from './intent';
import { RevisionPicker } from '../sharing/revision-picker';
import './remotes.css';

type SelectedCard = Pick<CardSummary, 'id' | 'headRevisionId' | 'name' | 'revisionCount' | 'reference'>;
type ReturnReview = Awaited<ReturnType<RemotesClient['review']>>;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'The remote request failed.';
function field(document: Record<string, unknown>, name: string): string {
  const data = document.data && typeof document.data === 'object' && !Array.isArray(document.data)
    ? document.data as Record<string, unknown> : document;
  return typeof data[name] === 'string' ? data[name] as string : '';
}
const title = (document: Record<string, unknown>) => field(document, 'name') || 'Untitled character';
const jobState = (job: ReturnJobView) => job.state === 'prepared' ? 'Ready to send' : job.state === 'uncertain' ? 'Outcome uncertain' : 'Acknowledged';

export default function RemotesPage() {
  const library = useLibraryClient();
  const client = useMemo(() => createRemotesClient(library), [library]);
  return <AppShell><RemotesContent key={client.scopeKey} client={client} /></AppShell>;
}

function RemotesContent({ client }: { client: RemotesClient }) {
  const navigate = useNavigate();
  const connectionSelectId = useId(), revisionSelectId = useId();
  const lifecycle = useRef<AbortController | null>(null);
  const reviewPanel = useRef<HTMLElement | null>(null);
  const running = useRef(false);
  const [connections, setConnections] = useState<RemoteDescriptor[] | null>(null);
  const [connectionId, setConnectionId] = useState('');
  const [publications, setPublications] = useState<SyncReadPublication[]>([]);
  const [nextPublication, setNextPublication] = useState<string | null>(null);
  const [browsed, setBrowsed] = useState(false);
  const [jobs, setJobs] = useState<ReturnJobView[] | null>(null);
  const [nextJob, setNextJob] = useState<string | null>(null);
  const [library, setLibrary] = useState<CardSummary[]>([]);
  const [libraryTotal, setLibraryTotal] = useState<number | null>(null);
  const [libraryOffset, setLibraryOffset] = useState(0);
  const [selected, setSelected] = useState<SelectedCard | null>(null);
  const [chooseRevision, setChooseRevision] = useState(false);
  const [pending, setPending] = useState<ReturnPreparation | null>(null);
  const [preparationError, setPreparationError] = useState<string | null>(null);
  const [review, setReview] = useState<ReturnReview | null>(null);
  const [unknownReturn, setUnknownReturn] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  async function refresh(signal: AbortSignal) {
    const [configured, returns, cards] = await Promise.all([client.connections(signal), client.jobs('', signal), client.library(0, signal)]);
    signal.throwIfAborted();
    setConnections(configured); setJobs(returns.jobs); setNextJob(returns.nextAfter);
    setLibrary(cards.cards); setLibraryTotal(cards.total); setLibraryOffset(cards.cards.length);
  }

  useEffect(() => {
    const controller = new AbortController(); lifecycle.current = controller;
    try {
      const value = loadPreparation(localStorage, client.actorId, client.workspaceId);
      setPending(value);
      if (value) setConnectionId(value.connectionId);
    } catch (failure) { setPreparationError(errorMessage(failure)); }
    void refresh(controller.signal).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => { controller.abort(); };
  }, [client]);

  useEffect(() => {
    if (review) {
      reviewPanel.current?.focus({ preventScroll: true });
      reviewPanel.current?.scrollIntoView({ block: 'start' });
    }
  }, [review?.job.requestId]);

  function run(action: (signal: AbortSignal) => Promise<void>) {
    const signal = lifecycle.current?.signal;
    if (!signal || signal.aborted || running.current) return;
    running.current = true; setBusy(true); setError(null); setMessage('');
    void Promise.resolve().then(() => { signal.throwIfAborted(); return action(signal); }).catch((failure: unknown) => {
      if (!signal.aborted) setError(errorMessage(failure));
    }).finally(() => {
      running.current = false;
      if (!signal.aborted) setBusy(false);
    });
  }
  function remember(job: ReturnJobView) {
    setJobs((old) => [job, ...(old ?? []).filter((value) => value.requestId !== job.requestId)]);
  }
  async function reviewJob(id: string, signal: AbortSignal) {
    const value = await client.review(id, signal);
    signal.throwIfAborted(); remember(value.job); setReview(value);
  }
  async function prepare(value: ReturnPreparation, signal: AbortSignal) {
    // The client persists intent before dispatch. Keep it visible on any unconfirmed outcome.
    setPending(value);
    const job = await client.prepare(localStorage, value, signal);
    signal.throwIfAborted(); setPending(null); remember(job);
    await reviewJob(job.requestId, signal);
    setMessage('Return prepared. Review this exact saved revision before sending.');
  }
  function dismissPreparation() {
    try {
      clearPreparation(localStorage, client.actorId, client.workspaceId);
      setPending(null); setPreparationError(null);
    } catch (failure) { setError(errorMessage(failure)); }
  }
  const connection = connections?.find((value) => value.id === connectionId);
  const savedOptions: SelectedCard[] = selected && !library.some((card) => card.headRevisionId === selected.headRevisionId)
    ? [selected, ...library] : library;

  return <div className="remote-page">
    <header className="remote-page-heading">
      <div><p className="remote-eyebrow">Sharing</p><h1>Connected hubs</h1><p>Browse configured hubs, pull a private fork, and return a saved revision.</p></div>
      <button type="button" disabled={busy} onClick={() => run(refresh)}>Refresh connections and returns</button>
    </header>
    {error && <p className="remote-notice remote-error" role="alert">{error}</p>}
    {message && <p className="remote-notice" role="status">{message}</p>}
    {busy && connections === null && <p role="status" className="remote-muted">Loading connected hubs…</p>}

    {(pending || preparationError) && <section className="remote-panel remote-pending" aria-label="Pending preparation">
      <h2>Preparation not confirmed</h2>
      <p>{pending ? `${pending.title} · revision ${pending.sequence}. Recover the same operation before preparing another return.` : preparationError}</p>
      <div className="remote-actions">
        {pending && <button type="button" disabled={busy || !!preparationError} onClick={() => run((signal) => prepare(pending, signal))}>Retry preparation</button>}
        <button type="button" disabled={busy} onClick={dismissPreparation}>Dismiss preparation</button>
      </div>
      <p className="remote-muted">Dismissal only clears this browser notice. A return already saved on the server remains below.</p>
    </section>}

    <div className="remote-columns">
      <section className="remote-panel" aria-labelledby="remote-browse-title">
        <div className="remote-section-heading"><div><p className="remote-eyebrow">Discover</p><h2 id="remote-browse-title">Remote publications</h2></div></div>
        <p className="remote-muted">Connections are configured by your operator. This page never accepts signing keys or destination URLs.</p>
        <p className="remote-notice">{remoteListingPolicy}</p>
        {connections?.length === 0 && <div className="remote-empty"><h3>No connected hubs</h3><p>Ask your operator to configure a connection for this account.</p></div>}
        {!!connections?.length && <>
          <label htmlFor={connectionSelectId}>Connected hub</label>
          <select id={connectionSelectId} value={connectionId} disabled={busy || !!pending} onChange={(event) => {
            setConnectionId(event.target.value); setPublications([]); setNextPublication(null); setBrowsed(false); setReview(null);
          }}><option value="">Choose a connected hub</option>{connections.map((value) => <option key={value.id} value={value.id}>{value.name}</option>)}</select>
          {connection && <p className="remote-destination">{connection.baseUrl}</p>}
          <button type="button" disabled={busy || !connection} onClick={() => run(async (signal) => {
            const page = await client.publications(connectionId, '', signal); signal.throwIfAborted();
            setPublications(page.publications); setNextPublication(page.nextAfter); setBrowsed(true);
          })}>Browse remote publications</button>
          {browsed && publications.length === 0 && <p className="remote-empty">No compatible publications are visible through this connection.</p>}
          <ul className="remote-items">{publications.map((value) => <li key={value.id}>
            <div className="remote-item-heading"><h3>{title(value.document)}</h3><span className="remote-pill">{value.policy.allowFork ? 'Forks allowed' : 'Read-only'}</span></div>
            {field(value.document, 'description') && <p className="remote-excerpt">{field(value.document, 'description')}</p>}
            <button type="button" disabled={busy || !value.policy.allowFork} onClick={() => run(async (signal) => {
              const pulled = await client.pull(connectionId, value.id, signal); signal.throwIfAborted();
              navigate(`/card/${encodeURIComponent(pulled.card.id)}/edit`);
            })}>Pull fork of {title(value.document)}</button>
            {!value.policy.allowFork && <p className="remote-muted">This publication does not permit forks.</p>}
          </li>)}</ul>
          {nextPublication && <button type="button" disabled={busy} onClick={() => run(async (signal) => {
            const page = await client.publications(connectionId, nextPublication, signal); signal.throwIfAborted();
            setPublications((old) => [...old, ...page.publications.filter((value) => !old.some((item) => item.id === value.id))]); setNextPublication(page.nextAfter);
          })}>More remote publications</button>}
        </>}
      </section>

      <section className="remote-panel" aria-labelledby="remote-prepare-title">
        <p className="remote-eyebrow">Return a fork</p><h2 id="remote-prepare-title">Prepare a saved revision</h2>
        <p className="remote-muted">Choose a saved fork pulled from the selected hub. Preparation does not send it. Unsaved changes stay in your editor.</p>
        <label htmlFor={revisionSelectId}>Saved revision to return</label>
        <select id={revisionSelectId} value={selected?.headRevisionId ?? ''} disabled={busy || !!pending || !!preparationError} onChange={(event) => {
          const card = savedOptions.find((value) => value.headRevisionId === event.target.value);
          setSelected(card ? { ...card } : null); setReview(null);
        }}><option value="">Choose a saved revision</option>{savedOptions.map((value) => <option key={`${value.id}:${value.headRevisionId}`} value={value.headRevisionId} disabled={!!value.reference}>
          {value.name} · {value.reference ? 'Archive reference (read-only)' : `revision ${value.revisionCount}`}
        </option>)}</select>
        <p className="remote-muted">Archive references are read-only links, not returnable remote drafts.</p>
        {libraryTotal !== null && libraryOffset < libraryTotal && <button type="button" disabled={busy} onClick={() => run(async (signal) => {
          const page = await client.library(libraryOffset, signal); signal.throwIfAborted();
          setLibrary((old) => [...old, ...page.cards.filter((card) => !old.some((value) => value.id === card.id && value.headRevisionId === card.headRevisionId))]);
          setLibraryOffset((offset) => offset + page.cards.length); setLibraryTotal(page.total);
        })}>More saved cards</button>}
        {selected && <><p className="remote-destination">Pinned revision: <code>{selected.headRevisionId}</code></p>
          <button type="button" disabled={busy || !!pending || !!preparationError || !!selected.reference} onClick={() => setChooseRevision(true)}>Choose another saved revision</button></>}
        <button type="button" className="remote-primary" disabled={busy || !connection || !selected || !!pending || !!preparationError} onClick={() => {
          if (selected) run((signal) => prepare(createPreparation(client, connectionId, selected), signal));
        }}>Prepare return</button>
        <p className="remote-muted">To share a local card rather than return a remote fork, use <Link to="/sharing">publications</Link>.</p>
      </section>
    </div>

    <section className="remote-panel" aria-labelledby="remote-returns-title">
      <p className="remote-eyebrow">Durable outbox</p><h2 id="remote-returns-title">Saved returns</h2>
      <p className="remote-muted">Sending is always explicit. Retrying reuses the saved operation and exact bytes; it never creates a replacement draft.</p>
      {jobs?.length === 0 && <p className="remote-empty">No returns are queued in this workspace.</p>}
      <ul className="remote-items remote-jobs">{jobs?.map((job) => <li key={job.requestId}>
        <div><h3>{job.title} · revision {job.sequence}</h3><p className="remote-muted">{job.destination}</p></div>
        <span className={`remote-pill ${job.state === 'uncertain' || unknownReturn === job.requestId ? 'remote-pill-warning' : ''}`}>{unknownReturn === job.requestId && !job.receipt ? 'Outcome unconfirmed' : jobState(job)}</span>
        <button type="button" disabled={busy} onClick={() => run((signal) => reviewJob(job.requestId, signal))}>Review return {job.title} · revision {job.sequence}</button>
      </li>)}</ul>
      {nextJob && <button type="button" disabled={busy} onClick={() => run(async (signal) => {
        const page = await client.jobs(nextJob, signal); signal.throwIfAborted();
        setJobs((old) => [...(old ?? []), ...page.jobs.filter((job) => !old?.some((value) => value.requestId === job.requestId))]); setNextJob(page.nextAfter);
      })}>More saved returns</button>}
    </section>

    {review && <section ref={reviewPanel} tabIndex={-1} className="remote-panel remote-review" aria-label="Review remote return">
      <div className="remote-section-heading"><div><p className="remote-eyebrow">Review before sending</p><h2>{review.job.title} · revision {review.job.sequence}</h2></div>
        <button type="button" disabled={busy} onClick={() => setReview(null)}>Close return review</button></div>
      <p>Destination: <strong>{review.job.destination}</strong></p><p className="remote-destination">{review.job.baseUrl}</p>
      <div className="remote-review-facts"><span className="remote-pill">{jobState(review.job)}</span><span>{(review.job.byteLength / 1024).toFixed(1)} KiB</span><span>{review.revision.assets.length} attached {review.revision.assets.length === 1 ? 'asset' : 'assets'}</span></div>
      <p className="remote-muted">Only this saved revision is sent as a private draft. Later edits and unsaved changes are excluded. Publication is a separate action on the receiving hub.</p>
      <dl>{[['description', 'Description'], ['scenario', 'Scenario'], ['first_mes', 'First message']].map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{field(review.revision.document, key) || '—'}</dd></div>)}</dl>
      <p className="remote-destination">Saved revision: <code>{review.job.revisionId}</code><br />Operation: <code>{review.job.requestId}</code><br />Frame hash: <code>{review.job.frameHash}</code></p>
      {(review.job.state === 'uncertain' || unknownReturn === review.job.requestId) && !review.job.receipt && <p className="remote-notice">The hub may already have accepted this return. Retry only this saved operation to recover its receipt.</p>}
      {review.job.receipt ? <p role="status" className="remote-notice">Private draft acknowledged. Remote card: <code>{review.job.receipt.cardId}</code>. Remote revision: <code>{review.job.receipt.revisionId}</code>.</p>
        : <button type="button" className="remote-primary" disabled={busy || !review.job.connectionId} onClick={() => {
          const current = review;
          run(async (signal) => {
            try {
              const job = await client.send(current.job.requestId, signal); signal.throwIfAborted();
              remember(job); setReview({ ...current, job }); setUnknownReturn(null);
              setMessage('Remote hub acknowledged the private draft. Publish it there when ready.');
            } catch (failure) {
              signal.throwIfAborted(); setUnknownReturn(current.job.requestId);
              try {
                const job = await client.job(current.job.requestId, signal); signal.throwIfAborted();
                remember(job); setReview({ ...current, job });
                if (job.receipt) {
                  setUnknownReturn(null); setMessage('The remote acknowledgment was recovered for this saved return.');
                  return;
                }
              } catch (refreshFailure) {
                signal.throwIfAborted();
                throw new Error(`${errorMessage(failure)} Return status could not be refreshed: ${errorMessage(refreshFailure)}`, { cause: refreshFailure });
              }
              throw failure;
            }
          });
        }}>{review.job.state === 'uncertain' || unknownReturn === review.job.requestId ? 'Retry saved return' : 'Send saved return'}</button>}
      {!review.job.connectionId && <p className="remote-muted">This configured connection is unavailable. Ask your operator to restore it before retrying.</p>}
    </section>}
    {chooseRevision && selected && <RevisionPicker client={client} card={selected} onClose={() => setChooseRevision(false)} onChoose={(revision) => {
      setSelected({ ...selected, headRevisionId: revision.id, revisionCount: revision.sequence }); setReview(null); setChooseRevision(false);
    }} />}
  </div>;
}
