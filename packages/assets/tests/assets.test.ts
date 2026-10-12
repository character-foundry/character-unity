import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openNodeStore } from '@character-unity/store/node';
import { createNodeBlobStore } from '@character-unity/blob-store/node';
import type { BlobStore } from '@character-unity/blob-store';
import { createAssetService } from '../src/index.js';
import type { AssetService } from '../src/index.js';

const bytes = new TextEncoder().encode('immutable portrait fixture');
const hash = createHash('sha256').update(bytes).digest('hex');
const body = () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
let directory: string;
let database: Awaited<ReturnType<typeof openNodeStore>>;
let blobs: BlobStore;
let service: AssetService;
let workspaceId: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'unity-assets-'));
  database = await openNodeStore(':memory:');
  blobs = await createNodeBlobStore(directory);
  service = createAssetService(database.store, blobs, { uploadTimeoutMs: 50 });
  workspaceId = (await database.store.createWorkspace({ ownerId: 'alice', name: 'Desk' })).id;
});
afterEach(async () => {
  database?.close();
  await rm(directory, { recursive: true, force: true });
});
const stage = () => service.stage({ workspaceId, hash, byteLength: bytes.length, mediaType: 'image/png' });

it('verifies uploaded bytes before making an asset attachable to a revision', async () => {
  const asset = await stage();
  await expect(service.download(workspaceId, asset.id)).rejects.toMatchObject({ code: 'ASSET_NOT_READY' });
  const uploaded = await service.upload(workspaceId, asset.id, body());
  expect(uploaded.state).toBe('ready');
  const object = await service.download(workspaceId, asset.id);
  expect(object.hash).toBe(hash);
  expect(new Uint8Array(await new Response(object.body).arrayBuffer())).toEqual(bytes);
  const card = await database.store.createCard({ workspaceId, authorId: 'alice', document: { name: 'Aster' },
    identity: { algorithm: 'synthetic-test-v1', hash: 'a'.repeat(64) }, assets: [{ path: 'portrait.png', assetId: asset.id }] });
  expect(card.revision.assets).toEqual([{ path: 'portrait.png', assetId: asset.id }]);
});

it('keeps bad uploads staged and clears temporary files', async () => {
  const asset = await stage();
  const wrong = new Uint8Array(bytes.length);
  await expect(service.upload(workspaceId, asset.id, new Blob([wrong]).stream())).rejects.toMatchObject({ code: 'INTEGRITY' });
  expect((await database.store.getAsset(workspaceId, asset.id)).state).toBe('staged');
  expect(await blobs.get(asset.storageKey)).toBeNull();
  expect(await readdir(join(directory, '.pending'))).toEqual([]);
});

it('recovers after bytes commit but database completion fails, without overwriting bytes', async () => {
  let fail = true;
  const retryable = createAssetService({ ...database.store, completeAsset: async (input) => {
    if (fail) throw new Error('injected database failure');
    return database.store.completeAsset(input);
  } }, blobs);
  const asset = await stage();
  await expect(retryable.upload(workspaceId, asset.id, body())).rejects.toThrow('injected database failure');
  expect((await database.store.getAsset(workspaceId, asset.id)).state).toBe('staged');
  await expect(retryable.download(workspaceId, asset.id)).rejects.toMatchObject({ code: 'ASSET_NOT_READY' });
  fail = false;
  expect((await retryable.upload(workspaceId, asset.id, body())).state).toBe('ready');
  expect((await retryable.upload(workspaceId, asset.id, body())).state).toBe('ready');
  const object = await retryable.download(workspaceId, asset.id);
  expect(new Uint8Array(await new Response(object.body).arrayBuffer())).toEqual(bytes);
});

it('does not read or write another workspace’s asset bytes', async () => {
  const asset = await stage();
  const other = (await database.store.createWorkspace({ ownerId: 'bob', name: 'Other' })).id;
  await expect(service.upload(other, asset.id, body())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(service.download(other, asset.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(await blobs.get(asset.storageKey)).toBeNull();
});

it('enforces deadlines on stalled uploads and leaves the staged record retryable', async () => {
  const asset = await stage();
  let cancelled = false;
  const stalled = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.slice(0, 1)); }, cancel() { cancelled = true; } });
  await expect(service.upload(workspaceId, asset.id, stalled)).rejects.toMatchObject({ code: 'ABORTED' });
  expect(cancelled).toBe(true);
  expect((await database.store.getAsset(workspaceId, asset.id)).state).toBe('staged');
  expect(await readdir(join(directory, '.pending'))).toEqual([]);
});

it('enforces its configured limit even for an asset staged through a different caller', async () => {
  const asset = await stage();
  const restricted = createAssetService(database.store, blobs, { maxBytes: 1 });
  await expect(restricted.upload(workspaceId, asset.id, body())).rejects.toMatchObject({ code: 'TOO_LARGE' });
  expect(await blobs.get(asset.storageKey)).toBeNull();
});
