import { useState } from 'react';
import { AppShell } from '@/components/layout';
import { useSettings } from '@/lib/settings';
import { isFiltered, loadSavedSearches, storeSavedSearches, useLibraryFeed, useSearchState, writeSearch } from '@/lib/library-search';
import type { SavedSearch } from '@/lib/library-search';
import { FilterBar } from '@/components/search/filter-bar';
import { LibraryResults, ResultCount } from '@/components/search/library-results';

/** Archive-style search over the library: search box, expressions, tag matching, flags and saved searches. */
export default function SearchPage() {
  const { search, update, replace } = useSearchState();
  const { settings } = useSettings();
  const feed = useLibraryFeed(search, { tags: settings.bannedTags, hideNsfw: settings.hideNsfw });
  const [saved, setSaved] = useState<SavedSearch[]>(loadSavedSearches);
  const keep = (next: SavedSearch[]) => { setSaved(next); storeSavedSearches(next); };

  function save() {
    const name = window.prompt('Name this search', search.q.trim() || search.tags.join(', ') || 'My search')?.trim();
    if (!name) return;
    keep([...saved.filter((item) => item.name.toLowerCase() !== name.toLowerCase()), { name, params: writeSearch(search).toString() }]
      .sort((a, b) => a.name.localeCompare(b.name)));
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-7xl space-y-3">
        <FilterBar advanced search={search} update={update} replace={replace} saved={saved} onSave={save}
          onForget={(name) => keep(saved.filter((item) => item.name !== name))} />
        <ResultCount feed={feed} filtered={isFiltered(search)} />
        <LibraryResults feed={feed} empty={
          <div className="py-16 text-center">
            <h3 className="mb-2 text-xl font-semibold">No matching cards</h3>
            <p className="text-starlight/60">Loosen the search or tags. Hidden tags and NSFW hiding from Settings also apply.</p>
          </div>
        } />
      </div>
    </AppShell>
  );
}
