import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
export type CopyManifest = { version: string; archiveId: string; database: { path: string; sha256: string }; cards: {
  id: string; original: { path: string; mediaType: string }; assets: { id: string; file: null | { path: string; mediaType: string }; binding?: { kind: string; uri: string } }[];
}[] };
export const original = Buffer.from('{"spec":"chara_card_v3","spec_version":"3.0","data":{"name":"Copied Aster","extensions":{"unknown":[null,1]}}}\n');
/** Minimal legacy schema projection plus mutation sentinels, always in a new test directory. */
export async function createCopyFixture(root: string) {
  await mkdir(join(root, 'files'));
  const db = new Database(join(root, 'archive.sqlite'));
  db.exec(`CREATE TABLE cards (id INTEGER PRIMARY KEY, name TEXT, source TEXT, sourceId TEXT, sourcePath TEXT, fullPath TEXT, sourceUrl TEXT);
    CREATE TABLE card_tags (cardId INTEGER, tag TEXT, normalizedTag TEXT, PRIMARY KEY(cardId, normalizedTag));
    CREATE TABLE cached_assets (id INTEGER PRIMARY KEY, cardId INTEGER, originalUrl TEXT, localPath TEXT, assetType TEXT);
    CREATE TABLE search_index_queue (id INTEGER PRIMARY KEY, cardId TEXT, action TEXT);
    CREATE TABLE optimizer_queue (id INTEGER PRIMARY KEY, cardId TEXT);
    CREATE TRIGGER cards_update AFTER UPDATE ON cards BEGIN INSERT INTO optimizer_queue(cardId) VALUES (new.id); INSERT INTO search_index_queue(cardId,action) VALUES(new.id,'upsert'); END;
    INSERT INTO cards VALUES (1,'Aster','chub','remote-aster',NULL,'author/aster','https://example.invalid/aster'), (2,'Birch','ct','remote-birch',NULL,NULL,NULL), (3,'Not selected','chub','remote-other',NULL,NULL,NULL);
    INSERT INTO card_tags VALUES (1,'Forest','forest'), (1,'quiet','quiet'), (2,'Forest','forest');
    INSERT INTO cached_assets VALUES (10,1,'https://example.invalid/missing','/never/follow/database/paths','image'), (11,2,'embedded://note.txt','../../escape','custom');
    INSERT INTO search_index_queue VALUES (1,'untouched','upsert');`);
  db.close();
  await writeFile(join(root, 'files/aster.json'), original); await writeFile(join(root, 'files/birch.json'), Buffer.from(original.toString().replace('Aster', 'Birch')));
  await writeFile(join(root, 'files/note.txt'), 'Exact cached bytes\n');
  const manifest: CopyManifest = { version: 'unity.archive-copy.v1', archiveId: 'copied-test', database: { path: 'archive.sqlite', sha256: digest(await readFile(join(root, 'archive.sqlite'))) }, cards: [
    { id: '2', original: { path: 'files/birch.json', mediaType: 'application/json' }, assets: [{ id: '11', file: { path: 'files/note.txt', mediaType: 'text/plain' }, binding: { kind: 'uri', uri: 'embedded://note.txt' } }] },
    { id: '1', original: { path: 'files/aster.json', mediaType: 'application/json' }, assets: [{ id: '10', file: null }] },
  ] };
  await writeFile(join(root, 'copy-manifest.json'), JSON.stringify(manifest));
  return manifest;
}
