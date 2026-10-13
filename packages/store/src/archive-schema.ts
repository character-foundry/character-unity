/** Migration 13: lightweight membership, exact external ancestry and import claims. */
export const archiveSchema = [
  `CREATE TABLE unity_archive_references (
    id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL REFERENCES unity_workspaces(id),
    archive_id TEXT NOT NULL, archive_card_id TEXT NOT NULL, archive_version_id TEXT NOT NULL,
    summary_json TEXT NOT NULL CHECK(json_valid(summary_json)), file_hash TEXT,
    content_algorithm TEXT, content_hash TEXT, module_hash TEXT, lineage_hash TEXT,
    favorite INTEGER NOT NULL CHECK(favorite IN (0,1)),
    created_at TEXT NOT NULL, UNIQUE(id,workspace_id), UNIQUE(workspace_id, archive_id, archive_card_id, archive_version_id)
  )`,
  'CREATE INDEX unity_archive_references_workspace ON unity_archive_references(workspace_id,id)',
  `CREATE TRIGGER unity_archive_reference_pin_guard BEFORE UPDATE ON unity_archive_references
    WHEN OLD.id IS NOT NEW.id OR OLD.workspace_id IS NOT NEW.workspace_id
      OR OLD.archive_id IS NOT NEW.archive_id OR OLD.archive_card_id IS NOT NEW.archive_card_id
      OR OLD.archive_version_id IS NOT NEW.archive_version_id OR OLD.summary_json IS NOT NEW.summary_json
      OR OLD.file_hash IS NOT NEW.file_hash OR OLD.content_algorithm IS NOT NEW.content_algorithm
      OR OLD.content_hash IS NOT NEW.content_hash OR OLD.module_hash IS NOT NEW.module_hash
      OR OLD.lineage_hash IS NOT NEW.lineage_hash OR OLD.created_at IS NOT NEW.created_at
    BEGIN SELECT RAISE(ABORT, 'UNITY_IMMUTABLE_PROVENANCE'); END`,
  `CREATE TABLE unity_archive_assets (
    asset_id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL,
    archive_id TEXT NOT NULL, archive_card_id TEXT NOT NULL, archive_version_id TEXT NOT NULL, path TEXT NOT NULL,
    UNIQUE(workspace_id,archive_id,archive_card_id,archive_version_id,path),
    FOREIGN KEY(asset_id,workspace_id) REFERENCES unity_assets(id,workspace_id)
  )`,
  `CREATE TRIGGER unity_archive_asset_guard BEFORE INSERT ON unity_archive_assets
    WHEN NOT EXISTS (SELECT 1 FROM unity_assets a WHERE a.id = NEW.asset_id
      AND a.workspace_id = NEW.workspace_id AND a.state = 'ready')
    BEGIN SELECT RAISE(ABORT, 'UNITY_ASSET_NOT_READY'); END`,
  `CREATE TABLE unity_archive_fork_sources (
    card_id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL,
    archive_id TEXT NOT NULL, archive_card_id TEXT NOT NULL, archive_version_id TEXT NOT NULL, reference_id TEXT,
    source_provider TEXT NOT NULL,
    FOREIGN KEY(card_id,workspace_id) REFERENCES unity_cards(id,workspace_id)
  )`,
  `CREATE TRIGGER unity_archive_fork_source_guard BEFORE INSERT ON unity_archive_fork_sources
    WHEN NOT EXISTS (SELECT 1 FROM unity_cards c WHERE c.id = NEW.card_id
      AND c.workspace_id = NEW.workspace_id AND c.head_revision_id IS NULL)
    BEGIN SELECT RAISE(ABORT, 'UNITY_IMMUTABLE_PROVENANCE'); END`,
  ...['unity_archive_assets', 'unity_archive_fork_sources'].flatMap((table) =>
    ['UPDATE', 'DELETE'].map((operation) => `CREATE TRIGGER ${table}_no_${operation.toLowerCase()}
      BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'UNITY_IMMUTABLE_PROVENANCE'); END`)),
  `CREATE TABLE unity_import_claims (
    workspace_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('file','content')),
    algorithm TEXT NOT NULL, hash TEXT NOT NULL, module_hash TEXT NOT NULL, lineage_hash TEXT NOT NULL,
    card_id TEXT NOT NULL, revision_id TEXT NOT NULL,
    PRIMARY KEY(workspace_id,kind,algorithm,hash,module_hash,lineage_hash),
    FOREIGN KEY(card_id,workspace_id) REFERENCES unity_cards(id,workspace_id),
    FOREIGN KEY(revision_id,workspace_id) REFERENCES unity_revisions(id,workspace_id)
  )`,
  'CREATE INDEX unity_import_claims_card ON unity_import_claims(card_id)',
  `CREATE TRIGGER unity_import_claim_head_changed AFTER UPDATE OF head_revision_id ON unity_cards
    BEGIN DELETE FROM unity_import_claims WHERE card_id = NEW.id AND kind = 'content'; END`,
  `CREATE TRIGGER unity_import_claim_card_deleted AFTER INSERT ON unity_card_deletions
    BEGIN DELETE FROM unity_import_claims WHERE card_id = NEW.card_id; END`,
  `CREATE TRIGGER unity_archive_asset_never_retire BEFORE INSERT ON unity_asset_retirements
    WHEN EXISTS (SELECT 1 FROM unity_archive_assets WHERE asset_id = NEW.asset_id)
    BEGIN SELECT RAISE(ABORT, 'UNITY_ASSET_IN_USE'); END`,
  `CREATE TABLE unity_shared_assets (
    workspace_id TEXT NOT NULL, content_hash TEXT NOT NULL, byte_length INTEGER NOT NULL, media_type TEXT NOT NULL,
    asset_id TEXT NOT NULL UNIQUE, PRIMARY KEY(workspace_id,content_hash,byte_length,media_type),
    FOREIGN KEY(asset_id,workspace_id) REFERENCES unity_assets(id,workspace_id)
  )`,
  `CREATE TRIGGER unity_shared_asset_retired AFTER INSERT ON unity_asset_retirements
    BEGIN DELETE FROM unity_shared_assets WHERE asset_id = NEW.asset_id; END`,
  `CREATE TABLE unity_search_outbox (
    workspace_id TEXT NOT NULL,card_id TEXT NOT NULL,revision_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')),event_sequence INTEGER NOT NULL CHECK(event_sequence BETWEEN 1 AND 9007199254740991),
    pending INTEGER NOT NULL CHECK(pending IN (0,1)),error TEXT,queued_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id,card_id),FOREIGN KEY(card_id,workspace_id) REFERENCES unity_cards(id,workspace_id)
  )`,
  `INSERT INTO unity_search_outbox(workspace_id,card_id,revision_id,operation,event_sequence,pending,error,queued_at)
    SELECT c.workspace_id,c.id,c.head_revision_id,CASE WHEN EXISTS (SELECT 1 FROM unity_card_deletions d WHERE d.card_id = c.id)
      THEN 'delete' ELSE 'upsert' END,1,1,NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM unity_cards c WHERE c.head_revision_id IS NOT NULL`,
  'CREATE INDEX unity_search_outbox_pending ON unity_search_outbox(pending,queued_at,workspace_id,card_id)',
  `CREATE TRIGGER unity_search_head_changed AFTER UPDATE OF head_revision_id ON unity_cards WHEN NEW.head_revision_id IS NOT NULL
    BEGIN INSERT INTO unity_search_outbox(workspace_id,card_id,revision_id,operation,event_sequence,pending,error,queued_at)
      VALUES (NEW.workspace_id,NEW.id,NEW.head_revision_id,'upsert',1,1,NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(workspace_id,card_id) DO UPDATE SET revision_id = excluded.revision_id,operation = 'upsert',
        event_sequence = unity_search_outbox.event_sequence + 1,pending = 1,error = NULL,queued_at = excluded.queued_at; END`,
  `CREATE TRIGGER unity_search_card_deleted AFTER INSERT ON unity_card_deletions
    BEGIN INSERT INTO unity_search_outbox(workspace_id,card_id,revision_id,operation,event_sequence,pending,error,queued_at)
      SELECT NEW.workspace_id,NEW.card_id,head_revision_id,'delete',1,1,NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM unity_cards WHERE id = NEW.card_id AND head_revision_id IS NOT NULL
      ON CONFLICT(workspace_id,card_id) DO UPDATE SET operation = 'delete',event_sequence = unity_search_outbox.event_sequence + 1,
        pending = 1,error = NULL,queued_at = excluded.queued_at; END`,
] as const;
