import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createNodeDriver } from '@character-unity/store/node';
import { createD1Driver } from '@character-unity/store/d1';
import { createStore } from '@character-unity/store';
import { migrate } from '@character-unity/store/migrations';
import { createNodeBlobStore } from '@character-unity/blob-store/node';
import { createNodeOrphanMaintenance } from '@character-unity/blob-store/node-maintenance';
import type { NodeOrphanCandidate } from '@character-unity/blob-store/node-maintenance';
import { createAssetMaintenanceStore } from '@character-unity/store/asset-maintenance';
import { assetMaintenanceSchema } from '../../../packages/store/src/asset-maintenance-schema.js';
import type { StoreDriver } from '../../../packages/store/src/driver.js';

const execute = promisify(execFile), cli = fileURLToPath(new URL('../dist/assets-cli.js', import.meta.url));
const bytes = new TextEncoder().encode('operator-owned fixture'), hash = createHash('sha256').update(bytes).digest('hex');
const before = '2001-01-01T00:00:00.000Z';
let root: string;
beforeAll(async () => {
  await build({ entryPoints: [fileURLToPath(new URL('./assets-cli.ts', import.meta.url))], outfile: cli,
    bundle: true, platform: 'node', target: 'node24', format: 'esm', external: ['better-sqlite3', 'wrangler'] });
});
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'unity-assets-cli-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const run = (...args: string[]) => execute(process.execPath, [cli, ...args], { timeout: 30000, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });

it('requires explicit matching paths and valid commands without creating a database', async () => {
  const database = join(root, 'missing.db');
  for (const args of [
    ['preview', '--before', before], ['preview', '--database', database, '--before', before],
    ['sweep', '--database', database], ['retire', '--database', database, '--before', before],
    ['preview', '--database', database, '--before', before, '--limit', '101'],
    ['sweep', '--worker-state', root, '--blob-dir', root],
    ['orphan-preview', '--worker-state', root, '--before', before],
    ['orphan-remove', '--database', database, '--blob-dir', root, '--before', before, '--review', 'missing.json'],
  ]) await expect(run(...args)).rejects.toMatchObject({ code: 1, stdout: '' });
  await expect(stat(database)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await run('--help')).stdout).toContain('Retirement is permanent');
});

it('orphan commands require an exact review and stopped storage, remain read-only in SQL and refuse fresh or linked review files', async () => {
  const database = join(root, 'unity.db'), blobDir = join(root, 'blobs'), reviewFile = join(root, 'review.json');
  const raw = new Database(database), driver = createNodeDriver(raw);
  let review: { objects: NodeOrphanCandidate[]; nextAfter: string | null };
  const key = `.pending/${crypto.randomUUID()}`;
  try {
    await migrate(driver); await createNodeBlobStore(blobDir); await writeFile(join(blobDir, key), bytes);
    const maintenance = createAssetMaintenanceStore(driver);
    const collector = await createNodeOrphanMaintenance(blobDir, { tracked: maintenance.trackedStorageKeys, now: () => new Date('2100-01-03T00:00:00.000Z') });
    review = await collector.preview('2100-01-01T00:00:00.000Z');
  } finally { raw.close(); }
  await writeFile(reviewFile, JSON.stringify(review));
  const flags = ['--database', database, '--blob-dir', blobDir, '--before', before];
  const databaseBefore = await stat(database);
  expect(JSON.parse((await run('orphan-preview', ...flags)).stdout)).toEqual({ objects: [], nextAfter: null });
  await expect(run('orphan-remove', ...flags, '--review', reviewFile)).rejects.toMatchObject({ code: 1, stdout: '' });
  await expect(run('orphan-remove', ...flags, '--review', reviewFile, '--storage-stopped')).rejects.toMatchObject({ code: 1 });
  await symlink(reviewFile, join(root, 'linked-review.json'));
  await expect(run('orphan-remove', ...flags, '--review', join(root, 'linked-review.json'), '--storage-stopped')).rejects.toMatchObject({ code: 1, stdout: '' });
  await writeFile(join(root, 'large-review.json'), new Uint8Array(262_145));
  await expect(run('orphan-remove', ...flags, '--review', join(root, 'large-review.json'), '--storage-stopped')).rejects.toMatchObject({ code: 1, stdout: '' });
  expect((await stat(database)).mtimeMs).toBe(databaseBefore.mtimeMs);
  expect(new Uint8Array(await readFile(join(blobDir, key)))).toEqual(bytes);
});

for (const adapter of ['sqlite', 'd1']) describe(`asset operator / ${adapter}`, () => {
  it('previews, retires exact IDs and repeatedly sweeps persisted Node or local Worker bytes across command processes', async () => {
    const database = join(root, 'unity.db'), blobDir = join(root, 'blobs'), state = join(root, 'state');
    let driver: StoreDriver, close: () => void | Promise<void>, put: (key: string) => Promise<void>;
    if (adapter === 'sqlite') {
      const db = new Database(database); driver = createNodeDriver(db); close = () => { db.close(); };
      const blobs = await createNodeBlobStore(blobDir);
      put = async (key) => { await blobs.put(key, new Blob([bytes]).stream(), { hash, byteLength: bytes.length }); };
    } else {
      const { getPlatformProxy } = await import('wrangler');
      const proxy = await getPlatformProxy<{ UNITY_DB: Parameters<typeof createD1Driver>[0]; UNITY_BLOBS: { put(key: string, value: Uint8Array): Promise<unknown> } }>({
        configPath: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)), persist: { path: join(state, 'v3') }, remoteBindings: false,
      });
      driver = createD1Driver(proxy.env.UNITY_DB); close = proxy.dispose;
      put = async (key) => { await proxy.env.UNITY_BLOBS.put(key, bytes); };
    }
    let id: string;
    try {
      await migrate(driver); const store = createStore(driver);
      const workspaceId = (await store.createWorkspace({ ownerId: 'fixture', name: 'Synthetic only' })).id;
      const asset = await store.stageAsset({ workspaceId, hash, byteLength: bytes.length, mediaType: 'application/octet-stream' }); id = asset.id;
      await put(asset.storageKey);
      await store.completeAsset({ workspaceId, assetId: id, measuredHash: hash, measuredByteLength: bytes.length });
      // Only this disposable fixture is backdated. Restore the exact migration trigger
      // in the same transaction; production has no clock override or age-reset command.
      await driver.batch([
        { sql: 'DROP TRIGGER unity_asset_lifetimes_no_update' },
        { sql: "UPDATE unity_asset_lifetimes SET created_at = '2000-01-01T00:00:00.000Z'" },
        { sql: assetMaintenanceSchema.find((sql) => sql.startsWith('CREATE TRIGGER unity_asset_lifetimes_no_update'))! },
      ]);
    } finally { await close(); }
    const flags = adapter === 'sqlite' ? ['--database', database] : ['--worker-state', state];
    const preview = JSON.parse((await run('preview', ...flags, '--before', before)).stdout);
    expect(preview.assets).toMatchObject([{ id }]);
    await expect(run('retire', ...flags, '--before', before, '--id', id, '--id', 'missing')).rejects.toMatchObject({ code: 1 });
    expect(JSON.parse((await run('preview', ...flags, '--before', before)).stdout).assets).toHaveLength(1);
    expect(JSON.parse((await run('retire', ...flags, '--before', before, '--id', id)).stdout)).toEqual({ retired: [id] });
    expect(JSON.parse((await run('preview', ...flags, '--before', before)).stdout).assets).toEqual([]);
    for (let retry = 0; retry < 2; retry++) {
      const swept = JSON.parse((await run('sweep', ...flags, ...(adapter === 'sqlite' ? ['--blob-dir', blobDir] : []))).stdout);
      expect(swept).toEqual({ results: [{ assetId: id, status: 'removed' }], nextAfter: null });
    }
    if (adapter === 'sqlite') expect(await (await createNodeBlobStore(blobDir)).get(`assets/${id}`)).toBeNull();
    else {
      const { getPlatformProxy } = await import('wrangler');
      const proxy = await getPlatformProxy<{ UNITY_BLOBS: { get(key: string): Promise<unknown> } }>({
        configPath: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)), persist: { path: join(state, 'v3') }, remoteBindings: false,
      });
      try { expect(await proxy.env.UNITY_BLOBS.get(`assets/${id}`)).toBeNull(); } finally { await proxy.dispose(); }
    }
  }, 60000);
});
