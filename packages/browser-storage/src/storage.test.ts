import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { openBrowserStorage } from './index.js';
import { openDatabase } from './database.js';
import { request, transaction } from './transaction.js';
import type { RevisionInput } from '@character-unity/store';
import { librarySearchCases } from '../../store/tests/conformance/library-search.cases.js';

const input: RevisionInput = { authorId: 'alice', document: { spec: 'chara_card_v3', data: { name: 'Aster', opaque: [null, 2] } },
  identity: { algorithm: 'fixture', hash: 'a'.repeat(64) } };
const names = ['cards', 'revisions', 'sources'];
const name = 'character-unity:test';
const handles: { close(): void }[] = [];
async function open() { const value = await openBrowserStorage({ name }); handles.push(value); return value; }
async function raw() { const value = await openDatabase(name); handles.push(value); return value; }
async function counts() { const db = await raw(); return transaction(db, names, 'readonly', function* (tx) {
  const values: number[] = []; for (const table of names) values.push(yield* request(tx.objectStore(table).count())); return values;
}); }
const body = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
async function digest(bytes: Uint8Array) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))].map((byte) => byte.toString(16).padStart(2, '0')).join(''); }

beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange); });
afterEach(() => { for (const handle of handles.splice(0)) handle.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('browser storage', () => {
  it('reopens sources and ordered revisions, snapshots inputs and isolates workspaces', async () => {
    const first = await open();
    const workspace = await first.store.createWorkspace({ name: 'Desk', ownerId: 'alice' });
    const other = await first.store.createWorkspace({ name: 'Other', ownerId: 'bob' });
    const asset = await first.store.stageAsset({ workspaceId: workspace.id, hash: 'c'.repeat(64), byteLength: 5, mediaType: 'image/png' });
    await first.store.completeAsset({ workspaceId: workspace.id, assetId: asset.id, measuredHash: asset.hash, measuredByteLength: asset.byteLength });
    const source = { assetId: asset.id, provenance: { kind: 'file', filename: 'original.json' } };
    const draft = structuredClone(input);
    const pending = first.store.createCard({ ...draft, workspaceId: workspace.id, originalHash: 'b'.repeat(64), source, assets: [{ path: 'portrait', assetId: asset.id }] });
    draft.document.changed = true; source.provenance.filename = 'mutated';
    const created = await pending;
    expect(created.revision.document).toEqual(input.document);
    await first.store.saveRevision({ ...input, workspaceId: workspace.id, cardId: created.card.id, expectedHead: created.revision.id });
    first.close();
    const second = await open();
    expect((await second.store.listRevisions(workspace.id, created.card.id)).map((v) => v.sequence)).toEqual([1, 2]);
    expect(await second.store.listRevisions(workspace.id, created.card.id, { afterSequence: 1, limit: 1 })).toHaveLength(1);
    expect(await second.store.getSource(workspace.id, created.card.id)).toMatchObject({ provenance: { filename: 'original.json' } });
    expect(await second.store.listWorkspaces('alice')).toEqual([workspace]);
    expect(await second.store.listCards(other.id)).toEqual([]);
    await expect(second.store.getRevision(other.id, created.revision.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(second.store.getSource(other.id, created.card.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    created.revision.document.localMutation = true;
    expect((await second.store.getRevision(workspace.id, created.revision.id)).document).toEqual(input.document);
  });

  it('serializes head comparison and advancement across separate connections', async () => {
    const one = (await open()).store, two = (await open()).store;
    const workspaceId = (await one.createWorkspace({ ownerId: 'alice', name: 'Concurrent' })).id;
    const card = await one.createCard({ ...input, workspaceId });
    const results = await Promise.allSettled([one, two].map((store) => store.saveRevision({ ...input, workspaceId, cardId: card.card.id, expectedHead: card.revision.id })));
    expect(results.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((v) => v.status === 'rejected')).toMatchObject({ reason: { code: 'HEAD_CONFLICT' } });
    expect(await one.listRevisions(workspaceId, card.card.id)).toHaveLength(2);
  });

  it('rolls back card/source writes on late quota failure and rejects unready or foreign assets', async () => {
    const { store } = await open();
    const workspaceId = (await store.createWorkspace({ ownerId: 'alice', name: 'Atomic' })).id;
    const foreign = (await store.createWorkspace({ ownerId: 'bob', name: 'Foreign' })).id;
    const asset = await store.stageAsset({ workspaceId, hash: 'c'.repeat(64), byteLength: 2, mediaType: 'image/png' });
    const source = { assetId: asset.id, provenance: { kind: 'file' } };
    await expect(store.createCard({ ...input, workspaceId, source })).rejects.toMatchObject({ code: 'ASSET_NOT_READY' });
    await expect(store.completeAsset({ workspaceId, assetId: asset.id, measuredHash: 'b'.repeat(64), measuredByteLength: 2 })).rejects.toMatchObject({ code: 'INTEGRITY' });
    await store.completeAsset({ workspaceId, assetId: asset.id, measuredHash: asset.hash, measuredByteLength: 2 });
    await expect(store.createCard({ ...input, workspaceId: foreign, source })).rejects.toMatchObject({ code: 'ASSET_NOT_READY' });
    const add = IDBObjectStore.prototype.add;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'revisions') throw new DOMException('Injected full storage', 'QuotaExceededError');
      return add.apply(this, args);
    });
    await expect(store.createCard({ ...input, workspaceId, source })).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(await counts()).toEqual([0, 0, 0]);
    spy.mockRestore();
    const created = await store.createCard({ ...input, workspaceId, source });
    const staged = await store.stageAsset({ workspaceId, hash: asset.hash, byteLength: 2, mediaType: 'image/png' });
    await expect(store.saveRevision({ ...input, workspaceId, cardId: created.card.id, expectedHead: created.revision.id, assets: [{ path: 'portrait', assetId: staged.id }] })).rejects.toMatchObject({ code: 'ASSET_NOT_READY' });
    expect((await store.getCard(workspaceId, created.card.id)).headRevisionId).toBe(created.revision.id);
    expect(await counts()).toEqual([1, 1, 1]);
  });

  it('searches the library with the same meaning as the SQL store (S18)', async () => {
    const { store } = await open();
    await librarySearchCases(store, (await store.createWorkspace({ ownerId: 'alice', name: 'Library' })).id);
  });

  it('preserves fork roots and scoped pagination without importing ancestor assets', async () => {
    const { store } = await open();
    const workspaceId = (await store.createWorkspace({ ownerId: 'alice', name: 'Source' })).id;
    const target = (await store.createWorkspace({ ownerId: 'bob', name: 'Forks' })).id;
    const source = await store.createCard({ ...input, workspaceId, originalHash: 'b'.repeat(64) });
    const first = await store.forkCard({ ...input, workspaceId: target, sourceWorkspaceId: workspaceId, sourceRevisionId: source.revision.id });
    const second = await store.forkCard({ ...input, workspaceId: target, sourceWorkspaceId: workspaceId, sourceRevisionId: source.revision.id });
    expect(first.card.originalHash).toBe(source.card.originalHash);
    expect(first.revision).toMatchObject({ sequence: 1, parentRevisionId: source.revision.id });
    expect(await store.getSource(target, first.card.id)).toBeNull();
    const page = await store.listCards(target, { limit: 1 });
    expect(await store.listCards(target, { afterId: page[0]!.id })).toHaveLength(1);
    expect(new Set((await store.listForks(target, source.revision.id)).map((v) => v.id))).toEqual(new Set([first.card.id, second.card.id]));
    expect(await store.listForks(workspaceId, source.revision.id)).toEqual([]);
    await expect(store.forkCard({ ...input, workspaceId: target, sourceWorkspaceId: target, sourceRevisionId: source.revision.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(store.listCards(target, { limit: 0 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('publishes only verified immutable blobs, supports retry/reopen and cancels bad streams', async () => {
    const { blobs } = await open();
    const bytes = new TextEncoder().encode('An immutable original');
    const expected = { hash: await digest(bytes), byteLength: bytes.length };
    await blobs.put('originals/one', body(bytes), expected);
    await blobs.put('originals/one', body(bytes), expected);
    const reopened = (await open()).blobs;
    expect(await new Response((await reopened.get('originals/one'))!.body).text()).toBe('An immutable original');
    const different = new Uint8Array([0]);
    await expect(blobs.put('originals/one', body(different), { hash: await digest(different), byteLength: 1 })).rejects.toMatchObject({ code: 'INTEGRITY' });
    await expect(blobs.put('originals/wrong', body(different), expected)).rejects.toMatchObject({ code: 'INTEGRITY' });
    expect(await blobs.get('originals/wrong')).toBeNull();
    const controller = new AbortController();
    const cancelled = vi.fn();
    const pending = blobs.put('originals/abort', new ReadableStream({ cancel: cancelled }), expected, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    expect(cancelled).toHaveBeenCalledOnce(); expect(await blobs.get('originals/abort')).toBeNull();
    await expect(blobs.put('../outside', body(bytes), expected)).rejects.toMatchObject({ code: 'INVALID_KEY' });
    await expect(blobs.put('originals/huge', body(bytes), { ...expected, byteLength: 33 * 1024 * 1024 })).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });

  it('refuses foreign schemas and namespaces without erasing data', async () => {
    await expect(openBrowserStorage({ name: 'archive' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const op = indexedDB.open(name, 1);
      op.onupgradeneeded = () => { op.result.createObjectStore('foreign').put('keep', 'original'); };
      op.onsuccess = () => resolve(op.result); op.onerror = () => reject(op.error);
    });
    handles.push(db);
    await expect(open()).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' });
    expect(await transaction(db, ['foreign'], 'readonly', function* (tx) { return yield* request(tx.objectStore('foreign').get('original')); })).toBe('keep');
  });
});
