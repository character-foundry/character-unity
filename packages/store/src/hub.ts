import { commitSyncMutation, readSyncReceipt, requireSyncWrite, snapshotSyncContext } from './sync-operations.js';
import type { SyncWriteContext, SyncMutationTarget } from './sync-operations.js';
import type { StoreDriver, Statement } from './driver.js';
import { StoreError } from './types.js';
import type { CardDocument, ContentIdentity } from './types.js';
import * as validate from './validation.js';

export interface PublicationPolicy {
  visibility: 'private' | 'members' | 'public';
  allowOriginal: boolean;
  allowFork: boolean;
}
/** Internal record. Source workspace/revision identifiers must not be sent to public readers. */
export interface Publication extends PublicationPolicy {
  id: string; ownerId: string; workspaceId: string; revisionId: string;
  document: CardDocument; identity: ContentIdentity; originalHash: string;
  parentId: string | null; createdAt: string; policyVersion: number;
}
export interface PublishInput extends PublicationPolicy {
  workspaceId: string; revisionId: string; document: CardDocument;
  identity: ContentIdentity; originalHash: string;
}
type Row = Omit<Publication, 'document' | 'identity' | 'allowFork' | 'allowOriginal'> & {
  document: string; algorithm: string; hash: string; allowOriginal: number; allowFork: number;
};
const columns = `p.id, p.owner_id AS ownerId, p.workspace_id AS workspaceId, p.revision_id AS revisionId,
  p.document_json AS document, p.content_algorithm AS algorithm, p.content_hash AS hash,
  p.original_hash AS originalHash, p.parent_id AS parentId, p.created_at AS createdAt,
  p.visibility, p.allow_original AS allowOriginal, p.allow_fork AS allowFork, p.policy_version AS policyVersion`;
function decode(row: Row): Publication {
  const { document, algorithm, hash, allowOriginal, allowFork, ...rest } = row;
  return { ...rest, document: JSON.parse(document) as CardDocument, identity: { algorithm, hash }, allowOriginal: !!allowOriginal, allowFork: !!allowFork };
}
export function publicationPolicy(input: PublicationPolicy): PublicationPolicy {
  if (!['private', 'members', 'public'].includes(input.visibility)
    || typeof input.allowOriginal !== 'boolean' || typeof input.allowFork !== 'boolean') validate.invalid('Expected explicit publication visibility, original-download and fork permissions');
  return { visibility: input.visibility, allowOriginal: input.allowOriginal, allowFork: input.allowFork };
}
/** All ancestor restrictions apply to shared reads, including after a policy change. */
const visible = `NOT EXISTS (SELECT 1 FROM unity_publication_ancestors a
  JOIN unity_publications ancestor ON ancestor.id = a.ancestor_id
  WHERE a.publication_id = p.id AND NOT (ancestor.owner_id = COALESCE(?, '')
    OR ancestor.visibility = 'public' OR (ancestor.visibility = 'members' AND ? IS NOT NULL)))`;

/** Actor IDs come from the host authentication boundary, never request JSON. */
export function createHubStore(driver: StoreDriver) {
  async function get(actorId: string | null, id: string): Promise<Publication> {
    validate.text(id, 'publicationId');
    const [row] = await driver.query<Row>({ sql: `SELECT ${columns} FROM unity_publications p WHERE p.id = ? AND ${visible}`, params: [id, actorId, actorId] });
    if (!row) throw new StoreError('NOT_FOUND', 'Publication not found');
    return decode(row);
  }
  async function syncResult(context: SyncWriteContext, target: SyncMutationTarget, ids: readonly string[]) {
    const publications = await Promise.all(ids.map((id) => get(target.accountId, id)));
    if (publications.some((publication) => publication.ownerId !== target.accountId || publication.workspaceId !== target.workspaceId)) {
      throw new StoreError('INTEGRITY', 'Sync publication receipt escaped its grant');
    }
    await requireSyncWrite(driver, context, target);
    return publications;
  }
  return {
    get,
    async findSyncPublication(actorId: string, workspaceId: string, syncContext: SyncWriteContext) {
      const context = snapshotSyncContext(syncContext)!;
      const target: SyncMutationTarget = { scope: 'publish', accountId: validate.text(actorId, 'actorId'), workspaceId: validate.text(workspaceId, 'workspaceId') };
      const receipt = await readSyncReceipt(driver, context, target);
      return receipt ? syncResult(context, target, receipt.result) : null;
    },
    async rootPage(actorId: string | null, originalHash: string, options: { afterId?: string; limit?: number } = {}) {
      validate.hash(originalHash);
      if (options.afterId) validate.text(options.afterId, 'afterId');
      const limit = options.limit ?? 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) validate.invalid('Lineage page size must be between 1 and 20');
      // Filter access before pagination. Never expose a count or cursor for hidden rows.
      const rows = await driver.query<Row>({ sql: `SELECT ${columns} FROM unity_publications p
        WHERE p.original_hash = ? AND p.id > ? AND ${visible} ORDER BY p.id LIMIT ?`,
      params: [originalHash, options.afterId ?? '', actorId, actorId, limit + 1] });
      const records = rows.slice(0, limit).map(decode);
      return { records, nextAfter: rows.length > limit ? records.at(-1)!.id : null };
    },
    async list(actorId: string | null, options: { afterId?: string; limit?: number; parentId?: string;
      /** Host eligibility policy: opaque modules cannot travel through the current signed-sync profile. */
      excludeOpaqueResources?: boolean } = {}) {
      if (options.afterId) validate.text(options.afterId, 'afterId');
      if (options.parentId) validate.text(options.parentId, 'parentId');
      const limit = options.limit ?? 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) validate.invalid('Publication page size must be between 1 and 20');
      const rows = await driver.query<Row>({ sql: `SELECT ${columns} FROM unity_publications p
        WHERE p.id > ? AND ${visible} ${options.parentId ? 'AND p.parent_id = ?' : ''}
        ${options.excludeOpaqueResources ? `AND NOT EXISTS (SELECT 1 FROM unity_revision_assets ra
          WHERE ra.revision_id = p.revision_id AND ra.path = 'module.risum')` : ''} ORDER BY p.id LIMIT ?`,
      params: [options.afterId ?? '', actorId, actorId, ...(options.parentId ? [options.parentId] : []), limit] });
      return rows.map(decode);
    },
    async publish(actorId: string, inputs: readonly PublishInput[], syncContext?: SyncWriteContext): Promise<Publication[]> {
      const context = snapshotSyncContext(syncContext);
      validate.text(actorId, 'actorId');
      if (!inputs.length || inputs.length > 20) validate.invalid('Select between 1 and 20 revisions');
      if (new Set(inputs.map((input) => input.revisionId)).size !== inputs.length) validate.invalid('Select each revision once');
      let size = 0;
      const records = inputs.map((input) => {
        const policy = publicationPolicy(input);
        const document = validate.document(input.document);
        size += new TextEncoder().encode(document).byteLength;
        return { ...policy, id: crypto.randomUUID(), ownerId: actorId,
          workspaceId: validate.text(input.workspaceId, 'workspaceId'), revisionId: validate.text(input.revisionId, 'revisionId'),
          document, algorithm: validate.text(input.identity.algorithm, 'identity algorithm', 80), hash: validate.hash(input.identity.hash),
          originalHash: validate.hash(input.originalHash), createdAt: new Date().toISOString() };
      });
      if (size > 1_048_576) validate.invalid('Selected publication documents exceed 1 MiB');
      const target: SyncMutationTarget = { scope: 'publish', accountId: actorId, workspaceId: records[0]!.workspaceId };
      if (context && records.some((row) => row.workspaceId !== target.workspaceId)) validate.invalid('A sync publication must stay within its granted workspace');
      const statements: Statement[] = records.map((row) => ({
        sql: `INSERT INTO unity_publications(id, owner_id, workspace_id, revision_id, document_json,
          content_algorithm, content_hash, original_hash, parent_id, created_at, visibility, allow_original, allow_fork)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT f.publication_id FROM unity_publication_forks f
            JOIN unity_revisions r ON r.card_id = f.card_id WHERE r.id = ?), ?, ?, ?, ?)`,
        params: [row.id, row.ownerId, row.workspaceId, row.revisionId, row.document, row.algorithm, row.hash,
          row.originalHash, row.revisionId, row.createdAt, row.visibility, Number(row.allowOriginal), Number(row.allowFork)],
      }));
      try {
        if (context) {
          const receipt = await readSyncReceipt(driver, context, target);
          const ids = receipt?.result ?? await commitSyncMutation(driver, context, target, statements, records.map((row) => row.id));
          return await syncResult(context, target, ids);
        }
        await driver.batch(statements);
      }
      catch (error) {
        if (error instanceof Error && error.message.includes('UNITY_PUBLICATION_ACCESS')) throw new StoreError('ACCESS_CHANGED', 'Publication source is not owned by this account', { cause: error });
        if (error instanceof Error && /constraint/i.test(error.message)) throw new StoreError('INTEGRITY', 'Selection could not be published; a revision may already be published or ancestry exceeds 32 forks', { cause: error });
        throw error;
      }
      // These immutable records were just committed. A hidden ancestor may make a descendant
      // inaccessible even to its publisher, so mutation results contain receipts, not a second access check.
      return Promise.all(records.map(async (row) => {
        const [stored] = await driver.query<Row>({ sql: `SELECT ${columns} FROM unity_publications p WHERE p.id = ?`, params: [row.id] });
        if (!stored) throw new StoreError('INTEGRITY', 'Committed publication is missing');
        return decode(stored);
      }));
    },
    async updatePolicy(actorId: string, id: string, expectedVersion: number, input: PublicationPolicy) {
      const policy = publicationPolicy(input);
      validate.count(expectedVersion, 'expectedVersion');
      const [changed] = await driver.batch([{ sql: `UPDATE unity_publications SET visibility = ?, allow_original = ?,
        allow_fork = ?, policy_version = policy_version + 1 WHERE id = ? AND owner_id = ? AND policy_version = ?`,
      params: [policy.visibility, Number(policy.allowOriginal), Number(policy.allowFork), id, actorId, expectedVersion] }]);
      if (changed !== 1) throw new StoreError('ACCESS_CHANGED', 'Publication policy changed or is not owned by this account');
      return { id, policyVersion: expectedVersion + 1, ...policy };
    },
    async canFork(actorId: string, id: string) {
      const publication = await get(actorId, id);
      const denied = await driver.query({ sql: `SELECT 1 FROM unity_publication_ancestors a
        JOIN unity_publications p ON p.id = a.ancestor_id WHERE a.publication_id = ?
          AND p.owner_id != ? AND p.allow_fork = 0 LIMIT 1`, params: [id, actorId] });
      if (denied.length) throw new StoreError('NOT_FOUND', 'Publication is not available for forking');
      return publication;
    },
  };
}
export type HubStore = ReturnType<typeof createHubStore>;
