import { describe, expect, it, vi } from 'vitest';
import type { CardSummary } from '@character-unity/cards';
import { createSharingClient, defaultPolicy, publicationText, publicationTitle, selectRevision } from './client';
import type { SelectedRevision, SharingHost } from './client';

const summary = (id = 'card/one', revision = 'saved one'): CardSummary => ({
  id, headRevisionId: revision, name: 'A character', creator: '', tags: [], spec: 'v3', sourceFormat: 'json', creatorNotes: '',
  greetingsCount: 1, lorebookEntriesCount: 0, assetsCount: 0, hasPortrait: false, revisionCount: 2, forkedFromRevisionId: null,
  forkCount: 0, favorite: false, tokensTotal: null, source: 'file', createdAt: '2026-10-01', updatedAt: '2026-10-02',
});
function fixture() {
  const request = vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>().mockResolvedValue({});
  const binary = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>().mockResolvedValue(new Response('accepted original'));
  const listCards = vi.fn<SharingHost['listCards']>().mockResolvedValue({ cards: [], total: 0 });
  const host: SharingHost = { workspaceId: 'workspace/one', scopeKey: 'actor:workspace', connection: {
    actor: { id: 'owner' }, request: async <T>(path: string, init?: RequestInit) => await request(path, init) as T, fetch: binary,
  }, listCards };
  return { client: createSharingClient(host), request, binary, listCards };
}

describe('native sharing selection', () => {
  it('pins saved revision IDs without repinning on refresh, and removes by card ID', () => {
    const chosen = selectRevision([], summary(), true);
    expect(chosen).toEqual([{ cardId: 'card/one', revisionId: 'saved one', name: 'A character', sequence: 2 }]);
    const refreshed = summary('card/one', 'new head'); refreshed.revisionCount = 3;
    expect(selectRevision(chosen, refreshed, true)).toEqual(chosen);
    expect(selectRevision(chosen, refreshed, false)).toEqual([]);
  });
  it('rejects read-only Archive pins rather than manufacturing an owned revision', () => {
    const card = summary(); card.reference = { archiveId: 'archive', cardId: 'original', versionId: 'pin' };
    expect(() => selectRevision([], card, true)).toThrow('Save an edited fork before publishing');
  });
  it('limits one publication to 20, keeping the previous selection intact', () => {
    const values = Array.from({ length: 20 }, (_, index) => ({ cardId: `card${index}`, revisionId: `rev${index}`, name: 'Card', sequence: 1 }));
    expect(() => selectRevision(values, summary(), true)).toThrow('at most 20');
    expect(values).toHaveLength(20);
    expect(selectRevision(values, summary('card0'), false)).toHaveLength(19);
  });
  it('uses conservative explicit policy defaults and never coerces opaque card fields', () => {
    expect(defaultPolicy).toEqual({ visibility: 'members', allowFork: true, allowOriginal: false });
    expect(Object.isFrozen(defaultPolicy)).toBe(true);
    expect(publicationTitle({ data: { name: { opaque: true } } })).toBe('Untitled character');
    expect(publicationText({ data: { description: ['opaque'] } }, 'description')).toBe('');
  });
});

describe('native sharing bound client', () => {
  it('uses the immutable library and scoped connection for every real publication request', async () => {
    const { client, request, listCards } = fixture();
    const signal = new AbortController().signal;
    expect(client.actorId).toBe('owner'); expect(client.scopeKey).toBe('actor:workspace');
    await client.library(20, signal);
    expect(listCards).toHaveBeenCalledWith({ offset: 20, limit: 20, sort: 'edited' }, signal);
    request.mockResolvedValueOnce({ publications: [{ id: 'pub' }] });
    expect(await client.list({ afterId: 'after/id', parentId: 'parent/id', signal })).toEqual([{ id: 'pub' }]);
    const [path, init] = request.mock.calls.at(-1)!;
    const url = new URL(path, 'https://unity.invalid');
    expect(url.pathname).toBe('/api/hub/publications');
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: '20', afterId: 'after/id', parentId: 'parent/id' });
    expect(init?.signal).toBe(signal);
    await client.detail('publication/one', signal);
    expect(request).toHaveBeenLastCalledWith('/api/hub/publications/publication%2Fone', { signal });
  });
  it('reviews exact saved revisions, snapshots selection before awaiting and passes aborts', async () => {
    const { client, request } = fixture(), controller = new AbortController();
    let resolve!: (value: unknown) => void;
    request.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const chosen: SelectedRevision[] = [{ cardId: 'card/one', revisionId: 'saved one', name: 'stale name', sequence: 1 }];
    const pending = client.review(chosen, controller.signal);
    chosen[0].revisionId = 'new head'; chosen.push({ cardId: 'card2', revisionId: 'head2', name: 'Not selected at review', sequence: 1 });
    resolve({ id: 'saved one', sequence: 2, document: { data: { name: 'Saved name' } }, createdAt: 'date' });
    expect(await pending).toEqual([{ cardId: 'card/one', revisionId: 'saved one', name: 'Saved name', sequence: 2, document: { data: { name: 'Saved name' } }, createdAt: 'date' }]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('/api/workspaces/workspace%2Fone/cards/card%2Fone/revisions/saved%20one', { signal: controller.signal });
  });
  it('pins history pagination to the explicit saved-history snapshot', async () => {
    const { client, request } = fixture(), signal = new AbortController().signal;
    await client.history('card/one', { afterSequence: 20, throughSequence: 37, signal });
    expect(request).toHaveBeenCalledWith('/api/workspaces/workspace%2Fone/cards/card%2Fone/revisions?limit=20&afterSequence=20&throughSequence=37', { signal });
  });
  it('refuses mismatched reviewed revisions and late reads after cancellation', async () => {
    const { client, request } = fixture(), controller = new AbortController();
    const chosen = [{ cardId: 'card', revisionId: 'exact', name: 'Name', sequence: 1 }];
    request.mockResolvedValueOnce({ id: 'wrong', document: {}, sequence: 1 });
    await expect(client.review(chosen, controller.signal)).rejects.toThrow('changed unexpectedly');
    request.mockImplementationOnce(async () => { controller.abort(new Error('Route changed')); return { id: 'exact', document: {}, sequence: 1 }; });
    await expect(client.review(chosen, controller.signal)).rejects.toThrow('Route changed');
  });
  it('publishes only explicit pinned IDs and policy, with no implicit retry', async () => {
    const { client, request } = fixture(), signal = new AbortController().signal;
    const selected = selectRevision([], summary(), true);
    await client.publish(selected, { ...defaultPolicy }, signal);
    const [path, init] = request.mock.calls[0];
    expect(path).toBe('/api/hub/publications'); expect(init?.method).toBe('POST'); expect(init?.signal).toBe(signal);
    expect(JSON.parse(String(init?.body))).toEqual({ workspaceId: 'workspace/one', revisionIds: ['saved one'], policy: defaultPolicy });
    request.mockRejectedValueOnce(new Error('Response lost'));
    await expect(client.publish(selected, { ...defaultPolicy })).rejects.toThrow('Response lost');
    expect(request).toHaveBeenCalledTimes(2);
    expect(() => client.publish([], { ...defaultPolicy })).toThrow('1–20');
    expect(() => client.publish([selected[0], selected[0]], { ...defaultPolicy })).toThrow('distinct');
  });
  it('submits expected policy version and all permissions without leaking public card fields', async () => {
    const { client, request } = fixture(), signal = new AbortController().signal;
    await client.policy('pub/id', 7, { visibility: 'private', allowFork: false, allowOriginal: true }, signal);
    const [path, init] = request.mock.calls[0];
    expect(path).toBe('/api/hub/publications/pub%2Fid/policy'); expect(init?.method).toBe('PATCH');
    expect(JSON.parse(String(init?.body))).toEqual({ expectedVersion: 7, policy: { visibility: 'private', allowFork: false, allowOriginal: true } });
  });
  it('forks into the bound workspace, pages visible lineage and uses authenticated binary download', async () => {
    const { client, request, binary } = fixture(), signal = new AbortController().signal;
    await client.fork('pub/id', signal);
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({ workspaceId: 'workspace/one' });
    expect(request.mock.calls[0][0]).toBe('/api/hub/publications/pub%2Fid/forks');
    await client.lineage('pub/id', { afterId: 'node/id', signal });
    expect(request.mock.calls[1][0]).toBe('/api/hub/publications/pub%2Fid/lineage?limit=20&afterId=node%2Fid');
    expect(await (await client.original('pub/id', signal)).text()).toBe('accepted original');
    expect(binary).toHaveBeenCalledWith('/api/hub/publications/pub%2Fid/original', { signal });
    binary.mockResolvedValueOnce(Response.json({ error: { message: 'Original is not available' } }, { status: 404 }));
    await expect(client.original('pub/id')).rejects.toThrow('Original is not available');
  });
});
