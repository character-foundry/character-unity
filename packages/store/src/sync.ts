import type { SyncNonceClaim } from '@character-foundry/character-foundry/sync';
import { SYNC_HTTP_MAX_AGE, SYNC_HTTP_CLOCK_SKEW } from '@character-foundry/character-foundry/sync';
import type { StoreDriver } from './driver.js';
import { StoreError } from './types.js';
import * as validate from './validation.js';

export type SyncScope = 'pull' | 'publish' | 'fork';
export interface SyncPeer { actor: string; accountId: string; workspaceId: string; enabled: boolean }
export interface SyncPeerStatus extends SyncPeer { accountEnabled: boolean; scopes: SyncScope[] }
export interface SyncPublicKey { keyId: string; publicKeyHex: string; revoked: boolean }
interface PeerRow extends Omit<SyncPeer, 'enabled'> { enabled: number }
const actorUri = validate.actorUri;
function keyId(actor: string, value: string) {
  if (typeof value !== 'string' || !value.startsWith(`${actor}#`) || !/^[A-Za-z0-9._-]{1,80}$/.test(value.slice(actor.length + 1))) {
    validate.invalid('Key ID must be a fragment of its exact actor URI');
  }
  return value;
}
function scopeValue(value: SyncScope) {
  if (!['pull', 'publish', 'fork'].includes(value)) validate.invalid('Unknown sync scope');
  return value;
}
function token(value: string) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) validate.invalid('Expected a sync token');
  return value;
}
function missing(changed: number | undefined) { if (!changed) throw new StoreError('NOT_FOUND', 'Sync peer or key not found'); }
const active = `FROM unity_sync_peers p JOIN unity_sync_keys k ON k.actor = p.actor
  JOIN unity_accounts a ON a.id = p.account_id JOIN unity_workspaces w ON w.id = p.workspace_id
  JOIN unity_sync_scopes s ON s.actor = p.actor
  WHERE p.actor = ? AND k.key_id = ? AND s.scope = ? AND p.enabled = 1 AND k.revoked = 0
  AND a.enabled = 1 AND w.owner_id = a.id`;

async function publicKeyHex(publicKey: CryptoKey) {
  if (publicKey.type !== 'public' || publicKey.algorithm.name !== 'Ed25519' || !publicKey.usages.includes('verify')) {
    validate.invalid('Expected an exportable Ed25519 public verification key');
  }
  const exported = await crypto.subtle.exportKey('raw', publicKey);
  if (!(exported instanceof ArrayBuffer) || exported.byteLength !== 32) throw new StoreError('INTEGRITY', 'Expected 32 raw Ed25519 public-key bytes');
  return Array.from(new Uint8Array(exported), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Operator-owned store. Nonce admission is transport authentication, never a mutation receipt. */
export function createSyncStore(driver: StoreDriver, clock: () => number = Date.now) {
  const now = () => Math.floor(validate.count(clock(), 'clock milliseconds') / 1000);
  return {
    async grant(input: Omit<SyncPeer, 'enabled'> & { scopes: readonly SyncScope[] }) {
      const actor = actorUri(input.actor); const accountId = validate.text(input.accountId, 'accountId');
      const workspaceId = validate.text(input.workspaceId, 'workspaceId');
      const scopes = [...new Set(input.scopes.map(scopeValue))];
      if (!scopes.length || scopes.length > 3) validate.invalid('Expected at least one sync scope');
      const [inserted] = await driver.batch([
        { sql: `INSERT INTO unity_sync_peers(actor, account_id, workspace_id, enabled)
          SELECT ?, a.id, w.id, 1 FROM unity_accounts a JOIN unity_workspaces w ON w.owner_id = a.id
          WHERE a.id = ? AND w.id = ? AND a.enabled = 1`, params: [actor, accountId, workspaceId] },
        ...scopes.map((scope) => ({ sql: 'INSERT INTO unity_sync_scopes(actor, scope) VALUES (?, ?)', params: [actor, scope] })),
      ]);
      missing(inserted);
      return { actor, accountId, workspaceId, enabled: true };
    },
    async getPeer(actor: string): Promise<SyncPeer | null> {
      const [row] = await driver.query<PeerRow>({ sql: `SELECT actor, account_id AS accountId,
        workspace_id AS workspaceId, enabled FROM unity_sync_peers WHERE actor = ?`, params: [actorUri(actor)] });
      return row ? { ...row, enabled: row.enabled === 1 } : null;
    },
    async listPeers(options: { afterActor?: string; limit?: number } = {}): Promise<SyncPeer[]> {
      const rows = await driver.query<PeerRow>({ sql: `SELECT actor, account_id AS accountId, workspace_id AS workspaceId, enabled
        FROM unity_sync_peers WHERE actor > ? ORDER BY actor LIMIT ?`,
      params: [options.afterActor === undefined ? '' : actorUri(options.afterActor), validate.limit(options.limit)] });
      return rows.map((row) => ({ ...row, enabled: row.enabled === 1 }));
    },
    async inspectPeer(actor: string): Promise<SyncPeerStatus> {
      actor = actorUri(actor);
      const [row] = await driver.query<PeerRow & { accountEnabled: number }>({ sql: `SELECT p.actor, p.account_id AS accountId,
        p.workspace_id AS workspaceId, p.enabled, a.enabled AS accountEnabled
        FROM unity_sync_peers p JOIN unity_accounts a ON a.id = p.account_id WHERE p.actor = ?`, params: [actor] });
      if (!row) throw new StoreError('NOT_FOUND', 'Sync peer not found');
      const scopes = await driver.query<{ scope: SyncScope }>({ sql: 'SELECT scope FROM unity_sync_scopes WHERE actor = ? ORDER BY scope', params: [actor] });
      return { ...row, enabled: row.enabled === 1, accountEnabled: row.accountEnabled === 1, scopes: scopes.map((row) => row.scope) };
    },
    async listKeys(actor: string, options: { afterKeyId?: string; limit?: number } = {}): Promise<SyncPublicKey[]> {
      actor = actorUri(actor);
      const rows = await driver.query<{ keyId: string; publicKeyHex: string; revoked: number }>({ sql: `SELECT key_id AS keyId,
        public_key AS publicKeyHex, revoked FROM unity_sync_keys WHERE actor = ? AND key_id > ? ORDER BY key_id LIMIT ?`,
      params: [actor, options.afterKeyId === undefined ? '' : keyId(actor, options.afterKeyId), validate.limit(options.limit)] });
      return rows.map((row) => ({ ...row, revoked: row.revoked === 1 }));
    },
    async setEnabled(actor: string, enabled: boolean) {
      if (typeof enabled !== 'boolean') validate.invalid('Expected enabled boolean');
      const [changed] = await driver.batch([{ sql: 'UPDATE unity_sync_peers SET enabled = ? WHERE actor = ?', params: [Number(enabled), actorUri(actor)] }]);
      missing(changed);
    },
    async setScopes(actor: string, input: readonly SyncScope[]) {
      actor = actorUri(actor); const scopes = [...new Set(input.map(scopeValue))];
      // Empty scopes revoke all operations. The peer/key identity remains reserved.
      const [changed] = await driver.batch([
        { sql: 'UPDATE unity_sync_peers SET enabled = enabled WHERE actor = ?', params: [actor] },
        { sql: 'DELETE FROM unity_sync_scopes WHERE actor = ?', params: [actor] },
        ...scopes.map((scope) => ({ sql: 'INSERT INTO unity_sync_scopes(actor, scope) VALUES (?, ?)', params: [actor, scope] })),
      ]);
      missing(changed);
    },
    async addKey(actor: string, id: string, publicKey: CryptoKey) {
      actor = actorUri(actor); id = keyId(actor, id);
      const encoded = await publicKeyHex(publicKey);
      await driver.batch([{ sql: 'INSERT INTO unity_sync_keys(actor, key_id, public_key, revoked) VALUES (?, ?, ?, 0)', params: [actor, id, encoded] }]);
    },
    async rotateKey(actor: string, previousId: string, replacementId: string, publicKey: CryptoKey) {
      actor = actorUri(actor); previousId = keyId(actor, previousId); replacementId = keyId(actor, replacementId);
      if (previousId === replacementId) validate.invalid('Rotation requires a new key ID');
      const encoded = await publicKeyHex(publicKey);
      const [inserted] = await driver.batch([
        { sql: `INSERT INTO unity_sync_keys(actor, key_id, public_key, revoked)
          SELECT actor, ?, ?, 0 FROM unity_sync_keys WHERE actor = ? AND key_id = ? AND revoked = 0`,
        params: [replacementId, encoded, actor, previousId] },
        { sql: 'UPDATE unity_sync_keys SET revoked = 1 WHERE actor = ? AND key_id = ? AND revoked = 0', params: [actor, previousId] },
      ]);
      missing(inserted);
    },
    async revokeKey(actor: string, id: string) {
      actor = actorUri(actor); id = keyId(actor, id);
      const [changed] = await driver.batch([{ sql: 'UPDATE unity_sync_keys SET revoked = 1 WHERE actor = ? AND key_id = ?', params: [actor, id] }]);
      missing(changed);
    },
    async resolveKey(actor: string, id: string, scope: SyncScope) {
      actor = actorUri(actor); id = keyId(actor, id); scope = scopeValue(scope);
      const [row] = await driver.query<{ publicKey: string }>({ sql: `SELECT k.public_key AS publicKey ${active}`, params: [actor, id, scope] });
      if (!row) return null;
      if (!/^[a-f0-9]{64}$/.test(row.publicKey)) throw new StoreError('INTEGRITY', 'Invalid stored sync key');
      const bytes = Uint8Array.from(row.publicKey.match(/../g)!, (pair) => Number.parseInt(pair, 16));
      return { actor, keyId: id, publicKey: await crypto.subtle.importKey('raw', bytes, 'Ed25519', false, ['verify']) };
    },
    async consumeNonce(claim: Readonly<SyncNonceClaim>, scope: SyncScope): Promise<boolean> {
      // Snapshot a verified SDK claim before the first await. Never call this on unsigned input.
      const actor = actorUri(claim.actor); const id = keyId(actor, claim.keyId);
      const nonce = token(claim.nonce); const requestId = token(claim.requestId); const requestHash = validate.hash(claim.requestHash);
      const retainUntil = validate.count(claim.retainUntil, 'retainUntil seconds'); scope = scopeValue(scope);
      const checkedAt = now();
      if (retainUntil < checkedAt || retainUntil > checkedAt + SYNC_HTTP_MAX_AGE + 2 * SYNC_HTTP_CLOCK_SKEW) return false;
      const [inserted] = await driver.batch([{ sql: `INSERT INTO unity_sync_nonces(actor, nonce, key_id, request_id, request_hash, retain_until)
        SELECT p.actor, ?, k.key_id, ?, ?, ? ${active} ON CONFLICT(actor, nonce) DO NOTHING`,
      params: [nonce, requestId, requestHash, retainUntil, actor, id, scope] }]);
      // A slow backend must not turn an expired claim into successful admission.
      return inserted === 1 && retainUntil >= now();
    },
    /** Current grant and exact admitted claim, for protected reads and host identity mapping. */
    async authorize(input: Readonly<SyncNonceClaim>, scope: SyncScope) {
      const actor = actorUri(input.actor); const id = keyId(actor, input.keyId);
      const nonce = token(input.nonce); const requestId = token(input.requestId); const requestHash = validate.hash(input.requestHash);
      const retainUntil = validate.count(input.retainUntil, 'retainUntil seconds'); scope = scopeValue(scope);
      const [row] = await driver.query<{ accountId: string; accountUri: string; workspaceId: string }>({
        sql: `SELECT a.id AS accountId, a.actor_uri AS accountUri, w.id AS workspaceId ${active}
          AND EXISTS (SELECT 1 FROM unity_sync_nonces n WHERE n.actor = p.actor AND n.key_id = k.key_id
            AND n.nonce = ? AND n.request_id = ? AND n.request_hash = ? AND n.retain_until = ? AND n.retain_until >= ?)`,
        params: [actor, id, scope, nonce, requestId, requestHash, retainUntil, now()],
      });
      if (!row || retainUntil < now()) throw new StoreError('UNAUTHENTICATED', 'Sync claim expired, unadmitted or revoked');
      return row;
    },
    async pruneNonces(): Promise<number> {
      const [removed] = await driver.batch([{ sql: 'DELETE FROM unity_sync_nonces WHERE retain_until < ?', params: [now()] }]);
      return removed ?? 0;
    },
  };
}
export type SyncStore = ReturnType<typeof createSyncStore>;

export type { SyncWriteContext, SyncReceipt } from './sync-operations.js';
export { snapshotSyncContext } from './sync-operations.js';
