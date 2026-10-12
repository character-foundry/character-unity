import { hubSchema } from './hub-schema.js';
import { accountsSchema } from './accounts-schema.js';
import { syncSchema } from './sync-schema.js';
import { syncOperationsSchema } from './sync-operations-schema.js';
import { syncOutboxSchema } from './sync-outbox-schema.js';
import { assetMaintenanceSchema } from './asset-maintenance-schema.js';
import { chatFingerprintSchema, chatSchema } from './chat-schema.js';
import { librarySchema } from './library-schema.js';
/** Append migrations; never edit a migration that has been applied to real data. */
export const migrations = [{
  version: 1,
  name: 'workspace_revisions',
  statements: [
    `CREATE TABLE unity_workspaces (
      id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL, name TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE unity_cards (
      id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL,
      head_revision_id TEXT, original_hash TEXT, forked_from_revision_id TEXT,
      created_at TEXT NOT NULL, UNIQUE(id, workspace_id),
      FOREIGN KEY(workspace_id) REFERENCES unity_workspaces(id),
      FOREIGN KEY(head_revision_id, id) REFERENCES unity_revisions(id, card_id),
      FOREIGN KEY(forked_from_revision_id) REFERENCES unity_revisions(id)
    )`,
    `CREATE TABLE unity_revisions (
      id TEXT PRIMARY KEY NOT NULL, card_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      parent_revision_id TEXT, author_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence > 0),
      content_algorithm TEXT NOT NULL, content_hash TEXT NOT NULL,
      document_json TEXT NOT NULL CHECK(json_valid(document_json)), created_at TEXT NOT NULL,
      UNIQUE(id, card_id), UNIQUE(id, workspace_id), UNIQUE(card_id, sequence),
      FOREIGN KEY(card_id, workspace_id) REFERENCES unity_cards(id, workspace_id),
      FOREIGN KEY(parent_revision_id) REFERENCES unity_revisions(id)
    )`,
    `CREATE INDEX unity_revisions_card ON unity_revisions(workspace_id, card_id, created_at, id)`,
    `CREATE INDEX unity_cards_workspace ON unity_cards(workspace_id, created_at, id)`,
    `CREATE INDEX unity_cards_forks ON unity_cards(forked_from_revision_id)`,
    `CREATE TABLE unity_assets (
      id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL,
      content_hash TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
      media_type TEXT NOT NULL, storage_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK(state IN ('staged', 'ready')),
      UNIQUE(id, workspace_id), FOREIGN KEY(workspace_id) REFERENCES unity_workspaces(id)
    )`,
    `CREATE TABLE unity_revision_assets (
      revision_id TEXT NOT NULL, workspace_id TEXT NOT NULL, path TEXT NOT NULL, asset_id TEXT NOT NULL,
      PRIMARY KEY(revision_id, path),
      FOREIGN KEY(revision_id, workspace_id) REFERENCES unity_revisions(id, workspace_id),
      FOREIGN KEY(asset_id, workspace_id) REFERENCES unity_assets(id, workspace_id)
    )`,
    `CREATE TABLE unity_revision_seals (
      revision_id TEXT PRIMARY KEY NOT NULL REFERENCES unity_revisions(id)
    )`,
    `CREATE TRIGGER unity_revision_head_guard BEFORE INSERT ON unity_revisions
      WHEN NOT EXISTS (
        SELECT 1 FROM unity_cards c WHERE c.id = NEW.card_id AND c.workspace_id = NEW.workspace_id
        AND ((c.head_revision_id IS NOT NULL AND c.head_revision_id = NEW.parent_revision_id)
          OR (c.head_revision_id IS NULL AND c.forked_from_revision_id IS NEW.parent_revision_id))
        AND (NEW.parent_revision_id IS NULL OR EXISTS
          (SELECT 1 FROM unity_revision_seals WHERE revision_id = NEW.parent_revision_id))
      ) BEGIN SELECT RAISE(ABORT, 'UNITY_HEAD_CONFLICT'); END`,
    `CREATE TRIGGER unity_card_identity_guard BEFORE UPDATE ON unity_cards
      WHEN OLD.id IS NOT NEW.id OR OLD.workspace_id IS NOT NEW.workspace_id
        OR OLD.original_hash IS NOT NEW.original_hash
        OR OLD.forked_from_revision_id IS NOT NEW.forked_from_revision_id
        OR OLD.created_at IS NOT NEW.created_at
      BEGIN SELECT RAISE(ABORT, 'UNITY_IMMUTABLE_PROVENANCE'); END`,
    `CREATE TRIGGER unity_card_head_guard BEFORE UPDATE OF head_revision_id ON unity_cards
      WHEN NOT EXISTS (SELECT 1 FROM unity_revisions r WHERE r.id = NEW.head_revision_id AND r.card_id = NEW.id
        AND ((OLD.head_revision_id IS NOT NULL AND r.parent_revision_id = OLD.head_revision_id)
          OR (OLD.head_revision_id IS NULL AND r.parent_revision_id IS OLD.forked_from_revision_id))
        AND NOT EXISTS (SELECT 1 FROM unity_revision_seals WHERE revision_id = r.id))
      BEGIN SELECT RAISE(ABORT, 'UNITY_HEAD_CONFLICT'); END`,
    `CREATE TRIGGER unity_revision_advance_head AFTER INSERT ON unity_revisions
      BEGIN UPDATE unity_cards SET head_revision_id = NEW.id WHERE id = NEW.card_id; END`,
    `CREATE TRIGGER unity_revision_no_update BEFORE UPDATE ON unity_revisions
      BEGIN SELECT RAISE(ABORT, 'UNITY_IMMUTABLE_REVISION'); END`,
    `CREATE TRIGGER unity_revision_no_delete BEFORE DELETE ON unity_revisions
      BEGIN SELECT RAISE(ABORT, 'UNITY_IMMUTABLE_REVISION'); END`,
    `CREATE TRIGGER unity_asset_ready_guard BEFORE INSERT ON unity_revision_assets
      WHEN NOT EXISTS (SELECT 1 FROM unity_assets a WHERE a.id = NEW.asset_id
        AND a.workspace_id = NEW.workspace_id AND a.state = 'ready')
      BEGIN SELECT RAISE(ABORT, 'UNITY_ASSET_NOT_READY'); END`,
    `CREATE TRIGGER unity_revision_asset_sealed BEFORE INSERT ON unity_revision_assets
      WHEN EXISTS (SELECT 1 FROM unity_revision_seals WHERE revision_id = NEW.revision_id)
      BEGIN SELECT RAISE(ABORT, 'UNITY_IMMUTABLE_REVISION'); END`,
    `CREATE TRIGGER unity_seal_no_update BEFORE UPDATE ON unity_revision_seals
      BEGIN SELECT RAISE(ABORT, 'UNITY_IMMUTABLE_REVISION'); END`,
    `CREATE TRIGGER unity_seal_no_delete BEFORE DELETE ON unity_revision_seals
      BEGIN SELECT RAISE(ABORT, 'UNITY_IMMUTABLE_REVISION'); END`,
    `CREATE TRIGGER unity_revision_asset_no_update BEFORE UPDATE ON unity_revision_assets
      BEGIN SELECT RAISE(ABORT, 'UNITY_IMMUTABLE_REVISION'); END`,
    `CREATE TRIGGER unity_revision_asset_no_delete BEFORE DELETE ON unity_revision_assets
      BEGIN SELECT RAISE(ABORT, 'UNITY_IMMUTABLE_REVISION'); END`,
    `CREATE TRIGGER unity_asset_identity_guard BEFORE UPDATE ON unity_assets
      WHEN OLD.id != NEW.id OR OLD.workspace_id != NEW.workspace_id
        OR OLD.content_hash != NEW.content_hash OR OLD.byte_length != NEW.byte_length
        OR OLD.media_type != NEW.media_type OR OLD.storage_key != NEW.storage_key
        OR (OLD.state = 'ready' AND NEW.state != 'ready')
      BEGIN SELECT RAISE(ABORT, 'UNITY_IMMUTABLE_ASSET'); END`,
  ],
}, {
  version: 2,
  name: 'immutable_card_sources',
  statements: [
    `CREATE TABLE unity_card_sources (
      card_id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, asset_id TEXT NOT NULL,
      provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)),
      FOREIGN KEY(card_id, workspace_id) REFERENCES unity_cards(id, workspace_id),
      FOREIGN KEY(asset_id, workspace_id) REFERENCES unity_assets(id, workspace_id)
    )`,
    `CREATE TRIGGER unity_source_insert_guard BEFORE INSERT ON unity_card_sources
      WHEN NOT EXISTS (SELECT 1 FROM unity_cards c JOIN unity_assets a ON a.id = NEW.asset_id
        WHERE c.id = NEW.card_id AND c.workspace_id = NEW.workspace_id AND c.head_revision_id IS NULL
        AND a.workspace_id = NEW.workspace_id AND a.state = 'ready')
      BEGIN SELECT RAISE(ABORT, 'UNITY_ASSET_NOT_READY'); END`,
    `CREATE TRIGGER unity_source_no_update BEFORE UPDATE ON unity_card_sources
      BEGIN SELECT RAISE(ABORT, 'UNITY_IMMUTABLE_PROVENANCE'); END`,
    `CREATE TRIGGER unity_source_no_delete BEFORE DELETE ON unity_card_sources
      BEGIN SELECT RAISE(ABORT, 'UNITY_IMMUTABLE_PROVENANCE'); END`,
  ],
}, { version: 3, name: 'pinned_publications', statements: hubSchema },
{ version: 4, name: 'accounts_and_sessions', statements: accountsSchema },
{ version: 5, name: 'publication_root_index', statements: [
  'CREATE INDEX unity_publications_root ON unity_publications(original_hash, id)',
] }, { version: 6, name: 'sync_peers_and_nonces', statements: syncSchema },
{ version: 7, name: 'sync_operation_receipts', statements: syncOperationsSchema },
{ version: 8, name: 'durable_sync_outbox', statements: syncOutboxSchema },
{ version: 9, name: 'asset_retirement_fences', statements: assetMaintenanceSchema },
{ version: 10, name: 'chat_placements', statements: chatSchema },
  { version: 11, name: 'chat_fingerprints', statements: chatFingerprintSchema },
  { version: 12, name: 'library_annotations', statements: librarySchema }] as const;
