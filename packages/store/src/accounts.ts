import type { Statement, StoreDriver } from './driver.js';
import { StoreError } from './types.js';
import * as validate from './validation.js';

export { actorUri as publicAccountActorUri } from './validation.js';

export const sessionLifetimeMs = 8 * 60 * 60 * 1000;
export const sessionIdleMs = 30 * 60 * 1000;
export interface Account { id: string; uri: string; name: string; enabled: boolean; createdAt: number }
export interface SessionProof { accountId: string; tokenHash: string }
export interface AccountSession { account: Account; proof: SessionProof; expiresAt: number }
interface AccountRow extends Omit<Account, 'enabled'> { enabled: number }
const columns = 'a.id, a.actor_uri AS uri, a.name, a.enabled, a.created_at AS createdAt';
const account = (row: AccountRow): Account => ({ ...row, enabled: row.enabled === 1 });
function nowValue(now: number) { return validate.count(now, 'now'); }
function token(prefix: 'cuk' | 'cus') {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${prefix}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
async function digest(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export function validSessionToken(value: string): boolean { return /^cus_[a-f0-9]{64}$/.test(value); }
function expired(): never { throw new StoreError('UNAUTHENTICATED', 'Session expired or revoked; sign in again'); }

/** Operator methods are never exposed as public HTTP routes. Keys have 256 random bits, not user passwords. */
export function createAccountStore(driver: StoreDriver, clock: () => number = Date.now) {
  async function lookup(tokenHash: string, now: number): Promise<AccountSession | null> {
    const [row] = await driver.query<AccountRow & { expiresAt: number }>({
      sql: `SELECT ${columns}, s.expires_at AS expiresAt FROM unity_sessions s
        JOIN unity_accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND a.enabled = 1
        AND s.expires_at > ? AND s.last_seen_at > ?`, params: [tokenHash, now, now - sessionIdleMs],
    });
    if (!row) return null;
    const { expiresAt, ...rest } = row;
    return { account: account(rest), proof: { accountId: row.id, tokenHash }, expiresAt };
  }
  return {
    async create(name: string, options: { actorUri?: string } = {}) {
      name = validate.text(name.trim(), 'account name', 80);
      const requestedUri = options.actorUri;
      const actorUri = requestedUri === undefined ? undefined : validate.actorUri(requestedUri);
      const key = token('cuk'); const keyHash = await digest(key);
      const id = crypto.randomUUID(); const uri = actorUri ?? `urn:unity:user:${id}`;
      const createdAt = nowValue(clock());
      await driver.batch([{ sql: 'INSERT INTO unity_accounts(id, actor_uri, name, key_hash, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)',
        params: [id, uri, name, keyHash, createdAt] }]);
      return { account: { id, uri, name, enabled: true, createdAt }, key };
    },
    async list(options: { afterId?: string; limit?: number } = {}) {
      const rows = await driver.query<AccountRow>({ sql: `SELECT ${columns} FROM unity_accounts a WHERE a.id > ? ORDER BY a.id LIMIT ?`,
        params: [options.afterId ?? '', validate.limit(options.limit)] });
      return rows.map(account);
    },
    async rotateKey(id: string) {
      validate.text(id, 'accountId');
      const key = token('cuk'); const keyHash = await digest(key);
      const [changed] = await driver.batch([{ sql: 'UPDATE unity_accounts SET key_hash = ? WHERE id = ?', params: [keyHash, id] }]);
      // D1 includes session deletions by the revocation trigger in its change count.
      if (!changed) throw new StoreError('NOT_FOUND', 'Account not found');
      return { accountId: id, key };
    },
    async setEnabled(id: string, enabled: boolean) {
      validate.text(id, 'accountId');
      if (typeof enabled !== 'boolean') validate.invalid('Expected enabled boolean');
      const [changed] = await driver.batch([{ sql: 'UPDATE unity_accounts SET enabled = ? WHERE id = ?', params: [Number(enabled), id] }]);
      if (!changed) throw new StoreError('NOT_FOUND', 'Account not found');
      return { accountId: id, enabled };
    },
    async login(key: string, previousToken?: string) {
      if (typeof key !== 'string' || !/^cuk_[a-f0-9]{64}$/.test(key)) return null;
      const keyHash = await digest(key); const sessionToken = token('cus'); const tokenHash = await digest(sessionToken);
      const previousHash = previousToken && validSessionToken(previousToken) ? await digest(previousToken) : null;
      const now = nowValue(clock());
      const [inserted] = await driver.batch([
        { sql: `INSERT INTO unity_sessions(token_hash, account_id, created_at, last_seen_at, expires_at)
          SELECT ?, id, ?, ?, ? FROM unity_accounts WHERE key_hash = ? AND enabled = 1`,
        params: [tokenHash, now, now, now + sessionLifetimeMs, keyHash] },
        // Only a successful login can revoke the cookie it replaces.
        { sql: `DELETE FROM unity_sessions WHERE token_hash = ? AND EXISTS (SELECT 1 FROM unity_sessions WHERE token_hash = ?)`, params: [previousHash, tokenHash] },
        { sql: `DELETE FROM unity_sessions WHERE account_id = (SELECT account_id FROM unity_sessions WHERE token_hash = ?)
          AND (expires_at <= ? OR last_seen_at <= ?)`, params: [tokenHash, now, now - sessionIdleMs] },
        // Keep at most eight sessions per account, including the newly issued one.
        { sql: `DELETE FROM unity_sessions WHERE token_hash IN (SELECT token_hash FROM unity_sessions
          WHERE account_id = (SELECT account_id FROM unity_sessions WHERE token_hash = ?) AND token_hash != ?
          ORDER BY created_at DESC, token_hash DESC LIMIT -1 OFFSET 7)`, params: [tokenHash, tokenHash] },
      ]);
      if (inserted !== 1) return null;
      const session = await lookup(tokenHash, now);
      return session ? { ...session, token: sessionToken } : null;
    },
    async authenticate(value: string) {
      if (!validSessionToken(value)) return null;
      const tokenHash = await digest(value); const now = nowValue(clock());
      await driver.batch([{ sql: `UPDATE unity_sessions SET last_seen_at = MAX(last_seen_at, ?)
        WHERE token_hash = ? AND expires_at > ? AND last_seen_at > ?
        AND account_id IN (SELECT id FROM unity_accounts WHERE enabled = 1)`, params: [now, tokenHash, now, now - sessionIdleMs] }]);
      return lookup(tokenHash, now);
    },
    async logout(value: string) {
      if (!validSessionToken(value)) return;
      await driver.batch([{ sql: 'DELETE FROM unity_sessions WHERE token_hash = ?', params: [await digest(value)] }]);
    },
    async requireProof(proof: SessionProof) {
      const session = await lookup(proof.tokenHash, nowValue(clock()));
      if (!session || session.account.id !== proof.accountId) expired();
    },
  };
}
export type AccountStore = ReturnType<typeof createAccountStore>;

/** Every domain batch checks the session in the same SQL transaction as its writes. */
export function createSessionDriver(driver: StoreDriver, input: SessionProof, clock: () => number = Date.now): StoreDriver {
  const proof = { accountId: validate.text(input.accountId, 'accountId'), tokenHash: validate.hash(input.tokenHash) };
  const accounts = createAccountStore(driver, clock);
  return {
    async query<T>(statement: Statement) {
      const result = await driver.query<T>(statement);
      await accounts.requireProof(proof);
      return result;
    },
    async batch(statements) {
      if (!statements.length) return [];
      const id = crypto.randomUUID();
      try {
        const results = await driver.batch([
          { sql: 'INSERT INTO unity_session_write_guards(id, token_hash, account_id, checked_at) VALUES (?, ?, ?, ?)',
            params: [id, proof.tokenHash, proof.accountId, nowValue(clock())] },
          ...statements,
          { sql: 'DELETE FROM unity_session_write_guards WHERE id = ?', params: [id] },
        ]);
        return results.slice(1, -1);
      } catch (error) {
        if (error instanceof Error && error.message.includes('UNITY_SESSION_EXPIRED')) expired();
        throw error;
      }
    },
  };
}
