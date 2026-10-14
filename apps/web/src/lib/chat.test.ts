import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatClient } from './chat';
import { createSessionRuntime, SessionError } from './session';
import { createLibraryClient } from './unity';
import type { ChatPlacement, ChatTarget } from './chat';

const target: ChatTarget = { id: 'target/one', kind: 'sillytavern', name: 'Chat', baseUrl: 'http://127.0.0.1:8000', createdAt: 'date', scannedAt: null, scanError: null };
const placement: ChatPlacement = { targetId: target.id, targetName: 'Chat', kind: 'sillytavern', remoteId: 'remote', remoteName: 'Card', cardId: 'card',
  revisionId: 'revision', revisionSequence: 1, headSequence: 1, status: 'current', sentAt: 'date', seenAt: 'date' };
async function fixture(profile: 'local' | 'hub' = 'local', owner = 'owner') {
  const handler = vi.fn<(path: string, init: RequestInit) => Promise<Response>>().mockImplementation(async (path) => {
    if (path === '/api/client') return Response.json({ profile, capabilities: { browserLLM: profile === 'local' } });
    if (path === '/api/local-session' || path === '/api/session') return Response.json({ actor: { id: owner, uri: `urn:${owner}` }, name: owner, expiresAt: 9000 });
    if (path.endsWith('/targets')) return Response.json({ targets: [target] });
    if (path.includes('/placements?')) return Response.json({ placements: [placement] });
    if (path.endsWith('/sends')) return Response.json(placement);
    return Response.json({ found: 1 });
  });
  const runtime = createSessionRuntime({ fetch: (path, init) => handler(String(path), init!) });
  const connection = await runtime.restore();
  const library = createLibraryClient(connection, 'workspace/one');
  handler.mockClear();
  return { api: createChatClient(library), connection, library, handler };
}
afterEach(() => vi.unstubAllGlobals());

describe('native chat account/workspace ownership', () => {
  it('keeps target cache and invalidation local to each immutable library client', async () => {
    const first = await fixture(), other = await fixture('local', 'other');
    await first.api.targets(); await first.api.targets(); await other.api.targets();
    expect(first.handler).toHaveBeenCalledTimes(1); expect(other.handler).toHaveBeenCalledTimes(1);
    const changed = vi.fn(), untouched = vi.fn(); first.api.subscribe(changed); other.api.subscribe(untouched);
    await first.api.scan(target.id); await first.api.targets(); await other.api.targets();
    expect(changed).toHaveBeenCalledTimes(1); expect(untouched).not.toHaveBeenCalled();
    expect(first.handler).toHaveBeenCalledTimes(3); expect(other.handler).toHaveBeenCalledTimes(1);
    for (const [path, init] of first.handler.mock.calls) {
      expect(path).toContain('/api/workspaces/workspace%2Fone/chat/');
      expect(new Headers(init.headers).get('x-unity-actor')).toBe('owner');
    }
    expect(first.api.available).toBe(true); expect((await fixture('hub')).api.available).toBe(false);
  });
  it('shares target reads but cancels only once the final subscriber leaves', async () => {
    const { api, handler } = await fixture();
    let upstream!: AbortSignal;
    handler.mockImplementationOnce((_path, init) => new Promise((_resolve, reject) => {
      upstream = init.signal!;
      upstream.addEventListener('abort', () => reject(upstream.reason), { once: true });
    }));
    const first = new AbortController(), second = new AbortController();
    const one = api.targets(first.signal), two = api.targets(second.signal);
    const rejectedOne = expect(one).rejects.toThrow('First gone'), rejectedTwo = expect(two).rejects.toThrow('Second gone');
    first.abort(new Error('First gone')); expect(upstream.aborted).toBe(false);
    second.abort(new Error('Second gone')); expect(upstream.aborted).toBe(true);
    await Promise.all([rejectedOne, rejectedTwo]); expect(handler).toHaveBeenCalledTimes(1);
    handler.mockResolvedValueOnce(Response.json({ targets: [target] }));
    expect(await api.targets()).toEqual([target]);
  });
  it('does not cache target failures or disguise account mismatch as an empty list', async () => {
    const { api, handler, connection } = await fixture('hub');
    handler.mockResolvedValueOnce(Response.json({ error: { code: 'ACCOUNT_CHANGED', message: 'This browser belongs to another account' } }, { status: 409 }));
    await expect(api.targets()).rejects.toMatchObject({ status: 409, code: 'ACCOUNT_CHANGED', message: 'This browser belongs to another account' });
    expect(connection.snapshot().status).toBe('locked');
    const local = await fixture();
    local.handler.mockResolvedValueOnce(Response.json({ error: { code: 'UNAVAILABLE', message: 'Server is unavailable' } }, { status: 503 }));
    await expect(local.api.targets()).rejects.toThrow('Server is unavailable');
    expect(await local.api.targets()).toEqual([target]);
  });
  it('encodes target/remote IDs and uses only the captured workspace for placements', async () => {
    const { api, handler } = await fixture();
    await api.placements(['card,one', 'card/two']);
    const url = new URL(handler.mock.calls[0][0], 'https://unity.invalid');
    expect(url.searchParams.getAll('cardId')).toEqual(['card,one', 'card/two']);
    await api.forget(target.id, 'remote/id?');
    expect(handler.mock.calls[1][0]).toBe('/api/workspaces/workspace%2Fone/chat/targets/target%2Fone/placements?remoteId=remote%2Fid%3F');
    expect(handler.mock.calls[1][1].method).toBe('DELETE');
  });
  it('asks before overwriting remote edits and reuses the same card/target on consent', async () => {
    const { api, handler } = await fixture(); const confirm = vi.fn().mockReturnValue(true); vi.stubGlobal('window', { confirm });
    handler.mockResolvedValueOnce(Response.json({ error: { code: 'ACCESS_CHANGED', message: 'Edited inside chat' } }, { status: 409 }));
    expect(await api.sendCard(target, 'card')).toEqual(placement);
    expect(confirm).toHaveBeenCalledTimes(1); expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0][0]).toBe(handler.mock.calls[1][0]);
    expect(JSON.parse(String(handler.mock.calls[1][1].body))).toEqual({ cardId: 'card', overwriteEdited: true });
  });
  it('does not overwrite after decline, cancellation or another error', async () => {
    const declined = await fixture(); vi.stubGlobal('window', { confirm: () => false });
    declined.handler.mockResolvedValueOnce(Response.json({ error: { code: 'ACCESS_CHANGED', message: 'Edited' } }, { status: 409 }));
    expect(await declined.api.sendCard(target, 'card')).toBeNull(); expect(declined.handler).toHaveBeenCalledTimes(1);
    const failed = await fixture(); failed.handler.mockRejectedValueOnce(new SessionError(503, 'UNAVAILABLE', 'Offline'));
    await expect(failed.api.sendCard(target, 'card')).rejects.toThrow('Offline'); expect(failed.handler).toHaveBeenCalledTimes(1);
    const canceled = await fixture(), controller = new AbortController(); controller.abort(new Error('Route changed'));
    await expect(canceled.api.sendCard(target, 'card', controller.signal)).rejects.toThrow('Route changed'); expect(canceled.handler).not.toHaveBeenCalled();
  });
  it('never retains submitted credentials in the target cache', async () => {
    const { api, handler } = await fixture();
    handler.mockResolvedValueOnce(Response.json(target));
    await api.add({ kind: 'sillytavern', baseUrl: target.baseUrl, credentials: { username: 'user', password: 'private' } });
    expect(JSON.parse(String(handler.mock.calls[0][1].body)).credentials.password).toBe('private');
    expect(await api.targets()).toEqual([target]);
    expect(JSON.stringify(await api.targets())).not.toContain('private');
  });
  it('reviews and accepts only byte/head-pinned edits through the captured account transport', async () => {
    const { api, handler } = await fixture();
    const review = { cardId: 'card', remoteId: 'copy/one?', baseRevisionId: 'base', expectedHead: 'head', remoteHash: 'a'.repeat(64),
      targetKind: 'sillytavern', targetUrl: target.baseUrl, targetConfiguration: 1, changes: [{ field: 'description', before: 'Before', after: 'After' }], preserved: [] };
    handler.mockResolvedValueOnce(Response.json(review));
    expect(await api.reviewEdit(target.id, review.remoteId)).toEqual(review);
    handler.mockResolvedValueOnce(Response.json({ cardId: 'fork', revisionId: 'fork-head', duplicate: false }));
    expect(await api.acceptEdit(target.id, review)).toMatchObject({ cardId: 'fork' });
    expect(handler.mock.calls[0][0]).toBe('/api/workspaces/workspace%2Fone/chat/targets/target%2Fone/edits/review');
    expect(JSON.parse(String(handler.mock.calls[0][1].body))).toEqual({ remoteId: review.remoteId });
    const submitted = JSON.parse(String(handler.mock.calls[1][1].body)) as Record<string, unknown>;
    expect(submitted).not.toHaveProperty('changes'); expect(submitted).not.toHaveProperty('preserved');
    expect(submitted.remoteHash).toBe(review.remoteHash);
    for (const [, init] of handler.mock.calls) expect(new Headers(init.headers).get('x-unity-actor')).toBe('owner');
  });
});
