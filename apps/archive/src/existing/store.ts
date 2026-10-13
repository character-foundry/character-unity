import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, NativeArchiveError, pinnedSummary } from '../native/store.js';
import type { ArchiveCardDetail, ArchiveCardSummary, ArchiveObjectRef, ArchiveVersion, RunRecord, SourceRecord } from '../native/store.js';
import { createObjectStore, sha256 } from '../native/objects.js';
import type { ArchiveCapabilities, ArchiveQuery } from '../native/query.js';
import { archiveSorts } from '../native/query.js';
import type { RunCounts, RunResult, ScrapedCard, ScrapedObject, ScrapeSink, SourceStats } from '@character-unity/scraper-kit';
import { existingSchema, existingSchemaVersion } from './schema.js';
import { existingFilter, existingSort } from './query.js';
import { hashExistingFile, missing, readExistingFile, realDirectory, safeRelative } from './files.js';
import type { ExistingSearch } from './search.js';
import type { DocumentEmbedder } from '../embeddings.js';
import { createVectorQueueDrainer } from './vector-queue.js';
import { validateIdentityQuery } from '@character-unity/archive-client/native';
import type { ArchiveIdentityQuery, ArchiveIdentityMatch, ArchiveIdentityResult } from '@character-unity/archive-client';
import { archiveContentHash } from '../identity.js';
import { loadExistingBlacklists } from './blacklists.js';
import { ArchiveError } from '@character-unity/archive-client/contract';
import type { SearchMatch } from '@character-unity/archive-client';
import { searchSnapshot } from '../native/search-snapshot.js';
import type { LibraryIndex, LibrarySearchCard } from '../library-index.js';
import { mergeSearchPage } from '../library-search-merge.js';

export interface ExistingArchiveOptions {
  databasePath: string; filesDirectory: string; objectsDirectory?: string;
  readOnly?: boolean; now?: () => string; search?: ExistingSearch; documentEmbedder?: DocumentEmbedder; legacyRoot?: string;
  libraryIndex?: LibraryIndex;
}
type Row = Record<string, unknown> & { id: number };
type Location = { origin: 'legacy' | 'objects'; path: string; sha256: string; byteLength: number; mediaType: string; bytes?: Uint8Array<ArrayBuffer> };
const text = (value: unknown) => typeof value === 'string' ? value : '';
const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const iso = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const providerOf = (row: Row) => text(row.source) || 'chub';
const recordOf = (row: Row) => text(row.sourceId) || String(row.id);
const normalizePath = (value: string) => value.trim().replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/').toLowerCase().replace(/\s+/g, '_');
function sourcePath(card: ScrapedCard) {
  try { const path = new URL(card.url).pathname; return normalizePath(decodeURIComponent(path.replace(/^\/characters?\//, ''))); }
  catch { return ''; }
}

/** The original SQLite database and files, with additive bookkeeping and no corpus adoption/copy. */
export async function openExistingArchive(options: ExistingArchiveOptions) {
  const blacklistEntries = !options.readOnly && options.legacyRoot ? await loadExistingBlacklists(options.legacyRoot) : [];
  const databasePath = resolve(options.databasePath), filesDirectory = await realDirectory(options.filesDirectory);
  const existingArchiveId = `existing-${sha256(databasePath).slice(0, 24)}`;
  const databaseInfo = await lstat(databasePath);
  if (!databaseInfo.isFile() || databaseInfo.isSymbolicLink() || await realpath(databasePath) !== databasePath) throw new Error('Existing Archive database must be a real existing file');
  if (!options.readOnly && !options.objectsDirectory) throw new Error('Existing Archive writes require an explicit objectsDirectory');
  const objectsDirectory = resolve(options.objectsDirectory ?? join(dirname(databasePath), 'unity-objects'));
  if (objectsDirectory === filesDirectory || relative(objectsDirectory, filesDirectory) === '' || !relative(objectsDirectory, filesDirectory).startsWith('..')) throw new Error('Archive object directory cannot contain the existing files directory');
  const now = options.now ?? (() => new Date().toISOString()), readonly = options.readOnly ?? false;
  const db = new Database(databasePath, { readonly, fileMustExist: true });
  let lockPath: string | undefined, lockToken = '';
  const table = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_schema WHERE name = ? AND type = 'table' AND sql NOT LIKE '%VIRTUAL%'").get(name);
  try {
    db.pragma('trusted_schema = OFF'); db.pragma('foreign_keys = ON'); db.pragma('busy_timeout = 15000');
    for (const name of ['cards', 'card_tags', 'cached_assets']) if (!table(name)) throw new Error(`Existing Archive needs its physical legacy ${name} table`);
    const columns = new Set((db.prepare('PRAGMA table_info(cards)').all() as { name: string }[]).map((column) => column.name));
    for (const name of ['id', 'source', 'sourceId', 'sourcePath', 'sourceUrl', 'name', 'author', 'tagline', 'description', 'topics', 'tokenCount', 'lastModified', 'createdAt', 'firstDownloadedAt', 'favorited', 'starCount', 'n_favorites', 'nChats', 'nMessages', 'rating', 'hasAlternateGreetings', 'hasLorebook', 'hasGallery', 'hasEmbeddedImages', 'hasExpressions', 'hasSystemPrompt', 'hasExampleDialogues']) {
      if (!columns.has(name)) throw new Error(`Unsupported existing Archive schema: cards.${name} is missing; use the Archive's explicit schema upgrade first`);
    }
    if (!readonly) {
      const optimizer = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND (name IN ('trg_cards_after_insert_png_opt_queue','trg_cards_after_update_png_opt_queue') OR lower(sql) LIKE '%insert%png_optimization_queue%')").all();
      if (optimizer.length) throw new Error('Stop the legacy PNG optimizer and disable its PNG optimization queue triggers before enabling the existing Archive writer; optimizer rewrites would invalidate retained versions');
      if (table('sync_runs') && db.prepare("SELECT 1 FROM sync_runs WHERE status = 'running' AND (lease_expires_at IS NULL OR datetime(lease_expires_at) > datetime('now')) LIMIT 1").get()) throw new Error('A legacy Archive sync worker is active; complete the single-writer takeover before starting this writer');
      lockPath = `${databasePath}.unity-writer.lock`; lockToken = JSON.stringify({ pid: process.pid, token: randomUUID() });
      const handle = await open(lockPath, 'wx').catch(() => { lockPath = undefined; throw new Error('The existing Archive writer is already locked; stop its owner, or remove a stale .unity-writer.lock only after verifying the owner has stopped'); });
      try { await handle.writeFile(lockToken); await handle.sync(); } finally { await handle.close(); }
      await mkdir(objectsDirectory, { recursive: true }); await realDirectory(objectsDirectory);
      db.transaction(() => {
        const old = table('unity_archive_meta') ? db.prepare("SELECT value FROM unity_archive_meta WHERE key = 'schema_version'").get() as { value: string } | undefined : undefined;
        if (old && Number(old.value) > existingSchemaVersion) throw new Error('Existing Archive bookkeeping was written by a newer version');
        db.exec(existingSchema);
        if (table('card_source_aliases')) db.exec('CREATE INDEX IF NOT EXISTS unity_archive_alias_identity ON card_source_aliases(source,source_id); CREATE INDEX IF NOT EXISTS unity_archive_alias_path ON card_source_aliases(source,lower(source_path));');
        db.prepare('INSERT OR REPLACE INTO unity_archive_meta(key,value) VALUES (?,?)').run('schema_version', String(existingSchemaVersion));
        db.prepare('INSERT OR IGNORE INTO unity_archive_meta(key,value) VALUES (?,?)').run('archive_id', existingArchiveId);
        db.prepare("UPDATE unity_archive_runs SET status = 'failed', finished_at = ?, error = coalesce(error,'The Archive stopped during this run') WHERE status = 'running'").run(now());
      })();
    } else db.pragma('query_only = ON');
  } catch (error) {
    db.close();
    if (lockPath) { try { if (readFileSync(lockPath, 'utf8') === lockToken) unlinkSync(lockPath); } catch { /* startup did not create a complete lock */ } }
    throw error;
  }
  const bookkeeping = table('unity_archive_meta');
  const identityIndex = table('unity_archive_identities');
  const archiveId = bookkeeping ? (db.prepare("SELECT value FROM unity_archive_meta WHERE key = 'archive_id'").get() as { value: string } | undefined)?.value ?? existingArchiveId : existingArchiveId;
  const readInstance = randomUUID();
  const databaseGeneration = () => JSON.stringify([readInstance, db.pragma('data_version', { simple: true }), db.prepare('SELECT total_changes() AS n').get()]);
  const capabilities: ArchiveCapabilities = { lexical: !!options.search, semantic: options.search?.semantic ?? false,
    browse: !!options.search, filterFields: options.search?.filterFields ?? [],
    browseSorts: options.search?.sorts ?? [],
    libraryIndex: options.libraryIndex?.capabilities ?? { enabled: false, semantic: false, reason: 'Library projection indexing is not enabled for this Archive' },
    ...(options.search?.embedding ? { embedding: options.search.embedding } : {}),
    sorts: archiveSorts.filter((sort) => sort !== 'downloads'),
    has: ['greetings', 'lorebook', 'gallery', 'embeddedImages', 'expressions', 'systemPrompt', 'exampleDialogues', 'followed'] };
  const objects = createObjectStore(objectsDirectory), locations = new Map<string, Location>();
  const vectorQueue = createVectorQueueDrainer(db, options.search, options.documentEmbedder);
  let retainedBytes = 0;
  const stateJoin = bookkeeping ? 'LEFT JOIN unity_archive_state s ON s.card_id = c.id' : '';
  const stateFields = bookkeeping ? ', s.current_version, s.spec, s.alt_greetings, s.lorebook_entries, s.portrait_sha256, s.changed_at, s.last_seen_at' : '';
  const selected = `SELECT c.*${stateFields} FROM cards c ${stateJoin}`;
  const observedIdentities = new Map<string, Omit<ArchiveIdentityMatch, 'matchedBy' | 'provider' | 'recordId' | 'url'>>();
  const legacyStamp = "json_array(c.name,c.lastModified,c.source,c.sourceId,c.sourcePath,c.sourceUrl,(SELECT group_concat(a.originalUrl || ':' || a.localPath,'|') FROM cached_assets a WHERE a.cardId = c.id))";
  function rememberIdentity(cardId: string, versionId: string, fileHash: string, contentHash: string | null) {
    observedIdentities.delete(versionId); observedIdentities.set(versionId, { cardId, versionId, fileHash, contentHash });
    while (observedIdentities.size > 2048) observedIdentities.delete(observedIdentities.keys().next().value!);
  }
  const writable = () => { if (readonly) throw new NativeArchiveError('INVALID_INPUT', 'This existing Archive connection is read-only'); };
  async function writeObject(bytes: Uint8Array) {
    const hash = sha256(bytes);
    let directory = objectsDirectory;
    for (const part of [hash.slice(0, 2), hash.slice(2, 4)]) {
      directory = join(directory, part);
      let info;
      try { info = await lstat(directory); }
      catch (error) { if (!missing(error)) throw error; await mkdir(directory); info = await lstat(directory); }
      if (!info.isDirectory() || info.isSymbolicLink()) throw new NativeArchiveError('INVALID_INPUT', 'Archive object directories cannot contain symlinks');
    }
    const path = `${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
    try {
      const existing = await readExistingFile(objectsDirectory, path);
      if (existing.sha256 !== hash) throw new Error('An existing Archive object is corrupt; repair it before writing');
      return hash;
    } catch (error) { if (!missing(error)) throw error; }
    return objects.put(bytes);
  }
  function remember(location: Location) {
    const previous = locations.get(location.sha256);
    const accepted = previous && !previous.bytes && location.bytes ? previous : location;
    retainedBytes -= previous?.bytes?.byteLength ?? 0;
    retainedBytes += accepted.bytes?.byteLength ?? 0;
    locations.delete(location.sha256); locations.set(location.sha256, accepted);
    // Read-only attachment has no index writes; only recently requested objects are held in memory.
    while (locations.size > 20_000 || retainedBytes > 32 * 1024 * 1024) {
      const key = locations.keys().next().value!;
      retainedBytes -= locations.get(key)?.bytes?.byteLength ?? 0; locations.delete(key);
    }
    return accepted;
  }
  function visible(id: string) {
    if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new NativeArchiveError('INVALID_INPUT', 'Existing Archive IDs must be positive numeric IDs');
    const filter = existingFilter({}, bookkeeping);
    const row = db.prepare(`${selected} WHERE c.id = ? AND ${filter.clause}`).get(id) as Row | undefined;
    if (!row) throw new NativeArchiveError('NOT_FOUND', 'No such existing Archive card');
    return row;
  }
  function find(provider: string, recordId: string, path = '') {
    let row = db.prepare(`${selected} WHERE c.source = ? AND c.sourceId = ? ORDER BY c.id LIMIT 1`).get(provider, recordId) as Row | undefined;
    if (!row && /^[1-9][0-9]*$/.test(recordId)) row = db.prepare(`${selected} WHERE c.id = ? AND coalesce(c.source,'chub') = ? AND coalesce(c.sourceId,'') = ''`).get(recordId, provider) as Row | undefined;
    if (provider === 'ct' && path) {
      const byPath = db.prepare(`${selected} WHERE c.source = 'ct' AND lower(c.sourcePath) = ? ORDER BY c.id LIMIT 1`).get(path) as Row | undefined;
      if (byPath && (!row || byPath.id < row.id)) row = byPath;
    }
    if (table('card_source_aliases')) {
      const alias = db.prepare(`${selected} JOIN card_source_aliases a ON a.canonical_card_id = c.id WHERE a.source = ? AND (a.source_id = ?${provider === 'ct' && path ? " OR lower(replace(replace(replace(trim(trim(a.source_path),'/'),' ','_'),'//','/'),'//','/')) = ?" : ''}) ORDER BY c.id LIMIT 1`)
        .get(provider, recordId, ...(provider === 'ct' && path ? [path] : [])) as Row | undefined;
      if (alias && (!row || alias.id < row.id)) row = alias;
    }
    if (!row && provider === 'ct' && path) row = db.prepare(`${selected} WHERE c.source = 'ct' AND lower(replace(replace(replace(trim(trim(c.sourcePath),'/'),' ','_'),'//','/'),'//','/')) = ? ORDER BY c.id LIMIT 1`).get(path) as Row | undefined;
    return row;
  }
  const rowTags = (row: Row) => (db.prepare('SELECT tag FROM card_tags WHERE cardId = ? ORDER BY normalizedTag COLLATE BINARY').all(row.id) as { tag: string }[]).map((tag) => tag.tag);
  function summary(row: Row): ArchiveCardSummary {
    return { id: String(row.id), provider: providerOf(row), recordId: recordOf(row), url: text(row.sourceUrl),
      name: text(row.name), creator: text(row.author), tagline: text(row.tagline), tags: rowTags(row), spec: row.spec === 'v3' ? 'v3' : 'v2',
      tokens: numeric(row.tokenCount), altGreetings: row.alt_greetings === undefined ? +!!row.hasAlternateGreetings : numeric(row.alt_greetings),
      lorebookEntries: row.lorebook_entries === undefined ? +!!row.hasLorebook : numeric(row.lorebook_entries),
      flags: { gallery: !!row.hasGallery, expressions: !!row.hasExpressions, embeddedImages: !!row.hasEmbeddedImages, systemPrompt: !!row.hasSystemPrompt, exampleDialogues: !!row.hasExampleDialogues },
      stats: { stars: numeric(row.starCount), favorites: numeric(row.n_favorites), chats: numeric(row.nChats), messages: numeric(row.nMessages), rating: numeric(row.rating) },
      portrait: text(row.portrait_sha256) || null, remoteCreatedAt: iso(row.createdAt), remoteUpdatedAt: iso(row.lastModified),
      firstSeenAt: text(row.firstDownloadedAt), changedAt: text(row.changed_at) || text(row.lastModified), versionId: text(row.current_version) || `legacy-${row.id}`,
      versions: row.current_version ? numeric((db.prepare('SELECT count(*) AS n FROM unity_archive_versions WHERE card_id = ?').get(row.id) as { n: number }).n) : 1 };
  }
  async function legacy(path: string) {
    const { bytes, ...metadata } = await readExistingFile(filesDirectory, path);
    const location = remember({ origin: 'legacy', path, ...metadata });
    return { ...location, bytes };
  }
  async function portrait(row: Row) {
    if (row.current_version) return text(row.portrait_sha256) || null;
    const id = String(row.id);
    try {
      const path = `${id.slice(0, 2)}/${id}.png`, metadata = await hashExistingFile(filesDirectory, path);
      if (!metadata.mediaType.startsWith('image/')) return null;
      return remember({ origin: 'legacy', path, ...metadata }).sha256;
    }
    catch (error) { if (missing(error)) return null; throw error; }
  }
  const objectRef = (location: Location, role: ScrapedObject['role'], name: string): ArchiveObjectRef => ({ role, name, sha256: location.sha256, byteLength: location.byteLength, mediaType: location.mediaType });
  async function generated(bytes: Uint8Array<ArrayBuffer>, name: string) {
    if (bytes.byteLength > 16 * 1024 * 1024) throw new NativeArchiveError('INVALID_INPUT', 'An extracted legacy card document exceeds 16 MiB');
    const hash = sha256(bytes);
    return remember({ origin: 'legacy', path: name, bytes, sha256: hash, byteLength: bytes.byteLength, mediaType: 'application/json' });
  }
  async function baseline(row: Row, computeIdentity = false) {
    const id = String(row.id), prefix = `${id.slice(0, 2)}/${id}`, refs: ArchiveObjectRef[] = [];
    let description: ReturnType<typeof describe> | undefined, chosen: Location | undefined;
    for (const suffix of ['.charx', '.card.png', '.png', '.json']) {
      let location: Location;
      try { location = await legacy(`${prefix}${suffix}`); }
      catch (error) { if (missing(error)) continue; throw error; }
      const fileBytes = location.bytes ?? (await readExistingFile(filesDirectory, location.path)).bytes;
      // Legacy sidecars contain searchable metadata alongside their complete definition.
      // Inspect that envelope first: its outer name/description can otherwise resemble a v1 card.
      if (suffix === '.json') {
        let metadata: { definition?: unknown; spec?: unknown } | undefined;
        try { metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fileBytes)) as typeof metadata; } catch { /* Foundry reports an unreadable raw JSON below */ }
        if (metadata && !metadata.spec && metadata.definition && typeof metadata.definition === 'object') {
          const bytes = new TextEncoder().encode(JSON.stringify(metadata.definition));
          description = describe({ provider: providerOf(row), recordId: recordOf(row), url: text(row.sourceUrl), objects: [] }, { role: 'card', bytes, mediaType: 'application/json' });
          refs.push(objectRef(location, 'raw', `${id}.json`));
          chosen = await generated(bytes, `${id}.definition.json`);
          refs.push(objectRef(chosen, 'card', `${id}.json`)); break;
        }
      }
      try {
        description = describe({ provider: providerOf(row), recordId: recordOf(row), url: text(row.sourceUrl), objects: [] }, { role: 'card', bytes: fileBytes, mediaType: location.mediaType });
        chosen = location;
      } catch (error) {
        if (suffix !== '.json') continue;
        let metadata: { definition?: unknown };
        try { metadata = JSON.parse(new TextDecoder().decode(fileBytes)) as { definition?: unknown }; } catch { throw error; }
        if (!metadata.definition) throw error;
        const bytes = new TextEncoder().encode(JSON.stringify(metadata.definition));
        description = describe({ provider: providerOf(row), recordId: recordOf(row), url: text(row.sourceUrl), objects: [] }, { role: 'card', bytes, mediaType: 'application/json' });
        refs.push(objectRef(location, 'raw', `${id}.json`));
        chosen = await generated(bytes, `${id}.definition.json`);
      }
      if (chosen) { refs.push(objectRef(chosen, 'card', `${id}${suffix}`)); break; }
    }
    if (!chosen || !description) throw new NativeArchiveError('UNSUPPORTED_FORMAT', `Existing Archive card ${id} has no readable card file`);
    try {
      const image = await legacy(`${prefix}.png`);
      if (image.mediaType.startsWith('image/')) refs.push(objectRef(image, 'portrait', `${id}.png`));
    } catch (error) { if (!missing(error)) throw error; }
    const assets = db.prepare('SELECT originalUrl,localPath FROM cached_assets WHERE cardId = ? ORDER BY id').all(row.id) as { originalUrl: string; localPath: string }[];
    for (const asset of assets) {
      safeRelative(asset.localPath);
      try { refs.push(objectRef(await legacy(asset.localPath), 'asset', asset.originalUrl)); }
      catch (error) { if (!missing(error)) throw error; }
    }
    const fingerprint = fingerprintOf(refs);
    const versionId = `legacy-${id}-${fingerprint.slice(0, 24)}`;
    const identity = computeIdentity ? await archiveContentHash(chosen.bytes ?? (await readObject(chosen.sha256)).bytes, description.document, refs, readObject)
      : { hash: null, reason: 'Content identity was not requested', name: null };
    if (computeIdentity) rememberIdentity(id, versionId, chosen.sha256, identity.hash);
    return { id: versionId, sequence: 1, fetchedAt: text(row.firstDownloadedAt) || text(row.lastModified), remoteUpdatedAt: iso(row.lastModified), objects: refs, description, fingerprint, identity };
  }
  function versionObjects(version: string) {
    return db.prepare('SELECT v.role,v.name,v.sha256,o.byte_length AS byteLength,o.media_type AS mediaType FROM unity_archive_version_objects v JOIN unity_archive_objects o ON o.sha256 = v.sha256 WHERE v.version_id = ? ORDER BY v.role,v.name').all(version) as ArchiveObjectRef[];
  }
  const fingerprintOf = (refs: ArchiveObjectRef[]) => sha256(JSON.stringify(refs.filter((ref) => ref.role !== 'raw')
    .map((ref) => [ref.role, ref.role === 'card' || ref.role === 'portrait' ? ref.role : ref.name, ref.sha256]).sort()));
  function saveVersion(id: number, version: ArchiveVersion, fingerprint: string) {
    db.prepare('INSERT INTO unity_archive_versions(id,card_id,sequence,fingerprint,remote_updated_at,fetched_at) VALUES (?,?,?,?,?,?)').run(version.id, id, version.sequence, fingerprint, version.remoteUpdatedAt, version.fetchedAt);
    for (const ref of version.objects) db.prepare('INSERT INTO unity_archive_version_objects(version_id,role,name,sha256) VALUES (?,?,?,?)').run(version.id, ref.role, ref.name, ref.sha256);
  }
  function saveIdentity(id: number, version: string, refs: ArchiveObjectRef[], identity: { hash: string | null; reason: string | null; name: string | null }, stamp: string | null = null) {
    const container = refs.find((ref) => ref.role === 'card');
    if (!container) throw new NativeArchiveError('UNSUPPORTED_FORMAT', 'This Archive version has no card file');
    db.prepare('INSERT OR REPLACE INTO unity_archive_identities(version_id,card_id,file_hash,content_hash,content_name,unavailable_reason,legacy_stamp) VALUES (?,?,?,?,?,?,?)')
      .run(version, id, container.sha256, identity.hash, identity.name, identity.reason, stamp);
  }
  async function persistDerived(refs: ArchiveObjectRef[]) {
    for (const ref of refs) {
      const location = locations.get(ref.sha256);
      if (location?.bytes) {
        await writeObject(location.bytes);
        remember({ origin: 'objects', path: `${ref.sha256.slice(0, 2)}/${ref.sha256.slice(2, 4)}/${ref.sha256}`, sha256: ref.sha256, byteLength: location.byteLength, mediaType: location.mediaType });
      }
    }
  }
  function register(refs: ArchiveObjectRef[]) {
    for (const ref of refs) {
      const location = locations.get(ref.sha256);
      if (!location || location.bytes) throw new Error('Archive file reference expired while preparing an update; retry the scrape');
      db.prepare(`INSERT INTO unity_archive_objects(sha256,origin,path,byte_length,media_type) VALUES (?,?,?,?,?)
        ON CONFLICT(sha256) DO UPDATE SET origin=excluded.origin,path=excluded.path,byte_length=excluded.byte_length,media_type=excluded.media_type`)
        .run(ref.sha256, location.origin, location.path, location.byteLength, location.mediaType);
    }
  }
  async function readObject(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new NativeArchiveError('INVALID_INPUT', 'Invalid object hash');
    let location = locations.get(hash);
    if (!location && bookkeeping) {
      const row = db.prepare('SELECT origin,path,sha256,byte_length AS byteLength,media_type AS mediaType FROM unity_archive_objects WHERE sha256 = ?').get(hash) as Location | undefined;
      if (row) location = row;
    }
    if (!location) throw new NativeArchiveError('NOT_FOUND', 'No such requested Archive object; request its card again');
    const bytes = location.bytes ?? (await readExistingFile(location.origin === 'legacy' ? filesDirectory : objectsDirectory, location.path)).bytes;
    if (bytes.byteLength !== location.byteLength || sha256(bytes) !== hash) throw new Error('Existing Archive object changed; its expected bytes are no longer available');
    return { bytes, mediaType: location.mediaType };
  }
  function statsUpdate(id: number, stats: SourceStats | undefined) {
    const values = [stats?.stars ?? null, stats?.favorites ?? null, stats?.chats ?? null, stats?.messages ?? null, stats?.rating ?? null];
    db.prepare(`UPDATE cards SET starCount = coalesce(?,starCount),n_favorites = coalesce(?,n_favorites),nChats = coalesce(?,nChats),nMessages = coalesce(?,nMessages),rating = coalesce(?,rating)
      WHERE id = ? AND (starCount,n_favorites,nChats,nMessages,rating) IS NOT (coalesce(?,starCount),coalesce(?,n_favorites),coalesce(?,nChats),coalesce(?,nMessages),coalesce(?,rating))`)
      .run(...values, id, ...values);
    db.prepare('UPDATE unity_archive_state SET last_seen_at = ? WHERE card_id = ?').run(now(), id);
  }
  // All providers may fetch concurrently; allocating numeric IDs and committing a card is serialized.
  let writes: Promise<unknown> = Promise.resolve();
  let lexicalWrites: Promise<unknown> = Promise.resolve();
  function put(card: ScrapedCard): Promise<'added' | 'updated' | 'unchanged'> {
    const operation = writes.then(() => putSerial(card)); writes = operation.catch(() => undefined); return operation;
  }
  async function putSerial(card: ScrapedCard): Promise<'added' | 'updated' | 'unchanged'> {
    writable();
    if (!/^[a-z0-9-]{1,32}$/.test(card.provider) || !card.recordId || card.recordId.length > 200 || /[\s/]/.test(card.recordId)) throw new NativeArchiveError('INVALID_INPUT', 'A scraped card needs a provider and record ID');
    const containers = card.objects.filter((object) => object.role === 'card');
    if (containers.length !== 1) throw new NativeArchiveError('INVALID_INPUT', 'A scraped card needs exactly one card file');
    const description = describe(card, containers[0]!);
    const path = sourcePath(card), previous = find(card.provider, card.recordId, card.provider === 'ct' ? path : '');
    if (bookkeeping && db.prepare('SELECT 1 FROM unity_archive_blocked WHERE card_id = ? OR (provider = ? AND (record_id IN (?,?) OR (source_path IS NOT NULL AND source_path = ?)))').get(previous?.id ?? null, card.provider, card.recordId, previous ? recordOf(previous) : card.recordId, path)) throw new NativeArchiveError('INVALID_INPUT', 'This Archive card is blocked');
    let id = previous?.id;
    if (!id && card.provider === 'chub') {
      if (!/^[1-9][0-9]*$/.test(card.recordId) || !Number.isSafeInteger(Number(card.recordId))) throw new NativeArchiveError('INVALID_INPUT', 'Chub requires its upstream numeric ID');
      id = Number(card.recordId);
      if (db.prepare('SELECT 1 FROM cards WHERE id = ?').get(id)) throw new NativeArchiveError('INVALID_INPUT', 'The upstream Chub ID is occupied by another source; resolve its numeric identity before writing');
    }
    id ??= numeric((db.prepare('SELECT max(id) AS id FROM cards').get() as { id: number | null }).id) + 1;
    const prior = previous && !previous.current_version ? await baseline(previous, true) : undefined;
    const fingerprint = fingerprintOf(card.objects.filter((object) => object.role !== 'raw').map((object) => ({ role: object.role,
      name: object.name ?? (object.role === 'card' ? `card.${description.containerFormat}` : object.role), sha256: sha256(object.bytes), byteLength: object.bytes.byteLength, mediaType: object.mediaType })));
    const previousFingerprint = previous?.current_version ? (db.prepare('SELECT fingerprint FROM unity_archive_versions WHERE id = ?').get(previous.current_version) as { fingerprint: string }).fingerprint : prior?.fingerprint;
    const unchanged = !!previous && previousFingerprint === fingerprint;
    const refs: ArchiveObjectRef[] = [];
    for (const object of card.objects) {
      // Changing upstream counters do not make a version. Keep the prior raw snapshot with it.
      if (unchanged && object.role === 'raw') continue;
      const name = object.name ?? (object.role === 'card' ? `card.${description.containerFormat}` : object.role);
      if (refs.some((ref) => ref.role === object.role && ref.name === name)) throw new NativeArchiveError('INVALID_INPUT', 'Duplicate scraped file names');
      const hash = sha256(object.bytes);
      const existingLocation = locations.get(hash) ?? db.prepare('SELECT origin,path,sha256,byte_length AS byteLength,media_type AS mediaType FROM unity_archive_objects WHERE sha256 = ?').get(hash) as Location | undefined;
      let location: Location;
      if (existingLocation) {
        // Accepted legacy bytes already live on disk. Refreshing them must not duplicate the corpus.
        remember(existingLocation);
        await readObject(hash);
        location = existingLocation;
      } else {
        await writeObject(object.bytes);
        location = remember({ origin: 'objects', path: `${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`, sha256: hash, byteLength: object.bytes.byteLength, mediaType: object.mediaType });
      }
      refs.push(objectRef(location, object.role, name));
    }
    if (prior) await persistDerived(prior.objects);
    const identity = await archiveContentHash(containers[0]!.bytes, description.document, refs, readObject);
    const at = now();
    return db.transaction(() => {
      register([...(prior?.objects ?? []), ...refs]);
      if (prior) { saveVersion(id!, prior, prior.fingerprint); saveIdentity(id!, prior.id, prior.objects, prior.identity); }
      const values: Record<string, unknown> = { source: card.provider, sourceId: card.recordId, sourcePath: path, sourceUrl: card.url, fullPath: previous ? text(previous.fullPath) : path,
        name: description.name, author: description.creator, tagline: card.tagline ?? '', description: description.description, topics: description.tags.join(','), tokenCount: description.tokens,
        lastModified: iso(card.updatedAt) ?? (previous ? previous.lastModified : at), createdAt: iso(card.createdAt) ?? (previous ? previous.createdAt : at),
        hasAlternateGreetings: +!!description.altGreetings, hasLorebook: +!!description.lorebookEntries, hasGallery: +description.gallery,
        hasEmbeddedImages: +description.embeddedImages, hasExpressions: +description.expressions, hasSystemPrompt: +description.systemPrompt, hasExampleDialogues: +description.examples };
      if (previous) {
        if (providerOf(previous) === 'ct' && (recordOf(previous) !== card.recordId || normalizePath(text(previous.sourcePath)) !== path) && table('card_source_aliases')) db.prepare('INSERT OR IGNORE INTO card_source_aliases(source,source_id,source_path,canonical_card_id,retired_card_id) VALUES (?,?,?,?,NULL)').run('ct', recordOf(previous), text(previous.sourcePath), id!);
        db.prepare(`UPDATE cards SET ${Object.keys(values).map((name) => `${name} = ?`).join(',')} WHERE id = ?`).run(...Object.values(values), id!);
      } else db.prepare(`INSERT INTO cards(id,firstDownloadedAt,favorited,${Object.keys(values).join(',')}) VALUES (?,?,0,${Object.keys(values).map(() => '?').join(',')})`).run(id!, at, ...Object.values(values));
      db.prepare('DELETE FROM card_tags WHERE cardId = ?').run(id!);
      for (const tag of description.tags) db.prepare('INSERT INTO card_tags(cardId,tag,normalizedTag) VALUES (?,?,?)').run(id!, tag, tag.toLowerCase());
      const count = (db.prepare('SELECT count(*) AS n FROM unity_archive_versions WHERE card_id = ?').get(id!) as { n: number }).n;
      const currentVersion = unchanged ? (text(previous?.current_version) || prior!.id) : randomUUID();
      if (!unchanged) saveVersion(id!, { id: currentVersion, sequence: count + 1, fetchedAt: at, remoteUpdatedAt: iso(card.updatedAt), objects: refs }, fingerprint);
      saveIdentity(id!, currentVersion, refs, identity);
      const portraitHash = refs.find((ref) => ref.role === 'portrait')?.sha256 ?? (description.containerFormat === 'png' ? refs.find((ref) => ref.role === 'card')!.sha256 : null);
      db.prepare(`INSERT INTO unity_archive_state(card_id,current_version,spec,alt_greetings,lorebook_entries,portrait_sha256,changed_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(card_id) DO UPDATE SET current_version=excluded.current_version,spec=excluded.spec,alt_greetings=excluded.alt_greetings,lorebook_entries=excluded.lorebook_entries,
        portrait_sha256=excluded.portrait_sha256,changed_at=CASE WHEN current_version=excluded.current_version THEN changed_at ELSE excluded.changed_at END,last_seen_at=excluded.last_seen_at`)
        .run(id!, currentVersion, description.spec, description.altGreetings, description.lorebookEntries, portraitHash, at, at);
      statsUpdate(id!, card.stats);
      return !previous ? 'added' : unchanged ? 'unchanged' : 'updated';
    })();
  }
  function source(provider: string): SourceRecord {
    const row = bookkeeping ? db.prepare('SELECT * FROM unity_archive_sources WHERE provider = ?').get(provider) as Record<string, unknown> | undefined : undefined;
    return row ? { provider, enabled: !!row.enabled, intervalMinutes: numeric(row.interval_minutes), settings: JSON.parse(text(row.settings_json)) as Record<string, unknown>, secrets: JSON.parse(text(row.secrets_json)) as Record<string, string>, updatedAt: text(row.updated_at) }
      : { provider, enabled: false, intervalMinutes: 360, settings: {}, secrets: {}, updatedAt: null };
  }
  const runRow = (row: Record<string, unknown>): RunRecord => ({ id: numeric(row.id), provider: text(row.provider), trigger: text(row.trigger), status: row.status as RunRecord['status'], startedAt: text(row.started_at), finishedAt: text(row.finished_at) || null, error: text(row.error) || null,
    listed: numeric(row.listed), added: numeric(row.added), updated: numeric(row.updated), unchanged: numeric(row.unchanged), skipped: numeric(row.skipped), blocked: numeric(row.blocked), errors: numeric(row.errors) });
  const sink: ScrapeSink = {
    blocked(provider, recordId) { const row = find(provider, recordId); return bookkeeping && !!db.prepare('SELECT 1 FROM unity_archive_blocked WHERE card_id = ? OR (provider = ? AND record_id IN (?,?))').get(row?.id ?? null, provider, recordId, row ? recordOf(row) : recordId); },
    known(provider, recordId) { const row = find(provider, recordId); return row ? { updatedAt: iso(row.lastModified) } : null; },
    seen(provider, recordId, stats) { writable(); const row = find(provider, recordId); if (row) statsUpdate(row.id, stats); }, put,
  };
  if (blacklistEntries.length) db.transaction(() => {
    const add = db.prepare('INSERT OR IGNORE INTO unity_archive_blocked(provider,record_id,reason,blocked_at,card_id,source_path) VALUES (?,?,?,?,?,?)');
    for (const entry of blacklistEntries) {
      const row = find(entry.provider, entry.recordId ?? '', entry.sourcePath ?? '');
      add.run(entry.provider, entry.recordId ?? `path:${entry.sourcePath}`, 'Existing Archive blacklist', now(), row?.id ?? null, entry.sourcePath ?? null);
    }
  })();
  return {
    archiveId, sink, put,
    async list(query: ArchiveQuery = {}) {
      query.signal?.throwIfAborted();
      if (query.sort === 'downloads') throw new NativeArchiveError('INVALID_INPUT', 'The existing Archive has no download-count metric to sort by');
      if (query.mode === 'browse' && query.q?.trim()) throw new NativeArchiveError('INVALID_INPUT', 'Browse mode does not accept query text');
      if (query.mode && query.mode !== 'browse' && !query.q?.trim()) throw new NativeArchiveError('INVALID_INPUT', 'A search mode requires a query');
      const indexed = !!(query.q?.trim() || query.filter || query.mode === 'browse');
      if (indexed && !options.search) throw new ArchiveError('UNAVAILABLE', 'Existing Archive search requires its configured LanceDB index');
      const sourceBefore = databaseGeneration(), indexBefore = indexed ? await options.search!.snapshot() : '';
      const libraryBefore = query.libraryWorkspaceId && options.libraryIndex ? await options.libraryIndex.snapshot() : '';
      const library = query.libraryWorkspaceId && options.libraryIndex ? await options.libraryIndex.search(query.libraryWorkspaceId, query) : undefined;
      if (sourceBefore !== databaseGeneration()) throw new ArchiveError('SNAPSHOT_CHANGED', 'The Archive changed during the search; start from the first page');
      let ids: string[] | undefined;
      let complete = true;
      let browseTotal: number | undefined;
      let scores: Map<string, number> | undefined, matches: Map<string, SearchMatch> | undefined;
      const limit = Math.min(Math.max(query.limit ?? 48, 1), 100), offset = Math.max(query.offset ?? 0, 0);
      const windowOffset = Math.max(0, offset - (library?.cards.length ?? 0)), windowLimit = limit + (library?.cards.length ?? 0);
      if (indexed) {
        const quoted = (value: string) => JSON.stringify(value);
        const searchFilters: string[] = [];
        if (query.filter) searchFilters.push(`(${query.filter})`);
        if (query.provider) searchFilters.push(`source = ${quoted(query.provider)}`);
        if (query.minTokens) searchFilters.push(`tokenCount >= ${query.minTokens}`);
        if (query.tags?.length) searchFilters.push(`(${query.tags.map((tag) => `topics = ${quoted(tag)}`).join(query.tagMode === 'any' ? ' OR ' : ' AND ')})`);
        for (const tag of query.exclude ?? []) searchFilters.push(`NOT (topics = ${quoted(tag)})`);
        const flags = { greetings: 'hasAlternateGreetings', lorebook: 'hasLorebook', gallery: 'hasGallery', embeddedImages: 'hasEmbeddedImages', expressions: 'hasExpressions', systemPrompt: 'hasSystemPrompt', exampleDialogues: 'hasExampleDialogues' };
        for (const flag of query.has ?? []) if (flag !== 'portrait' && flag !== 'followed') searchFilters.push(`${flags[flag]} = true`);
        existingFilter(query, bookkeeping); // Reject unsupported filters before an expensive native query.
        let eligibleIds: string[] | undefined;
        const visibility = existingFilter({}, bookkeeping);
        const excludedIds = bookkeeping ? (db.prepare(`SELECT c.id FROM cards c WHERE NOT (${visibility.clause}) LIMIT 10001`).all(...visibility.params) as { id: number }[]).map((row) => String(row.id)) : [];
        if (excludedIds.length > 10_000) throw new ArchiveError('TOO_LARGE', 'This search has more than 10,000 blocked IDs; narrow its metadata filters');
        if (query.has?.includes('followed')) {
          const creators = [...new Set((query.creators ?? []).map((creator) => creator.trim()).filter(Boolean))];
          if (!creators.length) eligibleIds = [];
          else searchFilters.push(`(${Array.from({ length: Math.ceil(creators.length / 64) }, (_, index) => `author IN [${creators.slice(index * 64, index * 64 + 64).map(quoted).join(',')}]`).join(' OR ')})`);
        }
        const constraints = { filter: searchFilters.join(' AND '), ...(eligibleIds ? { eligibleIds } : {}), ...(excludedIds.length ? { excludedIds } : {}), ...(query.signal ? { signal: query.signal } : {}) };
        if (!query.q?.trim()) {
          const result = await options.search!.browse({ ...constraints, sort: query.sort ?? 'updated', offset: windowOffset, limit: windowLimit,
            ...(library?.cards.length ? { mergeCandidates: true } : {}) });
          ids = result.ids; browseTotal = result.total;
        } else {
          const result = await options.search!.search(query.q, { ...constraints, mode: query.mode === 'browse' ? 'lexical' : query.mode ?? 'lexical' });
          ids = result.ids; complete = result.complete; scores = result.scores; matches = result.matches;
        }
      }
      const filter = existingFilter(query, bookkeeping, ids);
      const total = browseTotal ?? (db.prepare(`SELECT count(*) AS n FROM cards c ${stateJoin} WHERE ${filter.clause}`).get(...filter.params) as { n: number }).n;
      const ranked = !!ids?.length && (browseTotal !== undefined || (!!query.mode && query.mode !== 'lexical' && !query.sort));
      const order = ranked ? `CASE c.id ${ids!.map((_, index) => `WHEN CAST(? AS INTEGER) THEN ${index}`).join(' ')} END` : existingSort[query.sort ?? 'updated'];
      const rows = db.prepare(`${selected} WHERE ${filter.clause} ORDER BY ${order},c.id DESC LIMIT ? OFFSET ?`).all(...filter.params, ...(ranked ? ids! : []), windowLimit, browseTotal !== undefined ? 0 : windowOffset) as Row[];
      if (browseTotal !== undefined && rows.length !== ids!.length) throw new ArchiveError('INTEGRITY', 'The existing search index and Archive metadata disagree; refresh the index before browsing this subset');
      const merged = mergeSearchPage(query, rows.map((row) => ({ card: summary(row), row })), library?.cards ?? [],
        scores, library?.scores, offset - windowOffset, limit);
      const selectedRows = new Map(rows.map((row) => [String(row.id), row]));
      const cards: (ArchiveCardSummary | LibrarySearchCard)[] = [];
      for (let index = 0; index < merged.length; index += 4) cards.push(...await Promise.all(merged.slice(index, index + 4).map(async (card) =>
        'libraryOwned' in card ? card : { ...card, portrait: await portrait(selectedRows.get(card.id)!) })));
      query.signal?.throwIfAborted();
      if (sourceBefore !== databaseGeneration() || (indexed && indexBefore !== await options.search!.snapshot())) throw new ArchiveError('SNAPSHOT_CHANGED', 'The Archive changed during the search; start from the first page');
      if (query.libraryWorkspaceId && options.libraryIndex && libraryBefore !== await options.libraryIndex.snapshot()) throw new ArchiveError('SNAPSHOT_CHANGED', 'Library projections changed during the search; start from the first page');
      const combinedScores = scores ? new Map([...scores, ...library?.scores ?? []]) : undefined;
      const combinedMatches = new Map([...matches ?? [], ...library?.matches ?? []]);
      const snapshot = searchSnapshot(query, `${archiveId}:${sourceBefore}:${indexBefore}:${library?.snapshot ?? ''}`, combinedScores ? [...combinedScores] : undefined);
      if (query.snapshot && query.snapshot !== snapshot) throw new ArchiveError('SNAPSHOT_CHANGED', 'The Archive, ranking or query changed; start from the first page');
      return { cards, total: total + (library?.cards.length ?? 0), complete: complete && (library?.complete ?? true), snapshot,
        ...(combinedScores ? { scores: cards.map((card) => combinedScores.get(card.id) ?? 0), matches: cards.map((card) => combinedMatches.get(card.id) ?? null) } : {}) };
    },
    async card(id: string, versionId?: string): Promise<ArchiveCardDetail & { archiveId: string }> {
      const row = visible(id);
      if (!row.current_version) {
        const version = await baseline(row), description = version.description;
        if (versionId !== undefined && versionId !== version.id) throw new NativeArchiveError('NOT_FOUND', 'This exact Archive version is unavailable; the source file changed');
        const publicVersion: ArchiveVersion = { id: version.id, sequence: version.sequence, fetchedAt: version.fetchedAt, remoteUpdatedAt: version.remoteUpdatedAt, objects: version.objects };
        const container = version.objects.find((ref) => ref.role === 'card');
        return { ...(versionId === undefined ? summary(row) : pinnedSummary(summary(row), description, publicVersion)), archiveId,
          portrait: version.objects.find((ref) => ref.role === 'portrait')?.sha256 ?? (container?.mediaType === 'image/png' ? container.sha256 : null), versionId: version.id,
          spec: description.spec === 'v3' ? 'v3' : 'v2', document: description.document, versionList: [publicVersion] };
      }
      const versionList = (db.prepare('SELECT id,sequence,fetched_at AS fetchedAt,remote_updated_at AS remoteUpdatedAt FROM unity_archive_versions WHERE card_id = ? ORDER BY sequence DESC').all(row.id) as Omit<ArchiveVersion, 'objects'>[]).map((version) => ({ ...version, objects: versionObjects(version.id) }));
      const version = versionList.find((item) => item.id === (versionId ?? row.current_version));
      if (!version) throw new NativeArchiveError('NOT_FOUND', 'This Archive version is unavailable');
      const container = version.objects.find((ref) => ref.role === 'card');
      if (!container) throw new NativeArchiveError('UNSUPPORTED_FORMAT', 'Archive version has no card file');
      const object = await readObject(container.sha256), description = describe({ provider: providerOf(row), recordId: recordOf(row), url: text(row.sourceUrl), objects: [] }, { role: 'card', ...object });
      return { ...(versionId === undefined ? summary(row) : pinnedSummary(summary(row), description, version)), archiveId, versionId: version.id, portrait: version.objects.find((ref) => ref.role === 'portrait')?.sha256
        ?? (container.mediaType === 'image/png' ? container.sha256 : null), document: description.document, versionList };
    },
    async files(id: string, versionId?: string) {
      const row = visible(id);
      if (row.current_version) {
        const selectedVersion = versionId ?? text(row.current_version);
        if (!db.prepare('SELECT 1 FROM unity_archive_versions WHERE id = ? AND card_id = ?').get(selectedVersion, row.id)) throw new NativeArchiveError('NOT_FOUND', 'This Archive version is unavailable');
        return versionObjects(selectedVersion);
      }
      const version = await baseline(row);
      if (versionId !== undefined && versionId !== version.id) throw new NativeArchiveError('NOT_FOUND', 'This exact Archive version is unavailable; the source file changed');
      return version.objects;
    },
    /** Indexed lookups plus at most 32 lazy legacy candidates; a partial miss is never authoritative. */
    async identity(query: ArchiveIdentityQuery): Promise<ArchiveIdentityResult> {
      try { validateIdentityQuery(query); } catch { throw new NativeArchiveError('INVALID_INPUT', 'Invalid Archive identity lookup'); }
      const filter = existingFilter({}, bookkeeping);
      if (query.name !== undefined) {
        const candidates = db.prepare(`${selected} WHERE ${filter.clause} AND c.name = ?${bookkeeping ? ' AND s.current_version IS NULL' : ''}
          ${identityIndex ? `AND NOT EXISTS (SELECT 1 FROM unity_archive_identities i WHERE i.card_id = c.id AND i.legacy_stamp = ${legacyStamp})` : ''}
          ORDER BY c.id LIMIT 32`).all(...filter.params, query.name) as Row[];
        for (const candidate of candidates) {
          try { await baseline(candidate, true); }
          catch (error) { if (!(error instanceof NativeArchiveError && error.code === 'UNSUPPORTED_FORMAT')) throw error; }
        }
      }
      const select = `SELECT c.id AS cardId,i.version_id AS versionId,i.file_hash AS fileHash,i.content_hash AS contentHash,
        coalesce(c.source,'chub') AS provider,coalesce(nullif(c.sourceId,''),CAST(c.id AS TEXT)) AS recordId,coalesce(c.sourceUrl,'') AS url
        FROM unity_archive_identities i JOIN cards c ON c.id = i.card_id ${stateJoin}
        WHERE ${filter.clause} AND (i.legacy_stamp IS NULL OR (s.current_version IS NULL AND i.legacy_stamp = ${legacyStamp}))`;
      let indexed = identityIndex && query.fileHash ? db.prepare(`${select} AND i.file_hash = ? ORDER BY c.id,i.version_id LIMIT 101`).all(...filter.params, query.fileHash) as Omit<ArchiveIdentityMatch, 'matchedBy'>[] : [];
      if (!indexed.length && bookkeeping && query.fileHash) indexed = db.prepare(`SELECT c.id AS cardId,v.id AS versionId,vo.sha256 AS fileHash,NULL AS contentHash,
        coalesce(c.source,'chub') AS provider,coalesce(nullif(c.sourceId,''),CAST(c.id AS TEXT)) AS recordId,coalesce(c.sourceUrl,'') AS url
        FROM unity_archive_version_objects vo JOIN unity_archive_versions v ON v.id = vo.version_id JOIN cards c ON c.id = v.card_id
        WHERE ${filter.clause} AND vo.role = 'card' AND vo.sha256 = ? ORDER BY c.id,v.sequence LIMIT 101`).all(...filter.params, query.fileHash) as Omit<ArchiveIdentityMatch, 'matchedBy'>[];
      if (!indexed.length && identityIndex && query.contentHash) indexed = db.prepare(`${select} AND i.content_hash = ? ORDER BY c.id,i.version_id LIMIT 101`).all(...filter.params, query.contentHash) as Omit<ArchiveIdentityMatch, 'matchedBy'>[];
      const candidates = new Map(indexed.map((entry) => [entry.versionId, { ...entry, cardId: String(entry.cardId) }]));
      for (const entry of observedIdentities.values()) {
        if (entry.fileHash !== query.fileHash && (!query.contentHash || entry.contentHash !== query.contentHash)) continue;
        let row: Row;
        try { row = visible(entry.cardId); } catch (error) { if (error instanceof NativeArchiveError && error.code === 'NOT_FOUND') continue; throw error; }
        candidates.set(entry.versionId, { ...entry, provider: providerOf(row), recordId: recordOf(row), url: text(row.sourceUrl) });
      }
      const all = [...candidates.values()].sort((a, b) => Number(a.cardId) - Number(b.cardId) || a.versionId.localeCompare(b.versionId));
      const exact = query.fileHash ? all.filter((entry) => entry.fileHash === query.fileHash) : [];
      const matchedBy = exact.length ? 'bytes' as const : 'content' as const;
      const matches = exact.length ? exact : all.filter((entry) => !!query.contentHash && entry.contentHash === query.contentHash);
      let complete = identityIndex;
      let unresolvedCount = identityIndex ? 0 : (db.prepare(`SELECT count(*) AS n FROM cards c WHERE ${filter.clause}`).get(...filter.params) as { n: number }).n;
      if (complete) {
        const unresolved = query.contentHash ? ` OR (i.content_hash IS NULL${query.name === undefined ? '' : ' AND (i.content_name IS NULL OR i.content_name = ?)'} )` : '';
        const nameArgs = query.contentHash && query.name !== undefined ? [query.name] : [];
        const missingLegacy = (db.prepare(`SELECT count(*) AS n FROM cards c ${stateJoin} WHERE ${filter.clause} AND s.current_version IS NULL
          AND NOT EXISTS (SELECT 1 FROM unity_archive_identities i WHERE i.card_id = c.id AND i.legacy_stamp = ${legacyStamp})`).get(...filter.params) as { n: number }).n;
        const unknownLegacy = query.contentHash ? (db.prepare(`SELECT count(*) AS n FROM cards c ${stateJoin} JOIN unity_archive_identities i ON i.card_id = c.id
          WHERE ${filter.clause} AND s.current_version IS NULL AND i.legacy_stamp = ${legacyStamp} AND i.content_hash IS NULL
          ${query.name === undefined ? '' : 'AND (i.content_name IS NULL OR i.content_name = ?)'}`).get(...filter.params, ...nameArgs) as { n: number }).n : 0;
        const missingVersion = (db.prepare(`SELECT count(*) AS n FROM unity_archive_versions v JOIN cards c ON c.id = v.card_id LEFT JOIN unity_archive_identities i ON i.version_id = v.id
          WHERE ${filter.clause} AND (i.version_id IS NULL${unresolved})`).get(...filter.params, ...nameArgs) as { n: number }).n;
        unresolvedCount = missingLegacy + unknownLegacy + missingVersion;
        complete = !missingLegacy && !unknownLegacy && !missingVersion;
      }
      return { archiveId, matches: matches.slice(0, 100).map((entry) => ({ ...entry, matchedBy })), complete: complete && matches.length <= 100 && indexed.length <= 100, unresolved: unresolvedCount };
    },
    /** Explicit operator work only. Cursor checkpoints are metadata; original files are never copied. */
    async indexIdentities(options: { limit?: number; after?: string } = {}): Promise<{ processed: number; unavailable: number; nextAfter: string | null; complete: boolean }> {
      writable();
      options = { ...options };
      const operation = writes.then(async () => {
      const limit = options.limit ?? 16;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new NativeArchiveError('INVALID_INPUT', 'Identity index batches contain 1–100 versions');
      let afterId = 0, afterSequence = -1;
      if (options.after !== undefined) {
        try {
          const parsed: unknown = JSON.parse(Buffer.from(options.after, 'base64url').toString('utf8'));
          if (!Array.isArray(parsed) || parsed.length !== 2 || !Number.isSafeInteger(parsed[0]) || parsed[0] < 1 || !Number.isSafeInteger(parsed[1]) || parsed[1] < 0) throw new Error();
          [afterId, afterSequence] = parsed as [number, number];
        } catch { throw new NativeArchiveError('INVALID_INPUT', 'Invalid identity index cursor'); }
      }
      const filter = existingFilter({}, bookkeeping);
      const jobs = db.prepare(`SELECT * FROM (
        SELECT c.id AS cardId,NULL AS versionId,0 AS sequence,${legacyStamp} AS stamp FROM cards c ${stateJoin}
          WHERE ${filter.clause} AND s.current_version IS NULL AND NOT EXISTS (SELECT 1 FROM unity_archive_identities i WHERE i.card_id = c.id AND i.legacy_stamp = ${legacyStamp})
        UNION ALL SELECT c.id AS cardId,v.id AS versionId,v.sequence,NULL AS stamp FROM unity_archive_versions v JOIN cards c ON c.id = v.card_id
          WHERE ${filter.clause} AND NOT EXISTS (SELECT 1 FROM unity_archive_identities i WHERE i.version_id = v.id)
        ) WHERE cardId > ? OR (cardId = ? AND sequence > ?) ORDER BY cardId,sequence LIMIT ?`)
        .all(...filter.params, ...filter.params, afterId, afterId, afterSequence, limit + 1) as { cardId: number; versionId: string | null; sequence: number; stamp: string | null }[];
      let unavailable = 0;
      for (const job of jobs.slice(0, limit)) {
        const row = visible(String(job.cardId));
        if (job.versionId === null) {
          const version = await baseline(row, true);
          const currentStamp = (db.prepare(`SELECT ${legacyStamp} AS stamp FROM cards c WHERE c.id = ?`).get(job.cardId) as { stamp: string }).stamp;
          if (currentStamp !== job.stamp) throw new Error('Archive metadata changed during identity indexing; retry this batch');
          saveIdentity(job.cardId, version.id, version.objects, version.identity, job.stamp);
          unavailable += +!version.identity.hash;
        } else {
          const refs = versionObjects(job.versionId), container = refs.find((ref) => ref.role === 'card');
          if (!container) throw new NativeArchiveError('UNSUPPORTED_FORMAT', 'This Archive version has no card file');
          const object = await readObject(container.sha256);
          const identity = await archiveContentHash(object.bytes, undefined, refs, readObject);
          saveIdentity(job.cardId, job.versionId, refs, identity);
          unavailable += +!identity.hash;
        }
      }
      const last = jobs[Math.min(jobs.length, limit) - 1];
      return { processed: Math.min(jobs.length, limit), unavailable, nextAfter: jobs.length > limit && last ? Buffer.from(JSON.stringify([last.cardId, last.sequence])).toString('base64url') : null, complete: jobs.length <= limit };
      });
      writes = operation.catch(() => undefined);
      return operation;
    },
    object: readObject,
    tags(limit = 2000) {
      const filter = existingFilter({}, bookkeeping);
      return db.prepare(`SELECT min(t.tag) AS tag,count(*) AS count FROM card_tags t JOIN cards c ON c.id = t.cardId WHERE ${filter.clause} GROUP BY t.normalizedTag ORDER BY count DESC,t.normalizedTag LIMIT ?`).all(limit) as { tag: string; count: number }[];
    },
    status() {
      const filter = existingFilter({}, bookkeeping), providers = Object.fromEntries((db.prepare(`SELECT coalesce(c.source,'chub') AS provider,count(*) AS n FROM cards c WHERE ${filter.clause} GROUP BY coalesce(c.source,'chub')`).all() as { provider: string; n: number }[]).map((row) => [row.provider, row.n]));
      return { archiveId, cards: Object.values(providers).reduce((sum, n) => sum + n, 0), providers, blocked: bookkeeping ? (db.prepare('SELECT count(*) AS n FROM unity_archive_blocked').get() as { n: number }).n : 0,
        lastChangedAt: (db.prepare('SELECT max(lastModified) AS at FROM cards').get() as { at: string | null }).at, readOnly: readonly,
        capabilities };
    },
    block(provider: string, recordId: string, reason = 'Removed from the Archive') { writable(); const row = find(provider, recordId); db.prepare('INSERT OR REPLACE INTO unity_archive_blocked(provider,record_id,reason,blocked_at,card_id) VALUES (?,?,?,?,?)').run(provider, recordId, reason.slice(0, 500), now(), row?.id ?? null); },
    unblock(provider: string, recordId: string) { writable(); const row = find(provider, recordId); db.prepare('DELETE FROM unity_archive_blocked WHERE card_id = ? OR (provider = ? AND record_id = ?)').run(row?.id ?? null, provider, recordId); },
    source,
    saveSource(record: Omit<SourceRecord, 'updatedAt'>) { writable(); db.prepare('INSERT OR REPLACE INTO unity_archive_sources(provider,enabled,interval_minutes,settings_json,secrets_json,updated_at) VALUES (?,?,?,?,?,?)').run(record.provider, +record.enabled, record.intervalMinutes, JSON.stringify(record.settings), JSON.stringify(record.secrets), now()); return source(record.provider); },
    startRun(provider: string, trigger: string) { writable(); return Number(db.prepare("INSERT INTO unity_archive_runs(provider,trigger,status,started_at) VALUES (?,?,'running',?)").run(provider, trigger, now()).lastInsertRowid); },
    progressRun(id: number, counts: RunCounts) { writable(); db.prepare('UPDATE unity_archive_runs SET listed=?,added=?,updated=?,unchanged=?,skipped=?,blocked=?,errors=? WHERE id=?').run(counts.listed, counts.added, counts.updated, counts.unchanged, counts.skipped, counts.blocked, counts.errors, id); },
    finishRun(id: number, result: RunResult) { writable(); db.prepare('UPDATE unity_archive_runs SET status=?,finished_at=?,listed=?,added=?,updated=?,unchanged=?,skipped=?,blocked=?,errors=?,error=? WHERE id=?').run(result.status, now(), result.listed, result.added, result.updated, result.unchanged, result.skipped, result.blocked, result.errors, result.error?.slice(0, 2000) ?? null, id); },
    runs(provider?: string, limit = 20) { if (!bookkeeping) return []; const rows = provider ? db.prepare('SELECT * FROM unity_archive_runs WHERE provider = ? ORDER BY id DESC LIMIT ?').all(provider, limit) : db.prepare('SELECT * FROM unity_archive_runs ORDER BY id DESC LIMIT ?').all(limit); return rows.map((row) => runRow(row as Record<string, unknown>)); },
    lastFinishedRun(provider: string) { if (!bookkeeping) return null; const row = db.prepare("SELECT * FROM unity_archive_runs WHERE provider = ? AND status != 'running' ORDER BY id DESC LIMIT 1").get(provider) as Record<string, unknown> | undefined; return row ? runRow(row) : null; },
    flushVectorQueue(limit = 100, signal?: AbortSignal) { writable(); return vectorQueue(limit, signal); },
    /** Existing trigger queue -> existing Lance table. A failed write keeps every exact queue row. */
    async flushSearchQueue(limit = 100) {
      writable();
      const operation = lexicalWrites.then(async () => {
      if (!options.search || !table('search_index_queue')) return { processed: 0 };
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512) throw new NativeArchiveError('INVALID_INPUT', 'Search queue batches must contain 1–512 rows');
      const rows = db.prepare('SELECT * FROM search_index_queue ORDER BY id LIMIT ?').all(limit) as { id: number; cardId: string | number; action: string }[];
      if (!rows.length) return { processed: 0 };
      const jobs = new Map(rows.map((row) => [String(row.cardId), row.action]));
      const upserts: Record<string, unknown>[] = [], deletes: string[] = [], snapshots = new Map<string, string>();
      for (const [id] of jobs) {
        if (!/^[1-9][0-9]*$/.test(id)) throw new Error('Existing search queue contains a malformed numeric card ID; repair that queued record before draining');
        // The current authoritative row wins if an older delete was followed by a reinsert.
        const row = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as Record<string, unknown> | undefined;
        snapshots.set(id, JSON.stringify(row ?? null));
        if (row) upserts.push(row); else deletes.push(id);
      }
      if (deletes.length) await options.search.deleteDocuments(deletes);
      if (upserts.length) await options.search.upsertDocuments(upserts);
      const processed = db.transaction(() => {
        let acknowledged = 0;
        for (const row of rows) {
          const current = db.prepare('SELECT * FROM cards WHERE id = ?').get(row.cardId) as Record<string, unknown> | undefined;
          const queued = db.prepare('SELECT * FROM search_index_queue WHERE id = ?').get(row.id);
          if (JSON.stringify(current ?? null) === snapshots.get(String(row.cardId)) && JSON.stringify(queued) === JSON.stringify(row)) acknowledged += db.prepare('DELETE FROM search_index_queue WHERE id = ?').run(row.id).changes;
        }
        return acknowledged;
      })();
      return { processed };
      });
      lexicalWrites = operation.catch(() => undefined);
      return operation;
    },
    close() { db.close(); locations.clear(); retainedBytes = 0; if (lockPath) { try { if (readFileSync(lockPath, 'utf8') === lockToken) unlinkSync(lockPath); } catch (error) { if (!missing(error)) throw error; } } void options.search?.close(); void options.libraryIndex?.close(); },
  };
}
export type ExistingArchive = Awaited<ReturnType<typeof openExistingArchive>>;
