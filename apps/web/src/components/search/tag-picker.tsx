import { useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils/cn';
import { sameTag } from '@/lib/library-search';

const tones = {
  include: 'bg-emerald-500/20 text-emerald-200 border-emerald-500/40',
  exclude: 'bg-red-500/20 text-red-200 border-red-500/40',
  hidden: 'bg-starlight/10 text-starlight/70 border-starlight/20',
} as const;

/**
 * Multi-tag picker with library counts: type to filter, Enter or click to add, Backspace removes the last
 * chip. Tags picked on the other side (`blocked`) are not offered. Unknown tags can be added as typed.
 * `compact` is the filter bar's one-line field (label read by screen readers only).
 */
export function TagPicker({ label, tone, value, onChange, options, blocked = [], placeholder = 'Add tag…', className, compact = false, icon }: {
  label: string; tone: keyof typeof tones; value: readonly string[]; onChange: (tags: string[]) => void;
  options: readonly { tag: string; count: number }[]; blocked?: readonly string[]; placeholder?: string; className?: string;
  compact?: boolean; icon?: React.ReactNode;
}) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const suggestions = useMemo(() => {
    const needle = text.trim().toLowerCase();
    const taken = [...value, ...blocked];
    const matches = options.filter((option) => !taken.some((tag) => sameTag(tag, option.tag)) && option.tag.toLowerCase().includes(needle));
    // Prefix matches first, then by how common the tag is (options arrive most-used first).
    if (needle) matches.sort((a, b) => Number(!a.tag.toLowerCase().startsWith(needle)) - Number(!b.tag.toLowerCase().startsWith(needle)));
    return matches.slice(0, 40);
  }, [text, value, blocked, options]);
  const exact = suggestions.some((option) => sameTag(option.tag, text.trim()));
  const custom = text.trim() && !exact && ![...value, ...blocked].some((tag) => sameTag(tag, text.trim())) ? text.trim() : null;
  // Known tags first so Enter picks the best match; adding the typed text as-is comes last.
  const entries = [...suggestions, ...(custom ? [{ tag: custom, count: -1 }] : [])];

  const add = (tag: string) => {
    if (!value.some((existing) => sameTag(existing, tag))) onChange([...value, tag]);
    setText(''); setActive(0); input.current?.focus();
  };
  const remove = (tag: string) => onChange(value.filter((existing) => existing !== tag));

  return (
    <div className={cn('relative', className)}>
      {!compact && <div className="mb-1 text-xs font-medium text-starlight/60">{label}</div>}
      <div className={cn('flex items-center rounded-md border border-nebula/25 focus-within:border-nebula',
        compact ? 'h-8 gap-1 overflow-x-auto bg-cosmic-teal/60 px-2' : 'min-h-[34px] flex-wrap gap-1.5 border-nebula/30 bg-deep-space/60 px-2 py-1')}
        onClick={() => input.current?.focus()}>
        {icon}
        {value.map((tag) => (
          <span key={tag} className={cn('inline-flex shrink-0 items-center gap-1 border', compact ? 'rounded px-1.5 py-px text-[11px] font-medium' : 'rounded-full px-2 py-0.5 text-xs', tones[tone])}>
            {tone === 'exclude' && compact && '−'}{tag}
            <button type="button" aria-label={`Remove ${tag}`} onClick={(event) => { event.stopPropagation(); remove(tag); }} className="opacity-70 hover:opacity-100">✕</button>
          </span>
        ))}
        <input ref={input} value={text} placeholder={value.length ? '' : placeholder} aria-label={label}
          className={cn('min-w-[6rem] flex-1 p-0 text-starlight placeholder:text-starlight/40 focus:outline-none', compact ? 'text-[13px]' : 'text-sm')}
          // The global input rule is unlayered and outranks utilities; this input sits inside the field's own border.
          style={{ border: 'none', background: 'transparent', boxShadow: 'none', outline: 'none' }}
          onChange={(event) => { setText(event.target.value); setOpen(true); setActive(0); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActive((index) => Math.min(index + 1, entries.length - 1)); }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)); }
            else if (event.key === 'Enter' || (event.key === ',' && text.trim())) {
              event.preventDefault();
              const entry = entries[active] ?? (text.trim() ? { tag: text.trim() } : null);
              if (entry) add(entry.tag);
            } else if (event.key === 'Backspace' && !text && value.length) remove(value[value.length - 1]!);
            else if (event.key === 'Escape') setOpen(false);
          }} />
      </div>
      {open && entries.length > 0 && (
        <ul role="listbox" className="absolute z-40 mt-1 max-h-72 w-full min-w-[14rem] overflow-auto rounded-lg border border-nebula/30 bg-deep-space/95 py-1 text-sm shadow-xl backdrop-blur">
          {entries.map((entry, index) => (
            <li key={`${entry.count}:${entry.tag}`} role="option" aria-selected={index === active}
              onMouseDown={(event) => { event.preventDefault(); add(entry.tag); }} onMouseEnter={() => setActive(index)}
              className={cn('flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5', index === active ? 'bg-cosmic-teal/40' : 'hover:bg-cosmic-teal/30')}>
              <span className="truncate">{entry.count < 0 ? <>Add “{entry.tag}”</> : entry.tag}</span>
              {entry.count >= 0 && <span className="shrink-0 text-xs text-starlight/40">{entry.count}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
