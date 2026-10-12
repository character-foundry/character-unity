'use client';

import { CardItem } from './card-item';
import type { CardListItem } from '@/types/card';
import { useSettings } from '@/lib/settings';
import { cn } from '@/lib/utils/cn';
import type { ChatPlacement } from '@/lib/chat';

interface CardGridProps {
  cards: CardListItem[];
  isLoading?: boolean;
  onQuickView?: (card: CardListItem) => void;
  /** Chat app copies by card ID, for presence chips and quick send. */
  placements?: Map<string, ChatPlacement[]>;
}

export function CardGrid({ cards = [], isLoading, onQuickView, placements }: CardGridProps) {
  const { settings } = useSettings();

  // Fewer columns for larger cards
  const gridClasses = settings.cardSize === 'large'
    ? 'grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5'
    : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6';

  if (isLoading && cards.length === 0) {
    return (
      <div className={cn('grid gap-4', gridClasses)}>
        {Array.from({ length: 8 }).map((_, i) => (
          <CardSkeleton key={i} isLarge={settings.cardSize === 'large'} />
        ))}
      </div>
    );
  }

  if (cards.length === 0) {
    return (
      <div className="text-center py-16">
        <div className="text-6xl mb-4">🔍</div>
        <h3 className="text-xl font-semibold mb-2">No cards found</h3>
        <p className="text-starlight/60">
          Try adjusting your filters or search terms
        </p>
      </div>
    );
  }

  return (
    <div className={cn('grid gap-4', gridClasses)}>
      {cards.map((card) => (
        <CardItem key={card.id} card={card} onQuickView={onQuickView} placements={placements?.get(card.id)} />
      ))}
    </div>
  );
}

function CardSkeleton({ isLarge = false }: { isLarge?: boolean }) {
  return (
    <div className="glass-card rounded-xl overflow-hidden animate-pulse">
      <div className={cn(
        'bg-cosmic-teal/50',
        isLarge ? 'aspect-[3/4.5]' : 'aspect-[3/4]'
      )} />
      <div className="p-3 space-y-2">
        <div className="h-4 bg-cosmic-teal/50 rounded w-3/4" />
        <div className="h-3 bg-cosmic-teal/50 rounded w-1/2" />
      </div>
    </div>
  );
}
