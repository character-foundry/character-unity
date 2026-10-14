import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { openBrowserStorage } from './index.js';

const handles: Awaited<ReturnType<typeof openBrowserStorage>>[] = [];
const group = { id: 'genre-fantasy', name: ' Fantasy ', members: [' Magic ', 'MAGIC', 'Elves'] };
beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange); });
afterEach(() => { handles.splice(0).forEach((handle) => handle.close()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function open() { const handle = await openBrowserStorage({ name: 'character-unity:meta-tags' }); handles.push(handle); return handle; }

describe('browser meta-tag catalog persistence', () => {
  it('reads unused catalogs without writes, retains schema4, and persists metadata without touching original bytes or search jobs', async () => {
    const storage = await open(), workspace = await storage.store.createWorkspace({ ownerId: 'browser', name: 'Existing library' });
    const bytes = new TextEncoder().encode('exact browser original'), hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((value) => value.toString(16).padStart(2, '0')).join('');
    const asset = await storage.store.stageAsset({ workspaceId: workspace.id, hash, byteLength: bytes.byteLength, mediaType: 'text/plain' });
    await storage.blobs.put(asset.storageKey, new Blob([bytes]).stream(), { hash, byteLength: bytes.byteLength });
    await storage.store.completeAsset({ workspaceId: workspace.id, assetId: asset.id, measuredHash: hash, measuredByteLength: bytes.byteLength });
    const created = await storage.store.createCard({ workspaceId: workspace.id, authorId: 'browser', originalHash: hash,
      identity: { algorithm: 'fixture', hash: 'a'.repeat(64) }, document: { data: { name: 'Kept original', tags: ['MAGIC'] }, opaque: [null, false] },
      source: { assetId: asset.id, provenance: { kind: 'fixture' } }, assets: [{ path: 'portrait', assetId: asset.id }] });
    const jobs = await storage.store.listSearchJobs();
    for (const method of ['add', 'put', 'delete', 'clear'] as const) vi.spyOn(IDBObjectStore.prototype, method).mockImplementation(() => { throw new Error('Catalog reads must not write'); });
    expect(await storage.store.readMetaTags(workspace.id)).toEqual({ version: 0, groups: [] });
    expect(await storage.store.readiness()).toEqual({ schemaVersion: 4 });
    vi.restoreAllMocks();
    await storage.store.writeMetaTags(workspace.id, { expectedVersion: 0, groups: [group] });
    storage.close();
    const reopened = await open();
    expect(await reopened.store.readiness()).toEqual({ schemaVersion: 4 });
    expect(await reopened.store.readMetaTags(workspace.id)).toEqual({ version: 1, groups: [{ id: 'genre-fantasy', name: 'Fantasy', members: ['Magic', 'Elves'] }] });
    expect(await reopened.store.getCard(workspace.id, created.card.id)).toEqual(created.card);
    expect(await reopened.store.getRevision(workspace.id, created.revision.id)).toEqual(created.revision);
    expect(await reopened.store.getSource(workspace.id, created.card.id)).toMatchObject({ assetId: asset.id, provenance: { kind: 'fixture' } });
    expect(await reopened.store.listSearchJobs()).toEqual(jobs);
    expect(new Uint8Array(await new Response((await reopened.blobs.get(asset.storageKey))!.body).arrayBuffer())).toEqual(bytes);
  });
  it('fences competing tabs with version CAS and snapshots mutable input and returned values', async () => {
    const one = await open(), workspace = await one.store.createWorkspace({ ownerId: 'browser', name: 'Shared tabs' }), two = await open();
    const input = { expectedVersion: 0, groups: [structuredClone(group)] }, pending = one.store.writeMetaTags(workspace.id, input);
    input.groups[0]!.name = 'Changed after call'; input.groups[0]!.members[0] = 'Changed member'; input.expectedVersion = 10;
    const saved = await pending; expect(saved.groups[0]!.name).toBe('Fantasy');
    saved.groups[0]!.name = 'Changed returned value';
    expect((await two.store.readMetaTags(workspace.id)).groups[0]!.name).toBe('Fantasy');
    const attempts = await Promise.allSettled([one.store.writeMetaTags(workspace.id, { expectedVersion: 1, groups: [] }),
      two.store.writeMetaTags(workspace.id, { expectedVersion: 1, groups: [group] })]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    const failure = attempts.find((attempt) => attempt.status === 'rejected');
    expect(failure?.status === 'rejected' && failure.reason).toMatchObject({ code: 'HEAD_CONFLICT' });
    expect((await one.store.readMetaTags(workspace.id)).version).toBe(2);
    await expect(two.store.writeMetaTags(workspace.id, { expectedVersion: 0, groups: [] })).rejects.toMatchObject({ code: 'HEAD_CONFLICT' });
  });
  it('keeps separate workspace catalogs and rejects invalid replacements or missing workspace keys', async () => {
    const { store } = await open(), one = await store.createWorkspace({ ownerId: 'browser', name: 'One' }), other = await store.createWorkspace({ ownerId: 'browser', name: 'Other' });
    await store.writeMetaTags(one.id, { expectedVersion: 0, groups: [group] });
    expect(await store.readMetaTags(other.id)).toEqual({ version: 0, groups: [] });
    await expect(store.writeMetaTags(other.id, { expectedVersion: 1, groups: [] })).rejects.toMatchObject({ code: 'HEAD_CONFLICT' });
    await expect(store.writeMetaTags(one.id, { expectedVersion: 1, groups: [{ ...group, members: [] }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.readMetaTags('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(store.writeMetaTags('missing', { expectedVersion: 0, groups: [] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await store.readMetaTags(one.id)).version).toBe(1);
  });
});
