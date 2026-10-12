import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { localDB } from '../../lib/db';
import { getDeploymentConfig } from '../../config/deployment';
import { queryLocalCards, type CardListFilter, type CardListSort } from '../../lib/card-list';
import type { Card } from '../../lib/types';
import { useCardLibraryStore, type CardLibraryView } from '../../store/card-library-store';

const PAGE_SIZE = 20;

function uniqueCards(cards: Card[]) {
  return [...new Map(cards.map(card => [card.meta.id, card])).values()];
}

export function useCardLibrary() {
  const [initialView] = useState(() => useCardLibraryStore.getState().view);
  const [cards, setCards] = useState(initialView?.cards ?? []);
  const [totalCards, setTotalCards] = useState(initialView?.totalCards ?? 0);
  const [cachedImages, setCachedImages] = useState(initialView?.cachedImages ?? new Map<string, string>());
  const [searchQuery, setSearchQuery] = useState(initialView?.searchQuery ?? '');
  const [debouncedSearch, setDebouncedSearch] = useState(initialView?.debouncedSearch ?? '');
  const [filterBy, setFilterBy] = useState<CardListFilter>(initialView?.filterBy ?? 'all');
  const [sortBy, setSortBy] = useState<CardListSort>(initialView?.sortBy ?? 'edited');
  const [loadedPages, setLoadedPages] = useState(initialView?.loadedPages ?? 1);
  const [loading, setLoading] = useState(!initialView);
  const [loadError, setLoadError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadRevision = useRef(0);
  const busy = useRef(false);
  const failedOperation = useRef<'refresh' | 'more'>('refresh');
  const pagesRef = useRef(loadedPages);
  const config = getDeploymentConfig();
  const isClientMode = config.mode === 'light' || config.mode === 'static';
  const searching = searchQuery.trim() !== debouncedSearch;
  const queryKey = JSON.stringify([debouncedSearch, filterBy, sortBy]);
  const previousQuery = useRef(queryKey);
  const invalidateLoads = useCallback(() => { loadRevision.current++; }, []);

  useEffect(() => {
    if (searchQuery.trim() === debouncedSearch) return;
    const timeout = setTimeout(() => setDebouncedSearch(searchQuery.trim()), 300);
    return () => clearTimeout(timeout);
  }, [searchQuery, debouncedSearch]);

  // Refresh the loaded range after editing/deleting/importing, preserving its
  // height and position while requests are in flight.
  const loadCards = useCallback(async (query = debouncedSearch) => {
    const revision = ++loadRevision.current;
    busy.current = true;
    failedOperation.current = 'refresh';
    setLoading(true);
    setLoadError(null);
    try {
      if (isClientMode) {
        const localCards = await localDB.listCards();
        const images = new Map<string, string>();
        await Promise.all(localCards.map(async card => {
          const image = await localDB.getImage(card.meta.id, 'thumbnail');
          if (image) images.set(card.meta.id, image);
        }));
        if (revision !== loadRevision.current) return;
        setCards(localCards);
        setTotalCards(localCards.length);
        setCachedImages(images);
      } else {
        const responses = await Promise.all(Array.from({ length: pagesRef.current }, (_, index) =>
          api.listCards(query, index + 1, PAGE_SIZE, filterBy === 'favorites', { filter: filterBy, sort: sortBy })
        ));
        if (revision !== loadRevision.current) return;
        const items: Card[] = [];
        for (const response of responses) {
          if (response.error || !response.data) throw new Error(response.error || 'No response from the card library');
          items.push(...response.data.items);
        }
        const total = responses[0].data!.total;
        pagesRef.current = Math.min(pagesRef.current, Math.max(1, Math.ceil(total / PAGE_SIZE)));
        setLoadedPages(pagesRef.current);
        setCards(uniqueCards(items));
        setTotalCards(total);
      }
    } catch (error) {
      if (revision !== loadRevision.current) return;
      console.error('Failed to load cards:', error);
      setLoadError(error instanceof Error ? error.message : 'Failed to load cards');
    } finally {
      if (revision === loadRevision.current) {
        busy.current = false;
        setLoading(false);
      }
    }
  }, [debouncedSearch, filterBy, sortBy, isClientMode]);

  useEffect(() => {
    if (previousQuery.current !== queryKey) {
      previousQuery.current = queryKey;
      pagesRef.current = 1;
      setLoadedPages(1);
      setCards([]);
      setTotalCards(0);
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    }
    void loadCards();
    return invalidateLoads;
  }, [queryKey, loadCards, invalidateLoads]);

  const filteredCards = useMemo(() => isClientMode
    ? queryLocalCards(cards, debouncedSearch, { filter: filterBy, sort: sortBy })
    : cards, [cards, debouncedSearch, filterBy, sortBy, isClientMode]);
  const totalFilteredCards = isClientMode ? filteredCards.length : totalCards;
  const displayedCards = isClientMode ? filteredCards.slice(0, loadedPages * PAGE_SIZE) : cards;
  const hasMore = isClientMode
    ? displayedCards.length < totalFilteredCards
    : loadedPages * PAGE_SIZE < totalFilteredCards;

  const loadMore = useCallback(async () => {
    if (busy.current || searching || !hasMore) return;
    const nextPage = pagesRef.current + 1;
    if (isClientMode) {
      pagesRef.current = nextPage;
      setLoadedPages(nextPage);
      return;
    }
    const revision = ++loadRevision.current;
    busy.current = true;
    failedOperation.current = 'more';
    setLoading(true);
    setLoadError(null);
    try {
      const response = await api.listCards(debouncedSearch, nextPage, PAGE_SIZE, filterBy === 'favorites', { filter: filterBy, sort: sortBy });
      if (revision !== loadRevision.current) return;
      if (response.error || !response.data) throw new Error(response.error || 'No response from the card library');
      // An empty page can occur when cards are removed while browsing.
      // Stop at the known loaded range instead of repeatedly fetching it.
      setTotalCards(response.data.items.length ? response.data.total : cards.length);
      pagesRef.current = nextPage;
      setLoadedPages(nextPage);
      setCards(current => uniqueCards([...current, ...response.data!.items]));
    } catch (error) {
      if (revision !== loadRevision.current) return;
      console.error('Failed to load more cards:', error);
      setLoadError(error instanceof Error ? error.message : 'Failed to load more cards');
    } finally {
      if (revision === loadRevision.current) {
        busy.current = false;
        setLoading(false);
      }
    }
  }, [cards.length, debouncedSearch, filterBy, sortBy, hasMore, isClientMode, searching]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore || loading || searching || loadError) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadMore();
    }, { root: scrollRef.current, rootMargin: '400px 0px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loading, searching, loadError, loadMore]);

  const view = useRef<CardLibraryView | null>(null);
  useLayoutEffect(() => {
    view.current = { cards, totalCards, cachedImages, searchQuery, debouncedSearch, filterBy, sortBy, loadedPages, scrollTop: 0 };
  });
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = initialView?.scrollTop ?? 0;
    return () => {
      if (view.current) useCardLibraryStore.setState({ view: { ...view.current, scrollTop: scroller?.scrollTop ?? 0 } });
    };
  }, [initialView]);

  return {
    cards, setCards, totalCards, cachedImages, searchQuery, setSearchQuery,
    debouncedSearch, filterBy, setFilterBy, sortBy, setSortBy,
    loading, searching, loadError, loadCards, loadMore, hasMore,
    retry: () => failedOperation.current === 'more' ? loadMore() : loadCards(),
    isClientMode, filteredCards, displayedCards, totalFilteredCards,
    scrollRef, sentinelRef,
  };
}
