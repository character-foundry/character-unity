import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSyncToken, signSyncHttp, verifySyncHttp } from '@character-foundry/character-foundry/sync';
import type { SyncNonceClaim } from '@character-foundry/character-foundry/sync';
import { createNodeDriver } from '../../src/node.js';
import { createD1Driver } from '../../src/d1.js';
import { createSyncStore } from '../../src/sync.js';
import type { SyncStore } from '../../src/sync.js';
import { createAccountStore } from '../../src/accounts.js';
import { createStore } from '../../src/index.js';
import { migrate, inspectSchema } from '../../src/migrations.js';
import { migrations } from '../../src/schema.js';
import type { StoreDriver } from '../../src/driver.js';

const actor = 'https://peer.example/actors/alice';
const id = `${actor}#key-1`;
for (const adapter of ['sqlite', 'd1']) describe(`sync contract / ${adapter}`, () => {
  let directory: string; let close: () => void | Promise<void>;
  let driver: StoreDriver; let sync: SyncStore; let now: number;
  let accountId: string; let workspaceId: string; let key: CryptoKeyPair;
  async function open() {
    if (adapter === 'sqlite') {
      const db = new Database(join(directory, 'unity.db')); driver = createNodeDriver(db);
      db.pragma('journal_mode = WAL'); close = () => { db.close(); };
    } else {
      const mf = new Miniflare({ ...convertV4MiniflareOptions({ port: 0, workers: [{ name: 'sync-test', modules: true,
        script: 'export default { fetch() { return new Response("test"); } };', compatibilityDate: '2026-10-11', d1Databases: ['DB'] }] }),
      resourcePersistencePath: join(directory, 'state') });
      driver = createD1Driver(await mf.getD1Database('DB')); close = () => mf.dispose();
    }
    sync = createSyncStore(driver, () => now);
  }
  async function provision() {
    accountId = (await createAccountStore(driver).create('Alice')).account.id;
    workspaceId = (await createStore(driver).createWorkspace({ ownerId: accountId, name: 'Peer desk' })).id;
    await sync.grant({ actor, accountId, workspaceId, scopes: ['pull', 'publish'] });
    key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    await sync.addKey(actor, id, key.publicKey);
  }
  function claim(overrides: Partial<SyncNonceClaim> = {}): SyncNonceClaim {
    return { actor, keyId: id, nonce: createSyncToken(), requestId: createSyncToken(), requestHash: 'a'.repeat(64),
      retainUntil: Math.floor(now / 1000) + 60, ...overrides };
  }
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'unity-sync-')); now = Date.now(); await open(); await migrate(driver); await provision(); });
  afterEach(async () => { await close?.(); if (directory) await rm(directory, { recursive: true, force: true }); });

  it('[S01] pins exact public keys to local account/workspace grants and explicit scopes', async () => {
    expect(await sync.getPeer(actor)).toEqual({ actor, accountId, workspaceId, enabled: true });
    expect(await sync.resolveKey(actor, id, 'pull')).toMatchObject({ actor, keyId: id });
    expect(await sync.resolveKey(actor, `${actor}#unknown`, 'pull')).toBeNull();
    expect(await sync.resolveKey(actor, id, 'fork')).toBeNull();
    expect(await sync.consumeNonce(claim(), 'fork')).toBe(false);
    await expect(sync.addKey(actor, 'https://different.example/#key', key.publicKey)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(sync.addKey(actor, `${actor}#private`, key.privateKey)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const other = (await createAccountStore(driver).create('Bob')).account.id;
    await expect(sync.grant({ actor: 'https://other.example/actor', accountId: other, workspaceId, scopes: ['pull'] })).rejects.toThrow();
    expect(await sync.getPeer('https://other.example/actor')).toBeNull();
    await sync.setScopes(actor, ['fork']);
    expect(await sync.resolveKey(actor, id, 'pull')).toBeNull();
    expect(await sync.consumeNonce(claim(), 'fork')).toBe(true);
    await sync.setScopes(actor, []);
    expect(await sync.consumeNonce(claim(), 'fork')).toBe(false);
  });

  it('[S02] admits exactly one concurrent nonce and keeps replay state across key rotation and backend restart', async () => {
    const value = claim();
    let secondClose: (() => void) | undefined;
    let second = createSyncStore(driver, () => now);
    if (adapter === 'sqlite') {
      const db = new Database(join(directory, 'unity.db')); second = createSyncStore(createNodeDriver(db), () => now); secondClose = () => { db.close(); };
    }
    try {
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? sync : second).consumeNonce(value, 'publish')));
      expect(results.filter(Boolean)).toHaveLength(1);
    } finally { secondClose?.(); }
    const rotated = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    await sync.addKey(actor, `${actor}#key-2`, rotated.publicKey); await sync.revokeKey(actor, id);
    expect(await sync.consumeNonce({ ...value, keyId: `${actor}#key-2` }, 'publish')).toBe(false);
    await close(); await open();
    expect(await sync.consumeNonce({ ...value, keyId: `${actor}#key-2` }, 'publish')).toBe(false);
    expect(await sync.resolveKey(actor, id, 'publish')).toBeNull();
    expect(await sync.consumeNonce(claim({ keyId: `${actor}#key-2` }), 'publish')).toBe(true);
  });

  it('[S03] checks key, peer, account and scope revocation inside nonce insertion after key resolution', async () => {
    for (const change of ['peer', 'account', 'scope', 'key'] as const) {
      expect(await sync.resolveKey(actor, id, 'publish')).not.toBeNull();
      const wrapped: StoreDriver = { query: (query) => driver.query(query), async batch(statements) {
        if (change === 'key') await sync.revokeKey(actor, id);
        if (change === 'peer') await sync.setEnabled(actor, false);
        if (change === 'account') await createAccountStore(driver).setEnabled(accountId, false);
        if (change === 'scope') await sync.setScopes(actor, ['pull']);
        return driver.batch(statements);
      } };
      expect(await createSyncStore(wrapped, () => now).consumeNonce(claim(), 'publish')).toBe(false);
      expect(await driver.query({ sql: 'SELECT * FROM unity_sync_nonces' })).toEqual([]);
      if (change === 'key') {
        await expect(sync.addKey(actor, id, key.publicKey)).rejects.toThrow();
        await expect(driver.batch([{ sql: 'UPDATE unity_sync_keys SET revoked = 0' }])).rejects.toThrow();
        await expect(driver.batch([{ sql: 'DELETE FROM unity_sync_keys' }])).rejects.toThrow();
      }
      if (change === 'peer') await sync.setEnabled(actor, true);
      if (change === 'account') await createAccountStore(driver).setEnabled(accountId, true);
      if (change === 'scope') await sync.setScopes(actor, ['pull', 'publish']);
    }
    await expect(driver.batch([{ sql: "UPDATE unity_sync_peers SET workspace_id = 'other'" }])).rejects.toThrow();
    await expect(driver.batch([{ sql: "UPDATE unity_sync_keys SET public_key = 'other'" }])).rejects.toThrow();
  });

  it('[S04] retains the inclusive clock boundary, prunes strictly expired claims and refuses stale or excessive retention', async () => {
    now = Math.floor(now / 1000) * 1000;
    const value = claim({ retainUntil: now / 1000 });
    expect(await sync.consumeNonce(value, 'pull')).toBe(true);
    expect(await sync.pruneNonces()).toBe(0);
    expect(await sync.consumeNonce(value, 'pull')).toBe(false);
    now += 1000;
    expect(await sync.pruneNonces()).toBe(1);
    expect(await sync.consumeNonce(value, 'pull')).toBe(false);
    expect(await sync.consumeNonce(claim({ retainUntil: now / 1000 + 361 }), 'pull')).toBe(false);
    const slow: StoreDriver = { query: (query) => driver.query(query), async batch(statements) {
      const result = await driver.batch(statements); now += 61_000; return result;
    } };
    expect(await createSyncStore(slow, () => now).consumeNonce(claim(), 'pull')).toBe(false);
  });

  it('[S05] propagates storage failure and rolls back failed batches without an in-memory fallback', async () => {
    const value = claim();
    const broken: StoreDriver = { query: (query) => driver.query(query), batch: (statements) => driver.batch([
      ...statements, { sql: 'INSERT INTO nonexistent_table VALUES (1)' },
    ]) };
    await expect(createSyncStore(broken, () => now).consumeNonce(value, 'publish')).rejects.toThrow();
    expect(await driver.query({ sql: 'SELECT * FROM unity_sync_nonces' })).toEqual([]);
    expect(await sync.consumeNonce(value, 'publish')).toBe(true);
    await expect(driver.batch([{ sql: 'UPDATE unity_sync_nonces SET retain_until = 0' }])).rejects.toThrow();
  });

  it('[S06] verifies signed bytes with the public SDK and durable callbacks without treating fresh retries as mutation receipts', async () => {
    const options = { now: Math.floor(now / 1000), resolveKey: (actor: string, id: string) => sync.resolveKey(actor, id, 'publish'),
      consumeNonce: (value: Readonly<SyncNonceClaim>) => sync.consumeNonce(value, 'publish') };
    const input = { actor, keyId: id, privateKey: key.privateKey, requestId: createSyncToken(), created: options.now,
      method: 'POST' as const, url: 'https://local.example/sync/publish', contentType: 'application/json' as const,
      body: new TextEncoder().encode('{"selected":["one"]}') };
    const message = await signSyncHttp(input);
    const tampered = { ...message, body: new TextEncoder().encode('{"selected":["two"]}') };
    await expect(verifySyncHttp(tampered, options)).rejects.toMatchObject({ code: 'INVALID_DIGEST' });
    expect(await driver.query({ sql: 'SELECT * FROM unity_sync_nonces' })).toEqual([]);
    const verified = await verifySyncHttp(message, options);
    expect(verified.body).toEqual(input.body);
    await expect(verifySyncHttp(message, options)).rejects.toMatchObject({ code: 'REPLAY' });
    const retry = await verifySyncHttp(await signSyncHttp(input), options);
    expect(retry.requestHash).toBe(verified.requestHash);
    expect(retry.requestId).toBe(verified.requestId);
    expect(retry.nonce).not.toBe(verified.nonce);
    expect(await driver.query({ sql: 'SELECT COUNT(*) AS count FROM unity_sync_nonces' })).toEqual([{ count: 2 }]);
  });

  it('[S08] lists peer/key pages deterministically and distinguishes account suspension from the peer grant', async () => {
    const secondActor = `${actor}/second`;
    await sync.grant({ actor: secondActor, accountId, workspaceId, scopes: ['fork'] });
    expect((await sync.listPeers({ limit: 1 })).map((peer) => peer.actor)).toEqual([actor]);
    expect((await sync.listPeers({ afterActor: actor, limit: 1 })).map((peer) => peer.actor)).toEqual([secondActor]);
    expect(await sync.listPeers({ afterActor: secondActor })).toEqual([]);
    await sync.addKey(actor, `${actor}#key-2`, key.publicKey); await sync.revokeKey(actor, id);
    const first = await sync.listKeys(actor, { limit: 1 });
    expect(first).toMatchObject([{ keyId: id, revoked: true }]);
    expect(first[0]!.publicKeyHex).toMatch(/^[a-f0-9]{64}$/);
    expect(await sync.listKeys(actor, { afterKeyId: id })).toMatchObject([{ keyId: `${actor}#key-2`, revoked: false }]);
    expect(await sync.inspectPeer(actor)).toEqual({ actor, accountId, workspaceId, enabled: true, accountEnabled: true, scopes: ['publish', 'pull'] });
    await createAccountStore(driver).setEnabled(accountId, false);
    expect(await sync.inspectPeer(actor)).toMatchObject({ enabled: true, accountEnabled: false });
    expect(await sync.resolveKey(actor, `${actor}#key-2`, 'pull')).toBeNull();
    await expect(sync.listKeys(actor, { afterKeyId: `${secondActor}#one` })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(sync.listPeers({ limit: 101 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(sync.inspectPeer('https://missing.example/actor')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('[S09] rotates keys atomically, rolls back replacement failure and admits only one concurrent rotation', async () => {
    const replacement = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const next = `${actor}#key-2`;
    for (const failAt of [0, 1, 2]) {
      const faulty: StoreDriver = { query: (query) => driver.query(query), batch(statements) {
        const broken = [...statements]; broken.splice(failAt, 0, { sql: 'INSERT INTO nonexistent_table VALUES (1)' });
        return driver.batch(broken);
      } };
      await expect(createSyncStore(faulty).rotateKey(actor, id, next, replacement.publicKey)).rejects.toThrow();
      expect(await sync.listKeys(actor)).toMatchObject([{ keyId: id, revoked: false }]);
      expect(await sync.resolveKey(actor, id, 'pull')).not.toBeNull();
    }
    await expect(sync.rotateKey(actor, id, id, replacement.publicKey)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(sync.rotateKey(actor, `${actor}#missing`, next, replacement.publicKey)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const outcomes = await Promise.allSettled([sync.rotateKey(actor, id, next, replacement.publicKey), sync.rotateKey(actor, id, `${actor}#key-3`, replacement.publicKey)]);
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const keys = await sync.listKeys(actor); expect(keys).toHaveLength(2);
    expect(keys.find((item) => item.keyId === id)?.revoked).toBe(true);
    const activeKey = keys.find((item) => !item.revoked)!;
    await expect(sync.rotateKey(actor, activeKey.keyId, id, replacement.publicKey)).rejects.toThrow();
    expect(await sync.resolveKey(actor, activeKey.keyId, 'pull')).not.toBeNull();
    await expect(sync.rotateKey(actor, id, `${actor}#key-4`, replacement.publicKey)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await sync.listKeys(actor)).toEqual(keys);
  });

  it('[S10] authorizes only an exact admitted claim while its grant and expiry remain current', async () => {
    const value = claim();
    await expect(sync.authorize(value, 'pull')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await sync.consumeNonce(value, 'pull')).toBe(true);
    expect(await sync.authorize(value, 'pull')).toMatchObject({ accountId, workspaceId });
    for (const changed of [{ nonce: createSyncToken() }, { requestId: createSyncToken() }, { requestHash: 'b'.repeat(64) },
      { retainUntil: value.retainUntil + 1 }, { keyId: `${actor}#key-2` }]) {
      await expect(sync.authorize({ ...value, ...changed }, 'pull')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    }
    for (const change of ['scope', 'peer', 'account']) {
      if (change === 'scope') await sync.setScopes(actor, ['publish']);
      if (change === 'peer') await sync.setEnabled(actor, false);
      if (change === 'account') await createAccountStore(driver).setEnabled(accountId, false);
      await expect(sync.authorize(value, 'pull')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      await sync.setScopes(actor, ['pull', 'publish']); await sync.setEnabled(actor, true);
      await createAccountStore(driver).setEnabled(accountId, true);
    }
    now = value.retainUntil * 1000;
    expect(await sync.authorize(value, 'pull')).toMatchObject({ accountId });
    const slow: StoreDriver = { batch: (statements) => driver.batch(statements), async query<T>(statement: Parameters<StoreDriver['query']>[0]) {
      const rows = await driver.query<T>(statement); now += 1000; return rows;
    } };
    await expect(createSyncStore(slow, () => now).authorize(value, 'pull')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    now -= 1000; await sync.revokeKey(actor, id);
    await expect(sync.authorize(value, 'pull')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('[S07] upgrades a populated v5 store without changing accounts, workspaces or prior migration checksums', async () => {
    // This test owns the temporary DB: construct the old schema directly from its unchanged migration ledger.
    await close(); await rm(directory, { recursive: true, force: true }); directory = await mkdtemp(join(tmpdir(), 'unity-sync-v5-')); await open();
    await driver.batch([{ sql: 'CREATE TABLE unity_migrations (version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)' }]);
    for (const migration of migrations.filter((item) => item.version <= 5)) {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(migration.statements))));
      const checksum = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
      await driver.batch([...migration.statements.map((sql) => ({ sql })), { sql: 'INSERT INTO unity_migrations VALUES (?, ?, ?, ?)',
        params: [migration.version, migration.name, checksum, new Date(now).toISOString()] }]);
    }
    const accounts = createAccountStore(driver); const existing = await accounts.create('Before upgrade');
    const workspace = await createStore(driver).createWorkspace({ ownerId: existing.account.id, name: 'Existing desk' });
    const ledger = await driver.query({ sql: 'SELECT * FROM unity_migrations ORDER BY version' });
    expect(await inspectSchema(driver)).toBe(5);
    const faulty: StoreDriver = { query: (query) => driver.query(query), batch: (statements) => driver.batch(
      statements.length > 1 ? [...statements, { sql: 'INSERT INTO nonexistent_table VALUES (1)' }] : statements,
    ) };
    await expect(migrate(faulty)).rejects.toThrow();
    expect(await inspectSchema(driver)).toBe(5);
    expect(await driver.query({ sql: "SELECT name FROM sqlite_master WHERE name GLOB 'unity_sync_*'" })).toEqual([]);
    await migrate(driver); await migrate(driver);
    expect(await inspectSchema(driver)).toBe(10);
    expect(await driver.query({ sql: 'SELECT * FROM unity_migrations WHERE version <= 5 ORDER BY version' })).toEqual(ledger);
    expect(await accounts.list()).toEqual([existing.account]);
    expect((await accounts.login(existing.key))?.account).toEqual(existing.account);
    expect(await createStore(driver).getWorkspace(workspace.id)).toEqual(workspace);
    await sync.grant({ actor, accountId: existing.account.id, workspaceId: workspace.id, scopes: ['pull'] });
    await sync.addKey(actor, id, key.publicKey);
    expect(await sync.consumeNonce(claim(), 'pull')).toBe(true);
  });
});
