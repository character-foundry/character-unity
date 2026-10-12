import { useState } from 'react';
import { CardGrid } from '@/components/cards/card-grid';
import { CardModal } from '@/components/cards/card-modal';
import { Button } from '@/components/ui';
import { usePlacements } from '@/lib/chat';
import type { useLibraryFeed } from '@/lib/library-search';
import type { CardListItem } from '@/types/card';

/** The library's results grid: infinite scroll with a Load more fallback. */
export function LibraryResults({ feed, empty }: { feed: ReturnType<typeof useLibraryFeed>; empty: React.ReactNode }) {
  const [selected, setSelected] = useState<CardListItem | null>(null);
  const placements = usePlacements(feed.cards.map((card) => card.id));
  const settled = !feed.loading || feed.cards.length > 0;

  if (feed.error && feed.cards.length === 0) {
    return (
      <div role="alert" className="py-12 text-center text-starlight/70">
        <p className="mb-3">{feed.error}</p>
        <Button variant="secondary" onClick={feed.retry}>Try again</Button>
      </div>
    );
  }
  if (settled && !feed.loading && feed.cards.length === 0) return <>{empty}</>;

  return (
    <>
      <CardGrid cards={feed.cards} isLoading={feed.loading} onQuickView={setSelected} placements={placements} />
      {feed.cards.length > 0 && (
        <div ref={feed.sentinel} className="mt-6 flex flex-col items-center gap-3 pb-2 text-[13px] text-starlight/50" aria-live="polite">
          {feed.error ? (
            <div role="alert" className="text-center">
              <p className="mb-2 text-red-300">{feed.error}</p>
              <Button size="sm" variant="secondary" onClick={feed.retry}>Try again</Button>
            </div>
          ) : feed.loading ? (
            <p role="status">Loading cards…</p>
          ) : (
            // The bar shows the count; this only offers more when scrolling has not loaded them yet.
            feed.hasMore && <Button size="sm" variant="secondary" onClick={() => void feed.loadMore()}>Load more ({feed.cards.length} of {feed.total})</Button>
          )}
        </div>
      )}
      <CardModal card={selected} isOpen={!!selected} onClose={() => setSelected(null)} placements={selected ? placements.get(selected.id) : undefined} />
    </>
  );
}
