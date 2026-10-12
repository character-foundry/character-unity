import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { connect } from '@lancedb/lancedb';
import type { Table } from '@lancedb/lancedb';
import { ArchiveError, hash, record } from '@character-unity/archive-client/contract';
import { contained, relative, readCopy } from './copy-files.js';
function invalid(message: string): never { throw new ArchiveError('INVALID_INPUT', message); }
function exact(value: Record<string, unknown>, names: string[]) { if (Object.keys(value).some((key) => !names.includes(key))) invalid('Unknown copied search file field'); }
export async function openCopiedLance(root: string, input: Record<string, unknown>) {
  const path = relative(input.path);
  if (!Array.isArray(input.files) || !input.files.length || input.files.length > 4096) invalid('Copied search needs a pinned version and 1–4096 files');
  const files = input.files.map((raw) => { const file = record(raw); exact(file, ['path', 'sha256']); return { path: relative(file.path), sha256: hash(file.sha256) }; });
  if (new Set(files.map((file) => file.path)).size !== files.length) invalid('Duplicate copied search file');
  const directory = await contained(root, path);
  if (!(await lstat(directory)).isDirectory()) invalid('Copied search path must be an existing directory');
  const expected = new Set(files.map((file) => file.path));
  const directories = new Set(files.flatMap((file) => file.path.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'))));
  async function verify() {
    await contained(root, path);
    let count = 0, total = 0;
    async function walk(prefix = '', depth = 0): Promise<void> {
      if (depth > 16) invalid('Copied search directory is nested too deeply');
      for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
        if (++count > 8192) invalid('Copied search inventory exceeds its limit');
        const name = `${prefix}${entry.name}`;
        if (entry.isDirectory() && directories.has(name)) await walk(`${name}/`, depth + 1);
        else if (!entry.isFile() || !expected.has(name)) throw new ArchiveError('SNAPSHOT_CHANGED', 'Copied search inventory changed');
      }
    }
    await walk();
    for (const file of files) {
      const result = await readCopy(directory, file.path, 512 * 1024 * 1024 - total, false);
      total += result.byteLength;
      if (result.hash !== file.sha256) throw new ArchiveError('SNAPSHOT_CHANGED', 'Copied search bytes changed');
    }
  }
  async function withTable<T>(tableName: string, version: number, operation: (table: Table) => Promise<T>): Promise<T> {
    await verify();
    const connection = await connect(directory);
    try {
      if (!(await connection.tableNames()).includes(tableName)) invalid('Copied search table is missing');
      const table = await connection.openTable(tableName);
      try { await table.checkout(version); return await operation(table); }
      finally { table.close(); }
    } finally { connection.close(); await verify(); }
  }
  return { withTable };
}
export type CopiedLance = Awaited<ReturnType<typeof openCopiedLance>>;
