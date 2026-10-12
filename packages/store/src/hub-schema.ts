/** Migration 3. Frozen with the migration ledger; subsequent schema changes need a new migration. */
export const hubSchema = [
  `CREATE TABLE unity_publications (
    id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
    revision_id TEXT NOT NULL, document_json TEXT NOT NULL CHECK(json_valid(document_json)),
    content_algorithm TEXT NOT NULL, content_hash TEXT NOT NULL, original_hash TEXT NOT NULL,
    parent_id TEXT REFERENCES unity_publications(id), created_at TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK(visibility IN ('private', 'members', 'public')),
    allow_original INTEGER NOT NULL CHECK(allow_original IN (0, 1)),
    allow_fork INTEGER NOT NULL CHECK(allow_fork IN (0, 1)),
    policy_version INTEGER NOT NULL DEFAULT 1 CHECK(policy_version > 0),
    UNIQUE(owner_id, revision_id),
    FOREIGN KEY(revision_id, workspace_id) REFERENCES unity_revisions(id, workspace_id)
  )`,
  `CREATE INDEX unity_publications_parent ON unity_publications(parent_id, id)`,
  `CREATE TABLE unity_publication_ancestors (
    publication_id TEXT NOT NULL REFERENCES unity_publications(id),
    ancestor_id TEXT NOT NULL REFERENCES unity_publications(id),
    depth INTEGER NOT NULL CHECK(depth BETWEEN 0 AND 32),
    PRIMARY KEY(publication_id, ancestor_id)
  )`,
  `CREATE TABLE unity_publication_forks (
    card_id TEXT PRIMARY KEY NOT NULL REFERENCES unity_cards(id),
    publication_id TEXT NOT NULL REFERENCES unity_publications(id),
    actor_id TEXT NOT NULL, policy_version INTEGER NOT NULL
  )`,
  `CREATE TRIGGER unity_publication_insert_guard BEFORE INSERT ON unity_publications
    WHEN NOT EXISTS (SELECT 1 FROM unity_revisions r
      JOIN unity_revision_seals s ON s.revision_id = r.id
      JOIN unity_workspaces w ON w.id = r.workspace_id
      JOIN unity_cards c ON c.id = r.card_id
      LEFT JOIN unity_publication_forks f ON f.card_id = c.id
      WHERE r.id = NEW.revision_id AND w.id = NEW.workspace_id AND w.owner_id = NEW.owner_id
        AND c.original_hash = NEW.original_hash AND r.content_hash = NEW.content_hash
        AND r.content_algorithm = NEW.content_algorithm AND f.publication_id IS NEW.parent_id)
    BEGIN SELECT RAISE(ABORT, 'UNITY_PUBLICATION_ACCESS'); END`,
  `CREATE TRIGGER unity_publication_ancestry AFTER INSERT ON unity_publications
    BEGIN
      INSERT INTO unity_publication_ancestors VALUES (NEW.id, NEW.id, 0);
      INSERT INTO unity_publication_ancestors(publication_id, ancestor_id, depth)
        SELECT NEW.id, ancestor_id, depth + 1 FROM unity_publication_ancestors WHERE publication_id = NEW.parent_id;
    END`,
  `CREATE TRIGGER unity_publication_update_guard BEFORE UPDATE ON unity_publications
    WHEN NEW.id IS NOT OLD.id OR NEW.owner_id IS NOT OLD.owner_id
      OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.revision_id IS NOT OLD.revision_id
      OR NEW.document_json IS NOT OLD.document_json OR NEW.content_algorithm IS NOT OLD.content_algorithm
      OR NEW.content_hash IS NOT OLD.content_hash OR NEW.original_hash IS NOT OLD.original_hash
      OR NEW.parent_id IS NOT OLD.parent_id OR NEW.created_at IS NOT OLD.created_at
      OR NEW.policy_version != OLD.policy_version + 1
    BEGIN SELECT RAISE(ABORT, 'UNITY_IMMUTABLE_PUBLICATION'); END`,
  `CREATE TRIGGER unity_publication_no_delete BEFORE DELETE ON unity_publications
    BEGIN SELECT RAISE(ABORT, 'UNITY_IMMUTABLE_PUBLICATION'); END`,
  `CREATE TRIGGER unity_publication_fork_guard BEFORE INSERT ON unity_publication_forks
    WHEN NOT EXISTS (SELECT 1 FROM unity_publications p
      JOIN unity_cards c ON c.id = NEW.card_id
      JOIN unity_revisions r ON r.id = c.head_revision_id
      JOIN unity_workspaces w ON w.id = c.workspace_id
      WHERE p.id = NEW.publication_id AND p.policy_version = NEW.policy_version
        AND w.owner_id = NEW.actor_id AND r.author_id = NEW.actor_id AND r.sequence = 1
        AND c.forked_from_revision_id = p.revision_id
        AND NOT EXISTS (SELECT 1 FROM unity_publication_ancestors a
          JOIN unity_publications ancestor ON ancestor.id = a.ancestor_id
          WHERE a.publication_id = p.id AND ancestor.owner_id != NEW.actor_id
            AND (ancestor.visibility = 'private' OR ancestor.allow_fork = 0)))
    BEGIN SELECT RAISE(ABORT, 'UNITY_PUBLICATION_ACCESS'); END`,
  ...['unity_publication_forks', 'unity_publication_ancestors'].flatMap((table) => [
    `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT, 'UNITY_IMMUTABLE_PUBLICATION'); END`,
    `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT, 'UNITY_IMMUTABLE_PUBLICATION'); END`,
  ]),
];
