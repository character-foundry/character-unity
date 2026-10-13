import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createStore } from '../../src/index.js';
import type { UnityStore } from '../../src/index.js';
import { createNodeDriver } from '../../src/node.js';
import { createD1Driver } from '../../src/d1.js';
import { createAssetMaintenanceStore } from '../../src/asset-maintenance.js';
import { createChatStore } from '../../src/chat.js';
import { migrate } from '../../src/migrations.js';
import type { StoreDriver } from '../../src/driver.js';
import { archiveForkCases, archiveMembershipCases, importIdentityCases, libraryReferenceCases, searchOutboxCases, sharedAssetCases } from './archive.cases.js';

interface Fixture { driver: StoreDriver; close(): void | Promise<void> }
const factories: Record<string, () => Promise<Fixture>> = {
  sqlite: async () => { const db = new Database(':memory:'); return { driver: createNodeDriver(db), close: () => { db.close(); } }; },
  d1: async () => {
    const mf = new Miniflare(convertV4MiniflareOptions({ port: 0, workers: [{ name: 'archive-reference-test', modules: true,
      script: 'export default { fetch() { return new Response("test"); } };', compatibilityDate: '2026-10-11', d1Databases: ['DB'] }] }));
    return { driver: createD1Driver(await mf.getD1Database('DB')), close: () => mf.dispose() };
  },
};
for (const [adapter, factory] of Object.entries(factories)) describe(`store contract / ${adapter}`, () => {
  let fixture: Fixture, store: UnityStore, workspaceId: string;
  beforeEach(async () => { fixture = await factory(); await migrate(fixture.driver); store = createStore(fixture.driver);
    workspaceId = (await store.createWorkspace({ ownerId: 'alice', name: 'Archive library' })).id; });
  afterEach(async () => { await fixture?.close(); });
  it('[S20] stores one pinned lightweight membership per upstream source', async () => {
    await archiveMembershipCases(store, workspaceId);
    expect(await fixture.driver.query({ sql: 'SELECT count(*) AS count FROM unity_assets' })).toEqual([{ count: 0 }]);
    expect(await fixture.driver.query({ sql: 'SELECT count(*) AS count FROM unity_revisions' })).toEqual([{ count: 0 }]);
    await expect(fixture.driver.batch([{ sql: "UPDATE unity_archive_references SET archive_version_id = 'retargeted'" }])).rejects.toThrow();
  });
  it('[S21] keeps external fork ancestry and asset bytes outside Unity storage', async () => {
    await archiveForkCases(store, workspaceId);
    const now = Date.now(), maintenance = createAssetMaintenanceStore(fixture.driver, { now: () => new Date(now + 4 * 86_400_000) });
    expect(await maintenance.preview(new Date(now + 2 * 86_400_000).toISOString())).toEqual([]);
    const [asset] = await fixture.driver.query<{ id: string }>({ sql: 'SELECT asset_id AS id FROM unity_archive_assets LIMIT 1' });
    await expect(maintenance.retire([asset!.id], new Date(now + 2 * 86_400_000).toISOString())).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
    await expect(fixture.driver.batch([{ sql: "UPDATE unity_archive_fork_sources SET archive_version_id = 'retargeted'" }])).rejects.toThrow();
    await expect(fixture.driver.batch([{ sql: 'DELETE FROM unity_archive_assets' }])).rejects.toThrow();
  });
  it('[S22] atomically deduplicates imports without collapsing changed forks or modules', async () => {
    await importIdentityCases(store, workspaceId);
  });
  it('[S23] pages the mixed library after one consistent filter and global sort', async () => {
    await libraryReferenceCases(store, workspaceId);
  });
  it('derives reference chat filters from non-missing exact-version placements, not retained identity receipts', async () => {
    const chat = createChatStore(fixture.driver);
    const target = await chat.addTarget({ workspaceId, kind: 'sillytavern', name: 'ST', baseUrl: 'http://st.lan:9000', credentials: {} });
    const pin = { archiveId: 'archive', cardId: 'original', versionId: 'version-1' };
    const summary = { name: 'Aster', creator: 'Maker', description: '', tags: [], source: 'chub', format: 'json',
      changedAt: '2026-10-13', portrait: false, tokensTotal: null, flags: [], greetingCount: 1, alternateGreetingCount: 0, lorebookEntryCount: 0 };
    const first = await store.addArchiveReference({ workspaceId, pin, summary });
    const second = await store.addArchiveReference({ workspaceId, pin: { ...pin, versionId: 'version-2' }, summary });
    const otherWorkspace = (await store.createWorkspace({ ownerId: 'bob', name: 'Other' })).id;
    await store.addArchiveReference({ workspaceId: otherWorkspace, pin, summary });
    const query = () => store.listLibrarySummaries(workspaceId, { has: ['chat'] });
    expect((await query()).items).toEqual([]);
    const observed = { remoteId: 'Aster.png', remoteName: 'Aster', cardId: first.id, revisionId: pin.versionId, edited: false,
      reference: { sequence: 1, contentHash: 'a'.repeat(64), revisionHash: 'b'.repeat(64) } };
    await chat.recordPlacements(workspaceId, target.id, [observed], { complete: false });
    expect((await query()).items).toMatchObject([{ reference: { id: first.id }, inChat: true }]);
    expect((await store.listLibrarySummaries(workspaceId, { ids: [second.id] })).items).toMatchObject([{ inChat: false }]);
    expect((await store.listLibrarySummaries(otherWorkspace, { has: ['chat'] })).items).toEqual([]);
    await chat.recordPlacements(workspaceId, target.id, [{ ...observed, edited: true }], { complete: false });
    expect((await query()).total).toBe(1);
    await chat.recordPlacements(workspaceId, target.id, [], { complete: false, error: 'offline' });
    expect((await query()).total).toBe(1);
    const anotherTarget = await chat.addTarget({ workspaceId, kind: 'sillytavern', name: 'Another ST', baseUrl: 'http://other-st.lan:9000', credentials: {} });
    await chat.recordPlacements(workspaceId, anotherTarget.id, [observed], { complete: false });
    await chat.recordPlacements(workspaceId, target.id, [], { complete: true });
    expect((await query()).total).toBe(1);
    await chat.removeTarget(workspaceId, anotherTarget.id);
    expect((await query()).total).toBe(0);
    await chat.recordPlacements(workspaceId, target.id, [observed], { complete: false });
    await chat.forgetPlacement(workspaceId, target.id, observed.remoteId);
    expect(await chat.resolveRevision(workspaceId, { revisionHash: observed.reference.revisionHash, contentHash: observed.reference.contentHash }))
      .toMatchObject({ cardId: first.id });
    expect((await query()).total).toBe(0);
    await chat.recordPlacements(workspaceId, target.id, [observed], { complete: false });
    await chat.removeTarget(workspaceId, target.id);
    expect((await query()).total).toBe(0);
    const finalTarget = await chat.addTarget({ workspaceId, kind: 'sillytavern', name: 'Last ST', baseUrl: 'http://last-st.lan:9000', credentials: {} });
    await chat.recordPlacements(workspaceId, finalTarget.id, [observed], { complete: false });
    await store.removeArchiveReference(workspaceId, first.id);
    expect((await query()).total).toBe(0);
  });
  it('[S24] reuses one durable import asset claim and never revives a retired asset', async () => {
    await sharedAssetCases(store, workspaceId);
    const input = { workspaceId, hash: '9'.repeat(64), byteLength: 5, mediaType: 'image/png' };
    const old = await store.stageSharedAsset(input), now = Date.now();
    const maintenance = createAssetMaintenanceStore(fixture.driver, { now: () => new Date(now + 4 * 86_400_000) });
    await maintenance.retire([old.id], new Date(now + 2 * 86_400_000).toISOString());
    const next = await store.stageSharedAsset(input); expect(next.id).not.toBe(old.id);
    await expect(store.completeAsset({ workspaceId, assetId: old.id, measuredHash: input.hash, measuredByteLength: input.byteLength })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(fixture.driver.batch([{ sql: "UPDATE unity_assets SET state = 'ready' WHERE id = ?", params: [old.id] }])).rejects.toThrow();
  });
  it('[S25] atomically enqueues owned revisions and deletes with durable guarded search generations', async () => {
    await searchOutboxCases(store, workspaceId);
    expect(await fixture.driver.query({ sql: 'SELECT event_sequence AS sequence,pending FROM unity_search_outbox WHERE workspace_id = ?', params: [workspaceId] })).toEqual([{ sequence: 4, pending: 0 }]);
  });
  it('rolls back Archive metadata, ancestry, revision and import claims after every late failure', async () => {
    const input = { workspaceId, authorId: 'alice', document: { spec: 'chara_card_v3', data: { name: 'Atomic' } },
      identity: { algorithm: 'fixture', hash: 'a'.repeat(64) } };
    const pin = { archiveId: 'fixture', cardId: 'card', versionId: 'version' };
    async function counts() {
      return Promise.all(['cards', 'revisions', 'revision_seals', 'archive_fork_sources', 'archive_assets', 'assets', 'import_claims', 'search_outbox']
        .map(async (table) => fixture.driver.query({ sql: `SELECT count(*) AS count FROM unity_${table}` })));
    }
    const before = await counts();
    for (let step = 0; step <= 5; step++) {
      const broken = createStore({ query: fixture.driver.query, batch: (statements) => {
        const faulty = [...statements]; faulty.splice(step, 0, { sql: "INSERT INTO unity_workspaces(id,owner_id,name,created_at) VALUES (NULL,'failure','failure','failure')" });
        return fixture.driver.batch(faulty);
      } });
      if (step <= 4) {
        await expect(broken.createArchiveFork({ ...input, pin })).rejects.toThrow(); expect(await counts()).toEqual(before);
      }
      await expect(broken.createImportedCard({ ...input, fileHash: 'b'.repeat(64) })).rejects.toThrow(); expect(await counts()).toEqual(before);
      if (step <= 2) {
        await expect(broken.registerArchiveAsset({ workspaceId, pin, path: 'portrait', hash: 'c'.repeat(64), byteLength: 1, mediaType: 'image/png' })).rejects.toThrow();
        expect(await counts()).toEqual(before);
      }
    }
  });
});
