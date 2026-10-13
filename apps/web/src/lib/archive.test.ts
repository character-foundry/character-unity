import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('native Archive browser requests', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());
  async function client() {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (String(input) === '/api/local-session') return Response.json({});
      if (String(input) === '/api/workspaces') return Response.json({ workspaces: [{ id: 'workspace /?', name: 'Library' }] });
      if (String(input).includes('/cards?')) return Response.json({ cards: [], total: 0, complete: false, snapshot: 'a'.repeat(64), matches: [], scores: [] });
      return Response.json({ cardId: 'reference-id', created: true });
    });
    vi.stubGlobal('fetch', fetcher);
    return { api: (await import('./archive')).archiveApi, fetcher };
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
});
