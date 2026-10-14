import Database from 'better-sqlite3';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStore } from '../../src/index.js';
import type { UnityStore } from '../../src/index.js';
import { createHubStore } from '../../src/hub.js';
import type { HubStore, PublicationPolicy } from '../../src/hub.js';
import { createNodeDriver } from '../../src/node.js';
import { createD1Driver } from '../../src/d1.js';
import { migrate } from '../../src/migrations.js';
import type { StoreDriver } from '../../src/driver.js';

const input = { authorId: 'alice', document: { data: { name: 'Selected' } }, identity: { algorithm: 'test', hash: 'a'.repeat(64) } };
const policy: PublicationPolicy = { visibility: 'public', allowOriginal: false, allowFork: true };
for (const adapter of ['sqlite', 'd1']) describe(`hub contract / ${adapter}`, () => {
  let close: () => void | Promise<void>;
  let driver: StoreDriver;
  let store: UnityStore;
  let hub: HubStore;
  let alice: string;
  let bob: string;
  beforeEach(async () => {
    if (adapter === 'sqlite') {
      const db = new Database(':memory:'); driver = createNodeDriver(db); close = () => { db.close(); };
    } else {
      const mf = new Miniflare(convertV4MiniflareOptions({ port: 0, workers: [{ name: 'hub-test', modules: true,
        script: 'export default { fetch() { return new Response("test"); } };', compatibilityDate: '2026-10-11', d1Databases: ['DB'] }] }));
      driver = createD1Driver(await mf.getD1Database('DB')); close = () => mf.dispose();
    }
    await migrate(driver); store = createStore(driver); hub = createHubStore(driver);
    alice = (await store.createWorkspace({ ownerId: 'alice', name: 'Alice' })).id;
    bob = (await store.createWorkspace({ ownerId: 'bob', name: 'Bob' })).id;
  });
  afterEach(async () => { await close?.(); });
  async function source(workspaceId = alice) {
    return store.createCard({ ...input, workspaceId, originalHash: 'b'.repeat(64) });
  }
  async function publish(value: Awaited<ReturnType<typeof source>>, ownerId = 'alice', workspaceId = alice, override = policy) {
    const [publication] = await hub.publish(ownerId, [{ workspaceId, revisionId: value.revision.id, document: value.revision.document,
      identity: value.revision.identity, originalHash: value.card.originalHash!, ...override }]);
    return publication!;
  }
  async function fork(publicationId: string, policyVersion: number, revisionId: string, workspaceId = bob) {
    return store.forkCard({ ...input, authorId: 'bob', workspaceId, sourceWorkspaceId: alice, sourceRevisionId: revisionId,
      publication: { publicationId, policyVersion, actorId: 'bob' } });
  }

  it('[H01] publishes precisely the selected revisions atomically and snapshots input', async () => {
    const a = await source(); const b = await source(); await source();
    const selected = [a, b].map((item) => ({ workspaceId: alice, revisionId: item.revision.id, document: structuredClone(item.revision.document),
      identity: { ...item.revision.identity }, originalHash: item.card.originalHash!, ...policy }));
    for (let failAt = 0; failAt <= 2; failAt++) {
      const failing = createHubStore({ query: (query) => driver.query(query), batch: (statements) => {
        const modified = [...statements]; modified.splice(failAt, 0, { sql: "INSERT INTO unity_workspaces(id, owner_id, name, created_at) VALUES (NULL, 'fault', 'fault', 'fault')" });
        return driver.batch(modified);
      } });
      await expect(failing.publish('alice', selected)).rejects.toMatchObject({ code: 'INTEGRITY' });
      expect(await hub.list(null)).toEqual([]);
      expect(await driver.query({ sql: 'SELECT * FROM unity_publication_ancestors' })).toEqual([]);
    }
    await expect(hub.publish('bob', selected)).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
    const pending = hub.publish('alice', selected);
    selected[0]!.document.data = 'changed'; selected[1]!.identity.hash = 'c'.repeat(64);
    const published = await pending;
    expect(published).toHaveLength(2);
    expect(published[0]!.document).toEqual(input.document);
    expect(published[1]!.identity).toEqual(input.identity);
    await store.saveRevision({ ...input, document: { data: 'private later edit' }, workspaceId: alice, cardId: a.card.id, expectedHead: a.revision.id });
    expect((await hub.get(null, published[0]!.id)).document).toEqual(input.document);
    expect((await hub.list(null)).map((item) => item.revisionId).sort()).toEqual([a.revision.id, b.revision.id].sort());
    await expect(hub.publish('alice', published)).rejects.toMatchObject({ code: 'INTEGRITY' });
  });

  it('[H02] applies private/member/public policies, immutable snapshots and compare-and-swap policy updates', async () => {
    const p = await publish(await source(), 'alice', alice, { ...policy, visibility: 'private' });
    await expect(hub.get(null, p.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(hub.get('bob', p.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await hub.get('alice', p.id)).id).toBe(p.id);
    await hub.updatePolicy('alice', p.id, 1, { ...policy, visibility: 'members' });
    await expect(hub.get(null, p.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await hub.get('bob', p.id)).id).toBe(p.id);
    await expect(hub.updatePolicy('alice', p.id, 1, policy)).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
    await expect(hub.updatePolicy('bob', p.id, 2, policy)).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
    await hub.updatePolicy('alice', p.id, 2, policy);
    expect((await hub.get(null, p.id)).policyVersion).toBe(3);
    for (const sql of ['UPDATE unity_publications SET document_json = \'{}\', policy_version = policy_version + 1',
      'DELETE FROM unity_publications', 'DELETE FROM unity_publication_ancestors', 'UPDATE unity_publication_ancestors SET depth = 1']) {
      await expect(driver.batch([{ sql }])).rejects.toThrow();
    }
  });

  it('[H03] rechecks policy, target ownership and source revision inside the atomic fork commit', async () => {
    const a = await source(); const other = await source(); const p = await publish(a);
    for (const operation of [
      () => fork(p.id, 1, a.revision.id, alice), () => fork(p.id, 1, other.revision.id), () => fork(p.id, 99, a.revision.id),
    ]) await expect(operation()).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
    expect(await store.listCards(bob)).toEqual([]);
    await hub.updatePolicy('alice', p.id, 1, { ...policy, allowFork: false });
    await expect(fork(p.id, 1, a.revision.id)).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
    await expect(fork(p.id, 2, a.revision.id)).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
    expect(await store.listCards(bob)).toEqual([]);
    await hub.updatePolicy('alice', p.id, 2, policy);
    const created = await fork(p.id, 3, a.revision.id);
    expect(created.card.originalHash).toBe(a.card.originalHash);
    expect(await driver.query({ sql: 'SELECT card_id FROM unity_publication_forks' })).toEqual([{ card_id: created.card.id }]);
    await expect(driver.batch([{ sql: 'DELETE FROM unity_publication_forks' }])).rejects.toThrow();
    await expect(driver.batch([{ sql: 'UPDATE unity_publication_forks SET actor_id = \'alice\'' }])).rejects.toThrow();
  });

  it('[H04] enforces current ancestor visibility and fork restrictions on published descendants', async () => {
    const a = await source(); const root = await publish(a);
    const descendant = await fork(root.id, 1, a.revision.id);
    const child = await publish(descendant, 'bob', bob);
    expect(child.parentId).toBe(root.id);
    expect((await hub.list(null, { parentId: root.id })).map((item) => item.id)).toEqual([child.id]);
    await hub.updatePolicy('alice', root.id, 1, { ...policy, allowFork: false });
    await expect(hub.canFork('bob', child.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(store.forkCard({ ...input, authorId: 'bob', workspaceId: bob, sourceWorkspaceId: bob,
      sourceRevisionId: descendant.revision.id, publication: { publicationId: child.id, policyVersion: 1, actorId: 'bob' } })).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
    expect(await store.listCards(bob)).toHaveLength(1);
    await hub.updatePolicy('alice', root.id, 2, { ...policy, visibility: 'private' });
    for (const actor of [null, 'bob', 'charlie']) {
      await expect(hub.get(actor, child.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await hub.list(actor)).toEqual([]);
    }
    expect((await store.getCard(bob, descendant.card.id)).id).toBe(descendant.card.id);
    expect((await hub.get('alice', child.id)).id).toBe(child.id);
    await hub.updatePolicy('bob', child.id, 1, { ...policy, visibility: 'private' });
    await expect(hub.get('alice', child.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('[H05] pages all visible publications of an original across revisions and branches without hidden cursors', async () => {
    const a = await source(); const first = await publish(a);
    const revision = await store.saveRevision({ ...input, workspaceId: alice, cardId: a.card.id, expectedHead: a.revision.id });
    const second = await publish({ card: a.card, revision });
    const forked = await fork(second.id, 1, revision.id); const child = await publish(forked, 'bob', bob);
    await publish(await source(), 'alice', alice, { ...policy, visibility: 'private' });
    const other = await store.createCard({ ...input, workspaceId: alice, originalHash: 'c'.repeat(64) });
    await publish(other);
    const ids: string[] = []; let cursor: string | undefined;
    do {
      const page = await hub.rootPage('bob', a.card.originalHash!, { limit: 1, ...(cursor ? { afterId: cursor } : {}) });
      expect(page.records).toHaveLength(1); ids.push(page.records[0]!.id);
      cursor = page.nextAfter ?? undefined;
    } while (cursor && ids.length < 10);
    expect(ids).toEqual([first.id, second.id, child.id].sort());
    expect(cursor).toBeUndefined();
    await hub.updatePolicy('alice', second.id, 1, { ...policy, visibility: 'private' });
    const filtered = await hub.rootPage('bob', a.card.originalHash!, { limit: 1 });
    expect(filtered.records.map((value) => value.id)).toEqual([first.id]); expect(filtered.nextAfter).toBeNull();
    for (const limit of [0, 21]) await expect(hub.rootPage('bob', a.card.originalHash!, { limit })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(hub.rootPage('bob', 'not-a-hash')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('filters opaque-resource publications before pagination only when the signed-sync host requests it', async () => {
    const asset = await store.stageAsset({ workspaceId: alice, hash: 'd'.repeat(64), byteLength: 4, mediaType: 'application/octet-stream' });
    await store.completeAsset({ workspaceId: alice, assetId: asset.id, measuredHash: asset.hash, measuredByteLength: asset.byteLength });
    const supported = [await publish(await source()), await publish(await source())];
    const opaque = [];
    for (let i = 0; i < 3; i++) {
      const card = await store.createCard({ ...input, workspaceId: alice, originalHash: 'b'.repeat(64), assets: [{ path: 'module.risum', assetId: asset.id }] });
      opaque.push(await publish(card));
    }
    const ids: string[] = []; let cursor: string | undefined;
    do {
      const page = await hub.list('bob', { limit: 1, excludeOpaqueResources: true, ...(cursor ? { afterId: cursor } : {}) });
      if (!page.length) break;
      expect(page).toHaveLength(1); ids.push(page[0]!.id); cursor = page[0]!.id;
    } while (ids.length < 10);
    expect(ids).toEqual(supported.map((value) => value.id).sort());
    expect((await hub.list('bob')).map((value) => value.id).sort()).toEqual([...supported, ...opaque].map((value) => value.id).sort());
    for (const value of opaque) expect((await hub.get('bob', value.id)).revisionId).toBe(value.revisionId);
  });
});
