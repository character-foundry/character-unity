import { parseSyncCommandReceipt, SYNC_FORK_MAX_BYTES } from '@character-foundry/character-foundry/sync';
import type { SyncCommandReceipt } from '@character-foundry/character-foundry/sync';
import { canonicalJson } from '@character-foundry/character-foundry/identity';
import type { StoreDriver, Statement } from './driver.js';
import { StoreError } from './types.js';
import * as validate from './validation.js';

export interface OutboxScope { accountId: string; workspaceId: string }
export interface ReturnJobInput extends OutboxScope {
  requestId: string; actor: string; baseUrl: string; publicationId: string;
  cardId: string; revisionId: string; assetId: string; frameHash: string; byteLength: number;
}
export type ReturnReceipt = Extract<SyncCommandReceipt, { cardId: string }>;
export interface ReturnJob extends ReturnJobInput {
  createdAt: string; attempts: number; lastAttemptAt: string | null;
  state: 'prepared' | 'uncertain' | 'acknowledged'; receipt: ReturnReceipt | null; receivedAt: string | null;
}
interface JobRow extends ReturnJobInput {
  createdAt: string; attempts: number; lastAttemptAt: string | null; receiptJson: string | null; receivedAt: string | null;
}
const columns = `j.request_id AS requestId, j.account_id AS accountId, j.workspace_id AS workspaceId,
  j.actor, j.base_url AS baseUrl, j.publication_id AS publicationId, j.card_id AS cardId, j.revision_id AS revisionId,
  j.asset_id AS assetId, j.frame_hash AS frameHash, j.byte_length AS byteLength, j.created_at AS createdAt,
  (SELECT COUNT(*) FROM unity_sync_outbox_attempts t WHERE t.request_id = j.request_id) AS attempts,
  (SELECT MAX(started_at) FROM unity_sync_outbox_attempts t WHERE t.request_id = j.request_id) AS lastAttemptAt,
  r.receipt_json AS receiptJson, r.received_at AS receivedAt`;
export function returnOperationId(value: string) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) validate.invalid('Expected an explicit sync operation ID');
  return value;
}
function scope(input: OutboxScope): OutboxScope {
  return { accountId: validate.text(input.accountId, 'accountId'), workspaceId: validate.text(input.workspaceId, 'workspaceId') };
}
function receipt(input: unknown, requestId: string): ReturnReceipt {
  const parsed = parseSyncCommandReceipt(input);
  if (parsed.operation !== 'forks.submit' || parsed.requestId !== requestId) validate.invalid('Receipt does not match this return job');
  return parsed;
}
function decode(row: JobRow): ReturnJob {
  const { receiptJson, ...rest } = row;
  return { ...rest, state: receiptJson ? 'acknowledged' : row.attempts ? 'uncertain' : 'prepared',
    receipt: receiptJson ? receipt(JSON.parse(receiptJson), row.requestId) : null };
}
/** Trusted host repository; use a session driver for browser-account operations. No signing keys are stored. */
export function createSyncOutboxStore(driver: StoreDriver) {
  async function authorize(owner: OutboxScope) {
    const rows = await driver.query({ sql: `SELECT 1 FROM unity_accounts a JOIN unity_workspaces w ON w.owner_id = a.id
      WHERE a.id = ? AND a.enabled = 1 AND w.id = ?`, params: [owner.accountId, owner.workspaceId] });
    if (!rows.length) throw new StoreError('UNAUTHENTICATED', 'Outbox account or workspace is unavailable');
  }
  async function batch(statements: readonly Statement[]) {
    try { await driver.batch(statements); } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('UNITY_OUTBOX_ACCESS')) throw new StoreError('UNAUTHENTICATED', 'Outbox account or asset is unavailable', { cause: error });
      if (message.includes('UNITY_OUTBOX_CONFLICT')) throw new StoreError('OPERATION_CONFLICT', 'Remote acknowledgment differs from the saved receipt', { cause: error });
      throw error;
    }
  }
  async function get(input: OutboxScope, requestId: string): Promise<ReturnJob | null> {
    const owner = scope(input); returnOperationId(requestId); await authorize(owner);
    const [row] = await driver.query<JobRow>({ sql: `SELECT ${columns} FROM unity_sync_outbox j
      LEFT JOIN unity_sync_outbox_receipts r ON r.request_id = j.request_id
      WHERE j.account_id = ? AND j.workspace_id = ? AND j.request_id = ?`, params: [owner.accountId, owner.workspaceId, requestId] });
    await authorize(owner); return row ? decode(row) : null;
  }
  async function required(owner: OutboxScope, requestId: string) {
    const job = await get(owner, requestId); if (!job) throw new StoreError('NOT_FOUND', 'Return job not found in this workspace'); return job;
  }
  return {
    get,
    async list(input: OutboxScope, options: { afterId?: string; limit?: number } = {}) {
      const owner = scope(input), limit = validate.limit(options.limit), after = options.afterId === undefined ? '' : returnOperationId(options.afterId);
      await authorize(owner);
      const rows = await driver.query<JobRow>({ sql: `SELECT ${columns} FROM unity_sync_outbox j
        LEFT JOIN unity_sync_outbox_receipts r ON r.request_id = j.request_id
        WHERE j.account_id = ? AND j.workspace_id = ? AND j.request_id > ? ORDER BY j.request_id LIMIT ?`, params: [owner.accountId, owner.workspaceId, after, limit] });
      await authorize(owner); return rows.map(decode);
    },
    async enqueue(input: ReturnJobInput) {
      const value: ReturnJobInput = { ...scope(input), requestId: returnOperationId(input.requestId), actor: validate.actorUri(input.actor),
        baseUrl: validate.actorUri(input.baseUrl), publicationId: validate.text(input.publicationId, 'publicationId', 128),
        cardId: validate.text(input.cardId, 'cardId'), revisionId: validate.text(input.revisionId, 'revisionId'),
        assetId: validate.text(input.assetId, 'assetId'), frameHash: validate.hash(input.frameHash), byteLength: validate.count(input.byteLength, 'byteLength') };
      if (value.baseUrl.endsWith('/') || !value.byteLength || value.byteLength > SYNC_FORK_MAX_BYTES) validate.invalid('Invalid return destination or frame length');
      await authorize(value);
      await batch([{ sql: `INSERT INTO unity_sync_outbox(request_id, account_id, workspace_id, actor, base_url, publication_id,
        card_id, revision_id, asset_id, frame_hash, byte_length, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(request_id) DO NOTHING`, params: [value.requestId, value.accountId, value.workspaceId, value.actor, value.baseUrl,
        value.publicationId, value.cardId, value.revisionId, value.assetId, value.frameHash, value.byteLength, new Date().toISOString()] }]);
      const saved = await get(value, value.requestId);
      if (!saved || (Object.keys(value) as (keyof ReturnJobInput)[]).some((key) => key !== 'assetId' && value[key] !== saved[key])) {
        throw new StoreError('OPERATION_CONFLICT', 'Operation ID is already bound to another return');
      }
      return saved;
    },
    async beginAttempt(input: OutboxScope, requestId: string) {
      const owner = scope(input); await required(owner, requestId);
      await batch([{ sql: `INSERT INTO unity_sync_outbox_attempts(id, request_id, started_at)
        SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM unity_sync_outbox_receipts WHERE request_id = ?)`,
      params: [crypto.randomUUID(), requestId, new Date().toISOString(), requestId] }]);
      return required(owner, requestId);
    },
    async acknowledge(input: OutboxScope, requestId: string, received: unknown) {
      const owner = scope(input), encoded = canonicalJson(receipt(received, returnOperationId(requestId)));
      await required(owner, requestId);
      await batch([{ sql: `INSERT INTO unity_sync_outbox_receipts(request_id, receipt_json, received_at) VALUES (?, ?, ?)
        ON CONFLICT(request_id) DO NOTHING`, params: [requestId, encoded, new Date().toISOString()] }]);
      return required(owner, requestId);
    },
  };
}
export type SyncOutboxStore = ReturnType<typeof createSyncOutboxStore>;
