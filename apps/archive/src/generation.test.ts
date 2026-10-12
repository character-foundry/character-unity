import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { connect } from '@lancedb/lancedb';
import { buildLexicalGeneration, buildSemanticGeneration } from './generation.js';
import { createDocumentEmbedder, createQueryEmbedder } from './embeddings.js';
import { prepareVectorGeneration } from './vector-generation.js';
import { buildSearchDocument, scoringDate, searchSourceColumns } from './search-document.js';
import { openCopiedArchive } from './copied.js';
import { fixtureInventory } from '../tests/browser-search-fixture.js';

const exec = promisify(execFile), asOf = '2026-10-12T00:00:00.000Z';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const space = { model: 'synthetic-generation', dimensions: 2, sourceDimensions: 3, queryInstruction: 'Find the matching character' };
function row(values: Record<string, unknown>) { return { ...Object.fromEntries(searchSourceColumns.map((name) => [name, null])), ...values }; }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'unity-generation-')); roots.push(root);
  const copy = join(root, 'input'); await mkdir(copy); await mkdir(join(copy, 'files'));
  const db = new Database(join(copy, 'archive.sqlite'));
  const rows = [row({ id: '1', name: 'North gate', description: 'A silver forest.', tagline: 'Lantern keeper', author: 'Mira', source: 'chub', sourceId: 'first', sourcePath: 'remote/path', topics: ' Fantasy, MAGIC ', hasLorebook: 1, tokenCount: 250, starCount: 6, n_favorites: 2, nChats: 4, nMessages: 30, rating: 4, ratingCount: 5, createdAt: '2026-10-10 00:00:00', lastModified: '2026-10-11T00:00:00Z' }),
    row({ id: '2', name: 'Sea captain', description: 'A silver ocean.', source: 'ct', sourceId: 'second', topics: 'Ocean', tokenCount: 800, starCount: 10, createdAt: '2026-09-22', lastModified: '2026-09-22' })];
  try {
    // Deliberately use dynamic SQLite types, as in migrated legacy databases.
    db.exec(`CREATE TABLE cards (${searchSourceColumns.map((name) => `"${name}"`).join(', ')}, sourceUrl TEXT);
      CREATE TABLE card_tags(cardId TEXT, tag TEXT, normalizedTag TEXT);
      CREATE TABLE cached_assets(id TEXT, cardId TEXT, originalUrl TEXT);
      CREATE TABLE search_index_queue(cardId TEXT); INSERT INTO search_index_queue VALUES ('untouched');
      CREATE TABLE optimizer_queue(cardId TEXT); INSERT INTO optimizer_queue VALUES ('untouched');
      CREATE TRIGGER mutation_sentinel AFTER UPDATE ON cards BEGIN INSERT INTO search_index_queue VALUES(new.id); END;
      INSERT INTO card_tags VALUES ('1', 'metadata-tag', 'metadata-tag');
      INSERT INTO cached_assets VALUES ('asset-1', '1', 'https://invalid.example/never-fetch');
      INSERT INTO cached_assets VALUES ('asset-2', '2', 'https://invalid.example/missing');`);
    const insert = db.prepare(`INSERT INTO cards (${searchSourceColumns.map((name) => `"${name}"`).join(', ')}) VALUES (${searchSourceColumns.map(() => '?').join(', ')})`);
    for (const item of rows) insert.run(...searchSourceColumns.map((name) => item[name]));
  } finally { db.close(); }
  await writeFile(join(copy, 'files', 'original'), '{ "accepted": "exact bytes, not the indexed metadata" }\n');
  await writeFile(join(copy, 'files', 'asset'), 'exact cached image bytes');
  const manifest = { version: 'unity.archive-copy.v1', archiveId: 'generation-test', database: { path: 'archive.sqlite', sha256: digest(await readFile(join(copy, 'archive.sqlite'))) }, cards: [
    { id: '2', original: { path: 'files/original', mediaType: 'application/json' }, assets: [{ id: 'asset-2', file: null }] },
    { id: '1', original: { path: 'files/original', mediaType: 'application/json' }, assets: [{ id: 'asset-1', file: { path: 'files/asset', mediaType: 'image/png' } }] },
  ] };
  await writeFile(join(copy, 'copy-manifest.json'), JSON.stringify(manifest));
  return { root, copy, manifest, rows };
}
async function updateDatabase(copy: string, change: (db: Database.Database) => void) {
  const db = new Database(join(copy, 'archive.sqlite')); try { change(db); } finally { db.close(); }
  const manifest = JSON.parse(await readFile(join(copy, 'copy-manifest.json'), 'utf8'));
  manifest.database.sha256 = digest(await readFile(join(copy, 'archive.sqlite')));
  await writeFile(join(copy, 'copy-manifest.json'), JSON.stringify(manifest));
}

describe('explicit lexical generation', () => {
  it('projects legacy text, flags, topics, aliases and ranking with an explicit clock', () => {
    const projected = buildSearchDocument(row({ id: 7n, name: 'Keeper', description: 'Silver forest', tagline: 'At night', author: 'Mira', topics: ' Fantasy, MAGIC ,,', sourcePath: 'remote/path', favorited: 1n, hasLorebook: 1n, tokenCount: 250n,
      starCount: 6n, n_favorites: 2n, nChats: 4n, nMessages: 30n, rating: 4, ratingCount: 5n, createdAt: '2026-10-10 00:00:00', lastModified: '2026-10-11T00:00:00Z' }), scoringDate(asOf));
    expect(projected).toMatchObject({ id: '7', source: 'chub', sourceId: '7', fullPath: 'remote/path', sourceSpecific: 'remote/path', type: 'character', language: 'unknown', visibility: 'unknown',
      tags: ['fantasy', 'magic'], topics: ['fantasy', 'magic'], platform_summary: 'Silver forest', favorited: 1, hasLorebook: true, hasGallery: false, tokenCount: 250, token_count: 250, favorites: 2,
      scoreComposite: 10, scoreVelocity: 5, engagementScore: 42, engagementVelocity: 42,
      created: '2026-10-10 00:00:00', added: '2026-10-10 00:00:00', updated: '2026-10-11T00:00:00Z' });
    expect(projected.searchText).toBe('Keeper\nAt night\nSilver forest\nSilver forest\nMira\nfantasy magic\nchub\nremote/path\nremote/path');
    for (const [days, bonus] of [[3, 25], [4, 15], [7, 15], [8, 8], [14, 8], [15, 0]]) {
      const date = new Date(scoringDate(asOf) - days! * 86_400_000).toISOString();
      expect(buildSearchDocument(row({ id: 'x', createdAt: date }), scoringDate(asOf)).engagementScore).toBe(bonus);
    }
    for (const date of ['bad', '2026-10-12', '2026-02-30T00:00:00.000Z']) expect(() => scoringDate(date)).toThrow();
    for (const date of ['Oct 12 2026', '2026-02-30', '2026-10-12T24:00:00']) expect(() => buildSearchDocument(row({ id: 'x', createdAt: date }), scoringDate(asOf))).toThrow();
    for (const value of [Infinity, 'oops', 9007199254740993n]) expect(() => buildSearchDocument(row({ id: 'x', tokenCount: value }), scoringDate(asOf))).toThrow();
  });

  it('publishes a reopenable exact copy with native FTS, filters, sorts and unchanged input queues/objects', async () => {
    const { root, copy } = await fixture(), before = await fixtureInventory(copy), output = join(root, 'generation');
    const report = await buildLexicalGeneration({ copy, output, asOf });
    expect(report).toMatchObject({ state: 'ready', kind: 'lexical', cardCount: 2, vectorsGenerated: false, replacedSearch: false, asOf });
    expect((await stat(output)).mode & 0o777).toBe(0o700);
    expect(await fixtureInventory(copy)).toEqual(before);
    expect(await readFile(join(output, 'archive.sqlite'))).toEqual(await readFile(join(copy, 'archive.sqlite')));
    const input = await openCopiedArchive(copy), result = await openCopiedArchive(output);
    expect(result.status().snapshot).not.toBe(input.status().snapshot);
    expect(result.status().sorts).toHaveLength(22); expect(result.status()).not.toHaveProperty('semantic');
    expect((await result.search({ text: '"silver forest"', filter: 'tags = magic AND hasLorebook = true' })).cards.map((card) => card.id)).toEqual(['1']);
    expect((await result.search({ text: 'silver', sort: 'trending_desc' })).cards.map((card) => card.id)).toEqual(['1', '2']);
    expect((await result.search({ mode: 'browse', text: '', sort: 'tokens_desc' })).cards.map((card) => card.id)).toEqual(['2', '1']);
    // Native topic filters come from cards.topics; metadata tags retain card_tags.
    expect((await result.search({ text: 'silver', tag: 'metadata-tag' })).cards.map((card) => card.id)).toEqual(['1']);
    const page = await result.search({ text: 'silver', sort: 'id', limit: 1 });
    const reopened = await openCopiedArchive(output);
    expect((await reopened.search({ text: 'silver', sort: 'id', snapshot: page.snapshot, cursor: page.nextCursor!, limit: 1 })).cards.map((card) => card.id)).toEqual(['2']);
    for (const card of result.list().cards) {
      expect(card).toEqual(input.card(input.status().snapshot, card.id).card);
      expect((await result.object('originals', result.status().snapshot, card.original.hash)).bytes).toEqual(new Uint8Array(await readFile(join(copy, 'files', 'original'))));
      for (const asset of card.assets) if (asset.availability === 'available') expect((await result.object('assets', result.status().snapshot, asset.object.hash)).bytes).toEqual(new Uint8Array(await readFile(join(copy, 'files', 'asset'))));
    }
    const second = await buildLexicalGeneration({ copy: output, output: join(root, 'second'), asOf });
    expect(second.rowSha256).toBe(report.rowSha256); expect(second.replacedSearch).toBe(true);
    const later = await buildLexicalGeneration({ copy, output: join(root, 'later'), asOf: '2026-10-20T00:00:00.000Z' });
    expect(later.rowSha256).not.toBe(report.rowSha256);
    const conn = await connect(join(output, 'search.lance'));
    try {
      const table = await conn.openTable('cards');
      try { expect((await table.query().where("id = '1'").select(['scoreComposite', 'scoreVelocity', 'engagementScore']).toArray())[0]).toMatchObject({ scoreComposite: 10, scoreVelocity: 5, engagementScore: 42 }); }
      finally { table.close(); }
    } finally { conn.close(); }
    expect(await fixtureInventory(copy)).toEqual(before);
  }, 30000);

  it('rejects existing, nested, symlinked, incomplete and malformed inputs without modifying them', async () => {
    const { root, copy } = await fixture(), before = await fixtureInventory(copy), output = join(root, 'existing');
    await mkdir(output); await writeFile(join(output, 'sentinel'), 'keep');
    for (const target of [output, copy, join(copy, 'nested'), root]) await expect(buildLexicalGeneration({ copy, output: target, asOf })).rejects.toThrow();
    await symlink(root, join(root, 'alias'));
    await expect(buildLexicalGeneration({ copy, output: join(root, 'alias', 'new'), asOf })).rejects.toThrow();
    await expect(buildLexicalGeneration({ copy, output: join(root, 'bad-date'), asOf: 'now' })).rejects.toThrow();
    expect(await readFile(join(output, 'sentinel'), 'utf8')).toBe('keep');
    expect(await fixtureInventory(copy)).toEqual(before);
    await updateDatabase(copy, (db) => db.exec('ALTER TABLE cards DROP COLUMN description'));
    await expect(buildLexicalGeneration({ copy, output: join(root, 'missing-column'), asOf })).rejects.toThrow('description');
    await expect(stat(join(root, 'missing-column'))).rejects.toHaveProperty('code', 'ENOENT');
    await writeFile(join(copy, 'archive.sqlite-wal'), 'do not recover');
    await expect(buildLexicalGeneration({ copy, output: join(root, 'wal'), asOf })).rejects.toThrow('sidecars');
  });

  it('leaves no published manifest on cancellation and refuses to reuse an incomplete directory', async () => {
    const { root, copy } = await fixture(), before = await fixtureInventory(copy), output = join(root, 'cancelled');
    const controller = new AbortController();
    // Interrupt at the publication boundary after the real native build/verify.
    vi.spyOn(controller.signal, 'throwIfAborted').mockImplementation(() => {
      if (existsSync(join(output, 'copy-manifest.pending.json'))) controller.abort();
      AbortSignal.prototype.throwIfAborted.call(controller.signal);
    });
    await expect(buildLexicalGeneration({ copy, output, asOf }, controller.signal)).rejects.toThrow();
    expect(JSON.parse(await readFile(join(output, 'generation.json'), 'utf8')).state).toBe('building');
    await expect(stat(join(output, 'copy-manifest.json'))).rejects.toHaveProperty('code', 'ENOENT');
    await expect(openCopiedArchive(output)).rejects.toThrow();
    await expect(buildLexicalGeneration({ copy, output, asOf })).rejects.toThrow('already exists');
    expect(await fixtureInventory(copy)).toEqual(before);
  });

  it('refuses to publish when a mapped original changes during a build', async () => {
    const { root, copy } = await fixture(), output = join(root, 'changed');
    const controller = new AbortController(); let changed = false;
    vi.spyOn(controller.signal, 'throwIfAborted').mockImplementation(() => {
      if (!changed && existsSync(join(output, 'generation.json'))) {
        changed = true; writeFileSync(join(copy, 'files', 'original'), 'changed by another writer');
      }
      AbortSignal.prototype.throwIfAborted.call(controller.signal);
    });
    await expect(buildLexicalGeneration({ copy, output, asOf }, controller.signal)).rejects.toThrow('changed');
    await expect(stat(join(output, 'copy-manifest.json'))).rejects.toHaveProperty('code', 'ENOENT');
    expect(changed).toBe(true);
  });

  it('runs the operator command in a new process and rejects duplicate flags', async () => {
    const { root, copy } = await fixture(), output = join(root, 'cli');
    const cli = join(import.meta.dirname, 'generation-cli.ts');
    const result = await exec(process.execPath, ['--import', 'tsx', cli, 'lexical', '--copy', copy, '--output', output, '--as-of', asOf], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, TZ: 'UTC' } });
    expect(JSON.parse(result.stdout)).toMatchObject({ state: 'ready', output, cardCount: 2 });
    const another = await exec(process.execPath, ['--import', 'tsx', cli, 'lexical', '--copy', copy, '--output', join(root, 'another-timezone'), '--as-of', asOf], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, TZ: 'America/New_York' } });
    expect(JSON.parse(another.stdout).rowSha256).toBe(JSON.parse(result.stdout).rowSha256);
    const source = await openCopiedArchive(output);
    expect((await source.search({ text: 'forest' })).cards.map((card) => card.id)).toEqual(['1']);
    await expect(exec(process.execPath, ['--import', 'tsx', cli, 'lexical', '--copy', copy, '--copy', copy], { cwd: join(import.meta.dirname, '..') })).rejects.toMatchObject({ code: 1 });
  }, 30000);

  it('plans bounded legacy batches and explicitly records text/excerpt truncation before model calls', async () => {
    const { root } = await fixture(), texts: string[][] = [];
    const embedder = { space, async embed(input: readonly string[]) { texts.push([...input]); return input.map(() => [1, 0]); } };
    const plan = prepareVectorGeneration([{ id: '1', searchText: `${'a'.repeat(2047)}😀 tail` }, { id: '2', searchText: 'second card' }, { id: '3', searchText: '   ' }], { embedder, tokenBudget: 512, batchSize: 32 });
    expect(plan.summary).toMatchObject({ batches: 2, truncatedCards: 1, excerptTruncatedCards: 0, indexedCards: 2, skippedNoText: 1 });
    expect(texts).toEqual([]);
    const connection = await connect(join(root, 'plan.lance'));
    try { await plan.write(connection); } finally { connection.close(); }
    expect(texts).toEqual([[`${'a'.repeat(2047)}�`], ['second card']]);
    const excerpt = prepareVectorGeneration([{ id: 'x', searchText: 'x'.repeat(9000) }], { embedder });
    expect(excerpt.summary).toMatchObject({ truncatedCards: 0, excerptTruncatedCards: 1, inputCharacters: 9000 });
    expect(() => prepareVectorGeneration(Array.from({ length: 1001 }, (_, id) => ({ id: String(id), searchText: 'x' })), { embedder: { ...embedder, space: { ...space, dimensions: 4096, sourceDimensions: 4096 } } })).toThrow('limits');
    for (const options of [{ batchSize: 129 }, { batchSize: 0 }, { tokenBudget: 511 }, { tokenBudget: 24001 }]) expect(() => prepareVectorGeneration([{ id: 'x', searchText: 'x' }], { embedder, ...options })).toThrow();
  });

  it('builds matching lexical/vector generations with exact originals and real semantic/hybrid reads after reopen', async () => {
    const { root, copy } = await fixture(), before = await fixtureInventory(copy), output = join(root, 'semantic');
    const sent: string[][] = [];
    const config = { provider: 'openai', baseUrl: 'http://127.0.0.1:1', space };
    const document = createDocumentEmbedder(config, 'synthetic-key', async (_url, init) => {
      const texts = JSON.parse(String(init?.body)).input as string[]; sent.push(texts);
      return Response.json({ data: texts.map((text, index) => ({ index, embedding: text.includes('ocean') ? [0, 4, 12] : [3, 0, 12] })).reverse() });
    });
    const report = await buildSemanticGeneration({ copy, output, asOf }, { embedder: document });
    expect(report).toMatchObject({ kind: 'semantic', vectorsGenerated: true, embeddings: { batches: 1, indexedCards: 2, indexedRows: 2, space } });
    expect(sent).toHaveLength(1); expect(sent[0]![0]).toBe('North gate\nLantern keeper\nA silver forest.\nA silver forest.\nMira\nfantasy magic\nchub\nremote/path\nremote/path');
    expect(sent.flat().some((text) => text.includes('Instruct:'))).toBe(false);
    const query = createQueryEmbedder(config, 'synthetic-key', async (_url, init) => {
      expect(JSON.parse(String(init?.body)).input[0]).toContain('Instruct: Find the matching character\nQuery:');
      return Response.json({ data: [{ index: 0, embedding: [0, 4, 12] }] });
    });
    const source = await openCopiedArchive(output, query), inventory = await fixtureInventory(output);
    expect(source.status().semantic).toMatchObject({ indexedCards: 2, indexedRows: 2, dimensions: 2 });
    const first = await source.search({ mode: 'semantic', text: 'sea voyage', limit: 1 });
    expect(first.cards[0]!.id).toBe('2'); expect(first.matches?.[0]).toMatchObject({ section: 'card', score: 1 });
    expect(first.matches?.[0]?.text).toContain('ocean');
    const reopened = await openCopiedArchive(output, query);
    expect((await reopened.search({ mode: 'semantic', text: 'sea voyage', snapshot: first.snapshot, cursor: first.nextCursor!, limit: 1 })).cards.map((card) => card.id)).toEqual(['1']);
    expect((await reopened.search({ mode: 'semantic', text: 'sea voyage', filter: 'tokenCount < 800' })).cards.map((card) => card.id)).toEqual(['1']);
    expect((await reopened.search({ mode: 'hybrid', text: 'North gate' })).cards[0]!.id).toBe('1');
    expect((await reopened.search({ text: 'forest' })).cards.map((card) => card.id)).toEqual(['1']);
    expect((await openCopiedArchive(output)).status()).not.toHaveProperty('semantic');
    expect(await readFile(join(output, 'archive.sqlite'))).toEqual(await readFile(join(copy, 'archive.sqlite')));
    expect(await fixtureInventory(copy)).toEqual(before); expect(await fixtureInventory(output)).toEqual(inventory);
    expect(await readFile(join(output, 'generation.json'), 'utf8')).not.toContain('synthetic-key');
  }, 30000);

  it('does not publish a failed, cancelled, malformed or changed-source semantic build', async () => {
    const { root, copy } = await fixture(), before = await fixtureInventory(copy);
    for (const failure of ['provider', 'cancelled', 'malformed']) {
      const output = join(root, failure), controller = new AbortController(); let calls = 0;
      await expect(buildSemanticGeneration({ copy, output, asOf }, { batchSize: 1, embedder: { space, async embed() {
        calls++;
        if (calls === 2) {
          if (failure === 'provider') throw new Error('Synthetic outage');
          if (failure === 'cancelled') controller.abort();
          if (failure === 'malformed') return [[0, 0]];
        }
        return [[1, 0]];
      } } }, controller.signal)).rejects.toThrow();
      expect(calls).toBe(2); await expect(stat(join(output, 'copy-manifest.json'))).rejects.toHaveProperty('code', 'ENOENT');
      expect(JSON.parse(await readFile(join(output, 'generation.json'), 'utf8')).state).toBe('building');
      expect(await fixtureInventory(copy)).toEqual(before);
    }
    const output = join(root, 'changed-during-provider');
    await expect(buildSemanticGeneration({ copy, output, asOf }, { embedder: { space, async embed(texts) {
      await writeFile(join(copy, 'files', 'original'), 'changed externally during provider request'); return texts.map(() => [1, 0]);
    } } })).rejects.toThrow('changed');
    await expect(stat(join(output, 'copy-manifest.json'))).rejects.toHaveProperty('code', 'ENOENT');
  });

  it('runs the semantic CLI against real loopback provider HTTP with serial batches and no key in its receipt', async () => {
    const { root, copy } = await fixture(), before = await fixtureInventory(copy);
    const seen: { path: string; input: string[] }[] = []; let active = 0, peak = 0;
    const server = createServer(async (request, response) => {
      active++; peak = Math.max(peak, active);
      let body = ''; for await (const chunk of request) body += chunk;
      const input = JSON.parse(body).input as string[]; seen.push({ path: request.url!, input });
      const openai = request.url === '/v1/embeddings';
      expect(request.headers.authorization).toBe(openai ? 'Bearer private-synthetic-key' : undefined);
      const vectors = input.map((text) => text.includes('ocean') ? [0, 4, 12] : [3, 0, 12]);
      await new Promise((resolve) => setTimeout(resolve, 10)); active--;
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(openai ? { data: vectors.map((embedding, index) => ({ index, embedding })).reverse() } : { embeddings: vectors }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    try {
      for (const provider of ['openai', 'ollama']) {
        const config = join(root, `${provider}.json`); await writeFile(config, JSON.stringify({ provider, baseUrl: `http://127.0.0.1:${address.port}`, space }));
        const output = join(root, `cli-${provider}`);
        const result = await exec(process.execPath, ['--import', 'tsx', join(import.meta.dirname, 'generation-cli.ts'), 'semantic', '--copy', copy, '--output', output, '--as-of', asOf, '--embedding-config', config, '--batch-size', '1'],
          { cwd: join(import.meta.dirname, '..'), env: { ...process.env, UNITY_ARCHIVE_EMBEDDING_KEY: provider === 'openai' ? 'private-synthetic-key' : '' } });
        expect(JSON.parse(result.stdout)).toMatchObject({ kind: 'semantic', state: 'ready', embeddings: { batches: 2, indexedCards: 2 } });
        expect(result.stdout + result.stderr + await readFile(join(output, 'generation.json'), 'utf8')).not.toContain('private-synthetic-key');
        expect((await openCopiedArchive(output)).status().search).toBe('lance-fts-v1');
      }
      expect(peak).toBe(1); expect(seen.map((item) => item.path)).toEqual(['/v1/embeddings', '/v1/embeddings', '/api/embed', '/api/embed']);
      expect(seen.every((item) => item.input.length === 1 && !item.input[0]!.includes('Instruct:'))).toBe(true);
      expect(await fixtureInventory(copy)).toEqual(before);
    } finally { const closed = new Promise<void>((resolve) => server.close(() => resolve())); server.closeAllConnections(); await closed; }
  }, 30000);
});
