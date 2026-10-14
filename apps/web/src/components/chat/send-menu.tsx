import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui';
import { cn } from '@/lib/utils/cn';
import { kindInfo, statusInfo, useChatApi, useChatTargets } from '@/lib/chat';
import type { ChatPlacement, ChatTarget } from '@/lib/chat';
import { useTileMenuPosition } from '@/components/cards/menu-position';

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
  const api = useChatApi();
  const { targets, available, error: targetError, retry } = useChatTargets();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const position = useTileMenuPosition(ref, menu, open && variant === 'icon');
  const operation = useRef<AbortController | null>(null);
  useEffect(() => {
    setOpen(false); setBusy(null); setToast(null);
    return () => operation.current?.abort();
  }, [api, cardId]);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const close = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  if (!available) return null;
  if (targetError) return <button type="button" onClick={(event) => { event.stopPropagation(); retry(); }} title={targetError}
    className="rounded px-2 py-1 text-xs text-red-200">Chat unavailable · retry<span className="sr-only" role="alert">{targetError}</span></button>;
  if (!targets) return null;

  async function send(target: ChatTarget) {
    const controller = new AbortController(); operation.current?.abort(); operation.current = controller;
    setOpen(false); setBusy(target.id);
    try {
      const placed = await api.sendCard(target, cardId, controller.signal);
      if (placed && !controller.signal.aborted) setToast({ message: `Sent to ${target.name}`, error: false });
    } catch (error) {
      if (!controller.signal.aborted) setToast({ message: error instanceof Error ? error.message : `Could not send to ${target.name}`, error: true });
    } finally { if (operation.current === controller) { operation.current = null; if (!controller.signal.aborted) setBusy(null); } }
  }
  const stop = (event: React.MouseEvent) => { event.stopPropagation(); event.preventDefault(); };
  const label = busy ? 'Sending…' : targets.length === 1 ? `Send to ${targets[0]!.name}` : 'Send to…';
  const onTrigger = (event: React.MouseEvent) => {
    stop(event);
    if (targets.length === 1) void send(targets[0]!); else setOpen(!open);
  };

  return (
    <div ref={ref} className={cn('relative', className)} onClick={(event) => event.stopPropagation()}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
      {variant === 'icon' ? (
        <button ref={trigger} type="button" onClick={onTrigger} disabled={!!busy} title={targets.length ? label : 'Connect a chat app to send cards'}
          aria-label={targets.length ? label : 'Connect a chat app to send cards'} aria-haspopup={targets.length === 1 ? undefined : 'menu'}
          aria-expanded={targets.length === 1 ? undefined : open} aria-controls={open ? menuId : undefined}
          onKeyDown={(event) => { if (targets.length !== 1 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); setOpen(true); } }}
          className="grid h-7 w-7 place-items-center rounded text-white/75 transition-colors hover:bg-white/15 hover:text-white focus-visible:bg-white/15 disabled:opacity-60">
          <SendIcon className={cn('h-3.5 w-3.5', busy && 'animate-pulse')} />
        </button>
      ) : (
        <Button ref={trigger} type="button" variant="secondary" size="sm" onClick={onTrigger} disabled={!!busy} aria-haspopup={targets.length === 1 ? undefined : 'menu'}
          aria-expanded={targets.length === 1 ? undefined : open} aria-controls={open ? menuId : undefined}
          onKeyDown={(event) => { if (targets.length !== 1 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); setOpen(true); } }}
          className={cn(variant === 'wide' && 'w-full')}>
          <SendIcon className="mr-1.5 h-4 w-4" />{targets.length ? label : 'Send to chat app'}
        </Button>
      )}
      {open && (
        <div ref={menu} id={menuId} role="menu" aria-label="Send to chat app"
          onKeyDown={(event) => {
            const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
            const index = items.indexOf(document.activeElement as HTMLElement);
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
            else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
            else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); items[event.key === 'Home' ? 0 : items.length - 1]?.focus(); }
            else if (event.key === 'Tab') { trigger.current?.focus(); setOpen(false); }
          }}
          style={variant === 'icon' ? { transform: `translateX(${position.shiftX}px)`, maxHeight: position.maxHeight } : undefined}
          className={cn('absolute z-50 w-64 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-md border border-starlight/10 bg-surface-2 p-1 text-sm text-starlight shadow-xl shadow-black/50', variant === 'icon' ? (position.below ? 'top-full right-0 mt-1' : 'bottom-full right-0 mb-1') : 'left-0 mt-1')}>
          {targets.length === 0 && (
            <Link to="/settings#chat-apps" role="menuitem" tabIndex={-1} className="block rounded px-2 py-2 text-text-muted hover:bg-starlight/5 focus:bg-starlight/10">Connect SillyTavern or another chat app…</Link>
          )}
          {targets.map((target) => {
            const copy = placements.find((row) => row.targetId === target.id && row.status !== 'missing');
            return (
              <button key={target.id} type="button" role="menuitem" tabIndex={-1} onClick={(event) => { stop(event); void send(target); }}
                className="flex w-full items-center justify-between gap-2 rounded px-2 py-2 text-left hover:bg-starlight/5 focus:bg-starlight/10">
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
export function PlacementChips({ placements, className }: { placements: ChatPlacement[] | undefined; className?: string }) {
  const live = (placements ?? []).filter((row) => row.status !== 'missing');
  if (!live.length) return null;
  const byTarget = new Map<string, ChatPlacement>();
  for (const row of live) if (!byTarget.has(row.targetId) || row.status === 'current') byTarget.set(row.targetId, row);
  return (
    <>
      {[...byTarget.values()].map((row) => (
        <div key={row.targetId} title={`${row.targetName}: ${statusInfo[row.status].label} — ${statusInfo[row.status].hint}`}
          className={cn('rounded border px-1.5 py-0.5 text-xs font-medium backdrop-blur', statusInfo[row.status].tone, 'bg-black/60', className)}>
          {kindInfo(row.kind).short}{row.status === 'current' ? ' ✓' : row.status === 'behind' ? ' ↻' : ' ✎'}
        </div>
      ))}
    </>
  );
}
