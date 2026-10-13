import { useState } from 'react';
import { Link } from 'react-router';
import type { CardListItem, SourceFormat } from '@/types/card';
import { useSettings } from '@/lib/settings';
import type { UserSettings } from '@/lib/settings';
import { cn } from '@/lib/utils/cn';
import { formatCount, formatRelative } from '@/lib/utils/format';
import { DownloadIcon, MetadataBadge } from '@/components/ui';
import { PlacementChips, SendMenu } from '@/components/chat/send-menu';
import { FavoriteButton } from './card-actions';
import type { ChatPlacement } from '@/lib/chat';
import { downloadExport } from '@/lib/unity';
import { buildCardExportFilename } from '@/lib/utils';

const badge = 'rounded bg-black/70 px-1 py-0.5 text-[10px] font-semibold text-white';

// charx/voxta show the package format, png/json show the spec version
function formatLabel(format: SourceFormat | null, specVersion: string) {
  return (format === 'charx' || format === 'voxta' ? format : specVersion).toUpperCase();
}

interface CardItemProps {
  card: CardListItem;
  size?: UserSettings['cardSize'];
  onQuickView?: (card: CardListItem) => void;
  placements?: ChatPlacement[] | undefined;
}

/** A library tile: portrait, badges along the top, and name, creator, tags and counts in the bottom panel. */
export function CardItem({ card, size = 'medium', onQuickView, placements }: CardItemProps) {
  const { settings } = useSettings();
  const small = size === 'small';
  const maxTags = size === 'large' ? 3 : 2;
  const [exporting, setExporting] = useState(false);

  const isNsfw = card.tags.some(tag => tag.slug === 'nsfw');
  const shouldBlur = settings.blurNsfwContent && isNsfw;

  // Quick export: a PNG when the card has a portrait to carry it, otherwise JSON.
  const handleQuickExport = async (e: React.MouseEvent) => {
    e.stopPropagation(); e.preventDefault();
    const format = card.imagePath ? 'png' : 'json';
    setExporting(true);
    try { await downloadExport(card.id, card.headRevisionId, format, buildCardExportFilename(card, format)); }
    catch (error) { window.alert(error instanceof Error ? error.message : 'Export failed'); }
    finally { setExporting(false); }
  };

  return (
    <article className="group relative block aspect-[3/4] overflow-hidden rounded-lg bg-cosmic-teal ring-1 ring-nebula/15 transition-shadow hover:ring-nebula/70">
      {onQuickView ? (
        <button type="button" aria-label={`Quick view ${card.name}`} onClick={() => onQuickView(card)}
          className="absolute inset-0 cursor-pointer rounded-lg focus-visible:outline-2 focus-visible:outline-nebula" />
      ) : (
        <Link to={`/card/${card.id}`} aria-label={`View ${card.name}`}
          className="absolute inset-0 rounded-lg focus-visible:outline-2 focus-visible:outline-nebula" />
      )}
      {(card.thumbnailPath || card.imagePath) ? (
        <img src={card.thumbnailPath || card.imagePath!} alt={card.name} loading="lazy" decoding="async"
          className={cn('pointer-events-none absolute inset-0 h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.03]', shouldBlur && 'blur-xl')} />
      ) : (
        <div className="pointer-events-none flex h-full w-full items-center justify-center">
          <span aria-hidden="true" className="flex h-18 w-18 items-center justify-center rounded-2xl bg-nebula/20 text-2xl font-bold text-nebula/50">CU</span>
        </div>
      )}

      {/* Badges along the top */}
      <div className="pointer-events-none absolute inset-x-1.5 top-1.5 flex items-start justify-between gap-1">
        <div className="flex flex-wrap gap-1">
          <MetadataBadge type="greetings" count={card.totalGreetingsCount} className={cn(badge, 'gap-0.5')} />
          {!small && <MetadataBadge type="lorebook" count={card.lorebookEntriesCount} className={cn(badge, 'gap-0.5')} />}
          {!small && <MetadataBadge type="images" count={card.embeddedImagesCount} className={cn(badge, 'gap-0.5')} />}
          {!small && <MetadataBadge type="assets" count={card.assetsCount} className={cn(badge, 'gap-0.5')} />}
        </div>
        <div className="flex flex-wrap justify-end gap-1">
          {card.isFork && <span className="rounded bg-nebula px-1 py-0.5 text-[10px] font-semibold text-white" title="Your edited fork">FORK</span>}
          {card.reference && <span className="rounded bg-emerald-900/90 px-1 py-0.5 text-[10px] font-semibold text-emerald-200" title="Linked to an exact Archive version; files stay in Archive">ARCHIVE</span>}
          {card.forksCount !== null && card.forksCount > 0 && !small && <span className={badge} title={`${card.forksCount} fork${card.forksCount === 1 ? '' : 's'}`}>⑂ {card.forksCount}</span>}
          <PlacementChips placements={placements} className="px-1 py-0.5 text-[10px] font-semibold" />
          <span className={badge}>{formatLabel(card.sourceFormat, card.specVersion)}</span>
        </div>
      </div>

      {/* Quick actions - revealed on hover (always visible on touch screens) */}
      <div className="absolute right-1.5 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
        <SendMenu cardId={card.id} placements={placements} variant="icon" />
        <button onClick={handleQuickExport} disabled={exporting} title={card.imagePath ? 'Download PNG' : 'Download JSON'}
          className="flex h-7 w-7 items-center justify-center rounded-md bg-black/70 text-white hover:bg-nebula disabled:opacity-60">
          <DownloadIcon className={cn('h-3.5 w-3.5', exporting && 'animate-pulse')} />
        </button>
      </div>

      {/* Info panel */}
      <div className={cn('pointer-events-none absolute inset-x-0 bottom-0 bg-black/75 backdrop-blur-sm', small ? 'px-2 py-1.5' : 'px-2.5 py-2')}>
        <h3 className={cn('truncate font-semibold leading-tight text-white group-hover:text-nebula', small ? 'text-[12px]' : 'text-[13px]')}>{card.name}</h3>
        <p className="truncate text-[11px] leading-tight text-white/60">by {card.creator}</p>

        {!small && card.tags.length > 0 && (
          <div className="mt-1.5 flex gap-1 overflow-hidden">
            {card.tags.slice(0, maxTags).map((tag) => (
              <Link key={tag.id} to={`/?tags=${encodeURIComponent(tag.name)}`}
                className="pointer-events-auto relative z-10 shrink-0 whitespace-nowrap rounded bg-aurora/20 px-1.5 py-px text-[10px] font-medium text-blue-200 hover:bg-nebula/40">
                {tag.name}
              </Link>
            ))}
            {card.tags.length > maxTags && <span className="shrink-0 rounded bg-white/10 px-1.5 py-px text-[10px] font-medium text-white/70">+{card.tags.length - maxTags}</span>}
          </div>
        )}

        <div className={cn('flex items-center gap-1.5 whitespace-nowrap text-[11px] text-white/60', small ? 'mt-1' : 'mt-1.5')}>
          <FavoriteButton cardId={card.id} initial={card.isFavorited ?? false} className="pointer-events-auto relative z-10 -m-1 p-1" iconClassName="h-3 w-3" />
          {isNsfw && <span className="text-orange-400" title="NSFW">🔥</span>}
          <span className="min-w-0 truncate" title="Last edited">{formatRelative(card.updatedAt)}</span>
          {card.tokensTotal !== null && <span className="ml-auto shrink-0 tabular-nums text-amber-300" title="Tokens">{formatCount(card.tokensTotal)} tk</span>}
        </div>
      </div>
    </article>
  );
}
