import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseCard } from '@character-foundry/character-foundry/loader';
import { GptTokenizer } from '@character-foundry/character-foundry/tokenizers';
import { isPlaceholderImage } from '@character-unity/scraper-kit';
import type { RunCounts, RunResult, ScrapedCard, ScrapedObject, ScrapeSink, SourceStats } from '@character-unity/scraper-kit';
import { createObjectStore, sha256 } from './objects.js';
import { nativeSchema, nativeSchemaVersion } from './schema.js';
import { archiveFilterSql, archiveSortSql } from './query.js';
import type { ArchiveQuery } from './query.js';

export class NativeArchiveError extends Error {
  constructor(public readonly code: 'NOT_FOUND' | 'INVALID_INPUT' | 'UNSUPPORTED_FORMAT', message: string) {
    super(message);
    this.name = 'NativeArchiveError';
  }
}

export interface ArchiveCardSummary {
  id: string; provider: string; recordId: string; url: string;
  name: string; creator: string; tagline: string; tags: string[]; spec: 'v2' | 'v3'; tokens: number;
  altGreetings: number; lorebookEntries: number;
  flags: { gallery: boolean; expressions: boolean; embeddedImages: boolean; systemPrompt: boolean; exampleDialogues: boolean };
  stats: SourceStats;
  /** Digest of the portrait object, for the image URL (null when the card has none). */
  portrait: string | null;
  remoteCreatedAt: string | null; remoteUpdatedAt: string | null;
  firstSeenAt: string; changedAt: string; versionId: string; versions: number;
}
export interface ArchiveObjectRef { role: ScrapedObject['role']; name: string; sha256: string; mediaType: string; byteLength: number }
export interface ArchiveVersion { id: string; sequence: number; fetchedAt: string; remoteUpdatedAt: string | null; objects: ArchiveObjectRef[] }
export interface ArchiveCardDetail extends ArchiveCardSummary { document: unknown; versionList: ArchiveVersion[] }
export interface SourceRecord { provider: string; enabled: boolean; intervalMinutes: number; settings: Record<string, unknown>; secrets: Record<string, string>; updatedAt: string | null }
export interface RunRecord extends RunCounts { id: number; provider: string; trigger: string; status: 'running' | RunResult['status']; startedAt: string; finishedAt: string | null; error: string | null }

const fields = ['description', 'personality', 'scenario', 'mes_example', 'first_mes', 'system_prompt', 'post_history_instructions'] as const;
const text = (value: unknown) => typeof value === 'string' ? value : '';
let tokenizer: GptTokenizer | null = null;

type Row = Record<string, unknown> & { id: string; provider: string; record_id: string; name: string; creator: string; tagline: string; tags_json: string;
  url: string; spec: string; tokens: number; alt_greetings: number; lorebook_entries: number; has_gallery: number; has_expressions: number;
  has_embedded_images: number; has_system_prompt: number; has_examples: number; portrait_sha256: string | null;
  stars: number | null; favorites: number | null; chats: number | null; messages: number | null; downloads: number | null; rating: number | null;
  remote_created_at: string | null; remote_updated_at: string | null; first_seen_at: string; changed_at: string; version_id: string; versions: number };

function summary(row: Row): ArchiveCardSummary {
  const stats: SourceStats = {};
  for (const key of ['stars', 'favorites', 'chats', 'messages', 'downloads', 'rating'] as const) if (row[key] !== null) stats[key] = row[key] as number;
  return {
    id: row.id, provider: row.provider, recordId: row.record_id, url: row.url, name: row.name, creator: row.creator, tagline: row.tagline,
    tags: JSON.parse(row.tags_json) as string[], spec: row.spec === 'v3' ? 'v3' : 'v2', tokens: row.tokens,
    altGreetings: row.alt_greetings, lorebookEntries: row.lorebook_entries,
    flags: { gallery: !!row.has_gallery, expressions: !!row.has_expressions, embeddedImages: !!row.has_embedded_images,
      systemPrompt: !!row.has_system_prompt, exampleDialogues: !!row.has_examples },
    stats, portrait: row.portrait_sha256, remoteCreatedAt: row.remote_created_at, remoteUpdatedAt: row.remote_updated_at,
    firstSeenAt: row.first_seen_at, changedAt: row.changed_at, versionId: row.version_id, versions: row.versions,
  };
}

const iso = (value: string | undefined) => {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const count = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Fields read from the card file itself, so every source is summarised the same way. */
function describe(card: ScrapedCard, container: ScrapedObject) {
  let parsed: ReturnType<typeof parseCard>;
  try {
    parsed = parseCard(container.bytes, { maxFileSize: 64 * 1024 * 1024, maxAssetSize: 64 * 1024 * 1024, maxTotalSize: 64 * 1024 * 1024, extractAssets: true });
  } catch (error) {
    throw new NativeArchiveError('UNSUPPORTED_FORMAT', `The ${card.provider} card ${card.recordId} is not a readable character card: ${error instanceof Error ? error.message : String(error)}`);
  }
  const data = parsed.card.data as unknown as Record<string, unknown>;
  const alternate = Array.isArray(data.alternate_greetings) ? data.alternate_greetings.filter((value) => typeof value === 'string' && value.trim()) : [];
  const book = data.character_book as { entries?: unknown } | undefined;
  const entries = Array.isArray(book?.entries) ? book.entries.length : 0;
  const linked = card.objects.filter((object) => object.role === 'asset' && object.name?.startsWith('lorebook/')).length;
  const extensions = (data.extensions ?? {}) as Record<string, unknown>;
  const expressionMap = (value: unknown) => !!value && typeof value === 'object' && Object.keys(value).length > 0;
  const assets = Array.isArray(data.assets) ? data.assets as { type?: unknown }[] : [];
  const imageText = [...fields.map((field) => text(data[field])), ...alternate.map(text)].join('\n');
  tokenizer ??= new GptTokenizer();
  const tokens = fields.reduce((sum, field) => sum + (text(data[field]) ? tokenizer!.count(text(data[field])) : 0), 0);
  const tags = new Map<string, string>();
  for (const tag of [...(card.tags ?? []), ...(Array.isArray(data.tags) ? data.tags : [])]) {
    if (typeof tag === 'string' && tag.trim() && !tags.has(tag.trim().toLowerCase())) tags.set(tag.trim().toLowerCase(), tag.trim().slice(0, 120));
  }
  const embeddedPortrait = parsed.assets.some((asset) => asset.isMain && asset.type === 'icon') || parsed.containerFormat === 'png';
  return {
    spec: parsed.spec === 'v3' ? 'v3' : 'v2',
    name: (text(data.name) || card.name || card.recordId).slice(0, 500),
    creator: (card.creator?.trim() || text(data.creator).trim()).slice(0, 200),
    description: text(data.description).slice(0, 50_000),
    tags: [...tags.values()].slice(0, 200),
    tokens,
    altGreetings: alternate.length,
    lorebookEntries: entries || linked,
    gallery: !!card.flags?.gallery || assets.some((asset) => typeof asset.type === 'string' && !['icon', 'emotion', 'expression'].includes(asset.type)),
    expressions: !!card.flags?.expressions || assets.some((asset) => asset.type === 'emotion' || asset.type === 'expression')
      || expressionMap((extensions.chub as Record<string, unknown> | undefined)?.expressions) || expressionMap(extensions.expressions),
    embeddedImages: /!\[|<img\b/i.test(imageText),
    systemPrompt: !!text(data.system_prompt).trim(),
    examples: !!text(data.mes_example).trim(),
    embeddedPortrait,
    document: parsed.originalShape,
    containerFormat: parsed.containerFormat,
  };
}

/**
 * The native Archive: its own SQLite database and object files under one directory. Scrapes append
 * versions; fetched bytes are never rewritten or removed. Everything else in the app reads it.
 */
export async function openNativeArchive(directory: string, options: { now?: () => string } = {}) {
  const root = resolve(directory);
  await mkdir(join(root, 'objects'), { recursive: true });
  const now = options.now ?? (() => new Date().toISOString());
  const objects = createObjectStore(join(root, 'objects'));
  const db = new Database(join(root, 'archive.sqlite'));
  db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON'); db.pragma('busy_timeout = 15000');
  db.exec(nativeSchema);
  const meta = (key: string) => (db.prepare('SELECT value FROM archive_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  const version = meta('schema_version');
  if (version && Number(version) > nativeSchemaVersion) throw new Error(`This Archive was written by a newer version (schema ${version})`);
  db.prepare('INSERT OR REPLACE INTO archive_meta (key, value) VALUES (?, ?)').run('schema_version', String(nativeSchemaVersion));
  if (!meta('archive_id')) db.prepare('INSERT INTO archive_meta (key, value) VALUES (?, ?)').run('archive_id', `archive-${randomUUID()}`);
  const archiveId = meta('archive_id')!;
  // A run still marked running belonged to a process that stopped.
  db.prepare("UPDATE runs SET status = 'failed', finished_at = ?, error = coalesce(error, 'The Archive stopped during this run') WHERE status = 'running'").run(now());

  const statements = {
    card: db.prepare('SELECT * FROM cards WHERE id = ?'),
    byRecord: db.prepare('SELECT id, remote_updated_at, version_id, versions, portrait_sha256 FROM cards WHERE provider = ? AND record_id = ?'),
    blocked: db.prepare('SELECT 1 FROM blocked WHERE provider = ? AND record_id = ?'),
    versionObjects: db.prepare('SELECT vo.role, vo.name, vo.sha256, vo.media_type AS mediaType, o.byte_length AS byteLength FROM version_objects vo JOIN objects o ON o.sha256 = vo.sha256 WHERE vo.version_id = ? ORDER BY vo.role, vo.name'),
    fingerprint: db.prepare('SELECT fingerprint FROM versions WHERE id = ?'),
    object: db.prepare('SELECT sha256, byte_length AS byteLength, media_type AS mediaType FROM objects WHERE sha256 = ?'),
  };
  const objectsOf = (versionId: string) => statements.versionObjects.all(versionId) as ArchiveObjectRef[];

  function statsUpdate(id: string, stats: SourceStats | undefined, seenAt: string) {
    db.prepare(`UPDATE cards SET last_seen_at = ?, stars = coalesce(?, stars), favorites = coalesce(?, favorites), chats = coalesce(?, chats),
      messages = coalesce(?, messages), downloads = coalesce(?, downloads), rating = coalesce(?, rating) WHERE id = ?`)
      .run(seenAt, count(stats?.stars), count(stats?.favorites), count(stats?.chats), count(stats?.messages), count(stats?.downloads), count(stats?.rating), id);
  }

  async function put(card: ScrapedCard): Promise<'added' | 'updated' | 'unchanged'> {
    if (!/^[a-z0-9-]{1,32}$/.test(card.provider) || !card.recordId || card.recordId.length > 200 || /[\s/]/.test(card.recordId)) {
      throw new NativeArchiveError('INVALID_INPUT', 'A scraped card needs a provider and a record ID without spaces or slashes');
    }
    const containers = card.objects.filter((object) => object.role === 'card');
    if (containers.length !== 1) throw new NativeArchiveError('INVALID_INPUT', 'A scraped card needs exactly one card file');
    const described = describe(card, containers[0]!);
    const id = `${card.provider}:${card.recordId}`;
    const existing = statements.byRecord.get(card.provider, card.recordId) as { id: string; remote_updated_at: string | null; version_id: string; versions: number; portrait_sha256: string | null } | undefined;
    // Store every fetched file; identical bytes are stored once.
    const refs: { role: ScrapedObject['role']; name: string; sha256: string; mediaType: string; byteLength: number }[] = [];
    for (const object of card.objects) {
      const name = (object.name ?? (object.role === 'card' ? `card.${described.containerFormat}` : object.role)).slice(0, 200);
      if (refs.some((ref) => ref.role === object.role && ref.name === name)) throw new NativeArchiveError('INVALID_INPUT', `Two ${object.role} files named ${name}`);
      refs.push({ role: object.role, name, sha256: await objects.put(object.bytes), mediaType: object.mediaType.slice(0, 100) || 'application/octet-stream', byteLength: object.bytes.byteLength });
    }
    // A placeholder portrait never replaces a real one the Archive already holds.
    const portraitIndex = refs.findIndex((ref) => ref.role === 'portrait');
    if (portraitIndex >= 0 && existing?.portrait_sha256 && existing.portrait_sha256 !== refs[portraitIndex]!.sha256) {
      const incoming = card.objects.find((object) => object.role === 'portrait')!;
      if (isPlaceholderImage(incoming.bytes)) {
        const kept = statements.object.get(existing.portrait_sha256) as { sha256: string; byteLength: number; mediaType: string } | undefined;
        if (kept && !isPlaceholderImage(await objects.get(kept.sha256))) refs[portraitIndex] = { ...refs[portraitIndex]!, sha256: kept.sha256, mediaType: kept.mediaType, byteLength: kept.byteLength };
      }
    }
    const portrait = refs.find((ref) => ref.role === 'portrait')?.sha256
      ?? (described.embeddedPortrait ? refs.find((ref) => ref.role === 'card')!.sha256 : null);
    // The source's own record (stats, timestamps) changes all the time; only the card, portrait and assets make a new version.
    const fingerprint = sha256(JSON.stringify(refs.filter((ref) => ref.role !== 'raw').map((ref) => [ref.role, ref.name, ref.sha256]).sort()));
    const at = now();
    const remoteUpdated = iso(card.updatedAt);
    return db.transaction((): 'added' | 'updated' | 'unchanged' => {
      for (const ref of refs) db.prepare('INSERT OR IGNORE INTO objects (sha256, byte_length, media_type, created_at) VALUES (?, ?, ?, ?)').run(ref.sha256, ref.byteLength, ref.mediaType, at);
      if (existing && (statements.fingerprint.get(existing.version_id) as { fingerprint: string }).fingerprint === fingerprint) {
        statsUpdate(existing.id, card.stats, at);
        if (remoteUpdated) db.prepare('UPDATE cards SET remote_updated_at = ? WHERE id = ?').run(remoteUpdated, existing.id);
        return 'unchanged';
      }
      const versionId = randomUUID(), sequence = (existing?.versions ?? 0) + 1;
      const values = {
        id, provider: card.provider, record_id: card.recordId, name: described.name, creator: described.creator,
        tagline: (card.tagline ?? '').slice(0, 1000), description: described.description, tags: described.tags.join(', '), tags_json: JSON.stringify(described.tags),
        url: card.url.slice(0, 2000), spec: described.spec, tokens: described.tokens, alt_greetings: described.altGreetings, lorebook_entries: described.lorebookEntries,
        has_gallery: +described.gallery, has_expressions: +described.expressions, has_embedded_images: +described.embeddedImages,
        has_system_prompt: +described.systemPrompt, has_examples: +described.examples, portrait_sha256: portrait,
        stars: count(card.stats?.stars), favorites: count(card.stats?.favorites), chats: count(card.stats?.chats), messages: count(card.stats?.messages),
        downloads: count(card.stats?.downloads), rating: count(card.stats?.rating),
        remote_created_at: iso(card.createdAt), remote_updated_at: remoteUpdated, seen: at, version_id: versionId, versions: sequence,
      };
      if (existing) {
        db.prepare(`UPDATE cards SET name = @name, creator = @creator, tagline = @tagline, description = @description, tags = @tags, tags_json = @tags_json,
          url = @url, spec = @spec, tokens = @tokens, alt_greetings = @alt_greetings, lorebook_entries = @lorebook_entries, has_gallery = @has_gallery,
          has_expressions = @has_expressions, has_embedded_images = @has_embedded_images, has_system_prompt = @has_system_prompt, has_examples = @has_examples,
          portrait_sha256 = @portrait_sha256, stars = coalesce(@stars, stars), favorites = coalesce(@favorites, favorites), chats = coalesce(@chats, chats),
          messages = coalesce(@messages, messages), downloads = coalesce(@downloads, downloads), rating = coalesce(@rating, rating),
          remote_created_at = coalesce(@remote_created_at, remote_created_at), remote_updated_at = coalesce(@remote_updated_at, remote_updated_at),
          last_seen_at = @seen, changed_at = @seen, version_id = @version_id, versions = @versions WHERE id = @id`).run(values);
        db.prepare('DELETE FROM card_tags WHERE card_id = ?').run(id);
      } else {
        db.prepare(`INSERT INTO cards (id, provider, record_id, name, creator, tagline, description, tags, tags_json, url, spec, tokens, alt_greetings,
          lorebook_entries, has_gallery, has_expressions, has_embedded_images, has_system_prompt, has_examples, portrait_sha256, stars, favorites, chats,
          messages, downloads, rating, remote_created_at, remote_updated_at, first_seen_at, last_seen_at, changed_at, version_id, versions)
          VALUES (@id, @provider, @record_id, @name, @creator, @tagline, @description, @tags, @tags_json, @url, @spec, @tokens, @alt_greetings,
          @lorebook_entries, @has_gallery, @has_expressions, @has_embedded_images, @has_system_prompt, @has_examples, @portrait_sha256, @stars, @favorites, @chats,
          @messages, @downloads, @rating, @remote_created_at, @remote_updated_at, @seen, @seen, @seen, @version_id, @versions)`).run(values);
      }
      db.prepare('INSERT INTO versions (id, card_id, sequence, fingerprint, remote_updated_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(versionId, id, sequence, fingerprint, remoteUpdated, at);
      const tag = db.prepare('INSERT OR IGNORE INTO card_tags (card_id, tag, folded) VALUES (?, ?, ?)');
      for (const value of described.tags) tag.run(id, value, value.toLowerCase());
      const object = db.prepare('INSERT INTO version_objects (version_id, role, name, sha256, media_type) VALUES (?, ?, ?, ?, ?)');
      for (const ref of refs) object.run(versionId, ref.role, ref.name, ref.sha256, ref.mediaType);
      return existing ? 'updated' : 'added';
    })();
  }

  const sink: ScrapeSink = {
    blocked: (provider, recordId) => !!statements.blocked.get(provider, recordId),
    known(provider, recordId) {
      const row = statements.byRecord.get(provider, recordId) as { remote_updated_at: string | null } | undefined;
      return row ? { updatedAt: row.remote_updated_at } : null;
    },
    seen(provider, recordId, stats) {
      const row = statements.byRecord.get(provider, recordId) as { id: string } | undefined;
      if (row) statsUpdate(row.id, stats, now());
    },
    put,
  };

  function getRow(id: string) {
    const row = statements.card.get(id) as Row | undefined;
    if (!row || statements.blocked.get(row.provider, row.record_id)) throw new NativeArchiveError('NOT_FOUND', 'No such Archive card');
    return row;
  }

  function source(provider: string): SourceRecord {
    const row = db.prepare('SELECT * FROM sources WHERE provider = ?').get(provider) as { enabled: number; interval_minutes: number; settings_json: string; secrets_json: string; updated_at: string } | undefined;
    return row ? { provider, enabled: !!row.enabled, intervalMinutes: row.interval_minutes, settings: JSON.parse(row.settings_json) as Record<string, unknown>,
      secrets: JSON.parse(row.secrets_json) as Record<string, string>, updatedAt: row.updated_at }
      : { provider, enabled: false, intervalMinutes: 240, settings: {}, secrets: {}, updatedAt: null };
  }

  const runRow = (row: Record<string, unknown>): RunRecord => ({
    id: row.id as number, provider: row.provider as string, trigger: row.trigger as string, status: row.status as RunRecord['status'],
    startedAt: row.started_at as string, finishedAt: row.finished_at as string | null, error: row.error as string | null,
    listed: row.listed as number, added: row.added as number, updated: row.updated as number, unchanged: row.unchanged as number,
    skipped: row.skipped as number, blocked: row.blocked as number, errors: row.errors as number,
  });

  return {
    archiveId,
    sink,
    put,
    list(query: ArchiveQuery = {}) {
      const { where, params } = archiveFilterSql(query);
      const limit = Math.min(Math.max(query.limit ?? 48, 1), 100), offset = Math.max(query.offset ?? 0, 0);
      const clause = where.join(' AND ');
      const total = (db.prepare(`SELECT count(*) AS total FROM cards c WHERE ${clause}`).get(...params) as { total: number }).total;
      const rows = db.prepare(`SELECT c.* FROM cards c WHERE ${clause} ORDER BY ${archiveSortSql[query.sort ?? 'updated']}, c.seq DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset) as Row[];
      return { cards: rows.map(summary), total };
    },
    /** Summary, every version's files, and the current card document as its file holds it (parsed, never rewritten). */
    async card(id: string): Promise<ArchiveCardDetail> {
      const row = getRow(id);
      const versionList = (db.prepare('SELECT id, sequence, fetched_at AS fetchedAt, remote_updated_at AS remoteUpdatedAt FROM versions WHERE card_id = ? ORDER BY sequence DESC').all(id) as Omit<ArchiveVersion, 'objects'>[])
        .map((version) => ({ ...version, objects: objectsOf(version.id) }));
      const container = objectsOf(row.version_id).find((ref) => ref.role === 'card')!;
      const document = describe({ provider: row.provider, recordId: row.record_id, url: row.url, objects: [] },
        { role: 'card', bytes: await objects.get(container.sha256), mediaType: container.mediaType }).document;
      return { ...summary(row), document, versionList };
    },
    /** Files of the current version (for importing into the library). */
    files(id: string) { return objectsOf(getRow(id).version_id); },
    async object(hash: string) {
      const ref = statements.object.get(hash) as { sha256: string; byteLength: number; mediaType: string } | undefined;
      if (!ref) throw new NativeArchiveError('NOT_FOUND', 'No such Archive object');
      return { bytes: await objects.get(hash), mediaType: ref.mediaType };
    },
    tags(limit = 2000) {
      return db.prepare(`SELECT min(t.tag) AS tag, count(*) AS count FROM card_tags t JOIN cards c ON c.id = t.card_id
        WHERE NOT EXISTS (SELECT 1 FROM blocked b WHERE b.provider = c.provider AND b.record_id = c.record_id)
        GROUP BY t.folded ORDER BY count DESC, t.folded LIMIT ?`).all(limit) as { tag: string; count: number }[];
    },
    status() {
      const visible = 'NOT EXISTS (SELECT 1 FROM blocked b WHERE b.provider = c.provider AND b.record_id = c.record_id)';
      const providers = Object.fromEntries((db.prepare(`SELECT provider, count(*) AS n FROM cards c WHERE ${visible} GROUP BY provider`).all() as { provider: string; n: number }[]).map((row) => [row.provider, row.n]));
      const blocked = (db.prepare('SELECT count(*) AS n FROM blocked').get() as { n: number }).n;
      const changed = (db.prepare('SELECT max(changed_at) AS at FROM cards').get() as { at: string | null }).at;
      return { archiveId, cards: Object.values(providers).reduce((sum, value) => sum + value, 0), providers, blocked, lastChangedAt: changed };
    },
    block(provider: string, recordId: string, reason = 'Removed from the Archive') {
      db.prepare('INSERT OR REPLACE INTO blocked (provider, record_id, reason, blocked_at) VALUES (?, ?, ?, ?)').run(provider, recordId, reason.slice(0, 500), now());
    },
    unblock(provider: string, recordId: string) { db.prepare('DELETE FROM blocked WHERE provider = ? AND record_id = ?').run(provider, recordId); },
    source,
    saveSource(record: Omit<SourceRecord, 'updatedAt'>) {
      db.prepare(`INSERT INTO sources (provider, enabled, interval_minutes, settings_json, secrets_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (provider) DO UPDATE SET enabled = excluded.enabled, interval_minutes = excluded.interval_minutes,
        settings_json = excluded.settings_json, secrets_json = excluded.secrets_json, updated_at = excluded.updated_at`)
        .run(record.provider, +record.enabled, record.intervalMinutes, JSON.stringify(record.settings), JSON.stringify(record.secrets), now());
      return source(record.provider);
    },
    startRun(provider: string, trigger: string) {
      return Number(db.prepare("INSERT INTO runs (provider, trigger, status, started_at) VALUES (?, ?, 'running', ?)").run(provider, trigger, now()).lastInsertRowid);
    },
    progressRun(id: number, counts: RunCounts) {
      db.prepare('UPDATE runs SET listed = ?, added = ?, updated = ?, unchanged = ?, skipped = ?, blocked = ?, errors = ? WHERE id = ?')
        .run(counts.listed, counts.added, counts.updated, counts.unchanged, counts.skipped, counts.blocked, counts.errors, id);
    },
    finishRun(id: number, result: RunResult) {
      db.prepare('UPDATE runs SET status = ?, finished_at = ?, listed = ?, added = ?, updated = ?, unchanged = ?, skipped = ?, blocked = ?, errors = ?, error = ? WHERE id = ?')
        .run(result.status, now(), result.listed, result.added, result.updated, result.unchanged, result.skipped, result.blocked, result.errors, result.error?.slice(0, 2000) ?? null, id);
    },
    runs(provider?: string, limit = 20) {
      const rows = provider
        ? db.prepare('SELECT * FROM runs WHERE provider = ? ORDER BY id DESC LIMIT ?').all(provider, limit)
        : db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit);
      return (rows as Record<string, unknown>[]).map(runRow);
    },
    lastFinishedRun(provider: string) {
      const row = db.prepare("SELECT * FROM runs WHERE provider = ? AND status != 'running' ORDER BY id DESC LIMIT 1").get(provider) as Record<string, unknown> | undefined;
      return row ? runRow(row) : null;
    },
    close() { db.close(); },
  };
}
export type NativeArchive = Awaited<ReturnType<typeof openNativeArchive>>;
