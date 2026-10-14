import { describe, expect, it, vi } from 'vitest';
import { createSessionRuntime } from './session';

const alice = { actor: { id: 'alice', uri: 'urn:unity:user:alice' }, name: 'Alice', expiresAt: 10_000 };

describe('native immutable account connection', () => {
  it('discovers the account profile and pins every JSON and binary request to its authenticated actor', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (path, options) => {
      if (path === '/api/client') return Response.json({ profile: 'hub', capabilities: { browserLLM: false } });
      if (path === '/api/session') return Response.json(alice);
      expect(new Headers(options?.headers).get('x-unity-actor')).toBe('alice');
      expect(options?.credentials).toBe('same-origin');
      expect(options?.redirect).toBe('error');
      expect(options?.cache).toBe('no-store');
      return Response.json({ saved: true });
    });
    const runtime = createSessionRuntime({ fetch: fetcher });
    const connection = await runtime.restore();
    expect(connection.actor).toEqual(alice.actor);
    expect(connection.capabilities.browserLLM).toBe(false);
    expect(await connection.request('/api/workspaces')).toEqual({ saved: true });
    expect((await connection.fetch('/api/workspaces/desk/cards/card/export', { cache: 'force-cache' })).ok).toBe(true);
    expect(fetcher.mock.calls.map(([path]) => path)).not.toContain('/api/local-session');
    connection.dispose();
  });

  it('reconnects a restarted local host once without using the account sign-in route', async () => {
    let localSessions = 0, reads = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (path) => {
      if (path === '/api/client') return Response.json({ profile: 'local', capabilities: { browserLLM: true } });
      if (path === '/api/local-session') { localSessions++; return Response.json({ actor: { id: 'local', uri: 'urn:unity:user:local' } }); }
      if (++reads === 1) return Response.json({ error: { code: 'UNAUTHENTICATED', message: 'Host restarted' } }, { status: 401 });
      return Response.json({ recovered: true });
    });
    const connection = await createSessionRuntime({ fetch: fetcher }).restore();
    expect(await connection.request('/api/workspaces')).toEqual({ recovered: true });
    expect(localSessions).toBe(2);
    expect(fetcher.mock.calls.map(([path]) => path)).not.toContain('/api/session');
    connection.dispose();
  });

  it.each([401, 409])('locks on %s without retrying the account request, and same-account sign-in keeps the connection', async (status) => {
    let expired = true;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (path) => {
      if (path === '/api/client') return Response.json({ profile: 'hub', capabilities: { browserLLM: false } });
      if (path === '/api/session') return Response.json(alice);
      return expired ? Response.json({ error: { code: status === 409 ? 'ACCOUNT_CHANGED' : 'UNAUTHENTICATED', message: 'Reconnect Alice' } }, { status }) : Response.json({ recovered: true });
    });
    const runtime = createSessionRuntime({ fetch: fetcher }), connection = await runtime.restore();
    await expect(connection.request('/api/workspaces')).rejects.toMatchObject({ status });
    expect(connection.snapshot()).toEqual({ status: 'locked', reason: 'Reconnect Alice' });
    await expect(connection.fetch('/api/workspaces/secret')).rejects.toMatchObject({ status: 401 });
    expired = false;
    expect(await runtime.login('alice-key', { expected: connection })).toBe(connection);
    expect(connection.snapshot().status).toBe('active');
    expect(await connection.request('/api/workspaces')).toEqual({ recovered: true });
    expect(fetcher.mock.calls.map(([path]) => path)).not.toContain('/api/local-session');
    connection.dispose();
  });

  it('rejects a different recovery account, revokes that new session, and never changes the old actor', async () => {
    let revoked = false;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (path, options) => {
      if (path === '/api/client') return Response.json({ profile: 'hub', capabilities: { browserLLM: false } });
      if (path === '/api/session' && options?.method === 'DELETE') { revoked = true; expect(new Headers(options.headers).get('x-unity-actor')).toBe('bob'); return new Response(null, { status: 204 }); }
      if (path === '/api/session') return Response.json(options?.method === 'POST' ? { ...alice, actor: { id: 'bob', uri: 'urn:unity:user:bob' }, name: 'Bob' } : alice);
      return Response.json({ error: { code: 'UNAUTHENTICATED', message: 'Expired' } }, { status: 401 });
    });
    const runtime = createSessionRuntime({ fetch: fetcher }), connection = await runtime.restore();
    await expect(connection.fetch('/api/workspaces')).rejects.toMatchObject({ status: 401 });
    await expect(runtime.login('bob-key', { expected: connection })).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
    expect(revoked).toBe(true);
    expect(connection.actor.id).toBe('alice');
    expect(connection.snapshot().status).toBe('locked');
    connection.dispose();
  });

  it('cancels in-flight reads on disposal and refuses external paths', async () => {
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (path, options) => {
      if (path === '/api/client') return Response.json({ profile: 'hub', capabilities: { browserLLM: false } });
      if (path === '/api/session') return Response.json(alice);
      started();
      return new Promise<Response>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true }));
    });
    const connection = await createSessionRuntime({ fetch: fetcher }).restore();
    await expect(connection.fetch('https://other.example/api/workspaces')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const pending = connection.fetch('/api/workspaces');
    await waiting;
    connection.dispose();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(connection.snapshot().status).toBe('disposed');
  });

  it.each(['request', 'fetch'] as const)('cancels %s during a local 401 reconnect without retrying the superseded read', async (method) => {
    let reconnecting!: () => void;
    const started = new Promise<void>((resolve) => { reconnecting = resolve; });
    let localSessions = 0, reads = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (path, options) => {
      if (path === '/api/client') return Response.json({ profile: 'local', capabilities: { browserLLM: true } });
      if (path === '/api/local-session') {
        if (++localSessions === 1) return Response.json({ actor: { id: 'local', uri: 'urn:unity:user:local' } });
        reconnecting();
        return new Promise<Response>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true }));
      }
      reads++;
      return Response.json({ error: { code: 'UNAUTHENTICATED', message: 'Restarted local host' } }, { status: 401 });
    });
    const connection = await createSessionRuntime({ fetch: fetcher }).restore();
    const controller = new AbortController();
    const pending = connection[method]('/api/viewer-read', { signal: controller.signal });
    await started; controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(reads).toBe(1); expect(localSessions).toBe(2);
    connection.dispose();
  });
});
