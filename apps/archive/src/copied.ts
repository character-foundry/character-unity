import { relative, readCopy } from './copy-files.js';
import type { QueryEmbedder } from './embeddings.js';
import { openCopiedSearch } from './copied-search.js';
import { lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { ArchiveError, identifier, limits, parseCard, parseObject, record } from '@character-unity/archive-client/contract';
import type { ArchiveCard, OriginalObject } from '@character-unity/archive-client';
import { createArchiveIndex } from './read-source.js';

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function invalid(message: string): never { throw new ArchiveError('INVALID_INPUT', message); }
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid('Unknown copied Archive manifest field');
}
/** Open only an explicitly staged copy. Never imports the legacy initializer or jobs. */
export async function openCopiedArchive(directory: string, embedder?: QueryEmbedder) {
  const root = resolve(directory);
  if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) invalid('Copy root must be a real directory');
  const manifestFile = await readCopy(root, 'copy-manifest.json', limits.jsonBytes, true);
  const manifest = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestFile.bytes)));
  keys(manifest, ['version', 'archiveId', 'database', 'cards', 'search']);
  if (manifest.version !== 'unity.archive-copy.v1') invalid('Expected an explicit unity.archive-copy.v1 manifest');
  const archiveId = identifier(manifest.archiveId), database = record(manifest.database);
  keys(database, ['path', 'sha256']);
  const databasePath = relative(database.path);
  if (typeof database.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(database.sha256)) invalid('Expected a copied database digest');
  if (!Array.isArray(manifest.cards) || manifest.cards.length > 10_000) invalid('A copied selection supports at most 10,000 cards');
  // A copy must be a standalone SQLite snapshot. Never recover a journal or open a live WAL.
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { await lstat(join(root, `${databasePath}${suffix}`)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    invalid('Copied database must have no WAL, SHM or journal sidecars');
  }
  const captured = await readCopy(root, databasePath, 1024 * 1024 * 1024, false);
  if (captured.hash !== database.sha256) throw new ArchiveError('INTEGRITY', 'Copied database digest does not match its manifest');
  if (new TextDecoder().decode(captured.header.subarray(0, 16)) !== 'SQLite format 3\0'
    || captured.header[18] !== 1 || captured.header[19] !== 1) invalid('Expected a standalone rollback-mode SQLite copy, not a WAL database');
  const originals = new Map<string, { path: string; object: OriginalObject }>(), assets = new Map<string, { path: string; object: OriginalObject }>();
  async function capture(input: unknown, target: typeof originals) {
    const value = record(input); keys(value, ['path', 'mediaType']);
    const path = relative(value.path), source = await readCopy(root, path, limits.objectBytes, false);
    const object = parseObject({ algorithm: 'sha256', hash: source.hash, byteLength: source.byteLength, mediaType: value.mediaType });
    const previous = target.get(object.hash);
    if (previous && previous.object.mediaType !== object.mediaType) invalid('Identical copied bytes must have one media type');
    target.set(object.hash, { path, object }); return object;
  }
  const db = new Database(captured.target, { readonly: true, fileMustExist: true });
  const cards: ArchiveCard[] = [];
  let metadataBytes = 0;
  try {
    db.pragma('query_only = ON'); db.pragma('trusted_schema = OFF');
    for (const name of ['cards', 'card_tags', 'cached_assets']) {
      const table = db.prepare('SELECT type, sql FROM sqlite_schema WHERE name = ?').get(name) as { type: string; sql: string } | undefined;
      if (!table || table.type !== 'table' || /CREATE\s+VIRTUAL/i.test(table.sql)) invalid('Copied database needs physical legacy Archive tables');
    }
    const getCard = db.prepare('SELECT CAST(id AS TEXT) AS id, name, source, sourceId, sourcePath, fullPath, sourceUrl FROM cards WHERE id = ?');
    const getTags = db.prepare('SELECT tag FROM card_tags WHERE cardId = ? ORDER BY normalizedTag COLLATE BINARY');
    const getAssets = db.prepare('SELECT CAST(id AS TEXT) AS id, originalUrl FROM cached_assets WHERE cardId = ? ORDER BY id');
    db.exec('BEGIN');
    for (const raw of manifest.cards) {
      const value = record(raw); keys(value, ['id', 'original', 'assets']);
      const id = identifier(value.id);
      const row = getCard.get(id) as Record<string, unknown> | undefined;
      if (!row || row.id !== id) invalid('Selected card does not exist in copied Archive database');
      const cached = getAssets.all(id) as { id: string; originalUrl: string }[];
      if (!Array.isArray(value.assets) || value.assets.length !== cached.length || cached.length > 64) invalid('Explicitly map every selected card cache record, including missing files');
      const ids = new Set<string>();
      const cardAssets: ArchiveCard['assets'] = [];
      for (const rawAsset of value.assets) {
        const asset = record(rawAsset); keys(asset, ['id', 'file', 'binding']);
        const assetId = identifier(asset.id);
        if (ids.has(assetId) || !cached.some((entry) => entry.id === assetId)) invalid('Cached asset is duplicate or belongs to another card');
        ids.add(assetId);
        // A binding is supplied explicitly from the accepted card, never guessed from
        // cached localPath or fetched from originalUrl. parseCard validates its shape.
        const entry = { id: assetId, ...(asset.binding === undefined ? {} : { binding: asset.binding }),
          ...(asset.file === null ? { availability: 'unavailable' } : { availability: 'available', object: await capture(asset.file, assets) }) };
        cardAssets.push(entry as ArchiveCard['assets'][number]);
      }
      const card = parseCard({ id, title: row.name ?? '', tags: (getTags.all(id) as { tag: string }[]).map((entry) => entry.tag),
        source: { provider: row.source ?? 'unknown', recordId: row.sourceId ?? row.sourcePath ?? row.fullPath ?? id, url: row.sourceUrl ?? null },
        original: await capture(value.original, originals), assets: cardAssets });
      metadataBytes += Buffer.byteLength(JSON.stringify(card));
      if (metadataBytes > 64 * 1024 * 1024) throw new ArchiveError('TOO_LARGE', 'Copied selection metadata exceeds 64 MiB');
      cards.push(card);
    }
    db.exec('ROLLBACK');
  } finally { db.close(); }
  const after = await readCopy(root, databasePath, 1024 * 1024 * 1024, false);
  if (after.hash !== captured.hash) throw new ArchiveError('SNAPSHOT_CHANGED', 'Copied database changed while capturing metadata');
  const fingerprint = digest(JSON.stringify({ database: captured.hash, manifest: manifestFile.hash }));
  if (embedder && manifest.search === undefined) invalid('Embedding provider requires a copied search index');
  const search = manifest.search === undefined ? undefined : await openCopiedSearch(root, manifest.search, cards.map((card) => card.id), embedder);
  return createArchiveIndex(archiveId, cards, 'copy', async (kind, hash, snapshot) => {
    const entry = (kind === 'originals' ? originals : assets).get(hash);
    if (!entry) throw new ArchiveError('NOT_FOUND', 'Existing copied Archive object not found');
    let result: Awaited<ReturnType<typeof readCopy>>;
    try { result = await readCopy(root, entry.path, limits.objectBytes, true); }
    catch { throw new ArchiveError('UNAVAILABLE', 'Copied Archive object is no longer readable'); }
    if (result.hash !== hash || result.byteLength !== entry.object.byteLength) throw new ArchiveError('INTEGRITY', 'Copied Archive object changed');
    return { ...snapshot, object: { ...entry.object }, bytes: result.bytes };
  }, fingerprint, search);
}
