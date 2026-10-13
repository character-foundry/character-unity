import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { cn } from '@/lib/utils/cn';
import { formatCount, formatRelative } from '@/lib/utils/format';
import { useSettings } from '@/lib/settings';
import type { UserSettings } from '@/lib/settings';
import { HeartIcon, MetadataBadge } from '@/components/ui';
import { archiveApi, providerShort, useObjectUrl } from '@/lib/archive';
import type { ArchiveCard } from '@/lib/archive';
import { libraryId, portraitUrl, setFavorite } from '@/lib/unity';
import { libraryChanged } from '@/lib/library-search';
import { FavoriteButton } from '@/components/cards/card-actions';

const badge = 'rounded bg-black/70 px-1 py-0.5 text-[10px] font-semibold text-white';

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
  const [libraryId, setLibraryId] = useState(card.libraryCardId);
  const [favorite, setValue] = useState(card.libraryFavorite ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  useEffect(() => {
    request.current++; setLibraryId(card.libraryCardId); setValue(card.libraryFavorite ?? false); setBusy(false); setError(null);
    return () => { request.current++; };
  }, [card.id, card.versionId, card.libraryCardId, card.libraryFavorite]);
  async function add(favorited: boolean) {
    const generation = ++request.current;
    setBusy(true); setError(null);
    try {
      if (favorite && libraryId && favorited) {
        await setFavorite(libraryId, false);
        if (generation === request.current) setValue(false);
        libraryChanged();
      } else {
        const result = await (favorited ? archiveApi.favorite(card.id, card.versionId) : archiveApi.import(card.id, card.versionId));
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
      {error && <span role="alert" className="absolute bottom-full left-0 z-20 mb-1 w-56 whitespace-normal rounded border border-red-500/40 bg-slate-950 p-2 text-xs text-red-200">{error}</span>}
    </span>
  );
}

/** An Archive tile, in the library tile's layout: badges on top, name, creator, tags and counts below. */
export function ArchiveCardItem({ card, size, onOpen }: { card: ArchiveCard; size: UserSettings['cardSize']; onOpen: (card: ArchiveCard) => void }) {
  const { settings } = useSettings();
  const navigate = useNavigate();
  const archivedImage = useObjectUrl(card.libraryOwned ? null : card.portrait);
  const [ownedImage, setOwnedImage] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setOwnedImage(null);
    if (card.libraryOwned && card.libraryCardId && card.hasPortrait) void libraryId().then((workspace) => {
      if (active) setOwnedImage(portraitUrl(workspace, card.libraryCardId!, card.versionId));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [card.libraryOwned, card.libraryCardId, card.hasPortrait, card.versionId]);
  const image = card.libraryOwned ? ownedImage : archivedImage;
  const small = size === 'small';
  const maxTags = size === 'large' ? 3 : 2;
  const nsfw = card.tags.some((tag) => tag.toLowerCase() === 'nsfw');
  return (
    <article className="group relative block aspect-[3/4] overflow-hidden rounded-lg bg-cosmic-teal ring-1 ring-nebula/15 transition-shadow hover:ring-nebula/70">
      <button type="button" aria-label={`${card.libraryOwned ? 'View' : 'Quick view'} ${card.name}`} onClick={() => {
        if (card.libraryOwned) { if (card.libraryCardId) navigate(`/card/${encodeURIComponent(card.libraryCardId)}`); } else onOpen(card);
      }}
        className="absolute inset-0 cursor-pointer rounded-lg focus-visible:outline-2 focus-visible:outline-nebula" />
      {image ? (
        <img src={image} alt={card.name} loading="lazy" decoding="async"
          className={cn('pointer-events-none absolute inset-0 h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.03]', settings.blurNsfwContent && nsfw && 'blur-xl')} />
      ) : <div className="pointer-events-none flex h-full items-center justify-center text-4xl text-starlight/20">?</div>}

      <div className="pointer-events-none absolute inset-x-1.5 top-1.5 flex items-start justify-between gap-1">
        <div className="flex flex-wrap gap-1">
          <MetadataBadge type="greetings" count={card.altGreetings + 1} className={cn(badge, 'gap-0.5')} />
          {!small && <MetadataBadge type="lorebook" count={card.lorebookEntries} className={cn(badge, 'gap-0.5')} />}
        </div>
        <div className="flex flex-wrap justify-end gap-1">
          {card.versions > 1 && !small && <span className={badge} title={`${card.versions} versions archived`}>v{card.versions}</span>}
          <span className={badge}>{providerShort[card.provider] ?? card.provider.toUpperCase()}</span>
        </div>
      </div>

      <div className={cn('pointer-events-none absolute inset-x-0 bottom-0 bg-black/75 backdrop-blur-sm', small ? 'px-2 py-1.5' : 'px-2.5 py-2')}>
        <h3 className={cn('truncate font-semibold leading-tight text-white group-hover:text-nebula', small ? 'text-[12px]' : 'text-[13px]')}>{card.name}</h3>
        <p className="truncate text-[11px] leading-tight text-white/60">by {card.creator || 'Anonymous'}</p>
        {!small && card.tags.length > 0 && (
          <div className="mt-1.5 flex gap-1 overflow-hidden">
            {card.tags.slice(0, maxTags).map((tag) => (
              <span key={tag} className="shrink-0 whitespace-nowrap rounded bg-aurora/20 px-1.5 py-px text-[10px] font-medium text-blue-200">{tag}</span>
            ))}
            {card.tags.length > maxTags && <span className="shrink-0 rounded bg-white/10 px-1.5 py-px text-[10px] font-medium text-white/70">+{card.tags.length - maxTags}</span>}
          </div>
        )}
        <div className={cn('flex items-center gap-1.5 whitespace-nowrap text-[11px] text-white/60', small ? 'mt-1' : 'mt-1.5')}>
          <AddToLibrary card={card} />
          {card.stats.stars !== undefined && !small && <span title="Stars on the source">★ {formatCount(card.stats.stars)}</span>}
          {size === 'large' && <span className="min-w-0 truncate" title="Last updated on the source">{formatRelative(Date.parse(card.remoteUpdatedAt ?? card.changedAt) / 1000)}</span>}
          <span className="ml-auto shrink-0 tabular-nums text-amber-300" title="Tokens">{formatCount(card.tokens)} tk</span>
        </div>
      </div>
    </article>
  );
}
