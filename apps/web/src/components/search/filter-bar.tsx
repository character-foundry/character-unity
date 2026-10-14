import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/utils/cn';
import { useSettings } from '@/lib/settings';
import { useLibraryClient } from '@/lib/library-client';
import {
  archiveSortOptions, emptySearch, flagOptions, isFiltered, loadSavedSearches, readSearch, sortOptions, sourceOptions, storeSavedSearches,
  useDebouncedText, useFollowedCreators, writeSearch,
} from '@/lib/library-search';
import type { LibrarySearch, SavedSearch, SearchPage } from '@/lib/library-search';
import { HeartIcon } from '@/components/ui';
import { TagPicker } from './tag-picker';

// One sticky bar under the top bar: everyday filters on one row, the rest behind Filters.
// The top bar's box is the text search, so the bar has none.
const box = 'flex h-8 shrink-0 items-center rounded-md border border-starlight/10 bg-cosmic-teal text-[13px] focus-within:border-nebula';
// The global input rule is unlayered and outranks utilities; fields inside `box` draw no frame of their own.
const bare = { border: 'none', background: 'transparent', boxShadow: 'none', outline: 'none' } as const;
const segment = (on: boolean) => cn('h-full rounded px-2.5 text-[12px] font-medium transition-colors', on ? 'bg-surface-2 text-starlight' : 'text-text-muted hover:text-starlight');
const pill = (on: boolean, disabled = false) => cn('h-7 rounded-full border px-2.5 text-[12px] font-medium transition-colors',
  disabled ? 'cursor-not-allowed border-dashed border-starlight/10 text-starlight/30'
    : on ? 'border-nebula/60 bg-nebula/15 text-nebula' : 'border-starlight/10 text-text-muted hover:text-starlight');

function Select({ label, prefix, value, options, onChange }: {
  label: string; prefix?: string; value: string; options: readonly { value: string; label: string }[]; onChange: (value: string) => void;
}) {
  return (
    <label className={cn(box, 'relative pl-2.5 pr-7')}>
      <span className="sr-only">{label}</span>
      {prefix && <span className="mr-1 text-text-muted">{prefix}</span>}
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} style={bare} className="appearance-none font-medium text-starlight">
        {options.map((option) => <option key={option.value} value={option.value} className="bg-surface-1">{option.label}</option>)}
      </select>
      <svg className="pointer-events-none absolute right-2 h-3.5 w-3.5 text-starlight/40" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
    </label>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: readonly { value: T; label: React.ReactNode; title?: string }[]; onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn(box, 'p-0.5')}>
      {options.map((option) => (
        <button key={option.value} type="button" role="radio" aria-checked={value === option.value} title={option.title} aria-label={option.title}
          onClick={() => onChange(option.value)} className={segment(value === option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

const icon = (d: string) => (
  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={d} /></svg>
);

const syntax = [
  ['"modern city"', 'exact phrase'],
  ['vampire OR werewolf', 'either word'],
  ['fantasy NOT elves', 'leave out (also -elves)'],
  ['(vampire OR werewolf) "modern city"', 'grouping'],
  ['creator:"some author"', 'creator only (author: works too)'],
  ['name:aria   description:dragon', 'one field only'],
  ['tag:fantasy', 'exact tag'],
];

/**
 * The filter bar of the library and the Archive (after Archive's filters, laid out as one row plus a Filters
 * drawer). The Archive has no forks or favorites; it sorts by the sources' popularity too.
 */
export function FilterBar({ page = 'library', tags, search, update, replace, count, total }: {
  page?: SearchPage;
  /** Tag counts for the pickers (the library's or the Archive's). */
  tags: readonly { tag: string; count: number }[];
  search: LibrarySearch;
  update: (changes: Partial<LibrarySearch>) => void;
  replace: (search: LibrarySearch) => void;
  /** Cards matching, or null while the first page loads. */
  count: number | null;
  /** Cards in the library (or Archive), less those Settings hides. */
  total: number | null;
}) {
  const archive = page === 'archive';
  const client = useLibraryClient();
  const followed = useFollowedCreators();
  const { settings } = useSettings();
  const [minTokens, setMinTokens] = useDebouncedText(search.minTokens, useCallback((value: string) => update({ minTokens: value }), [update]), 500);
  const [expr, setExpr, flushExpr] = useDebouncedText(search.expr, useCallback((value: string) => update({ expr: value }), [update]), 600);
  const [open, setOpen] = useState(() => !!search.expr.trim());
  const [help, setHelp] = useState(false);
  const [savedState, setSavedState] = useState<{ owner: string; page: SearchPage; rows: SavedSearch[] }>(() => ({ owner: client.scopeKey, page, rows: loadSavedSearches(client, page) }));
  const saved = savedState.owner === client.scopeKey && savedState.page === page ? savedState.rows : [];
  useEffect(() => { setSavedState({ owner: client.scopeKey, page, rows: loadSavedSearches(client, page) }); }, [client, page]);
  const keep = (next: SavedSearch[]) => { setSavedState({ owner: client.scopeKey, page, rows: next }); storeSavedSearches(client, next, page); };
  const params = writeSearch(search).toString();
  const applied = saved.find((item) => item.params === params);

  const advanced = search.exclude.length + search.has.length + (search.source ? 1 : 0) + (search.minTokens ? 1 : 0)
    + (search.favorite === 'not_fav' ? 1 : 0) + (search.expr.trim() ? 1 : 0);
  const hidden = [settings.hideNsfw ? 'NSFW' : '', settings.bannedTags.length ? `${settings.bannedTags.length} tag${settings.bannedTags.length === 1 ? '' : 's'}` : ''].filter(Boolean);

  function save() {
    const name = window.prompt('Name this search', search.q.trim() || search.tags.join(', ') || 'My search')?.trim();
    if (!name) return;
    keep([...saved.filter((item) => item.name.toLowerCase() !== name.toLowerCase()), { name, params }].sort((a, b) => a.name.localeCompare(b.name)));
  }

  return (
    <div className="sticky top-12 z-30 border-b border-starlight/10 bg-deep-space/95 backdrop-blur">
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5 sm:px-4">
        <TagPicker compact className="min-w-[min(220px,100%)] flex-1" label="Include tags" tone="include" value={search.tags} options={tags} blocked={search.exclude}
          onChange={(next) => update({ tags: next })} placeholder="Filter by tag…"
          icon={<svg className="h-3.5 w-3.5 shrink-0 text-starlight/40" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" /></svg>} />

        <Select label="Sort" value={search.sort || (archive ? 'updated' : 'edited')} options={archive ? archiveSortOptions : sortOptions} onChange={(sort) => update({ sort })} />

        {!archive && (<>
          <Select label="Originals or forks" value={search.fork} onChange={(fork) => update({ fork: fork === 'only' || fork === 'none' ? fork : '' })}
            options={[{ value: '', label: 'All cards' }, { value: 'none', label: 'Originals' }, { value: 'only', label: 'Forks' }]} />
          <button type="button" aria-pressed={search.favorite === 'fav'} onClick={() => update({ favorite: search.favorite === 'fav' ? '' : 'fav' })}
            className={cn(box, 'gap-1.5 px-2.5 text-[12px] font-medium transition-colors', search.favorite === 'fav' ? 'border-nebula/60 bg-nebula/15 text-nebula' : 'text-text-muted hover:text-starlight')}>
            <HeartIcon className="h-3.5 w-3.5" filled={search.favorite === 'fav'} />
            Favorites
          </button>
        </>)}

        <button type="button" aria-expanded={open} aria-controls="library-filters" onClick={() => setOpen(!open)}
          className={cn(box, 'gap-1.5 px-2.5 text-[12px] font-medium transition-colors', open || advanced ? 'bg-surface-2 text-starlight' : 'text-text-muted hover:text-starlight')}>
          {icon('M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4')}
          Filters
          {advanced > 0 && <span className="grid h-4 min-w-4 place-items-center rounded bg-nebula px-1 text-[10px] font-bold text-white">{advanced}</span>}
        </button>

        <div className="ml-auto flex shrink-0 items-center gap-2 pl-1">
          <span className="text-[12px] tabular-nums text-text-muted" aria-live="polite" title={hidden.length ? `Not showing ${hidden.join(' or ')} (Settings)` : undefined}>
            {count !== null && <><span className="font-semibold text-starlight">{count}</span>{total !== null && count !== total && ` / ${total}`} cards</>}
            {hidden.length > 0 && <span className="text-starlight/30"> · {hidden.join(', ')} hidden</span>}
          </span>
          {isFiltered(search) && (
            <button type="button" onClick={() => { setMinTokens(''); setExpr(''); replace({ ...emptySearch, sort: search.sort }); }}
              className="text-[12px] font-medium text-nebula hover:underline">Clear</button>
          )}
        </div>
      </div>

      {open && (
        <div id="library-filters" className="border-t border-starlight/10 px-3 py-1.5 sm:px-4">
          <form onSubmit={(event) => { event.preventDefault(); flushExpr(); }} className="mb-2 flex items-center gap-2">
            <label className={cn(box, 'min-w-0 flex-1 gap-2 px-2.5')}>
              <span className="shrink-0 text-starlight/50">Advanced search</span>
              <input aria-label="Advanced search" value={expr} spellCheck={false} onChange={(event) => setExpr(event.target.value)} style={bare}
                placeholder='(vampire OR werewolf) "modern city" -tag:nsfw creator:ash'
                className="h-full min-w-0 flex-1 p-0 font-mono text-[12px] text-starlight placeholder:text-starlight/30" />
              {expr && <button type="button" aria-label="Clear advanced search" onClick={() => { setExpr(''); update({ expr: '' }); }} className="text-starlight/40 hover:text-starlight">✕</button>}
            </label>
            <button type="button" aria-expanded={help} onClick={() => setHelp(!help)} className="shrink-0 text-[12px] font-medium text-starlight/40 hover:text-starlight">
              Syntax {help ? '▴' : '▾'}
            </button>
          </form>
          {help && (
            <ul className="mb-2 grid gap-x-4 gap-y-1 text-[12px] text-starlight/60 sm:grid-cols-2 lg:grid-cols-3">
              {syntax.map(([example, note]) => (
                <li key={example}><code className="rounded bg-cosmic-teal px-1.5 py-0.5 font-mono text-[11px] text-nebula">{example}</code> {note}</li>
              ))}
              <li className="text-starlight/40 sm:col-span-2 lg:col-span-3">Works here and in the top search box; both apply together. Plain words search name, creator, description, creator notes, personality, scenario, first message and tags. Write OR and NOT in capitals.</li>
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <TagPicker compact className="min-w-[min(220px,100%)] flex-1" label="Exclude tags" tone="exclude" value={search.exclude} options={tags} blocked={search.tags}
              onChange={(next) => update({ exclude: next })} placeholder="Exclude tags…" />
            <Segmented label="Tag match mode" value={search.tagMode} onChange={(tagMode) => update({ tagMode })}
              options={[{ value: 'any', label: 'Match any' }, { value: 'all', label: 'Match all' }]} />
            <Select label="Source" prefix="Source" value={search.source} options={archive ? sourceOptions.filter((option) => option.value !== 'file') : sourceOptions} onChange={(source) => update({ source })} />
            <label className={cn(box, 'gap-1.5 px-2.5')}>
              <span className="text-starlight/50">Min tokens</span>
              <input type="number" min={0} step={100} inputMode="numeric" value={minTokens} placeholder="0" style={bare}
                onChange={(event) => setMinTokens(event.target.value.replace(/[^0-9]/g, '').replace(/^0+/, ''))}
                className="w-16 p-0 font-medium text-starlight placeholder:text-starlight/40" />
            </label>
            {saved.length > 0 && (
              <Select label="Saved searches" prefix="Saved" value={applied?.name ?? ''} onChange={(name) => {
                const item = saved.find((entry) => entry.name === name);
                if (item) replace(readSearch(new URLSearchParams(item.params)));
              }} options={[...(applied ? [] : [{ value: '', label: 'Choose…' }]), ...saved.map((item) => ({ value: item.name, label: item.name }))]} />
            )}
            {applied ? (
              <button type="button" onClick={() => keep(saved.filter((item) => item !== applied))} className={pill(false)}>Forget “{applied.name}”</button>
            ) : (
              <button type="button" onClick={save} disabled={!isFiltered(search)} className={pill(false, !isFiltered(search))}
                title={isFiltered(search) ? undefined : 'Set a search or filters first'}>Save search</button>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1">
            {flagOptions.filter((flag) => !archive || flag.value !== 'chat').map((flag) => {
              const on = search.has.includes(flag.value);
              const disabled = flag.value === 'followed' && followed.length === 0 && !on;
              return (
                <button key={flag.value} type="button" aria-pressed={on} disabled={disabled} title={disabled ? 'Follow a creator from a card first' : undefined}
                  onClick={() => update({ has: on ? search.has.filter((value) => value !== flag.value) : [...search.has, flag.value] })}
                  className={pill(on, disabled)}>
                  {flag.label}
                </button>
              );
            })}
            {!archive && (
              <button type="button" aria-pressed={search.favorite === 'not_fav'} onClick={() => update({ favorite: search.favorite === 'not_fav' ? '' : 'not_fav' })}
                className={pill(search.favorite === 'not_fav')}>Not favorited</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
