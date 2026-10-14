import { useEffect, useRef, useState } from 'react';
import { Modal } from '@/components/ui/modal';
import type { ContentClient, ContentPolicy, ContentRecord, SharedContent } from './client';

export const privateContentPolicy: Readonly<ContentPolicy> = Object.freeze({ visibility: 'private',allowFork: false,allowOriginal: false });
export function ContentPolicyFields({ value,onChange,disabled }: { value: ContentPolicy; onChange(value: ContentPolicy): void; disabled: boolean }) {
  return <div className="space-y-3 text-sm">
    <label className="block space-y-1"><span>Who can read</span><select aria-label="Content visibility" value={value.visibility} disabled={disabled}
      onChange={(event) => onChange({ ...value,visibility: event.target.value as ContentPolicy['visibility'] })} className="block w-full rounded-lg px-3 py-2">
      <option value="private">Only me</option><option value="members">Signed-in members</option><option value="public">Public policy</option>
    </select></label>
    <label className="flex items-center gap-2"><input type="checkbox" checked={value.allowFork} disabled={disabled} onChange={(event) => onChange({ ...value,allowFork: event.target.checked })} />Allow private forks</label>
    <label className="flex items-center gap-2"><input type="checkbox" checked={value.allowOriginal} disabled={disabled} onChange={(event) => onChange({ ...value,allowOriginal: event.target.checked })} />Allow exact original-file downloads</label>
    <p className="text-xs leading-relaxed text-amber-200/80">Review every field: presets and personas can contain passwords, provider keys or private prompts. Nothing is stripped automatically. Originals can also contain metadata absent from this saved revision.</p>
    <p className="text-xs text-starlight/50">Hosting authentication still applies. This native content profile does not participate in signed character-card federation.</p>
  </div>;
}
export function ContentPublisher({ client,record,onClose }: { client: ContentClient; record: ContentRecord; onClose(): void }) {
  const [policy,setPolicy] = useState<ContentPolicy>({ ...privateContentPolicy }), [reviewed,setReviewed] = useState(false);
  const [busy,setBusy] = useState(false), [error,setError] = useState<string | null>(null), [published,setPublished] = useState<SharedContent | null>(null);
  const lifetime = useRef<AbortController | null>(null), running = useRef(false);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); },[]);
  async function publish() {
    if (!reviewed || running.current) return; running.current = true; setBusy(true); setError(null);
    const signal = lifetime.current!.signal;
    try { const result = await client.publish(record,policy,signal); if (!signal.aborted) setPublished(result); }
    catch (failure) { if (!signal.aborted) setError(`${failure instanceof Error ? failure.message : 'Publication was not confirmed.'} Check My shared items before retrying: a lost response may follow a committed publication.`); }
    finally { running.current = false; if (!signal.aborted) setBusy(false); }
  }
  return <Modal isOpen onClose={() => { if (!busy) onClose(); }} label="Review standalone content publication" size="lg">
    <div className="space-y-4 p-5"><div className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">Review before sharing</h2>
      <p className="mt-1 text-sm text-starlight/60">{record.revision.title} · saved revision {record.revision.sequence}. Unsaved edits and later heads are not included.</p></div>
      <button type="button" disabled={busy} onClick={onClose} aria-label="Close publication review" className="px-2 py-1">×</button></div>
      {published ? <div role="status" className="space-y-2 rounded-lg border border-nebula/30 p-4"><p>Saved revision published with {published.visibility} visibility.</p>
        <p className="break-all text-xs text-starlight/60">Publication {published.id}</p><button type="button" className="btn-primary px-3 py-2" onClick={onClose}>Done</button></div>
        : <><pre aria-label="Exact JSON selected for sharing" className="max-h-72 overflow-auto rounded-lg border border-nebula/20 bg-deep-space p-3 text-xs">{JSON.stringify(record.revision.json,null,2)}</pre>
          <ContentPolicyFields value={policy} disabled={busy} onChange={(value) => { setPolicy(value); setReviewed(false); }} />
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={reviewed} disabled={busy} onChange={(event) => setReviewed(event.target.checked)} />I reviewed this exact JSON and its sharing permissions.</label>
          {error && <p role="alert" className="text-sm text-red-200">{error}</p>}
          <button type="button" disabled={!reviewed || busy} onClick={() => { void publish(); }} className="btn-primary px-4 py-2 disabled:opacity-50">{busy ? 'Publishing…' : 'Publish selected revision'}</button></>}
    </div>
  </Modal>;
}
