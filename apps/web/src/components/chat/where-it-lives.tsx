import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { cn } from '@/lib/utils/cn';
import { formatRelative } from '@/lib/utils/format';
import { kindInfo, statusInfo, useChatApi, useChatTargets, usePlacementState } from '@/lib/chat';
import type { ChatPlacement, ChatTarget } from '@/lib/chat';

const seconds = (iso: string | null) => (iso ? Math.floor(Date.parse(iso) / 1000) : null);

/** Profile panel: every chat app copy of this card, how it compares to the library, and what to do about it. */
export function WhereItLives({ cardId }: { cardId: string }) {
  const api = useChatApi();
  const { targets, available, error: targetError, retry } = useChatTargets();
  const placementState = usePlacementState([cardId]);
  const placements = placementState.placements.get(cardId) ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => { setBusy(null); setError(null); return () => operation.current?.abort(); }, [api, cardId]);
  if (!available) return null;
  if (targetError) return <section className="glass mb-4 rounded-xl p-4"><p role="alert" className="text-sm text-red-200">{targetError}</p>
    <button type="button" onClick={retry} className="mt-2 text-sm text-nebula">Retry chat connections</button></section>;
  if (!targets) return null;

  async function run(key: string, action: (signal: AbortSignal) => Promise<unknown>) {
    const controller = new AbortController(); operation.current?.abort(); operation.current = controller;
    setBusy(key); setError(null);
    try { await action(controller.signal); } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'That did not work'); }
    finally { if (operation.current === controller) { operation.current = null; if (!controller.signal.aborted) setBusy(null); } }
  }
  const rescan = () => run('scan', async (signal) => {
    for (const target of targets) await api.scan(target.id, signal);
  });
  const send = (target: ChatTarget) => run(target.id, (signal) => api.sendCard(target, cardId, signal));
  const forget = (row: ChatPlacement) => run(`${row.targetId}:${row.remoteId}`, (signal) => api.forget(row.targetId, row.remoteId, signal));
  const without = targets.filter((target) => !placements.some((row) => row.targetId === target.id && row.status !== 'missing'));
  const lastScan = targets.map((target) => target.scannedAt).filter(Boolean).sort().at(-1) ?? null;

  return (
    <section className="glass mb-4 rounded-xl border border-nebula/20 p-4" data-where-it-lives>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-starlight/90">Where it lives</h2>
          <p className="text-xs text-starlight/50">
            {targets.length === 0 ? 'No chat apps connected.' : lastScan ? `Checked ${formatRelative(seconds(lastScan)!)}` : 'Not checked yet.'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {targets.length > 0 && (
            <button onClick={rescan} disabled={!!busy} className="rounded-lg border border-nebula/30 px-3 py-1.5 text-xs text-starlight/80 hover:bg-cosmic-teal/30 disabled:opacity-50">
              {busy === 'scan' ? 'Checking…' : 'Check now'}
            </button>
          )}
          <Link to="/settings#chat-apps" className="rounded-lg border border-nebula/30 px-3 py-1.5 text-xs text-starlight/80 hover:bg-cosmic-teal/30">
            {targets.length ? 'Manage apps' : 'Connect a chat app'}
          </Link>
        </div>
      </div>

      {placements.length > 0 && (
        <ul className="space-y-2">
          {placements.map((row) => {
            const target = targets.find((item) => item.id === row.targetId);
            const key = `${row.targetId}:${row.remoteId}`;
            return (
              <li key={key} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-deep-space/40 px-3 py-2 text-sm">
                <span className="w-7 shrink-0 rounded bg-cosmic-teal/50 py-0.5 text-center text-[10px] font-bold text-starlight/80">{kindInfo(row.kind).short}</span>
                <span className="min-w-0 flex-1">
                  <span className="text-starlight/90">{row.targetName}</span>
                  <span className="ml-2 truncate text-xs text-starlight/40" title={row.remoteId}>{row.remoteId}</span>
                </span>
                <span className={cn('rounded border px-2 py-0.5 text-xs', statusInfo[row.status].tone)} title={statusInfo[row.status].hint}>
                  {statusInfo[row.status].label}
                  {row.status === 'behind' && row.revisionSequence ? ` · rev ${row.revisionSequence} of ${row.headSequence}` : ''}
                </span>
                <span className="text-xs text-starlight/40" title={row.sentAt ? `Sent ${new Date(row.sentAt).toLocaleString()}` : 'Found in the app'}>
                  {row.sentAt ? `sent ${formatRelative(seconds(row.sentAt)!)}` : 'found there'}
                </span>
                {target && row.status !== 'current' && row.status !== 'missing' && (
                  <button onClick={() => void send(target)} disabled={!!busy} className="rounded-lg bg-nebula/20 px-2.5 py-1 text-xs text-nebula hover:bg-nebula/30 disabled:opacity-50">
                    {busy === target.id ? 'Sending…' : row.status === 'edited' ? 'Overwrite' : 'Update'}
                  </button>
                )}
                {row.status === 'missing' && (
                  <button onClick={() => void forget(row)} disabled={!!busy} className="rounded-lg px-2.5 py-1 text-xs text-starlight/50 hover:bg-cosmic-teal/30 disabled:opacity-50">
                    Forget
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {without.length > 0 && (
        <div className={cn('flex flex-wrap gap-2', placements.length > 0 && 'mt-3')}>
          {without.map((target) => (
            <button key={target.id} onClick={() => void send(target)} disabled={!!busy}
              className="rounded-lg border border-dashed border-nebula/40 px-3 py-1.5 text-xs text-starlight/70 hover:border-nebula hover:text-nebula disabled:opacity-50">
              {busy === target.id ? 'Sending…' : `Send to ${target.name}`}
            </button>
          ))}
        </div>
      )}
      {error && <p className="mt-2 text-xs text-red-300" role="alert">{error}</p>}
      {placementState.error && <p className="mt-2 text-xs text-red-300" role="alert">{placementState.error}</p>}
    </section>
  );
}
