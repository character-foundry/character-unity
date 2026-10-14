import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Modal, ModalBody } from '@/components/ui';
import { cn } from '@/lib/utils/cn';
import { formatCount, formatDate } from '@/lib/utils/format';
import { useSettings } from '@/lib/settings';
import { FollowButton } from '@/components/cards/card-actions';
import { providerLabels, useArchiveApi, useObjectUrl } from '@/lib/archive';
import { ProtectedImage } from '@/components/ui/protected-media';
import type { ArchiveCard, ArchiveCardDetail } from '@/lib/archive';
import { AddToLibrary } from './archive-card';

const text = (value: unknown) => typeof value === 'string' ? value : '';

function Section({ title, value }: { title: string; value: string }) {
  if (!value.trim()) return null;
  return (
    <div>
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-starlight/40">{title}</h3>
      <p className="max-h-48 overflow-y-auto whitespace-pre-wrap text-sm text-starlight/80">{value.length > 4000 ? `${value.slice(0, 4000)}…` : value}</p>
    </div>
  );
}

/** Archive quick view. Library membership references a pinned version without copying files. */
export function ArchiveCardModal({ card, onClose, onRemoved }: { card: ArchiveCard | null; onClose: () => void; onRemoved: () => void }) {
  const archiveApi = useArchiveApi();
  const { settings } = useSettings();
  const [detail, setDetail] = useState<ArchiveCardDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const image = useObjectUrl(card?.portrait ?? null);
  useEffect(() => {
    setDetail(null); setError(null); setBusy(false); operation.current?.abort();
    if (!card) return;
    const controller = new AbortController();
    archiveApi.card(card.id, card.versionId, controller.signal).then(
      (value) => { if (!controller.signal.aborted) setDetail(value); },
      (failure: Error) => { if (!controller.signal.aborted) setError(failure.message); },
    );
    return () => { controller.abort(); operation.current?.abort(); };
  }, [archiveApi, card]);
  if (!card) return null;
  const data = detail?.document?.data ?? {};
  const nsfw = card.tags.some((tag) => tag.toLowerCase() === 'nsfw');
  const stats = [['Stars', card.stats.stars], ['Favorites', card.stats.favorites], ['Chats', card.stats.chats], ['Messages', card.stats.messages], ['Downloads', card.stats.downloads]]
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number');

  return (
    <Modal isOpen onClose={onClose} size="xl">
      <ModalBody className="p-0">
        <div className="flex flex-col lg:flex-row">
          <div className="relative aspect-[3/4] w-full flex-shrink-0 bg-cosmic-teal lg:aspect-auto lg:min-h-[600px] lg:w-2/5">
            {image && <ProtectedImage src={image} alt={card.name} className={cn('absolute inset-0 h-full w-full rounded-t-2xl object-cover lg:rounded-l-2xl lg:rounded-tr-none', settings.blurNsfwContent && nsfw && 'blur-xl')} />}
          </div>
          <div className="max-h-[600px] flex-1 space-y-4 overflow-y-auto p-6 lg:max-h-[80vh]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-2xl font-bold gradient-text">{card.name}</h2>
                <div className="mt-1 text-sm text-starlight/60">
                  by {card.creator || 'Anonymous'}{card.creator && <FollowButton creator={card.creator} />}
                </div>
                {card.tagline && <p className="mt-1 text-sm italic text-starlight/60">{card.tagline}</p>}
              </div>
              <button type="button" onClick={onClose} aria-label="Close" className="text-xl text-starlight/50 hover:text-starlight">✕</button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <AddToLibrary card={card} className="px-3 py-1.5 text-sm" />
              <a href={card.url} target="_blank" rel="noreferrer noopener" className="rounded-lg border border-nebula/30 px-3 py-1.5 text-sm text-starlight/80 hover:border-nebula">
                Open on {providerLabels[card.provider] ?? card.provider} ↗
              </a>
              <button type="button" disabled={busy} className="rounded-lg border border-red-500/40 px-3 py-1.5 text-sm text-red-300 hover:bg-red-500/10 disabled:opacity-40"
                onClick={async () => {
                  if (!window.confirm(`Remove “${card.name}” from the Archive? It will be hidden and never fetched again. Its files stay on disk.`)) return;
                  const controller = new AbortController(); operation.current = controller; setBusy(true); setError(null);
                  try { await archiveApi.block(card.id, controller.signal); if (!controller.signal.aborted) onRemoved(); }
                  catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Could not remove it'); }
                  finally { if (operation.current === controller) operation.current = null; if (!controller.signal.aborted) setBusy(false); }
                }}>{busy ? 'Removing…' : 'Remove from Archive'}</button>
            </div>
            <p className="text-xs text-starlight/50">Adding or favoriting keeps a library link to this archived version. The original and its files stay in Archive; saving a changed edit creates your fork. Unfavoriting keeps the link.</p>

            <div className="flex flex-wrap gap-1.5">
              {card.tags.map((tag) => <Link key={tag} to={`/archive?tags=${encodeURIComponent(tag)}`} onClick={onClose} className="rounded bg-aurora/20 px-2 py-0.5 text-xs text-blue-200 hover:bg-nebula/40">{tag}</Link>)}
            </div>

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-starlight/60">
              <span>{formatCount(card.tokens)} tokens</span>
              <span>{card.altGreetings + 1} greeting{card.altGreetings ? 's' : ''}</span>
              {card.lorebookEntries > 0 && <span>{card.lorebookEntries} lorebook entries</span>}
              {stats.map(([label, value]) => <span key={label}>{formatCount(value)} {label.toLowerCase()}</span>)}
              {card.remoteUpdatedAt && <span>Updated {formatDate(Date.parse(card.remoteUpdatedAt) / 1000)}</span>}
              <span>Archived {formatDate(Date.parse(card.firstSeenAt) / 1000)}</span>
            </div>

            {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
            {!detail && !error && <p className="text-sm text-starlight/50">Loading card…</p>}
            {detail && (<>
              <Section title="Description" value={text(data.description)} />
              <Section title="Personality" value={text(data.personality)} />
              <Section title="Scenario" value={text(data.scenario)} />
              <Section title="First message" value={text(data.first_mes)} />
              <Section title="Creator's notes" value={text(data.creator_notes)} />
              <div>
                <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-starlight/40">Archived versions</h3>
                <ul className="space-y-0.5 text-xs text-starlight/60">
                  {detail.versionList.map((version) => (
                    <li key={version.id}>v{version.sequence} · fetched {formatDate(Date.parse(version.fetchedAt) / 1000)} · {version.objects.filter((object) => object.role !== 'raw').map((object) => object.name).join(', ')}</li>
                  ))}
                </ul>
              </div>
            </>)}
          </div>
        </div>
      </ModalBody>
    </Modal>
  );
}
