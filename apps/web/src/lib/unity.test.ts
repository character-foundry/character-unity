import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('native viewer read contracts', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  async function client() {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (String(input) === '/api/local-session') return Response.json({});
      if (String(input) === '/api/workspaces') return Response.json({ workspaces: [{ id: 'workspace /?', name: 'Library' }] });
      return Response.json({});
    });
    vi.stubGlobal('fetch', fetcher);
    return { api: await import('./unity'), fetcher };
  }

  it('constructs explicit revision-bound asset and original URLs without descriptor URI fallback', async () => {
    const { api } = await client();
    const path = api.assetUrl('workspace /?', 'card /?', 'head /?', 'declared/100');
    expect(path).toBe('/api/workspaces/workspace%20%2F%3F/cards/card%20%2F%3F/asset?revisionId=head+%2F%3F&path=declared%2F100');
    expect(api.portraitUrl('workspace', 'card', 'head')).toBe(api.assetUrl('workspace', 'card', 'head', 'portrait'));
    expect(api.originalUrl('workspace /?', 'card /?')).toBe('/api/workspaces/workspace%20%2F%3F/cards/card%20%2F%3F/original');
  });

  it('passes cancellation to detail, family and revision asset reads', async () => {
    const { api, fetcher } = await client();
    await api.libraryId();
    const controller = new AbortController();
    fetcher.mockImplementation(async (path, options) => {
      expect(options?.signal).toBe(controller.signal);
      expect(String(path)).not.toContain('/api/cards/');
      return Response.json({});
    });
    await api.openCard('card', { signal: controller.signal });
    await api.cardFamily('card', { signal: controller.signal });
    await api.listAssets('card', 'head', controller.signal);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it('reports native read failures instead of treating unavailable data as empty', async () => {
    const { api, fetcher } = await client();
    await api.libraryId();
    fetcher.mockResolvedValue(Response.json({ error: { code: 'ASSET_UNAVAILABLE', message: 'Saved revision asset is unavailable' } }, { status: 503 }));
    await expect(api.listAssets('card', 'head')).rejects.toMatchObject({ status: 503, code: 'ASSET_UNAVAILABLE' });
  });

  it('returns the existing library entry and deduplication outcome from a regular file import', async () => {
    const { api, fetcher } = await client();
    await api.libraryId();
    const file = new File(['exact accepted bytes'], 'already-have.png', { type: 'image/png' });
    fetcher.mockImplementationOnce(async (path, options) => {
      expect(String(path)).toContain('/imports');
      expect(options?.body).toBe(file);
      return Response.json({ card: { id: 'existing-reference' }, import: { created: false, match: 'archive' }, reference: { archiveId: 'archive', cardId: 'source', versionId: 'exact-version' } });
    });
    expect(await api.importFile(file)).toMatchObject({ card: { id: 'existing-reference' }, import: { created: false, match: 'archive' } });
  });

  it.each(['call', 'fetchWithSession'] as const)('cancels %s during 401 reconnect without retrying a superseded read', async (method) => {
    const { api, fetcher } = await client();
    const controller = new AbortController();
    let reconnecting!: () => void;
    const started = new Promise<void>((resolve) => { reconnecting = resolve; });
    fetcher.mockResolvedValueOnce(Response.json({}, { status: 401 })).mockImplementationOnce(async (path, options) => {
      expect(path).toBe('/api/local-session'); expect(options?.signal).toBe(controller.signal);
      reconnecting();
      return new Promise<Response>((_resolve, reject) => { controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }); });
    });
    const pending = api[method]('/api/viewer-read', { signal: controller.signal });
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
