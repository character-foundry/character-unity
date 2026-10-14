import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLibraryClient } from './unity';
import type { SessionConnection } from './session';

describe('native Archive browser requests', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());
  async function client() {
    const fetcher = vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>().mockImplementation(async (input) => {
      if (String(input).includes('/cards?')) return { cards: [], total: 0, complete: false, snapshot: 'a'.repeat(64), matches: [], scores: [] };
      return { cardId: 'reference-id', created: true };
    });
    const connection: SessionConnection = {
      actor: { id: 'owner', uri: 'urn:owner' }, name: 'Owner', profile: 'local', capabilities: { browserLLM: true },
      scopeKey: 'owner-connection', signal: new AbortController().signal,
      request: async <T>(path: string, init?: RequestInit) => await fetcher(path, init) as T,
      fetch: async () => new Response(), reconnect: async () => {}, subscribe: () => () => {},
      snapshot: () => ({ status: 'active', reason: null }), dispose() {},
    };
    return { api: (await import('./archive')).createArchiveClient(createLibraryClient(connection, 'workspace /?')), fetcher, connection };
  }

  it('sends submitted mode, typed filter, page snapshot and cancellation to the native route', async () => {
    const { api, fetcher } = await client();
    const controller = new AbortController();
    const params = new URLSearchParams({ q: 'forest', mode: 'hybrid', filter: 'tokenCount > 10', offset: '48', snapshot: 'a'.repeat(64) });
    const result = await api.list(params, controller.signal);
    const [path, init] = fetcher.mock.calls.at(-1)!;
    expect(String(path)).toContain('/api/workspaces/workspace%20%2F%3F/archive/v2/cards?');
    const submitted = new URL(String(path), 'https://local.invalid').searchParams;
    expect(Object.fromEntries(submitted)).toEqual(Object.fromEntries(params));
    expect(init?.signal).toBe(controller.signal); expect(result.complete).toBe(false);
    await api.status(controller.signal);
    expect(fetcher.mock.calls.at(-1)?.[1]?.signal).toBe(controller.signal);
  });

  it.each(['import', 'favorite'] as const)('pins the displayed Archive version when adding a %s reference', async (method) => {
    const { api, fetcher } = await client();
    expect(await api[method]('source /?', 'displayed-version')).toEqual({ cardId: 'reference-id', created: true });
    const [path, init] = fetcher.mock.calls.at(-1)!;
    expect(String(path)).toContain(`/archive/v2/cards/source%20%2F%3F/${method}`);
    expect(init?.method).toBe(method === 'favorite' ? 'PUT' : 'POST');
    expect(init?.body).toBe(JSON.stringify({ versionId: 'displayed-version' }));
  });

  it('reads the displayed Archive version and cancels abandoned quick views', async () => {
    const { api, fetcher } = await client();
    const controller = new AbortController();
    await api.card('source /?', 'version /?', controller.signal);
    const [path, init] = fetcher.mock.calls.at(-1)!;
    expect(String(path)).toBe('/api/workspaces/workspace%20%2F%3F/archive/v2/cards/source%20%2F%3F?version=version+%2F%3F');
    expect(init?.signal).toBe(controller.signal);
    await api.card('source /?');
    expect(String(fetcher.mock.calls.at(-1)![0])).toBe('/api/workspaces/workspace%20%2F%3F/archive/v2/cards/source%20%2F%3F');
  });
  it('encodes providers and immutable object URLs without consulting another session or workspace', async () => {
    const { api, fetcher } = await client();
    expect(api.objectUrl('hash/one')).toBe('/api/workspaces/workspace%20%2F%3F/archive/v2/objects/hash%2Fone');
    await api.saveSource('provider /?', { enabled: false });
    expect(fetcher.mock.calls.at(-1)![0]).toBe('/api/workspaces/workspace%20%2F%3F/archive/v2/sources/provider%20%2F%3F');
    await api.runs('provider /?');
    expect(fetcher.mock.calls.at(-1)![0]).toBe('/api/workspaces/workspace%20%2F%3F/archive/v2/runs?provider=provider+%2F%3F');
    expect(api.workspaceId).toBe('workspace /?'); expect(api.scopeKey).toContain('owner-connection');
  });
  it('propagates auth and stale-page failures, rather than empty successful pages', async () => {
    const { api, fetcher } = await client();
    fetcher.mockRejectedValueOnce(new Error('This browser belongs to another account'));
    await expect(api.list(new URLSearchParams())).rejects.toThrow('another account');
    fetcher.mockResolvedValueOnce({ cards: [{ id: 'duplicate' }, { id: 'duplicate' }], total: 2 });
    await expect(api.list(new URLSearchParams())).rejects.toThrow('invalid result page');
  });
  it('passes cancellation through both pinned mutations and source administration', async () => {
    const { api, fetcher } = await client(); const signal = new AbortController().signal;
    await api.import('card', 'version', signal); expect(fetcher.mock.calls.at(-1)![1]?.signal).toBe(signal);
    await api.favorite('card', 'version', signal); expect(fetcher.mock.calls.at(-1)![1]?.signal).toBe(signal);
    await api.block('card', signal); expect(fetcher.mock.calls.at(-1)![1]?.signal).toBe(signal);
    await api.sources(signal); expect(fetcher.mock.calls.at(-1)![1]?.signal).toBe(signal);
    await api.cancel(3, signal); expect(fetcher.mock.calls.at(-1)![1]?.signal).toBe(signal);
  });
});
