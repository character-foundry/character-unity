import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSyncToken, SYNC_COMMAND_VERSION } from '@character-foundry/character-foundry/sync';
import { createNodeDriver } from '../../src/node.js';
import { createD1Driver } from '../../src/d1.js';
import { createAccountStore, createSessionDriver } from '../../src/accounts.js';
import { createStore } from '../../src/index.js';
import { createSyncOutboxStore } from '../../src/sync-outbox.js';
import type { ReturnJobInput } from '../../src/sync-outbox.js';
import { migrate, inspectSchema } from '../../src/migrations.js';
import { migrations } from '../../src/schema.js';
import type { StoreDriver } from '../../src/driver.js';

const actor = 'https://sender.example/actors/alice', baseUrl = 'https://hub.example/api/sync/v1';
const received = (requestId: string) => ({ version: SYNC_COMMAND_VERSION, operation: 'forks.submit' as const, requestId, cardId: 'remote-card', revisionId: 'remote-revision' });
for (const adapter of ['sqlite', 'd1']) describe(`sync-outbox contract / ${adapter}`, () => {
  let directory: string, driver: StoreDriver, close: () => void | Promise<void>, input: ReturnJobInput;
  async function open(path = directory) {
    if (adapter === 'sqlite') {
      const db = new Database(join(path, 'unity.db')); driver = createNodeDriver(db); close = () => { db.close(); };
    } else {
      const mf = new Miniflare({ ...convertV4MiniflareOptions({ port: 0, workers: [{ name: 'outbox-test', modules: true,
        script: 'export default { fetch() { return new Response("test"); } };', compatibilityDate: '2026-10-11', d1Databases: ['DB'] }] }),
      resourcePersistencePath: join(path, 'state') });
      driver = createD1Driver(await mf.getD1Database('DB')); close = () => mf.dispose();
    }
  }
  async function provision(legacy = false) {
    const accountId = (await createAccountStore(driver).create('Alice', { actorUri: actor })).account.id;
    const store = createStore(driver), workspace = await store.createWorkspace({ ownerId: accountId, name: 'Sender' });
    const card = await store.createCard({ workspaceId: workspace.id, authorId: accountId, document: { name: 'Outbox revision' }, identity: { algorithm: 'test', hash: 'a'.repeat(64) } });
    const asset = await store.stageAsset({ workspaceId: workspace.id, hash: 'b'.repeat(64), byteLength: 10, mediaType: 'application/octet-stream' });
    if (legacy) await driver.batch([{ sql: "UPDATE unity_assets SET state = 'ready' WHERE id = ?", params: [asset.id] }]);
    else await store.completeAsset({ workspaceId: workspace.id, assetId: asset.id, measuredHash: asset.hash, measuredByteLength: asset.byteLength });
    input = { accountId, workspaceId: workspace.id, requestId: createSyncToken(), actor, baseUrl, publicationId: 'parent',
      cardId: card.card.id, revisionId: card.revision.id, assetId: asset.id, frameHash: asset.hash, byteLength: asset.byteLength };
  }
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'unity-outbox-')); await open(); await migrate(driver); await provision(); });
  afterEach(async () => { await close?.(); await rm(directory, { recursive: true, force: true }); });

  it('[O01] pins ready frame bytes and a saved revision with immutable destination and identity', async () => {
    const outbox = createSyncOutboxStore(driver), saved = await outbox.enqueue(input);
    expect(saved).toMatchObject({ ...input, state: 'prepared', attempts: 0, receipt: null });
    for (const [field, value] of [['base_url', 'https://evil.example/sync'], ['revision_id', input.revisionId], ['asset_id', input.assetId]]) {
      await expect(driver.batch([{ sql: `UPDATE unity_sync_outbox SET ${field} = ?`, params: [value!] }])).rejects.toThrow('UNITY_IMMUTABLE_OUTBOX');
    }
    await expect(driver.batch([{ sql: 'DELETE FROM unity_sync_outbox' }])).rejects.toThrow('UNITY_IMMUTABLE_OUTBOX');
    for (const changed of [{ actor: `${actor}/other` }, { frameHash: 'c'.repeat(64) }, { byteLength: 11 }, { assetId: 'missing' }]) {
      await expect(outbox.enqueue({ ...input, requestId: createSyncToken(), ...changed })).rejects.toThrow();
    }
    const other = await createStore(driver).createCard({ workspaceId: input.workspaceId, authorId: input.accountId, document: {}, identity: { algorithm: 'test', hash: 'a'.repeat(64) } });
    await expect(outbox.enqueue({ ...input, requestId: createSyncToken(), revisionId: other.revision.id })).rejects.toThrow();
    const staged = await createStore(driver).stageAsset({ workspaceId: input.workspaceId, hash: input.frameHash, byteLength: 10, mediaType: 'application/octet-stream' });
    await expect(outbox.enqueue({ ...input, requestId: createSyncToken(), assetId: staged.id })).rejects.toThrow();
    for (const change of [{ requestId: 'short' }, { baseUrl: 'http://hub.example/api/sync/v1' }, { baseUrl: `${baseUrl}/` }, { byteLength: 8388609 }]) {
      await expect(outbox.enqueue({ ...input, ...change })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(await outbox.list(input)).toHaveLength(1);
  });

  it('[O02] concurrent enqueue and restart retain one owned intent; changed operation IDs never replace it', async () => {
    const outbox = createSyncOutboxStore(driver), mutable = { ...input };
    const pending = outbox.enqueue(mutable); mutable.baseUrl = 'https://elsewhere.example/sync';
    const [first, second] = await Promise.all([pending, outbox.enqueue(input)]); expect(first).toEqual(second);
    await close(); await open(); const reopened = createSyncOutboxStore(driver);
    expect(await reopened.get(input, input.requestId)).toEqual(first);
    for (const change of [{ baseUrl: 'https://elsewhere.example/sync' }, { publicationId: 'other' }]) {
      await expect(reopened.enqueue({ ...input, ...change })).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    }
    const extra = await reopened.enqueue({ ...input, requestId: createSyncToken() });
    const page = await reopened.list(input, { limit: 1 });
    const rest = await reopened.list(input, { afterId: page[0]!.requestId, limit: 1 });
    expect([...page, ...rest].map((job) => job.requestId).sort()).toEqual([first.requestId, extra.requestId].sort());
    const otherWorkspace = await createStore(driver).createWorkspace({ ownerId: input.accountId, name: 'Other desk' });
    expect(await reopened.get({ ...input, workspaceId: otherWorkspace.id }, input.requestId)).toBeNull();
    await expect(reopened.get({ accountId: 'other-account', workspaceId: input.workspaceId }, input.requestId)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('[O03] persists uncertain attempts and one immutable acknowledgment across restart and concurrent retries', async () => {
    const outbox = createSyncOutboxStore(driver); await outbox.enqueue(input);
    await expect(outbox.acknowledge(input, input.requestId, received(input.requestId))).rejects.toThrow('UNITY_OUTBOX_NO_ATTEMPT');
    await outbox.beginAttempt(input, input.requestId); await close(); await open();
    const reopened = createSyncOutboxStore(driver);
    expect(await reopened.get(input, input.requestId)).toMatchObject({ state: 'uncertain', attempts: 1, receipt: null });
    await reopened.beginAttempt(input, input.requestId);
    const results = await Promise.all([reopened.acknowledge(input, input.requestId, received(input.requestId)), reopened.acknowledge(input, input.requestId, received(input.requestId))]);
    expect(results[0]).toEqual(results[1]); expect(results[0]).toMatchObject({ state: 'acknowledged', attempts: 2, receipt: received(input.requestId) });
    expect(await reopened.beginAttempt(input, input.requestId)).toEqual(results[0]);
    await expect(reopened.acknowledge(input, input.requestId, { ...received(input.requestId), revisionId: 'changed' })).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    await expect(reopened.acknowledge(input, input.requestId, received(createSyncToken()))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    for (const table of ['unity_sync_outbox_attempts', 'unity_sync_outbox_receipts']) {
      await expect(driver.batch([{ sql: `DELETE FROM ${table}` }])).rejects.toThrow('UNITY_IMMUTABLE_OUTBOX');
    }
    await close(); await open(); expect(await createSyncOutboxStore(driver).get(input, input.requestId)).toEqual(results[0]);
  });

  it('[O04] checks account and session revocation inside intent, attempt and receipt writes and after reads', async () => {
    const accounts = createAccountStore(driver), outbox = createSyncOutboxStore(driver);
    await outbox.enqueue(input); await outbox.beginAttempt(input, input.requestId);
    for (const operation of ['enqueue', 'attempt', 'receipt']) {
      const key = await accounts.rotateKey(input.accountId), session = (await accounts.login(key.key))!;
      const interrupted: StoreDriver = { query: (query) => driver.query(query), async batch(statements) {
        await accounts.logout(session.token); return driver.batch(statements);
      } };
      const scoped = createSyncOutboxStore(createSessionDriver(interrupted, session.proof));
      await expect(operation === 'enqueue' ? scoped.enqueue({ ...input, requestId: createSyncToken() })
        : operation === 'attempt' ? scoped.beginAttempt(input, input.requestId)
          : scoped.acknowledge(input, input.requestId, received(input.requestId))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    }
    expect(await outbox.get(input, input.requestId)).toMatchObject({ state: 'uncertain', attempts: 1 });
    const revoked: StoreDriver = { async query<T>(query: Parameters<StoreDriver['query']>[0]) {
      const rows = await driver.query<T>(query);
      if (query.sql.includes('LEFT JOIN unity_sync_outbox_receipts')) await accounts.setEnabled(input.accountId, false);
      return rows;
    }, batch: (statements) => driver.batch(statements) };
    await expect(createSyncOutboxStore(revoked).get(input, input.requestId)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(outbox.list(input)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await driver.query({ sql: 'SELECT * FROM unity_session_write_guards' })).toEqual([]);
  });

  it('[O05] failed batches roll back and a lost local acknowledgment response recovers the committed receipt', async () => {
    const faulty: StoreDriver = { query: (query) => driver.query(query), batch: (statements) => driver.batch([...statements, { sql: 'INSERT INTO nonexistent_table VALUES (1)' }]) };
    const outbox = createSyncOutboxStore(driver), failing = createSyncOutboxStore(faulty);
    await expect(failing.enqueue(input)).rejects.toThrow(); expect(await outbox.get(input, input.requestId)).toBeNull();
    await outbox.enqueue(input); await expect(failing.beginAttempt(input, input.requestId)).rejects.toThrow();
    expect(await outbox.get(input, input.requestId)).toMatchObject({ state: 'prepared', attempts: 0 });
    await outbox.beginAttempt(input, input.requestId); await expect(failing.acknowledge(input, input.requestId, received(input.requestId))).rejects.toThrow();
    expect(await outbox.get(input, input.requestId)).toMatchObject({ state: 'uncertain', receipt: null });
    const lost = createSyncOutboxStore({ query: (query) => driver.query(query), async batch(statements) {
      await driver.batch(statements); throw new Error('local response lost');
    } });
    await expect(lost.acknowledge(input, input.requestId, received(input.requestId))).rejects.toThrow('local response lost');
    await close(); await open();
    expect(await createSyncOutboxStore(driver).acknowledge(input, input.requestId, received(input.requestId))).toMatchObject({ state: 'acknowledged', receipt: received(input.requestId) });
  });

  it('[O06] upgrades populated v7 without changing history or data; failed migration leaves no outbox tables', async () => {
    await close(); await rm(directory, { recursive: true, force: true }); directory = await mkdtemp(join(tmpdir(), 'unity-outbox-v7-')); await open();
    await driver.batch([{ sql: 'CREATE TABLE unity_migrations(version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)' }]);
    for (const migration of migrations.filter((item) => item.version <= 7)) await driver.batch([
      ...migration.statements.map((sql) => ({ sql })), { sql: 'INSERT INTO unity_migrations VALUES (?, ?, ?, ?)', params: [migration.version, migration.name,
        createHash('sha256').update(JSON.stringify(migration.statements)).digest('hex'), new Date().toISOString()] },
    ]);
    await provision(true); const history = await driver.query({ sql: 'SELECT * FROM unity_migrations ORDER BY version' });
    const revision = await createStore(driver).getRevision(input.workspaceId, input.revisionId);
    const faulty: StoreDriver = { query: (query) => driver.query(query), batch: (statements) => driver.batch(statements.length > 1 ? [...statements, { sql: 'INSERT INTO nonexistent_table VALUES (1)' }] : statements) };
    await expect(migrate(faulty)).rejects.toThrow(); expect(await inspectSchema(driver)).toBe(7);
    expect(await driver.query({ sql: "SELECT name FROM sqlite_master WHERE name LIKE 'unity_sync_outbox%'" })).toEqual([]);
    await migrate(driver); await migrate(driver); expect(await inspectSchema(driver)).toBe(10);
    expect(await driver.query({ sql: 'SELECT * FROM unity_migrations WHERE version <= 7 ORDER BY version' })).toEqual(history);
    expect(await createStore(driver).getRevision(input.workspaceId, input.revisionId)).toEqual(revision);
    expect(await createSyncOutboxStore(driver).enqueue(input)).toMatchObject({ state: 'prepared' });
  });
});
