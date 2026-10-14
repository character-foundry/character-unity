import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireProtectedResource, publicResource } from './protected-resource';
import { createSessionRuntime } from './session';
import { createLibraryClient } from './unity';

const source = '/api/workspaces/library/cards/card/asset?revisionId=saved&path=portrait';
async function fixture(actorId = 'alice') {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (path) => {
    if (path === '/api/client') return Response.json({ profile: 'hub', capabilities: { browserLLM: false } });
    if (path === '/api/session') return Response.json({ actor: { id: actorId, uri: `urn:unity:user:${actorId}` }, name: actorId, expiresAt: 10_000 });
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
  });
  const connection = await createSessionRuntime({ fetch: fetcher }).restore();
  fetcher.mockClear();
  return { client: createLibraryClient(connection, 'library'), connection, fetcher };
}

describe('authenticated visible media ownership', () => {
  beforeEach(() => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:owned-image');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('shares one authenticated fetch and blob URL until the last visible user releases it', async () => {
    const { client, connection, fetcher } = await fixture();
    const first = acquireProtectedResource(client, source), second = acquireProtectedResource(client, source);
    expect(await first.promise).toBe('blob:owned-image'); expect(await second.promise).toBe('blob:owned-image');
    expect(fetcher).toHaveBeenCalledTimes(1); expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('x-unity-actor')).toBe('alice');
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0];
    expect(blob).toBeInstanceOf(Blob);
    if (!(blob instanceof Blob)) throw new Error('Expected the authenticated image blob');
    expect(blob.type).toBe('image/png'); expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([137, 80, 78, 71]);
    first.release(); await Promise.resolve();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    second.release(); second.release(); await Promise.resolve();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:owned-image');
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    connection.dispose();
  });

  it('reuses an immediately reacquired preview without revoking the still-visible resource', async () => {
    const { client, connection, fetcher } = await fixture();
    const first = acquireProtectedResource(client, source);
    await first.promise;
    first.release();
    const replacement = acquireProtectedResource(client, source);
    await replacement.promise;
    expect(fetcher).toHaveBeenCalledTimes(1); expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    replacement.release(); await Promise.resolve();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:owned-image');
    connection.dispose();
  });

  it('aborts an unfinished media request when its last owner releases and does not create a blob URL', async () => {
    const { client, connection, fetcher } = await fixture();
    fetcher.mockImplementationOnce(async (_path, options) => new Promise<Response>((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
    }));
    const media = acquireProtectedResource(client, source);
    const outcome = expect(media.promise).rejects.toMatchObject({ name: 'AbortError' });
    media.release(); await outcome;
    expect(URL.createObjectURL).not.toHaveBeenCalled(); expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    connection.dispose();
  });

  it('shows stored-media errors rather than turning an error JSON response into an image blob', async () => {
    const { client, connection, fetcher } = await fixture();
    fetcher.mockResolvedValueOnce(Response.json({ error: { message: 'Archive original is offline' } }, { status: 503 }));
    const failed = acquireProtectedResource(client, source);
    await expect(failed.promise).rejects.toThrow('Archive original is offline');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    failed.release(); await Promise.resolve();
    const retry = acquireProtectedResource(client, source);
    expect(await retry.promise).toBe('blob:owned-image'); expect(fetcher).toHaveBeenCalledTimes(2);
    retry.release(); await Promise.resolve(); connection.dispose();
  });

  it('does not create an image URL if the captured account is disposed during the response body read', async () => {
    const { client, connection, fetcher } = await fixture();
    const response = new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
    vi.spyOn(response, 'blob').mockImplementation(async () => {
      connection.dispose();
      return new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
    });
    fetcher.mockResolvedValueOnce(response);
    const media = acquireProtectedResource(client, source);
    await expect(media.promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    media.release(); await Promise.resolve();
  });

  it('never shares another account’s cached image even when the requested source path is identical', async () => {
    const alice = await fixture('alice'), bob = await fixture('bob');
    vi.mocked(URL.createObjectURL).mockReturnValueOnce('blob:alice').mockReturnValueOnce('blob:bob');
    const first = acquireProtectedResource(alice.client, source), second = acquireProtectedResource(bob.client, source);
    expect(await first.promise).toBe('blob:alice'); expect(await second.promise).toBe('blob:bob');
    expect(new Headers(alice.fetcher.mock.calls[0][1]?.headers).get('x-unity-actor')).toBe('alice');
    expect(new Headers(bob.fetcher.mock.calls[0][1]?.headers).get('x-unity-actor')).toBe('bob');
    first.release(); await Promise.resolve();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:alice'); expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:bob');
    second.release(); await Promise.resolve(); alice.connection.dispose(); bob.connection.dispose();
  });

  it.each(['https://remote.example/image.png', '//remote.example/image.png', 'javascript:alert(1)', 'data:image/svg+xml,<svg/>'])('refuses external or executable protected source %s before transport', async (value) => {
    const { client, connection, fetcher } = await fixture();
    expect(() => acquireProtectedResource(client, value)).toThrow('Only stored Unity resources');
    expect(publicResource(value)).toBe(false); expect(fetcher).not.toHaveBeenCalled();
    connection.dispose();
  });

  it.each(['blob:owned-local', 'data:image/png;base64,iVBORw0KGgo=', '/images/brand-mark.png'])('allows already-owned or app-static preview %s without API transport', (value) => {
    expect(publicResource(value)).toBe(true);
  });

  it.each(['/images/../api/private/portrait', '/images/%2e%2e/api/private/portrait'])('does not let static bypass paths normalize into authenticated API media: %s', (value) => {
    expect(publicResource(value)).toBe(false);
  });
});
