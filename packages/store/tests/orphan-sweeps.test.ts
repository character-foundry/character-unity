import { afterEach, beforeEach, expect, it } from 'vitest';
import { link, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createNodeDriver, openNodeStore } from '../src/node.js';
import { createAssetMaintenanceStore } from '../src/asset-maintenance.js';
import { createNodeBlobStore } from '../../blob-store/src/node.js';
import { createNodeBlobRemover, createNodeOrphanMaintenance, parseNodeOrphanReview } from '../../blob-store/src/node-maintenance.js';

const clock = { now: () => new Date('2100-01-03T00:00:00.000Z') }, before = '2100-01-01T00:00:00.000Z';
const bytes = new TextEncoder().encode('Synthetic crash-left upload');
let root: string, database: Awaited<ReturnType<typeof openNodeStore>>, raw: Database.Database, blobs: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'unity-orphans-')); blobs = join(root, 'blobs');
  database = await openNodeStore(join(root, 'unity.db')); await createNodeBlobStore(blobs);
  raw = new Database(join(root, 'unity.db'));
});

it('never treats a staged, ready or retired SQL-owned key as an orphan, and rechecks claims after preview', async () => {
  const maintenance = createAssetMaintenanceStore(createNodeDriver(raw), clock);
  const collector = await createNodeOrphanMaintenance(blobs, { ...clock, tracked: maintenance.trackedStorageKeys });
  const workspaceId = (await database.store.createWorkspace({ ownerId: 'fixture', name: 'Desk' })).id;
  const assets = [];
  for (let index = 0; index < 3; index++) {
    const asset = await database.store.stageAsset({ workspaceId, hash: 'b'.repeat(64), byteLength: bytes.length, mediaType: 'application/octet-stream' });
    assets.push(asset); await writeFile(join(blobs, asset.storageKey), bytes);
  }
  await database.store.completeAsset({ workspaceId, assetId: assets[1]!.id, measuredHash: assets[1]!.hash, measuredByteLength: bytes.length });
  await maintenance.retire([assets[2]!.id], before);
  expect(await collector.preview(before)).toEqual({ objects: [], nextAfter: null });
  const id = crypto.randomUUID(), key = `assets/${id}`; await writeFile(join(blobs, key), bytes);
  const preview = await collector.preview(before); expect(preview.objects).toMatchObject([{ key }]);
  // Synthetic recovery fixture: another writer acquires this exact storage key.
  raw.prepare("INSERT INTO unity_assets VALUES (?,?,?,?,?,?,'staged')").run(id, workspaceId, 'c'.repeat(64), bytes.length, 'application/octet-stream', key);
  expect(await collector.remove(preview.objects, before, { storageStopped: true })).toEqual({ results: [{ key, status: 'failed' }] });
  expect(new Uint8Array(await readFile(join(blobs, key)))).toEqual(bytes);
});

it('refuses changed review tokens, fresh files, symlinks, hard links, traversal and replaced namespaces', async () => {
  const maintenance = createAssetMaintenanceStore(createNodeDriver(raw), clock);
  const collector = await createNodeOrphanMaintenance(blobs, { ...clock, tracked: maintenance.trackedStorageKeys });
  const key = `.pending/${crypto.randomUUID()}`, file = join(blobs, key); await writeFile(file, bytes);
  const preview = await collector.preview(before); await writeFile(file, new TextEncoder().encode('Changed after preview'));
  expect(await collector.remove(preview.objects, before, { storageStopped: true })).toEqual({ results: [{ key, status: 'failed' }] });
  const fresh = await createNodeOrphanMaintenance(blobs, { tracked: maintenance.trackedStorageKeys });
  const oldCutoff = new Date(Date.now() - 172_800_000).toISOString();
  expect(await fresh.preview(oldCutoff)).toEqual({ objects: [], nextAfter: null });
  expect(await fresh.remove(preview.objects, oldCutoff, { storageStopped: true })).toEqual({ results: [{ key, status: 'failed' }] });
  const target = join(root, 'protected'); await writeFile(target, bytes);
  for (const create of [symlink, link]) await create(target, join(blobs, `.pending/${crypto.randomUUID()}`));
  expect((await collector.preview(before)).objects.map((object) => object.key)).toEqual([key]);
  for (const value of [null, {}, [], { objects: [{ ...preview.objects[0], key: '../protected' }] }, { objects: [{ ...preview.objects[0], byteLength: -1 }] }]) {
    expect(() => parseNodeOrphanReview(value)).toThrow();
  }
  await rename(join(blobs, '.pending'), join(blobs, 'old-pending')); await symlink(root, join(blobs, '.pending'));
  expect(await collector.remove(preview.objects, before, { storageStopped: true })).toEqual({ results: [{ key, status: 'failed' }] });
  await expect(collector.preview(before)).rejects.toMatchObject({ code: 'INVALID_KEY' });
  expect(new Uint8Array(await readFile(target))).toEqual(bytes);
});

it('paginates bounded review names even when a page contains no eligible objects, and retries lost deletion acknowledgments', async () => {
  const maintenance = createAssetMaintenanceStore(createNodeDriver(raw), clock);
  const collector = await createNodeOrphanMaintenance(blobs, { ...clock, tracked: maintenance.trackedStorageKeys });
  const keys = [`.pending/${crypto.randomUUID()}`, `.pending/${crypto.randomUUID()}`, `assets/${crypto.randomUUID()}`].sort();
  for (const key of keys) await writeFile(join(blobs, key), bytes);
  await link(join(blobs, keys[0]!), join(root, 'protected-hard-link'));
  const first = await collector.preview(before, { limit: 1 }); expect(first.objects).toEqual([]);
  const second = await collector.preview(before, { afterKey: first.nextAfter!, limit: 1 }); expect(second.objects).toMatchObject([{ key: keys[1] }]);
  const last = await collector.preview(before, { afterKey: second.nextAfter!, limit: 1 }); expect(last.objects).toMatchObject([{ key: keys[2] }]); expect(last.nextAfter).toBeNull();
  const review = parseNodeOrphanReview(JSON.parse(JSON.stringify(second)));
  expect(await collector.remove(review, before, { storageStopped: true })).toEqual({ results: [{ key: keys[1], status: 'removed' }] });
  expect(await collector.remove(review, before, { storageStopped: true })).toEqual({ results: [{ key: keys[1], status: 'removed' }] });
  for (const page of [{ limit: 101 }, { afterKey: '../outside' }]) await expect(collector.preview(before, page)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  for (const bad of ['bad', '2100-01-02T23:59:59.000Z']) await expect(collector.preview(bad)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

it('revalidates a retired-object remover when a storage namespace is replaced after opening', async () => {
  const remover = await createNodeBlobRemover(blobs), target = join(root, 'assets');
  await rename(join(blobs, 'assets'), target); await symlink(target, join(blobs, 'assets'));
  await writeFile(join(target, 'protected'), bytes);
  await expect(remover.removeRetired('assets/protected')).rejects.toMatchObject({ code: 'INVALID_KEY' });
  expect(new Uint8Array(await readFile(join(target, 'protected')))).toEqual(bytes);
});
afterEach(async () => { raw?.close(); database?.close(); await rm(root, { recursive: true, force: true }); });

it('only removes exact reviewed old pending and SQL-untracked UUID objects while the owning store is stopped', async () => {
  const maintenance = createAssetMaintenanceStore(createNodeDriver(raw), clock);
  const collector = await createNodeOrphanMaintenance(blobs, { ...clock, tracked: maintenance.trackedStorageKeys });
  const pending = `.pending/${crypto.randomUUID()}`, untracked = `assets/${crypto.randomUUID()}`;
  for (const key of [pending, untracked]) await writeFile(join(blobs, key), bytes);
  await writeFile(join(blobs, 'assets/not-a-unity-id'), bytes);
  await writeFile(join(blobs, 'originals/untouched'), bytes);
  const preview = await collector.preview(before);
  expect(preview.objects.map((object) => object.key)).toEqual([pending, untracked]);
  await expect(collector.remove(preview.objects, before, { storageStopped: false })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(new Uint8Array(await readFile(join(blobs, pending)))).toEqual(bytes);
  expect(await collector.remove(preview.objects, before, { storageStopped: true })).toEqual({
    results: [{ key: pending, status: 'removed' }, { key: untracked, status: 'removed' }],
  });
  for (const key of ['assets/not-a-unity-id', 'originals/untouched']) expect(new Uint8Array(await readFile(join(blobs, key)))).toEqual(bytes);
});
