/** Immutable intent, attempts and acknowledgments. A missing receipt never proves no remote commit. */
export const syncOutboxSchema = [
  `CREATE TABLE unity_sync_outbox (
    request_id TEXT PRIMARY KEY NOT NULL CHECK(length(request_id) = 43),
    account_id TEXT NOT NULL REFERENCES unity_accounts(id), workspace_id TEXT NOT NULL,
    actor TEXT NOT NULL, base_url TEXT NOT NULL, publication_id TEXT NOT NULL,
    card_id TEXT NOT NULL, revision_id TEXT NOT NULL, asset_id TEXT NOT NULL,
    frame_hash TEXT NOT NULL CHECK(length(frame_hash) = 64),
    byte_length INTEGER NOT NULL CHECK(byte_length > 0 AND byte_length <= 8388608), created_at TEXT NOT NULL,
    FOREIGN KEY(card_id, workspace_id) REFERENCES unity_cards(id, workspace_id),
    FOREIGN KEY(revision_id, card_id) REFERENCES unity_revisions(id, card_id),
    FOREIGN KEY(asset_id, workspace_id) REFERENCES unity_assets(id, workspace_id)
  )`,
  `CREATE INDEX unity_sync_outbox_workspace ON unity_sync_outbox(account_id, workspace_id, request_id)`,
  `CREATE TRIGGER unity_outbox_insert_guard BEFORE INSERT ON unity_sync_outbox
    WHEN NOT EXISTS (SELECT 1 FROM unity_accounts a JOIN unity_workspaces w ON w.owner_id = a.id
      JOIN unity_assets b ON b.workspace_id = w.id JOIN unity_revision_seals r ON r.revision_id = NEW.revision_id
      WHERE a.id = NEW.account_id AND a.enabled = 1 AND a.actor_uri = NEW.actor AND w.id = NEW.workspace_id
        AND b.id = NEW.asset_id AND b.state = 'ready' AND b.content_hash = NEW.frame_hash
        AND b.byte_length = NEW.byte_length AND b.media_type = 'application/octet-stream')
    BEGIN SELECT RAISE(ABORT, 'UNITY_OUTBOX_ACCESS'); END`,
  `CREATE TABLE unity_sync_outbox_attempts (
    id TEXT PRIMARY KEY NOT NULL, request_id TEXT NOT NULL REFERENCES unity_sync_outbox(request_id), started_at TEXT NOT NULL
  )`,
  `CREATE INDEX unity_sync_outbox_attempt_job ON unity_sync_outbox_attempts(request_id, started_at)`,
  `CREATE TABLE unity_sync_outbox_receipts (
    request_id TEXT PRIMARY KEY NOT NULL REFERENCES unity_sync_outbox(request_id),
    receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)), received_at TEXT NOT NULL,
    CHECK(json_extract(receipt_json, '$.requestId') IS request_id),
    CHECK(json_extract(receipt_json, '$.operation') IS 'forks.submit')
  )`,
  ...['attempts', 'receipts'].map((table) => `CREATE TRIGGER unity_outbox_${table}_access BEFORE INSERT ON unity_sync_outbox_${table}
    WHEN NOT EXISTS (SELECT 1 FROM unity_sync_outbox j JOIN unity_accounts a ON a.id = j.account_id
      JOIN unity_workspaces w ON w.id = j.workspace_id
      WHERE j.request_id = NEW.request_id AND a.enabled = 1 AND a.actor_uri = j.actor AND w.owner_id = a.id)
    BEGIN SELECT RAISE(ABORT, 'UNITY_OUTBOX_ACCESS'); END`),
  `CREATE TRIGGER unity_outbox_receipt_attempt BEFORE INSERT ON unity_sync_outbox_receipts
    WHEN NOT EXISTS (SELECT 1 FROM unity_sync_outbox_attempts WHERE request_id = NEW.request_id)
    BEGIN SELECT RAISE(ABORT, 'UNITY_OUTBOX_NO_ATTEMPT'); END`,
  `CREATE TRIGGER unity_outbox_receipt_conflict BEFORE INSERT ON unity_sync_outbox_receipts
    WHEN EXISTS (SELECT 1 FROM unity_sync_outbox_receipts WHERE request_id = NEW.request_id AND receipt_json != NEW.receipt_json)
    BEGIN SELECT RAISE(ABORT, 'UNITY_OUTBOX_CONFLICT'); END`,
  ...['unity_sync_outbox', 'unity_sync_outbox_attempts', 'unity_sync_outbox_receipts'].flatMap((table) =>
    ['UPDATE', 'DELETE'].map((operation) => `CREATE TRIGGER ${table}_no_${operation.toLowerCase()} BEFORE ${operation} ON ${table}
      BEGIN SELECT RAISE(ABORT, 'UNITY_IMMUTABLE_OUTBOX'); END`)),
] as const;
