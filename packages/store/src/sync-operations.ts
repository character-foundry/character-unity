import type { SyncNonceClaim } from '@character-foundry/character-foundry/sync';
import type { Statement, StoreDriver } from './driver.js';
import { StoreError } from './types.js';
import * as validate from './validation.js';

/** Host-only context. The SDK verifier must have admitted this exact claim before use. */
export interface SyncWriteContext { claim: Readonly<SyncNonceClaim>; clock?: () => number }
export type SyncMutation = 'publish' | 'fork';
export interface SyncMutationTarget { scope: SyncMutation; accountId: string; workspaceId: string }
export interface SyncReceipt {
  actor: string; requestId: string; requestHash: string; scope: SyncMutation;
  accountId: string; workspaceId: string; result: readonly string[]; committedAt: number;
}
interface ReceiptRow extends Omit<SyncReceipt, 'result'> { result: string }

export function snapshotSyncContext(context?: SyncWriteContext): SyncWriteContext | undefined {
  if (context === undefined) return undefined;
  if (!context || typeof context !== 'object' || !context.claim || typeof context.claim !== 'object') validate.invalid('Expected a verified sync context');
  const claim = { ...context.claim };
  validate.text(claim.actor, 'sync actor', 1024); validate.text(claim.keyId, 'sync keyId', 1105);
  for (const value of [claim.nonce, claim.requestId]) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) validate.invalid('Expected a sync token');
  }
  validate.hash(claim.requestHash); validate.count(claim.retainUntil, 'sync retainUntil');
  return { claim, clock: context.clock ?? Date.now };
}
function now(context: SyncWriteContext) { return validate.count((context.clock ?? Date.now)(), 'clock milliseconds'); }
function parameters(context: SyncWriteContext, target: SyncMutationTarget) {
  const { claim } = context;
  return [claim.actor, claim.keyId, claim.nonce, claim.requestId, claim.requestHash,
    target.scope, target.accountId, target.workspaceId, claim.retainUntil, Math.floor(now(context) / 1000)] as const;
}
function access(): never { throw new StoreError('UNAUTHENTICATED', 'Sync request expired, unadmitted or revoked'); }
function conflict(): never { throw new StoreError('OPERATION_CONFLICT', 'Sync operation ID is already bound to a different request'); }

/** Rechecks the fresh admitted claim; a historical receipt alone never grants access. */
export async function requireSyncWrite(driver: StoreDriver, context: SyncWriteContext, target: SyncMutationTarget) {
  const [actor, key, nonce, requestId, requestHash, scope, accountId, workspaceId, retainUntil, checkedAt] = parameters(context, target);
  const rows = await driver.query({ sql: `SELECT 1 FROM unity_sync_peers p
    JOIN unity_sync_keys k ON k.actor = p.actor JOIN unity_sync_scopes s ON s.actor = p.actor
    JOIN unity_accounts a ON a.id = p.account_id JOIN unity_workspaces w ON w.id = p.workspace_id
    JOIN unity_sync_nonces n ON n.actor = p.actor AND n.key_id = k.key_id
    WHERE p.actor = ? AND k.key_id = ? AND n.nonce = ? AND n.request_id = ? AND n.request_hash = ?
      AND s.scope = ? AND a.id = ? AND w.id = ? AND n.retain_until = ? AND n.retain_until >= ?
      AND p.enabled = 1 AND k.revoked = 0 AND a.enabled = 1 AND w.owner_id = a.id`,
  params: [actor, key, nonce, requestId, requestHash, scope, accountId, workspaceId, retainUntil, checkedAt] });
  if (!rows.length || context.claim.retainUntil < Math.floor(now(context) / 1000)) access();
}

/** Read references only. Callers also recheck the referenced resource's current policy before presenting it. */
export async function readSyncReceipt(driver: StoreDriver, context: SyncWriteContext, target: SyncMutationTarget): Promise<SyncReceipt | null> {
  await requireSyncWrite(driver, context, target);
  const [row] = await driver.query<ReceiptRow>({ sql: `SELECT actor, request_id AS requestId, request_hash AS requestHash,
    scope, account_id AS accountId, workspace_id AS workspaceId, result_json AS result, committed_at AS committedAt
    FROM unity_sync_receipts WHERE actor = ? AND request_id = ?`, params: [context.claim.actor, context.claim.requestId] });
  if (!row) return null;
  if (row.requestHash !== context.claim.requestHash || row.scope !== target.scope || row.accountId !== target.accountId || row.workspaceId !== target.workspaceId) conflict();
  const result: unknown = JSON.parse(row.result);
  if (!Array.isArray(result) || !result.length || result.length > 20 || result.some((id: unknown) => typeof id !== 'string' || !id || id.length > 200)) {
    throw new StoreError('INTEGRITY', 'Invalid sync receipt references');
  }
  await requireSyncWrite(driver, context, target);
  return { ...row, result };
}

/** Precomputed SQL only: guards, receipt and domain writes share one atomic batch. */
export async function commitSyncMutation(driver: StoreDriver, context: SyncWriteContext, target: SyncMutationTarget,
  statements: readonly Statement[], result: readonly string[]): Promise<readonly string[]> {
  const id = crypto.randomUUID();
  const committedAt = now(context);
  const resultJson = JSON.stringify(result);
  try {
    await driver.batch([
      { sql: `INSERT INTO unity_sync_write_guards(id, actor, key_id, nonce, request_id, request_hash, scope, account_id, workspace_id, retain_until, checked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, params: [id, ...parameters(context, target)] },
      { sql: `INSERT INTO unity_sync_receipts(actor, request_id, request_hash, scope, account_id, workspace_id, result_json, committed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, params: [context.claim.actor, context.claim.requestId, context.claim.requestHash,
        target.scope, target.accountId, target.workspaceId, resultJson, committedAt] },
      ...statements,
      { sql: 'DELETE FROM unity_sync_write_guards WHERE id = ?', params: [id] },
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('UNITY_SYNC_ACCESS')) access();
    if (message.includes('UNITY_SYNC_CONFLICT')) conflict();
    if (!message.includes('UNITY_SYNC_RETRY')) throw error;
    // The losing transaction rolled back completely, including its proposed result IDs.
    const receipt = await readSyncReceipt(driver, context, target);
    if (!receipt) throw new StoreError('INTEGRITY', 'Committed sync receipt is missing');
    return receipt.result;
  }
  return [...result];
}
