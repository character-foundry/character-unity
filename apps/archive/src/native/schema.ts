/** The native Archive's own database. Only the Archive service writes it. */
export const nativeSchemaVersion = 1;

export const nativeSchema = `
CREATE TABLE IF NOT EXISTS archive_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS objects (
  sha256 TEXT PRIMARY KEY, byte_length INTEGER NOT NULL, media_type TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cards (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL, record_id TEXT NOT NULL,
  name TEXT NOT NULL, creator TEXT NOT NULL, tagline TEXT NOT NULL, description TEXT NOT NULL,
  tags TEXT NOT NULL, tags_json TEXT NOT NULL,
  url TEXT NOT NULL, spec TEXT NOT NULL, tokens INTEGER NOT NULL,
  alt_greetings INTEGER NOT NULL, lorebook_entries INTEGER NOT NULL,
  has_gallery INTEGER NOT NULL, has_expressions INTEGER NOT NULL, has_embedded_images INTEGER NOT NULL,
  has_system_prompt INTEGER NOT NULL, has_examples INTEGER NOT NULL, portrait_sha256 TEXT,
  stars INTEGER, favorites INTEGER, chats INTEGER, messages INTEGER, downloads INTEGER, rating REAL,
  remote_created_at TEXT, remote_updated_at TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, changed_at TEXT NOT NULL,
  version_id TEXT NOT NULL, versions INTEGER NOT NULL,
  UNIQUE (provider, record_id));
CREATE INDEX IF NOT EXISTS cards_changed ON cards (changed_at);
CREATE INDEX IF NOT EXISTS cards_first_seen ON cards (first_seen_at);
CREATE INDEX IF NOT EXISTS cards_remote_updated ON cards (remote_updated_at);
CREATE INDEX IF NOT EXISTS cards_tokens ON cards (tokens);
CREATE INDEX IF NOT EXISTS cards_stars ON cards (stars);
CREATE INDEX IF NOT EXISTS cards_creator ON cards (lower(creator));
CREATE TABLE IF NOT EXISTS card_tags (
  card_id TEXT NOT NULL REFERENCES cards (id), tag TEXT NOT NULL, folded TEXT NOT NULL, PRIMARY KEY (card_id, folded));
CREATE INDEX IF NOT EXISTS card_tags_folded ON card_tags (folded);
CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards (id), sequence INTEGER NOT NULL,
  fingerprint TEXT NOT NULL, remote_updated_at TEXT, fetched_at TEXT NOT NULL, UNIQUE (card_id, sequence));
CREATE TABLE IF NOT EXISTS version_objects (
  version_id TEXT NOT NULL REFERENCES versions (id), role TEXT NOT NULL, name TEXT NOT NULL,
  sha256 TEXT NOT NULL REFERENCES objects (sha256), media_type TEXT NOT NULL, PRIMARY KEY (version_id, role, name));
CREATE TABLE IF NOT EXISTS blocked (
  provider TEXT NOT NULL, record_id TEXT NOT NULL, reason TEXT NOT NULL, blocked_at TEXT NOT NULL, PRIMARY KEY (provider, record_id));
CREATE TABLE IF NOT EXISTS sources (
  provider TEXT PRIMARY KEY, enabled INTEGER NOT NULL, interval_minutes INTEGER NOT NULL,
  settings_json TEXT NOT NULL, secrets_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, trigger TEXT NOT NULL, status TEXT NOT NULL,
  started_at TEXT NOT NULL, finished_at TEXT,
  listed INTEGER NOT NULL DEFAULT 0, added INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0,
  unchanged INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0, error TEXT);
CREATE INDEX IF NOT EXISTS runs_provider ON runs (provider, id);
CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5 (
  name, creator, tagline, description, tags, content = 'cards', content_rowid = 'seq',
  tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3');
CREATE TRIGGER IF NOT EXISTS cards_fts_insert AFTER INSERT ON cards BEGIN
  INSERT INTO cards_fts (rowid, name, creator, tagline, description, tags) VALUES (new.seq, new.name, new.creator, new.tagline, new.description, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS cards_fts_delete AFTER DELETE ON cards BEGIN
  INSERT INTO cards_fts (cards_fts, rowid, name, creator, tagline, description, tags) VALUES ('delete', old.seq, old.name, old.creator, old.tagline, old.description, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS cards_fts_update AFTER UPDATE OF name, creator, tagline, description, tags ON cards BEGIN
  INSERT INTO cards_fts (cards_fts, rowid, name, creator, tagline, description, tags) VALUES ('delete', old.seq, old.name, old.creator, old.tagline, old.description, old.tags);
  INSERT INTO cards_fts (rowid, name, creator, tagline, description, tags) VALUES (new.seq, new.name, new.creator, new.tagline, new.description, new.tags);
END;
`;
