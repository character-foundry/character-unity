/** Migration 7: commit-time peer authorization and immutable mutation receipts. */
export const syncOperationsSchema = [
  `CREATE TABLE unity_sync_write_guards (
    id TEXT PRIMARY KEY NOT NULL, actor TEXT NOT NULL, key_id TEXT NOT NULL, nonce TEXT NOT NULL,
    request_id TEXT NOT NULL, request_hash TEXT NOT NULL, scope TEXT NOT NULL,
    account_id TEXT NOT NULL, workspace_id TEXT NOT NULL, retain_until INTEGER NOT NULL, checked_at INTEGER NOT NULL
  )`,
  `CREATE TRIGGER unity_sync_write_guard BEFORE INSERT ON unity_sync_write_guards
    WHEN NOT EXISTS (SELECT 1 FROM unity_sync_peers p
      JOIN unity_sync_keys k ON k.actor = p.actor JOIN unity_sync_scopes s ON s.actor = p.actor
      JOIN unity_accounts a ON a.id = p.account_id JOIN unity_workspaces w ON w.id = p.workspace_id
      JOIN unity_sync_nonces n ON n.actor = p.actor AND n.key_id = k.key_id
      WHERE p.actor = NEW.actor AND k.key_id = NEW.key_id AND s.scope = NEW.scope
        AND p.enabled = 1 AND k.revoked = 0 AND a.enabled = 1 AND w.owner_id = a.id
        AND a.id = NEW.account_id AND w.id = NEW.workspace_id
        AND n.nonce = NEW.nonce AND n.request_id = NEW.request_id AND n.request_hash = NEW.request_hash
        AND n.retain_until = NEW.retain_until AND n.retain_until >= NEW.checked_at)
    BEGIN SELECT RAISE(ABORT, 'UNITY_SYNC_ACCESS'); END`,
  `CREATE TRIGGER unity_sync_publication_access BEFORE INSERT ON unity_publications
    WHEN EXISTS (SELECT 1 FROM unity_sync_write_guards g WHERE g.scope = 'publish'
      AND g.account_id = NEW.owner_id AND g.workspace_id = NEW.workspace_id)
      AND EXISTS (SELECT 1 FROM unity_publication_ancestors a JOIN unity_publications ancestor ON ancestor.id = a.ancestor_id
        WHERE a.publication_id = NEW.parent_id AND ancestor.owner_id != NEW.owner_id AND ancestor.visibility = 'private')
    BEGIN SELECT RAISE(ABORT, 'UNITY_PUBLICATION_ACCESS'); END`,
  `CREATE TABLE unity_sync_receipts (
    actor TEXT NOT NULL REFERENCES unity_sync_peers(actor), request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
    scope TEXT NOT NULL CHECK(scope IN ('publish', 'fork')), account_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
    result_json TEXT NOT NULL CHECK(json_valid(result_json) AND length(result_json) <= 8192),
    committed_at INTEGER NOT NULL, PRIMARY KEY(actor, request_id)
  )`,
  `CREATE TRIGGER unity_sync_receipt_existing BEFORE INSERT ON unity_sync_receipts
    WHEN EXISTS (SELECT 1 FROM unity_sync_receipts WHERE actor = NEW.actor AND request_id = NEW.request_id)
    BEGIN
      SELECT CASE WHEN EXISTS (SELECT 1 FROM unity_sync_receipts WHERE actor = NEW.actor AND request_id = NEW.request_id
        AND request_hash = NEW.request_hash AND scope = NEW.scope AND account_id = NEW.account_id AND workspace_id = NEW.workspace_id)
        THEN RAISE(ABORT, 'UNITY_SYNC_RETRY') ELSE RAISE(ABORT, 'UNITY_SYNC_CONFLICT') END;
    END`,
  `CREATE TRIGGER unity_sync_receipt_guard BEFORE INSERT ON unity_sync_receipts
    WHEN NOT EXISTS (SELECT 1 FROM unity_sync_write_guards g WHERE g.actor = NEW.actor AND g.request_id = NEW.request_id
      AND g.request_hash = NEW.request_hash AND g.scope = NEW.scope AND g.account_id = NEW.account_id AND g.workspace_id = NEW.workspace_id)
    BEGIN SELECT RAISE(ABORT, 'UNITY_SYNC_ACCESS'); END`,
  `CREATE TRIGGER unity_sync_receipt_no_update BEFORE UPDATE ON unity_sync_receipts
    BEGIN SELECT RAISE(ABORT, 'UNITY_IMMUTABLE_SYNC_RECEIPT'); END`,
  `CREATE TRIGGER unity_sync_receipt_no_delete BEFORE DELETE ON unity_sync_receipts
    BEGIN SELECT RAISE(ABORT, 'UNITY_IMMUTABLE_SYNC_RECEIPT'); END`,
];
