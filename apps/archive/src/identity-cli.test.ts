import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { openNativeArchive } from './native/store.js';

const exec = promisify(execFile);
async function files(root: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) Object.assign(entries, await files(path));
    else entries[path] = (await readFile(path)).toString('hex');
  }
  return entries;
}

it('runs one resumable metadata-only identity batch in a new process and refuses unsafe invocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'unity-identity-cli-'));
  try {
    const archive = await openNativeArchive(root);
    for (const recordId of ['1', '2']) await archive.put({ provider: 'demo', recordId, url: `https://demo.test/${recordId}`, objects: [{ role: 'card',
      bytes: new TextEncoder().encode(JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: { name: `Card ${recordId}` } })), mediaType: 'application/json' }] });
    archive.close();
    const db = new Database(join(root, 'archive.sqlite'));
    try { db.exec('DELETE FROM version_identities'); } finally { db.close(); }
    const before = await files(join(root, 'objects'));
    const args = ['--import', 'tsx', join(import.meta.dirname, 'identity-cli.ts')];
    const options = { cwd: join(import.meta.dirname, '..'), env: { ...process.env, UNITY_ARCHIVE_MODE: 'native', UNITY_ARCHIVE_DATA_DIR: root, UNITY_ARCHIVE_READ_ONLY: '0' } };
    const first = JSON.parse((await exec(process.execPath, [...args, '--limit', '1'], options)).stdout) as { nextAfter: string };
    expect(first).toMatchObject({ processed: 1, unavailable: 0, complete: false, nextAfter: expect.any(String) });
    expect(JSON.parse((await exec(process.execPath, [...args, '--limit', '1', '--after', first.nextAfter], options)).stdout)).toMatchObject({ processed: 1, complete: true, nextAfter: null });
    expect(JSON.parse((await exec(process.execPath, args, options)).stdout)).toMatchObject({ processed: 0, complete: true });
    expect(await files(join(root, 'objects'))).toEqual(before);
    await expect(exec(process.execPath, [...args, '--limit', '101'], options)).rejects.toMatchObject({ code: 1 });
    await expect(exec(process.execPath, args, { ...options, env: { ...options.env, UNITY_ARCHIVE_READ_ONLY: '1' } })).rejects.toMatchObject({ code: 1 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
