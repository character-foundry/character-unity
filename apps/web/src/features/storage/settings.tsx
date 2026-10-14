import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { useLibraryClient } from '@/lib/library-client';
import { createBrowserMaintenanceClient, type BrowserCleanupPreview, type BrowserMaintenanceClient } from '@/lib/browser-maintenance';

const bytes = (value: number) => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 / 1024).toFixed(1)} MiB`;
function StoragePanel({ client }: { client: BrowserMaintenanceClient }) {
  const [preview, setPreview] = useState<BrowserCleanupPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState<BrowserCleanupPreview | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [status, setStatus] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), [client]);
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    const controller = new AbortController(); operation.current?.abort(); operation.current = controller;
    setBusy(true); setError(null); setStatus(null);
    try { await action(controller.signal); }
    catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Browser cleanup could not be confirmed.'); }
    finally { if (operation.current === controller) { operation.current = null; if (!controller.signal.aborted) setBusy(false); } }
  }
  async function refresh(signal: AbortSignal) {
    const value = await client.preview(signal);
    if (!signal.aborted) { setPreview(value); setSelected(new Set()); }
  }
  const close = () => { if (!busy) { setConfirmation(null); setError(null); } };
  const chosen = preview?.items.filter((item) => selected.has(item.assetId)) ?? [];
  return <div className="space-y-3" data-browser-storage-settings>
    <p className="text-sm text-starlight/70">Review old local browser objects before removing bytes. Live cards, their full history and fork ancestry, and Archive files are kept. Nothing runs automatically.</p>
    <button type="button" onClick={() => void run(refresh)} disabled={busy} className="btn-secondary px-3 py-2 text-sm disabled:opacity-50">{busy && !confirmation ? 'Checking…' : 'Preview browser cleanup'}</button>
    {preview && <>
      <p className="text-xs text-starlight/60">Eligible objects were last required before {new Date(preview.before).toLocaleString()} (at least 24 hours ago).</p>
      {preview.items.length === 0 ? <p role="status" className="text-sm text-starlight/70">No eligible local objects. Young and referenced objects are kept.</p> : <>
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><p>{preview.items.length}{preview.hasMore ? '+' : ''} eligible objects · {bytes(preview.items.reduce((total, item) => total + item.storedByteLength, 0))} stored bytes</p>
          <button type="button" disabled={busy} onClick={() => setSelected(selected.size === preview.items.length ? new Set() : new Set(preview.items.map((item) => item.assetId)))} className="text-xs text-nebula disabled:opacity-50">{selected.size === preview.items.length ? 'Deselect all' : 'Select reviewed page'}</button></div>
        <ul className="max-h-64 space-y-2 overflow-y-auto rounded-lg border border-nebula/20 p-3">
          {preview.items.map((item) => <li key={item.assetId}><label className="flex items-start gap-2 text-xs text-starlight/75">
            <input type="checkbox" aria-label={`Select object ${item.assetId}`} checked={selected.has(item.assetId)} disabled={busy} onChange={(event) => setSelected((previous) => { const next = new Set(previous); if (event.target.checked) next.add(item.assetId); else next.delete(item.assetId); return next; })} />
            <span className="min-w-0"><span className="break-all font-mono">{item.assetId}</span><span className="mt-1 block text-starlight/50">{item.reason === 'deleted-card' ? 'Deleted-card files' : 'Unreferenced upload'} · {item.mediaType} · {bytes(item.storedByteLength)}</span></span>
          </label></li>)}
        </ul>
        <button type="button" disabled={busy || !chosen.length} onClick={() => { setError(null); setConfirmation({ ...preview, items: chosen }); }} className="rounded-lg border border-red-400/40 px-3 py-2 text-sm text-red-200 disabled:opacity-50">Review selected objects ({chosen.length})</button>
      </>}
      {preview.unknownAge.length > 0 && <div className="space-y-2 rounded-lg border border-amber-400/25 bg-amber-400/5 p-3">
        <p className="text-sm text-amber-100">{preview.unknownAge.length}{preview.unknownMore ? '+' : ''} legacy orphan objects have no recorded age.</p>
        <p className="text-xs text-starlight/65">They cannot be removed yet. Starting their age clock records this observation only, then requires another 24 hours and a new preview. No bytes are deleted.</p>
        <button type="button" disabled={busy} onClick={() => void run(async (signal) => {
          const result = await client.observe(preview.unknownAge.map((item) => item.assetId), signal);
          if (!signal.aborted) { setPreview(null); setStatus(`Recorded ${result.observed} orphan objects. Earliest cleanup: ${new Date(result.eligibleAfter).toLocaleString()}.`); }
          await refresh(signal);
        })} className="btn-secondary px-3 py-2 text-sm disabled:opacity-50">Start 24-hour clock</button>
      </div>}
    </>}
    {status && <p role="status" className="text-sm text-emerald-200">{status}</p>}
    {error && !confirmation && <p role="alert" className="text-sm text-red-200">{error}</p>}
    <Modal isOpen={!!confirmation} onClose={close} label="Confirm browser object cleanup">
      <ModalHeader>Remove browser objects?</ModalHeader>
      <ModalBody className="space-y-3">
        <p className="text-sm text-starlight/80">Remove {confirmation?.items.length} reviewed objects ({bytes(confirmation?.items.reduce((total, item) => total + item.storedByteLength, 0) ?? 0)}). Card, revision and source metadata remain, but deleted bytes cannot be recovered from this browser. Keep a backup of anything you may need.</p>
        <ul className="max-h-40 space-y-1 overflow-y-auto rounded-lg bg-deep-space/40 p-3 text-xs text-starlight/65">{confirmation?.items.map((item) => <li key={item.assetId} className="break-all font-mono">{item.assetId} · {bytes(item.storedByteLength)}</li>)}</ul>
        <p className="text-xs text-starlight/60">The application rechecks every object and all live references atomically. If any selected object became live or changed, nothing in this selection is removed.</p>
        {error && <p role="alert" className="text-sm text-red-200">{error}</p>}
      </ModalBody>
      <ModalFooter>
        <button type="button" onClick={close} disabled={busy} className="btn-secondary px-3 py-2 text-sm disabled:opacity-50">Cancel</button>
        <button type="button" disabled={busy} onClick={() => confirmation && void run(async (signal) => {
          const result = await client.apply(confirmation, signal);
          if (signal.aborted) return;
          setConfirmation(null); setPreview(null); setSelected(new Set());
          setStatus(`Removed ${result.removed} objects (${bytes(result.bytesRemoved)}); ${result.alreadyRemoved} already removed.`);
          await refresh(signal);
        })} className="rounded-lg border border-red-400/40 bg-red-500/15 px-3 py-2 text-sm text-red-100 disabled:opacity-50">{busy ? 'Removing…' : 'Remove selected objects'}</button>
      </ModalFooter>
    </Modal>
  </div>;
}
export function BrowserStorageSettings() {
  const library = useLibraryClient(), client = useMemo(() => createBrowserMaintenanceClient(library), [library]);
  return client.available ? <StoragePanel key={library.scopeKey} client={client} /> : null;
}
