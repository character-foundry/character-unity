import { useCallback, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/layout';
import { Button } from '@/components/ui';
import { cn } from '@/lib/utils/cn';
import { useSettings } from '@/lib/settings';
import { emptySearch, fieldClass, isFiltered, loadSavedSearches, readSearch, storeSavedSearches, useCardTags, useDebouncedText, useLibraryFeed, useSearchState, writeSearch } from '@/lib/library-search';
import type { SavedSearch } from '@/lib/library-search';
import { TagPicker } from '@/components/search/tag-picker';
import { ContentControls, FlagChecks, SortSelect } from '@/components/search/search-controls';
import { LibraryResults } from '@/components/search/library-results';

const examples = [
  { query: 'vampire knight', note: 'every word must appear somewhere' },
  { query: '"modern city"', note: 'exact phrase' },
  { query: 'vampire OR werewolf', note: 'either word' },
  { query: '(elf OR dwarf) -modern', note: 'group, then leave out a word' },
  { query: 'NOT tag:nsfw', note: 'NOT works like -' },
  { query: 'creator:"some author"', note: 'only the creator field' },
  { query: 'name:aria', note: 'only the name' },
  { query: 'description:dragon', note: 'only the description' },
  { query: 'tag:fantasy tag:female', note: 'exact tags inside the query' },
];

/** Archive-style search over the library: query syntax, any/all tags, flags and saved searches. */
export default function SearchPage() {
  const { search, update, replace } = useSearchState();
  const { settings } = useSettings();
  const tagOptions = useCardTags();
  const feed = useLibraryFeed(search, { tags: settings.bannedTags, hideNsfw: settings.hideNsfw });
  const [help, setHelp] = useState(false);
  const [saved, setSaved] = useState<SavedSearch[]>(loadSavedSearches);

  const [text, setText, flush] = useDebouncedText(search.q, useCallback((q: string) => update({ q }), [update]), 500);

  const current = writeSearch(search).toString();
  function save() {
    const name = window.prompt('Name this search', search.q.trim() || search.tags.join(', ') || 'My search')?.trim();
    if (!name) return;
    const next = [...saved.filter((item) => item.name.toLowerCase() !== name.toLowerCase()), { name, params: current }]
      .sort((a, b) => a.name.localeCompare(b.name));
    setSaved(next); storeSavedSearches(next);
  }
  function forget(name: string) {
    const next = saved.filter((item) => item.name !== name);
    setSaved(next); storeSavedSearches(next);
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-7xl">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="mb-2 text-3xl font-bold gradient-text">Search</h1>
            <p className="text-starlight/60">Your whole library: phrases, OR / NOT, field filters, tag matching and saved searches.</p>
          </div>
          <Link href={`/${current ? `?${current}` : ''}`} className="text-sm text-nebula hover:underline">← Back to library view</Link>
        </div>

        <div className="relative z-20 grid gap-4 lg:grid-cols-[1fr_16rem]">
          <div className="glass space-y-4 rounded-xl border border-nebula/20 p-4">
            <div>
              <div className="mb-1 flex items-center justify-between text-xs font-medium text-starlight/60">
                <label htmlFor="advanced-query">Query</label>
                <button type="button" onClick={() => setHelp(!help)} className="text-nebula hover:underline" aria-expanded={help}>
                  {help ? 'Hide syntax' : 'Syntax help'}
                </button>
              </div>
              <textarea id="advanced-query" rows={2} value={text} spellCheck={false}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); flush(); } }}
                placeholder='(vampire OR werewolf) "modern city" -tag:nsfw creator:ash'
                className={cn(fieldClass, 'resize-y font-mono')} />
              {help && (
                <div className="mt-2 grid gap-1 rounded-lg bg-deep-space/50 p-3 text-xs sm:grid-cols-2">
                  {examples.map((example) => (
                    <button key={example.query} type="button" onClick={() => { setText(example.query); update({ q: example.query }); }}
                      className="flex items-baseline gap-2 rounded px-2 py-1 text-left hover:bg-cosmic-teal/30">
                      <code className="shrink-0 text-nebula">{example.query}</code>
                      <span className="text-starlight/50">{example.note}</span>
                    </button>
                  ))}
                  <p className="px-2 pt-1 text-starlight/40 sm:col-span-2">
                    Plain words search the name, creator, description, creator notes, personality, scenario, first message and tags.
                    Matching ignores case. AND is implied between words; write OR and NOT in capitals.
                  </p>
                </div>
              )}
            </div>

            <div>
              <div className="mb-2 flex items-center gap-2 text-xs text-starlight/60">
                <span>Included tags must match</span>
                <div className="inline-flex overflow-hidden rounded-lg border border-nebula/30" role="radiogroup" aria-label="Tag match mode">
                  {(['all', 'any'] as const).map((mode) => (
                    <button key={mode} type="button" role="radio" aria-checked={search.tagMode === mode} onClick={() => update({ tagMode: mode })}
                      className={cn('px-2.5 py-1 uppercase', search.tagMode === mode ? 'bg-nebula/30 text-nebula' : 'text-starlight/70 hover:bg-cosmic-teal/30')}>
                      {mode}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <TagPicker label="Include tags" tone="include" value={search.tags} options={tagOptions} blocked={search.exclude}
                  onChange={(tags) => update({ tags })} placeholder={search.tagMode === 'any' ? 'Any of…' : 'All of…'} />
                <TagPicker label="Exclude tags" tone="exclude" value={search.exclude} options={tagOptions} blocked={search.tags}
                  onChange={(exclude) => update({ exclude })} placeholder="None of…" />
              </div>
            </div>

            <FlagChecks search={search} onChange={update} />
            <div className="border-t border-nebula/20 pt-3"><ContentControls tagOptions={tagOptions} /></div>
          </div>

          <aside className="glass space-y-3 rounded-xl border border-nebula/20 p-4 text-sm">
            <div>
              <div className="mb-1 text-xs font-medium text-starlight/60">Sort</div>
              <SortSelect value={search.sort} onChange={(sort) => update({ sort })} />
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={save} disabled={!isFiltered(search)}>Save search</Button>
              <Button size="sm" variant="ghost" disabled={!isFiltered(search)}
                onClick={() => { setText(''); replace({ ...emptySearch, sort: search.sort }); }}>Clear</Button>
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-starlight/60">Saved searches</div>
              {saved.length === 0 ? <p className="text-xs text-starlight/40">None yet. Saved searches stay in this browser.</p> : (
                <ul className="space-y-1">
                  {saved.map((item) => (
                    <li key={item.name} className={cn('group flex items-center gap-1 rounded-lg', item.params === current && 'bg-nebula/15')}>
                      <button type="button" onClick={() => replace(readSearch(new URLSearchParams(item.params)))}
                        className="min-w-0 flex-1 truncate rounded-lg px-2 py-1 text-left text-starlight/80 hover:bg-cosmic-teal/30" title={decodeURIComponent(item.params.replace(/\+/g, ' '))}>
                        {item.name}
                      </button>
                      <button type="button" aria-label={`Delete saved search ${item.name}`} onClick={() => forget(item.name)}
                        className="px-2 text-starlight/30 opacity-0 hover:text-red-300 group-hover:opacity-100 focus:opacity-100">✕</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        </div>

        <div className="my-4 min-h-[1.25rem] text-sm text-starlight/60">
          {!(feed.loading && feed.cards.length === 0) && <>{feed.total} {feed.total === 1 ? 'match' : 'matches'}</>}
        </div>
        <LibraryResults feed={feed} empty={
          <div className="py-16 text-center">
            <h3 className="mb-2 text-xl font-semibold">No matching cards</h3>
            <p className="text-starlight/60">Loosen the query or tags. Hidden tags and NSFW hiding also apply here.</p>
          </div>
        } />
      </div>
    </AppShell>
  );
}
