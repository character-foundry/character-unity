import { afterEach, describe, expect, it } from 'vitest';
import { openNodeStore } from '@character-unity/store/node';
import { createStatisticsService } from '@character-unity/cards/statistics';
import { createApi } from '@character-unity/api';

describe('private workspace statistics HTTP contract', () => {
  const databases: Awaited<ReturnType<typeof openNodeStore>>[] = [];
  afterEach(() => { for (const database of databases.splice(0)) database.close(); });
  async function fixture() {
    const database = await openNodeStore(':memory:'); databases.push(database);
    const workspace = await database.store.createWorkspace({ ownerId: 'alice', name: 'Private' });
    await database.store.createCard({ workspaceId: workspace.id, authorId: 'alice', identity: { algorithm: 'fixture-v1', hash: 'a'.repeat(64) }, document: { data: { name: 'Aster' } } });
    const statistics = createStatisticsService(database.store, database.statistics);
    const app = createApi({ statistics, authenticate: (request) => {
      const id = request.headers.get('x-test-actor'); return id ? { id, uri: `urn:${id}` } : null;
    } });
    return { app, path: `/api/workspaces/${workspace.id}/statistics` };
  }
  it('requires authentication and ownership, and never caches private counts', async () => {
    const { app, path } = await fixture();
    for (const [actor, status] of [['', 401], ['bob', 403], ['alice', 200]] as const) {
      const response = await app.request(path, { headers: { 'x-test-actor': actor } });
      expect(response.status).toBe(status);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const result = await response.json() as { membership?: { total: number }; error?: { code: string } };
      if (status === 200) expect(result.membership?.total).toBe(1);
      else expect(result.membership).toBeUndefined();
    }
  });
  it('refuses query-supplied actors or workspace selectors and does not expose mutation endpoints', async () => {
    const { app, path } = await fixture();
    expect((await app.request(`${path}?actor=bob`, { headers: { 'x-test-actor': 'alice' } })).status).toBe(400);
    expect((await app.request(path, { method: 'POST', headers: { 'x-test-actor': 'alice' } })).status).toBe(404);
    expect((await app.request('/api/workspaces/missing/statistics', { headers: { 'x-test-actor': 'alice' } })).status).toBe(404);
  });
  it('reports unavailable statistics honestly when the host has no reader', async () => {
    const response = await createApi().request('/api/workspaces/workspace/statistics');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'UNAVAILABLE' } });
  });
});
