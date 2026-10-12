/** Migration 4: operator-created accounts, revocable sessions and atomic write guards. */
export const accountsSchema = [
  `CREATE TABLE unity_accounts (
    id TEXT PRIMARY KEY NOT NULL, actor_uri TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE unity_sessions (
    token_hash TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL REFERENCES unity_accounts(id),
    created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    CHECK(expires_at > created_at AND expires_at <= created_at + 28800000),
    CHECK(last_seen_at >= created_at)
  )`,
  `CREATE INDEX unity_sessions_account ON unity_sessions(account_id, created_at, token_hash)`,
  `CREATE TRIGGER unity_account_identity_guard BEFORE UPDATE ON unity_accounts
    WHEN NEW.id IS NOT OLD.id OR NEW.actor_uri IS NOT OLD.actor_uri OR NEW.created_at IS NOT OLD.created_at
    BEGIN SELECT RAISE(ABORT, 'UNITY_IMMUTABLE_ACCOUNT'); END`,
  `CREATE TRIGGER unity_account_revoke AFTER UPDATE ON unity_accounts
    WHEN NEW.key_hash IS NOT OLD.key_hash OR NEW.enabled IS NOT OLD.enabled
    BEGIN DELETE FROM unity_sessions WHERE account_id = NEW.id; END`,
  `CREATE TRIGGER unity_session_identity_guard BEFORE UPDATE ON unity_sessions
    WHEN NEW.token_hash IS NOT OLD.token_hash OR NEW.account_id IS NOT OLD.account_id
      OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
      OR NEW.last_seen_at < OLD.last_seen_at
    BEGIN SELECT RAISE(ABORT, 'UNITY_IMMUTABLE_SESSION'); END`,
  `CREATE TABLE unity_session_write_guards (
    id TEXT PRIMARY KEY NOT NULL, token_hash TEXT NOT NULL, account_id TEXT NOT NULL, checked_at INTEGER NOT NULL
  )`,
  `CREATE TRIGGER unity_session_write_guard BEFORE INSERT ON unity_session_write_guards
    WHEN NOT EXISTS (SELECT 1 FROM unity_sessions s JOIN unity_accounts a ON a.id = s.account_id
      WHERE s.token_hash = NEW.token_hash AND a.id = NEW.account_id AND a.enabled = 1
        AND s.expires_at > NEW.checked_at AND s.last_seen_at > NEW.checked_at - 1800000)
    BEGIN SELECT RAISE(ABORT, 'UNITY_SESSION_EXPIRED'); END`,
];
