import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { connect, Index, makeArrowTable } from '@lancedb/lancedb';
import { Bool, Field, FixedSizeList, Float32, Float64, Schema, Utf8 } from 'apache-arrow';
import { createDemoArchive, createFixtureArchive } from '../src/fixture.js';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export async function fixtureInventory(root: string, prefix = ''): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (!prefix && entry.name === '.unity-browser-fixture.json') continue;
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) { entries[`${path}/`] = 'directory'; Object.assign(entries, await fixtureInventory(join(root, entry.name), `${path}/`)); }
    else if (entry.isFile()) entries[path] = digest(await readFile(join(root, entry.name)));
    else throw new Error('Synthetic fixture contains an unexpected file type');
  }
  return entries;
}

/** Creates only a new disposable synthetic copy. The extra 13 cards exercise real
 * FTS paging; the three existing demo originals retain their exact bytes. */
export async function createBrowserSearchFixture(root: string) {
  await mkdir(root); await mkdir(join(root, 'files'));
  const extra = createFixtureArchive('synthetic-search', Array.from({ length: 13 }, (_, index) => {
    const number = String(index + 1).padStart(2, '0'), id = `zlex-${number}`, title = `Lexical ${number}`;
    return { id, title, tags: ['lexical'], source: { provider: 'synthetic', recordId: id, url: null }, assets: [],
      original: { mediaType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: {
        name: title, description: index < 12 ? 'A silver forest beside the north gate.' : 'A silver ocean beside the south gate.', extensions: {},
      } })) } };
  }));
  const db = new Database(join(root, 'archive.sqlite'));
  const cards: { id: string; original: { path: string; mediaType: string }; assets: { id: string; file: null }[] }[] = [];
  const rows: { id: string; searchText: string; source: string; tokenCount: number; hasLorebook: boolean; createdAt: string; lastModified: string }[] = [];
  try {
    db.exec(`CREATE TABLE cards(id TEXT PRIMARY KEY, name TEXT, source TEXT, sourceId TEXT, sourcePath TEXT, fullPath TEXT, sourceUrl TEXT);
      CREATE TABLE card_tags(cardId TEXT, tag TEXT, normalizedTag TEXT);
      CREATE TABLE cached_assets(id TEXT PRIMARY KEY, cardId TEXT, originalUrl TEXT);
      CREATE TABLE optimizer_queue(cardId TEXT);
      CREATE TABLE search_index_queue(cardId TEXT);
      CREATE TRIGGER mutation_sentinel AFTER UPDATE ON cards BEGIN INSERT INTO optimizer_queue VALUES(new.id); INSERT INTO search_index_queue VALUES(new.id); END;`);
    for (const source of [createDemoArchive(), extra]) {
      const status = source.status();
      for (const card of source.list().cards) {
        db.prepare('INSERT INTO cards VALUES (?, ?, ?, ?, NULL, NULL, NULL)').run(card.id, card.title, card.source.provider, card.source.recordId);
        for (const tag of card.tags) db.prepare('INSERT INTO card_tags VALUES (?, ?, ?)').run(card.id, tag, tag.toLowerCase());
        const assets = card.assets.map((asset) => {
          if (asset.availability !== 'unavailable') throw new Error('Browser fixture maps only absent demo assets');
          const id = `${card.id}-${asset.id}`;
          db.prepare('INSERT INTO cached_assets VALUES (?, ?, NULL)').run(id, card.id);
          return { id, file: null };
        });
        const bytes = source.object('originals', status.snapshot, card.original.hash).bytes;
        const path = `files/${card.id}.json`; await writeFile(join(root, path), bytes);
        cards.push({ id: card.id, original: { path, mediaType: 'application/json' }, assets });
        const data = JSON.parse(new TextDecoder().decode(bytes)).data;
        rows.push({ id: card.id, searchText: `${data.name} ${data.description}`, source: card.source.provider, tokenCount: card.id.startsWith('zlex-') ? Number(card.id.slice(5)) * 100 : 0, hasLorebook: card.id === 'zlex-01',
          createdAt: card.id.startsWith('zlex-') ? `2026-01-${String(14 - Number(card.id.slice(5))).padStart(2, '0')}` : '2020-01-01',
          lastModified: card.id.startsWith('zlex-') ? `2026-02-${card.id.slice(5)}` : '2020-01-01' });
      }
    }
  } finally { db.close(); }
  const connection = await connect(join(root, 'search.lance')); let version: number, vectorVersion: number;
  try {
    const table = await connection.createTable('cards', makeArrowTable(rows, { schema: new Schema([...['id', 'searchText', 'source', 'createdAt', 'lastModified'].map((name) => new Field(name, new Utf8(), false)), new Field('tokenCount', new Float64(), false), new Field('hasLorebook', new Bool(), false)]) }));
    try { await table.createIndex('searchText', { config: Index.fts({ withPosition: true, lowercase: true, asciiFolding: true }) }); version = await table.version(); }
    finally { table.close(); }
    const vectors = await connection.createTable('vectors', makeArrowTable(rows.map((row) => ({
      id: row.id, card_id: row.id, section: 'description', matchText: row.searchText,
      vector: row.id === 'zlex-13' ? [0, 1, 0] : row.id.startsWith('zlex-') ? [1, Number(row.id.slice(5)) / 100, 0] : [0, 0, 1],
    })), { schema: new Schema([...['id', 'card_id', 'section', 'matchText'].map((name) => new Field(name, new Utf8(), false)),
      new Field('vector', new FixedSizeList(3, new Field('item', new Float32(), false)), false)]) }));
    try { vectorVersion = await vectors.version(); } finally { vectors.close(); }
  } finally { connection.close(); }
  const manifest = { version: 'unity.archive-copy.v1', archiveId: 'unity-browser-copy',
    database: { path: 'archive.sqlite', sha256: digest(await readFile(join(root, 'archive.sqlite'))) }, cards,
    search: { path: 'search.lance', table: 'cards', version, vector: { table: 'vectors', version: vectorVersion, space: { model: 'unity-synthetic-v1', dimensions: 3, sourceDimensions: 3, queryInstruction: '' } },
      files: Object.entries(await fixtureInventory(join(root, 'search.lance'))).filter(([, sha256]) => sha256 !== 'directory').map(([path, sha256]) => ({ path, sha256 })) } };
  await writeFile(join(root, 'copy-manifest.json'), JSON.stringify(manifest));
  return manifest;
}
