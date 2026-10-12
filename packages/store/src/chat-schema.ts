/**
 * Migration 10: chat applications a workspace sends cards to, and where each card lives there.
 * Placements are observations of another application's state, so unlike revisions they are mutable.
 */
export const chatSchema = [
  `CREATE TABLE unity_chat_targets (
    id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL REFERENCES unity_workspaces(id),
    kind TEXT NOT NULL CHECK(kind IN ('sillytavern', 'lumiverse', 'marinara')),
    name TEXT NOT NULL, base_url TEXT NOT NULL,
    credentials_json TEXT NOT NULL CHECK(json_valid(credentials_json)),
    created_at TEXT NOT NULL, scanned_at TEXT, scan_error TEXT,
    UNIQUE(workspace_id, kind, base_url)
  )`,
  `CREATE TABLE unity_chat_placements (
    target_id TEXT NOT NULL REFERENCES unity_chat_targets(id) ON DELETE CASCADE,
    remote_id TEXT NOT NULL, remote_name TEXT NOT NULL,
    card_id TEXT NOT NULL, workspace_id TEXT NOT NULL, revision_id TEXT REFERENCES unity_revisions(id),
    remote_state TEXT NOT NULL CHECK(remote_state IN ('matched', 'edited', 'missing')),
    sent_at TEXT, seen_at TEXT,
    PRIMARY KEY(target_id, remote_id),
    FOREIGN KEY(card_id, workspace_id) REFERENCES unity_cards(id, workspace_id)
  )`,
  'CREATE INDEX unity_chat_placements_card ON unity_chat_placements(workspace_id, card_id)',
  `CREATE INDEX unity_revisions_lineage_hash ON unity_revisions(workspace_id,
    json_extract(document_json, '$.data.extensions.foundry.lineage.revisionHash'))`,
];

/**
 * Migration 11: apps that rebuild cards on export (Lumiverse, Marinara) cannot be checked with the transport
 * marker, so a send records a fingerprint of the copy as the app stores it; a later mismatch means it was edited there.
 */
export const chatFingerprintSchema = ['ALTER TABLE unity_chat_placements ADD COLUMN remote_fingerprint TEXT'];
