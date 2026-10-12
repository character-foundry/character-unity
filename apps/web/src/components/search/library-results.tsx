import { useState } from 'react';
import { CardGrid } from '@/components/cards/card-grid';
import { CardModal } from '@/components/cards/card-modal';
import { Button } from '@/components/ui';
import { usePlacements } from '@/lib/chat';
import { useSettings } from '@/lib/settings';
import type { useLibraryFeed } from '@/lib/library-search';
import type { CardListItem } from '@/types/card';

/** Results grid shared by the library and search pages: infinite scroll with a Load more fallback. */
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
        <div ref={feed.sentinel} className="mt-8 flex flex-col items-center gap-3 pb-4 text-sm text-starlight/50" aria-live="polite">
          {feed.error ? (
            <div role="alert" className="text-center">
              <p className="mb-2 text-red-300">{feed.error}</p>
              <Button size="sm" variant="secondary" onClick={feed.retry}>Try again</Button>
            </div>
          ) : feed.loading ? (
            <p role="status">Loading cards…</p>
          ) : (
            <>
              <p>{feed.cards.length} of {feed.total} cards</p>
              {feed.hasMore && <Button size="sm" variant="secondary" onClick={() => void feed.loadMore()}>Load more cards</Button>}
            </>
          )}
        </div>
      )}
      <CardModal card={selected} isOpen={!!selected} onClose={() => setSelected(null)} placements={selected ? placements.get(selected.id) : undefined} />
    </>
  );
}

export function ResultCount({ feed, filtered }: { feed: ReturnType<typeof useLibraryFeed>; filtered: boolean }) {
  const { settings } = useSettings();
  const hidden = [settings.hideNsfw ? 'NSFW' : '', settings.bannedTags.length ? `${settings.bannedTags.length} hidden tag${settings.bannedTags.length === 1 ? '' : 's'}` : ''].filter(Boolean);
  return (
    <div className="min-h-[1.25rem] text-sm text-starlight/60">
      {!(feed.loading && feed.cards.length === 0) && <>{feed.total} {feed.total === 1 ? 'card' : 'cards'}{filtered ? ' match' : ''}</>}
      {hidden.length > 0 && <span className="text-starlight/40"> · not showing {hidden.join(' or ')}</span>}
    </div>
  );
}
