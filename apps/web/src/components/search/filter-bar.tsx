import { useCallback, useState } from 'react';
import { cn } from '@/lib/utils/cn';
import { emptySearch, flagOptions, isFiltered, readSearch, sortOptions, useCardTags, useDebouncedText } from '@/lib/library-search';
import type { LibrarySearch, SavedSearch } from '@/lib/library-search';
import { TagPicker } from './tag-picker';

// Laid out after Archive's FilterBar: search, collapsible expressions, tag filters with ANY/ALL,
// a row of selects with Clear, collapsible flags, then collapsible saved searches.
const heading = 'text-[11px] font-semibold uppercase tracking-wide text-starlight/40';
const control = 'min-w-0 rounded-md border border-nebula/30 bg-deep-space/60 px-2 py-1.5 text-sm text-starlight focus:border-nebula focus:outline-none';

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={cn('h-4 w-4 shrink-0 transition-transform', open && 'rotate-180')} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function Disclosure({ title, badge, defaultOpen = false, children }: { title: React.ReactNode; badge?: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="min-w-0 rounded-md border border-nebula/20 bg-deep-space/30">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs font-semibold text-starlight/60 hover:text-starlight">
        <span className="flex items-center gap-2">{title}{badge}</span>
        <Chevron open={open} />
      </button>
      {open && <div className="border-t border-nebula/20 p-2">{children}</div>}
    </div>
  );
}

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
 * The library filter bar. The library page shows filters only (the header box is its search);
 * the search page adds the search box, expressions and saved searches.
 */
export function FilterBar({ search, update, replace, advanced = false, saved, onSave, onForget }: {
  search: LibrarySearch;
  update: (changes: Partial<LibrarySearch>) => void;
  replace: (search: LibrarySearch) => void;
  advanced?: boolean;
  saved?: SavedSearch[];
  onSave?: () => void;
  onForget?: (name: string) => void;
}) {
  const tags = useCardTags();
  const [text, setText, flush] = useDebouncedText(search.q, useCallback((q: string) => update({ q }), [update]));
  const [expr, setExpr] = useDebouncedText(search.expr, useCallback((value: string) => update({ expr: value }), [update]), 600);
  const [help, setHelp] = useState(false);

  return (
    <div className="space-y-2">
      <form onSubmit={(event) => { event.preventDefault(); flush(); }}
        className="glass relative z-20 grid gap-2.5 rounded-xl border border-nebula/20 p-3">
        {advanced && (
          <>
            <label className="flex min-w-0 flex-col gap-1">
              <span className={heading}>Search</span>
              <div className="relative">
                <svg className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-starlight/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input value={text} onChange={(event) => setText(event.target.value)} placeholder="Name, description, creator, tags…"
                  className={cn(control, 'w-full pl-8')} />
              </div>
            </label>
            <Disclosure title="Advanced filter expressions" defaultOpen={!!search.expr}
              badge={search.expr.trim() ? <span className="rounded bg-nebula/20 px-1.5 py-0.5 text-[10px] text-nebula">Active</span> : null}>
              <textarea aria-label="Advanced filter expressions" value={expr} rows={2} spellCheck={false}
                onChange={(event) => setExpr(event.target.value)}
                placeholder='(vampire OR werewolf) "modern city" -tag:nsfw creator:ash'
                className={cn(control, 'block w-full resize-y font-mono')} />
              <button type="button" onClick={() => setHelp(!help)} className="mt-1.5 flex w-full items-center justify-between rounded-md border border-nebula/20 bg-nebula/5 px-3 py-1.5 text-xs font-semibold text-starlight/70">
                Search help <Chevron open={help} />
              </button>
              {help && (
                <ul className="mt-1.5 space-y-1 px-1 text-xs text-starlight/60">
                  {syntax.map(([example, note]) => (
                    <li key={example}><code className="rounded bg-deep-space/80 px-1.5 py-0.5 font-mono text-[11px] text-nebula">{example}</code> <span>{note}</span></li>
                  ))}
                  <li className="pt-1 text-starlight/40">Words without a field search name, creator, description, creator notes, personality, scenario, first message and tags. Case is ignored; write OR and NOT in capitals.</li>
                </ul>
              )}
            </Disclosure>
          </>
        )}

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className={heading}>Tag filters</span>
            <div className="flex items-center gap-0.5 rounded-md border border-nebula/30 p-0.5 text-xs font-medium">
              {(['any', 'all'] as const).map((mode) => (
                <button key={mode} type="button" onClick={() => update({ tagMode: mode })} aria-pressed={search.tagMode === mode}
                  className={cn('rounded px-2 py-0.5', search.tagMode === mode ? 'bg-nebula text-white' : 'text-starlight/60 hover:text-starlight')}>
                  Match {mode.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <TagPicker label="Include tags" tone="include" value={search.tags} options={tags} blocked={search.exclude} onChange={(next) => update({ tags: next })} placeholder="Add tag" />
            <TagPicker label="Exclude tags" tone="exclude" value={search.exclude} options={tags} blocked={search.tags} onChange={(next) => update({ exclude: next })} placeholder="Add tag" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <label className={cn(heading, 'flex min-w-0 flex-col gap-1 md:col-span-2')}>
            Sort
            <select value={search.sort} onChange={(event) => update({ sort: event.target.value })} className={cn(control, 'font-normal normal-case tracking-normal')}>
              {sortOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className={cn(heading, 'flex min-w-0 flex-col gap-1')}>
            Cards
            <select value={search.fork} onChange={(event) => update({ fork: event.target.value as LibrarySearch['fork'] })} className={cn(control, 'font-normal normal-case tracking-normal')}>
              <option value="">Originals and forks</option>
              <option value="none">Originals only</option>
              <option value="only">Forks only</option>
            </select>
          </label>
          <div className="flex items-end">
            <button type="button" disabled={!isFiltered(search)} onClick={() => { setText(''); setExpr(''); replace({ ...emptySearch, sort: search.sort }); }}
              className="w-full rounded-md border border-nebula/30 px-3 py-1.5 text-sm font-semibold text-starlight/70 hover:border-nebula disabled:opacity-40">
              Clear filters
            </button>
          </div>
        </div>

        <Disclosure title={<span className="uppercase tracking-wide">Advanced flags</span>} defaultOpen={search.has.length > 0}
          badge={search.has.length ? <span className="rounded bg-nebula/20 px-1.5 py-0.5 text-[10px] text-nebula">{search.has.length}</span> : null}>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {flagOptions.map((flag) => (
              <label key={flag.value} className="flex cursor-pointer items-center gap-2 rounded-md border border-nebula/20 px-3 py-1.5 text-sm text-starlight/80 hover:border-nebula/50">
                <input type="checkbox" checked={search.has.includes(flag.value)}
                  onChange={(event) => update({ has: event.target.checked ? [...search.has, flag.value] : search.has.filter((value) => value !== flag.value) })} />
                {flag.label.replace(/^Has /, '').replace(/^./, (char) => char.toUpperCase())}
              </label>
            ))}
          </div>
        </Disclosure>
      </form>

      {advanced && saved && (
        <Disclosure title={<span className="uppercase tracking-wide">Saved searches{saved.length ? ` (${saved.length})` : ''}</span>}>
          <div className="flex flex-wrap items-center gap-2">
            {saved.map((item) => (
              <span key={item.name} className="inline-flex items-center gap-1 rounded-full border border-nebula/30 px-3 py-1 text-xs">
                <button type="button" onClick={() => replace(readSearch(new URLSearchParams(item.params)))} className="font-semibold text-starlight/80 hover:text-nebula">{item.name}</button>
                <button type="button" aria-label={`Remove saved search ${item.name}`} onClick={() => onForget?.(item.name)} className="px-1 text-starlight/40 hover:text-red-300">✕</button>
              </span>
            ))}
            <button type="button" onClick={onSave} disabled={!isFiltered(search)}
              className="rounded-md border border-dashed border-nebula/40 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-starlight/60 hover:border-nebula hover:text-nebula disabled:opacity-40">
              + Save current search
            </button>
          </div>
        </Disclosure>
      )}
    </div>
  );
}

