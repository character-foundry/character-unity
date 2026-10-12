'use client';

import { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import type { CardListItem, SourceFormat } from '@/types/card';
import { useSettings } from '@/lib/settings';
import { useAuth } from '@/lib/auth/context';
import { features } from '@/lib/features';
import { cn } from '@/lib/utils/cn';
import { formatCount, formatRelative } from '@/lib/utils/format';
import { CoinIcon, ThumbsUpIcon, DownloadIcon, HeartIcon, MetadataBadge } from '@/components/ui';
import { PlacementChips, SendMenu } from '@/components/chat/send-menu';
import { FavoriteButton } from './card-actions';
import type { ChatPlacement } from '@/lib/chat';
import { downloadExport } from '@/lib/unity';
import { buildCardExportFilename } from '@/lib/utils';

// Format badge component - matches the style of other top row badges
function FormatBadge({ format, specVersion }: { format: SourceFormat; specVersion: string }) {
  // Determine what to display based on source format
  // charx/voxta show the package format, png/json show the spec version
  const isPackage = format === 'charx' || format === 'voxta';
  const label = isPackage ? format.toUpperCase() : specVersion.toUpperCase();

  return (
    <div className="px-1.5 py-0.5 rounded bg-black/60 text-xs text-starlight/80">
      {label}
    </div>
  );
}

// Check if a card is "new" (uploaded within last 7 days)
function isNewCard(createdAt: number): boolean {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return createdAt > sevenDaysAgo;
}

interface CardItemProps {
  card: CardListItem;
  onQuickView?: (card: CardListItem) => void;
  placements?: ChatPlacement[] | undefined;
}

export function CardItem({ card, onQuickView, placements }: CardItemProps) {
  const { settings } = useSettings();
  const { user } = useAuth();
  // Initialize from card data (API returns isFavorited for authenticated users)
  const [isFavorited, setIsFavorited] = useState(card.isFavorited ?? false);
  const [favoritesCount, setFavoritesCount] = useState(card.favoritesCount);
  const [isTogglingFavorite, setIsTogglingFavorite] = useState(false);

  // Check if card has NSFW tag
  const isNsfw = card.tags.some(tag => tag.slug === 'nsfw');
  const shouldBlur = settings.blurNsfwContent && isNsfw;

  // Only intercept click when onQuickView is provided (modal mode)
  const handleClick = onQuickView ? (e: React.MouseEvent) => {
    e.preventDefault();
    onQuickView(card);
  } : undefined;

  const handleCreatorClick = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  const handleTagClick = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  const handleFavoriteClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();

    if (!user || isTogglingFavorite) return;

    setIsTogglingFavorite(true);
    try {
      const response = await fetch(`/api/cards/${card.slug}/favorite`, {
        method: 'POST',
      });

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

  const [exporting, setExporting] = useState(false);
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
    ? { onClick: handleClick }
    : { href: `/card/${card.slug}` };

  return (
    <Wrapper
      {...wrapperProps}
      className={cn(
        'glass-card rounded-xl overflow-hidden group cursor-pointer transition-transform hover:scale-[1.02]',
        settings.cardSize === 'large' ? 'aspect-[3/4.5]' : 'aspect-[3/4]'
      )}
    >
      {/* Image container - fills entire card */}
      <div className="relative overflow-hidden w-full h-full">
        {(card.thumbnailPath || card.imagePath) ? (
          <Image
            src={card.thumbnailPath || card.imagePath!}
            alt={card.name}
            fill
            className={cn(
              'object-cover transition-all duration-300 group-hover:scale-105',
              shouldBlur && 'blur-xl'
            )}
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
          />
        ) : (
          <div className="w-full h-full bg-cosmic-teal/50 flex items-center justify-center">
            <Image
              src="/ca-logo.svg"
              alt="Character Archives"
              width={120}
              height={120}
              className="opacity-40"
            />
          </div>
        )}

        {/* Overlay gradient */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-transparent" />

        {/* Metadata icons - top left - using shared MetadataBadge */}
        <div className="absolute top-2 left-2 flex flex-wrap gap-1">
          <MetadataBadge type="greetings" count={card.totalGreetingsCount} variant="compact" />
          <MetadataBadge type="lorebook" count={card.lorebookEntriesCount} variant="compact" />
          <MetadataBadge type="images" count={card.embeddedImagesCount} variant="compact" />
          <MetadataBadge type="assets" count={card.assetsCount} variant="compact" />
        </div>

        {/* Format badge and collection badge - top right */}
        <div className="absolute top-2 right-2 flex flex-col items-end gap-1">
          <FormatBadge format={card.sourceFormat} specVersion={card.specVersion} />
          {card.isFork && (
            <div className="px-1.5 py-0.5 rounded bg-nebula/80 text-xs text-white font-medium" title="Your edited fork">FORK</div>
          )}
          <PlacementChips placements={placements} />
          {card.forksCount > 0 && (
            <div className="px-1.5 py-0.5 rounded bg-black/60 text-xs text-starlight/80" title={`${card.forksCount} fork${card.forksCount === 1 ? '' : 's'}`}>⑂ {card.forksCount}</div>
          )}
          {card.collectionId && card.collectionSlug && (
            <Link
              href={`/collection/${card.collectionSlug}`}
              onClick={(e) => e.stopPropagation()}
              className="px-1.5 py-0.5 rounded bg-purple-600 text-xs text-white font-medium hover:bg-purple-500 transition-colors"
              title={card.collectionName ? `Part of ${card.collectionName}` : 'Part of a collection'}
            >
              COLLECTION
            </Link>
          )}
        </div>

        {/* Quick actions - revealed on hover (always visible on touch screens) */}
        <div className="absolute right-2 top-1/2 flex -translate-y-1/2 flex-col gap-1.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
          <SendMenu cardId={card.id} placements={placements} variant="icon" />
          <button onClick={handleQuickExport} disabled={exporting} title={card.imagePath ? 'Download PNG' : 'Download JSON'}
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-black/70 text-white hover:bg-nebula disabled:opacity-60">
            <DownloadIcon className={cn('h-4 w-4', exporting && 'animate-pulse')} />
          </button>
        </div>

        {/* Bottom info overlay */}
        <div className="absolute bottom-0 left-0 right-0 p-3">
          {/* Status badges - Processing / NEW / Trending / Following - above character name */}
          {(card.processingStatus === 'pending' || card.processingStatus === 'processing' || card.processingStatus === 'failed' ||
            isNewCard(card.createdAt) || card.feedReason === 'trending' || card.feedReason === 'followed_user') && (
            <div className="flex flex-wrap gap-1 mb-1.5">
              {card.processingStatus === 'pending' && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/90 text-white font-medium animate-pulse">
                  Uploading...
                </span>
              )}
              {card.processingStatus === 'processing' && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/90 text-white font-medium animate-pulse">
                  Processing...
                </span>
              )}
              {card.processingStatus === 'failed' && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/90 text-white font-medium">
                  Failed
                </span>
              )}
              {card.processingStatus !== 'pending' && card.processingStatus !== 'processing' && isNewCard(card.createdAt) && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/90 text-white font-medium">
                  NEW
                </span>
              )}
              {card.feedReason === 'trending' && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/90 text-white font-medium">
                  Trending
                </span>
              )}
              {card.feedReason === 'followed_user' && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/90 text-white font-medium">
                  Following
                </span>
              )}
            </div>
          )}

          {/* Character name */}
          <h3 className="font-bold text-base text-white mb-0.5 line-clamp-1 group-hover:text-nebula transition-colors">
            {card.name}
          </h3>

          {/* Creator name and uploader - clickable */}
          <div className="text-xs text-white/90 line-clamp-1 mb-1.5">
            {card.creator && (
              <span>by {card.creator}</span>
            )}
            {card.uploader && (
              <Link
                href={`/user/${card.uploader.username}`}
                onClick={handleCreatorClick}
                className="hover:text-nebula transition-colors"
              >
                {card.creator ? ` (@${card.uploader.username})` : `by @${card.uploader.username}`}
              </Link>
            )}
          </div>

          {/* Tags - white text for contrast */}
          {card.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              {card.tags.slice(0, 3).map((tag) => (
                <Link
                  key={tag.id}
                  href={`/explore?tags=${tag.slug}`}
                  onClick={handleTagClick}
                  className="text-xs px-1.5 py-0.5 rounded bg-black/50 text-white hover:bg-nebula/50 transition-colors"
                >
                  {tag.name}
                </Link>
              ))}
              {card.tags.length > 3 && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-black/50 text-white/70">
                  +{card.tags.length - 3}
                </span>
              )}
            </div>
          )}

          {/* Stats row - floating over image */}
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              {/* NSFW indicator */}
              {isNsfw && (
                <span className="text-orange-400" title="NSFW">
                  🔥
                </span>
              )}

              {features.social && (<>
              {/* Votes with thumbs up icon */}
              <div className="flex items-center gap-1">
                <ThumbsUpIcon className={cn('w-3.5 h-3.5', card.score >= 0 ? 'text-aurora' : 'text-red-400')} />
                <span className={cn('font-medium', card.score >= 0 ? 'text-aurora' : 'text-red-400')}>
                  {card.score >= 0 ? '+' : ''}{card.score}
                </span>
              </div>

              {/* Downloads */}
              <div className="flex items-center gap-1 text-white/80">
                <DownloadIcon className="w-3.5 h-3.5" />
                <span>{formatCount(card.downloadsCount)}</span>
              </div>

              {/* Favorites - clickable button */}
              <button
                onClick={handleFavoriteClick}
                disabled={!user || isTogglingFavorite}
                className={cn(
                  'flex items-center gap-1 transition-colors',
                  user ? 'hover:text-pink-400 cursor-pointer' : 'cursor-default',
                  isFavorited ? 'text-pink-400' : 'text-white/80'
                )}
                title={user ? (isFavorited ? 'Remove from favorites' : 'Add to favorites') : 'Login to favorite'}
              >
                <HeartIcon className="w-3.5 h-3.5" filled={isFavorited} />
                <span>{formatCount(favoritesCount)}</span>
              </button>
              </>)}
              {!features.social && (<>
                <FavoriteButton cardId={card.id} initial={card.isFavorited ?? false} />
                <span className="text-white/70" title="Last touched">{formatRelative(card.updatedAt)}</span>
              </>)}
            </div>

            {/* Tokens with coin icon */}
            {card.tokensTotal !== null && (
              <div className="flex items-center gap-1 text-white/80">
                <CoinIcon className="w-3.5 h-3.5 text-solar" />
                <span>{formatCount(card.tokensTotal)}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </Wrapper>
  );
}

