import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui';
import { cn } from '@/lib/utils/cn';
import { kindInfo, sendCard, statusInfo, useChatTargets } from '@/lib/chat';
import type { ChatPlacement, ChatTarget } from '@/lib/chat';

function SendIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
    </svg>
  );
}

function Toast({ message, error, onDone }: { message: string; error: boolean; onDone: () => void }) {
  useEffect(() => { const timer = setTimeout(onDone, error ? 8000 : 4000); return () => clearTimeout(timer); }, [onDone, error]);
  return createPortal(
    <div role={error ? 'alert' : 'status'} className={cn('fixed bottom-4 right-4 z-[200] max-w-[calc(100vw-2rem)] rounded-lg px-4 py-3 text-sm text-white shadow-lg', error ? 'bg-red-600' : 'bg-emerald-600')}>
      {message}
    </div>, document.body);
}

/**
 * "Send to…" menu for one card. With one connected app it sends directly; with several it lists them
 * with the card's current copy status in each.
 */
export function SendMenu({ cardId, placements = [], variant = 'button', className }: {
  cardId: string; placements?: ChatPlacement[] | undefined; variant?: 'button' | 'icon' | 'wide'; className?: string;
}) {
  const { targets, available } = useChatTargets();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  if (!available || !targets) return null;

  async function send(target: ChatTarget) {
    setOpen(false); setBusy(target.id);
    try {
      const placed = await sendCard(target, cardId);
      if (placed) setToast({ message: `Sent to ${target.name}`, error: false });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : `Could not send to ${target.name}`, error: true });
    } finally { setBusy(null); }
  }
  const stop = (event: React.MouseEvent) => { event.stopPropagation(); event.preventDefault(); };
  const label = busy ? 'Sending…' : targets.length === 1 ? `Send to ${targets[0]!.name}` : 'Send to…';
  const onTrigger = (event: React.MouseEvent) => {
    stop(event);
    if (targets.length === 1) void send(targets[0]!); else setOpen(!open);
  };

  return (
    <div ref={ref} className={cn('relative', className)} onClick={(event) => event.stopPropagation()}>
      {variant === 'icon' ? (
        <button onClick={onTrigger} disabled={!!busy} title={targets.length ? label : 'Connect a chat app to send cards'}
          className="flex h-8 w-8 items-center justify-center rounded-lg bg-black/70 text-white hover:bg-nebula disabled:opacity-60">
          <SendIcon className={cn('h-4 w-4', busy && 'animate-pulse')} />
        </button>
      ) : (
        <Button variant="secondary" size="sm" onClick={onTrigger} disabled={!!busy} className={cn(variant === 'wide' && 'w-full')}>
          <SendIcon className="mr-1.5 h-4 w-4" />{targets.length ? label : 'Send to chat app'}
        </Button>
      )}
      {open && (
        <div className={cn('absolute z-50 mt-1 w-64 rounded-lg border border-nebula/30 py-1 text-sm shadow-xl glass', variant === 'icon' ? 'right-0' : 'left-0')}>
          {targets.length === 0 && (
            <Link href="/settings#chat-apps" className="block px-3 py-2 text-starlight/70 hover:bg-cosmic-teal/30">Connect SillyTavern or another chat app…</Link>
          )}
          {targets.map((target) => {
            const copy = placements.find((row) => row.targetId === target.id && row.status !== 'missing');
            return (
              <button key={target.id} onClick={(event) => { stop(event); void send(target); }}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-cosmic-teal/30">
                <span className="truncate">{copy ? 'Update in' : 'Send to'} {target.name}</span>
                {copy && <span className={cn('shrink-0 rounded border px-1.5 text-[10px]', statusInfo[copy.status].tone)}>{statusInfo[copy.status].label}</span>}
              </button>
            );
          })}
        </div>
      )}
      {toast && <Toast message={toast.message} error={toast.error} onDone={() => setToast(null)} />}
    </div>
  );
}

/** Compact presence chips for a tile: one per chat app holding a live copy. */
export function PlacementChips({ placements }: { placements: ChatPlacement[] | undefined }) {
  const live = (placements ?? []).filter((row) => row.status !== 'missing');
  if (!live.length) return null;
  const byTarget = new Map<string, ChatPlacement>();
  for (const row of live) if (!byTarget.has(row.targetId) || row.status === 'current') byTarget.set(row.targetId, row);
  return (
    <>
      {[...byTarget.values()].map((row) => (
        <div key={row.targetId} title={`${row.targetName}: ${statusInfo[row.status].label} — ${statusInfo[row.status].hint}`}
          className={cn('rounded border px-1.5 py-0.5 text-xs font-medium backdrop-blur', statusInfo[row.status].tone, 'bg-black/60')}>
          {kindInfo(row.kind).short}{row.status === 'current' ? ' ✓' : row.status === 'behind' ? ' ↻' : ' ✎'}
        </div>
      ))}
    </>
  );
}
