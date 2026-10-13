import { useState } from 'react';
import { Link } from 'react-router';
import { AppShell } from '@/components/layout';
import { Button } from '@/components/ui';
import { cn } from '@/lib/utils/cn';
import { useSettings } from '@/lib/settings';
import { emptySearch, libraryChanged, useSearchState, writeSearch } from '@/lib/library-search';
import { useArchiveFeed, useArchiveTags } from '@/lib/archive';
import type { ArchiveCard } from '@/lib/archive';
import { archiveIsFiltered, archiveMode, archiveModes } from '@/lib/archive-search';
import { ArchiveSearchBar } from '@/components/search/archive-search-bar';
import { LibraryIndexStatus } from '@/components/search/library-index-status';
import { ArchiveCardItem } from '@/components/archive/archive-card';
import { ArchiveCardModal } from '@/components/archive/archive-modal';

const columns = {
  large: 'grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3',
  medium: 'grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5',
  small: 'grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-2',
} as const;

/** Everything the scrapers collected. Read-only here: add a card to the library to edit, fork or send it. */
export default function ArchivePage() {
  const { search, replace } = useSearchState('push');
  const { settings } = useSettings();
  const hidden = { tags: settings.bannedTags, hideNsfw: settings.hideNsfw };
  const feed = useArchiveFeed(search, hidden);
  const tags = useArchiveTags();
  const [selected, setSelected] = useState<ArchiveCard | null>(null);
  const offline = !!feed.error && feed.cards.length === 0;

  return (
    <AppShell flush>
      <ArchiveSearchBar key={writeSearch(search).toString()} search={search} submit={(next) => {
        if (writeSearch(next).toString() === writeSearch(search).toString()) feed.retry(); else replace(next);
      }} retry={feed.retry} status={feed.status} tags={tags} loading={feed.loading} />
      <LibraryIndexStatus archive={feed.status} searchKey={writeSearch(search).toString()} />
      <div className="px-3 py-3 sm:px-4">
        {feed.status && <p aria-live="polite" className="mb-3 text-[12px] text-starlight/55">
          {archiveModes.find((option) => option.value === archiveMode(search))?.label ?? archiveMode(search)}
          {search.q.trim() && <> results for “{search.q.trim()}”</>}: {feed.loading && !feed.cards.length ? 'loading' : `${feed.cards.length.toLocaleString()} shown of ${feed.total.toLocaleString()} ${feed.complete ? 'matches' : 'candidates'}`}
          {!feed.complete && ' · bounded candidate set, not the full Archive match count'}.
          {feed.staleLibraryHits > 0 && <> {feed.staleLibraryHits} stale saved-card result{feed.staleLibraryHits === 1 ? ' was' : 's were'} hidden while indexing catches up.</>}
          {search.archiveFilter && <> Applied filter: <code>{search.archiveFilter}</code>.</>}
        </p>}
        {offline ? (
          <div role="alert" className="py-24 text-center">
            <p className="text-sm font-medium">{feed.status ? 'Archive search could not run' : 'The Archive is not available'}</p>
            <p className="mt-1 text-[13px] text-starlight/50">{feed.error}</p>
            <div className="mt-3 flex justify-center gap-2">
              <Button size="sm" variant="secondary" onClick={feed.retry}>Try again</Button>
              <Link to="/settings#archive" className="rounded-lg border border-nebula/30 px-3 py-1.5 text-sm text-starlight/80 hover:border-nebula">Archive settings</Link>
            </div>
          </div>
        ) : !feed.loading && feed.cards.length === 0 && !feed.hasMore ? (
          <div className="py-24 text-center">
            <p className="text-sm font-medium">{archiveIsFiltered(search) ? 'No Archive cards match these filters' : 'The Archive is empty'}</p>
            {archiveIsFiltered(search)
              ? <button type="button" onClick={() => replace(emptySearch)} className="mt-2 text-[13px] font-medium text-nebula hover:underline">Clear all filters</button>
              : <Link to="/settings#archive" className="mt-2 inline-block text-[13px] font-medium text-nebula hover:underline">Turn on a source in Settings</Link>}
          </div>
        ) : (
          <>
            <div className={cn('grid', columns[settings.cardSize])}>
              {feed.cards.length === 0 && feed.loading
                ? Array.from({ length: 12 }).map((_, index) => <div key={index} className="aspect-[3/4] animate-pulse rounded-lg bg-cosmic-teal ring-1 ring-nebula/15" />)
                : feed.cards.map((card, index) => <div key={`${card.id}:${card.libraryCardId ?? ''}`} className="min-w-0">
                  <ArchiveCardItem card={card} size={settings.cardSize} onOpen={setSelected} />
                  {feed.matches?.[index] && <details className="mt-1 rounded-md border border-nebula/20 px-2 py-1 text-[12px] text-starlight/65">
                    <summary className="cursor-pointer">Matched {feed.matches[index]!.section || 'card text'}</summary>
                    <p className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words">{feed.matches[index]!.text}</p>
                  </details>}
                </div>)}
            </div>
            {(feed.cards.length > 0 || feed.hasMore) && (
              <div ref={feed.sentinel} className="mt-6 flex flex-col items-center gap-3 pb-2 text-[13px] text-starlight/50" aria-live="polite">
                {feed.error ? (
                  <div role="alert" className="text-center">
                    <p className="mb-2 text-red-300">{feed.error}</p>
                    <Button size="sm" variant="secondary" onClick={feed.retry}>Try again</Button>
                  </div>
                ) : feed.loading ? <p role="status">Loading cards…</p>
                  : feed.hasMore && <Button size="sm" variant="secondary" onClick={() => void feed.loadMore()}>Load more ({feed.cards.length} of {feed.total}{!feed.complete && ' candidates'})</Button>}
              </div>
            )}
          </>
        )}
      </div>
      <ArchiveCardModal card={selected} onClose={() => setSelected(null)} onRemoved={() => { setSelected(null); libraryChanged(); }} />
    </AppShell>
  );
}
