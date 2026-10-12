import { useCallback, useRef, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/layout';
import { Button } from '@/components/ui';
import { cn } from '@/lib/utils/cn';
import { importFile } from '@/lib/unity';
import { useSettings } from '@/lib/settings';
import { emptySearch, fieldClass, isFiltered, libraryChanged, useCardTags, useDebouncedText, useLibraryFeed, useSearchState, writeSearch } from '@/lib/library-search';
import { TagPicker } from '@/components/search/tag-picker';
import { ContentControls, FlagChecks, SortSelect } from '@/components/search/search-controls';
import { LibraryResults } from '@/components/search/library-results';

/** The everyday library view: quick text, tag include/exclude, sort and show/hide. /search has the full syntax. */
export default function LibraryPage() {
  const { search, update, replace } = useSearchState();
  const { settings } = useSettings();
  const tagOptions = useCardTags();
  const feed = useLibraryFeed(search, { tags: settings.bannedTags, hideNsfw: settings.hideNsfw });
  const [showFilters, setShowFilters] = useState(() => search.has.length > 0 || !!search.fork);
  const [notice, setNotice] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const [text, setText, flush] = useDebouncedText(search.q, useCallback((q: string) => update({ q }), [update]));

  async function importFiles(files: FileList) {
    setImporting(true); setNotice(null);
    let imported = 0; const failed: string[] = [];
    for (const file of Array.from(files)) {
      try { await importFile(file); imported += 1; } catch { failed.push(file.name); }
    }
    setImporting(false);
    setNotice(`Imported ${imported} card${imported === 1 ? '' : 's'}.${failed.length ? ` Could not import: ${failed.join(', ')}` : ''}`);
    libraryChanged();
  }

  const filterCount = search.has.length + (search.fork ? 1 : 0);
  const hiddenCount = settings.bannedTags.length + (settings.hideNsfw ? 1 : 0);
  const advanced = writeSearch(search).toString();

  return (
    <AppShell>
      <div className="mx-auto max-w-7xl">
        <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="mb-2 text-3xl font-bold gradient-text">Library</h1>
            <p className="text-starlight/60">Your imported cards and edited forks.</p>
          </div>
          <div className="flex items-center gap-2">
            <input ref={fileInput} type="file" multiple accept=".png,.json,.charx" className="hidden"
              onChange={(event) => { if (event.target.files?.length) void importFiles(event.target.files); event.target.value = ''; }} />
            <Button variant="primary" onClick={() => fileInput.current?.click()} disabled={importing}>
              {importing ? 'Importing…' : 'Import cards'}
            </Button>
          </div>
        </div>

        {/* Above the grid so tag suggestions are not drawn under the cards. */}
        <div className="glass relative z-20 mb-4 space-y-3 rounded-xl border border-nebula/20 p-4">
          <div className="flex flex-col gap-2 md:flex-row">
            <div className="relative flex-1">
              <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-starlight/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') flush(); }}
                placeholder="Search name, description, creator, tags…" aria-label="Search the library" className={cn(fieldClass, 'pl-9')} />
            </div>
            <div className="flex flex-wrap gap-2">
              <SortSelect value={search.sort} onChange={(sort) => update({ sort })} />
              <Button variant={showFilters ? 'primary' : 'secondary'} onClick={() => setShowFilters(!showFilters)} aria-expanded={showFilters}>
                Filters{filterCount + hiddenCount ? ` (${filterCount + hiddenCount})` : ''}
              </Button>
              <Link href={`/search${advanced ? `?${advanced}` : ''}`} className="flex items-center rounded-lg px-3 text-sm text-nebula hover:bg-nebula/10">
                Advanced search →
              </Link>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <TagPicker label="Include tags" tone="include" value={search.tags} options={tagOptions} blocked={search.exclude}
              onChange={(tags) => update({ tags })} placeholder="Must have…" />
            <TagPicker label="Exclude tags" tone="exclude" value={search.exclude} options={tagOptions} blocked={search.tags}
              onChange={(exclude) => update({ exclude })} placeholder="Must not have…" />
          </div>
          {showFilters && (
            <div className="space-y-4 border-t border-nebula/20 pt-3">
              <FlagChecks search={search} onChange={update} />
              <ContentControls tagOptions={tagOptions} />
            </div>
          )}
        </div>

        {notice && <div className="mb-4 rounded-lg border border-nebula/30 p-3 text-sm text-starlight/80 glass" role="status">{notice}</div>}

        <div className="mb-4 flex min-h-[1.25rem] flex-wrap items-center gap-3 text-sm text-starlight/60">
          {!(feed.loading && feed.cards.length === 0) && <span>{feed.total} {feed.total === 1 ? 'character' : 'characters'}</span>}
          {hiddenCount > 0 && <span className="text-starlight/40">· hiding {settings.hideNsfw ? 'NSFW' : ''}{settings.hideNsfw && settings.bannedTags.length ? ' and ' : ''}{settings.bannedTags.length ? `${settings.bannedTags.length} tag${settings.bannedTags.length === 1 ? '' : 's'}` : ''}</span>}
          {isFiltered(search) && (
            <button onClick={() => replace({ ...emptySearch, sort: search.sort })} className="text-nebula hover:underline">
              Clear filters
            </button>
          )}
        </div>

        <LibraryResults feed={feed} empty={
          <div className="py-16 text-center">
            <h3 className="mb-2 text-xl font-semibold">{isFiltered(search) ? 'No matching cards' : 'No cards yet'}</h3>
            <p className="text-starlight/60">{isFiltered(search) ? 'Try fewer filters, or the advanced search.' : 'Import a card to get started.'}</p>
          </div>
        } />
      </div>
    </AppShell>
  );
}
