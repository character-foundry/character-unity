import { describe, expect, it, vi } from 'vitest';
import { createSessionRuntime } from './session';
import { assetUrl, createLibraryClient, originalUrl, portraitUrl } from './unity';

const alice = { actor: { id: 'alice', uri: 'urn:unity:user:alice' }, name: 'Alice', expiresAt: 10_000 };
async function fixture() {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (path) => {
    if (path === '/api/client') return Response.json({ profile: 'hub', capabilities: { browserLLM: false } });
    if (path === '/api/session') return Response.json(alice);
    return Response.json({});
  });
  const runtime = createSessionRuntime({ fetch: fetcher });
  const connection = await runtime.restore();
  return { client: createLibraryClient(connection, 'workspace /?'), connection, runtime, fetcher };
}

describe('native immutable library client', () => {
  it('constructs explicit revision-bound asset and original URLs without descriptor URI fallback', () => {
    expect(assetUrl('workspace /?', 'card /?', 'head /?', 'declared/100'))
      .toBe('/api/workspaces/workspace%20%2F%3F/cards/card%20%2F%3F/asset?revisionId=head+%2F%3F&path=declared%2F100');
    expect(portraitUrl('workspace', 'card', 'head')).toBe(assetUrl('workspace', 'card', 'head', 'portrait'));
    expect(originalUrl('workspace /?', 'card /?')).toBe('/api/workspaces/workspace%20%2F%3F/cards/card%20%2F%3F/original');
  });

  it.each(['open', 'family', 'assets'] as const)('cancels a superseded %s read while retaining its authenticated actor and encoded workspace', async (kind) => {
    const { client, connection, fetcher } = await fixture();
    const controller = new AbortController();
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    fetcher.mockImplementationOnce(async (path, options) => {
      expect(String(path)).toContain('/api/workspaces/workspace%20%2F%3F/cards/card%20%2F%3F');
      expect(String(path)).not.toContain('/api/cards/');
      expect(new Headers(options?.headers).get('x-unity-actor')).toBe('alice');
      started();
      return new Promise<Response>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true }));
    });
    const pending = kind === 'open' ? client.openCard('card /?', { signal: controller.signal })
      : kind === 'family' ? client.cardFamily('card /?', { signal: controller.signal })
        : client.listAssets('card /?', 'saved-head /?', controller.signal);
    await waiting; controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    connection.dispose();
  });

  it('reports native read failures instead of treating unavailable revision assets as empty', async () => {
    const { client, connection, fetcher } = await fixture();
    fetcher.mockResolvedValueOnce(Response.json({ error: { code: 'ASSET_UNAVAILABLE', message: 'Saved revision asset is unavailable' } }, { status: 503 }));
    await expect(client.listAssets('card', 'saved-head')).rejects.toMatchObject({ status: 503, code: 'ASSET_UNAVAILABLE', message: 'Saved revision asset is unavailable' });
    connection.dispose();
  });

  it('returns an existing library entry and the real deduplication outcome from a regular file import', async () => {
    const { client, connection, fetcher } = await fixture();
    const file = new File(['exact accepted bytes'], 'already have 日本語.png', { type: 'image/png' });
    fetcher.mockImplementationOnce(async (path, options) => {
      expect(path).toBe('/api/workspaces/workspace%20%2F%3F/imports');
      expect(options?.method).toBe('POST'); expect(options?.body).toBe(file);
      const headers = new Headers(options?.headers);
      expect(headers.get('x-unity-actor')).toBe('alice');
      expect(headers.get('x-file-name')).toBe('already%20have%20%E6%97%A5%E6%9C%AC%E8%AA%9E.png');
      expect(headers.get('x-file-name-encoding')).toBe('uri');
      return Response.json({ card: { id: 'existing-reference' }, import: { created: false, match: 'archive' } });
    });
    expect(await client.importFile(file)).toEqual({ card: { id: 'existing-reference' }, import: { created: false, match: 'archive' } });
    connection.dispose();
  });

  it('keeps an old library owner fixed when another workspace and account client are created', async () => {
    const { client, connection, runtime, fetcher } = await fixture();
    fetcher.mockImplementation(async (path, options) => {
      if (path === '/api/session') return Response.json({ ...alice, actor: { id: 'bob', uri: 'urn:unity:user:bob' }, name: 'Bob' });
      return Response.json({ path, actorId: new Headers(options?.headers).get('x-unity-actor') });
    });
    const bob = await runtime.login('bob-key');
    const later = createLibraryClient(bob, 'other-workspace');
    expect(client.workspaceId).toBe('workspace /?'); expect(client.connection.actor.id).toBe('alice');
    expect(Object.isFrozen(client)).toBe(true); expect(client.scopeKey).not.toBe(later.scopeKey);
    expect(await client.call('/api/workspaces/workspace%20%2F%3F')).toEqual({ path: '/api/workspaces/workspace%20%2F%3F', actorId: 'alice' });
    expect(await later.call('/api/workspaces/other-workspace')).toEqual({ path: '/api/workspaces/other-workspace', actorId: 'bob' });
    await client.setFavorite('card /?', true);
    expect(fetcher.mock.calls.at(-1)?.[0]).toBe('/api/workspaces/workspace%20%2F%3F/cards/card%20%2F%3F/favorite');
    expect(new Headers(fetcher.mock.calls.at(-1)?.[1]?.headers).get('x-unity-actor')).toBe('alice');
    connection.dispose(); bob.dispose();
  });

  it('uses encoded native summary filters on the captured workspace rather than a singleton default library', async () => {
    const { client, connection, fetcher } = await fixture();
    const controller = new AbortController();
    fetcher.mockResolvedValueOnce(Response.json({ cards: [], total: 0 }));
    expect(await client.listCards({ q: 'fox & moon', tags: ['tag one'], tagMode: 'any', exclude: ['hidden'], has: ['portrait'],
      fork: 'only', favorite: 'fav', source: 'risuai', minTokens: 100, sort: 'name', offset: 20, limit: 20 }, controller.signal)).toEqual({ cards: [], total: 0 });
    const path = String(fetcher.mock.calls.at(-1)?.[0]);
    expect(path).toBe('/api/workspaces/workspace%20%2F%3F/card-summaries?q=fox+%26+moon&tags=tag+one&tagMode=any&exclude=hidden&has=portrait&fork=only&favorite=fav&source=risuai&minTokens=100&sort=name&offset=20&limit=20');
    connection.dispose();
  });
});
