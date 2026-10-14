import { contentForkableSql, contentVisibleSql } from './content-policy.js';

/** Migration 16: standalone JSON content, not counterfeit character revisions.
 * Originals are workspace-deduplicated, immutable, reversible UTF-8 source text. */
export const contentSchema = [
  `CREATE TABLE unity_content_sources (
    id TEXT PRIMARY KEY NOT NULL,workspace_id TEXT NOT NULL REFERENCES unity_workspaces(id),
    file_hash TEXT NOT NULL,original_text TEXT NOT NULL,filename TEXT NOT NULL,
    UNIQUE(id,workspace_id),UNIQUE(workspace_id,file_hash)
  )`,
  `CREATE TABLE unity_content_documents (
    id TEXT PRIMARY KEY NOT NULL,workspace_id TEXT NOT NULL REFERENCES unity_workspaces(id),
    kind TEXT NOT NULL CHECK(kind IN ('lorebook','preset','persona')),source_id TEXT NOT NULL,
    head_revision_id TEXT,forked_from_revision_id TEXT,source_publication_id TEXT,created_at TEXT NOT NULL,deleted_at TEXT,
    UNIQUE(id,workspace_id),FOREIGN KEY(source_id,workspace_id) REFERENCES unity_content_sources(id,workspace_id),
    FOREIGN KEY(head_revision_id,id) REFERENCES unity_content_revisions(id,document_id),
    FOREIGN KEY(forked_from_revision_id) REFERENCES unity_content_revisions(id),
    FOREIGN KEY(source_publication_id) REFERENCES unity_content_publications(id)
  )`,
  'CREATE INDEX unity_content_documents_workspace ON unity_content_documents(workspace_id,id)',
  `CREATE TABLE unity_content_revisions (
    id TEXT PRIMARY KEY NOT NULL,document_id TEXT NOT NULL,workspace_id TEXT NOT NULL,parent_revision_id TEXT,
    sequence INTEGER NOT NULL CHECK(sequence > 0),author_id TEXT NOT NULL,title TEXT NOT NULL,
    document_json TEXT NOT NULL CHECK(json_valid(document_json)),content_hash TEXT NOT NULL,created_at TEXT NOT NULL,
    UNIQUE(id,document_id),UNIQUE(id,workspace_id),UNIQUE(document_id,sequence),
    FOREIGN KEY(document_id,workspace_id) REFERENCES unity_content_documents(id,workspace_id),
    FOREIGN KEY(parent_revision_id) REFERENCES unity_content_revisions(id)
  )`,
  'CREATE INDEX unity_content_history ON unity_content_revisions(workspace_id,document_id,sequence)',
  `CREATE TABLE unity_content_import_claims (
    workspace_id TEXT NOT NULL,kind TEXT NOT NULL,identity_kind TEXT NOT NULL CHECK(identity_kind IN ('file','content')),
    hash TEXT NOT NULL,document_id TEXT NOT NULL,revision_id TEXT NOT NULL,
    PRIMARY KEY(workspace_id,kind,identity_kind,hash),
    FOREIGN KEY(document_id,workspace_id) REFERENCES unity_content_documents(id,workspace_id),
    FOREIGN KEY(revision_id,workspace_id) REFERENCES unity_content_revisions(id,workspace_id)
  )`,
  'CREATE INDEX unity_content_claims_document ON unity_content_import_claims(document_id)',
  `CREATE TABLE unity_content_publications (
    id TEXT PRIMARY KEY NOT NULL,owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,revision_id TEXT NOT NULL,parent_id TEXT,
    visibility TEXT NOT NULL CHECK(visibility IN ('private','members','public')),allow_fork INTEGER NOT NULL CHECK(allow_fork IN (0,1)),
    allow_original INTEGER NOT NULL CHECK(allow_original IN (0,1)),policy_version INTEGER NOT NULL DEFAULT 1 CHECK(policy_version > 0),created_at TEXT NOT NULL,
    FOREIGN KEY(revision_id,workspace_id) REFERENCES unity_content_revisions(id,workspace_id),
    FOREIGN KEY(parent_id) REFERENCES unity_content_publications(id)
  )`,
  'CREATE INDEX unity_content_publications_owner ON unity_content_publications(owner_id,id)',
  `CREATE TRIGGER unity_content_revision_guard BEFORE INSERT ON unity_content_revisions
    WHEN NOT EXISTS (SELECT 1 FROM unity_content_documents d WHERE d.id = NEW.document_id AND d.workspace_id = NEW.workspace_id
      AND d.deleted_at IS NULL AND ((d.head_revision_id IS NOT NULL AND d.head_revision_id = NEW.parent_revision_id)
        OR (d.head_revision_id IS NULL AND d.forked_from_revision_id IS NEW.parent_revision_id))
      AND NEW.sequence = coalesce((SELECT sequence FROM unity_content_revisions WHERE id = d.head_revision_id),0) + 1)
    BEGIN SELECT RAISE(ABORT,'UNITY_HEAD_CONFLICT'); END`,
  `CREATE TRIGGER unity_content_advance_head AFTER INSERT ON unity_content_revisions BEGIN
    UPDATE unity_content_documents SET head_revision_id = NEW.id WHERE id = NEW.document_id;
    DELETE FROM unity_content_import_claims WHERE document_id = NEW.document_id AND identity_kind = 'content'; END`,
  `CREATE TRIGGER unity_content_document_guard BEFORE UPDATE ON unity_content_documents
    WHEN OLD.id IS NOT NEW.id OR OLD.workspace_id IS NOT NEW.workspace_id OR OLD.kind IS NOT NEW.kind
      OR OLD.source_id IS NOT NEW.source_id OR OLD.forked_from_revision_id IS NOT NEW.forked_from_revision_id
      OR OLD.source_publication_id IS NOT NEW.source_publication_id OR OLD.created_at IS NOT NEW.created_at
      OR (OLD.deleted_at IS NOT NULL AND OLD.deleted_at IS NOT NEW.deleted_at)
    BEGIN SELECT RAISE(ABORT,'UNITY_IMMUTABLE_PROVENANCE'); END`,
  `CREATE TRIGGER unity_content_head_guard BEFORE UPDATE OF head_revision_id ON unity_content_documents
    WHEN NOT EXISTS (SELECT 1 FROM unity_content_revisions r WHERE r.id = NEW.head_revision_id AND r.document_id = NEW.id
      AND ((OLD.head_revision_id IS NOT NULL AND r.parent_revision_id = OLD.head_revision_id)
        OR (OLD.head_revision_id IS NULL AND r.parent_revision_id IS OLD.forked_from_revision_id)))
    BEGIN SELECT RAISE(ABORT,'UNITY_HEAD_CONFLICT'); END`,
  `CREATE TRIGGER unity_content_deleted AFTER UPDATE OF deleted_at ON unity_content_documents WHEN NEW.deleted_at IS NOT NULL
    BEGIN DELETE FROM unity_content_import_claims WHERE document_id = NEW.id; END`,
  ...['unity_content_sources','unity_content_revisions'].flatMap((table) => ['UPDATE','DELETE'].map((operation) =>
    `CREATE TRIGGER ${table}_${operation.toLowerCase()} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'UNITY_IMMUTABLE_REVISION'); END`)),
  `CREATE TRIGGER unity_content_document_no_delete BEFORE DELETE ON unity_content_documents
    BEGIN SELECT RAISE(ABORT,'UNITY_IMMUTABLE_PROVENANCE'); END`,
  `CREATE TRIGGER unity_content_publication_identity BEFORE UPDATE ON unity_content_publications
    WHEN OLD.id IS NOT NEW.id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.workspace_id IS NOT NEW.workspace_id
      OR OLD.revision_id IS NOT NEW.revision_id OR OLD.parent_id IS NOT NEW.parent_id OR OLD.created_at IS NOT NEW.created_at
      OR NEW.policy_version <> OLD.policy_version + 1
    BEGIN SELECT RAISE(ABORT,'UNITY_IMMUTABLE_PROVENANCE'); END`,
  `CREATE TRIGGER unity_content_publication_guard BEFORE INSERT ON unity_content_publications
    WHEN NOT EXISTS (SELECT 1 FROM unity_content_revisions r JOIN unity_content_documents d ON d.id = r.document_id
      JOIN unity_workspaces w ON w.id = d.workspace_id WHERE r.id = NEW.revision_id AND w.owner_id = NEW.owner_id
      AND d.deleted_at IS NULL AND d.source_publication_id IS NEW.parent_id)
      OR (NEW.parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM unity_content_publications p
        WHERE p.id = NEW.parent_id AND ${contentVisibleSql('NEW.owner_id')} AND ${contentForkableSql('NEW.owner_id')}))
    BEGIN SELECT RAISE(ABORT,'UNITY_PUBLICATION_ACCESS'); END`,
  `CREATE TRIGGER unity_content_publication_no_delete BEFORE DELETE ON unity_content_publications
    BEGIN SELECT RAISE(ABORT,'UNITY_IMMUTABLE_PROVENANCE'); END`,
] as const;
