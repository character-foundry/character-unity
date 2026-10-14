export interface ClientProfile {
  profile: 'local' | 'hub';
  capabilities: { browserLLM: boolean };
}
export interface SessionInfo {
  actor: { id: string; uri: string };
  name: string;
  expiresAt: number | null;
}
export interface ConnectionState { status: 'active' | 'locked' | 'disposed'; reason: string | null }
export interface SessionConnection {
  readonly actor: Readonly<SessionInfo['actor']>;
  readonly name: string;
  readonly profile: ClientProfile['profile'];
  readonly capabilities: Readonly<ClientProfile['capabilities']>;
  readonly scopeKey: string;
  readonly signal: AbortSignal;
  request<T>(path: string, init?: RequestInit): Promise<T>;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  reconnect(signal?: AbortSignal): Promise<void>;
  subscribe(listener: () => void): () => void;
  snapshot(): ConnectionState;
  dispose(): void;
}
export class SessionError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

async function responseError(response: Response): Promise<SessionError> {
  const value = await response.json().catch(() => null) as { error?: { code?: unknown; message?: unknown } } | null;
  return new SessionError(response.status, typeof value?.error?.code === 'string' ? value.error.code : 'UNAVAILABLE',
    typeof value?.error?.message === 'string' ? value.error.message : `Request failed (${response.status})`);
}
function sessionInfo(input: unknown, local = false): SessionInfo {
  const value = input as Partial<SessionInfo> | null;
  if (!value?.actor || typeof value.actor.id !== 'string' || !value.actor.id || typeof value.actor.uri !== 'string'
    || (!local && (typeof value.name !== 'string' || typeof value.expiresAt !== 'number'))) {
    throw new SessionError(503, 'UNAVAILABLE', 'The host returned an invalid session');
  }
  return { actor: { id: value.actor.id, uri: value.actor.uri }, name: local ? 'Local owner' : value.name!, expiresAt: local ? null : value.expiresAt! };
}

/** One explicit host profile and immutable actor per connection. No request ever
 * consults a mutable current account, and disposing cancels the captured lifetime. */
export function createSessionRuntime(options: { fetch?: typeof fetch } = {}) {
  const transport = options.fetch ?? globalThis.fetch.bind(globalThis);
  const owned = new WeakMap<SessionConnection, { unlock(): void }>();
  let discovered: ClientProfile | undefined;
  async function raw(path: string, init: RequestInit = {}) {
    const parsed = new URL(path, 'https://unity.invalid');
    if (!path.startsWith('/api/') || path.includes('\\') || parsed.origin !== 'https://unity.invalid' || !parsed.pathname.startsWith('/api/')) {
      throw new SessionError(400, 'INVALID_INPUT', 'Only same-host API paths are allowed');
    }
    const signal = AbortSignal.any([AbortSignal.timeout(120_000), ...(init.signal ? [init.signal] : [])]);
    signal.throwIfAborted();
    const response = await transport(path, { ...init, credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal });
    signal.throwIfAborted();
    return response;
  }
  async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await raw(path, init);
    if (!response.ok) throw await responseError(response);
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
  async function profile(signal?: AbortSignal): Promise<ClientProfile> {
    signal?.throwIfAborted();
    if (discovered) return discovered;
    const value = await json<unknown>('/api/client', signal ? { signal } : {}) as Partial<ClientProfile> | null;
    if (!value || !['local', 'hub'].includes(value.profile ?? '') || typeof value.capabilities?.browserLLM !== 'boolean'
      || (value.profile === 'hub' && value.capabilities.browserLLM)) throw new SessionError(503, 'UNAVAILABLE', 'The host returned an invalid client profile');
    discovered = Object.freeze({ profile: value.profile!, capabilities: Object.freeze({ browserLLM: value.capabilities.browserLLM }) });
    return discovered;
  }
  function connect(host: ClientProfile, info: SessionInfo): SessionConnection {
    const lifetime = new AbortController();
    const listeners = new Set<() => void>();
    let state: ConnectionState = Object.freeze({ status: 'active', reason: null });
    const setState = (status: ConnectionState['status'], reason: string | null) => {
      if (state.status === 'disposed') return;
      state = Object.freeze({ status, reason });
      for (const listener of listeners) listener();
    };
    const active = () => {
      lifetime.signal.throwIfAborted();
      if (state.status === 'locked') throw new SessionError(401, 'UNAUTHENTICATED', state.reason ?? 'Reconnect to continue');
    };
    async function reconnect(signal?: AbortSignal) {
      lifetime.signal.throwIfAborted();
      const init = { signal: AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]) };
      try {
        const current = host.profile === 'local'
          ? sessionInfo(await json('/api/local-session', { ...init, method: 'POST', headers: { 'x-unity-session': 'local' } }), true)
          : sessionInfo(await json('/api/session', init));
        if (current.actor.id !== info.actor.id || current.actor.uri !== info.actor.uri) throw new SessionError(409, 'ACCOUNT_CHANGED', 'Sign in with the same account to recover this work');
        setState('active', null);
      } catch (error) {
        if (error instanceof SessionError && (error.status === 401 || error.code === 'ACCOUNT_CHANGED')) setState('locked', error.message);
        throw error;
      }
    }
    async function send(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
      active();
      const headers = new Headers(init.headers);
      headers.set('x-unity-actor', info.actor.id);
      const signal = AbortSignal.any([lifetime.signal, ...(init.signal ? [init.signal] : [])]);
      const response = await raw(path, { ...init, headers, signal });
      if (response.status === 401) {
        if (host.profile === 'local' && !retried) { await response.body?.cancel(); await reconnect(signal); return send(path, { ...init, signal }, true); }
        const error = await responseError(response.clone());
        await response.body?.cancel();
        setState('locked', error.message);
        throw error;
      }
      if (response.status === 409) {
        const error = await responseError(response.clone());
        if (error.code === 'ACCOUNT_CHANGED') { await response.body?.cancel(); setState('locked', error.message); throw error; }
      }
      return response;
    }
    const connection: SessionConnection = Object.freeze({
      actor: Object.freeze({ ...info.actor }), name: info.name, profile: host.profile,
      capabilities: host.capabilities, scopeKey: `${host.profile}:${info.actor.id}:${crypto.randomUUID()}`, signal: lifetime.signal,
      fetch: send,
      async request<T>(path: string, init: RequestInit = {}): Promise<T> {
        const response = await connection.fetch(path, init);
        if (!response.ok) throw await responseError(response);
        if (response.status === 204) return undefined as T;
        return response.json() as Promise<T>;
      },
      reconnect,
      snapshot: () => state,
      subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      dispose() { setState('disposed', null); lifetime.abort(); listeners.clear(); },
    });
    owned.set(connection, { unlock() { setState('active', null); } });
    return connection;
  }
  return {
    profile,
    async restore(signal?: AbortSignal) {
      const host = await profile(signal);
      const info = host.profile === 'local'
        ? sessionInfo(await json('/api/local-session', { method: 'POST', headers: { 'x-unity-session': 'local' }, ...(signal ? { signal } : {}) }), true)
        : sessionInfo(await json('/api/session', signal ? { signal } : {}));
      return connect(host, info);
    },
    async connectLocal(signal?: AbortSignal) {
      const host = await profile(signal);
      if (host.profile !== 'local') throw new SessionError(403, 'FORBIDDEN', 'This host requires an account sign-in');
      return connect(host, sessionInfo(await json('/api/local-session', { method: 'POST', headers: { 'x-unity-session': 'local' }, ...(signal ? { signal } : {}) }), true));
    },
    async login(key: string, input: { expected?: SessionConnection; signal?: AbortSignal } = {}) {
      const host = await profile(input.signal);
      if (host.profile !== 'hub') throw new SessionError(400, 'INVALID_INPUT', 'This host uses the local owner session');
      input.expected?.signal.throwIfAborted();
      if (input.expected && !owned.has(input.expected)) throw new SessionError(400, 'INVALID_INPUT', 'The connection belongs to another runtime');
      const info = sessionInfo(await json('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }),
        ...(input.signal ? { signal: input.signal } : {}) }));
      if (input.expected) {
        if (input.expected.actor.id !== info.actor.id || input.expected.actor.uri !== info.actor.uri) {
          await json('/api/session', { method: 'DELETE', headers: { 'x-unity-actor': info.actor.id }, ...(input.signal ? { signal: input.signal } : {}) });
          throw new SessionError(409, 'ACCOUNT_CHANGED', `Sign in as ${input.expected.name} to recover this work, or discard it to switch accounts`);
        }
        input.expected.signal.throwIfAborted();
        owned.get(input.expected)!.unlock();
        return input.expected;
      }
      return connect(host, info);
    },
    async logout(connection: SessionConnection) {
      if (!owned.has(connection)) throw new SessionError(400, 'INVALID_INPUT', 'The connection belongs to another runtime');
      if (connection.profile === 'hub') await json('/api/session', { method: 'DELETE', headers: { 'x-unity-actor': connection.actor.id } });
      connection.dispose();
    },
  };
}
export type SessionRuntime = ReturnType<typeof createSessionRuntime>;
