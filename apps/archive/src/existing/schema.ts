/** Additive bookkeeping in the original Archive database; legacy tables and IDs stay intact. */
export const existingSchemaVersion = 2;
export const existingSchema = `
CREATE TABLE IF NOT EXISTS unity_archive_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS unity_archive_objects (
  sha256 TEXT PRIMARY KEY, origin TEXT NOT NULL CHECK(origin IN ('legacy','objects')),
  path TEXT NOT NULL, byte_length INTEGER NOT NULL, media_type TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS unity_archive_versions (
  id TEXT PRIMARY KEY, card_id INTEGER NOT NULL REFERENCES cards(id), sequence INTEGER NOT NULL,
  fingerprint TEXT NOT NULL, remote_updated_at TEXT, fetched_at TEXT NOT NULL,
  UNIQUE(card_id, sequence));
CREATE TABLE IF NOT EXISTS unity_archive_version_objects (
  version_id TEXT NOT NULL REFERENCES unity_archive_versions(id), role TEXT NOT NULL, name TEXT NOT NULL,
  sha256 TEXT NOT NULL REFERENCES unity_archive_objects(sha256), PRIMARY KEY(version_id, role, name));
CREATE INDEX IF NOT EXISTS unity_archive_version_objects_identity ON unity_archive_version_objects(role,sha256,version_id);
CREATE TABLE IF NOT EXISTS unity_archive_identities (
  version_id TEXT PRIMARY KEY, card_id INTEGER NOT NULL REFERENCES cards(id), file_hash TEXT NOT NULL,
  content_hash TEXT, content_name TEXT, unavailable_reason TEXT, legacy_stamp TEXT);
CREATE INDEX IF NOT EXISTS unity_archive_identities_file ON unity_archive_identities(file_hash,card_id,version_id);
CREATE INDEX IF NOT EXISTS unity_archive_identities_content ON unity_archive_identities(content_hash,card_id,version_id);
CREATE INDEX IF NOT EXISTS unity_archive_identities_card ON unity_archive_identities(card_id,legacy_stamp);
CREATE TABLE IF NOT EXISTS unity_archive_state (
  card_id INTEGER PRIMARY KEY REFERENCES cards(id), current_version TEXT NOT NULL,
  spec TEXT NOT NULL, alt_greetings INTEGER NOT NULL, lorebook_entries INTEGER NOT NULL,
  portrait_sha256 TEXT, changed_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS unity_archive_blocked (
  provider TEXT NOT NULL, record_id TEXT NOT NULL, reason TEXT NOT NULL, blocked_at TEXT NOT NULL,
  card_id INTEGER, source_path TEXT, PRIMARY KEY(provider, record_id));
CREATE TABLE IF NOT EXISTS unity_archive_sources (
  provider TEXT PRIMARY KEY, enabled INTEGER NOT NULL, interval_minutes INTEGER NOT NULL,
  settings_json TEXT NOT NULL, secrets_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS unity_archive_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, trigger TEXT NOT NULL, status TEXT NOT NULL,
  started_at TEXT NOT NULL, finished_at TEXT, listed INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0, unchanged INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, error TEXT);
CREATE INDEX IF NOT EXISTS unity_archive_runs_provider ON unity_archive_runs(provider,id);
CREATE INDEX IF NOT EXISTS unity_archive_identity ON cards(source,sourceId);
CREATE INDEX IF NOT EXISTS unity_archive_ct_path ON cards(source,lower(sourcePath));
CREATE INDEX IF NOT EXISTS unity_archive_updated ON cards(lastModified DESC,id DESC);
CREATE INDEX IF NOT EXISTS unity_archive_source_updated ON cards(coalesce(source,'chub'),lastModified DESC,id DESC);
`;
