import { afterEach, describe, expect, it } from 'vitest';
import { openNodeStore } from '@character-unity/store/node';
import { createStatisticsService } from '../src/statistics.js';

describe('workspace statistics service', () => {
  const databases: Awaited<ReturnType<typeof openNodeStore>>[] = [];
  afterEach(() => { for (const database of databases.splice(0)) database.close(); });
  async function fixture() {
    const database = await openNodeStore(':memory:'); databases.push(database);
    const { store } = database;
    const workspace = await store.createWorkspace({ ownerId: 'alice', name: 'Private library' });
    await store.createCard({ workspaceId: workspace.id, authorId: 'alice', identity: { algorithm: 'fixture-v1', hash: 'a'.repeat(64) }, document: { data: { name: 'Aster' } } });
    return { store, workspace, reader: database.statistics };
  }
  it('reads only the authenticated actor’s workspace', async () => {
    const { store, workspace, reader } = await fixture();
    const service = createStatisticsService(store, reader);
    expect((await service.read({ id: 'alice', uri: 'urn:alice' }, workspace.id)).membership.total).toBe(1);
    await expect(service.read({ id: 'bob', uri: 'urn:bob' }, workspace.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('captures the actor before asynchronous authorization and rechecks access before returning private counts', async () => {
    const { store, workspace, reader } = await fixture();
    const actor = { id: 'alice', uri: 'urn:alice' };
    const started = createStatisticsService(store, reader).read(actor, workspace.id);
    actor.id = 'bob';
    expect((await started).membership.total).toBe(1);
    let reads = 0;
    const guarded = createStatisticsService({ getWorkspace: async (id: string) => ({ ...await store.getWorkspace(id), ownerId: reads++ ? 'bob' : 'alice' }) }, reader);
    await expect(guarded.read({ id: 'alice', uri: 'urn:alice' }, workspace.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
