import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createSessionRuntime, type ClientProfile, type SessionConnection, type SessionRuntime } from './session';

interface SessionContextValue {
  connection: SessionConnection | null;
  profile: ClientProfile | null;
  status: 'loading' | 'signed-out' | 'active' | 'locked';
  error: string | null;
  busy: boolean;
  login(key: string): Promise<void>;
  reconnect(): Promise<void>;
  logout(): Promise<boolean>;
  discardAndSwitch(): Promise<boolean>;
}
const Context = createContext<SessionContextValue | null>(null);
const empty = Object.freeze({ status: 'active' as const, reason: null });
const noSubscription = () => () => {};

/** Expiry locks, but does not unmount, an authenticated editor. A deliberate
 * discard/switch disposes the entire captured account before mounting another. */
export function SessionProvider({ children, runtime: supplied, confirmDiscard = () => window.confirm('Discard this account’s open drafts and switch accounts?') }: {
  children: ReactNode; runtime?: SessionRuntime; confirmDiscard?: () => boolean | Promise<boolean>;
}) {
  const runtime = useMemo(() => supplied ?? createSessionRuntime(), [supplied]);
  const [connection, setConnection] = useState<SessionConnection | null>(null);
  const [profile, setProfile] = useState<ClientProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const operation = useRef<AbortController | null>(null);
  const owner = useRef<SessionConnection | null>(null);
  const recoveryDialog = useRef<HTMLDialogElement>(null);
  const state = useSyncExternalStore(connection?.subscribe ?? noSubscription, connection?.snapshot ?? (() => empty));
  useEffect(() => {
    const controller = new AbortController();
    operation.current = controller;
    let active = true;
    owner.current?.dispose(); owner.current = null; setConnection(null);
    setLoading(true);
    void (async () => {
      const host = await runtime.profile(controller.signal);
      if (active) setProfile(host);
      const restored = await runtime.restore(controller.signal);
      if (!active) { restored.dispose(); return; }
      owner.current = restored; setConnection(restored);
    })().catch((failure: unknown) => {
      if (active) setError(failure instanceof Error ? failure.message : 'The host could not be opened');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); operation.current?.abort(); owner.current?.dispose(); owner.current = null; };
  }, [runtime, attempt]);
  const run = useCallback(async (action: (signal: AbortSignal) => Promise<void>) => {
    operation.current?.abort();
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError(null);
    try { await action(controller.signal); }
    catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'The account action failed');
      throw failure;
    } finally { if (operation.current === controller) setBusy(false); }
  }, []);
  const login = useCallback(async (accessKey: string) => run(async (signal) => {
    const next = await runtime.login(accessKey, { ...(connection ? { expected: connection } : {}), signal });
    signal.throwIfAborted(); owner.current = next; setConnection(next); setKey('');
  }), [connection, run, runtime]);
  const reconnect = useCallback(async () => run(async (signal) => {
    if (!connection) throw new Error('No account is connected');
    await connection.reconnect(signal);
  }), [connection, run]);
  const leave = useCallback(async () => {
    if (!connection || !await confirmDiscard()) return false;
    await run(async () => {
      try { await runtime.logout(connection); }
      finally { connection.dispose(); owner.current = null; setConnection(null); setKey(''); }
    });
    return true;
  }, [connection, confirmDiscard, run, runtime]);
  const status = loading ? 'loading' : !connection ? 'signed-out' : state.status !== 'active' ? 'locked' : 'active';
  const value: SessionContextValue = { connection, profile, status, error: error ?? (status === 'locked' ? state.reason : null), busy, login, reconnect, logout: leave, discardAndSwitch: leave };
  const recovery = !loading && (!connection || status === 'locked');
  useEffect(() => {
    if (!recovery || !recoveryDialog.current) return;
    const element = recoveryDialog.current;
    const overflow = document.body.style.overflow;
    element.showModal(); document.body.style.overflow = 'hidden';
    return () => {
      // Native dialog restoration skips detached/inert prior triggers. Do not
      // explicitly focus a control from the account that was just discarded.
      element.close(); document.body.style.overflow = overflow;
    };
  }, [recovery]);
  return <Context.Provider value={value}>
    {connection && <div key={connection.scopeKey} inert={status === 'locked'} aria-hidden={status === 'locked' ? true : undefined}>{children}</div>}
    {loading && <div role="status" className="p-12 text-center text-starlight/60">Connecting to Unity…</div>}
    <dialog ref={recoveryDialog} aria-labelledby="unity-sign-in" onCancel={(event) => event.preventDefault()}
      className="m-auto w-[calc(100%_-_2rem)] max-w-md max-h-[90dvh] overflow-y-auto space-y-5 rounded-2xl border border-line bg-surface p-6 text-ink shadow-2xl backdrop:bg-black/80">
      {recovery && <>
        <div><h1 id="unity-sign-in" className="text-xl font-semibold">{connection ? `Reconnect as ${connection.name}` : 'Sign in to Unity'}</h1>
          <p className="mt-2 text-sm text-starlight/60">{connection ? 'Your draft is still here. Reconnect with the same account to continue.' : profile?.profile === 'browser' ? 'Open the library stored in this browser. No server account is needed.' : profile?.profile === 'local' ? 'Connect to this installation’s local owner session.' : 'Use the access key supplied by your hub operator.'}</p></div>
        {value.error && <p role="alert" className="text-sm text-red-300">{value.error}</p>}
        {profile?.profile === 'hub' && <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void login(key).catch(() => undefined); }}>
          <label className="block text-sm">Access key<input autoFocus type="password" name="unity-access-key" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} disabled={busy}
            className="mt-2 w-full rounded-lg border border-white/15 bg-void px-3 py-2" /></label>
          <button type="submit" disabled={busy || !key.trim()} className="rounded-lg bg-nebula px-4 py-2 text-white disabled:opacity-50">{busy ? 'Connecting…' : 'Sign in'}</button>
        </form>}
        {profile && profile.profile !== 'hub' && <button type="button" disabled={busy} onClick={() => {
          void run(async (signal) => { if (connection) await connection.reconnect(signal); else { const next = await runtime.connectLocal(signal); owner.current = next; setConnection(next); } }).catch(() => undefined);
        }} className="rounded-lg bg-nebula px-4 py-2 text-white disabled:opacity-50">{profile.profile === 'browser' ? 'Reopen browser library' : 'Reconnect local session'}</button>}
        {!profile && <button type="button" disabled={busy} onClick={() => { setError(null); setAttempt((value) => value + 1); }}>Retry connection</button>}
        {connection && <button type="button" disabled={busy} onClick={() => { void leave().catch(() => undefined); }} className="block text-sm text-starlight/60">Discard draft and switch accounts</button>}
      </>}
    </dialog>
  </Context.Provider>;
}
export function useSession(): SessionContextValue {
  const value = useContext(Context);
  if (!value) throw new Error('The native SessionProvider is required');
  return value;
}
export function useSessionConnection(): SessionConnection {
  const { connection } = useSession();
  if (!connection) throw new Error('An authenticated Unity connection is required');
  return connection;
}
