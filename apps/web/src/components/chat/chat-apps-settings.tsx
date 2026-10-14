import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui';
import { cn } from '@/lib/utils/cn';
import { formatRelative } from '@/lib/utils/format';
import { chatKinds, kindInfo, useChatApi, useChatTargets } from '@/lib/chat';
import type { ChatKind, ChatTarget } from '@/lib/chat';

const input = 'w-full rounded-lg border border-nebula/30 bg-deep-space/60 px-3 py-2 text-sm text-starlight placeholder:text-starlight/30 focus:border-nebula focus:outline-none';

function AddForm({ onDone }: { onDone: () => void }) {
  const api = useChatApi();
  const [kind, setKind] = useState<ChatKind>('sillytavern');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState(kindInfo('sillytavern').defaultUrl);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), [api]);
  const info = kindInfo(kind);

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    const controller = new AbortController(); operation.current = controller;
    const credentials = { ...(username ? { username, password } : {}), ...(info.auth === 'login' && apiKey ? { apiKey } : {}) };
    setUsername(''); setPassword(''); setApiKey('');
    let created: ChatTarget | null = null;
    try {
      const target = await api.add({ kind, baseUrl, ...(name.trim() ? { name: name.trim() } : {}), credentials }, controller.signal);
      created = target; controller.signal.throwIfAborted(); setSaved(true);
      await api.check(target.id, controller.signal);
      // First look: find copies of library cards that are already there.
      await api.scan(target.id, controller.signal); controller.signal.throwIfAborted();
      onDone();
    } catch (failure) {
      if (!controller.signal.aborted) setError(`${failure instanceof Error ? failure.message : 'Could not connect'}${created ? ' — connection saved. Close this form and fix its details below.' : ''}`);
    } finally { if (operation.current === controller) operation.current = null; if (!controller.signal.aborted) setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="glass space-y-3 rounded-xl border border-nebula/20 p-4">
      <h2 className="font-semibold">Connect a chat app</h2>
      <div className="flex flex-wrap gap-2">
        {chatKinds.map((item) => (
          <button key={item.kind} type="button" disabled={!item.ready}
            onClick={() => { setKind(item.kind); setBaseUrl(item.defaultUrl); }}
            className={cn('rounded-lg px-3 py-1.5 text-sm', kind === item.kind ? 'bg-nebula/30 text-nebula' : 'bg-cosmic-teal/30 text-starlight/70', !item.ready && 'cursor-not-allowed opacity-40')}
            title={item.ready ? undefined : 'Coming next'}>
            {item.label}{item.ready ? '' : ' (soon)'}
          </button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-starlight/60">Address
          <input className={input} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={info.defaultUrl} required />
        </label>
        <label className="space-y-1 text-xs text-starlight/60">Name (optional)
          <input className={input} value={name} onChange={(event) => setName(event.target.value)} placeholder={info.label} />
        </label>
        <label className="space-y-1 text-xs text-starlight/60">{info.auth === 'basic' ? 'Username (only if basic auth is on)' : 'Username (only if login is on)'}
          <input className={input} value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" />
        </label>
        <label className="space-y-1 text-xs text-starlight/60">Password
          <input className={input} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" />
        </label>
        {info.auth === 'login' && (
          <label className="space-y-1 text-xs text-starlight/60 sm:col-span-2">Or a session token instead of username and password
            <input className={input} type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" />
          </label>
        )}
      </div>
      <p className="text-xs text-starlight/40">Credentials stay on this machine; the browser never sees them again.</p>
      {error && <p className="text-sm text-red-300" role="alert">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" isLoading={busy} disabled={saved}>Connect</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

function TargetRow({ target }: { target: ChatTarget }) {
  const api = useChatApi();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [editing, setEditing] = useState(false);
  const [baseUrl, setBaseUrl] = useState(target.baseUrl);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), [api, target.id]);

  async function run(key: string, action: (signal: AbortSignal) => Promise<string>) {
    const controller = new AbortController(); operation.current?.abort(); operation.current = controller;
    setBusy(key); setMessage(null);
    try { const text = await action(controller.signal); if (!controller.signal.aborted) setMessage({ text, error: false }); }
    catch (failure) { if (!controller.signal.aborted) setMessage({ text: failure instanceof Error ? failure.message : 'That did not work', error: true }); }
    finally { if (operation.current === controller) operation.current = null; if (!controller.signal.aborted) setBusy(null); }
  }
  const scanned = target.scannedAt ? formatRelative(Math.floor(Date.parse(target.scannedAt) / 1000)) : null;

  return (
    <li className="glass rounded-xl border border-nebula/20 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="rounded bg-cosmic-teal/50 px-2 py-1 text-xs font-bold">{kindInfo(target.kind).short}</span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{target.name}</div>
          <div className="truncate text-xs text-starlight/50">{target.baseUrl}</div>
        </div>
        <div className="text-right text-xs">
          {target.scanError
            ? <span className="text-red-300" title={target.scanError}>Last check failed</span>
            : <span className="text-starlight/50">{scanned ? `Checked ${scanned}` : 'Never checked'}</span>}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" isLoading={busy === 'check'} disabled={!!busy}
          onClick={() => run('check', async (signal) => `Connected — ${(await api.check(target.id, signal)).characters} characters there.`)}>Test connection</Button>
        <Button size="sm" variant="secondary" isLoading={busy === 'scan'} disabled={!!busy}
          onClick={() => run('scan', async (signal) => { const { found } = await api.scan(target.id, signal); return `Found ${found} cop${found === 1 ? 'y' : 'ies'} of library cards.`; })}>Check copies</Button>
        <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setEditing(!editing)}>Edit</Button>
        <Button size="sm" variant="ghost" disabled={!!busy} className="text-red-300"
          onClick={() => { if (window.confirm(`Disconnect ${target.name}? Its copies stay in the app; unity forgets where they are.`)) void run('remove', async (signal) => { await api.remove(target.id, signal); return 'Removed.'; }); }}>Disconnect</Button>
      </div>
      {editing && (
        <form className="mt-3 grid gap-2 sm:grid-cols-3" onSubmit={(event) => { event.preventDefault(); const credentials = username ? { username, password } : undefined;
          setUsername(''); setPassword(''); void run('save', async (signal) => {
          await api.update(target.id, { baseUrl, ...(credentials ? { credentials } : {}) }, signal); signal.throwIfAborted(); setEditing(false); return 'Saved.';
        }); }}>
          <input className={input} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} aria-label="Address" />
          <input className={input} value={username} onChange={(event) => setUsername(event.target.value)} placeholder="New username (optional)" autoComplete="off" />
          <input className={input} type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="New password" autoComplete="new-password" />
          <div className="sm:col-span-3"><Button type="submit" size="sm" isLoading={busy === 'save'}>Save</Button></div>
        </form>
      )}
      {(message || target.scanError) && (
        <p className={cn('mt-2 text-xs', message?.error || (!message && target.scanError) ? 'text-red-300' : 'text-emerald-300')}>{message?.text ?? target.scanError}</p>
      )}
    </li>
  );
}

/** Chat app connections, shown as a section of Settings. */
export function ChatAppsSettings() {
  const api = useChatApi();
  const { targets, available, error, retry } = useChatTargets();
  const [adding, setAdding] = useState(false);
  useEffect(() => setAdding(false), [api]);
  if (!available) return <p className="text-sm text-starlight/60">Chat apps are only available in the self-hosted app.</p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-starlight/60">Send cards to your chat apps and see which copy lives where. Copies are checked every few minutes.</p>
        {!adding && <Button size="sm" onClick={() => setAdding(true)}>Connect an app</Button>}
      </div>
      {error && <div><p role="alert" className="text-sm text-red-200">{error}</p><button type="button" onClick={retry} className="mt-2 text-sm text-nebula">Retry chat connections</button></div>}
      {!targets && !error && <p role="status" className="text-sm text-starlight/50">Loading chat connections…</p>}
      {adding && <AddForm onDone={() => setAdding(false)} />}
      {targets && targets.length === 0 && !adding && <p className="rounded-lg border border-dashed border-nebula/30 p-4 text-center text-sm text-starlight/50">No chat apps connected yet.</p>}
      <ul className="space-y-3">{targets?.map((target) => <TargetRow key={target.id} target={target} />)}</ul>
    </div>
  );
}
