import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { openBrowserStorage } from '@character-unity/browser-storage';
import { createBrowserRuntime } from '../browser/runtime';
import { createSessionRuntime } from './session';
import { createLibraryClient } from './unity';
import { createBrowserMaintenanceClient } from './browser-maintenance';

const day = 86_400_000, start = Date.parse('2026-10-01T00:00:00.000Z');
const actor = 'browser';
const hosts: ReturnType<typeof createBrowserRuntime>[] = [];
const handles: Awaited<ReturnType<typeof openBrowserStorage>>[] = [];
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(start);
});
afterEach(async () => { await Promise.all(hosts.splice(0).map((host) => host.close())); for (const handle of handles.splice(0)) handle.close(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function fixture() {
  const storage = await openBrowserStorage(); handles.push(storage);
  const workspace = await storage.store.createWorkspace({ ownerId: actor, name: 'Library' });
  const bytes = new TextEncoder().encode('an old browser orphan'), hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((value) => value.toString(16).padStart(2, '0')).join('');
  const staged = await storage.store.stageAsset({ workspaceId: workspace.id, hash, byteLength: bytes.byteLength, mediaType: 'text/plain' });
  await storage.blobs.put(staged.storageKey, new Blob([bytes]).stream(), { hash, byteLength: bytes.byteLength });
  await storage.store.completeAsset({ workspaceId: workspace.id, assetId: staged.id, measuredHash: hash, measuredByteLength: bytes.byteLength });
  vi.setSystemTime(start + 2 * day);
  const host = createBrowserRuntime(); hosts.push(host);
  const connection = await host.runtime.restore(), library = createLibraryClient(connection, workspace.id);
  return { storage, workspace, staged, bytes, host, connection, client: createBrowserMaintenanceClient(library) };
}

describe('in-process native browser cleanup transport', () => {
  it('uses the real browser owner client for read-only preview, exact reviewed cleanup, retry and real statistics', async () => {
    const fixtureValue = await fixture(); const { client, storage, staged, bytes, connection, workspace } = fixtureValue;
    const preview = await client.preview(); expect(preview.items).toMatchObject([{ assetId: staged.id }]);
    expect(await storage.blobs.get(staged.storageKey)).not.toBeNull();
    expect(await client.apply(preview)).toEqual({ removed: 1, alreadyRemoved: 0, bytesRemoved: bytes.byteLength });
    expect(await client.apply(preview)).toEqual({ removed: 0, alreadyRemoved: 1, bytesRemoved: 0 });
    expect((await connection.request<{ storage: { localBytes: number } }>(`/api/workspaces/${workspace.id}/statistics`)).storage.localBytes).toBe(0);
    const response = await connection.fetch(`/api/workspaces/${workspace.id}/browser-storage/preview`);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('rejects missing/wrong actors, foreign workspaces, malformed bodies, changed objects and aborted operations', async () => {
    const { client, host, workspace, storage, staged } = await fixture();
    const base = `https://unity-browser.invalid/api/workspaces/${workspace.id}/browser-storage`;
    expect((await host.fetch(`${base}/preview`)).status).toBe(401);
    expect((await host.fetch(`${base}/preview`, { headers: { 'x-unity-actor': 'other' } })).status).toBe(401);
    const foreign = await storage.store.createWorkspace({ ownerId: 'other', name: 'Private' });
    expect((await host.fetch(`https://unity-browser.invalid/api/workspaces/${foreign.id}/browser-storage/preview`, { headers: { 'x-unity-actor': actor } })).status).toBe(403);
    const post = (value: unknown) => host.fetch(`${base}/apply`, { method: 'POST', headers: { 'x-unity-actor': actor, 'content-type': 'application/json' }, body: JSON.stringify(value) });
    expect((await post({ before: 'today', items: [] })).status).toBe(400);
    const preview = await client.preview();
    expect((await post({ ...preview, document: { forged: true } })).status).toBe(400);
    await storage.store.createCard({ workspaceId: workspace.id, authorId: actor, document: { data: { name: 'Now live' } },
      identity: { algorithm: 'fixture', hash: 'a'.repeat(64) }, assets: [{ path: 'portrait', assetId: staged.id }] });
    await expect(client.apply(preview)).rejects.toMatchObject({ status: 409, code: 'ACCESS_CHANGED' });
    expect(await storage.blobs.get(staged.storageKey)).not.toBeNull();
    const controller = new AbortController(); controller.abort(new Error('Workspace changed'));
    await expect(client.preview(controller.signal)).rejects.toThrow('Workspace changed');
  });
  it('captures its connection and workspace instead of consulting a mutable caller binding later', async () => {
    const { connection, workspace, staged } = await fixture();
    const input = { connection, workspaceId: workspace.id }, client = createBrowserMaintenanceClient(input);
    const switched = vi.fn();
    input.connection = { ...connection, async request<T>(): Promise<T> { switched(); throw new Error('The new connection must not be used'); } };
    input.workspaceId = 'another-workspace';
    expect((await client.preview()).items).toMatchObject([{ assetId: staged.id }]);
    expect(switched).not.toHaveBeenCalled();
  });
  it.each(['local', 'hub'])('never sends a cleanup mutation to a %s host', async (profile) => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => String(input) === '/api/client'
      ? Response.json({ profile, capabilities: { browserLLM: profile === 'local' } })
      : Response.json({ actor: { id: actor, uri: 'urn:browser' }, name: 'Browser fixture', expiresAt: 0 }));
    const runtime = createSessionRuntime({ fetch: request }), connection = await runtime.restore(); request.mockClear();
    const client = createBrowserMaintenanceClient(createLibraryClient(connection, 'workspace'));
    expect(client.available).toBe(false); await expect(client.preview()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(request).not.toHaveBeenCalled(); connection.dispose();
  });
});
