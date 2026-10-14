import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createStore, type UnityStore } from '../../src/index.js';
import { createNodeDriver } from '../../src/node.js';
import { createD1Driver } from '../../src/d1.js';
import { migrate } from '../../src/migrations.js';
import { createStatisticsStore } from '../../src/statistics.js';
import type { StoreDriver } from '../../src/driver.js';
import { createChatStore } from '../../src/chat.js';
import { createAssetMaintenanceStore } from '../../src/asset-maintenance.js';

interface Fixture { driver: StoreDriver; close(): void | Promise<void> }
const factories: Record<string, () => Promise<Fixture>> = {
  sqlite: async () => {
    const db = new Database(':memory:');
    return { driver: createNodeDriver(db), close: () => { db.close(); } };
  },
  d1: async () => {
    const mf = new Miniflare(convertV4MiniflareOptions({ port: 0, workers: [{ name: 'statistics-test', modules: true,
      script: 'export default { fetch() { return new Response("test"); } };', compatibilityDate: '2026-10-11', d1Databases: ['DB'] }] }));
    return { driver: createD1Driver(await mf.getD1Database('DB')), close: () => mf.dispose() };
  },
};

for (const [adapter, factory] of Object.entries(factories)) describe(`statistics contract / ${adapter}`, () => {
  let fixture: Fixture, store: UnityStore, workspaceId: string;
  beforeEach(async () => {
    fixture = await factory();
    await migrate(fixture.driver);
    store = createStore(fixture.driver);
    workspaceId = (await store.createWorkspace({ ownerId: 'alice', name: 'Library' })).id;
  });
  afterEach(async () => { await fixture?.close(); });

  it('[T01] reports an empty workspace without inventing stored cards, bytes or measurements', async () => {
    const result = await createStatisticsStore(fixture.driver).read(workspaceId);
    expect(result).toEqual({
      membership: { total: 0, owned: 0, archiveReferences: 0, forks: 0, favorites: 0, inChat: 0 },
      content: { ownedRevisions: 0, greetings: { total: 0, cards: 0, knownCards: 0 }, lorebookEntries: { total: 0, cards: 0, knownCards: 0 },
        tokens: { total: 0, knownCards: 0 } },
      storage: { localAssets: 0, localBytes: 0, inheritedAssets: 0, inheritedBytes: 0, stagedAssets: 0, stagedBytes: 0 },
      chat: { copies: 0, matched: 0, edited: 0 },
      tags: [], creators: [], formats: [], sources: [],
    });
    await expect(createStatisticsStore(fixture.driver).read('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('[T02] counts current library membership and shared storage once, with explicit measurement coverage', async () => {
    const identity = { algorithm: 'statistics-fixture-v1', hash: 'a'.repeat(64) };
    const asset = await store.stageAsset({ workspaceId, hash: 'b'.repeat(64), byteLength: 17, mediaType: 'image/png' });
    await store.completeAsset({ workspaceId, assetId: asset.id, measuredHash: asset.hash, measuredByteLength: 17 });
    await store.stageAsset({ workspaceId, hash: 'c'.repeat(64), byteLength: 3, mediaType: 'image/png' });
    const base = await store.createCard({ workspaceId, authorId: 'alice', identity,
      document: { data: { name: 'Before', alternate_greetings: ['old', 'old', 'old', 'old'] } },
      source: { assetId: asset.id, provenance: { format: 'png' } }, assets: [{ path: 'portrait', assetId: asset.id }] });
    await store.putRevisionMetrics(workspaceId, base.revision.id, { tokenizer: 'fixture', total: 999, tokens: {} });
    const head = await store.saveRevision({ workspaceId, cardId: base.card.id, expectedHead: base.revision.id, authorId: 'alice', identity,
      document: { data: { name: 'Now', creator: 'Alice', tags: ['Magic', 'magic', 7], first_mes: 'Hello', alternate_greetings: ['Hi'],
        group_only_greetings: ['Hey'], character_book: { entries: [{}, {}] } } }, assets: [{ path: 'portrait', assetId: asset.id }] });
    await store.putRevisionMetrics(workspaceId, head.id, { tokenizer: 'fixture', total: 100, tokens: {} });
    await store.setFavorite(workspaceId, base.card.id, true);
    await store.forkCard({ workspaceId, sourceWorkspaceId: workspaceId, sourceRevisionId: head.id, authorId: 'alice', identity,
      document: { data: { creator: 'alice', tags: ['Magic'] } }, assets: [{ path: 'portrait', assetId: asset.id }] });
    const pin = { archiveId: 'historical', cardId: 'upstream', versionId: 'v1' };
    const inherited = await store.registerArchiveAsset({ workspaceId, pin, path: 'portrait', hash: 'd'.repeat(64), byteLength: 40, mediaType: 'image/png' });
    await store.createArchiveFork({ workspaceId, pin, sourceProvider: 'risuai', authorId: 'alice', identity,
      document: { data: { name: 'Changed', first_mes: 'Welcome', tags: ['Rare'] } }, assets: [{ path: 'portrait', assetId: inherited.id }] });
    const reference = await store.addArchiveReference({ workspaceId, pin, favorite: true, summary: {
      name: 'Historical', creator: ' Alice ', description: '', tags: [' magic ', 'Archive'], source: 'chub', format: 'charx', changedAt: '',
      portrait: true, tokensTotal: 30, flags: [], greetingCount: 4, lorebookEntryCount: 5,
    } });
    await store.addArchiveReference({ workspaceId, pin: { ...pin, cardId: 'older', versionId: 'v2' }, summary: {
      name: 'Unknown measurements', creator: '', description: '', tags: [], source: 'wyvern', format: 'json', changedAt: '',
      portrait: false, tokensTotal: null, flags: [],
    } });
    const deleted = await store.createCard({ workspaceId, authorId: 'alice', identity, document: { data: { creator: 'Not counted', tags: ['Deleted'] } } });
    await store.setFavorite(workspaceId, deleted.card.id, true);
    await store.deleteCard(workspaceId, deleted.card.id);
    const foreign = await store.createWorkspace({ ownerId: 'bob', name: 'Other' });
    await store.createCard({ workspaceId: foreign.id, authorId: 'bob', identity, document: { data: { tags: ['Foreign'] } } });
    const chat = createChatStore(fixture.driver);
    const target = await chat.addTarget({ workspaceId, kind: 'sillytavern', name: 'Chat', baseUrl: 'http://chat.test', credentials: {} });
    await chat.recordPlacements(workspaceId, target.id, [{ remoteId: 'missing', remoteName: 'Missing', cardId: base.card.id, revisionId: head.id, edited: false }], { complete: true });
    await chat.recordPlacements(workspaceId, target.id, [
      { remoteId: 'matched', remoteName: 'Matched', cardId: base.card.id, revisionId: head.id, edited: false },
      { remoteId: 'edited', remoteName: 'Edited', cardId: base.card.id, revisionId: head.id, edited: true },
      { remoteId: 'reference', remoteName: 'Reference', cardId: reference.id, revisionId: pin.versionId, edited: false,
        reference: { sequence: 1, contentHash: identity.hash, revisionHash: null } },
    ], { complete: true });

    // A statistics read can run on a read-only driver, even when projections need work.
    const reader = createStatisticsStore({ query: fixture.driver.query.bind(fixture.driver), batch: async () => { throw new Error('Read must not write'); } });
    expect(await reader.read(workspaceId)).toEqual({
      membership: { total: 5, owned: 3, archiveReferences: 2, forks: 2, favorites: 2, inChat: 2 },
      content: { ownedRevisions: 4, greetings: { total: 8, cards: 3, knownCards: 4 }, lorebookEntries: { total: 7, cards: 2, knownCards: 4 },
        tokens: { total: 130, knownCards: 2 } },
      storage: { localAssets: 1, localBytes: 17, inheritedAssets: 1, inheritedBytes: 40, stagedAssets: 1, stagedBytes: 3 },
      chat: { copies: 3, matched: 2, edited: 1 },
      tags: [{ label: 'magic', count: 3 }, { label: 'archive', count: 1 }, { label: 'rare', count: 1 }],
      creators: [{ label: 'alice', count: 3 }],
      formats: [{ label: 'unknown', count: 2 }, { label: 'charx', count: 1 }, { label: 'json', count: 1 }, { label: 'png', count: 1 }],
      sources: [{ label: 'file', count: 2 }, { label: 'chub', count: 1 }, { label: 'risuai', count: 1 }, { label: 'wyvern', count: 1 }],
    });
    expect(await reader.read(workspaceId)).toEqual(await reader.read(workspaceId));
  });

  it('[T03] keeps reference-only libraries lightweight and bounds deterministic breakdowns', async () => {
    const tags = Array.from({ length: 15 }, (_, index) => `tag-${String(index).padStart(2, '0')}`);
    await store.addArchiveReference({ workspaceId, pin: { archiveId: 'archive', cardId: 'large', versionId: 'exact' }, summary: {
      name: 'Large historical package', creator: 'Creator', description: '', tags: [...tags].reverse(), source: 'risuai', format: 'charx',
      changedAt: '', portrait: true, tokensTotal: 0, flags: [], greetingCount: 0, lorebookEntryCount: 0, assetCount: 8192,
    } });
    const result = await createStatisticsStore({ query: fixture.driver.query.bind(fixture.driver), batch: async () => { throw new Error('No assets may be registered'); } }).read(workspaceId);
    expect(result.membership).toEqual({ total: 1, owned: 0, archiveReferences: 1, forks: 0, favorites: 0, inChat: 0 });
    expect(result.storage).toEqual({ localAssets: 0, localBytes: 0, inheritedAssets: 0, inheritedBytes: 0, stagedAssets: 0, stagedBytes: 0 });
    expect(result.content).toEqual({ ownedRevisions: 0, greetings: { total: 0, cards: 0, knownCards: 1 }, lorebookEntries: { total: 0, cards: 0, knownCards: 1 }, tokens: { total: 0, knownCards: 1 } });
    expect(result.tags).toEqual(tags.slice(0, 12).map((label) => ({ label, count: 1 })));
    expect(await store.listCards(workspaceId)).toEqual([]);
  });

  it('[T04] excludes retired storage records without counting a cleanup ledger as freed physical disk space', async () => {
    const asset = await store.stageAsset({ workspaceId, hash: 'b'.repeat(64), byteLength: 17, mediaType: 'image/png' });
    await store.completeAsset({ workspaceId, assetId: asset.id, measuredHash: asset.hash, measuredByteLength: 17 });
    const staged = await store.stageAsset({ workspaceId, hash: 'c'.repeat(64), byteLength: 3, mediaType: 'image/png' });
    const reader = createStatisticsStore(fixture.driver);
    expect((await reader.read(workspaceId)).storage).toMatchObject({ localAssets: 1, localBytes: 17, stagedAssets: 1, stagedBytes: 3 });
    const maintenance = createAssetMaintenanceStore(fixture.driver, { now: () => new Date('2100-01-03T00:00:00.000Z') });
    await maintenance.retire([asset.id, staged.id], '2100-01-01T00:00:00.000Z');
    expect((await reader.read(workspaceId)).storage).toEqual({ localAssets: 0, localBytes: 0, inheritedAssets: 0, inheritedBytes: 0, stagedAssets: 0, stagedBytes: 0 });
  });
});
