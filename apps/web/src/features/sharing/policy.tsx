import { useId } from 'react';
import type { PublicationPolicy } from './client';

export function PolicyFields({ value, disabled, onChange }: { value: PublicationPolicy; disabled: boolean; onChange(value: PublicationPolicy): void }) {
  const id = useId();
  return <div className="space-y-4 text-sm">
    <div className="space-y-1.5">
      <label htmlFor={`${id}-visibility`} className="block font-medium">Who can read</label>
      <select id={`${id}-visibility`} value={value.visibility} disabled={disabled}
        onChange={(event) => onChange({ ...value, visibility: event.target.value as PublicationPolicy['visibility'] })}
        className="w-full rounded-lg px-3 py-2">
        <option value="private">Only me</option><option value="members">Hub members</option><option value="public">Public policy</option>
      </select>
      <p className="text-xs text-starlight/50">Every current publication route still requires sign-in. Public policy does not enable anonymous hosting.</p>
    </div>
    <label className="flex items-center gap-2"><input type="checkbox" checked={value.allowFork} disabled={disabled}
      onChange={(event) => onChange({ ...value, allowFork: event.target.checked })} />Allow forks</label>
    <label className="flex items-center gap-2"><input type="checkbox" checked={value.allowOriginal} disabled={disabled}
      onChange={(event) => onChange({ ...value, allowOriginal: event.target.checked })} />Allow original-file downloads</label>
    <p className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-relaxed text-amber-200/80">
      Original files can include private metadata removed from the published card. Review the original before allowing downloads.
    </p>
  </div>;
}
