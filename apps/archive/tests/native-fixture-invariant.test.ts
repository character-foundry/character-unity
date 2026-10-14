import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { connect } from '@lancedb/lancedb';
import { captureNativeArchiveInvariant, assertNativeArchiveInvariant } from './native-fixture-invariant.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'unity-archive-invariant-'));
  await mkdir(join(root, 'files')); await mkdir(join(root, 'versions'));
  await writeFile(join(root, 'files', 'original.json'), '{"accepted":"exact bytes"}\n');
  await writeFile(join(root, 'versions', 'retained.json'), '{"historical":true}\n');
  const db = new Database(join(root, 'cards.db'));
  try {
    db.pragma('journal_mode = WAL');
    db.exec("CREATE TABLE cards(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO cards VALUES(1001,'Original'); CREATE TABLE search_index_queue(id INTEGER PRIMARY KEY,cardId TEXT);");
  } finally { db.close(); }
  const connection = await connect(join(root, 'search.lance'));
  try {
    for (const name of ['cards', 'card_vectors']) {
      const table = await connection.createTable(name, [{ id: '1001', text: 'Original indexed description' }]);
      table.close();
    }
  } finally { connection.close(); }
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('fails the shutdown proof when an Archive SQL row changed', async () => {
  const before = await captureNativeArchiveInvariant(root);
  const db = new Database(join(root, 'cards.db'));
  try { db.prepare('UPDATE cards SET name = ? WHERE id = ?').run('Unexpected replacement', 1001); }
  finally { db.close(); }
  await expect(assertNativeArchiveInvariant(root, before)).rejects.toThrow('SQLite');
});

it('allows logical SQLite contents to survive WAL checkpoints and an independent Unity Lance projection', async () => {
  const before = await captureNativeArchiveInvariant(root);
  expect(before.lance.tables.cards?.count).toBe(1);
  expect(before.lance.tables.card_vectors?.count).toBe(1);
  const db = new Database(join(root, 'cards.db'));
  try {
    db.exec("INSERT INTO search_index_queue VALUES(9,'temporary'); DELETE FROM search_index_queue WHERE id = 9;");
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally { db.close(); }
  const connection = await connect(join(root, 'search.lance'));
  try {
    const table = await connection.createTable('unity_library_search_v1', [{ id: 'owned-fork', text: 'Independent library projection' }]);
    await table.add([{ id: 'another-fork', text: 'Another owned projection' }]); table.close();
  } finally { connection.close(); }
  await expect(assertNativeArchiveInvariant(root, before)).resolves.toBeUndefined();
});

it('detects a queue write even when accepted card rows were untouched', async () => {
  const before = await captureNativeArchiveInvariant(root);
  const db = new Database(join(root, 'cards.db'));
  try { db.prepare('INSERT INTO search_index_queue VALUES(?,?)').run(1, '1001'); }
  finally { db.close(); }
  await expect(assertNativeArchiveInvariant(root, before)).rejects.toThrow('SQLite');
});

it.each([['files', 'accepted original files'], ['versions', 'retained version objects']] as const)(
  'detects new or changed bytes under %s', async (directory, reason) => {
    const before = await captureNativeArchiveInvariant(root);
    await writeFile(join(root, directory, directory === 'files' ? 'original.json' : 'retained.json'), 'Unexpected replacement bytes');
    await expect(assertNativeArchiveInvariant(root, before)).rejects.toThrow(reason);
  });

it.each(['cards', 'card_vectors'])('detects mutation of the original %s Lance table', async name => {
  const before = await captureNativeArchiveInvariant(root);
  const connection = await connect(join(root, 'search.lance'));
  try {
    const table = await connection.openTable(name);
    await table.add([{ id: 'unexpected', text: 'Original index mutation' }]); table.close();
  } finally { connection.close(); }
  await expect(assertNativeArchiveInvariant(root, before)).rejects.toThrow('original Lance tables');
});

it('detects changes to an original Lance file even when its query results did not change', async () => {
  const before = await captureNativeArchiveInvariant(root);
  await writeFile(join(root, 'search.lance', 'cards.lance', 'unexpected-rewrite'), 'Unexpected original-table bytes');
  await expect(assertNativeArchiveInvariant(root, before)).rejects.toThrow('original Lance tables');
});
