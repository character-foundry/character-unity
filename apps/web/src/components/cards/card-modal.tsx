'use client';

import { useState, useEffect } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Modal, ModalBody, Button, CoinIcon, MetadataBadge } from '@/components/ui';
import type { CardListItem, SourceFormat } from '@/types/card';
import { useAuth } from '@/lib/auth/context';
import { cn } from '@/lib/utils/cn';
import { formatDate, stripHtml } from '@/lib/utils/format';
import { useSettings } from '@/lib/settings';
import { features } from '@/lib/features';
import { PlacementChips, SendMenu } from '@/components/chat/send-menu';
import type { ChatPlacement } from '@/lib/chat';

// Format badge component
function FormatBadge({ format, specVersion, className }: { format: SourceFormat; specVersion: string; className?: string }) {
  const isPackage = format === 'charx' || format === 'voxta';
  const label = isPackage ? format.toUpperCase() : specVersion.toUpperCase();

  const colorClasses = {
    charx: 'bg-amber-500/80 text-white',
    voxta: 'bg-purple-500/80 text-white',
    v2: 'bg-blue-500/80 text-white',
    v3: 'bg-emerald-500/80 text-white',
  };

  const colorClass = isPackage
    ? colorClasses[format as 'charx' | 'voxta']
    : colorClasses[specVersion as 'v2' | 'v3'] || 'bg-gray-500/80 text-white';

  return (
    <span className={cn('px-2 py-0.5 rounded text-xs font-semibold uppercase', colorClass, className)}>
      {label}
    </span>
  );
}

interface CardModalProps {
  card: CardListItem | null;
  isOpen: boolean;
  onClose: () => void;
  placements?: ChatPlacement[] | undefined;
}

export function CardModal({ card, isOpen, onClose, placements }: CardModalProps) {
  const { user } = useAuth();
  const { settings } = useSettings();
  const [isFavorited, setIsFavorited] = useState(false);
  const [favoritesCount, setFavoritesCount] = useState(0);
  const [isTogglingFavorite, setIsTogglingFavorite] = useState(false);

  // Check if card has NSFW tag
  const isNsfw = card?.tags.some(tag => tag.slug === 'nsfw') ?? false;
  const shouldBlur = settings.blurNsfwContent && isNsfw;

  useEffect(() => {
    if (card) {
      setFavoritesCount(card.favoritesCount);
      // Use isFavorited from card data (API returns it for authenticated users)
      // Only fetch if not present (fallback for older cached data)
      if (card.isFavorited !== undefined) {
        setIsFavorited(card.isFavorited);
      } else if (user) {
        setIsFavorited(false);
        fetch(`/api/cards/${card.slug}/favorite`)
          .then(res => res.json())
          .then(data => {
            if (data.data?.isFavorited !== undefined) {
              setIsFavorited(data.data.isFavorited);
            }
          })
          .catch(() => {});
      } else {
        setIsFavorited(false);
      }
    }
  }, [card, user]);

  if (!card) return null;

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

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl">
      <ModalBody className="p-0">
        <div className="flex flex-col lg:flex-row">
          {/* Left side - Image */}
          <div className="relative w-full lg:w-2/5 aspect-[3/4] lg:aspect-auto lg:min-h-[660px] flex-shrink-0 group">
            {(card.thumbnailPath || card.imagePath) ? (
              <Image
                src={card.thumbnailPath || card.imagePath!}
                alt={card.name}
                fill
                className={cn(
                  'object-cover rounded-t-2xl lg:rounded-l-2xl lg:rounded-tr-none transition-all duration-300',
                  shouldBlur && 'blur-xl'
                )}
              />
            ) : (
              <div className="w-full h-full bg-cosmic-teal/50 flex items-center justify-center rounded-t-2xl lg:rounded-l-2xl lg:rounded-tr-none">
                <span className="text-8xl text-starlight/30">?</span>
              </div>
            )}
          </div>

          {/* Right side - Content */}
          <div className="flex-1 p-6 space-y-5 overflow-y-auto max-h-[660px] lg:max-h-none">
            {/* Header with close button */}
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-2xl font-bold gradient-text">{card.name}</h2>
                {card.creator && (
                  <Link
                    href={`/explore?search=${encodeURIComponent(`creator:"${card.creator}"`)}`}
                    className="text-sm text-starlight/60 hover:text-nebula mt-1 block"
                    onClick={onClose}
                  >
                    by <span className="text-nebula">{card.creator}</span>
                  </Link>
                )}
              </div>
              <button
                onClick={onClose}
                className="text-starlight/60 hover:text-starlight text-2xl leading-none p-1 -mt-1"
              >
                &times;
              </button>
            </div>

            {/* TODO: Tagline field - will replace description here */}

            {/* Tags */}
            {card.tags.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {card.tags.map((tag) => (
                  <Link
                    key={tag.id}
                    href={`/explore?tags=${tag.slug}`}
                    onClick={onClose}
                    className="text-xs px-2 py-1 rounded-full bg-nebula/20 text-nebula hover:bg-nebula/30 transition-colors"
                  >
                    {tag.name}
                  </Link>
                ))}
              </div>
            )}

            {/* Collection banner */}
            {card.collectionId && card.collectionSlug && (
              <Link
                href={`/collection/${card.collectionSlug}`}
                onClick={onClose}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-nebula/20 border border-nebula/30 hover:bg-nebula/30 transition-colors group"
              >
                <svg className="w-4 h-4 text-nebula" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
                <div className="flex-1">
                  <span className="text-xs text-starlight/60">Part of collection</span>
                  <p className="text-sm text-nebula font-medium group-hover:text-aurora transition-colors">
                    {card.collectionName || 'View Collection'}
                  </p>
                </div>
                <svg className="w-4 h-4 text-nebula/60 group-hover:text-nebula transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </Link>
            )}

            {/* Stats row (read-only, no voting buttons) */}
            <div className="flex items-center flex-wrap gap-3 p-3 rounded-lg bg-deep-space/50">
              {features.social && (<>
              {/* Score display */}
              <div className="flex items-center gap-2">
                <svg className="w-5 h-5 text-starlight/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5" />
                </svg>
                <span className={`font-bold ${card.score >= 0 ? 'text-aurora' : 'text-red-400'}`}>
                  {card.score >= 0 ? '+' : ''}{card.score}
                </span>
              </div>

              <div className="w-px h-6 bg-nebula/20" />

              {/* Favorites - interactive */}
              <button
                onClick={handleFavoriteClick}
                disabled={!user || isTogglingFavorite}
                className={cn(
                  'flex items-center gap-1.5 transition-colors',
                  user ? 'hover:text-pink-400 cursor-pointer' : 'cursor-default',
                  isFavorited ? 'text-pink-400' : 'text-starlight/60'
                )}
                title={user ? (isFavorited ? 'Remove from favorites' : 'Add to favorites') : 'Login to favorite'}
              >
                <svg
                  className="w-5 h-5"
                  fill={isFavorited ? 'currentColor' : 'none'}
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                </svg>
                <span>{favoritesCount}</span>
              </button>

              <div className="w-px h-6 bg-nebula/20" />

              {/* Downloads */}
              <div className="flex items-center gap-1.5 text-starlight/60">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                <span>{card.downloadsCount.toLocaleString()}</span>
              </div>

              <div className="w-px h-6 bg-nebula/20" />

              <div className="w-px h-6 bg-nebula/20" />
              </>)}

              {/* Format badge */}
              <FormatBadge format={card.sourceFormat} specVersion={card.specVersion} />

              {card.tokensTotal !== null && (<>
              <div className="w-px h-6 bg-nebula/20" />

              {/* Token count with coin icon */}
              <div className="flex items-center gap-1.5 text-starlight/60">
                <CoinIcon className="w-5 h-5 text-solar" />
                <span className="font-medium">{card.tokensTotal.toLocaleString()}</span>
              </div>
              </>)}

              {card.isFork && (<>
              <div className="w-px h-6 bg-nebula/20" />
              <span className="px-2 py-0.5 rounded text-xs font-semibold bg-nebula/80 text-white">FORK</span>
              </>)}
              {card.forksCount > 0 && (<>
              <div className="w-px h-6 bg-nebula/20" />
              <span className="text-starlight/60 text-sm">{card.forksCount} fork{card.forksCount === 1 ? '' : 's'}</span>
              </>)}
            </div>

            {/* Metadata badges - using shared MetadataBadge */}
            <div className="flex flex-wrap gap-2">
              <MetadataBadge type="greetings" count={card.totalGreetingsCount} variant="full" />
              <MetadataBadge type="lorebook" count={card.lorebookEntriesCount} variant="full" />
              <MetadataBadge type="images" count={card.embeddedImagesCount} variant="full" />
              <MetadataBadge type="assets" count={card.assetsCount} variant="full" />
            </div>

            {/* Creator notes preview */}
            {card.creatorNotes && (
              <div>
                <h4 className="font-semibold mb-2 text-sm text-starlight/70">Creator Notes</h4>
                <p className="text-starlight/60 text-sm line-clamp-4 bg-deep-space/30 p-3 rounded">
                  {stripHtml(card.creatorNotes)}
                </p>
              </div>
            )}

            {/* Dates */}
            <div className="flex gap-4 text-xs text-starlight/50">
              <div>
                <span>Added: </span>
                <span className="text-starlight/70">{formatDate(card.createdAt)}</span>
              </div>
              {card.updatedAt !== card.createdAt && (
                <div>
                  <span>Last edited: </span>
                  <span className="text-starlight/70">{formatDate(card.updatedAt)}</span>
                </div>
              )}
            </div>

            {/* View full profile button */}
            <div className="pt-2 space-y-2">
              <Link href={`/card/${card.slug}`} className="block">
                <Button variant="secondary" className="w-full">
                  View Full Profile
                </Button>
              </Link>
              <Link href={`/card/${card.slug}/edit`} className="block">
                <Button variant="primary" className="w-full">
                  Edit
                </Button>
              </Link>
              <div className="flex items-center gap-2">
                <SendMenu cardId={card.id} placements={placements} variant="wide" className="flex-1" />
                <PlacementChips placements={placements} />
              </div>
            </div>
          </div>
        </div>
      </ModalBody>
    </Modal>
  );
}
