'use client';

import { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import type { CardListItem, SourceFormat } from '@/types/card';
import { useSettings } from '@/lib/settings';
import type { UserSettings } from '@/lib/settings';
import { useAuth } from '@/lib/auth/context';
import { features } from '@/lib/features';
import { cn } from '@/lib/utils/cn';
import { formatCount, formatRelative } from '@/lib/utils/format';
import { ThumbsUpIcon, DownloadIcon, HeartIcon, MetadataBadge } from '@/components/ui';
import { PlacementChips, SendMenu } from '@/components/chat/send-menu';
import { FavoriteButton } from './card-actions';
import type { ChatPlacement } from '@/lib/chat';
import { downloadExport } from '@/lib/unity';
import { buildCardExportFilename } from '@/lib/utils';

const badge = 'rounded bg-black/70 px-1 py-0.5 text-[10px] font-semibold text-white';

// charx/voxta show the package format, png/json show the spec version
function formatLabel(format: SourceFormat, specVersion: string) {
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
  const { user } = useAuth();
  const small = size === 'small';
  const maxTags = size === 'large' ? 3 : 2;
  // Hub favorites (social builds) count across users; the local heart is FavoriteButton.
  const [isFavorited, setIsFavorited] = useState(card.isFavorited ?? false);
  const [favoritesCount, setFavoritesCount] = useState(card.favoritesCount);
  const [isTogglingFavorite, setIsTogglingFavorite] = useState(false);
  const [exporting, setExporting] = useState(false);

  const isNsfw = card.tags.some(tag => tag.slug === 'nsfw');
  const shouldBlur = settings.blurNsfwContent && isNsfw;

  const handleFavoriteClick = async (e: React.MouseEvent) => {
    e.stopPropagation(); e.preventDefault();
    if (!user || isTogglingFavorite) return;
    setIsTogglingFavorite(true);
    try {
      const response = await fetch(`/api/cards/${card.slug}/favorite`, { method: 'POST' });
      if (response.ok) {
        const data = await response.json();
        setIsFavorited(data.data.isFavorited);
        setFavoritesCount(data.data.favoritesCount);
      }
    } catch (error) {
      console.error('Error toggling favorite:', error);
    } finally {
      setIsTogglingFavorite(false);
    }
  };

  // Quick export: a PNG when the card has a portrait to carry it, otherwise JSON.
  const handleQuickExport = async (e: React.MouseEvent) => {
    e.stopPropagation(); e.preventDefault();
    const format = card.imagePath ? 'png' : 'json';
    setExporting(true);
    try { await downloadExport(card.id, card.headRevisionId, format, buildCardExportFilename(card, format)); }
    catch (error) { window.alert(error instanceof Error ? error.message : 'Export failed'); }
    finally { setExporting(false); }
  };

  // Use Link wrapper for direct navigation, div for modal mode
  const Wrapper = (onQuickView ? 'div' : Link) as React.ElementType;
  const wrapperProps = onQuickView
    ? { onClick: (e: React.MouseEvent) => { e.preventDefault(); onQuickView(card); } }
    : { href: `/card/${card.slug}` };

  return (
    <Wrapper {...wrapperProps}
      className="group relative block aspect-[3/4] cursor-pointer overflow-hidden rounded-lg bg-cosmic-teal ring-1 ring-nebula/15 transition-shadow hover:ring-nebula/70">
      {(card.thumbnailPath || card.imagePath) ? (
        <Image src={card.thumbnailPath || card.imagePath!} alt={card.name} fill
          className={cn('object-cover transition-transform duration-300 ease-out group-hover:scale-[1.03]', shouldBlur && 'blur-xl')}
          sizes="(max-width: 640px) 50vw, 240px" />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <Image src="/ca-logo.svg" alt="" width={72} height={72} className="opacity-30" />
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
          {card.forksCount > 0 && !small && <span className={badge} title={`${card.forksCount} fork${card.forksCount === 1 ? '' : 's'}`}>⑂ {card.forksCount}</span>}
          <PlacementChips placements={placements} className="px-1 py-0.5 text-[10px] font-semibold" />
          <span className={badge}>{formatLabel(card.sourceFormat, card.specVersion)}</span>
        </div>
      </div>

      {/* Quick actions - revealed on hover (always visible on touch screens) */}
      <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 flex-col gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
        <SendMenu cardId={card.id} placements={placements} variant="icon" />
        <button onClick={handleQuickExport} disabled={exporting} title={card.imagePath ? 'Download PNG' : 'Download JSON'}
          className="flex h-7 w-7 items-center justify-center rounded-md bg-black/70 text-white hover:bg-nebula disabled:opacity-60">
          <DownloadIcon className={cn('h-3.5 w-3.5', exporting && 'animate-pulse')} />
        </button>
      </div>

      {/* Info panel */}
      <div className={cn('absolute inset-x-0 bottom-0 bg-black/75 backdrop-blur-sm', small ? 'px-2 py-1.5' : 'px-2.5 py-2')}>
        <h3 className={cn('truncate font-semibold leading-tight text-white group-hover:text-nebula', small ? 'text-[12px]' : 'text-[13px]')}>{card.name}</h3>
        <p className="truncate text-[11px] leading-tight text-white/60">by {card.creator}</p>

        {!small && card.tags.length > 0 && (
          <div className="mt-1.5 flex gap-1 overflow-hidden">
            {card.tags.slice(0, maxTags).map((tag) => (
              <Link key={tag.id} href={`/?tags=${encodeURIComponent(tag.name)}`} onClick={(e: React.MouseEvent) => e.stopPropagation()}
                className="shrink-0 whitespace-nowrap rounded bg-aurora/20 px-1.5 py-px text-[10px] font-medium text-blue-200 hover:bg-nebula/40">
                {tag.name}
              </Link>
            ))}
            {card.tags.length > maxTags && <span className="shrink-0 rounded bg-white/10 px-1.5 py-px text-[10px] font-medium text-white/70">+{card.tags.length - maxTags}</span>}
          </div>
        )}

        <div className={cn('flex items-center gap-1.5 whitespace-nowrap text-[11px] text-white/60', small ? 'mt-1' : 'mt-1.5')}>
          {features.social ? (<>
            <span className={cn('flex items-center gap-0.5 font-medium', card.score >= 0 ? 'text-aurora' : 'text-red-400')}>
              <ThumbsUpIcon className="h-3 w-3" />{card.score >= 0 ? '+' : ''}{card.score}
            </span>
            <span className="flex items-center gap-0.5"><DownloadIcon className="h-3 w-3" />{formatCount(card.downloadsCount)}</span>
            <button onClick={handleFavoriteClick} disabled={!user || isTogglingFavorite}
              className={cn('flex items-center gap-0.5 transition-colors', user ? 'cursor-pointer hover:text-pink-400' : 'cursor-default', isFavorited && 'text-pink-400')}
              title={user ? (isFavorited ? 'Remove from favorites' : 'Add to favorites') : 'Login to favorite'}>
              <HeartIcon className="h-3 w-3" filled={isFavorited} />{formatCount(favoritesCount)}
            </button>
          </>) : (<>
            <FavoriteButton cardId={card.id} initial={card.isFavorited ?? false} className="relative z-10 -m-1 p-1" iconClassName="h-3 w-3" />
            {isNsfw && <span className="text-orange-400" title="NSFW">🔥</span>}
            <span className="min-w-0 truncate" title="Last edited">{formatRelative(card.updatedAt)}</span>
          </>)}
          {card.tokensTotal !== null && <span className="ml-auto shrink-0 tabular-nums text-amber-300" title="Tokens">{formatCount(card.tokensTotal)} tk</span>}
        </div>
      </div>
    </Wrapper>
  );
}
