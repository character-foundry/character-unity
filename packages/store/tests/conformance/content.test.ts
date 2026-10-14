import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createStore } from '../../src/index.js';
import { createNodeDriver } from '../../src/node.js';
import { createD1Driver } from '../../src/d1.js';
import { migrate } from '../../src/migrations.js';
import { createContentStore, type ContentStore } from '../../src/content.js';
import type { StoreDriver } from '../../src/driver.js';

interface Fixture { driver: StoreDriver; close(): void | Promise<void> }
const factories: Record<string, () => Promise<Fixture>> = {
  sqlite: async () => { const db = new Database(':memory:'); return { driver: createNodeDriver(db), close: () => { db.close(); } }; },
  d1: async () => {
    const mf = new Miniflare(convertV4MiniflareOptions({ port: 0, workers: [{ name: 'content-test', modules: true,
      script: 'export default { fetch() { return new Response("test"); } };', compatibilityDate: '2026-10-11', d1Databases: ['DB'] }] }));
    return { driver: createD1Driver(await mf.getD1Database('DB')), close: () => mf.dispose() };
  },
};
for (const [adapter, factory] of Object.entries(factories)) describe(`content contract / ${adapter}`, () => {
  let fixture: Fixture, store: ContentStore, workspaceId: string;
  const value = () => ({ workspaceId, kind: 'preset' as const, authorId: 'alice', title: 'Preset', json: { temperature: 0.7, foreign: { preserve: true } },
    hash: 'a'.repeat(64), source: { hash: 'b'.repeat(64), text: '\uFEFF{ "temperature": 0.7, "foreign": {"preserve":true} }\n', filename: 'preset.json' } });
  beforeEach(async () => { fixture = await factory(); await migrate(fixture.driver); store = createContentStore(fixture.driver);
    workspaceId = (await createStore(fixture.driver).createWorkspace({ ownerId: 'alice', name: 'Library' })).id; });
  afterEach(async () => { await fixture?.close(); });
  it('[D01] imports lossless typed JSON and deduplicates exact bytes or canonical content without making character cards', async () => {
    expect(await store.list(workspaceId)).toEqual({ items: [], total: 0, nextAfter: null });
    const imported = await store.import(value());
    expect(imported.created).toBe(true);
    expect(imported.record.document.kind).toBe('preset');
    expect(imported.record.revision.json).toEqual(value().json);
    expect(await store.original(workspaceId, imported.record.document.id)).toMatchObject(value().source);
    const duplicate = await store.import(value());
    expect(duplicate.created).toBe(false);
    expect(duplicate.record.document.id).toBe(imported.record.document.id);
    const canonical = await store.import({ ...value(), source: { ...value().source, hash: 'c'.repeat(64), text: '{"foreign":{"preserve":true},"temperature":0.7}' } });
    expect(canonical.created).toBe(false);
    expect(canonical.record.document.id).toBe(imported.record.document.id);
    expect((await store.list(workspaceId)).total).toBe(1);
    expect(await createStore(fixture.driver).listCards(workspaceId)).toEqual([]);
  });
  it('[D02] saves immutable history with CAS, forks exact revisions without duplicating originals, and isolates deleted or foreign content', async () => {
    const created = (await store.import(value())).record;
    const saved = await store.save({ ...value(), documentId: created.document.id, expectedHead: created.revision.id,
      title: 'Changed', json: { temperature: 1, foreign: { preserve: true } }, hash: 'c'.repeat(64) });
    await expect(store.save({ ...value(), documentId: created.document.id, expectedHead: created.revision.id })).rejects.toMatchObject({ code: 'HEAD_CONFLICT' });
    expect((await store.revision(workspaceId, created.document.id, created.revision.id)).json).toEqual(value().json);
    expect((await store.history(workspaceId, created.document.id, { limit: 1 })).nextAfter).toBe(1);
    const fork = await store.fork(workspaceId, created.document.id, created.revision.id, 'alice');
    expect(fork.document.forkedFromRevisionId).toBe(created.revision.id);
    expect(fork.document.sourceId).toBe(created.document.sourceId);
    expect(fork.revision.json).toEqual(value().json);
    const other = await createStore(fixture.driver).createWorkspace({ ownerId: 'bob', name: 'Other' });
    await expect(store.get(other.id, created.document.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await store.remove(workspaceId, created.document.id);
    await expect(store.get(workspaceId, created.document.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await store.get(workspaceId, fork.document.id)).revision.json).toEqual(value().json);
    expect((await store.revision(workspaceId, created.document.id, saved.id)).title).toBe('Changed');
    expect((await store.list(workspaceId)).total).toBe(1);
  });
  it('[D03] publishes exact revisions and current ancestor policies fence reads, originals and private recipient forks', async () => {
    const owned = (await store.import(value())).record;
    const publication = await store.publish('alice', workspaceId, owned.document.id, owned.revision.id, { visibility: 'public', allowFork: true, allowOriginal: false });
    await store.save({ ...value(), documentId: owned.document.id, expectedHead: owned.revision.id, json: { changed: true }, hash: 'c'.repeat(64) });
    expect((await store.publication(null, publication.id)).revision.json).toEqual(value().json);
    await expect(store.publicationOriginal('bob', publication.id)).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
    expect((await store.publicationOriginal('alice', publication.id)).text).toBe(value().source.text);
    const bob = await createStore(fixture.driver).createWorkspace({ ownerId: 'bob', name: 'Recipient' });
    const fork = await store.forkPublication('bob', bob.id, publication.id, publication.policyVersion);
    expect(fork.document.sourcePublicationId).toBe(publication.id);
    expect(fork.document.sourceId).not.toBe(owned.document.sourceId);
    expect(fork.revision.json).toEqual(value().json);
    // The permitted published JSON is the recipient's source, not Alice's hidden original bytes.
    expect((await store.original(bob.id, fork.document.id)).text).toBe(JSON.stringify(value().json));
    const derivative = await store.publish('bob', bob.id, fork.document.id, fork.revision.id, { visibility: 'public', allowFork: true, allowOriginal: true });
    const changed = await store.updatePublication('alice', publication.id, publication.policyVersion, { visibility: 'private', allowFork: false, allowOriginal: false });
    expect(changed.policyVersion).toBe(2);
    await expect(store.updatePublication('alice', publication.id, 1, { visibility: 'public', allowFork: true, allowOriginal: true })).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
    await expect(store.publication(null, derivative.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(store.forkPublication('bob', bob.id, publication.id, 1)).rejects.toThrow();
    expect((await store.get(bob.id, fork.document.id)).revision.json).toEqual(value().json);
    expect((await store.publications(null)).items).toEqual([]);
  });
  it('[D04] atomically deduplicates concurrent imports and rolls back failed imports or permission-revoked forks', async () => {
    const simultaneous = await Promise.all([store.import(value()),store.import({ ...value(),source: { ...value().source,hash: 'c'.repeat(64),text: '{"temperature":0.7,"foreign":{"preserve":true}}' } })]);
    expect(simultaneous.filter((result) => result.created)).toHaveLength(1);
    expect(simultaneous[0].record.document.id).toBe(simultaneous[1].record.document.id);
    for (let index = 0; index <= 5; index++) {
      const failing = createContentStore({ query: fixture.driver.query.bind(fixture.driver),batch: (statements) => {
        const injected = [...statements]; injected.splice(index,0,{ sql: "INSERT INTO unity_workspaces(id,owner_id,name,created_at) VALUES (NULL,'fault','fault','fault')" });
        return fixture.driver.batch(injected);
      } });
      await expect(failing.import({ ...value(),hash: 'd'.repeat(64),source: { ...value().source,hash: 'e'.repeat(64),text: '{"new":true}' } })).rejects.toThrow();
      expect((await store.list(workspaceId)).total).toBe(1);
      expect(await store.findImport(workspaceId,'preset','e'.repeat(64))).toBeNull();
    }
    const first = simultaneous[0].record, shared = await store.publish('alice',workspaceId,first.document.id,first.revision.id,{ visibility: 'public',allowFork: true,allowOriginal: false });
    const bob = await createStore(fixture.driver).createWorkspace({ ownerId: 'bob',name: 'Bob' });
    const fenced = createContentStore({ query: fixture.driver.query.bind(fixture.driver),batch: async (statements) => {
      await store.updatePublication('alice',shared.id,shared.policyVersion,{ visibility: 'private',allowFork: false,allowOriginal: false });
      return fixture.driver.batch(statements);
    } });
    await expect(fenced.forkPublication('bob',bob.id,shared.id,shared.policyVersion)).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
    expect((await store.list(bob.id)).total).toBe(0);
  });
});
