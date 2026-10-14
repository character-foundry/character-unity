import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openNodeStore } from '@character-unity/store/node';
import { createNodeBlobStore } from '@character-unity/blob-store/node';
import { backupNodeProfile, restoreNodeProfile, verifyNodeBackup } from './node-backup.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'unity-backup-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const bytes = new TextEncoder().encode('owned bytes, not the Archive corpus');
const hash = createHash('sha256').update(bytes).digest('hex');
const execute = promisify(execFile);
const cli = (...args: string[]) => execute(process.execPath,
  [fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)), fileURLToPath(new URL('./backup-cli.ts', import.meta.url)), ...args], { timeout: 30_000 });
async function fixture() {
  const database = join(root, 'source.db'), blobDirectory = join(root, 'source-blobs');
  const opened = await openNodeStore(database), blobs = await createNodeBlobStore(blobDirectory);
  try {
    const workspace = await opened.store.createWorkspace({ ownerId: 'backup-owner', name: 'Small owned library' });
    const asset = await opened.store.stageAsset({ workspaceId: workspace.id, hash, byteLength: bytes.length, mediaType: 'text/plain' });
    await blobs.put(asset.storageKey, new Blob([bytes]).stream(), { hash, byteLength: bytes.length });
    await opened.store.completeAsset({ workspaceId: workspace.id, assetId: asset.id, measuredHash: hash, measuredByteLength: bytes.length });
    await opened.store.registerArchiveAsset({ workspaceId: workspace.id,
      pin: { archiveId: 'archive', cardId: 'original', versionId: 'immutable-version' }, path: 'portrait',
      hash: 'a'.repeat(64), byteLength: 200_000_000_000, mediaType: 'image/png' });
    return { database, blobDirectory, workspace, asset };
  } finally { opened.close(); }
}

it('backs up a consistent Unity snapshot and owned files, retaining Archive locators without copying their bytes', async () => {
  const source = await fixture(), directory = join(root, 'backup');
  const manifest = await backupNodeProfile({ ...source, directory });
  expect(manifest).toMatchObject({ format: 'unity-node-backup-v1', archiveAssetLocators: 1,
    blobs: [{ key: source.asset.storageKey, hash, byteLength: bytes.length }] });
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  expect((await stat(join(directory, 'unity.db'))).mode & 0o777).toBe(0o600);
  expect(await verifyNodeBackup(directory)).toEqual(manifest);
  const destination = join(root, 'restored');
  const result = await restoreNodeProfile({ directory, destination });
  const db = new Database(result.database, { readonly: true, fileMustExist: true });
  try {
    expect(db.prepare('SELECT name FROM unity_workspaces').get()).toEqual({ name: 'Small owned library' });
    expect(db.prepare('SELECT count(*) AS count FROM unity_archive_assets').get()).toEqual({ count: 1 });
  } finally { db.close(); }
  expect(await readFile(join(result.blobDirectory, source.asset.storageKey))).toEqual(Buffer.from(bytes));
  expect((await stat(join(result.blobDirectory, source.asset.storageKey))).mode & 0o777).toBe(0o600);
});

it('refuses overwritten backup/restore destinations and never initializes a missing source database', async () => {
  const source = await fixture(), directory = join(root, 'backup');
  await backupNodeProfile({ ...source, directory });
  const original = await readFile(join(directory, 'unity.db'));
  await expect(backupNodeProfile({ ...source, directory })).rejects.toThrow(/exist/i);
  await expect(restoreNodeProfile({ directory, destination: directory })).rejects.toThrow(/exist/i);
  expect(await readFile(join(directory, 'unity.db'))).toEqual(original);
  const missing = join(root, 'missing.db');
  await expect(backupNodeProfile({ database: missing, blobDirectory: source.blobDirectory, directory: join(root, 'invalid-backup') })).rejects.toThrow();
  await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('detects corrupted or missing files before restore and does not commit an incomplete backup', async () => {
  const source = await fixture(), directory = join(root, 'backup');
  await backupNodeProfile({ ...source, directory });
  await writeFile(join(directory, 'blobs', source.asset.storageKey), 'tampered');
  await expect(verifyNodeBackup(directory)).rejects.toThrow(/integrity|length|hash/i);
  const destination = join(root, 'rejected-restore');
  await expect(restoreNodeProfile({ directory, destination })).rejects.toThrow();
  await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  await rm(join(source.blobDirectory, source.asset.storageKey));
  const incomplete = join(root, 'incomplete');
  await expect(backupNodeProfile({ ...source, directory: incomplete })).rejects.toThrow();
  await expect(stat(join(incomplete, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects path traversal and symlinked files instead of reading or restoring arbitrary paths', async () => {
  const source = await fixture(), directory = join(root, 'backup');
  const manifest = await backupNodeProfile({ ...source, directory });
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...manifest, blobs: [{ ...manifest.blobs[0], key: '../source.db' }] }));
  await expect(verifyNodeBackup(directory)).rejects.toThrow(/key|path/i);
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  const path = join(directory, 'blobs', source.asset.storageKey);
  await rm(path);
  await symlink(join(source.blobDirectory, source.asset.storageKey), path);
  await expect(verifyNodeBackup(directory)).rejects.toThrow();
});

it('exposes explicit create/verify/new-destination restore commands without secrets in output', async () => {
  const source = await fixture(), directory = join(root, 'backup');
  expect((await cli('--help')).stdout).toContain('Archive bytes are NOT copied');
  await expect(cli('restore', '--input', directory)).rejects.toMatchObject({ code: 1, stdout: '' });
  await expect(cli('create', '--database', source.database, '--blob-dir', source.blobDirectory, '--output', directory, '--output', directory)).rejects.toMatchObject({ code: 1, stdout: '' });
  expect(JSON.parse((await cli('create', '--database', source.database, '--blob-dir', source.blobDirectory, '--output', directory)).stdout))
    .toMatchObject({ status: 'complete', ownedAssets: 1, archiveAssetLocators: 1 });
  expect(JSON.parse((await cli('verify', '--input', directory)).stdout)).toMatchObject({ status: 'verified' });
  expect(JSON.parse((await cli('restore', '--input', directory, '--output', join(root, 'restore'))).stdout))
    .toMatchObject({ status: 'restored-not-activated' });
});

it('refuses an omitted database-owned file even when a manifest is rewritten to hide it', async () => {
  const source = await fixture(), directory = join(root, 'backup');
  const manifest = await backupNodeProfile({ ...source, directory });
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...manifest, blobs: [] }));
  await expect(verifyNodeBackup(directory)).rejects.toThrow(/inventory/);
});

it('refuses active SQLite sidecars instead of verifying WAL state that restore would omit', async () => {
  const source = await fixture(), directory = join(root, 'backup');
  const manifest = await backupNodeProfile({ ...source, directory });
  const db = new Database(join(directory, 'unity.db'));
  try {
    db.pragma('journal_mode = WAL'); db.pragma('wal_autocheckpoint = 0');
    db.prepare("UPDATE unity_workspaces SET name = 'Exists only in WAL'").run();
    // Re-hash the legitimate new main-file header: the untracked WAL still owns
    // changed rows, while restore's declared bundle would copy only unity.db.
    const main = await readFile(join(directory, 'unity.db'));
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...manifest,
      database: { hash: createHash('sha256').update(main).digest('hex'), byteLength: main.length } }));
    await expect(verifyNodeBackup(directory)).rejects.toThrow(/sidecar|WAL/i);
    const destination = join(root, 'reject-wal-restore');
    await expect(restoreNodeProfile({ directory, destination })).rejects.toThrow(/sidecar|WAL/i);
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { db.close(); }
});

it('includes a live source WAL in the self-contained snapshot without changing the source journal mode', async () => {
  const source = await fixture(), directory = join(root, 'backup');
  const db = new Database(source.database);
  try {
    db.pragma('journal_mode = WAL'); db.pragma('wal_autocheckpoint = 0');
    db.prepare("UPDATE unity_workspaces SET name = 'Committed live source'").run();
    await backupNodeProfile({ ...source, directory });
    await verifyNodeBackup(directory);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    const snapshot = new Database(join(directory, 'unity.db'), { readonly: true });
    try {
      expect(snapshot.pragma('journal_mode', { simple: true })).toBe('delete');
      expect(snapshot.prepare('SELECT name FROM unity_workspaces').get()).toEqual({ name: 'Committed live source' });
    } finally { snapshot.close(); }
    await expect(stat(join(directory, 'unity.db-wal'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { db.close(); }
});
