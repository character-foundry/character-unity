import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { openBrowserStorage } from './index.js';
import { createBrowserMaintenance } from './maintenance.js';
import { assetAgeKey } from './maintenance.js';
import { openDatabase } from './database.js';
import { request, transaction } from './transaction.js';

const actor = 'alice', start = Date.parse('2026-10-01T00:00:00.000Z'), day = 86_400_000;
const bytes = new TextEncoder().encode('exact synthetic browser asset');
const body = () => new Blob([bytes]).stream();
const hash = '31c71a3d3a2dc953d1e21a477ae5986876f6c54b7f6ba6e90caebfa38a1af710';
let db: IDBDatabase, storage: Awaited<ReturnType<typeof openBrowserStorage>>, maintenance: ReturnType<typeof createBrowserMaintenance>, workspaceId: string;
beforeEach(async () => {
  vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(start);
  storage = await openBrowserStorage({ name: 'character-unity:maintenance-test' });
  db = await openDatabase('character-unity:maintenance-test'); maintenance = createBrowserMaintenance(db);
  workspaceId = (await storage.store.createWorkspace({ ownerId: actor, name: 'Browser' })).id;
});
afterEach(() => { storage.close(); db.close(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function asset() {
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((value) => value.toString(16).padStart(2, '0')).join('');
  const staged = await storage.store.stageSharedAsset({ workspaceId, hash: digest, byteLength: bytes.byteLength, mediaType: 'text/plain' });
  await storage.blobs.put(staged.storageKey, body(), { hash: digest, byteLength: bytes.byteLength });
  return storage.store.completeAsset({ workspaceId, assetId: staged.id, measuredHash: digest, measuredByteLength: bytes.byteLength });
}
const revision = (assetId: string) => ({ workspaceId, authorId: actor, document: { data: { name: 'Synthetic' } },
  identity: { algorithm: 'test', hash }, assets: [{ path: 'portrait', assetId }] });

describe('explicit browser asset cleanup', () => {
  it('previews without writes, reclaims only deleted unreachable bytes and leaves immutable provenance intact', async () => {
    const saved = await asset();
    const card = await storage.store.createCard({ ...revision(saved.id), source: { assetId: saved.id, provenance: { kind: 'fixture' } } });
    await storage.store.deleteCard(workspaceId, card.card.id);
    vi.setSystemTime(start + 2 * day);
    const before = await transaction(db, ['meta'], 'readonly', function* (tx) { return yield* request(tx.objectStore('meta').getAll()); });
    const preview = await maintenance.preview(actor, workspaceId);
    expect(preview.items).toMatchObject([{ assetId: saved.id, storedByteLength: bytes.byteLength, reason: 'deleted-card' }]);
    expect(await transaction(db, ['meta'], 'readonly', function* (tx) { return yield* request(tx.objectStore('meta').getAll()); })).toEqual(before);
    expect(await storage.blobs.get(saved.storageKey)).not.toBeNull();
    expect((await storage.statistics.read(workspaceId)).storage).toMatchObject({ localAssets: 1, localBytes: bytes.byteLength });
    expect(await maintenance.apply(actor, workspaceId, preview)).toEqual({ removed: 1, alreadyRemoved: 0, bytesRemoved: bytes.byteLength });
    expect(await storage.blobs.get(saved.storageKey)).toBeNull();
    expect((await storage.statistics.read(workspaceId)).storage).toMatchObject({ localAssets: 0, localBytes: 0, stagedAssets: 0, stagedBytes: 0 });
    await expect(storage.store.getAsset(workspaceId, saved.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await storage.store.getRevision(workspaceId, card.revision.id)).assets).toEqual(card.revision.assets);
    expect(await transaction(db, ['cards', 'sources', 'assets'], 'readonly', function* (tx) {
      return [yield* request(tx.objectStore('cards').count()), yield* request(tx.objectStore('sources').count()), yield* request(tx.objectStore('assets').count())];
    })).toEqual([1, 1, 1]);
    expect(await maintenance.apply(actor, workspaceId, preview)).toEqual({ removed: 0, alreadyRemoved: 1, bytesRemoved: 0 });
  });

  it('protects live cards full history and source, recursively protects deleted fork ancestors and never touches Archive locators', async () => {
    const inherited = await asset();
    const original = await storage.store.createCard({ ...revision(inherited.id), source: { assetId: inherited.id, provenance: { kind: 'fixture' } } });
    const fork = await storage.store.forkCard({ ...revision(inherited.id), sourceWorkspaceId: workspaceId, sourceRevisionId: original.revision.id });
    await storage.store.deleteCard(workspaceId, original.card.id);
    const external = await storage.store.registerArchiveAsset({ workspaceId, pin: { archiveId: 'archive', cardId: 'source', versionId: 'pinned' },
      path: 'portrait', hash, byteLength: 99, mediaType: 'image/png' });
    vi.setSystemTime(start + 3 * day);
    expect((await maintenance.preview(actor, workspaceId)).items).toEqual([]);
    expect(await storage.store.getAsset(workspaceId, external.id)).toEqual(external);
    await storage.store.saveRevision({ workspaceId, cardId: fork.card.id, expectedHead: fork.revision.id, authorId: actor,
      document: { data: { name: 'Removed portrait, retained history' } }, identity: { algorithm: 'test', hash }, assets: [] });
    expect((await maintenance.preview(actor, workspaceId)).items).toEqual([]);
    await storage.store.deleteCard(workspaceId, fork.card.id);
    vi.setSystemTime(start + 4 * day - 1);
    expect((await maintenance.preview(actor, workspaceId)).items).toEqual([]);
    vi.setSystemTime(start + 4 * day);
    expect((await maintenance.preview(actor, workspaceId)).items.map((item) => item.assetId)).toEqual([inherited.id]);
  });

  it('requires an explicit observation and another 24 hours for legacy orphans with unknown ages', async () => {
    const orphan = await asset();
    await transaction(db, ['meta'], 'readwrite', function* (tx) { yield* request(tx.objectStore('meta').delete(assetAgeKey(orphan.id))); });
    vi.setSystemTime(start + 20 * day);
    const preview = await maintenance.preview(actor, workspaceId);
    expect(preview.items).toEqual([]); expect(preview.unknownAge.map((item) => item.assetId)).toEqual([orphan.id]);
    const observed = await maintenance.observe(actor, workspaceId, [orphan.id]);
    expect(observed).toEqual({ observed: 1, eligibleAfter: new Date(start + 21 * day).toISOString() });
    expect(await storage.blobs.get(orphan.storageKey)).not.toBeNull();
    await expect(maintenance.observe(actor, workspaceId, [orphan.id])).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
    vi.setSystemTime(start + 21 * day - 1);
    expect((await maintenance.preview(actor, workspaceId)).items).toEqual([]);
    vi.setSystemTime(start + 21 * day);
    expect((await maintenance.preview(actor, workspaceId)).items.map((item) => item.assetId)).toEqual([orphan.id]);
  });

  it('refuses young/foreign selections and a ready object with missing bytes instead of claiming reclaimed space', async () => {
    const orphan = await asset();
    await expect(maintenance.preview('bob', workspaceId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(maintenance.preview(actor, workspaceId, { before: new Date(start).toISOString() })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    vi.setSystemTime(start + 2 * day);
    const preview = await maintenance.preview(actor, workspaceId);
    const other = (await storage.store.createWorkspace({ ownerId: actor, name: 'Other' })).id;
    await expect(maintenance.apply(actor, other, preview)).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
    expect(await storage.blobs.get(orphan.storageKey)).not.toBeNull();
    await transaction(db, ['blobs'], 'readwrite', function* (tx) { yield* request(tx.objectStore('blobs').delete(orphan.storageKey)); });
    await expect(maintenance.preview(actor, workspaceId)).rejects.toMatchObject({ code: 'INTEGRITY' });
  });

  it('rechecks new attachments and rolls back the entire reviewed selection on conflict', async () => {
    const one = await asset();
    const staged = await storage.store.stageAsset({ workspaceId, hash: one.hash, byteLength: bytes.byteLength, mediaType: 'text/plain' });
    await storage.blobs.put(staged.storageKey, body(), { hash: one.hash, byteLength: bytes.byteLength });
    const two = await storage.store.completeAsset({ workspaceId, assetId: staged.id, measuredHash: one.hash, measuredByteLength: bytes.byteLength });
    vi.setSystemTime(start + 2 * day);
    const preview = await maintenance.preview(actor, workspaceId); expect(preview.items).toHaveLength(2);
    await storage.store.createCard(revision(two.id));
    await expect(maintenance.apply(actor, workspaceId, preview)).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
    expect(await storage.blobs.get(one.storageKey)).not.toBeNull(); expect(await storage.blobs.get(two.storageKey)).not.toBeNull();
  });

  it('fences in-flight and future uploads, completion, attachment and fork reuse after atomic retirement', async () => {
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((value) => value.toString(16).padStart(2, '0')).join('');
    const staged = await storage.store.stageSharedAsset({ workspaceId, hash: digest, byteLength: bytes.byteLength, mediaType: 'text/plain' });
    vi.setSystemTime(start + 2 * day);
    const preview = await maintenance.preview(actor, workspaceId);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const upload = storage.blobs.put(staged.storageKey, new ReadableStream({ start(value) { controller = value; } }), { hash: digest, byteLength: bytes.byteLength });
    const rejected = expect(upload).rejects.toMatchObject({ code: 'ABORTED' });
    expect(await maintenance.apply(actor, workspaceId, preview)).toMatchObject({ removed: 1, bytesRemoved: 0 });
    controller.enqueue(bytes); controller.close(); await rejected;
    await expect(storage.blobs.put(staged.storageKey, body(), { hash: digest, byteLength: bytes.byteLength })).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(storage.store.completeAsset({ workspaceId, assetId: staged.id, measuredHash: digest, measuredByteLength: bytes.byteLength })).rejects.toMatchObject({ code: 'ASSET_NOT_READY' });
    await expect(storage.store.createCard(revision(staged.id))).rejects.toMatchObject({ code: 'ASSET_NOT_READY' });
    const original = await storage.store.createCard({ ...revision(staged.id), assets: [] });
    await expect(storage.store.forkCard({ ...revision(staged.id), sourceWorkspaceId: workspaceId, sourceRevisionId: original.revision.id })).rejects.toMatchObject({ code: 'ASSET_NOT_READY' });
    const replacement = await storage.store.stageSharedAsset({ workspaceId, hash: digest, byteLength: bytes.byteLength, mediaType: 'text/plain' });
    expect(replacement.id).not.toBe(staged.id);
    expect(await storage.blobs.get(staged.storageKey)).toBeNull();
  });

  it.each(['attachment', 'cleanup'])('serializes concurrent %s-first writes without a dangling live asset', async (first) => {
    const orphan = await asset(); vi.setSystemTime(start + 2 * day);
    const preview = await maintenance.preview(actor, workspaceId);
    const attach = () => storage.store.createCard(revision(orphan.id));
    const cleanup = () => maintenance.apply(actor, workspaceId, preview);
    const attempts = await Promise.allSettled(first === 'attachment' ? [attach(), cleanup()] : [cleanup(), attach()]);
    expect(attempts.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    const remaining = await storage.blobs.get(orphan.storageKey);
    if (first === 'cleanup') expect(remaining).toBeNull(); else expect(remaining).not.toBeNull();
    expect(await storage.store.listCards(workspaceId)).toHaveLength(first === 'cleanup' ? 0 : 1);
  });
});
