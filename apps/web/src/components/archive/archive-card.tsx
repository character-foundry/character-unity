import { useState } from 'react';
import { Link } from 'react-router';
import { cn } from '@/lib/utils/cn';
import { formatCount, formatRelative } from '@/lib/utils/format';
import { useSettings } from '@/lib/settings';
import type { UserSettings } from '@/lib/settings';
import { MetadataBadge } from '@/components/ui';
import { archiveApi, providerShort, useObjectUrl } from '@/lib/archive';
import type { ArchiveCard } from '@/lib/archive';

const badge = 'rounded bg-black/70 px-1 py-0.5 text-[10px] font-semibold text-white';

/** Add to library, or a link to the library copy once it is there. */
export function AddToLibrary({ card, onAdded, className }: { card: Pick<ArchiveCard, 'id' | 'libraryCardId'>; onAdded?: (cardId: string) => void; className?: string }) {
  const [libraryId, setLibraryId] = useState(card.libraryCardId);
  const [busy, setBusy] = useState(false);
  if (libraryId) {
    return (
      <Link to={`/card/${libraryId}`} onClick={(event: React.MouseEvent) => event.stopPropagation()} title="Open the library copy"
        className={cn('pointer-events-auto relative z-10 rounded px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300 hover:text-emerald-200', className)}>
        In library ✓
      </Link>
    );
  }
  return (
    <button type="button" disabled={busy} title="Copy this card into your library"
      onClick={async (event) => {
        event.stopPropagation(); event.preventDefault(); setBusy(true);
        try { const result = await archiveApi.import(card.id); setLibraryId(result.cardId); onAdded?.(result.cardId); }
        catch (error) { window.alert(error instanceof Error ? error.message : 'The card could not be added'); }
        finally { setBusy(false); }
      }}
      className={cn('pointer-events-auto relative z-10 rounded bg-nebula/80 px-1.5 py-0.5 text-[10px] font-semibold text-white hover:bg-nebula disabled:opacity-60', className)}>
      {busy ? 'Adding…' : '+ Library'}
    </button>
  );
}

/** An Archive tile, in the library tile's layout: badges on top, name, creator, tags and counts below. */
export function ArchiveCardItem({ card, size, onOpen }: { card: ArchiveCard; size: UserSettings['cardSize']; onOpen: (card: ArchiveCard) => void }) {
  const { settings } = useSettings();
  const image = useObjectUrl(card.portrait);
  const small = size === 'small';
  const maxTags = size === 'large' ? 3 : 2;
  const nsfw = card.tags.some((tag) => tag.toLowerCase() === 'nsfw');
  return (
    <article className="group relative block aspect-[3/4] overflow-hidden rounded-lg bg-cosmic-teal ring-1 ring-nebula/15 transition-shadow hover:ring-nebula/70">
      <button type="button" aria-label={`Quick view ${card.name}`} onClick={() => onOpen(card)}
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
