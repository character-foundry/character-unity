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

/** Migration 15: trusted receipts are separate from all authored JSON, including
 * legacy local metadata. New receipt and fork commit in one atomic batch. */
export const chatImportReceiptSchema = [
  'ALTER TABLE unity_chat_targets ADD COLUMN configuration_version INTEGER NOT NULL DEFAULT 1 CHECK(configuration_version > 0)',
  `CREATE TABLE unity_chat_import_receipts (
    workspace_id TEXT NOT NULL, receipt_hash TEXT NOT NULL, author_id TEXT NOT NULL,
    source_card_id TEXT NOT NULL, source_revision_id TEXT NOT NULL,
    card_id TEXT NOT NULL, revision_id TEXT NOT NULL,
    target_id TEXT NOT NULL,target_configuration INTEGER NOT NULL,remote_id TEXT NOT NULL,base_revision_id TEXT NOT NULL,
    PRIMARY KEY(workspace_id,receipt_hash),
    FOREIGN KEY(card_id,workspace_id) REFERENCES unity_cards(id,workspace_id),
    FOREIGN KEY(revision_id,card_id) REFERENCES unity_revisions(id,card_id)
  )`,
  `CREATE TRIGGER unity_chat_import_connection_guard BEFORE INSERT ON unity_chat_import_receipts
    WHEN NOT EXISTS (SELECT 1 FROM unity_chat_targets t WHERE t.id = NEW.target_id AND t.workspace_id = NEW.workspace_id
      AND t.configuration_version = NEW.target_configuration
      AND (EXISTS (SELECT 1 FROM unity_chat_placements p WHERE p.target_id = t.id AND p.workspace_id = NEW.workspace_id
        AND p.remote_id = NEW.remote_id AND p.card_id = NEW.source_card_id AND p.revision_id = NEW.base_revision_id AND p.remote_state != 'missing')
        OR EXISTS (SELECT 1 FROM unity_archive_chat_placements p WHERE p.target_id = t.id AND p.workspace_id = NEW.workspace_id
          AND p.remote_id = NEW.remote_id AND p.reference_id = NEW.source_card_id AND p.revision_id = NEW.base_revision_id AND p.remote_state != 'missing')))
    BEGIN SELECT RAISE(ABORT,'UNITY_CHAT_ACCESS_CHANGED'); END`,
  `CREATE TRIGGER unity_chat_import_receipt_guard BEFORE INSERT ON unity_chat_import_receipts
    WHEN NOT EXISTS (SELECT 1 FROM unity_revisions r JOIN unity_cards c ON c.id = r.card_id
      WHERE r.id = NEW.revision_id AND r.card_id = NEW.card_id AND r.workspace_id = NEW.workspace_id
        AND r.author_id = NEW.author_id AND r.sequence = 1
        AND (EXISTS (SELECT 1 FROM unity_revisions source WHERE source.id = NEW.source_revision_id
          AND source.card_id = NEW.source_card_id AND c.forked_from_revision_id = source.id)
          OR EXISTS (SELECT 1 FROM unity_archive_fork_sources af WHERE af.card_id = c.id
            AND af.reference_id = NEW.source_card_id AND af.archive_version_id = NEW.source_revision_id)))
    BEGIN SELECT RAISE(ABORT,'UNITY_INVALID_CHAT_RECEIPT'); END`,
  ...['UPDATE', 'DELETE'].map((operation) => `CREATE TRIGGER unity_chat_import_receipt_no_${operation.toLowerCase()}
    BEFORE ${operation} ON unity_chat_import_receipts BEGIN SELECT RAISE(ABORT,'UNITY_IMMUTABLE_PROVENANCE'); END`),
] as const;

/** Reference placements contain only observations and identity digests. External
 * Archive versions never become Unity cards or revisions merely by being sent. */
export const chatReferenceSchema = [
  `CREATE TABLE unity_archive_chat_identities (
    reference_id TEXT NOT NULL, workspace_id TEXT NOT NULL, revision_id TEXT NOT NULL,
    revision_sequence INTEGER NOT NULL CHECK(revision_sequence > 0),content_hash TEXT NOT NULL,lineage_hash TEXT,
    PRIMARY KEY(reference_id),
    FOREIGN KEY(reference_id,workspace_id) REFERENCES unity_archive_references(id,workspace_id) ON DELETE CASCADE
  )`,
  'CREATE INDEX unity_archive_chat_identity_content ON unity_archive_chat_identities(workspace_id,content_hash)',
  'CREATE INDEX unity_archive_chat_identity_lineage ON unity_archive_chat_identities(workspace_id,lineage_hash)',
  `CREATE TABLE unity_archive_chat_placements (
    target_id TEXT NOT NULL REFERENCES unity_chat_targets(id) ON DELETE CASCADE,
    remote_id TEXT NOT NULL, remote_name TEXT NOT NULL,
    reference_id TEXT NOT NULL, workspace_id TEXT NOT NULL, revision_id TEXT NOT NULL,
    revision_sequence INTEGER NOT NULL CHECK(revision_sequence > 0),
    content_hash TEXT NOT NULL, lineage_hash TEXT,
    remote_state TEXT NOT NULL CHECK(remote_state IN ('matched', 'edited', 'missing')),
    sent_at TEXT, seen_at TEXT, remote_fingerprint TEXT,
    PRIMARY KEY(target_id,remote_id),
    FOREIGN KEY(reference_id,workspace_id) REFERENCES unity_archive_references(id,workspace_id) ON DELETE CASCADE
  )`,
  'CREATE INDEX unity_archive_chat_placements_card ON unity_archive_chat_placements(workspace_id,reference_id)',
  `CREATE TRIGGER unity_archive_chat_placement_pin_insert BEFORE INSERT ON unity_archive_chat_placements
    WHEN NOT EXISTS (SELECT 1 FROM unity_archive_references r WHERE r.id = NEW.reference_id
      AND r.workspace_id = NEW.workspace_id AND r.archive_version_id = NEW.revision_id)
    BEGIN SELECT RAISE(ABORT, 'UNITY_INVALID_REFERENCE'); END`,
  `CREATE TRIGGER unity_archive_chat_placement_pin_update BEFORE UPDATE ON unity_archive_chat_placements
    WHEN NOT EXISTS (SELECT 1 FROM unity_archive_references r WHERE r.id = NEW.reference_id
      AND r.workspace_id = NEW.workspace_id AND r.archive_version_id = NEW.revision_id)
    BEGIN SELECT RAISE(ABORT, 'UNITY_INVALID_REFERENCE'); END`,
] as const;
