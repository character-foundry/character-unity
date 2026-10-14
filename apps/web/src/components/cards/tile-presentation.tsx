import { formatCount } from '../../lib/utils/format';

export const tileBadge = 'flex items-center gap-0.5 rounded bg-black/55 px-1 py-0.5 text-[10px] font-semibold text-white/90 backdrop-blur-sm';

/** Tokens stay with the metadata at the top, leaving every density's action footer usable. */
export function TileTokens({ count }: { count: number | null }) {
  if (count === null) return null;
  return <span className={`${tileBadge} pointer-events-none tabular-nums`} title={`${count.toLocaleString()} tokens`}>
    <svg className="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true"><path strokeLinecap="round" d="M4 5h16M4 10h10M4 15h16M4 20h10" /></svg>
    {formatCount(count)}<span className="sr-only"> tokens</span>
  </span>;
}

export function ForkIcon() {
  return <svg className="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true"><circle cx="6" cy="4" r="2" /><circle cx="18" cy="4" r="2" /><circle cx="12" cy="20" r="2" /><path d="M6 6v3a6 6 0 006 6m6-9v3a6 6 0 01-6 6v3" /></svg>;
}
