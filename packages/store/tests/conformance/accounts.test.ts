import Database from 'better-sqlite3';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccountStore, createSessionDriver, sessionIdleMs, sessionLifetimeMs } from '../../src/accounts.js';
import type { AccountStore } from '../../src/accounts.js';
import { createNodeDriver } from '../../src/node.js';
import { createD1Driver } from '../../src/d1.js';
import { createStore } from '../../src/index.js';
import { migrate } from '../../src/migrations.js';
import type { StoreDriver } from '../../src/driver.js';

for (const adapter of ['sqlite', 'd1']) describe(`accounts contract / ${adapter}`, () => {
  let close: () => void | Promise<void>;
  let driver: StoreDriver;
  let accounts: AccountStore;
  let now: number;
  beforeEach(async () => {
    if (adapter === 'sqlite') {
      const db = new Database(':memory:'); driver = createNodeDriver(db); close = () => { db.close(); };
    } else {
      const mf = new Miniflare(convertV4MiniflareOptions({ port: 0, workers: [{ name: 'accounts-test', modules: true,
        script: 'export default { fetch() { return new Response("test"); } };', compatibilityDate: '2026-10-11', d1Databases: ['DB'] }] }));
      driver = createD1Driver(await mf.getD1Database('DB')); close = () => mf.dispose();
    }
    await migrate(driver); now = Date.now(); accounts = createAccountStore(driver, () => now);
  });
  afterEach(async () => { await close?.(); });

  it('[A01] issues independent keys and sessions, stores only digests and rejects invalid or substituted credentials', async () => {
    const alice = await accounts.create('Alice'); const bob = await accounts.create('Bob');
    expect(alice.account.uri).toBe(`urn:unity:user:${alice.account.id}`);
    expect(alice.key).toMatch(/^cuk_[a-f0-9]{64}$/); expect(alice.key).not.toBe(bob.key);
    const session = (await accounts.login(alice.key))!;
    expect(session.token).toMatch(/^cus_[a-f0-9]{64}$/);
    expect(session.account).toEqual(alice.account);
    expect((await accounts.authenticate(session.token))?.account).toEqual(alice.account);
    expect(await accounts.authenticate(alice.key)).toBeNull(); expect(await accounts.login(session.token)).toBeNull();
    expect(await accounts.login(`cuk_${'0'.repeat(64)}`)).toBeNull();
    expect(await accounts.authenticate(`cus_${'0'.repeat(64)}`)).toBeNull();
    const rows = JSON.stringify(await driver.query({ sql: 'SELECT * FROM unity_accounts UNION ALL SELECT token_hash, account_id, NULL, NULL, NULL, NULL FROM unity_sessions' }));
    expect(rows).not.toContain(alice.key); expect(rows).not.toContain(bob.key); expect(rows).not.toContain(session.token);
    expect(await accounts.list()).toHaveLength(2);
    await expect(driver.batch([{ sql: "UPDATE unity_accounts SET actor_uri = 'urn:forged' WHERE id = ?", params: [alice.account.id] }])).rejects.toThrow();
  });

  it('[A02] enforces idle and absolute expiry on the server without extending absolute lifetime', async () => {
    const alice = await accounts.create('Alice');
    const first = (await accounts.login(alice.key))!;
    now += sessionIdleMs - 1;
    expect((await accounts.authenticate(first.token))?.expiresAt).toBe(first.expiresAt);
    now += sessionIdleMs;
    expect(await accounts.authenticate(first.token)).toBeNull();
    const active = (await accounts.login(alice.key))!;
    await driver.batch([{ sql: 'UPDATE unity_sessions SET last_seen_at = expires_at - 1 WHERE token_hash = ?', params: [active.proof.tokenHash] }]);
    now += sessionLifetimeMs;
    expect(await accounts.authenticate(active.token)).toBeNull();
    await expect(driver.batch([{ sql: 'UPDATE unity_sessions SET expires_at = expires_at + 1' }])).rejects.toThrow();
  });

  it('[A03] revokes replaced/logged-out sessions and all sessions on key rotation or disablement', async () => {
    const alice = await accounts.create('Alice');
    const first = (await accounts.login(alice.key))!;
    const replaced = (await accounts.login(alice.key, first.token))!;
    expect(replaced.token).not.toBe(first.token); expect(await accounts.authenticate(first.token)).toBeNull();
    await accounts.logout(replaced.token); expect(await accounts.authenticate(replaced.token)).toBeNull();
    const beforeRotation = (await accounts.login(alice.key))!;
    const rotated = await accounts.rotateKey(alice.account.id);
    expect(await accounts.authenticate(beforeRotation.token)).toBeNull(); expect(await accounts.login(alice.key)).toBeNull();
    const latest = (await accounts.login(rotated.key))!;
    await accounts.setEnabled(alice.account.id, false);
    expect(await accounts.authenticate(latest.token)).toBeNull(); expect(await accounts.login(rotated.key)).toBeNull();
    await accounts.setEnabled(alice.account.id, true);
    expect(await accounts.authenticate(latest.token)).toBeNull(); expect(await accounts.login(rotated.key)).not.toBeNull();
  });

  it('[A04] limits each account to eight sessions and keeps the newest login usable', async () => {
    const alice = await accounts.create('Alice'); const bob = await accounts.create('Bob');
    const other = (await accounts.login(bob.key))!;
    const sessions = [];
    for (let i = 0; i < 10; i++) { now++; sessions.push((await accounts.login(alice.key))!); }
    expect(await accounts.authenticate(sessions[0]!.token)).toBeNull(); expect(await accounts.authenticate(sessions[1]!.token)).toBeNull();
    expect(await accounts.authenticate(sessions[9]!.token)).not.toBeNull(); expect(await accounts.authenticate(other.token)).not.toBeNull();
    expect(await driver.query({ sql: 'SELECT COUNT(*) AS count FROM unity_sessions' })).toEqual([{ count: 9 }]);
  });

  it('[A05] checks revocation inside domain write batches and leaves no rows or guards after failures', async () => {
    const alice = await accounts.create('Alice'); const session = (await accounts.login(alice.key))!;
    const scoped = createStore(createSessionDriver(driver, session.proof, () => now));
    const workspace = await scoped.createWorkspace({ ownerId: alice.account.id, name: 'Desk' });
    expect((await scoped.getWorkspace(workspace.id)).id).toBe(workspace.id);
    const invalidActor = createStore(createSessionDriver(driver, { ...session.proof, accountId: 'not-alice' }, () => now));
    await expect(invalidActor.createWorkspace({ ownerId: 'not-alice', name: 'Denied' })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    let revoke = true;
    const interrupted: StoreDriver = { query: (query) => driver.query(query), async batch(statements) {
      if (revoke) { revoke = false; await accounts.setEnabled(alice.account.id, false); }
      return driver.batch(statements);
    } };
    const guarded = createStore(createSessionDriver(interrupted, session.proof, () => now));
    await expect(guarded.createWorkspace({ ownerId: alice.account.id, name: 'After revoke' })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(scoped.getWorkspace(workspace.id)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await driver.query({ sql: 'SELECT name FROM unity_workspaces' })).toEqual([{ name: 'Desk' }]);
    expect(await driver.query({ sql: 'SELECT * FROM unity_session_write_guards' })).toEqual([]);
  });

  it('[A07] provisions one immutable public actor explicitly, preserving local URNs and rejecting aliases', async () => {
    const local = await accounts.create('Local');
    expect(local.account.uri).toBe(`urn:unity:user:${local.account.id}`);
    const uri = 'https://sender.example/actors/alice';
    const options = { actorUri: uri };
    const pending = accounts.create('Public Alice', options); options.actorUri = 'https://changed.example/actor';
    const created = await pending; expect(created.account.uri).toBe(uri);
    expect((await accounts.login(created.key))?.account.uri).toBe(uri);
    await expect(accounts.create('Duplicate', { actorUri: uri })).rejects.toThrow();
    for (const actorUri of ['', 'urn:unity:user:public', 'http://sender.example/actor', 'https://SENDER.example/actor',
      'https://sender.example', 'https://sender.example/actor#key', 'https://sender.example/actor?x=1',
      'https://user:pass@sender.example/actor', ' https://sender.example/actor', `https://sender.example/${'x'.repeat(1024)}`]) {
      await expect(accounts.create('Invalid', { actorUri })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    await expect(driver.batch([{ sql: 'UPDATE unity_accounts SET actor_uri = ? WHERE id = ?', params: ['https://replacement.example/actor', created.account.id] }])).rejects.toThrow();
    const rotated = await accounts.rotateKey(created.account.id);
    expect((await accounts.login(rotated.key))?.account.uri).toBe(uri);
    expect(await accounts.list()).toHaveLength(2);
    const concurrent = await Promise.allSettled([accounts.create('First', { actorUri: `${uri}/two` }), accounts.create('Second', { actorUri: `${uri}/two` })]);
    expect(concurrent.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
  });

  it('[A06] rejects a login when the key changes before the session batch commits', async () => {
    const alice = await accounts.create('Alice');
    let rotated = false;
    const racing = createAccountStore({ query: (query) => driver.query(query), async batch(statements) {
      if (!rotated) { rotated = true; await accounts.rotateKey(alice.account.id); }
      return driver.batch(statements);
    } }, () => now);
    expect(await racing.login(alice.key)).toBeNull();
    expect(await driver.query({ sql: 'SELECT * FROM unity_sessions' })).toEqual([]);
  });
});
