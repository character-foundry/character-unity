import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, link, symlink, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createNodeBlobStore } from '../../blob-store/src/node.js';
import { byteStream } from '../../blob-store/src/verify.js';
import { createNodeBlobRemover } from '../../blob-store/src/node-maintenance.js';
import { createR2BlobRemover } from '../../blob-store/src/maintenance.js';
import type { BlobRemover } from '../../blob-store/src/maintenance.js';
import type { BlobStore } from '../../blob-store/src/index.js';
import { openNodeStore, createNodeDriver } from '../src/node.js';
import { createAssetMaintenanceStore } from '../src/asset-maintenance.js';
import { createAssetService } from '../../assets/src/index.js';
import { sweepRetiredAssets } from '../../assets/src/maintenance.js';
import Database from 'better-sqlite3';

const bytes = new TextEncoder().encode('Owned fixture bytes'), hash = createHash('sha256').update(bytes).digest('hex');
const clock = { now: () => new Date('2100-01-03T00:00:00.000Z') }, cutoff = '2100-01-01T00:00:00.000Z';
const body = () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
for (const adapter of ['node', 'r2']) describe(`asset sweeps / ${adapter}`, () => {
  let root: string, blobs: BlobStore, remover: BlobRemover, database: Awaited<ReturnType<typeof openNodeStore>>;
  let raw: Database.Database, maintenance: ReturnType<typeof createAssetMaintenanceStore>, workspaceId: string, dispose: (() => Promise<void>) | undefined;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'unity-sweep-'));
    database = await openNodeStore(join(root, 'unity.db')); raw = new Database(join(root, 'unity.db'));
    maintenance = createAssetMaintenanceStore(createNodeDriver(raw), clock);
    workspaceId = (await database.store.createWorkspace({ ownerId: 'alice', name: 'Desk' })).id;
    if (adapter === 'node') {
      blobs = await createNodeBlobStore(join(root, 'blobs')); remover = await createNodeBlobRemover(join(root, 'blobs'));
    } else {
      const mf = new Miniflare(convertV4MiniflareOptions({ port: 0, modules: true,
        script: 'export default { fetch() { return new Response("test"); } };', compatibilityDate: '2026-10-11', r2Buckets: ['BUCKET'] }));
      dispose = () => mf.dispose(); const bucket = await mf.getR2Bucket('BUCKET');
      remover = createR2BlobRemover(bucket);
      // Test transport writes tiny synthetic bytes directly to actual local R2.
      // Streaming integrity of the production R2 writer has its own blob contract suite.
      blobs = { async put(key, stream, expected) { await bucket.put(key, await new Response(stream).arrayBuffer()); return expected; },
        async get(key) { const value = await bucket.get(key); return value ? { body: byteStream(value.body.getReader()), byteLength: value.size } : null; } };
    }
  });
  afterEach(async () => { await dispose?.(); dispose = undefined; raw?.close(); database?.close(); await rm(root, { recursive: true, force: true }); });
  const stage = () => database.store.stageAsset({ workspaceId, hash, byteLength: bytes.length, mediaType: 'application/octet-stream' });

  it('deletes only selected retired objects, retries missing bytes and lost delete acknowledgments, and keeps referenced originals', async () => {
    const service = createAssetService(database.store, blobs), values = [await stage(), await stage(), await stage()];
    for (const asset of values) await service.upload(workspaceId, asset.id, body());
    const [retired, original, unselected] = values;
    await database.store.createCard({ workspaceId, authorId: 'alice', document: {}, identity: { algorithm: 'test', hash }, source: { assetId: original!.id, provenance: {} } });
    const missing = await stage(); await maintenance.retire([retired!.id, missing.id], cutoff);
    const lost: BlobRemover = { async removeRetired(key) { await remover.removeRetired(key); if (key === retired!.storageKey) throw new Error('ack lost'); } };
    expect((await sweepRetiredAssets(maintenance, lost)).results).toContainEqual({ assetId: retired!.id, status: 'failed' });
    expect(await blobs.get(retired!.storageKey)).toBeNull();
    const first = await sweepRetiredAssets(maintenance, remover, { limit: 1 });
    const last = await sweepRetiredAssets(maintenance, remover, { afterId: first.nextAfter!, limit: 1 });
    expect([...first.results, ...last.results].map((value) => value.status)).toEqual(['removed', 'removed']);
    expect(await maintenance.retired()).toHaveLength(2);
    for (const kept of [original!, unselected!]) {
      const object = await blobs.get(kept.storageKey); expect(object).not.toBeNull();
      expect(new Uint8Array(await new Response(object!.body).arrayBuffer())).toEqual(bytes);
    }
    for (const key of ['originals/protected', '../unity.db', 'assets/../../unity.db', '.pending/file']) await expect(remover.removeRetired(key)).rejects.toMatchObject({ code: 'INVALID_KEY' });
  });

  it('fences a delayed upload after retirement and removes reappearing unreachable bytes on a later sweep', async () => {
    const asset = await stage();
    const started = deferred(), release = deferred();
    const delayed: BlobStore = { get: (key) => blobs.get(key), async put(...args) { started.resolve(); await release.promise; return blobs.put(...args); } };
    const uploading = createAssetService(database.store, delayed).upload(workspaceId, asset.id, body());
    const rejected = expect(uploading).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await started.promise; await maintenance.retire([asset.id], cutoff);
    expect((await sweepRetiredAssets(maintenance, remover)).results).toEqual([{ assetId: asset.id, status: 'removed' }]);
    release.resolve(); await rejected;
    const reappeared = await blobs.get(asset.storageKey); expect(reappeared).not.toBeNull(); await reappeared!.body.cancel();
    await expect(createAssetService(database.store, blobs).download(workspaceId, asset.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await sweepRetiredAssets(maintenance, remover)).results).toEqual([{ assetId: asset.id, status: 'removed' }]);
    expect(await blobs.get(asset.storageKey)).toBeNull();
  });

  it('continues past a failed deletion and retries the permanent ledger without a completion flag', async () => {
    const assets = [await stage(), await stage()];
    for (const asset of assets) await blobs.put(asset.storageKey, body(), asset);
    await maintenance.retire(assets.map((asset) => asset.id), cutoff);
    const failed: BlobRemover = { async removeRetired(key) { if (key === assets[0]!.storageKey) throw new Error('unavailable'); await remover.removeRetired(key); } };
    expect((await sweepRetiredAssets(maintenance, failed)).results).toContainEqual({ assetId: assets[0]!.id, status: 'failed' });
    const kept = await blobs.get(assets[0]!.storageKey); expect(kept).not.toBeNull(); await kept!.body.cancel();
    expect(await blobs.get(assets[1]!.storageKey)).toBeNull();
    expect((await sweepRetiredAssets(maintenance, remover)).results.every((value) => value.status === 'removed')).toBe(true);
    expect(await blobs.get(assets[0]!.storageKey)).toBeNull();
  });
});

it('filesystem cleanup refuses linked roots, symlinks and hard links without touching their targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'unity-sweep-links-'));
  try {
    await createNodeBlobStore(join(root, 'blobs')); const remover = await createNodeBlobRemover(join(root, 'blobs'));
    const target = join(root, 'original'); await writeFile(target, bytes);
    await symlink(target, join(root, 'blobs/assets/symlink')); await link(target, join(root, 'blobs/assets/hardlink'));
    for (const key of ['assets/symlink', 'assets/hardlink']) await expect(remover.removeRetired(key)).rejects.toMatchObject({ code: 'INVALID_KEY' });
    expect(new Uint8Array(await readFile(target))).toEqual(bytes);
    await symlink(join(root, 'blobs'), join(root, 'linked-root'));
    await expect(createNodeBlobRemover(join(root, 'linked-root'))).rejects.toMatchObject({ code: 'INVALID_KEY' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
