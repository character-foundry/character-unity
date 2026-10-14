import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openNodeStore } from '@character-unity/store/node';
import { createApi } from '@character-unity/api';
import { createMetaTagService } from '@character-unity/api/meta-tags';

const alice = { id: 'alice', uri: 'urn:alice' }, bob = { id: 'bob', uri: 'urn:bob' };
const group = { id: 'genre-fantasy', name: 'Fantasy', members: ['Magic', 'Elves'] };
describe('authorized workspace meta-tag HTTP metadata', () => {
  let database: Awaited<ReturnType<typeof openNodeStore>>, api: ReturnType<typeof createApi>, workspaceId: string;
  beforeEach(async () => {
    database = await openNodeStore(':memory:'); workspaceId = (await database.store.createWorkspace({ ownerId: alice.id, name: 'Library' })).id;
    api = createApi({ metaTags: createMetaTagService(database.store), authenticate: (request) => request.headers.get('x-fixture-actor') === alice.id ? alice : request.headers.get('x-fixture-actor') === bob.id ? bob : null });
  });
  afterEach(() => database.close());
  const path = (id: string) => `/api/workspaces/${id}/meta-tags`;
  function request(method = 'GET', body?: unknown, actor = alice.id, id = workspaceId) {
    return api.request(path(id), { method, headers: { 'x-fixture-actor': actor, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  it('requires the workspace owner, returns no-store defaults and supports strict versioned create/update/delete replacement', async () => {
    expect((await request('GET', undefined, '')).status).toBe(401);
    expect((await request('GET', undefined, bob.id)).status).toBe(403);
    expect((await request('PUT', { expectedVersion: 0, groups: [group] }, bob.id)).status).toBe(403);
    const empty = await request(); expect(empty.status).toBe(200); expect(empty.headers.get('cache-control')).toBe('no-store');
    expect(await empty.json()).toEqual({ version: 0, groups: [] });
    const created = await request('PUT', { expectedVersion: 0, groups: [group] });
    expect(created.status).toBe(200); expect(created.headers.get('cache-control')).toBe('no-store');
    expect(await created.json()).toEqual({ version: 1, groups: [group] });
    const stale = await request('PUT', { expectedVersion: 0, groups: [] });
    expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ error: { code: 'HEAD_CONFLICT' } });
    expect(await (await request('PUT', { expectedVersion: 1, groups: [] })).json()).toEqual({ version: 2, groups: [] });
    expect((await request('GET', undefined, alice.id, 'missing')).status).toBe(404);
  });
  it('refuses forged selectors, unknown fields, invalid groups, query overrides and oversized bodies', async () => {
    for (const body of [{ expectedVersion: 0, groups: [group], workspaceId: 'other' }, { expectedVersion: 0, groups: [group], actor: bob },
      { expectedVersion: 0, groups: [{ ...group, extra: true }] }, { expectedVersion: 0, groups: [{ ...group, members: [] }] }]) expect((await request('PUT', body)).status).toBe(400);
    expect((await api.request(`${path(workspaceId)}?actor=alice`, { headers: { 'x-fixture-actor': alice.id } })).status).toBe(400);
    expect((await api.request(path(workspaceId), { method: 'PUT', headers: { 'x-fixture-actor': alice.id, 'content-type': 'application/json' }, body: '{' })).status).toBe(400);
    expect((await request('PUT', { expectedVersion: 0, groups: [], padding: 'x'.repeat(1_048_576) })).status).toBe(413);
    expect((await request('DELETE')).status).toBe(404);
    expect(await database.store.readMetaTags(workspaceId)).toEqual({ version: 0, groups: [] });
    expect(await database.store.listCards(workspaceId)).toEqual([]); expect(await database.store.listSearchJobs()).toEqual([]);
  });
  it('captures actor identity and the entire replacement before awaiting authorization', async () => {
    const service = createMetaTagService(database.store), actor = { ...alice }, input = { expectedVersion: 0, groups: [structuredClone(group)] };
    const pending = service.write(actor, workspaceId, input);
    actor.id = bob.id; input.expectedVersion = 9; input.groups[0]!.members[0] = 'Changed while waiting';
    expect(await pending).toEqual({ version: 1, groups: [group] });
    await expect(service.read(bob, workspaceId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const reader = { ...alice }, reading = service.read(reader, workspaceId); reader.id = bob.id;
    expect(await reading).toEqual({ version: 1, groups: [group] });
  });
  it('saves a valid large multilingual catalog and refuses over-1-MiB replacement without a partial save', async () => {
    const groups = Array.from({ length: 10 }, (_, index) => ({ id: `g-${index}`, name: `Group ${index}`,
      members: Array.from({ length: 100 }, (_, member) => `${'界'.repeat(124)}${String(member).padStart(4, '0')}`) }));
    const input = { expectedVersion: 0, groups };
    expect(new TextEncoder().encode(JSON.stringify(input)).byteLength).toBe(379_452);
    const accepted = await request('PUT', input);
    expect(accepted.status).toBe(200); expect(await accepted.json()).toEqual({ version: 1, groups });
    const bounded = JSON.stringify({ expectedVersion: 1, groups });
    const boundary = await api.request(path(workspaceId), { method: 'PUT', headers: { 'x-fixture-actor': alice.id, 'content-type': 'application/json' },
      body: bounded + ' '.repeat(1_048_576 - new TextEncoder().encode(bounded).byteLength) });
    expect(boundary.status).toBe(200); expect(await boundary.json()).toEqual({ version: 2, groups });
    const replacement = JSON.stringify({ expectedVersion: 2, groups: [] });
    const rejected = await api.request(path(workspaceId), { method: 'PUT', headers: { 'x-fixture-actor': alice.id, 'content-type': 'application/json' },
      body: replacement + ' '.repeat(1_048_577 - replacement.length) });
    expect(rejected.status).toBe(413);
    expect(await rejected.json()).toMatchObject({ error: { code: 'TOO_LARGE' } });
    expect(await database.store.readMetaTags(workspaceId)).toEqual({ version: 2, groups });
  });
});
