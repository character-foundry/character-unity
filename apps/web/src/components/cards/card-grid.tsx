'use client';

import { CardItem } from './card-item';
import type { CardListItem } from '@/types/card';
import { useSettings } from '@/lib/settings';
import type { UserSettings } from '@/lib/settings';
import { cn } from '@/lib/utils/cn';
import type { ChatPlacement } from '@/lib/chat';

interface CardGridProps {
  cards: CardListItem[];
  isLoading?: boolean;
  onQuickView?: (card: CardListItem) => void;
  /** Chat app copies by card ID, for presence chips and quick send. */
  placements?: Map<string, ChatPlacement[]>;
}

/** Columns fill the width; the card size from the filter bar sets the narrowest tile. */
const columns: Record<UserSettings['cardSize'], string> = {
  large: 'grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3',
  medium: 'grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5',
  small: 'grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-2',
};

export function CardGrid({ cards = [], isLoading, onQuickView, placements }: CardGridProps) {
  const { settings } = useSettings();

  if (isLoading && cards.length === 0) {
    return (
      <div className={cn('grid', columns[settings.cardSize])}>
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="aspect-[3/4] animate-pulse rounded-lg bg-cosmic-teal ring-1 ring-nebula/15" />
        ))}
      </div>
    );
  }

  if (cards.length === 0) {
    return <div className="py-16 text-center text-sm text-starlight/50">No cards found</div>;
  }

  return (
    <div className={cn('grid', columns[settings.cardSize])}>
      {cards.map((card) => (
        <CardItem key={card.id} card={card} size={settings.cardSize} onQuickView={onQuickView} placements={placements?.get(card.id)} />
      ))}
    </div>
  );
}
