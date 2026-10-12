'use client';

import { useState, useEffect } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Button, CoinIcon, ThumbsUpIcon, ThumbsDownIcon, MetadataBadge } from '@/components/ui';
import type { CardDetail, SourceFormat } from '@/types/card';
import { useAuth } from '@/lib/auth/context';
import { useSettings } from '@/lib/settings';
import { cn } from '@/lib/utils/cn';
import { features } from '@/lib/features';
import type { ExportFormat } from '@/lib/unity';
import { SendMenu } from '@/components/chat/send-menu';
import { DeleteCardButton, FollowButton } from '@/components/cards/card-actions';
import { useNavigate } from 'react-router';

// Format badge component
function FormatBadge({ format, specVersion, className }: { format: SourceFormat; specVersion: string; className?: string }) {
  const isPackage = format === 'charx' || format === 'voxta';
  const label = isPackage ? format.toUpperCase() : specVersion.toUpperCase();

  const colorClasses = {
    charx: 'bg-amber-500 text-white',
    voxta: 'bg-purple-500 text-white',
    v2: 'bg-blue-500 text-white',
    v3: 'bg-emerald-500 text-white',
  };

  const colorClass = isPackage
    ? colorClasses[format as 'charx' | 'voxta']
    : colorClasses[specVersion as 'v2' | 'v3'] || 'bg-gray-500 text-white';

  return (
    <span className={cn('px-2 py-0.5 rounded text-xs font-semibold uppercase', colorClass, className)}>
      {label}
    </span>
  );
}

interface CardHeroProps {
  card: CardDetail;
  permanentTokens: number;
  tokensReady: boolean;
  onDownload: (format: ExportFormat) => void;
  onFork: () => void;
  forking: boolean;
  parent: { id: string; name: string } | null;
}

type CardVisibility = 'public' | 'private' | 'unlisted' | 'nsfw_only' | 'blocked';

const VISIBILITY_OPTIONS: { value: CardVisibility; label: string; icon: string }[] = [
  { value: 'public', label: 'Public', icon: '🌐' },
  { value: 'unlisted', label: 'Unlisted', icon: '🔗' },
  { value: 'private', label: 'Private', icon: '🔒' },
];

function VisibilityBadge({ visibility }: { visibility: CardVisibility }) {
  const config: Record<CardVisibility, { label: string; className: string; icon: string }> = {
    public: { label: 'Public', className: 'bg-green-500/20 text-green-400', icon: '🌐' },
    private: { label: 'Private', className: 'bg-red-500/20 text-red-400', icon: '🔒' },
    unlisted: { label: 'Unlisted', className: 'bg-yellow-500/20 text-yellow-400', icon: '🔗' },
    nsfw_only: { label: 'NSFW Only', className: 'bg-pink-500/20 text-pink-400', icon: '🔞' },
    blocked: { label: 'Blocked', className: 'bg-gray-500/20 text-gray-400', icon: '⛔' },
  };
  const { label, className, icon } = config[visibility] || config.public;
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${className}`}>
      {icon} {label}
    </span>
  );
}

export function CardHero({ card, permanentTokens, tokensReady, onDownload, onFork, forking, parent }: CardHeroProps) {
  const { user } = useAuth();
  const { settings } = useSettings();
  const navigate = useNavigate();
  const [isFavorited, setIsFavorited] = useState(false);
  const [favoritesCount, setFavoritesCount] = useState(card.favoritesCount);
  const [isTogglingFavorite, setIsTogglingFavorite] = useState(false);
  const [currentVisibility, setCurrentVisibility] = useState<CardVisibility>(card.visibility);
  const [isEditingVisibility, setIsEditingVisibility] = useState(false);
  const [isUpdatingVisibility, setIsUpdatingVisibility] = useState(false);

  const isOwner = user && card.uploader?.id === user.id;

  // Check if card has NSFW tag
  const isNsfw = card.tags.some(tag => tag.slug === 'nsfw');
  const shouldBlur = settings.blurNsfwContent && isNsfw;

  useEffect(() => {
    if (user && card) {
      fetch(`/api/cards/${card.slug}/favorite`)
        .then(res => res.json())
        .then(data => {
          if (data.data?.isFavorited !== undefined) {
            setIsFavorited(data.data.isFavorited);
          }
        })
        .catch(() => {});
    }
  }, [user, card]);

  const handleFavoriteClick = async () => {
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

  const handleVisibilityChange = async (newVisibility: CardVisibility) => {
    if (newVisibility === currentVisibility) {
      setIsEditingVisibility(false);
      return;
    }

    setIsUpdatingVisibility(true);
    try {
      const res = await fetch(`/api/cards/${card.slug}/visibility`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visibility: newVisibility }),
      });

      if (res.ok) {
        setCurrentVisibility(newVisibility);
        setIsEditingVisibility(false);
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to update visibility');
      }
    } catch {
      alert('An error occurred while updating visibility');
    } finally {
      setIsUpdatingVisibility(false);
    }
  };

  return (
    <div className="relative rounded-xl overflow-hidden mb-4" data-card-hero>
      <div className="absolute inset-0 bg-gradient-to-r from-deep-space via-deep-space/80 to-transparent z-10" data-card-hero-overlay />

      {(card.thumbnailPath || card.imagePath) && (
        <div className="absolute inset-0" data-card-hero-bg>
          <Image
            src={card.thumbnailPath || card.imagePath!}
            alt=""
            fill
            className="object-cover opacity-30 blur-sm"
          />
        </div>
      )}

      <div className="relative z-20 flex flex-col md:flex-row gap-6 p-6" data-card-hero-content>
        {/* Card image */}
        <div className="flex-shrink-0" data-card-image-container>
          <div className="relative w-52 h-72 rounded-lg overflow-hidden border-2 border-nebula/30 shadow-xl group" data-card-image>
            {(card.thumbnailPath || card.imagePath) ? (
              <Image
                src={card.thumbnailPath || card.imagePath!}
                alt={card.name}
                fill
                className={cn(
                  'object-cover transition-all duration-300',
                  shouldBlur && 'blur-xl'
                )}
                priority
              />
            ) : (
              <div className="w-full h-full bg-cosmic-teal/50 flex items-center justify-center">
                <Image
                  src="/ca-logo.svg"
                  alt="Character Archives"
                  width={160}
                  height={160}
                  className="opacity-40"
                />
              </div>
            )}
          </div>
        </div>

        {/* Card info */}
        <div className="flex-1 flex flex-col" data-card-info>
          <div className="flex-1">
            <h1 className="text-3xl font-bold gradient-text mb-1" data-card-name>{card.name}</h1>

            {card.creator && (
              <div className="mb-2 text-sm" data-card-creator>
                <Link href={`/explore?search=${encodeURIComponent(`creator:"${card.creator}"`)}`} className="text-starlight/60 hover:text-nebula">
                  by <span className="text-nebula">{card.creator}</span>
                </Link>
                <FollowButton creator={card.creator} />
              </div>
            )}

            <p className="text-starlight/70 text-sm mb-3 line-clamp-2" data-card-description>
              {card.description || 'No description provided.'}
            </p>

            {/* Tags */}
            {card.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-4" data-card-tags>
                {card.tags.map((tag) => (
                  <Link
                    key={tag.id}
                    href={`/explore?tags=${tag.slug}`}
                    className="text-xs px-2 py-1 rounded-full bg-nebula/20 text-nebula hover:bg-nebula/30 transition-colors"
                  >
                    {tag.name}
                  </Link>
                ))}
              </div>
            )}

            {/* Fork origin */}
            {parent && (
              <Link
                href={`/card/${parent.id}`}
                className="flex items-center gap-2 mb-4 px-3 py-2 rounded-lg bg-nebula/10 border border-nebula/30 hover:bg-nebula/20 transition-colors w-fit"
              >
                <span className="text-xs text-starlight/60">Forked from</span>
                <span className="text-sm text-nebula font-medium">{parent.name}</span>
              </Link>
            )}

            {/* Collection banner */}
            {card.collectionId && card.collectionSlug && (
              <Link
                href={`/collection/${card.collectionSlug}`}
                className="flex items-center gap-2 mb-4 px-3 py-2 rounded-lg bg-nebula/20 border border-nebula/30 hover:bg-nebula/30 transition-colors group"
              >
                <svg className="w-5 h-5 text-nebula" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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

            {/* Voting controls + Stats row */}
            <div className="flex flex-wrap items-center gap-4 mb-4 p-3 rounded-lg bg-deep-space/50" data-card-stats>
              {features.social && (<>
              {/* Voting buttons - restructured with icons and counts */}
              <div className="flex items-center gap-3">
                {/* Upvote button with count */}
                <div className="flex flex-col items-center">
                  <button className="p-2 rounded-lg hover:bg-aurora/20 text-starlight/60 hover:text-aurora transition-colors">
                    <ThumbsUpIcon className="w-5 h-5" />
                  </button>
                  <span className="text-xs text-aurora">+{card.upvotes}</span>
                </div>

                {/* Score in middle */}
                <span className={`font-bold text-xl ${card.score >= 0 ? 'text-aurora' : 'text-red-400'}`}>
                  {card.score >= 0 ? '+' : ''}{card.score}
                </span>

                {/* Downvote button with count */}
                <div className="flex flex-col items-center">
                  <button className="p-2 rounded-lg hover:bg-red-400/20 text-starlight/60 hover:text-red-400 transition-colors">
                    <ThumbsDownIcon className="w-5 h-5" />
                  </button>
                  <span className="text-xs text-red-400">-{card.downvotes}</span>
                </div>
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

              {/* Downloads count */}
              <div className="flex items-center gap-1.5 text-starlight/60">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                <span>{card.downloadsCount.toLocaleString()}</span>
              </div>
              </>)}

              <FormatBadge format={card.sourceFormat} specVersion={card.specVersion} />
              {card.isFork && <span className="px-2 py-0.5 rounded text-xs font-semibold bg-nebula text-white">FORK</span>}
              <span className="text-xs text-starlight/60" title="Saved revisions">Revision {card.revisionCount}</span>

              {/* Feature indicators - using shared MetadataBadge */}
              <MetadataBadge type="greetings" count={card.totalGreetingsCount} variant="full" />
              <MetadataBadge type="lorebook" count={card.lorebookEntriesCount} variant="full" />
              <MetadataBadge type="images" count={card.embeddedImagesCount} variant="full" />
              <MetadataBadge type="assets" count={card.assetsCount} variant="full" />

              {/* Spacer to push visibility to end */}
              <div className="flex-1" />

              {features.social && (<>
              {/* Visibility badge with edit dropdown - moved to end */}
              <div className="relative">
                {isOwner && !isEditingVisibility ? (
                  <button
                    onClick={() => setIsEditingVisibility(true)}
                    className="flex items-center gap-1 hover:opacity-80 transition-opacity"
                    title="Click to change visibility"
                  >
                    <VisibilityBadge visibility={currentVisibility} />
                    <svg className="w-3 h-3 text-starlight/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                    </svg>
                  </button>
                ) : isOwner && isEditingVisibility ? (
                  <div className="flex items-center gap-2">
                    <select
                      value={currentVisibility}
                      onChange={(e) => handleVisibilityChange(e.target.value as CardVisibility)}
                      disabled={isUpdatingVisibility}
                      className="px-2 py-1 text-xs bg-deep-space border border-nebula/30 rounded text-starlight"
                    >
                      {VISIBILITY_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.icon} {opt.label}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => setIsEditingVisibility(false)}
                      className="text-starlight/50 hover:text-starlight"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ) : (
                  <VisibilityBadge visibility={currentVisibility} />
                )}
              </div>
              </>)}
            </div>

            {/* Action buttons */}
            <div className="flex flex-wrap gap-2" data-card-actions>
              <Link href={`/card/${card.slug}/edit`}>
                <Button variant="primary" size="sm">
                  <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                  Edit
                </Button>
              </Link>
              <Button variant="secondary" size="sm" onClick={onFork} disabled={forking} title="Make your own copy to edit; this card stays unchanged">
                <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 3v12m0 0a3 3 0 103 3m-3-3a3 3 0 013 3m0 0h3a6 6 0 006-6V9m0 0a3 3 0 10-3-3 3 3 0 003 3z" />
                </svg>
                {forking ? 'Forking…' : 'Fork'}
              </Button>
              <SendMenu cardId={card.id} />
              <Button variant="secondary" size="sm" onClick={() => onDownload('png')}>
                <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Download PNG
              </Button>
              <Button variant="secondary" size="sm" onClick={() => onDownload('json')}>
                Export JSON
              </Button>
              <Button variant="secondary" size="sm" onClick={() => onDownload('charx')}>
                Export CharX
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onDownload('sillytavern-png')} title="PNG shaped for SillyTavern import">
                SillyTavern PNG
              </Button>
              <DeleteCardButton cardId={card.id} name={card.name} onDeleted={() => navigate('/')} />
            </div>
          </div>
        </div>

        {/* Token Breakdown - Right side box */}
        <div className="flex-shrink-0 w-full md:w-56" data-card-tokens-container>
          <div className="glass rounded-lg p-4 border border-nebula/20" data-card-tokens>
            <h3 className="text-sm font-semibold text-starlight/80 mb-3 flex items-center gap-2">
              <CoinIcon className="w-4 h-4 text-solar" />
              Token Breakdown
            </h3>
            <div className="space-y-2 text-xs">
              {!tokensReady && <p className="text-starlight/40">Counting…</p>}
              <div className="flex justify-between">
                <span className="text-starlight/50">Description</span>
                <span>{card.tokens.description.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-starlight/50">Personality</span>
                <span>{card.tokens.personality.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-starlight/50">Scenario</span>
                <span>{card.tokens.scenario.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-starlight/50">First Message</span>
                <span>{card.tokens.firstMes.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-starlight/50">Examples</span>
                <span>{card.tokens.mesExample.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-starlight/50">System Prompt</span>
                <span>{card.tokens.systemPrompt.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-starlight/50">Post History</span>
                <span>{card.tokens.postHistory.toLocaleString()}</span>
              </div>
              <div className="border-t border-nebula/20 pt-2 mt-2">
                <div className="flex justify-between font-semibold">
                  <span className="text-nebula">Total</span>
                  <span className="text-nebula">{card.tokens.total.toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-starlight/40 mt-1">
                  <span>Permanent</span>
                  <span>{permanentTokens.toLocaleString()}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
