import { mkdtemp, readFile, readdir, rm, writeFile, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { createArchiveClient } from '@character-unity/archive-client';
import { openCopiedArchive } from './copied.js';
import { createCopyFixture, original } from '../tests/copy-fixture.js';
import type { CopyManifest } from '../tests/copy-fixture.js';
import { createArchiveApp } from './app.js';

const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
let root: string;
let manifest: CopyManifest;
async function saveManifest() { await writeFile(join(root, 'copy-manifest.json'), JSON.stringify(manifest)); }
async function inventory(directory = root): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(entries, await inventory(path));
    else entries[path.slice(root.length)] = digest(await readFile(path));
  }
  return entries;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'unity-archive-copy-')); manifest = await createCopyFixture(root);
});
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

it('serves an explicit copied selection through the real client without touching SQL queues or source bytes', async () => {
  const before = await inventory(), source = await openCopiedArchive(root);
  const app = createArchiveApp(source);
  const client = createArchiveClient('http://copy.test', { fetch: async (input, init) => app.fetch(new Request(input, init)) });
  const status = await client.status(); expect(status).toMatchObject({ mode: 'copy', cardCount: 2, archiveId: 'copied-test' });
  const first = await client.list({ q: 'remote', tag: 'Forest', limit: 1 }); expect(first.cards.map((card) => card.id)).toEqual(['1']);
  const second = await client.list({ snapshot: first.snapshot, cursor: first.nextCursor!, q: 'remote', tag: 'Forest', limit: 1 }); expect(second.cards.map((card) => card.id)).toEqual(['2']);
  expect(second.nextCursor).toBeNull();
  expect((await client.list({ provider: 'chub' })).cards.map((card) => card.id)).toEqual(['1']);
  const selection = await client.select(status, ['2', '1']); expect(selection.cards.map((card) => card.id)).toEqual(['1', '2']);
  const one = selection.cards[0]!; expect(one.assets).toEqual([{ id: '10', availability: 'unavailable' }]);
  expect(await client.original(status, one.original)).toEqual(new Uint8Array(original));
  const two = selection.cards[1]!, asset = two.assets[0]!;
  if (asset.availability !== 'available') throw new Error('Expected available asset');
  expect(new TextDecoder().decode(await client.asset(status, asset.object))).toBe('Exact cached bytes\n');
  expect(asset.binding).toEqual({ kind: 'uri', uri: 'embedded://note.txt' });
  await expect(client.card(status, '3')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(client.select(status, ['1', '3'])).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect((await app.request('/api/archive/v1/cards', { method: 'POST' })).status).toBe(404);
  expect(await inventory()).toEqual(before);
  const db = new Database(join(root, 'archive.sqlite'), { readonly: true });
  try {
    expect(db.prepare('SELECT * FROM optimizer_queue').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM search_index_queue').all()).toEqual([{ id: 1, cardId: 'untouched', action: 'upsert' }]);
  } finally { db.close(); }
  expect(await inventory()).toEqual(before);
});

it('keeps metadata snapshots stable and rejects changed or missing copied objects instead of repairing them', async () => {
  const source = await openCopiedArchive(root), status = source.status(), card = source.card(status.snapshot, '1').card;
  await writeFile(join(root, 'files/aster.json'), Buffer.from(original.toString().replace('Aster', 'Other')));
  await expect(source.object('originals', status.snapshot, card.original.hash)).rejects.toMatchObject({ code: 'INTEGRITY' });
  expect(source.card(status.snapshot, '1').card).toEqual(card);
  const reopened = await openCopiedArchive(root); expect(reopened.status().snapshot).not.toBe(status.snapshot);
  expect(() => reopened.select(status.snapshot, ['1'])).toThrow('snapshot');
  await rm(join(root, 'files/aster.json'));
  await expect(source.object('originals', status.snapshot, card.original.hash)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  expect(await readdir(join(root, 'files'))).not.toContain('aster.json');
});

it('requires a matching standalone copied database and rejects WAL or recovery sidecars', async () => {
  manifest.database.sha256 = 'a'.repeat(64); await saveManifest();
  await expect(openCopiedArchive(root)).rejects.toMatchObject({ code: 'INTEGRITY' });
  manifest.database.sha256 = digest(await readFile(join(root, 'archive.sqlite'))); await saveManifest();
  for (const suffix of ['-wal', '-shm', '-journal']) {
    await writeFile(join(root, `archive.sqlite${suffix}`), 'Do not recover'); const before = await inventory();
    await expect(openCopiedArchive(root)).rejects.toThrow('sidecars'); expect(await inventory()).toEqual(before);
    await rm(join(root, `archive.sqlite${suffix}`));
  }
  const wal = new Database(join(root, 'archive.sqlite')); wal.pragma('journal_mode = WAL'); wal.close();
  manifest.database.sha256 = digest(await readFile(join(root, 'archive.sqlite'))); await saveManifest();
  const before = await inventory();
  await expect(openCopiedArchive(root)).rejects.toThrow('rollback-mode'); expect(await inventory()).toEqual(before);
  await rm(join(root, 'copy-manifest.json')); await expect(openCopiedArchive(root)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects escaping paths, symlinks and hard links without changing the source', async () => {
  const entry = manifest.cards[0]!.original;
  for (const path of ['../outside', '/etc/passwd', 'files/../../outside', 'files\\outside', 'files//birch.json']) {
    entry.path = path; await saveManifest(); await expect(openCopiedArchive(root)).rejects.toBeDefined();
  }
  await symlink(join(root, 'files/birch.json'), join(root, 'files/link.json')); entry.path = 'files/link.json'; await saveManifest();
  await expect(openCopiedArchive(root)).rejects.toThrow('symlinks');
  await rm(join(root, 'files/link.json')); await link(join(root, 'files/birch.json'), join(root, 'files/hard.json'));
  entry.path = 'files/hard.json'; await saveManifest(); await expect(openCopiedArchive(root)).rejects.toThrow('hard links');
  expect(await readFile(join(root, 'files/birch.json'), 'utf8')).toContain('Birch');
});

it('rejects duplicate cards, foreign assets and incomplete mappings instead of silently dropping records', async () => {
  const originalManifest = structuredClone(manifest);
  const variants = [
    () => manifest.cards.push(manifest.cards[0]!),
    () => { manifest.cards[0]!.assets = []; },
    () => { manifest.cards[0]!.assets[0]!.id = '10'; },
    () => { manifest.cards[0]!.id = '999'; },
    () => { manifest.cards[0]!.assets[0]!.binding = { kind: 'fetch', uri: 'https://example.invalid' }; },
  ];
  for (const change of variants) {
    manifest = structuredClone(originalManifest); change(); await saveManifest(); const before = await inventory();
    await expect(openCopiedArchive(root)).rejects.toBeDefined(); expect(await inventory()).toEqual(before);
  }
});
