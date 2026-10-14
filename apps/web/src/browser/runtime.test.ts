import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { openBrowserStorage } from '@character-unity/browser-storage';
import { createAssetService } from '@character-unity/assets';
import { createCardService } from '@character-unity/cards';
import { hashBytes } from '@character-foundry/character-foundry/identity';
import { writeCharX } from '@character-foundry/character-foundry/charx';
import { parseCard } from '@character-foundry/character-foundry/loader';
import { createNativeArchiveAssetResolver } from '@character-unity/cards/native-reader';
import { createLibraryClient } from '../lib/unity';
import { createBrowserRuntime } from './runtime';

const actor = { id: 'browser', uri: 'urn:unity:user:browser' };
const original = new TextEncoder().encode(JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: {
  name: 'Existing browser card', description: 'Kept in the existing IndexedDB database.', extensions: { vendor: [1, null] },
} }));
const hosts: ReturnType<typeof createBrowserRuntime>[] = [];
async function localBlobCount() {
  return new Promise<number>((resolve, reject) => {
    const opening = indexedDB.open('character-unity:architect');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result, tx = db.transaction('blobs', 'readonly'), count = tx.objectStore('blobs').count();
      tx.oncomplete = () => { db.close(); resolve(count.result); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}
beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange); });
afterEach(async () => { await Promise.all(hosts.splice(0).map((host) => host.close())); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('native browser profile', () => {
  it('reopens changed Archive forks with inherited originals and files, exports without copying blobs, and fails explicitly when disconnected', async () => {
    const portrait = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg=='), (character) => character.charCodeAt(0));
    const notes = new TextEncoder().encode('Inherited notes: αβ\n');
    const document = { spec: 'chara_card_v3' as const, spec_version: '3.0' as const, data: { name: 'Archive source',
      description: '', personality: '', scenario: '', first_mes: '', mes_example: '', creator: '', creator_notes: '', character_version: '1.0',
      tags: [], alternate_greetings: [], group_only_greetings: [], extensions: {}, assets: [
      { type: 'icon' as const, name: 'main', ext: 'png', uri: 'ccdefault:' },
      { type: 'custom' as const, name: 'notes', ext: 'txt', uri: 'embeded://other/notes.txt', vendor: [0, false] },
    ] } };
    const accepted = new Uint8Array(writeCharX(document, [{ type: 'icon', name: 'main', ext: 'png', data: portrait, isMain: true },
      { type: 'custom', name: 'notes', ext: 'txt', data: notes }], { preserveDescriptors: true }).buffer);
    const hash = await hashBytes(accepted), reads: RequestInit[] = [];
    const archive = { origin: 'https://archive.invalid', async fetch(url: string, init?: RequestInit) {
      reads.push(init ?? {});
      if (new URL(url).pathname === `/api/archive/v2/objects/${hash}`) return new Response(accepted);
      return Response.json({ archiveId: 'archive', id: 'source', versionId: 'pinned', name: 'Archive source', provider: 'chub', recordId: 'source',
        url: 'https://source.invalid/source', document, versionList: [{ id: 'pinned', sequence: 3,
          objects: [{ role: 'card', name: 'original.charx', mediaType: 'application/zip', sha256: hash, byteLength: accepted.length }] }] });
    } };
    const host = createBrowserRuntime({ archive }); hosts.push(host);
    const connection = await host.runtime.restore();
    const workspace = await connection.request<{ id: string }>('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Referenced files' }) });
    const prefix = `/api/workspaces/${workspace.id}`;
    const reference = await connection.request<{ cardId: string }>(`${prefix}/archive/v2/cards/source/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ versionId: 'pinned' }),
    });
    const client = createLibraryClient(connection, workspace.id), opened = await client.openCard(reference.cardId);
    const changed = structuredClone(opened.revision.document); (changed.data as Record<string, unknown>).name = 'My lightweight fork';
    const form = new FormData(); form.set('input', JSON.stringify({ expectedHead: opened.revision.id, document: changed,
      bindings: opened.revision.assets.map((asset) => ({ path: asset.path, source: { kind: 'existing', path: asset.path } })) }));
    const fork = await connection.request<{ cardId: string; revisionId: string }>(`${prefix}/cards/${reference.cardId}/fork-assets`, { method: 'POST', body: form });
    expect(fork.cardId).not.toBe(reference.cardId);
    connection.dispose(); await host.close();

    const reopened = createBrowserRuntime({ archive }); hosts.push(reopened);
    const session = await reopened.runtime.restore(), path = `${prefix}/cards/${fork.cardId}`;
    for (const [assetPath, bytes] of [['portrait', portrait], ['declared/0', portrait], ['declared/1', notes]] as const) {
      expect(await (await session.fetch(`${path}/asset?${new URLSearchParams({ revisionId: fork.revisionId, path: assetPath })}`)).bytes()).toEqual(bytes);
    }
    expect(await (await session.fetch(`${path}/original`)).bytes()).toEqual(accepted);
    const exported = await (await session.fetch(`${path}/export?${new URLSearchParams({ revisionId: fork.revisionId, format: 'charx' })}`)).bytes();
    expect((await parseCard(exported, { extractAssets: true })).assets.find((asset) => asset.name === 'notes')?.data).toEqual(notes);
    const storage = await openBrowserStorage();
    expect(await storage.store.listCards(workspace.id)).toHaveLength(1);
    for (const binding of (await storage.store.getRevision(workspace.id, fork.revisionId)).assets) {
      const asset = await storage.store.getAsset(workspace.id, binding.assetId);
      expect(await storage.store.getArchiveAsset(workspace.id, asset.id)).not.toBeNull();
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
      const protectedAssets = createAssetService(storage.store, storage.blobs, { external: createNativeArchiveAssetResolver(storage.store) });
      await expect(protectedAssets.upload(workspace.id, binding.assetId, body)).rejects.toMatchObject({ code: 'INVALID_INPUT', message: 'Referenced Archive assets cannot be uploaded or overwritten' });
      expect(cancelled).toBe(true);
    }
    expect(await localBlobCount()).toBe(0);
    storage.close(); session.dispose(); await reopened.close();

    const disconnected = createBrowserRuntime(); hosts.push(disconnected);
    const offline = await disconnected.runtime.restore();
    for (const resource of [`${path}/original`, `${path}/asset?${new URLSearchParams({ revisionId: fork.revisionId, path: 'declared/1' })}`,
      `${path}/export?${new URLSearchParams({ revisionId: fork.revisionId, format: 'charx' })}`]) {
      await expect(offline.request(resource)).rejects.toMatchObject({ status: 503, code: 'SOURCE_UNAVAILABLE' });
    }
    expect(reads.every((request) => request.credentials === 'omit' && !new Headers(request.headers).has('authorization'))).toBe(true);
    offline.dispose();
  });
  it('opens an existing Architect library in place through the native immutable client', async () => {
    const existing = await openBrowserStorage();
    const cards = createCardService(existing.store, createAssetService(existing.store, existing.blobs));
    const workspace = await cards.createWorkspace(actor, 'Existing desk');
    const imported = await cards.import(actor, workspace.id, original, { kind: 'file', filename: 'existing.json' });
    await cards.favorite(actor, workspace.id, imported.card.id, true);
    existing.close();

    const host = createBrowserRuntime(); hosts.push(host);
    const connection = await host.runtime.restore();
    expect(connection.profile).toBe('browser');
    expect(connection.actor).toEqual(actor);
    expect(await connection.request('/api/workspaces')).toEqual({ workspaces: [workspace] });
    const client = createLibraryClient(connection, workspace.id);
    expect((await client.listCards({})).cards).toMatchObject([{ id: imported.card.id, favorite: true }]);
    expect((await client.openCard(imported.card.id)).revision.document).toMatchObject({ data: { extensions: { vendor: [1, null] } } });
    expect(await (await connection.fetch(`/api/workspaces/${workspace.id}/cards/${imported.card.id}/original`)).bytes()).toEqual(original);
    connection.dispose();
    await host.close();
    const unchanged = await openBrowserStorage();
    expect(await unchanged.store.readiness()).toEqual({ schemaVersion: 4 });
    expect(await unchanged.store.listRevisions(workspace.id, imported.card.id)).toHaveLength(1);
    unchanged.close();
  });

  it('runs imports, edits and exact downloads without any network API, with native duplicate checks and stale-head protection', async () => {
    const network = vi.fn<typeof fetch>().mockRejectedValue(new Error('Network is offline')); vi.stubGlobal('fetch', network);
    const host = createBrowserRuntime(); hosts.push(host);
    const connection = await host.runtime.restore();
    const workspace = await connection.request<{ id: string }>('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Offline desk' }) });
    const client = createLibraryClient(connection, workspace.id);
    const file = new File([original], 'aster.json', { type: 'application/json' });
    const imported = await client.importFile(file);
    expect(imported.import).toEqual({ created: true, match: null });
    expect((await client.importFile(file)).import).toEqual({ created: false, match: 'file' });
    const opened = await client.openCard(imported.card.id), document = structuredClone(opened.revision.document);
    (document.data as Record<string, unknown>).name = 'Offline edit';
    const save = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedHead: opened.revision.id, document }) };
    const path = `/api/workspaces/${workspace.id}/cards/${imported.card.id}`;
    expect(await connection.request(`${path}/revisions`, save)).toMatchObject({ sequence: 2 });
    await expect(connection.request(`${path}/revisions`, save)).rejects.toMatchObject({ status: 409, code: 'HEAD_CONFLICT' });
    expect((await client.openCard(imported.card.id)).revision.document).toMatchObject({ data: { name: 'Offline edit', extensions: { vendor: [1, null] } } });
    expect(await (await connection.fetch(`${path}/original`)).bytes()).toEqual(original);
    expect(network).not.toHaveBeenCalled(); connection.dispose();
  });

  it('retains the saved head after a quota failure and makes the same save retryable', async () => {
    const host = createBrowserRuntime(); hosts.push(host);
    const connection = await host.runtime.restore();
    const workspace = await connection.request<{ id: string }>('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Quota desk' }) });
    const client = createLibraryClient(connection, workspace.id);
    const imported = await client.importFile(new File([original], 'aster.json', { type: 'application/json' }));
    const opened = await client.openCard(imported.card.id), document = structuredClone(opened.revision.document);
    (document.data as Record<string, unknown>).name = 'Retry retained edit';
    const save = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedHead: opened.revision.id, document }) };
    const path = `/api/workspaces/${workspace.id}/cards/${imported.card.id}/revisions`;
    const add = IDBObjectStore.prototype.add;
    const injected = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'revisions') throw new DOMException('Injected full storage', 'QuotaExceededError');
      return add.apply(this, args);
    });
    await expect(connection.request(path, save)).rejects.toMatchObject({ status: 503, code: 'STORAGE_FULL', message: expect.stringContaining('Browser storage is full') });
    expect((await client.openCard(imported.card.id)).revision.id).toBe(opened.revision.id);
    injected.mockRestore();
    expect(await connection.request(path, save)).toMatchObject({ sequence: 2, document: { data: { name: 'Retry retained edit' } } });
    connection.dispose();
  });

  it('refuses actor substitution and SQL-only features without contacting another host', async () => {
    const network = vi.fn<typeof fetch>().mockRejectedValue(new Error('Network is offline')); vi.stubGlobal('fetch', network);
    const host = createBrowserRuntime(); hosts.push(host);
    expect((await host.fetch('/api/workspaces', { headers: { 'x-unity-actor': 'other' } })).status).toBe(401);
    const connection = await host.runtime.restore();
    await expect(connection.request('/api/hub/publications')).rejects.toMatchObject({ status: 503, code: 'UNAVAILABLE' });
    await expect(connection.request('/api/remotes')).rejects.toMatchObject({ status: 503, code: 'UNAVAILABLE' });
    expect((await host.fetch('https://other.invalid/api/workspaces')).status).toBe(400);
    expect(() => createBrowserRuntime({ archive: { origin: 'https://operator:secret@archive.invalid' } })).toThrow('without credentials');
    expect(network).not.toHaveBeenCalled(); connection.dispose();
  });
});
