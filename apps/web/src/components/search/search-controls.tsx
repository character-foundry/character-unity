import { cn } from '@/lib/utils/cn';
import { useSettings } from '@/lib/settings';
import { fieldClass, flagOptions, sortOptions } from '@/lib/library-search';
import type { LibrarySearch } from '@/lib/library-search';
import { TagPicker } from './tag-picker';

export function SortSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <select aria-label="Sort" value={value} onChange={(event) => onChange(event.target.value)} className={cn(fieldClass, 'w-auto pr-8')}>
      {sortOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  );
}

export function FlagChecks({ search, onChange }: { search: LibrarySearch; onChange: (changes: Partial<LibrarySearch>) => void }) {
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
      {flagOptions.map((flag) => (
        <label key={flag.value} className="flex cursor-pointer items-center gap-2 text-starlight/80">
          <input type="checkbox" checked={search.has.includes(flag.value)}
            onChange={(event) => onChange({ has: event.target.checked ? [...search.has, flag.value] : search.has.filter((value) => value !== flag.value) })} />
          {flag.label}
        </label>
      ))}
      <label className="flex items-center gap-2 text-starlight/80">
        <span className="sr-only">Forks</span>
        <select value={search.fork} onChange={(event) => onChange({ fork: event.target.value as LibrarySearch['fork'] })}
          className="rounded border border-nebula/30 bg-deep-space/60 px-2 py-1 text-sm">
          <option value="">Originals and forks</option>
          <option value="none">Originals only</option>
          <option value="only">Forks only</option>
        </select>
      </label>
    </div>
  );
}

/** What stays out of view everywhere: NSFW handling and always-hidden tags. Saved in display settings. */
export function ContentControls({ tagOptions }: { tagOptions: readonly { tag: string; count: number }[] }) {
  const { settings, updateSettings } = useSettings();
  const mode = settings.hideNsfw ? 'hide' : settings.blurNsfwContent ? 'blur' : 'show';
  return (
    <div className="grid gap-3 sm:grid-cols-[auto_1fr] sm:items-end">
      <div>
        <div className="mb-1 text-xs font-medium text-starlight/60">NSFW cards</div>
        <div className="inline-flex overflow-hidden rounded-lg border border-nebula/30" role="radiogroup" aria-label="NSFW cards">
          {(['show', 'blur', 'hide'] as const).map((value) => (
            <button key={value} type="button" role="radio" aria-checked={mode === value}
              onClick={() => updateSettings({ hideNsfw: value === 'hide', blurNsfwContent: value !== 'show' })}
              className={cn('px-3 py-2 text-sm capitalize', mode === value ? 'bg-nebula/30 text-nebula' : 'text-starlight/70 hover:bg-cosmic-teal/30')}>
              {value}
            </button>
          ))}
        </div>
      </div>
      <TagPicker label="Always hide tags" tone="hidden" value={settings.bannedTags} options={tagOptions}
        onChange={(bannedTags) => updateSettings({ bannedTags })} placeholder="Tags you never want to see…" />
    </div>
  );
}
