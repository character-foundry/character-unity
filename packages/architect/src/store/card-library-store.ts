import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Card } from '../lib/types';
import type { CardListFilter, CardListSort } from '../lib/card-list';

export interface CardLibraryView {
  cards: Card[];
  totalCards: number;
  cachedImages: Map<string, string>;
  searchQuery: string;
  debouncedSearch: string;
  filterBy: CardListFilter;
  sortBy: CardListSort;
  loadedPages: number;
  scrollTop: number;
}

// Keep the library in memory across editor navigation, without persisting card
// payloads to localStorage or replaying every page before restoring the scroll.
export const useCardLibraryStore = create<{ view: CardLibraryView | null }>(() => ({ view: null }));

export const useCardGridPreferences = create(persist<{
  cardsPerRow: number;
  setCardsPerRow: (count: number) => void;
}>((set) => ({
  cardsPerRow: 3,
  setCardsPerRow: (count) => set({ cardsPerRow: Math.max(3, Math.min(5, Math.round(count))) }),
}), { name: 'card-library-preferences' }));
