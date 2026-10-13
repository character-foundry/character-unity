import { useState } from 'react';
import { Link } from 'react-router';
import { AppShell } from '@/components/layout';
import { Button } from '@/components/ui';
import { cn } from '@/lib/utils/cn';
import { useSettings } from '@/lib/settings';
import { emptySearch, isFiltered, libraryChanged, useSearchState } from '@/lib/library-search';
import { useArchiveFeed, useArchiveTags, useArchiveTotal } from '@/lib/archive';
import type { ArchiveCard } from '@/lib/archive';
import { FilterBar } from '@/components/search/filter-bar';
import { ArchiveCardItem } from '@/components/archive/archive-card';
import { ArchiveCardModal } from '@/components/archive/archive-modal';

const columns = {
  large: 'grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3',
  medium: 'grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5',
  small: 'grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-2',
} as const;

/** Everything the scrapers collected. Read-only here: add a card to the library to edit, fork or send it. */
export default function ArchivePage() {
  const { search, update, replace } = useSearchState();
  const { settings } = useSettings();
  const hidden = { tags: settings.bannedTags, hideNsfw: settings.hideNsfw };
  const feed = useArchiveFeed(search, hidden);
  const total = useArchiveTotal(hidden);
  const tags = useArchiveTags();
  const [selected, setSelected] = useState<ArchiveCard | null>(null);
  const offline = !!feed.error && feed.cards.length === 0;

  return (
    <AppShell flush>
      <FilterBar page="archive" tags={tags} search={search} update={update} replace={replace} total={total}
        count={feed.loading && feed.cards.length === 0 ? null : feed.total} />
      <div className="px-3 py-3 sm:px-4">
        {offline ? (
          <div role="alert" className="py-24 text-center">
            <p className="text-sm font-medium">The Archive is not available</p>
            <p className="mt-1 text-[13px] text-starlight/50">{feed.error}</p>
            <div className="mt-3 flex justify-center gap-2">
              <Button size="sm" variant="secondary" onClick={feed.retry}>Try again</Button>
              <Link to="/settings#archive" className="rounded-lg border border-nebula/30 px-3 py-1.5 text-sm text-starlight/80 hover:border-nebula">Archive settings</Link>
            </div>
          </div>
        ) : !feed.loading && feed.cards.length === 0 ? (
          <div className="py-24 text-center">
            <p className="text-sm font-medium">{isFiltered(search) ? 'No Archive cards match these filters' : 'The Archive is empty'}</p>
            {isFiltered(search)
              ? <button type="button" onClick={() => replace({ ...emptySearch, sort: search.sort })} className="mt-2 text-[13px] font-medium text-nebula hover:underline">Clear all filters</button>
              : <Link to="/settings#archive" className="mt-2 inline-block text-[13px] font-medium text-nebula hover:underline">Turn on a source in Settings</Link>}
          </div>
        ) : (
          <>
            <div className={cn('grid', columns[settings.cardSize])}>
              {feed.cards.length === 0 && feed.loading
                ? Array.from({ length: 12 }).map((_, index) => <div key={index} className="aspect-[3/4] animate-pulse rounded-lg bg-cosmic-teal ring-1 ring-nebula/15" />)
                : feed.cards.map((card) => <ArchiveCardItem key={`${card.id}:${card.libraryCardId ?? ''}`} card={card} size={settings.cardSize} onOpen={setSelected} />)}
            </div>
            {feed.cards.length > 0 && (
              <div ref={feed.sentinel} className="mt-6 flex flex-col items-center gap-3 pb-2 text-[13px] text-starlight/50" aria-live="polite">
                {feed.error ? (
                  <div role="alert" className="text-center">
                    <p className="mb-2 text-red-300">{feed.error}</p>
                    <Button size="sm" variant="secondary" onClick={feed.retry}>Try again</Button>
                  </div>
                ) : feed.loading ? <p role="status">Loading cards…</p>
                  : feed.hasMore && <Button size="sm" variant="secondary" onClick={() => void feed.loadMore()}>Load more ({feed.cards.length} of {feed.total})</Button>}
              </div>
            )}
          </>
        )}
      </div>
      <ArchiveCardModal card={selected} onClose={() => setSelected(null)} onRemoved={() => { setSelected(null); libraryChanged(); }} />
    </AppShell>
  );
}
