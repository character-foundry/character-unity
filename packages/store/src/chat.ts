import type { StoreDriver, Statement } from './driver.js';
import { StoreError } from './types.js';
import * as validate from './validation.js';

export type ChatKind = 'sillytavern' | 'lumiverse' | 'marinara';
export const chatKinds: readonly ChatKind[] = ['sillytavern', 'lumiverse', 'marinara'];
/** Connection secrets for one chat application. Never returned to browsers. */
export interface ChatCredentials { username?: string; password?: string; apiKey?: string }
export interface ChatTarget {
  id: string; workspaceId: string; kind: ChatKind; name: string; baseUrl: string;
  configurationVersion: number;
  createdAt: string; scannedAt: string | null; scanError: string | null;
}
export interface ChatTargetWithCredentials extends ChatTarget { credentials: ChatCredentials }
export type RemoteState = 'matched' | 'edited' | 'missing';
/** `current` and `behind` compare the copy's revision with the card's head at read time. */
export type PlacementStatus = 'current' | 'behind' | 'edited' | 'missing';
/** Identity metadata for a sent external version; never an owned revision. */
export interface ReferencePlacementIdentity { sequence: number; contentHash: string; revisionHash: string | null }
export interface ChatPlacement {
  targetId: string; targetName: string; kind: ChatKind; remoteId: string; remoteName: string;
  cardId: string; revisionId: string | null; revisionSequence: number | null; headSequence: number;
  status: PlacementStatus; sentAt: string | null; seenAt: string | null;
  /** The copy's fingerprint when it was sent or first seen, for apps that rebuild cards on export. */
  fingerprint: string | null;
  reference?: ReferencePlacementIdentity;
}
/** One copy found during a scan (or created by a send), already resolved to a library card. */
export interface ObservedPlacement {
  remoteId: string; remoteName: string; cardId: string; revisionId: string | null; edited: boolean; sent?: boolean;
  /** Baseline fingerprint to keep for this copy; null leaves the stored one unchanged. */
  fingerprint?: string | null;
  reference?: ReferencePlacementIdentity;
}

interface TargetRow extends ChatTarget { credentials: string }
const targetColumns = `id, workspace_id AS workspaceId, kind, name, base_url AS baseUrl, configuration_version AS configurationVersion, credentials_json AS credentials,
  created_at AS createdAt, scanned_at AS scannedAt, scan_error AS scanError`;
function publicTarget({ credentials, ...target }: TargetRow): ChatTarget { void credentials; return target; }

function baseUrl(value: string) {
  validate.text(value, 'base URL', 500);
  let url: URL;
  try { url = new URL(value); } catch { return validate.invalid('Expected an http(s) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) validate.invalid('Expected an http(s) URL without credentials or query');
  return url.href.replace(/\/+$/, '');
}
function credentials(value: ChatCredentials) {
  const out: ChatCredentials = {};
  for (const key of ['username', 'password', 'apiKey'] as const) {
    const item = value[key];
    if (item === undefined || item === '') continue;
    if (typeof item !== 'string' || item.length > 500) validate.invalid(`${key} must be text`);
    out[key] = item;
  }
  return JSON.stringify(out);
}
function kind(value: ChatKind) {
  if (!chatKinds.includes(value)) validate.invalid('Unknown chat application');
  return value;
}

export function createChatStore(driver: StoreDriver) {
  async function target(workspaceId: string, id: string): Promise<ChatTargetWithCredentials> {
    const [row] = await driver.query<TargetRow>({ sql: `SELECT ${targetColumns} FROM unity_chat_targets WHERE id = ? AND workspace_id = ?`, params: [id, workspaceId] });
    if (!row) throw new StoreError('NOT_FOUND', 'Chat application not found');
    return { ...publicTarget(row), credentials: JSON.parse(row.credentials) as ChatCredentials };
  }
  return {
    target,
    /** Only an actual authored fork can satisfy a private inbound receipt. An
     * imported document merely claiming this metadata is never a receipt. */
    async importedEdit(workspaceId: string, authorId: string, receiptHash: string, expectedHead: string) {
      validate.hash(receiptHash);
      const [row] = await driver.query<{ cardId: string; revisionId: string }>({ sql: `SELECT card_id AS cardId,revision_id AS revisionId
        FROM unity_chat_import_receipts WHERE workspace_id = ? AND author_id = ? AND receipt_hash = ? AND source_revision_id = ?`,
      params: [workspaceId, authorId, receiptHash, expectedHead] });
      return row ?? null;
    },
    async targets(workspaceId: string): Promise<ChatTarget[]> {
      const rows = await driver.query<TargetRow>({ sql: `SELECT ${targetColumns} FROM unity_chat_targets WHERE workspace_id = ? ORDER BY created_at, id`, params: [workspaceId] });
      return rows.map(publicTarget);
    },
    async addTarget(input: { workspaceId: string; kind: ChatKind; name: string; baseUrl: string; credentials: ChatCredentials }): Promise<ChatTarget> {
      const row = { id: crypto.randomUUID(), workspaceId: validate.text(input.workspaceId, 'workspaceId'), kind: kind(input.kind),
        name: validate.text(input.name, 'name', 80), baseUrl: baseUrl(input.baseUrl), configurationVersion: 1, createdAt: new Date().toISOString() };
      try {
        await driver.batch([{ sql: `INSERT INTO unity_chat_targets(id, workspace_id, kind, name, base_url, credentials_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, params: [row.id, row.workspaceId, row.kind, row.name, row.baseUrl, credentials(input.credentials), row.createdAt] }]);
      } catch (error) {
        if (error instanceof Error && /constraint/i.test(error.message)) throw new StoreError('INVALID_INPUT', 'That chat application is already connected', { cause: error });
        throw error;
      }
      return { ...row, scannedAt: null, scanError: null };
    },
    /** Omitted credentials keep the stored secrets; empty strings clear them. */
    async updateTarget(workspaceId: string, id: string, input: { name?: string; baseUrl?: string; credentials?: ChatCredentials }): Promise<ChatTarget> {
      const current = await target(workspaceId, id);
      const merged = input.credentials ? { ...current.credentials, ...input.credentials } : current.credentials;
      await driver.batch([{ sql: 'UPDATE unity_chat_targets SET name = ?, base_url = ?, credentials_json = ?, configuration_version = configuration_version + 1 WHERE id = ? AND workspace_id = ?',
        params: [input.name === undefined ? current.name : validate.text(input.name, 'name', 80), input.baseUrl === undefined ? current.baseUrl : baseUrl(input.baseUrl), credentials(merged), id, workspaceId] }]);
      const { credentials: secrets, ...updated } = await target(workspaceId, id);
      void secrets;
      return updated;
    },
    async removeTarget(workspaceId: string, id: string) {
      await target(workspaceId, id);
      await driver.batch([
        { sql: 'DELETE FROM unity_chat_placements WHERE target_id = ?', params: [id] },
        { sql: 'DELETE FROM unity_archive_chat_placements WHERE target_id = ?', params: [id] },
        { sql: 'DELETE FROM unity_chat_targets WHERE id = ? AND workspace_id = ?', params: [id, workspaceId] },
      ]);
    },
    /**
     * Records what a scan found. Previously known copies that were not observed become `missing`;
     * pass `complete: false` for a single send so other copies keep their state.
     */
    async recordPlacements(workspaceId: string, targetId: string, observed: readonly ObservedPlacement[], options: { complete: boolean; error?: string | null }) {
      await target(workspaceId, targetId);
      const now = new Date().toISOString();
      const statements: Statement[] = [];
      if (options.complete) {
        statements.push({ sql: `UPDATE unity_chat_placements SET remote_state = 'missing' WHERE target_id = ?`, params: [targetId] });
        statements.push({ sql: `UPDATE unity_archive_chat_placements SET remote_state = 'missing' WHERE target_id = ?`, params: [targetId] });
      }
      for (const item of observed) {
        if (item.reference) {
          const identity = item.reference;
          if (!Number.isSafeInteger(identity.sequence) || identity.sequence < 1) validate.invalid('Invalid reference revision sequence');
          validate.hash(identity.contentHash);
          if (identity.revisionHash !== null) validate.hash(identity.revisionHash);
          // Keep the bounded identity receipt when a placement is forgotten, so
          // a later scan can rediscover an unchanged copy under any remote name.
          statements.push({ sql: `INSERT INTO unity_archive_chat_identities(reference_id,workspace_id,revision_id,revision_sequence,content_hash,lineage_hash)
            SELECT id,workspace_id,archive_version_id,?,?,? FROM unity_archive_references
            WHERE id = ? AND workspace_id = ? AND archive_version_id = ?
            ON CONFLICT(reference_id) DO UPDATE SET revision_sequence = excluded.revision_sequence,
              content_hash = excluded.content_hash,lineage_hash = excluded.lineage_hash`,
          params: [identity.sequence, identity.contentHash, identity.revisionHash, item.cardId, workspaceId, item.revisionId] });
          statements.push({ sql: 'DELETE FROM unity_chat_placements WHERE target_id = ? AND remote_id = ?', params: [targetId, item.remoteId] });
          statements.push({ sql: `INSERT INTO unity_archive_chat_placements(target_id,remote_id,remote_name,reference_id,workspace_id,revision_id,
              revision_sequence,content_hash,lineage_hash,remote_state,sent_at,seen_at,remote_fingerprint)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(target_id,remote_id) DO UPDATE SET remote_name = excluded.remote_name,reference_id = excluded.reference_id,
              revision_id = excluded.revision_id,revision_sequence = excluded.revision_sequence,content_hash = excluded.content_hash,
              lineage_hash = excluded.lineage_hash,remote_state = excluded.remote_state,seen_at = excluded.seen_at,
              sent_at = COALESCE(excluded.sent_at,unity_archive_chat_placements.sent_at),
              remote_fingerprint = COALESCE(excluded.remote_fingerprint,unity_archive_chat_placements.remote_fingerprint)`,
          params: [targetId, validate.text(item.remoteId, 'remoteId', 500), item.remoteName.slice(0, 200) || item.remoteId, item.cardId,
            workspaceId, validate.text(item.revisionId ?? '', 'revisionId'), identity.sequence, identity.contentHash, identity.revisionHash,
            item.edited ? 'edited' : 'matched', item.sent ? now : null, now, item.fingerprint ?? null] });
          continue;
        }
        statements.push({ sql: 'DELETE FROM unity_archive_chat_placements WHERE target_id = ? AND remote_id = ?', params: [targetId, item.remoteId] });
        statements.push({ sql: `INSERT INTO unity_chat_placements(target_id, remote_id, remote_name, card_id, workspace_id, revision_id, remote_state, sent_at, seen_at, remote_fingerprint)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(target_id, remote_id) DO UPDATE SET remote_name = excluded.remote_name, card_id = excluded.card_id,
            revision_id = excluded.revision_id, remote_state = excluded.remote_state, seen_at = excluded.seen_at,
            sent_at = COALESCE(excluded.sent_at, unity_chat_placements.sent_at),
            remote_fingerprint = COALESCE(excluded.remote_fingerprint, unity_chat_placements.remote_fingerprint)`,
        params: [targetId, validate.text(item.remoteId, 'remoteId', 500), item.remoteName.slice(0, 200) || item.remoteId, item.cardId, workspaceId,
          item.revisionId, item.edited ? 'edited' : 'matched', item.sent ? now : null, now, item.fingerprint ?? null] });
      }
      if (options.complete) statements.push({ sql: 'UPDATE unity_chat_targets SET scanned_at = ?, scan_error = NULL WHERE id = ?', params: [now, targetId] });
      // A failed scan keeps the last successful scan time and every known copy.
      else if (options.error !== undefined) statements.push({ sql: 'UPDATE unity_chat_targets SET scan_error = ? WHERE id = ?', params: [options.error, targetId] });
      if (statements.length) await driver.batch(statements);
    },
    async forgetPlacement(workspaceId: string, targetId: string, remoteId: string) {
      await target(workspaceId, targetId);
      await driver.batch([
        { sql: 'DELETE FROM unity_chat_placements WHERE target_id = ? AND remote_id = ?', params: [targetId, remoteId] },
        { sql: 'DELETE FROM unity_archive_chat_placements WHERE target_id = ? AND remote_id = ?', params: [targetId, remoteId] },
      ]);
    },
    /** Every known copy of the given cards (or of the whole workspace), with head comparison. */
    async placements(workspaceId: string, cardIds?: readonly string[]): Promise<ChatPlacement[]> {
      if (cardIds && cardIds.length > 100) validate.invalid('Ask for at most 100 cards');
      if (cardIds && !cardIds.length) return [];
      const rows = await driver.query<Omit<ChatPlacement, 'status'> & { remoteState: RemoteState; headRevisionId: string }>({
        sql: `SELECT p.target_id AS targetId, t.name AS targetName, t.kind, p.remote_id AS remoteId, p.remote_name AS remoteName,
            p.card_id AS cardId, p.revision_id AS revisionId, r.sequence AS revisionSequence, h.sequence AS headSequence,
            c.head_revision_id AS headRevisionId, p.remote_state AS remoteState, p.sent_at AS sentAt, p.seen_at AS seenAt,
            p.remote_fingerprint AS fingerprint
          FROM unity_chat_placements p JOIN unity_chat_targets t ON t.id = p.target_id
          JOIN unity_cards c ON c.id = p.card_id JOIN unity_revisions h ON h.id = c.head_revision_id
          LEFT JOIN unity_revisions r ON r.id = p.revision_id
          WHERE p.workspace_id = ? ${cardIds ? `AND p.card_id IN (${cardIds.map(() => '?').join(', ')})` : ''}
          ORDER BY t.created_at, p.remote_state = 'missing', p.remote_name, p.remote_id`,
        params: [workspaceId, ...(cardIds ?? [])],
      });
      const local = rows.map(({ remoteState, headRevisionId, ...row }): ChatPlacement => ({ ...row,
        status: remoteState === 'missing' ? 'missing' : remoteState === 'edited' ? 'edited' : row.revisionId === headRevisionId ? 'current' : 'behind' }));
      type ReferenceRow = Omit<ChatPlacement, 'status' | 'reference'> & { remoteState: RemoteState; contentHash: string; revisionHash: string | null };
      const references = await driver.query<ReferenceRow>({
        sql: `SELECT p.target_id AS targetId,t.name AS targetName,t.kind,p.remote_id AS remoteId,p.remote_name AS remoteName,
          p.reference_id AS cardId,p.revision_id AS revisionId,p.revision_sequence AS revisionSequence,p.revision_sequence AS headSequence,
          p.remote_state AS remoteState,p.sent_at AS sentAt,p.seen_at AS seenAt,p.remote_fingerprint AS fingerprint,
          p.content_hash AS contentHash,p.lineage_hash AS revisionHash
          FROM unity_archive_chat_placements p JOIN unity_chat_targets t ON t.id = p.target_id
          JOIN unity_archive_references r ON r.id = p.reference_id AND r.workspace_id = p.workspace_id
          WHERE p.workspace_id = ? ${cardIds ? `AND p.reference_id IN (${cardIds.map(() => '?').join(', ')})` : ''}`,
        params: [workspaceId, ...(cardIds ?? [])],
      });
      const external = references.map(({ remoteState, contentHash, revisionHash, ...row }): ChatPlacement => ({ ...row,
        status: remoteState === 'missing' ? 'missing' : remoteState === 'edited' ? 'edited' : 'current',
        reference: { sequence: row.revisionSequence!, contentHash, revisionHash } }));
      // Keep missing copies last across both sources, not just within each table.
      const targets = await driver.query<{ id: string }>({ sql: 'SELECT id FROM unity_chat_targets WHERE workspace_id = ? ORDER BY created_at,id', params: [workspaceId] });
      const order = new Map(targets.map((item, index) => [item.id, index]));
      return [...local, ...external].sort((a, b) => (order.get(a.targetId)! - order.get(b.targetId)!)
        || Number(a.status === 'missing') - Number(b.status === 'missing') || a.remoteName.localeCompare(b.remoteName) || a.remoteId.localeCompare(b.remoteId));
    },
    /** Resolves an exported revision back to the library: exact lineage revision hash first, then content hash. */
    async resolveRevision(workspaceId: string, match: { revisionHash: string | null; contentHash: string; preferCardId?: string }) {
      type Hit = { id: string; cardId: string; reference?: ReferencePlacementIdentity };
      type ReferenceHit = { id: string; cardId: string; sequence: number; contentHash: string; revisionHash: string | null };
      async function referenceHits(column: 'lineage_hash' | 'content_hash', value: string): Promise<Hit[]> {
        const rows = await driver.query<ReferenceHit>({ sql: `SELECT DISTINCT p.revision_id AS id,p.reference_id AS cardId,
          p.revision_sequence AS sequence,p.content_hash AS contentHash,p.lineage_hash AS revisionHash
          FROM unity_archive_chat_identities p JOIN unity_archive_references r ON r.id = p.reference_id AND r.workspace_id = p.workspace_id
          WHERE p.workspace_id = ? AND p.${column} = ?`, params: [workspaceId, value] });
        return rows.map(({ sequence, contentHash, revisionHash, ...row }) => ({ ...row, reference: { sequence, contentHash, revisionHash } }));
      }
      if (match.revisionHash) {
        const hits = await driver.query<Hit>({ sql: `SELECT id, card_id AS cardId FROM unity_revisions WHERE workspace_id = ?
          AND json_extract(document_json, '$.data.extensions.foundry.lineage.revisionHash') = ?`, params: [workspaceId, match.revisionHash] });
        hits.push(...await referenceHits('lineage_hash', match.revisionHash));
        if (hits[0]) return hits.find((hit) => hit.cardId === match.preferCardId) ?? hits[0];
      }
      const hits = await driver.query<Hit>({ sql: `SELECT id, card_id AS cardId FROM unity_revisions WHERE workspace_id = ? AND content_hash = ?
        ORDER BY sequence DESC, created_at DESC`, params: [workspaceId, match.contentHash] });
      hits.push(...await referenceHits('content_hash', match.contentHash));
      return hits.find((hit) => hit.cardId === match.preferCardId) ?? hits[0] ?? null;
    },
  };
}
export type ChatStore = ReturnType<typeof createChatStore>;
