import { AppShell } from '@/components/layout';
import { useSettings } from '@/lib/settings';
import { emptySearch, isFiltered, useCardTags, useLibraryFeed, useLibraryTotal, useSearchState } from '@/lib/library-search';
import { FilterBar } from '@/components/search/filter-bar';
import { LibraryResults } from '@/components/search/library-results';

/** The library: the top bar's box searches it, the sticky bar filters it. Hidden tags and NSFW live in Settings. */
export default function LibraryPage() {
  const { search, update, replace } = useSearchState();
  const { settings } = useSettings();
  const hidden = { tags: settings.bannedTags, hideNsfw: settings.hideNsfw };
  const feed = useLibraryFeed(search, hidden);
  const total = useLibraryTotal(hidden);
  const tags = useCardTags();
  return (
    <AppShell flush>
      <FilterBar tags={tags} search={search} update={update} replace={replace} total={total}
        count={feed.loading && feed.cards.length === 0 ? null : feed.total} />
      <div className="px-3 py-3 sm:px-4 sm:py-4">
        <LibraryResults feed={feed} empty={
          <div className="py-24 text-center">
            <svg className="mx-auto mb-3 h-8 w-8 text-text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path strokeLinecap="round" d="m16 16 5 5M8.5 8.5l4 4m0-4-4 4" /></svg>
            <p className="text-sm font-medium">{isFiltered(search) ? 'No cards match these filters' : 'No cards yet'}</p>
            {isFiltered(search)
              ? <button type="button" onClick={() => replace({ ...emptySearch, sort: search.sort })}
                  className="mt-2 text-[13px] font-medium text-nebula hover:underline">Clear all filters</button>
              : <p className="mt-1 text-[13px] text-starlight/50">Import a card from the top bar to get started.</p>}
          </div>
        } />
      </div>
    </AppShell>
  );
}
