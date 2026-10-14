import { Link } from 'react-router';
import { useMetaTags } from '@/lib/meta-tags';

/** IDs stay distinct from literal tag strings. Missing/deleted selections remain visible and removable. */
export function MetaTagFilters({ include, exclude, onInclude, onExclude }: {
  include: readonly string[]; exclude: readonly string[];
  onInclude(ids: string[]): void; onExclude(ids: string[]): void;
}) {
  const { catalog, loading, error, reload } = useMetaTags();
  const groups = catalog?.groups ?? [];
  function selector(label: string, selected: readonly string[], blocked: readonly string[], change: (ids: string[]) => void) {
    return <div className="min-w-0 space-y-1.5">
      <label className="flex flex-col gap-1 text-xs text-starlight/60">{label}
        <select aria-label={label} value="" disabled={loading || !!error || !catalog}
          className="min-w-0 rounded-md border border-starlight/15 bg-cosmic-teal px-2.5 py-1.5 text-[13px] text-starlight disabled:opacity-50"
          onChange={(event) => { if (event.target.value) change([...selected, event.target.value]); }}>
          <option value="">{loading ? 'Loading Meta-tags…' : !groups.length ? 'No Meta-tags created' : 'Choose a named group…'}</option>
          {groups.filter((group) => !selected.includes(group.id) && !blocked.includes(group.id)).map((group) =>
            <option key={group.id} value={group.id}>{group.name} ({group.members.length} member{group.members.length === 1 ? '' : 's'})</option>)}
        </select>
      </label>
      <div className="flex flex-wrap gap-1.5">{selected.map((id) => {
        const group = groups.find((item) => item.id === id);
        return <span key={id} className={`inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${group ? 'border-nebula/30 bg-nebula/10 text-starlight' : 'border-red-400/40 text-red-200'}`}>
          <span className="break-words">{group?.name ?? `Unavailable Meta-tag: ${id}`}</span>
          <button type="button" aria-label={`Remove ${label.toLowerCase()}: ${group?.name ?? id}`} className="shrink-0 opacity-70 hover:opacity-100"
            onClick={() => change(selected.filter((value) => value !== id))}>×</button>
        </span>;
      })}</div>
    </div>;
  }
  return <section aria-label="Meta-tag filters" className="space-y-2 rounded-lg border border-starlight/10 p-2.5">
    <div className="grid gap-2 sm:grid-cols-2">
      {selector('Include Meta-tags', include, exclude, onInclude)}
      {selector('Exclude Meta-tags', exclude, include, onExclude)}
    </div>
    <p className="text-[11px] leading-relaxed text-starlight/50">Each named group matches its name or any member tag. Literal tags stay literal; no reverse or fuzzy matching. <Link to="/meta-tags" className="font-medium text-nebula hover:underline">Manage Meta-tags</Link></p>
    {error && <p role="alert" className="text-xs text-red-200">Meta-tags unavailable: {error} <button type="button" className="font-medium underline" onClick={reload}>Retry Meta-tags</button></p>}
  </section>;
}
