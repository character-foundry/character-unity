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
