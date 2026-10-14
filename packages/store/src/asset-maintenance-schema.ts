/** Permanent retirement fences cross the SQL/object-store boundary. Never remove
 * these records: a delayed/crashed upload may publish bytes after a sweep. */
export const assetMaintenanceSchema = [
  `CREATE TABLE unity_asset_lifetimes (
    asset_id TEXT PRIMARY KEY NOT NULL REFERENCES unity_assets(id), created_at TEXT NOT NULL
  )`,
  `INSERT INTO unity_asset_lifetimes(asset_id, created_at)
    SELECT id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM unity_assets`,
  `CREATE TRIGGER unity_asset_birth AFTER INSERT ON unity_assets BEGIN
    INSERT INTO unity_asset_lifetimes(asset_id, created_at) VALUES (NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')); END`,
  `CREATE TABLE unity_asset_retirements (
    asset_id TEXT PRIMARY KEY NOT NULL REFERENCES unity_assets(id),
    eligible_before TEXT NOT NULL, retired_at TEXT NOT NULL,
    CHECK(eligible_before <= retired_at)
  )`,
  `CREATE INDEX unity_revision_assets_asset ON unity_revision_assets(asset_id)`,
  `CREATE INDEX unity_card_sources_asset ON unity_card_sources(asset_id)`,
  `CREATE INDEX unity_sync_outbox_asset ON unity_sync_outbox(asset_id)`,
  `CREATE TRIGGER unity_asset_retire_guard BEFORE INSERT ON unity_asset_retirements
    WHEN NOT EXISTS (SELECT 1 FROM unity_asset_lifetimes WHERE asset_id = NEW.asset_id AND created_at <= NEW.eligible_before)
      OR EXISTS (SELECT 1 FROM unity_revision_assets WHERE asset_id = NEW.asset_id)
      OR EXISTS (SELECT 1 FROM unity_card_sources WHERE asset_id = NEW.asset_id)
      OR EXISTS (SELECT 1 FROM unity_sync_outbox WHERE asset_id = NEW.asset_id)
    BEGIN SELECT RAISE(ABORT, 'UNITY_ASSET_IN_USE'); END`,
  ...['unity_revision_assets', 'unity_card_sources', 'unity_sync_outbox'].map((table) =>
    `CREATE TRIGGER ${table}_not_retired BEFORE INSERT ON ${table}
      WHEN EXISTS (SELECT 1 FROM unity_asset_retirements WHERE asset_id = NEW.asset_id)
      BEGIN SELECT RAISE(ABORT, 'UNITY_ASSET_NOT_READY'); END`),
  `CREATE TRIGGER unity_asset_complete_not_retired BEFORE UPDATE ON unity_assets
    WHEN EXISTS (SELECT 1 FROM unity_asset_retirements WHERE asset_id = NEW.id)
    BEGIN SELECT RAISE(ABORT, 'UNITY_ASSET_NOT_READY'); END`,
  ...['unity_asset_lifetimes', 'unity_asset_retirements'].flatMap((table) =>
    ['UPDATE', 'DELETE'].map((operation) => `CREATE TRIGGER ${table}_no_${operation.toLowerCase()} BEFORE ${operation} ON ${table}
      BEGIN SELECT RAISE(ABORT, 'UNITY_IMMUTABLE_ASSET'); END`)),
] as const;

/** Frozen migration-14 SQL fragment: changing this requires a new migration.
 * SQL-owned bytes remain in use while any retained card needs their history.
 * A recently deleted card also stays protected for the operator's full age floor. */
export function assetInUse(assetId: string, before: string) {
  const retained = (cardId: string) => `(EXISTS (SELECT 1 FROM unity_asset_retained_cards k WHERE k.id = ${cardId})
    OR NOT EXISTS (SELECT 1 FROM unity_card_deletions d WHERE d.card_id = ${cardId} AND d.deleted_at <= ${before}))`;
  return `EXISTS (SELECT 1 FROM unity_revision_assets ra JOIN unity_revisions r ON r.id = ra.revision_id
      WHERE ra.asset_id = ${assetId} AND ${retained('r.card_id')})
    OR EXISTS (SELECT 1 FROM unity_card_sources s WHERE s.asset_id = ${assetId} AND ${retained('s.card_id')})
    OR EXISTS (SELECT 1 FROM unity_sync_outbox WHERE asset_id = ${assetId})
    OR EXISTS (SELECT 1 FROM unity_archive_assets WHERE asset_id = ${assetId})`;
}

function retiredAncestry(cardId: string) {
  return `EXISTS (WITH RECURSIVE ancestry(id) AS (
    SELECT ${cardId} UNION SELECT r.card_id FROM ancestry k JOIN unity_cards c ON c.id = k.id
      JOIN unity_revisions r ON r.id = c.forked_from_revision_id
  ) SELECT 1 FROM ancestry k JOIN unity_revisions r ON r.card_id = k.id
    JOIN unity_revision_assets ra ON ra.revision_id = r.id JOIN unity_asset_retirements t ON t.asset_id = ra.asset_id
    UNION ALL SELECT 1 FROM ancestry k JOIN unity_card_sources s ON s.card_id = k.id
      JOIN unity_asset_retirements t ON t.asset_id = s.asset_id)`;
}

/** Migration 14. Prior immutable revision rows remain useful provenance even
 * after the bytes of an unreachable, deleted card have been retired. */
export const deletedCardAssetMaintenanceSchema = [
  `CREATE VIEW unity_asset_retained_cards AS WITH RECURSIVE retained(id) AS (
    SELECT c.id FROM unity_cards c WHERE NOT EXISTS (SELECT 1 FROM unity_card_deletions d WHERE d.card_id = c.id)
    UNION SELECT r.card_id FROM unity_publications p JOIN unity_revisions r ON r.id = p.revision_id
    UNION SELECT card_id FROM unity_sync_outbox
    UNION SELECT r.card_id FROM retained k JOIN unity_cards c ON c.id = k.id
      JOIN unity_revisions r ON r.id = c.forked_from_revision_id
  ) SELECT id FROM retained`,
  'DROP TRIGGER unity_asset_retire_guard',
  `CREATE TRIGGER unity_asset_retire_guard BEFORE INSERT ON unity_asset_retirements
    WHEN NOT EXISTS (SELECT 1 FROM unity_asset_lifetimes WHERE asset_id = NEW.asset_id AND created_at <= NEW.eligible_before)
      OR ${assetInUse('NEW.asset_id', 'NEW.eligible_before')}
    BEGIN SELECT RAISE(ABORT, 'UNITY_ASSET_IN_USE'); END`,
  `CREATE TRIGGER unity_publication_bytes_retained BEFORE INSERT ON unity_publications
    WHEN ${retiredAncestry('(SELECT card_id FROM unity_revisions WHERE id = NEW.revision_id)')}
    BEGIN SELECT RAISE(ABORT, 'UNITY_PUBLICATION_ACCESS'); END`,
  `CREATE TRIGGER unity_fork_bytes_retained BEFORE INSERT ON unity_cards
    WHEN NEW.forked_from_revision_id IS NOT NULL
      AND ${retiredAncestry('(SELECT card_id FROM unity_revisions WHERE id = NEW.forked_from_revision_id)')}
    BEGIN SELECT RAISE(ABORT, 'UNITY_ASSET_NOT_READY'); END`,
  `CREATE TRIGGER unity_outbox_bytes_retained BEFORE INSERT ON unity_sync_outbox
    WHEN ${retiredAncestry('NEW.card_id')}
    BEGIN SELECT RAISE(ABORT, 'UNITY_ASSET_NOT_READY'); END`,
  `CREATE TRIGGER unity_archive_assets_not_retired BEFORE INSERT ON unity_archive_assets
    WHEN EXISTS (SELECT 1 FROM unity_asset_retirements WHERE asset_id = NEW.asset_id)
    BEGIN SELECT RAISE(ABORT, 'UNITY_ASSET_NOT_READY'); END`,
  ...['UPDATE', 'DELETE'].map((operation) => `CREATE TRIGGER unity_deleted_bytes_no_${operation.toLowerCase()}
    BEFORE ${operation} ON unity_card_deletions WHEN ${retiredAncestry('OLD.card_id')}
    BEGIN SELECT RAISE(ABORT, 'UNITY_IMMUTABLE_ASSET'); END`),
] as const;
