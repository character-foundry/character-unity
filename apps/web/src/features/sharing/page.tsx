import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { AppShell } from '@/components/layout';
import { Modal } from '@/components/ui/modal';
import { useLibraryClient } from '@/lib/library-client';
import type { CardSummary } from '@/lib/unity';
import { libraryChanged } from '@/lib/library-search';
import { cn } from '@/lib/utils/cn';
import { createSharingClient, defaultPolicy, publicationPageSize, publicationText, publicationTitle, selectRevision } from './client';
import type { Publication, PublicationPolicy, PublishedLineage, ReviewedRevision, SelectedRevision, SharingClient } from './client';
import { PolicyFields } from './policy';
import { PublicationLineage } from './lineage';
import { RevisionPicker } from './revision-picker';

const panel = 'rounded-xl border border-nebula/15 bg-surface-1 p-4 sm:p-5';
const secondary = 'rounded-lg border border-nebula/20 px-3 py-2 text-sm text-starlight/75 transition-colors hover:bg-cosmic-teal disabled:cursor-not-allowed disabled:opacity-40';
const primary = 'rounded-lg bg-nebula px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40';
const errorMessage = (value: unknown) => value instanceof Error ? value.message : 'This request could not be completed.';

export default function SharingPage() {
  const library = useLibraryClient();
  const client = useMemo(() => createSharingClient(library), [library]);
  return <AppShell><SharingContent key={client.scopeKey} client={client} /></AppShell>;
}

function SharingContent({ client }: { client: SharingClient }) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<'published' | 'publish'>('published');
  const [library, setLibrary] = useState<CardSummary[]>([]), [libraryTotal, setLibraryTotal] = useState(0);
  const [libraryOffset, setLibraryOffset] = useState(0);
  const [libraryLoading, setLibraryLoading] = useState(true), [libraryError, setLibraryError] = useState('');
  const [libraryRefresh, setLibraryRefresh] = useState(0);
  const [selected, setSelected] = useState<SelectedRevision[]>([]), [review, setReview] = useState<ReviewedRevision[] | null>(null);
  const [revisionCard, setRevisionCard] = useState<CardSummary | null>(null);
  const [policy, setPolicy] = useState<PublicationPolicy>({ ...defaultPolicy });
  const [publications, setPublications] = useState<Publication[]>([]), [morePublications, setMorePublications] = useState(false);
  const [parentId, setParentId] = useState(''), [publicationRefresh, setPublicationRefresh] = useState(0);
  const [publicationLoading, setPublicationLoading] = useState(true), [publicationError, setPublicationError] = useState('');
  const [detailId, setDetailId] = useState(''), [detail, setDetail] = useState<Publication | null>(null);
  const [detailLoading, setDetailLoading] = useState(false), [detailError, setDetailError] = useState(''), [detailRefresh, setDetailRefresh] = useState(0);
  const [detailPolicy, setDetailPolicy] = useState<PublicationPolicy>({ ...defaultPolicy });
  const [lineage, setLineage] = useState<PublishedLineage | null>(null);
  const [action, setAction] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const operation = useRef<AbortController | null>(null), mounted = useRef(true);
  const busy = !!action;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; operation.current?.abort(); }; }, []);
  useEffect(() => {
    const controller = new AbortController(); setLibraryLoading(true); setLibraryError('');
    void client.library(0, controller.signal).then((page) => { if (!controller.signal.aborted) { setLibrary(page.cards); setLibraryTotal(page.total); setLibraryOffset(page.cards.length); } })
      .catch((failure) => { if (!controller.signal.aborted) setLibraryError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLibraryLoading(false); });
    return () => controller.abort();
  }, [client, libraryRefresh]);
  useEffect(() => {
    const controller = new AbortController(); setPublicationLoading(true); setPublicationError(''); setPublications([]);
    void client.list({ parentId, signal: controller.signal }).then((values) => { if (!controller.signal.aborted) {
      setPublications(values); setMorePublications(values.length === publicationPageSize);
    } }).catch((failure) => { if (!controller.signal.aborted) setPublicationError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setPublicationLoading(false); });
    return () => controller.abort();
  }, [client, parentId, publicationRefresh]);
  useEffect(() => {
    const controller = new AbortController(); setDetail(null); setLineage(null); setDetailError('');
    if (!detailId) { setDetailLoading(false); return () => controller.abort(); }
    setDetailLoading(true);
    void client.detail(detailId, controller.signal).then((value) => { if (!controller.signal.aborted) {
      setDetail(value); setDetailPolicy({ visibility: value.visibility, allowFork: value.allowFork, allowOriginal: value.allowOriginal });
    } }).catch((failure) => { if (!controller.signal.aborted) setDetailError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [client, detailId, detailRefresh]);

  async function run(label: string, task: (signal: AbortSignal) => Promise<void>) {
    if (operation.current) return;
    const controller = new AbortController(); operation.current = controller;
    setAction(label); setError(''); setNotice('');
    try { await task(controller.signal); }
    catch (failure) { if (mounted.current && !controller.signal.aborted) setError(errorMessage(failure)); }
    finally { if (operation.current === controller) { operation.current = null; if (mounted.current) setAction(''); } }
  }
  async function fork(value: Publication, signal: AbortSignal) {
    const result = await client.fork(value.id, signal); signal.throwIfAborted();
    libraryChanged(); navigate(`/card/${encodeURIComponent(result.card.id)}`);
  }
  async function readLineage(value: Publication, append: boolean, signal: AbortSignal) {
    const next = await client.lineage(value.id, { afterId: append ? lineage?.nextAfter ?? undefined : undefined, signal });
    signal.throwIfAborted();
    setLineage((old) => ({ ...next, nodes: append && old?.anchorId === next.anchorId ? [...old.nodes, ...next.nodes] : next.nodes }));
  }
  function select(card: CardSummary, checked: boolean) {
    try { setSelected(selectRevision(selected, card, checked)); setError(''); }
    catch (failure) { setError(errorMessage(failure)); }
  }
  function openDetail(id: string) { setDetailId(id); setDetailRefresh((value) => value + 1); }

  return <div className="mx-auto max-w-6xl space-y-5">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="mb-1 text-[11px] uppercase tracking-[0.18em] text-nebula">Your creative space</p>
        <h1 className="text-2xl font-semibold tracking-tight">Sharing</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-starlight/50">Publish a saved revision. Your library, unsaved drafts and future edits stay private.</p></div>
      <button type="button" className={primary} disabled={busy} onClick={() => setTab('publish')}>Publish saved revisions</button>
    </header>
    <div className="flex gap-1 border-b border-nebula/15" role="tablist" aria-label="Sharing view">
      {[['published', 'Published characters'], ['publish', 'Your saved revisions']].map(([value, label]) => <button type="button" key={value} role="tab" aria-selected={tab === value}
        aria-controls={`sharing-${value}`} id={`sharing-tab-${value}`} disabled={busy} onClick={() => setTab(value as typeof tab)}
        className={cn('border-b-2 px-4 py-3 text-sm transition-colors disabled:opacity-50', tab === value ? 'border-nebula text-starlight' : 'border-transparent text-starlight/45 hover:text-starlight')}>{label}</button>)}
    </div>
    {error && !review && !detailId && <p role="alert" className="rounded-lg border border-red-400/25 bg-red-400/5 p-3 text-sm text-red-200">{error}</p>}
    {notice && !detailId && <p role="status" className="rounded-lg border border-emerald-400/20 bg-emerald-400/5 p-3 text-sm text-emerald-200">{notice}</p>}

    {tab === 'publish' && <section id="sharing-publish" role="tabpanel" aria-labelledby="sharing-tab-publish" className={panel}>
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">Choose saved revisions</h2>
        <p className="mt-1 text-xs text-starlight/50">Select up to 20 exact saved revisions. Refreshing does not change your selection.</p></div>
        <button type="button" className={secondary} disabled={busy || libraryLoading} onClick={() => setLibraryRefresh((value) => value + 1)}>Refresh library</button></div>
      {libraryLoading ? <p role="status" className="py-10 text-center text-sm text-starlight/50">Loading saved revisions…</p>
        : libraryError ? <p role="alert" className="py-6 text-sm text-red-200">{libraryError}</p>
          : !library.length ? <div className="py-12 text-center"><p className="text-sm text-starlight/50">No cards in this workspace yet.</p><Link to="/" className="mt-3 inline-block text-sm">Go to your library</Link></div>
            : <ul className="my-4 divide-y divide-nebula/10">{library.map((card) => {
              const chosen = selected.find((value) => value.cardId === card.id);
              return <li key={card.id} className="flex gap-3 py-4">
                <input type="checkbox" aria-label={`Select ${card.name}`} checked={!!chosen} disabled={busy || !!review || !!card.reference || (!chosen && selected.length >= 20)}
                  onChange={(event) => select(card, event.target.checked)} className="mt-1 h-4 w-4 shrink-0" />
                <div className="min-w-0 flex-1"><Link to={`/card/${encodeURIComponent(card.id)}`} className="font-medium"><span className="text-starlight">{card.name}</span></Link>
                  <p className="mt-1 text-xs text-starlight/50">{card.reference ? 'Read-only Archive reference' : `Saved revision ${chosen?.sequence ?? card.revisionCount}`}</p>
                  {card.reference ? <p className="mt-1 text-xs text-starlight/40">Save an edited fork to publish. This link is not an owned Unity revision.</p>
                    : chosen && chosen.revisionId !== card.headRevisionId ? <p className="mt-1 text-xs text-amber-200/80">A newer revision exists. Your selection still pins revision {chosen.sequence}; deselect and reselect to choose the new head.</p> : null}
                </div>
                {!card.reference && <button type="button" className="shrink-0 self-start rounded-lg border border-nebula/20 px-2 py-1.5 text-xs text-starlight/60 disabled:opacity-40"
                  disabled={busy || (!chosen && selected.length >= 20)} onClick={() => setRevisionCard(card)}>Choose revision</button>}
              </li>;
            })}</ul>}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-nebula/10 pt-4">
        <span className="text-xs text-starlight/50">{selected.length} selected · maximum 20</span>
        <div className="flex flex-wrap gap-2">{!libraryLoading && libraryOffset < libraryTotal && <button type="button" className={secondary} disabled={busy} onClick={() => void run('Loading library', async (signal) => {
          const next = await client.library(libraryOffset, signal); signal.throwIfAborted();
          setLibrary((old) => [...old, ...next.cards.filter((card) => !old.some((existing) => existing.id === card.id))]);
          setLibraryOffset((old) => old + next.cards.length); setLibraryTotal(next.total);
        })}>More saved cards</button>}
          <button type="button" className={primary} disabled={busy || !selected.length} onClick={() => void run('Preparing review', async (signal) => {
            const values = await client.review(selected, signal); signal.throwIfAborted(); setReview(values); setPolicy({ ...defaultPolicy });
          })}>Review {selected.length || ''} selected</button></div>
      </div>
    </section>}

    {tab === 'published' && <section id="sharing-published" role="tabpanel" aria-labelledby="sharing-tab-published" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-sm font-medium text-starlight/70">{parentId ? 'Published forks' : 'Visible publications'}</h2>
        <div className="flex gap-2">{parentId && <button type="button" disabled={busy} className={secondary} onClick={() => setParentId('')}>All publications</button>}
          <button type="button" disabled={busy || publicationLoading} className={secondary} onClick={() => setPublicationRefresh((value) => value + 1)}>Refresh publications</button></div></div>
      {publicationLoading ? <p role="status" className={cn(panel, 'py-12 text-center text-sm text-starlight/50')}>Loading publications…</p>
        : publicationError ? <p role="alert" className={cn(panel, 'text-sm text-red-200')}>{publicationError}</p>
          : !publications.length ? <div className={cn(panel, 'py-14 text-center')}><h3 className="font-medium">{parentId ? 'No visible forks yet' : 'Nothing published here yet'}</h3>
            <p className="mx-auto mt-2 max-w-md text-sm text-starlight/45">Your private library is separate. Sharing starts with an explicit review of a saved revision.</p></div>
            : <ul className="grid gap-4 md:grid-cols-2">{publications.map((value) => <li key={value.id} className={cn(panel, 'flex flex-col')}>
              <div className="mb-3 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wider text-starlight/50">
                <span className="rounded border border-nebula/20 px-2 py-1">{value.visibility}</span>
                <span>{value.parentId ? 'Fork' : 'Publication'}</span>{value.ownerId === client.actorId && <span className="text-nebula">Yours</span>}
              </div>
              <h3 className="text-lg font-semibold">{publicationTitle(value.document)}</h3>
              <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm leading-relaxed text-starlight/50">{publicationText(value.document, 'description') || 'No description.'}</p>
              <div className="mt-auto flex flex-wrap gap-2 pt-5"><button type="button" className={secondary} disabled={busy} onClick={() => openDetail(value.id)}>View publication</button>
                <button type="button" className={secondary} disabled={busy || (!value.allowFork && value.ownerId !== client.actorId)}
                  onClick={() => void run('Creating fork', (signal) => fork(value, signal))}>Fork to library</button>
                <button type="button" className="px-1 text-xs text-starlight/45 hover:text-starlight disabled:opacity-40" disabled={busy} onClick={() => setParentId(value.id)}>View forks</button></div>
              {!value.allowFork && value.ownerId !== client.actorId && <p className="mt-2 text-xs text-starlight/40">The owner does not allow forks.</p>}
            </li>)}</ul>}
      {!publicationLoading && !publicationError && morePublications && <button type="button" className={secondary} disabled={busy} onClick={() => void run('Loading publications', async (signal) => {
        const values = await client.list({ parentId, afterId: publications.at(-1)?.id, signal }); signal.throwIfAborted();
        setPublications((old) => [...old, ...values.filter((value) => !old.some((existing) => existing.id === value.id))]); setMorePublications(values.length === publicationPageSize);
      })}>More publications</button>}
    </section>}

    {revisionCard && <RevisionPicker key={revisionCard.id} client={client} card={revisionCard} onClose={() => setRevisionCard(null)} onChoose={(revision) => {
      try {
        setSelected(selectRevision(selected.filter((value) => value.cardId !== revisionCard.id), { ...revisionCard, headRevisionId: revision.id, revisionCount: revision.sequence }, true));
        setError(''); setRevisionCard(null);
      } catch (failure) { setError(errorMessage(failure)); }
    }} />}

    <Modal isOpen={!!review} onClose={() => { if (!busy) setReview(null); }} label="Review publication" size="lg">
      <div className="space-y-5 p-5 sm:p-6"><div><h2 className="text-xl font-semibold">Review publication</h2>
        <p className="mt-2 text-sm text-starlight/50">Only these exact saved revisions will be shared. Later edits and unsaved drafts are excluded.</p></div>
        {error && <p role="alert" className="rounded-lg border border-red-400/25 bg-red-400/5 p-3 text-sm text-red-200">{error}</p>}
        <ul className="max-h-56 space-y-3 overflow-y-auto rounded-lg border border-nebula/15 p-3">{review?.map((value) => <li key={value.revisionId} className="text-sm">
          <strong>{value.name}</strong><span className="ml-2 text-xs text-starlight/45">revision {value.sequence}</span>
          <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-starlight/45">{publicationText(value.document, 'description') || 'No description.'}</p>
        </li>)}</ul>
        <PolicyFields value={policy} disabled={busy} onChange={setPolicy} />
        <p className="text-xs text-starlight/45">Publication removes known local-only fields; it is not a general secret detector. Check what you wrote before sharing.</p>
        <div className="flex flex-wrap justify-end gap-2"><button type="button" className={secondary} disabled={busy} onClick={() => setReview(null)}>Cancel publication</button>
          <button type="button" className={primary} disabled={busy || !review?.length} onClick={() => { if (review) void run('Publishing', async (signal) => {
            let result;
            try { result = await client.publish(review, policy, signal); }
            catch (failure) { throw new Error(`${errorMessage(failure)} Refresh the publication list before retrying: a lost response may mean this selection was already published.`, { cause: failure }); }
            signal.throwIfAborted(); setReview(null); setSelected([]); setTab('published'); setParentId(''); setPublicationRefresh((value) => value + 1);
            setNotice(`Published ${result.publications.length} saved revision${result.publications.length === 1 ? '' : 's'}.`);
          }); }}>{action === 'Publishing' ? 'Publishing…' : 'Publish selected revisions'}</button></div>
      </div>
    </Modal>

    <Modal isOpen={!!detailId} onClose={() => { if (!busy) setDetailId(''); }} label="Published character" size="lg">
      <div className="space-y-5 p-5 sm:p-6"><div className="flex items-start justify-between gap-3"><h2 className="text-xl font-semibold">{detail ? publicationTitle(detail.document) : 'Published character'}</h2>
        <button type="button" aria-label="Close publication" className={secondary} disabled={busy} onClick={() => setDetailId('')}>Close</button></div>
        {error && <p role="alert" className="rounded-lg border border-red-400/25 bg-red-400/5 p-3 text-sm text-red-200">{error}</p>}
        {notice && <p role="status" className="text-sm text-emerald-200">{notice}</p>}
        {detailLoading ? <p role="status" className="text-sm text-starlight/50">Loading publication…</p> : detailError ? <div className="space-y-3"><p role="alert" className="text-sm text-red-200">{detailError}</p>
          <button type="button" className={secondary} onClick={() => setDetailRefresh((value) => value + 1)}>Retry publication</button></div> : detail && <>
          <p className="text-xs text-starlight/45">{detail.visibility} · policy version {detail.policyVersion} · {detail.assets.length} attached {detail.assets.length === 1 ? 'asset' : 'assets'}</p>
          <div className="space-y-4">{[['description', 'Description'], ['personality', 'Personality'], ['scenario', 'Scenario'], ['first_mes', 'First message']].map(([field, label]) => {
            const value = publicationText(detail.document, field); return value ? <section key={field}><h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-starlight/45">{label}</h3>
              <p className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-starlight/75">{value}</p></section> : null;
          })}</div>
          <div className="flex flex-wrap gap-2"><button type="button" className={primary} disabled={busy || (!detail.allowFork && detail.ownerId !== client.actorId)} onClick={() => void run('Creating fork', (signal) => fork(detail, signal))}>Fork to library</button>
            <button type="button" className={secondary} disabled={busy} onClick={() => void run('Loading lineage', (signal) => readLineage(detail, false, signal))}>View lineage</button>
            {(detail.allowOriginal || detail.ownerId === client.actorId) && <button type="button" className={secondary} disabled={busy} onClick={() => void run('Downloading original', async (signal) => {
              const blob = await client.original(detail.id, signal); signal.throwIfAborted();
              const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url;
              link.download = `publication-${detail.id}-original`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
            })}>Download original</button>}</div>
          {detail.ownerId === client.actorId && <section className="space-y-4 border-t border-nebula/15 pt-5" aria-label="Publication policy">
            <h3 className="font-medium">Publication policy</h3><PolicyFields value={detailPolicy} disabled={busy} onChange={setDetailPolicy} />
            <button type="button" className={secondary} disabled={busy} onClick={() => void run('Updating policy', async (signal) => {
              await client.policy(detail.id, detail.policyVersion, detailPolicy, signal); signal.throwIfAborted();
              setLineage(null); setDetailRefresh((value) => value + 1); setPublicationRefresh((value) => value + 1); setNotice('Publication policy updated.');
            })}>Save publication policy</button>
          </section>}
          {lineage && <div className="border-t border-nebula/15 pt-5"><PublicationLineage value={lineage} busy={busy}
            onMore={() => void run('Loading lineage', (signal) => readLineage(detail, true, signal))}
            onRefresh={() => void run('Loading lineage', (signal) => readLineage(detail, false, signal))} /></div>}
        </>}
      </div>
    </Modal>
  </div>;
}
