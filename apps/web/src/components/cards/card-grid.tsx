'use client';

import { CardItem } from './card-item';
import type { CardListItem } from '@/types/card';
import { useSettings } from '@/lib/settings';
import { cn } from '@/lib/utils/cn';

interface CardGridProps {
  cards: CardListItem[];
  isLoading?: boolean;
  onQuickView?: (card: CardListItem) => void;
}

export function CardGrid({ cards = [], isLoading, onQuickView }: CardGridProps) {
  const { settings } = useSettings();

  // Fewer columns for larger cards
  const gridClasses = settings.cardSize === 'large'
    ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4'
    : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5';

  if (isLoading && cards.length === 0) {
    return (
      <div className={cn('grid gap-6', gridClasses)}>
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
    <div className={cn('grid gap-6', gridClasses)}>
      {cards.map((card) => (
        <CardItem key={card.id} card={card} onQuickView={onQuickView} />
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
