import { AppShell } from '@/components/layout';
import { useSettings } from '@/lib/settings';
import { isFiltered, useLibraryFeed, useSearchState } from '@/lib/library-search';
import { FilterBar } from '@/components/search/filter-bar';
import { LibraryResults, ResultCount } from '@/components/search/library-results';

/** The library: the header box searches it, the bar filters it. Hidden tags and NSFW live in Settings. */
export default function LibraryPage() {
  const { search, update, replace } = useSearchState();
  const { settings } = useSettings();
  const feed = useLibraryFeed(search, { tags: settings.bannedTags, hideNsfw: settings.hideNsfw });
  return (
    <AppShell>
      <div className="mx-auto max-w-7xl space-y-3">
        <FilterBar search={search} update={update} replace={replace} />
        <ResultCount feed={feed} filtered={isFiltered(search)} />
        <LibraryResults feed={feed} empty={
          <div className="py-16 text-center">
            <h3 className="mb-2 text-xl font-semibold">{isFiltered(search) ? 'No matching cards' : 'No cards yet'}</h3>
            <p className="text-starlight/60">{isFiltered(search) ? 'Try fewer filters.' : 'Import a card from the top bar to get started.'}</p>
          </div>
        } />
      </div>
    </AppShell>
  );
}
