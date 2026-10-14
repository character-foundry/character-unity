import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { openBrowserStorage } from './index.js';

const handles: Awaited<ReturnType<typeof openBrowserStorage>>[] = [];
beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange); });
afterEach(() => { handles.splice(0).forEach((handle) => handle.close()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function open() { const storage = await openBrowserStorage({ name: 'character-unity:statistics' }); handles.push(storage); return storage; }

describe('browser statistics snapshot', () => {
  it('reports an empty library without writing, inventing measurements or exposing another workspace', async () => {
    const storage = await open(), workspace = await storage.store.createWorkspace({ ownerId: 'browser', name: 'Library' });
    expect(await storage.statistics.read(workspace.id)).toEqual({
      membership: { total: 0, owned: 0, archiveReferences: 0, forks: 0, favorites: 0, inChat: 0 },
      content: { ownedRevisions: 0, greetings: { total: 0, cards: 0, knownCards: 0 }, lorebookEntries: { total: 0, cards: 0, knownCards: 0 }, tokens: { total: 0, knownCards: 0 } },
      storage: { localAssets: 0, localBytes: 0, inheritedAssets: 0, inheritedBytes: 0, stagedAssets: 0, stagedBytes: 0 },
      chat: { copies: 0, matched: 0, edited: 0 }, tags: [], creators: [], formats: [], sources: [],
    });
    await expect(storage.statistics.read('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('counts live membership, retained shared assets and measured coverage using the SQL statistics contract', async () => {
    const storage = await open(), store = storage.store, workspaceId = (await store.createWorkspace({ ownerId: 'browser', name: 'Mixed library' })).id;
    const identity = { algorithm: 'statistics-fixture-v1', hash: 'a'.repeat(64) };
    const asset = await store.stageAsset({ workspaceId, hash: 'b'.repeat(64), byteLength: 17, mediaType: 'image/png' });
    await store.completeAsset({ workspaceId, assetId: asset.id, measuredHash: asset.hash, measuredByteLength: 17 });
    await store.stageAsset({ workspaceId, hash: 'c'.repeat(64), byteLength: 3, mediaType: 'image/png' });
    const base = await store.createCard({ workspaceId, authorId: 'browser', identity, document: { data: { name: 'Before', alternate_greetings: ['old', 'old', 'old', 'old'] } },
      source: { assetId: asset.id, provenance: { format: 'png' } }, assets: [{ path: 'portrait', assetId: asset.id }] });
    await store.putRevisionMetrics(workspaceId, base.revision.id, { tokenizer: 'fixture', total: 999, tokens: {} });
    const head = await store.saveRevision({ workspaceId, cardId: base.card.id, expectedHead: base.revision.id, authorId: 'browser', identity,
      document: { data: { creator: 'Alice', tags: ['Magic', 'magic', 7], first_mes: 'Hello', alternate_greetings: ['Hi'], group_only_greetings: ['Hey'], character_book: { entries: [{}, {}] } } }, assets: [{ path: 'portrait', assetId: asset.id }] });
    await store.putRevisionMetrics(workspaceId, head.id, { tokenizer: 'fixture', total: 100, tokens: {} });
    await store.setFavorite(workspaceId, base.card.id, true);
    await store.forkCard({ workspaceId, sourceWorkspaceId: workspaceId, sourceRevisionId: head.id, authorId: 'browser', identity,
      document: { data: { creator: 'alice', tags: ['Magic'] } }, assets: [{ path: 'portrait', assetId: asset.id }] });
    const pin = { archiveId: 'historical', cardId: 'upstream', versionId: 'v1' };
    const inherited = await store.registerArchiveAsset({ workspaceId, pin, path: 'portrait', hash: 'd'.repeat(64), byteLength: 40, mediaType: 'image/png' });
    await store.createArchiveFork({ workspaceId, pin, sourceProvider: 'risuai', authorId: 'browser', identity, document: { data: { name: 'Changed', first_mes: 'Welcome', tags: ['Rare'] } }, assets: [{ path: 'portrait', assetId: inherited.id }] });
    await store.addArchiveReference({ workspaceId, pin, favorite: true, summary: { name: 'Historical', creator: ' Alice ', description: '', tags: [' magic ', 'Archive'], source: 'chub', format: 'charx', changedAt: '', portrait: true, tokensTotal: 30, flags: [], greetingCount: 4, lorebookEntryCount: 5 } });
    await store.addArchiveReference({ workspaceId, pin: { ...pin, cardId: 'older', versionId: 'v2' }, summary: { name: 'Unknown', creator: '', description: '', tags: [], source: 'wyvern', format: 'json', changedAt: '', portrait: false, tokensTotal: null, flags: [] } });
    const deleted = await store.createCard({ workspaceId, authorId: 'browser', identity, document: { data: { creator: 'Deleted', tags: ['Deleted'] } } });
    await store.deleteCard(workspaceId, deleted.card.id);
    const other = await store.createWorkspace({ ownerId: 'other', name: 'Other' });
    await store.createCard({ workspaceId: other.id, authorId: 'other', identity, document: { data: { tags: ['Foreign'] } } });
    for (const method of ['add', 'put', 'delete', 'clear'] as const) vi.spyOn(IDBObjectStore.prototype, method).mockImplementation(() => { throw new Error('Statistics must not write'); });
    expect(await storage.statistics.read(workspaceId)).toEqual({
      membership: { total: 5, owned: 3, archiveReferences: 2, forks: 2, favorites: 2, inChat: 0 },
      content: { ownedRevisions: 4, greetings: { total: 8, cards: 3, knownCards: 4 }, lorebookEntries: { total: 7, cards: 2, knownCards: 4 }, tokens: { total: 130, knownCards: 2 } },
      storage: { localAssets: 1, localBytes: 17, inheritedAssets: 1, inheritedBytes: 40, stagedAssets: 1, stagedBytes: 3 }, chat: { copies: 0, matched: 0, edited: 0 },
      tags: [{ label: 'magic', count: 3 }, { label: 'archive', count: 1 }, { label: 'rare', count: 1 }], creators: [{ label: 'alice', count: 3 }],
      formats: [{ label: 'unknown', count: 2 }, { label: 'charx', count: 1 }, { label: 'json', count: 1 }, { label: 'png', count: 1 }],
      sources: [{ label: 'file', count: 2 }, { label: 'chub', count: 1 }, { label: 'risuai', count: 1 }, { label: 'wyvern', count: 1 }],
    });
  });
});
