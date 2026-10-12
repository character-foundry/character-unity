/**
 * Migration 12: per-library annotations. Revisions are immutable, so deleting a card records a tombstone that
 * every read honours instead of removing rows. Favorites and followed creators are local preferences, and
 * revision metrics (token counts) are derived once per immutable revision for filtering and sorting.
 */
export const librarySchema = [
  `CREATE TABLE unity_card_deletions (
    card_id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, deleted_at TEXT NOT NULL,
    FOREIGN KEY(card_id, workspace_id) REFERENCES unity_cards(id, workspace_id)
  )`,
  `CREATE TABLE unity_card_favorites (
    card_id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, created_at TEXT NOT NULL,
    FOREIGN KEY(card_id, workspace_id) REFERENCES unity_cards(id, workspace_id)
  )`,
  `CREATE TABLE unity_followed_creators (
    workspace_id TEXT NOT NULL REFERENCES unity_workspaces(id), creator_key TEXT NOT NULL, creator TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id, creator_key)
  )`,
  `CREATE TABLE unity_revision_metrics (
    revision_id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, tokenizer TEXT NOT NULL,
    tokens_total INTEGER NOT NULL CHECK(tokens_total >= 0), tokens_json TEXT NOT NULL CHECK(json_valid(tokens_json)),
    FOREIGN KEY(revision_id, workspace_id) REFERENCES unity_revisions(id, workspace_id)
  )`,
];
