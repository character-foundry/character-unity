import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createNodeDriver } from '@character-unity/store/node';
import { inspectSchema } from '@character-unity/store/migrations';

interface Digest { hash: string; byteLength: number }
interface BackupBlob extends Digest { key: string }
export interface NodeBackupManifest {
  format: 'unity-node-backup-v1'; createdAt: string; schemaVersion: number;
  database: Digest; blobs: BackupBlob[]; archiveAssetLocators: number;
}
const maxManifestBytes = 16 * 1024 * 1024;
const maxBackupAssets = 100_000;
const invalid = (message: string): never => { throw new Error(`Unity backup: ${message}`); };
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('expected a manifest object');
  return value as Record<string, unknown>;
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid('invalid byte length or count');
  return value as number;
}
function digest(value: unknown): Digest {
  const item = record(value);
  if (typeof item.hash !== 'string' || !/^[a-f0-9]{64}$/.test(item.hash)) return invalid('invalid SHA-256 hash');
  return { hash: item.hash, byteLength: count(item.byteLength) };
}
function key(value: unknown): string {
  if (typeof value !== 'string' || !/^(assets|originals)\/[a-z0-9-]{1,128}$/.test(value)) return invalid('invalid owned blob key/path');
  return value;
}
function parseManifest(value: unknown): NodeBackupManifest {
  const item = record(value);
  if (item.format !== 'unity-node-backup-v1' || typeof item.createdAt !== 'string'
    || !Number.isFinite(Date.parse(item.createdAt)) || !Array.isArray(item.blobs)) return invalid('unsupported or invalid manifest');
  const blobs = item.blobs.map((entry) => ({ key: key(record(entry).key), ...digest(entry) }));
  if (new Set(blobs.map((blob) => blob.key)).size !== blobs.length) return invalid('duplicate owned blob key');
  return { format: item.format, createdAt: item.createdAt, schemaVersion: count(item.schemaVersion),
    database: digest(item.database), blobs, archiveAssetLocators: count(item.archiveAssetLocators) };
}
async function directory(path: string): Promise<string> {
  if (!(await lstat(path)).isDirectory()) return invalid('directory must not be a symlink');
  return realpath(path);
}
async function regular(path: string): Promise<void> {
  if (!(await lstat(path)).isFile()) invalid('source must be a regular file, not a symlink');
}
async function withoutSidecars(path: string): Promise<void> {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { await lstat(`${path}${suffix}`); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    invalid('finished backup contains a SQLite sidecar; a self-contained database without WAL/journal files is required');
  }
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function newDirectory(path: string): Promise<string> {
  // Never merge with or overwrite an existing backup/profile, even an empty one.
  await mkdir(path, { mode: 0o700 });
  const result = await directory(path);
  await syncDirectory(dirname(result));
  return result;
}
/** One owned 64KiB buffer, explicit descriptor ownership, and no whole-file reads. */
async function transfer(source: string, target?: string, expected?: Digest): Promise<Digest> {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const initial = await input.stat();
    if (!initial.isFile()) return invalid('source is not a regular file');
    if (expected && initial.size !== expected.byteLength) return invalid('source length integrity mismatch');
    if (target) output = await open(target, 'wx', 0o600);
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
    let byteLength = 0;
    while (true) {
      const { bytesRead } = await input.read(buffer);
      if (!bytesRead) break;
      byteLength += bytesRead;
      if (byteLength > initial.size) return invalid('source changed during backup');
      hash.update(buffer.subarray(0, bytesRead));
      if (output) await output.writeFile(buffer.subarray(0, bytesRead));
    }
    const final = await input.stat(), result = { hash: hash.digest('hex'), byteLength };
    if (byteLength !== initial.size || final.size !== initial.size || final.mtimeMs !== initial.mtimeMs
      || (expected && (result.hash !== expected.hash || byteLength !== expected.byteLength))) return invalid('source hash/length integrity mismatch');
    await output?.sync();
    return result;
  } finally { try { await output?.close(); } finally { await input.close(); } }
}
async function snapshotInfo(path: string, bundle = false) {
  await regular(path);
  if (bundle) await withoutSidecars(path);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    if (bundle && db.pragma('journal_mode', { simple: true }) !== 'delete') return invalid('finished backup must not require SQLite WAL state');
    const schemaVersion = await inspectSchema(createNodeDriver(db));
    if (schemaVersion < 13) return invalid('requires a known Unity schema with Archive ownership metadata; no migrations are run');
    const foreignKeys = db.pragma('foreign_key_check');
    if (db.pragma('quick_check', { simple: true }) !== 'ok' || !Array.isArray(foreignKeys) || foreignKeys.length) return invalid('database integrity check failed');
    const blobs = db.prepare(`SELECT a.storage_key AS key,a.content_hash AS hash,a.byte_length AS byteLength
      FROM unity_assets a WHERE a.state = 'ready'
      AND NOT EXISTS (SELECT 1 FROM unity_archive_assets x WHERE x.asset_id = a.id)
      AND NOT EXISTS (SELECT 1 FROM unity_asset_retirements r WHERE r.asset_id = a.id)
      ORDER BY a.storage_key LIMIT ${maxBackupAssets + 1}`).all().map((item) => ({ key: key(record(item).key), ...digest(item) }));
    if (blobs.length > maxBackupAssets) return invalid('backup inventory exceeds 100,000 owned assets');
    const row = record(db.prepare('SELECT COUNT(*) AS count FROM unity_archive_assets').get());
    return { schemaVersion, blobs, archiveAssetLocators: count(row.count) };
  } finally { db.close(); }
}
async function blobNamespaces(root: string): Promise<void> {
  for (const name of ['assets', 'originals']) {
    if (await directory(join(root, name)) !== join(root, name)) invalid('blob namespace must not redirect outside its root');
  }
}
async function createBlobDirectory(root: string): Promise<void> {
  await mkdir(root, { mode: 0o700 });
  for (const name of ['assets', 'originals', '.pending']) await mkdir(join(root, name), { mode: 0o700 });
}
async function finalizeManifest(root: string, manifest: NodeBackupManifest): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(manifest));
  if (bytes.length > maxManifestBytes) return invalid('manifest exceeds the supported size');
  for (const name of ['assets', 'originals']) await syncDirectory(join(root, 'blobs', name));
  await syncDirectory(join(root, 'blobs'));
  const temporary = join(root, 'manifest.pending');
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  await syncDirectory(root);
  // Publish only fully written, synced bytes, without replacing any existing name.
  await link(temporary, join(root, 'manifest.json'));
  await syncDirectory(root);
  await unlink(temporary);
  await syncDirectory(root);
}

/** CLI-only: the database contains account/session and chat secrets. No public HTTP backup route. */
export async function backupNodeProfile(options: { database: string; blobDirectory: string; directory: string }): Promise<NodeBackupManifest> {
  const database = resolve(options.database), blobRoot = await directory(options.blobDirectory);
  await regular(database); await blobNamespaces(blobRoot);
  // Validate ownership before creating any output. Never call openNodeStore/migrate.
  await snapshotInfo(database);
  const root = await newDirectory(options.directory), snapshot = join(root, 'unity.db');
  await createBlobDirectory(join(root, 'blobs'));
  const reserved = await open(snapshot, 'wx', 0o600); await reserved.close();
  const db = new Database(database, { readonly: true, fileMustExist: true });
  try { await db.backup(snapshot); } finally { db.close(); }
  // The live source may use WAL. Only the newly owned snapshot is normalized;
  // a completed bundle/restore never depends on undeclared SQLite sidecars.
  const snapshotDatabase = new Database(snapshot, { fileMustExist: true });
  try {
    if (snapshotDatabase.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') return invalid('could not make the snapshot self-contained');
  } finally { snapshotDatabase.close(); }
  await withoutSidecars(snapshot);
  const snapshotHandle = await open(snapshot, constants.O_RDONLY);
  try { await snapshotHandle.sync(); } finally { await snapshotHandle.close(); }
  const info = await snapshotInfo(snapshot, true);
  const manifest: NodeBackupManifest = { format: 'unity-node-backup-v1', createdAt: new Date().toISOString(),
    ...info, database: await transfer(snapshot) };
  if (Buffer.byteLength(JSON.stringify(manifest)) > maxManifestBytes) return invalid('manifest exceeds the supported size');
  for (const blob of info.blobs) await transfer(join(blobRoot, blob.key), join(root, 'blobs', blob.key), blob);
  // Completion marker is last. Missing/corrupt/concurrently swept bytes leave an invalid, inspectable directory.
  await finalizeManifest(root, manifest);
  return manifest;
}

export async function verifyNodeBackup(path: string): Promise<NodeBackupManifest> {
  const root = await directory(path), handle = await open(join(root, 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  let manifest: NodeBackupManifest;
  try {
    const size = await handle.stat();
    if (!size.isFile() || size.size > maxManifestBytes) return invalid('manifest exceeds size limit or is not a regular file');
    const buffer = Buffer.alloc(size.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length !== size.size) return invalid('manifest changed while being read');
    manifest = parseManifest(JSON.parse(buffer.subarray(0, length).toString('utf8')));
  } finally { await handle.close(); }
  await transfer(join(root, 'unity.db'), undefined, manifest.database);
  const info = await snapshotInfo(join(root, 'unity.db'), true);
  if (JSON.stringify(info.blobs) !== JSON.stringify(manifest.blobs) || info.schemaVersion !== manifest.schemaVersion
    || info.archiveAssetLocators !== manifest.archiveAssetLocators) return invalid('manifest does not match database asset inventory');
  const blobRoot = await directory(join(root, 'blobs')); await blobNamespaces(blobRoot);
  for (const blob of manifest.blobs) await transfer(join(blobRoot, blob.key), undefined, blob);
  await withoutSidecars(join(root, 'unity.db'));
  return manifest;
}

/** Restores only to a new isolated profile. Never replaces or activates any current data. */
export async function restoreNodeProfile(options: { directory: string; destination: string }) {
  const manifest = await verifyNodeBackup(options.directory), source = await directory(options.directory);
  const destination = await newDirectory(options.destination), database = join(destination, 'unity.db'), blobDirectory = join(destination, 'blobs');
  await createBlobDirectory(blobDirectory);
  await transfer(join(source, 'unity.db'), database, manifest.database);
  for (const blob of manifest.blobs) await transfer(join(source, 'blobs', blob.key), join(blobDirectory, blob.key), blob);
  for (const name of ['assets', 'originals']) await syncDirectory(join(blobDirectory, name));
  await syncDirectory(blobDirectory); await syncDirectory(destination);
  return { database, blobDirectory, archiveAssetLocators: manifest.archiveAssetLocators };
}
