import { useId, useState } from 'react';
import { Button } from '@/components/ui';
import { useSettings } from '@/lib/settings';
import { archiveSortOptions, emptySearch, flagOptions, loadSavedSearches, readSearch, sourceOptions, storeSavedSearches, writeSearch } from '@/lib/library-search';
import type { LibrarySearch, SavedSearch } from '@/lib/library-search';
import { archiveIsFiltered, archiveMode, archiveModes, archiveOrders, modeAvailable } from '@/lib/archive-search';
import type { ArchiveStatus } from '@/lib/archive-search';
import { TagPicker } from './tag-picker';

const field = 'min-w-0 rounded-md border border-nebula/30 bg-cosmic-teal px-2.5 py-1.5 text-[13px] text-starlight';
const label = 'flex min-w-0 flex-col gap-1 text-[12px] text-starlight/60';

/** A submitted native Archive query. Draft form edits never launch embedding/provider requests. */
export function ArchiveSearchBar({ search, submit, retry, status, tags, loading }: {
  search: LibrarySearch; submit(search: LibrarySearch): void; retry(): void;
  status: ArchiveStatus | null; tags: readonly { tag: string; count: number }[]; loading: boolean;
}) {
  const [draft, setDraft] = useState(search);
  const [saved, setSaved] = useState<SavedSearch[]>(() => loadSavedSearches('archive'));
  const { settings, updateSettings } = useSettings();
  const guide = useId();
  const mode = archiveMode(draft), capabilities = status?.capabilities;
  const patch = (changes: Partial<LibrarySearch>) => setDraft((previous) => ({ ...previous, ...changes }));
  const orders = archiveSortOptions.filter((option) => archiveOrders(mode, capabilities).includes(option.value));
  const defaultOrder = mode === 'browse' && !archiveOrders(mode, capabilities).includes('updated') ? orders[0]?.label ?? 'Unavailable' : 'Recently updated';
  const selectedOrderAvailable = !draft.sort || orders.some((option) => option.value === draft.sort);
  const hasTypedFilters = !!capabilities?.filterFields?.length;
  const semantic = mode === 'semantic' || mode === 'hybrid';
  const save = () => {
    const name = window.prompt('Name this Archive search', draft.q.trim() || draft.archiveFilter.trim() || 'My Archive search')?.trim();
    if (!name) return;
    const next = [...saved.filter((item) => item.name.toLowerCase() !== name.toLowerCase()), { name, params: writeSearch(draft).toString() }].sort((a, b) => a.name.localeCompare(b.name));
    setSaved(next); storeSavedSearches(next, 'archive');
  };
  return <section aria-label="Archive search controls" className="border-b border-nebula/20 bg-deep-space/95 px-3 py-3 sm:px-4">
    <form onSubmit={(event) => { event.preventDefault(); submit({ ...draft, archiveMode: mode }); }} className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className={label}>Search mode
          <select aria-label="Archive search mode" className={field} value={mode} onChange={(event) => patch({ archiveMode: event.target.value, sort: '' })}>
            {archiveModes.map((option) => <option key={option.value} value={option.value} disabled={option.value !== 'lexical' && !modeAvailable(option.value, capabilities)}>
              {option.label}{status && !modeAvailable(option.value, capabilities) ? ' (unavailable)' : ''}
            </option>)}
            {!archiveModes.some((option) => option.value === mode) && <option value={mode}>Unavailable: {mode}</option>}
          </select>
        </label>
        <label className={`${label} min-w-[160px] flex-1`}>Query
          <input aria-label="Archive query" maxLength={2000} value={draft.q} className={field} aria-describedby={guide} spellCheck={!semantic}
            placeholder={mode === 'browse' ? 'Clear text for filter-only browsing' : semantic ? 'Describe the character you want…' : '"silver forest" OR ocean'}
            onChange={(event) => patch({ q: event.target.value })} />
        </label>
        <label className={label}>Order
          <select aria-label="Archive result order" className={field} value={draft.sort} onChange={(event) => patch({ sort: event.target.value })}>
            <option value="">{semantic ? 'Relevance' : `Default (${defaultOrder})`}</option>
            {orders.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            {!selectedOrderAvailable && <option value={draft.sort} disabled>Unavailable: {draft.sort}</option>}
          </select>
        </label>
        <Button type="submit" size="sm">Search Archive</Button>
        {loading && <span role="status" className="py-2 text-[12px] text-starlight/60">Searching…</span>}
        <button type="button" onClick={retry} className="py-2 text-[12px] text-starlight/60 hover:text-starlight">Refresh capabilities</button>
      </div>
      <p id={guide} className="text-[12px] text-starlight/55">
        {mode === 'lexical' ? 'Search indexed card text with words, quoted phrases, AND, OR, NOT and parentheses. Use the filters below instead of library field prefixes. A blank query browses Archive metadata.'
          : mode === 'semantic' ? 'Search by meaning. Your submitted query is sent to the operator-configured embedding provider; it may incur provider charges.'
            : mode === 'hybrid' ? 'Combine keywords and meaning (40% semantic weight). Your submitted query is sent to the operator-configured embedding provider; it may incur provider charges.'
              : 'Browse existing indexed fields without full-text or embedding calls. Clear the text query; blank filters include the whole indexed selection.'}
      </p>
      {semantic && <p className="text-[12px] text-amber-200/80">
        {capabilities?.embedding ? <>Model: {capabilities.embedding.model} · {capabilities.embedding.dimensions} dimensions. Vector coverage: {capabilities.embedding.indexedCards === null ? 'not reported' : `${capabilities.embedding.indexedCards.toLocaleString()} of ${status?.cards.toLocaleString()} cards`}
          {capabilities.embedding.indexedRows !== null && ` (${capabilities.embedding.indexedRows.toLocaleString()} indexed sections)`}.</>
          : 'Embedding model and vector coverage are not reported by this Archive.'}
        {' '}Semantic results are a bounded candidate set, not an exhaustive match count.
      </p>}
      {draft.expr && <label className={label}>Additional card-text expression (from the saved URL)
        <input aria-label="Additional Archive text" value={draft.expr} className={field} onChange={(event) => patch({ expr: event.target.value })} />
      </label>}
      <details open={!!draft.archiveFilter || !!draft.tags.length || !!draft.exclude.length || !!draft.has.length || !!draft.source || !!draft.minTokens}>
        <summary className="cursor-pointer text-[13px] font-medium text-starlight/75">Filters and saved searches</summary>
        <div className="mt-2 space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <TagPicker label="Include tags" tone="include" value={draft.tags} options={tags} blocked={draft.exclude} onChange={(tags) => patch({ tags })} />
            <TagPicker label="Exclude tags" tone="exclude" value={draft.exclude} options={tags} blocked={draft.tags} onChange={(exclude) => patch({ exclude })} />
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className={label}>Included tags
              <select aria-label="Archive tag matching" className={field} value={draft.tagMode} onChange={(event) => patch({ tagMode: event.target.value === 'any' ? 'any' : 'all' })}>
                <option value="all">Match all</option><option value="any">Match any</option>
              </select>
            </label>
            <label className={label}>Source
              <select aria-label="Archive source" className={field} value={draft.source} onChange={(event) => patch({ source: event.target.value })}>
                {sourceOptions.filter((option) => option.value !== 'file').map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                {draft.source && !sourceOptions.some((option) => option.value === draft.source) && <option value={draft.source}>{draft.source}</option>}
              </select>
            </label>
            <label className={label}>Min tokens
              <input aria-label="Archive minimum tokens" type="number" min={0} max={10000000} step={1} value={draft.minTokens} className={`${field} w-28`} onChange={(event) => patch({ minTokens: event.target.value })} />
            </label>
            <label className={label}>Card size
              <select aria-label="Archive card size" className={field} value={settings.cardSize} onChange={(event) => updateSettings({ cardSize: event.target.value as typeof settings.cardSize })}>
                <option value="large">Large</option><option value="medium">Medium</option><option value="small">Small</option>
              </select>
            </label>
            <button type="button" onClick={save} className="py-2 text-[12px] font-medium text-nebula">Save this search</button>
            {!!saved.length && <label className={label}>Saved searches
              <select aria-label="Saved Archive searches" className={field} value="" onChange={(event) => {
                const found = saved.find((item) => item.name === event.target.value); if (found) setDraft(readSearch(new URLSearchParams(found.params)));
              }}><option value="">Choose…</option>{saved.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select>
            </label>}
          </div>
          <div className="flex flex-wrap gap-2">
            {flagOptions.filter((option) => option.value !== 'chat' && (capabilities?.has.includes(option.value) || draft.has.includes(option.value))).map((option) => <label key={option.value} className="flex items-center gap-1.5 text-[12px] text-starlight/70">
              <input type="checkbox" checked={draft.has.includes(option.value)} disabled={!capabilities?.has.includes(option.value) && !draft.has.includes(option.value)}
                onChange={(event) => patch({ has: event.target.checked ? [...draft.has, option.value] : draft.has.filter((flag) => flag !== option.value) })} />
              {option.label}{!capabilities?.has.includes(option.value) && ' (unavailable; remove to retry)'}
            </label>)}
            {draft.has.filter((flag) => flag === 'chat' || !flagOptions.some((option) => option.value === flag)).map((flag) => <button key={flag} type="button" onClick={() => patch({ has: draft.has.filter((value) => value !== flag) })} className="text-[12px] text-red-300">Remove unsupported filter: {flag}</button>)}
          </div>
          {(hasTypedFilters || draft.archiveFilter) && <label className={label}>Typed index filter
            <input aria-label="Archive typed filter" value={draft.archiveFilter} maxLength={4096} className={`${field} font-mono`} spellCheck={false}
              placeholder='tokenCount >= 1200 AND hasLorebook = true' aria-describedby={`${guide}-fields`} onChange={(event) => patch({ archiveFilter: event.target.value })} />
            <span id={`${guide}-fields`}>Comparisons, IN lists, inclusive ranges (100 TO 200), EXISTS, AND, OR and NOT. Available fields: {capabilities?.filterFields?.map((item) => `${item.name} (${item.type})`).join(', ') || 'none; clear the filter to retry'}.</span>
          </label>}
          {(settings.hideNsfw || settings.bannedTags.length > 0) && <p className="text-[12px] text-starlight/45">Settings exclusions also apply: {[...(settings.hideNsfw ? ['NSFW'] : []), ...settings.bannedTags].join(', ')}.</p>}
        </div>
      </details>
      {archiveIsFiltered(draft) && <button type="button" onClick={() => { setDraft(emptySearch); submit(emptySearch); }} className="text-[12px] font-medium text-nebula">Clear filters and query</button>}
    </form>
  </section>;
}
