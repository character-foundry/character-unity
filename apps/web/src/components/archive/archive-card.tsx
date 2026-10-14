import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { cn } from '@/lib/utils/cn';
import { formatCount, formatRelative } from '@/lib/utils/format';
import { useSettings } from '@/lib/settings';
import type { UserSettings } from '@/lib/settings';
import { HeartIcon, MetadataBadge } from '@/components/ui';
import { providerShort, useArchiveApi, useObjectUrl } from '@/lib/archive';
import type { ArchiveCard } from '@/lib/archive';
import { portraitUrl } from '@/lib/unity';
import { useLibraryClient } from '@/lib/library-client';
import { ProtectedImage } from '@/components/ui/protected-media';
import { libraryChanged } from '@/lib/library-search';
import { FavoriteButton } from '@/components/cards/card-actions';
import { TileTokens, tileBadge } from '@/components/cards/tile-presentation';
import { ActionError } from '@/components/cards/action-error';

/** Keep a lightweight link to the exact archived version, never a file copy. */
type LibraryLinkProps = { card: Pick<ArchiveCard, 'id' | 'versionId' | 'libraryCardId' | 'libraryFavorite' | 'libraryOwned'>; onAdded?: (cardId: string) => void; className?: string };
export function AddToLibrary(props: LibraryLinkProps) {
  if (props.card.libraryOwned) return props.card.libraryCardId ? <span className="pointer-events-auto relative z-10 inline-flex items-center gap-1">
    <FavoriteButton cardId={props.card.libraryCardId} initial={props.card.libraryFavorite ?? false} />
    <Link to={`/card/${encodeURIComponent(props.card.libraryCardId)}`} onClick={(event) => event.stopPropagation()} className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold', props.className)}><span className="text-emerald-300">In library ✓</span></Link>
  </span> : <span className="text-xs text-red-300">Library card unavailable</span>;
  return <ArchiveLibraryLink {...props} />;
}
function ArchiveLibraryLink({ card, onAdded, className }: LibraryLinkProps) {
  const library = useLibraryClient(), archiveApi = useArchiveApi();
  const [libraryId, setLibraryId] = useState(card.libraryCardId);
  const [favorite, setValue] = useState(card.libraryFavorite ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => {
    request.current++; setLibraryId(card.libraryCardId); setValue(card.libraryFavorite ?? false); setBusy(false); setError(null);
    return () => { request.current++; operation.current?.abort(); };
  }, [library, archiveApi, card.id, card.versionId, card.libraryCardId, card.libraryFavorite]);
  async function add(favorited: boolean) {
    const generation = ++request.current;
    const controller = new AbortController(); operation.current?.abort(); operation.current = controller;
    setBusy(true); setError(null);
    try {
      if (favorite && libraryId && favorited) {
        await library.setFavorite(libraryId, false);
        if (generation === request.current) setValue(false);
        libraryChanged();
      } else {
        const result = await (favorited ? archiveApi.favorite(card.id, card.versionId, controller.signal) : archiveApi.import(card.id, card.versionId, controller.signal));
        if (generation !== request.current) return;
        setLibraryId(result.cardId); if (favorited) setValue(true); onAdded?.(result.cardId);
      }
    } catch (failure) {
      if (generation === request.current) setError(failure instanceof Error ? failure.message : 'The Archive reference could not be added');
    } finally { if (generation === request.current) setBusy(false); }
  }
  return (
    <span className="pointer-events-auto relative z-10 inline-flex items-center gap-1">
      <button type="button" disabled={busy} aria-pressed={favorite}
        title={favorite ? 'Remove favorite; keep the library link' : 'Favorite and add a library link'}
        onClick={(event) => { event.stopPropagation(); event.preventDefault(); void add(true); }}
        className={cn('rounded p-1 hover:text-pink-300 disabled:opacity-60', favorite ? 'text-pink-400' : 'text-white/70')}>
        <HeartIcon className="h-3.5 w-3.5" filled={favorite} />
      </button>
      {libraryId ? <Link to={`/card/${encodeURIComponent(libraryId)}`} onClick={(event: React.MouseEvent) => event.stopPropagation()} title="Open the linked Archive version"
        className={cn('pointer-events-auto relative z-10 rounded px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300 hover:text-emerald-200', className)}>
        In library ✓
      </Link> : <button type="button" disabled={busy} title="Add a library link; the original files stay in Archive"
        onClick={(event) => { event.stopPropagation(); event.preventDefault(); void add(false); }}
        className={cn('rounded bg-nebula/80 px-1.5 py-0.5 text-[10px] font-semibold text-white hover:bg-nebula disabled:opacity-60', className)}>
        {busy ? 'Adding…' : '+ Library'}
      </button>}
      {error && <ActionError message={error} />}
    </span>
  );
}

/** An Archive tile, in the library tile's layout: badges on top, name, creator, tags and counts below. */
export function ArchiveCardItem({ card, size, onOpen }: { card: ArchiveCard; size: UserSettings['cardSize']; onOpen: (card: ArchiveCard) => void }) {
  const library = useLibraryClient();
  const { settings } = useSettings();
  const navigate = useNavigate();
  const archivedImage = useObjectUrl(card.libraryOwned ? null : card.portrait);
  const ownedImage = card.libraryOwned && card.libraryCardId && card.hasPortrait ? portraitUrl(library.workspaceId, card.libraryCardId, card.versionId) : null;
  const image = card.libraryOwned ? ownedImage : archivedImage;
  const small = size === 'small';
  const maxTags = size === 'large' ? 3 : 2;
  const nsfw = card.tags.some((tag) => tag.toLowerCase() === 'nsfw');
  return (
    <article className="group relative scroll-mt-28 focus-within:z-30">
      <div className="relative aspect-[3/4] overflow-hidden rounded-lg bg-surface-2 ring-1 ring-starlight/[0.06] transition-shadow hover:ring-starlight/20">
        {image ? (
          <ProtectedImage src={image} alt="" loading="lazy" decoding="async"
            className={cn('pointer-events-none absolute inset-0 h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.03] motion-reduce:transform-none', settings.blurNsfwContent && nsfw && 'blur-xl')} />
        ) : <div className="pointer-events-none flex h-full items-center justify-center text-4xl text-starlight/20" aria-hidden="true">?</div>}
        <button type="button" aria-label={`${card.libraryOwned ? 'View' : 'Quick view'} ${card.name}`} onClick={() => {
          if (card.libraryOwned) { if (card.libraryCardId) navigate(`/card/${encodeURIComponent(card.libraryCardId)}`); } else onOpen(card);
        }} className="absolute inset-0 cursor-pointer rounded-lg focus-visible:-outline-offset-2 focus-visible:outline-nebula" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/90 via-black/50 to-transparent" />

        <div className="pointer-events-none absolute left-1.5 top-1.5 flex max-w-[52%] flex-wrap gap-1">
          <MetadataBadge type="greetings" count={card.altGreetings + 1} className={tileBadge} />
          <MetadataBadge type="lorebook" count={card.lorebookEntries} className={tileBadge} />
        </div>
        <div className="pointer-events-none absolute right-1.5 top-1.5 flex max-w-[48%] flex-col items-end gap-1">
          <div className="flex flex-wrap justify-end gap-1">
            {card.versions > 1 && !small && <span className={tileBadge} title={`${card.versions} versions archived`}>v{card.versions}</span>}
            <span className={tileBadge}>{providerShort[card.provider] ?? card.provider.toUpperCase()}</span>
          </div>
          <TileTokens count={card.tokens} />
        </div>

        <div className={cn('pointer-events-none absolute inset-x-0 bottom-0 px-2', small ? 'pb-9' : 'pb-10')}>
          <h3 className={cn('truncate font-semibold leading-tight text-white drop-shadow', small ? 'text-[12px]' : 'text-[13px]')}>{card.name}</h3>
          <p className="truncate text-[11px] leading-tight text-white/65">by {card.creator || 'Anonymous'}</p>
          {!small && card.tags.length > 0 && <ul className="mt-1.5 flex gap-1 overflow-hidden" aria-label="Tags">
            {card.tags.slice(0, maxTags).map((tag) => <li key={tag} className="shrink-0 whitespace-nowrap rounded bg-white/10 px-1.5 py-px text-[10px] font-medium text-white/85 backdrop-blur-sm">{tag}</li>)}
            {card.tags.length > maxTags && <li className="shrink-0 px-0.5 py-px text-[10px] font-medium text-white/55">+{card.tags.length - maxTags}</li>}
          </ul>}
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1 px-1.5 pb-1.5 text-[11px] text-white/65">
        <AddToLibrary card={card} />
        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          {card.stats.stars !== undefined && !small && <span className="shrink-0" title="Stars on the source">★ {formatCount(card.stats.stars)}</span>}
          {size === 'large' && <span className="min-w-0 truncate" title="Last updated on the source">{formatRelative(Date.parse(card.remoteUpdatedAt ?? card.changedAt) / 1000)}</span>}
        </div>
      </div>
    </article>
  );
}
