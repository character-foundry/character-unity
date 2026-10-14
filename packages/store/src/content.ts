import type { JsonValue } from './types.js';
import { StoreError } from './types.js';
import type { Statement, StoreDriver } from './driver.js';
import * as validate from './validation.js';
import { contentForkableSql, contentVisibleSql } from './content-policy.js';
import { hashBytes } from '@character-foundry/character-foundry/identity';

export const contentKinds = ['lorebook', 'preset', 'persona'] as const;
export type ContentKind = typeof contentKinds[number];
export const contentByteLimit = 1_048_576;
export interface ContentDocument {
  id: string; workspaceId: string; kind: ContentKind; sourceId: string; headRevisionId: string;
  forkedFromRevisionId: string | null; sourcePublicationId: string | null; createdAt: string;
}
export interface ContentRevision {
  id: string; documentId: string; workspaceId: string; parentRevisionId: string | null; sequence: number;
  authorId: string; title: string; json: JsonValue; hash: string; createdAt: string;
}
export interface ContentOriginal { id: string; hash: string; text: string; filename: string }
export interface ContentRecord { document: ContentDocument; revision: ContentRevision }
export interface ContentSummary {
  id: string; kind: ContentKind; title: string; headRevisionId: string; revisionCount: number;
  forkedFromRevisionId: string | null; createdAt: string;
}
export interface ContentPolicy { visibility: 'private' | 'members' | 'public'; allowFork: boolean; allowOriginal: boolean }
export interface ContentPublication extends ContentPolicy {
  id: string; ownerId: string; workspaceId: string; revisionId: string; parentId: string | null; policyVersion: number; createdAt: string;
  kind: ContentKind; revision: ContentRevision;
}
export interface ContentPublicationSummary extends ContentPolicy {
  id: string; kind: ContentKind; title: string; sequence: number; policyVersion: number; createdAt: string; owned: boolean;
}
export interface ContentWrite { authorId: string; title: string; json: JsonValue; hash: string }
export interface ContentImport extends ContentWrite { workspaceId: string; kind: ContentKind; source: Omit<ContentOriginal, 'id'> }
export function contentKind(value: string): ContentKind {
  if (!(contentKinds as readonly string[]).includes(value)) throw new StoreError('INVALID_INPUT', 'Choose lorebook, preset or persona');
  return value as ContentKind;
}
export function contentJson(value: JsonValue) {
  if (!value || typeof value !== 'object') throw new StoreError('INVALID_INPUT', 'Standalone content must be a JSON object or array');
  validate.document({ value }, contentByteLimit + 20);
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).byteLength > contentByteLimit) throw new StoreError('INVALID_INPUT', 'Standalone content exceeds 1 MiB');
  return json;
}
export function contentPolicy(input: ContentPolicy): ContentPolicy {
  if (!['private','members','public'].includes(input.visibility) || typeof input.allowFork !== 'boolean' || typeof input.allowOriginal !== 'boolean') {
    throw new StoreError('INVALID_INPUT', 'Choose explicit visibility, fork and original-download permissions');
  }
  return { visibility: input.visibility, allowFork: input.allowFork, allowOriginal: input.allowOriginal };
}
const documentColumns = `d.id,d.workspace_id AS workspaceId,d.kind,d.source_id AS sourceId,d.head_revision_id AS headRevisionId,
  d.forked_from_revision_id AS forkedFromRevisionId,d.source_publication_id AS sourcePublicationId,d.created_at AS createdAt`;
const revisionColumns = `r.id,r.document_id AS documentId,r.workspace_id AS workspaceId,r.parent_revision_id AS parentRevisionId,
  r.sequence,r.author_id AS authorId,r.title,r.document_json AS json,r.content_hash AS hash,r.created_at AS createdAt`;
type RevisionRow = Omit<ContentRevision, 'json'> & { json: string };
const decode = (row: RevisionRow): ContentRevision => ({ ...row, json: JSON.parse(row.json) as JsonValue });
function write(input: ContentWrite) {
  return { authorId: validate.text(input.authorId, 'authorId'), title: validate.text(input.title, 'title', 500),
    json: contentJson(input.json), hash: validate.hash(input.hash) };
}
function original(input: Omit<ContentOriginal, 'id'>) {
  if (typeof input.text !== 'string' || new TextEncoder().encode(input.text).byteLength > contentByteLimit) throw new StoreError('INVALID_INPUT', 'Original exceeds 1 MiB');
  return { hash: validate.hash(input.hash), text: input.text, filename: validate.text(input.filename, 'filename', 512) };
}
/** Every published ancestor remains subject to its current visibility policy. */
const visible = contentVisibleSql('?');
const publicationColumns = `p.id,p.owner_id AS ownerId,p.workspace_id AS workspaceId,p.revision_id AS revisionId,
  p.parent_id AS parentId,p.policy_version AS policyVersion,p.created_at AS createdAt,p.visibility,
  p.allow_fork AS allowFork,p.allow_original AS allowOriginal,d.kind,r.document_id AS documentId,
  r.parent_revision_id AS revisionParentId,r.sequence,r.author_id AS revisionAuthorId,r.title,r.document_json AS json,
  r.content_hash AS hash,r.created_at AS revisionCreatedAt`;
interface PublicationRow extends Omit<ContentPublication, 'revision' | 'allowFork' | 'allowOriginal'> {
  allowFork: number; allowOriginal: number; documentId: string; revisionParentId: string | null; sequence: number;
  revisionAuthorId: string; title: string; json: string; hash: string; revisionCreatedAt: string;
}
function publication(row: PublicationRow): ContentPublication {
  const { documentId,revisionParentId,sequence,revisionAuthorId,title,json,hash,revisionCreatedAt,allowFork,allowOriginal,...base } = row;
  return { ...base, allowFork: Boolean(allowFork), allowOriginal: Boolean(allowOriginal), revision: {
    id: row.revisionId, documentId, workspaceId: row.workspaceId, parentRevisionId: revisionParentId, sequence,
    authorId: revisionAuthorId, title, json: JSON.parse(json) as JsonValue, hash, createdAt: revisionCreatedAt,
  } };
}

/** Trusted persistence interface; hosts enforce actor/workspace ownership. */
export function createContentStore(driver: StoreDriver) {
  async function batch(statements: readonly Statement[]) {
    try { return await driver.batch(statements); } catch (cause) {
      if (String(cause).includes('UNITY_HEAD_CONFLICT')) throw new StoreError('HEAD_CONFLICT', 'This content has a newer revision; reload before saving', { cause });
      if (String(cause).includes('UNITY_PUBLICATION_ACCESS')) throw new StoreError('ACCESS_CHANGED', 'Content sharing permissions changed; refresh before continuing', { cause });
      if (/constraint|UNITY_IMMUTABLE/.test(String(cause))) throw new StoreError('INTEGRITY', 'Content integrity check rejected the operation', { cause });
      throw cause;
    }
  }
  async function requireWorkspace(workspaceId: string) {
    const [row] = await driver.query({ sql: 'SELECT id FROM unity_workspaces WHERE id = ?', params: [validate.text(workspaceId, 'workspaceId')] });
    if (!row) throw new StoreError('NOT_FOUND', 'Workspace not found');
  }
  async function get(workspaceId: string, id: string): Promise<ContentRecord> {
    const [document] = await driver.query<ContentDocument>({ sql: `SELECT ${documentColumns} FROM unity_content_documents d
      WHERE d.workspace_id = ? AND d.id = ? AND d.deleted_at IS NULL`, params: [validate.text(workspaceId, 'workspaceId'), validate.text(id, 'contentId')] });
    if (!document) throw new StoreError('NOT_FOUND', 'Content not found in this workspace');
    return { document, revision: await revision(workspaceId, document.id, document.headRevisionId) };
  }
  async function revision(workspaceId: string, documentId: string, id: string) {
    const [row] = await driver.query<RevisionRow>({ sql: `SELECT ${revisionColumns} FROM unity_content_revisions r
      WHERE r.workspace_id = ? AND r.document_id = ? AND r.id = ?`, params: [validate.text(workspaceId, 'workspaceId'), validate.text(documentId, 'contentId'), validate.text(id, 'revisionId')] });
    if (!row) throw new StoreError('NOT_FOUND', 'Content revision not found in this workspace');
    return decode(row);
  }
  async function getOriginal(workspaceId: string, documentId: string): Promise<ContentOriginal> {
    const [row] = await driver.query<ContentOriginal>({ sql: `SELECT s.id,s.file_hash AS hash,s.original_text AS text,s.filename
      FROM unity_content_sources s JOIN unity_content_documents d ON d.source_id = s.id
      WHERE d.workspace_id = ? AND d.id = ? AND d.deleted_at IS NULL`, params: [validate.text(workspaceId, 'workspaceId'), validate.text(documentId, 'contentId')] });
    if (!row) throw new StoreError('NOT_FOUND', 'Content original not found in this workspace');
    return row;
  }
  function revisionStatement(id: string, documentId: string, workspaceId: string, parent: string | null, input: ReturnType<typeof write>): Statement {
    return { sql: `INSERT INTO unity_content_revisions(id,document_id,workspace_id,parent_revision_id,sequence,author_id,title,document_json,content_hash,created_at)
      VALUES (?,?,?,?,coalesce((SELECT r.sequence FROM unity_content_documents d JOIN unity_content_revisions r ON r.id = d.head_revision_id WHERE d.id = ?),0)+1,?,?,?,?,?)`,
    params: [id, documentId, workspaceId, parent, documentId, input.authorId, input.title, input.json, input.hash, new Date().toISOString()] };
  }
  async function match(workspaceId: string, kind: ContentKind, sourceHash: string, hash: string | null) {
    const [row] = await driver.query<{ id: string }>({ sql: `SELECT d.id FROM unity_content_documents d JOIN unity_content_import_claims i ON i.document_id = d.id
      WHERE i.workspace_id = ? AND i.kind = ? AND d.deleted_at IS NULL AND ((i.identity_kind = 'file' AND i.hash = ?) OR (i.identity_kind = 'content' AND i.hash = ?))
      ORDER BY CASE i.identity_kind WHEN 'file' THEN 0 ELSE 1 END,d.id LIMIT 1`, params: [workspaceId, kind, sourceHash, hash] });
    if (row) return get(workspaceId, row.id);
    if (hash === null) return null;
    const [head] = await driver.query<{ id: string }>({ sql: `SELECT d.id FROM unity_content_documents d JOIN unity_content_revisions r ON r.id = d.head_revision_id
      WHERE d.workspace_id = ? AND d.kind = ? AND d.deleted_at IS NULL AND r.content_hash = ? ORDER BY d.id LIMIT 1`, params: [workspaceId, kind, hash] });
    return head ? get(workspaceId, head.id) : null;
  }
  async function importContent(input: ContentImport) {
    const value = write(input), source = original(input.source), kind = contentKind(input.kind), workspaceId = validate.text(input.workspaceId, 'workspaceId');
    await requireWorkspace(workspaceId);
    const known = await match(workspaceId, kind, source.hash, value.hash);
    if (known) return { created: false, record: known };
    const id = crypto.randomUUID(), revisionId = crypto.randomUUID();
    try {
      await batch([
        { sql: `INSERT INTO unity_content_sources(id,workspace_id,file_hash,original_text,filename) VALUES (?,?,?,?,?)
          ON CONFLICT(workspace_id,file_hash) DO NOTHING`, params: [crypto.randomUUID(), workspaceId, source.hash, source.text, source.filename] },
        { sql: `INSERT INTO unity_content_documents(id,workspace_id,kind,source_id,created_at)
          VALUES (?,?,?,(SELECT id FROM unity_content_sources WHERE workspace_id = ? AND file_hash = ?),?)`, params: [id, workspaceId, kind, workspaceId, source.hash, new Date().toISOString()] },
        revisionStatement(revisionId, id, workspaceId, null, value),
        ...(['file','content'] as const).map((identityKind) => ({ sql: 'INSERT INTO unity_content_import_claims(workspace_id,kind,identity_kind,hash,document_id,revision_id) VALUES (?,?,?,?,?,?)',
          params: [workspaceId, kind, identityKind, identityKind === 'file' ? source.hash : value.hash, id, revisionId] })),
      ]);
    } catch (error) { const raced = await match(workspaceId, kind, source.hash, value.hash); if (raced) return { created: false, record: raced }; throw error; }
    return { created: true, record: await get(workspaceId, id) };
  }
  async function getPublication(actorId: string | null, id: string): Promise<ContentPublication> {
    const [row] = await driver.query<PublicationRow>({ sql: `SELECT ${publicationColumns} FROM unity_content_publications p
      JOIN unity_content_revisions r ON r.id = p.revision_id JOIN unity_content_documents d ON d.id = r.document_id
      WHERE p.id = ? AND ${visible}`, params: [validate.text(id, 'publicationId'), actorId, actorId] });
    if (!row) throw new StoreError('NOT_FOUND', 'Shared content not found');
    return publication(row);
  }
  return {
    get, revision, original: getOriginal, import: importContent, publication: getPublication,
    findImport: (workspaceId: string, kind: ContentKind, fileHash: string) => match(validate.text(workspaceId, 'workspaceId'), contentKind(kind), validate.hash(fileHash), null),
    async list(workspaceId: string, options: { kind?: ContentKind; q?: string; afterId?: string; limit?: number } = {}) {
      const kind = options.kind === undefined ? undefined : contentKind(options.kind), q = options.q === undefined ? '' : validate.text(options.q, 'search', 500).trim();
      const limit = validate.limit(options.limit ?? 20), afterId = options.afterId === undefined ? '' : validate.text(options.afterId, 'afterId');
      await requireWorkspace(workspaceId);
      const params: (string | number)[] = [workspaceId, ...(kind ? [kind] : []), ...(q ? [q] : [])];
      const where = `d.workspace_id = ? AND d.deleted_at IS NULL ${kind ? 'AND d.kind = ?' : ''} ${q ? 'AND instr(lower(r.title),lower(?)) > 0' : ''}`;
      const [total] = await driver.query<{ total: number }>({ sql: `SELECT count(*) AS total FROM unity_content_documents d JOIN unity_content_revisions r ON r.id = d.head_revision_id WHERE ${where}`, params });
      const items = await driver.query<ContentSummary>({ sql: `SELECT d.id,d.kind,r.title,d.head_revision_id AS headRevisionId,r.sequence AS revisionCount,
        d.forked_from_revision_id AS forkedFromRevisionId,d.created_at AS createdAt FROM unity_content_documents d JOIN unity_content_revisions r ON r.id = d.head_revision_id
        WHERE ${where} AND d.id > ? ORDER BY d.id LIMIT ?`, params: [...params, afterId, limit + 1] });
      const page = items.slice(0, limit);
      return { items: page, total: Number(total?.total ?? 0), nextAfter: items.length > limit ? page.at(-1)!.id : null };
    },
    async save(input: ContentWrite & { workspaceId: string; documentId: string; expectedHead: string }) {
      const value = write(input), workspaceId = validate.text(input.workspaceId, 'workspaceId'), documentId = validate.text(input.documentId, 'contentId');
      const parent = validate.text(input.expectedHead, 'expectedHead'); await get(workspaceId, documentId);
      const id = crypto.randomUUID(); await batch([revisionStatement(id, documentId, workspaceId, parent, value)]);
      return revision(workspaceId, documentId, id);
    },
    async fork(workspaceId: string, documentId: string, revisionId: string, authorId: string) {
      const source = await get(workspaceId, documentId), selected = await revision(workspaceId, documentId, revisionId);
      const value = write({ ...selected, authorId }), id = crypto.randomUUID(), head = crypto.randomUUID();
      await batch([
        { sql: `INSERT INTO unity_content_documents(id,workspace_id,kind,source_id,forked_from_revision_id,source_publication_id,created_at)
          VALUES (?,?,?,?,?,?,?)`, params: [id, workspaceId, source.document.kind, source.document.sourceId, selected.id, source.document.sourcePublicationId, new Date().toISOString()] },
        revisionStatement(head, id, workspaceId, selected.id, value),
      ]);
      return get(workspaceId, id);
    },
    async history(workspaceId: string, documentId: string, options: { afterSequence?: number; limit?: number } = {}) {
      await get(workspaceId, documentId);
      const limit = validate.limit(options.limit ?? 20);
      const rows = await driver.query<Omit<ContentRevision,'json'>>({ sql: `SELECT r.id,r.document_id AS documentId,r.workspace_id AS workspaceId,r.parent_revision_id AS parentRevisionId,
        r.sequence,r.author_id AS authorId,r.title,r.content_hash AS hash,r.created_at AS createdAt FROM unity_content_revisions r
        WHERE r.workspace_id = ? AND r.document_id = ? AND r.sequence > ? ORDER BY r.sequence LIMIT ?`,
      params: [workspaceId, documentId, validate.count(options.afterSequence ?? 0, 'afterSequence'), limit + 1] });
      return { revisions: rows.slice(0,limit), nextAfter: rows.length > limit ? rows[limit - 1]!.sequence : null };
    },
    async remove(workspaceId: string, documentId: string) {
      await get(workspaceId, documentId); await batch([{ sql: 'UPDATE unity_content_documents SET deleted_at = ? WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL', params: [new Date().toISOString(), workspaceId, documentId] }]);
    },
    async publish(actorId: string, workspaceId: string, documentId: string, revisionId: string, input: ContentPolicy) {
      const policy = contentPolicy(input), actor = validate.text(actorId, 'actorId');
      const source = await get(workspaceId, documentId); await revision(workspaceId, documentId, revisionId);
      const id = crypto.randomUUID();
      await batch([{ sql: `INSERT INTO unity_content_publications(id,owner_id,workspace_id,revision_id,parent_id,visibility,allow_fork,allow_original,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`, params: [id, actor, workspaceId, revisionId, source.document.sourcePublicationId, policy.visibility,
          Number(policy.allowFork), Number(policy.allowOriginal), new Date().toISOString()] }]);
      return getPublication(actor, id);
    },
    async updatePublication(actorId: string, publicationId: string, expectedVersion: number, input: ContentPolicy) {
      const policy = contentPolicy(input), actor = validate.text(actorId, 'actorId');
      validate.count(expectedVersion, 'expectedVersion');
      const changed = await batch([{ sql: `UPDATE unity_content_publications SET visibility = ?,allow_fork = ?,allow_original = ?,policy_version = policy_version + 1
        WHERE id = ? AND owner_id = ? AND policy_version = ?`, params: [policy.visibility, Number(policy.allowFork), Number(policy.allowOriginal),
        validate.text(publicationId, 'publicationId'), actor, expectedVersion] }]);
      if (changed[0] !== 1) throw new StoreError('ACCESS_CHANGED', 'Content sharing policy changed or belongs to another account');
      return getPublication(actor, publicationId);
    },
    async publicationOriginal(actorId: string | null, publicationId: string): Promise<ContentOriginal> {
      const shared = await getPublication(actorId, publicationId);
      if (shared.ownerId !== actorId && !shared.allowOriginal) throw new StoreError('ACCESS_CHANGED', 'Original download is not permitted');
      const [row] = await driver.query<ContentOriginal>({ sql: `SELECT s.id,s.file_hash AS hash,s.original_text AS text,s.filename
        FROM unity_content_sources s JOIN unity_content_documents d ON d.source_id = s.id
        JOIN unity_content_revisions r ON r.document_id = d.id WHERE r.id = ?`, params: [shared.revisionId] });
      if (!row) throw new StoreError('NOT_FOUND', 'Shared content original not found');
      const current = await getPublication(actorId, publicationId);
      if (current.policyVersion !== shared.policyVersion || (current.ownerId !== actorId && !current.allowOriginal)) throw new StoreError('ACCESS_CHANGED', 'Original permission changed; refresh before downloading');
      return row;
    },
    async publications(actorId: string | null, options: { mine?: boolean; kind?: ContentKind; afterId?: string; limit?: number } = {}) {
      if (options.mine && !actorId) throw new StoreError('UNAUTHENTICATED', 'Sign in to list your shared content');
      const limit = validate.limit(options.limit ?? 20), kind = options.kind === undefined ? undefined : contentKind(options.kind);
      const rows = await driver.query<Omit<ContentPublicationSummary,'allowFork'|'allowOriginal'|'owned'> & { allowFork: number; allowOriginal: number; owned: number }>({
        sql: `SELECT p.id,d.kind,r.title,r.sequence,p.policy_version AS policyVersion,p.created_at AS createdAt,p.visibility,
          p.allow_fork AS allowFork,p.allow_original AS allowOriginal,(p.owner_id = ?) AS owned
          FROM unity_content_publications p JOIN unity_content_revisions r ON r.id = p.revision_id JOIN unity_content_documents d ON d.id = r.document_id
          WHERE p.id > ? AND ${visible} ${options.mine ? 'AND p.owner_id = ?' : ''} ${kind ? 'AND d.kind = ?' : ''} ORDER BY p.id LIMIT ?`,
        params: [actorId, options.afterId === undefined ? '' : validate.text(options.afterId, 'afterId'), actorId, actorId, ...(options.mine ? [actorId] : []), ...(kind ? [kind] : []), limit + 1],
      });
      const items = rows.slice(0,limit).map((row) => ({ ...row, allowFork: Boolean(row.allowFork), allowOriginal: Boolean(row.allowOriginal), owned: Boolean(row.owned) }));
      return { items, nextAfter: rows.length > limit ? items.at(-1)!.id : null };
    },
    async forkPublication(actorId: string, workspaceId: string, publicationId: string, expectedVersion: number) {
      const actor = validate.text(actorId, 'actorId'); validate.count(expectedVersion, 'expectedVersion');
      await requireWorkspace(workspaceId);
      const shared = await getPublication(actor, publicationId), value = write({ ...shared.revision, authorId: actor });
      if (shared.policyVersion !== expectedVersion) throw new StoreError('ACCESS_CHANGED', 'Content sharing policy changed; refresh before forking');
      const [permission] = await driver.query({ sql: `SELECT p.id FROM unity_content_publications p WHERE p.id = ? AND p.policy_version = ?
        AND ${visible} AND ${contentForkableSql('?')}`, params: [shared.id,expectedVersion,actor,actor,actor] });
      if (!permission) throw new StoreError('ACCESS_CHANGED','Private forks are not permitted by the current sharing policy');
      const sourceHash = await hashBytes(new TextEncoder().encode(value.json)), sourceId = crypto.randomUUID(), id = crypto.randomUUID(), head = crypto.randomUUID();
      try { await batch([
        { sql: `INSERT INTO unity_content_sources(id,workspace_id,file_hash,original_text,filename) VALUES (?,?,?,?,?)
          ON CONFLICT(workspace_id,file_hash) DO NOTHING`, params: [sourceId, workspaceId, sourceHash, value.json, `${shared.kind}.json`] },
        { sql: `INSERT INTO unity_content_documents(id,workspace_id,kind,source_id,forked_from_revision_id,source_publication_id,created_at)
          SELECT ?,?,?,(SELECT id FROM unity_content_sources WHERE workspace_id = ? AND file_hash = ?),?,?,?
          FROM unity_content_publications p WHERE p.id = ? AND p.policy_version = ? AND ${visible} AND ${contentForkableSql('?')}
            AND EXISTS (SELECT 1 FROM unity_workspaces WHERE id = ? AND owner_id = ?)`,
        params: [id, workspaceId, shared.kind, workspaceId, sourceHash, shared.revisionId, shared.id, new Date().toISOString(), shared.id, expectedVersion, actor, actor, actor, workspaceId, actor] },
        revisionStatement(head, id, workspaceId, shared.revisionId, value),
      ]); } catch (cause) {
        if (cause instanceof StoreError && cause.code === 'HEAD_CONFLICT') throw new StoreError('ACCESS_CHANGED','Content sharing permissions changed before the fork committed',{ cause });
        throw cause;
      }
      return get(workspaceId, id);
    },
  };
}
export type ContentStore = ReturnType<typeof createContentStore>;
