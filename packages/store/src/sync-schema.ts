/** Migration 6: local peer grants and durable transport replay admission. */
export const syncSchema = [
  `CREATE TABLE unity_sync_peers (
    actor TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL REFERENCES unity_accounts(id),
    workspace_id TEXT NOT NULL REFERENCES unity_workspaces(id), enabled INTEGER NOT NULL CHECK(enabled IN (0, 1))
  )`,
  `CREATE TRIGGER unity_sync_peer_identity_guard BEFORE UPDATE ON unity_sync_peers
    WHEN NEW.actor IS NOT OLD.actor OR NEW.account_id IS NOT OLD.account_id OR NEW.workspace_id IS NOT OLD.workspace_id
    BEGIN SELECT RAISE(ABORT, 'UNITY_IMMUTABLE_PEER'); END`,
  `CREATE TABLE unity_sync_scopes (
    actor TEXT NOT NULL REFERENCES unity_sync_peers(actor), scope TEXT NOT NULL CHECK(scope IN ('pull', 'publish', 'fork')),
    PRIMARY KEY(actor, scope)
  )`,
  `CREATE TABLE unity_sync_keys (
    actor TEXT NOT NULL REFERENCES unity_sync_peers(actor), key_id TEXT NOT NULL, public_key TEXT NOT NULL,
    revoked INTEGER NOT NULL CHECK(revoked IN (0, 1)), PRIMARY KEY(actor, key_id)
  )`,
  `CREATE TRIGGER unity_sync_key_identity_guard BEFORE UPDATE ON unity_sync_keys
    WHEN NEW.actor IS NOT OLD.actor OR NEW.key_id IS NOT OLD.key_id OR NEW.public_key IS NOT OLD.public_key OR NEW.revoked < OLD.revoked
    BEGIN SELECT RAISE(ABORT, 'UNITY_IMMUTABLE_SYNC_KEY'); END`,
  `CREATE TRIGGER unity_sync_key_no_delete BEFORE DELETE ON unity_sync_keys
    BEGIN SELECT RAISE(ABORT, 'UNITY_IMMUTABLE_SYNC_KEY'); END`,
  `CREATE TABLE unity_sync_nonces (
    actor TEXT NOT NULL, nonce TEXT NOT NULL, key_id TEXT NOT NULL, request_id TEXT NOT NULL,
    request_hash TEXT NOT NULL, retain_until INTEGER NOT NULL CHECK(retain_until >= 0),
    PRIMARY KEY(actor, nonce), FOREIGN KEY(actor, key_id) REFERENCES unity_sync_keys(actor, key_id)
  )`,
  'CREATE INDEX unity_sync_nonces_expiry ON unity_sync_nonces(retain_until)',
  `CREATE TRIGGER unity_sync_nonce_no_update BEFORE UPDATE ON unity_sync_nonces
    BEGIN SELECT RAISE(ABORT, 'UNITY_IMMUTABLE_SYNC_NONCE'); END`,
];
