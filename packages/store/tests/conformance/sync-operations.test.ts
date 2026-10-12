import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSyncToken, signSyncHttp, verifySyncHttp } from '@character-foundry/character-foundry/sync';
import { createNodeDriver } from '../../src/node.js';
import { createD1Driver } from '../../src/d1.js';
import { createSyncStore } from '../../src/sync.js';
import type { SyncWriteContext } from '../../src/sync.js';
import { createAccountStore } from '../../src/accounts.js';
import { createStore } from '../../src/index.js';
import { createHubStore } from '../../src/hub.js';
import type { PublishInput } from '../../src/hub.js';
import { migrate, inspectSchema } from '../../src/migrations.js';
import { migrations } from '../../src/schema.js';
import type { StoreDriver } from '../../src/driver.js';

const actor = 'https://peer.example/actors/one';
const keyId = `${actor}#one`;
const policy = { visibility: 'public' as const, allowOriginal: false, allowFork: true };
for (const adapter of ['sqlite', 'd1']) describe(`sync-operations contract / ${adapter}`, () => {
  let directory: string; let driver: StoreDriver; let close: () => void | Promise<void>;
  let now: number; let accountId: string; let workspaceId: string; let key: CryptoKeyPair;
  async function open() {
    if (adapter === 'sqlite') {
      const db = new Database(join(directory, 'unity.db')); driver = createNodeDriver(db);
      db.pragma('journal_mode = WAL'); close = () => { db.close(); };
    } else {
      const mf = new Miniflare({ ...convertV4MiniflareOptions({ port: 0, workers: [{ name: 'receipt-test', modules: true,
        script: 'export default { fetch() { return new Response("test"); } };', compatibilityDate: '2026-10-11', d1Databases: ['DB'] }] }),
      resourcePersistencePath: join(directory, 'state') });
      driver = createD1Driver(await mf.getD1Database('DB')); close = () => mf.dispose();
    }
  }
  async function provision() {
    accountId = (await createAccountStore(driver).create('Local receiver')).account.id;
    workspaceId = (await createStore(driver).createWorkspace({ ownerId: accountId, name: 'Granted desk' })).id;
    const sync = createSyncStore(driver, () => now);
    await sync.grant({ actor, accountId, workspaceId, scopes: ['pull', 'publish', 'fork'] });
    key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']); await sync.addKey(actor, keyId, key.publicKey);
  }
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'unity-receipt-')); now = Date.now(); await open(); await migrate(driver); await provision(); });
  afterEach(async () => { await close?.(); if (directory) await rm(directory, { recursive: true, force: true }); });
  async function admitted(scope: 'publish' | 'fork', requestId = createSyncToken(), body = 'selected operation', signer = { actor, keyId, key }): Promise<SyncWriteContext> {
    const sync = createSyncStore(driver, () => now);
    const message = await signSyncHttp({ actor: signer.actor, keyId: signer.keyId, privateKey: signer.key.privateKey, requestId, method: 'POST',
      url: `https://receiver.example/sync/${scope}`, contentType: 'application/json', body: new TextEncoder().encode(JSON.stringify({ body })), created: Math.floor(now / 1000) });
    const claim = await verifySyncHttp(message, { now: Math.floor(now / 1000), resolveKey: (actor, id) => sync.resolveKey(actor, id, scope),
      consumeNonce: (claim) => sync.consumeNonce(claim, scope) });
    return { claim, clock: () => now };
  }
  async function selected(owner = accountId, workspace = workspaceId): Promise<PublishInput> {
    const value = await createStore(driver).createCard({ workspaceId: workspace, authorId: owner, originalHash: 'a'.repeat(64),
      document: { data: { name: 'Selected' } }, identity: { algorithm: 'test', hash: 'b'.repeat(64) } });
    return { workspaceId: workspace, revisionId: value.revision.id, document: value.revision.document,
      identity: value.revision.identity, originalHash: value.card.originalHash!, ...policy };
  }
  async function externalPublication() {
    const owner = (await createAccountStore(driver).create('Source owner')).account.id;
    const workspace = (await createStore(driver).createWorkspace({ ownerId: owner, name: 'Source desk' })).id;
    const source = await selected(owner, workspace);
    const [publication] = await createHubStore(driver).publish(owner, [source]);
    return { owner, source, publication: publication! };
  }
  function forkInput(value: Awaited<ReturnType<typeof externalPublication>>) {
    return { workspaceId, authorId: accountId, sourceWorkspaceId: value.source.workspaceId, sourceRevisionId: value.source.revisionId,
      document: { data: { name: 'Enriched fork' } }, identity: { algorithm: 'test', hash: 'c'.repeat(64) },
      publication: { publicationId: value.publication.id, actorId: accountId, policyVersion: value.publication.policyVersion } };
  }
  async function counts() {
    const [row] = await driver.query({ sql: `SELECT
      (SELECT COUNT(*) FROM unity_cards) AS cards, (SELECT COUNT(*) FROM unity_revisions) AS revisions,
      (SELECT COUNT(*) FROM unity_revision_seals) AS seals, (SELECT COUNT(*) FROM unity_publications) AS publications,
      (SELECT COUNT(*) FROM unity_publication_forks) AS forks, (SELECT COUNT(*) FROM unity_publication_ancestors) AS ancestors,
      (SELECT COUNT(*) FROM unity_card_sources) AS sources, (SELECT COUNT(*) FROM unity_revision_assets) AS assetReferences,
      (SELECT COUNT(*) FROM unity_sync_receipts) AS receipts, (SELECT COUNT(*) FROM unity_sync_write_guards) AS guards` });
    return row;
  }

  it('[R01] commits the selected subset and receipt once under concurrent retries and survives backend restart', async () => {
    const selectedRows = [await selected(), await selected()]; await selected();
    const first = await admitted('publish'); const retry = await admitted('publish', first.claim.requestId);
    let other = driver; let otherClose: (() => void) | undefined;
    if (adapter === 'sqlite') {
      const db = new Database(join(directory, 'unity.db')); other = createNodeDriver(db); otherClose = () => { db.close(); };
    }
    let published: string[];
    try {
      const [a, b] = await Promise.all([createHubStore(driver).publish(accountId, selectedRows, first), createHubStore(other).publish(accountId, selectedRows, retry)]);
      published = a.map((row) => row.id); expect(b.map((row) => row.id)).toEqual(published);
    } finally { otherClose?.(); }
    expect(await counts()).toMatchObject({ publications: 2, ancestors: 2, receipts: 1, guards: 0 });
    await close(); await open();
    expect((await createHubStore(driver).publish(accountId, selectedRows, await admitted('publish', first.claim.requestId))).map((row) => row.id)).toEqual(published);
    const [receipt] = await driver.query<{ result: string }>({ sql: 'SELECT result_json AS result FROM unity_sync_receipts' });
    expect(JSON.parse(receipt!.result)).toEqual(published);
    expect(await counts()).toMatchObject({ publications: 2, receipts: 1, guards: 0 });
  });

  it('[R02] recovers a committed write after a lost response and rejects ID reuse with changed bytes or operation kind', async () => {
    const rows = [await selected()]; const first = await admitted('publish');
    const lost: StoreDriver = { query: (query) => driver.query(query), async batch(statements) {
      await driver.batch(statements); throw new Error('injected response loss after commit');
    } };
    await expect(createHubStore(lost).publish(accountId, rows, first)).rejects.toThrow('response loss');
    expect(await counts()).toMatchObject({ publications: 1, receipts: 1, guards: 0 });
    const recovered = await createHubStore(driver).publish(accountId, rows, await admitted('publish', first.claim.requestId));
    expect(recovered).toHaveLength(1);
    await expect(createHubStore(driver).publish(accountId, rows, await admitted('publish', first.claim.requestId, 'changed bytes'))).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    const external = await externalPublication();
    await expect(createStore(driver).forkCard(forkInput(external), await admitted('fork', first.claim.requestId))).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    expect(await counts()).toMatchObject({ receipts: 1, forks: 0, guards: 0 });
  });

  it('[R03] rechecks peer, account, scope and key revocation in the write transaction and refuses workspace substitution', async () => {
    const rows = [await selected()]; const sync = createSyncStore(driver, () => now);
    const anotherWorkspace = (await createStore(driver).createWorkspace({ ownerId: accountId, name: 'Not granted' })).id;
    await expect(createHubStore(driver).publish(accountId, [await selected(accountId, anotherWorkspace)], await admitted('publish'))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    for (const change of ['peer', 'account', 'scope', 'key']) {
      const context = await admitted('publish');
      const before = await counts();
      const interrupted: StoreDriver = { query: (query) => driver.query(query), async batch(statements) {
        if (change === 'peer') await sync.setEnabled(actor, false);
        if (change === 'account') await createAccountStore(driver).setEnabled(accountId, false);
        if (change === 'scope') await sync.setScopes(actor, ['pull']);
        if (change === 'key') await sync.revokeKey(actor, keyId);
        return driver.batch(statements);
      } };
      await expect(createHubStore(interrupted).publish(accountId, rows, context)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      expect(await counts()).toEqual(before);
      if (change === 'peer') await sync.setEnabled(actor, true);
      if (change === 'account') await createAccountStore(driver).setEnabled(accountId, true);
      if (change === 'scope') await sync.setScopes(actor, ['pull', 'publish', 'fork']);
    }
  });

  it('[R04] rolls back receipts, guards and domain rows after failure at every publish and fork batch boundary', async () => {
    const external = await externalPublication(); const rows = [await selected(), await selected()];
    const sourceAsset = await createStore(driver).stageAsset({ workspaceId, hash: 'd'.repeat(64), byteLength: 10, mediaType: 'application/json' });
    await createStore(driver).completeAsset({ workspaceId, assetId: sourceAsset.id, measuredHash: sourceAsset.hash, measuredByteLength: 10 });
    const input = { ...forkInput(external), source: { assetId: sourceAsset.id, provenance: { kind: 'test' } }, assets: [{ path: 'portrait.json', assetId: sourceAsset.id }] };
    for (const kind of ['publish', 'fork'] as const) {
      const context = await admitted(kind); const before = await counts();
      let length = 1;
      for (let failure = 0; failure <= length; failure++) {
        const faulty: StoreDriver = { query: (query) => driver.query(query), batch(statements) {
          length = statements.length;
          const broken = [...statements]; broken.splice(failure, 0, { sql: 'INSERT INTO nonexistent_table VALUES (1)' });
          return driver.batch(broken);
        } };
        await expect(kind === 'publish' ? createHubStore(faulty).publish(accountId, rows, context) : createStore(faulty).forkCard(input, context)).rejects.toThrow();
        expect(await counts()).toEqual(before);
      }
    }
    expect((await createStore(driver).getAsset(workspaceId, sourceAsset.id)).state).toBe('ready');
  });

  it('[R05] forks once under concurrent requests and retains the committed revision, source and asset references on retry', async () => {
    const external = await externalPublication();
    const asset = await createStore(driver).stageAsset({ workspaceId, hash: 'e'.repeat(64), byteLength: 5, mediaType: 'application/json' });
    await createStore(driver).completeAsset({ workspaceId, assetId: asset.id, measuredHash: asset.hash, measuredByteLength: 5 });
    const input = { ...forkInput(external), source: { assetId: asset.id, provenance: { publicationId: external.publication.id } }, assets: [{ path: 'one.json', assetId: asset.id }] };
    const first = await admitted('fork'); const retry = await admitted('fork', first.claim.requestId);
    const [a, b] = await Promise.all([createStore(driver).forkCard(input, first), createStore(driver).forkCard(input, retry)]);
    expect(a).toEqual(b); expect(a.card.originalHash).toBe(external.source.originalHash);
    expect(a.revision.parentRevisionId).toBe(external.source.revisionId);
    expect(a.revision.assets).toEqual(input.assets);
    expect((await createStore(driver).getSource(workspaceId, a.card.id))?.assetId).toBe(asset.id);
    expect(await counts()).toMatchObject({ forks: 1, cards: 2, revisions: 2, receipts: 1, sources: 1, assetReferences: 1, guards: 0 });
    await close(); await open();
    expect(await createStore(driver).forkCard(input, await admitted('fork', first.claim.requestId))).toEqual(a);
  });

  it('[R06] checks source policies at fork commit and reauthorizes both fork and descendant publication receipts', async () => {
    const external = await externalPublication(); const input = forkInput(external); const context = await admitted('fork');
    const interrupted: StoreDriver = { query: (query) => driver.query(query), async batch(statements) {
      await createHubStore(driver).updatePolicy(external.owner, external.publication.id, 1, { ...policy, allowFork: false });
      return driver.batch(statements);
    } };
    const before = await counts();
    await expect(createStore(interrupted).forkCard(input, context)).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
    expect(await counts()).toEqual(before);
    await createHubStore(driver).updatePolicy(external.owner, external.publication.id, 2, policy);
    input.publication.policyVersion = 3;
    const fork = await createStore(driver).forkCard(input, await admitted('fork', context.claim.requestId));
    const publishRows = [{ ...policy, workspaceId, revisionId: fork.revision.id, document: fork.revision.document, identity: fork.revision.identity, originalHash: fork.card.originalHash! }];
    const publishContext = await admitted('publish');
    const hiddenDuringPublish: StoreDriver = { query: (query) => driver.query(query), async batch(statements) {
      await createHubStore(driver).updatePolicy(external.owner, external.publication.id, 3, { ...policy, visibility: 'private' });
      return driver.batch(statements);
    } };
    await expect(createHubStore(hiddenDuringPublish).publish(accountId, publishRows, publishContext)).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
    expect(await counts()).toMatchObject({ publications: 1, receipts: 1, guards: 0 });
    await createHubStore(driver).updatePolicy(external.owner, external.publication.id, 4, policy);
    await createHubStore(driver).publish(accountId, publishRows, publishContext);
    await createHubStore(driver).updatePolicy(external.owner, external.publication.id, 5, { ...policy, visibility: 'private' });
    await expect(createStore(driver).forkCard(input, await admitted('fork', context.claim.requestId))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(createHubStore(driver).publish(accountId, publishRows, await admitted('publish', publishContext.claim.requestId))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await counts()).toMatchObject({ forks: 1, receipts: 2, guards: 0 });
  });

  it('[R07] rejects expired, unadmitted or substituted claims and keeps receipts after nonce cleanup and revocation', async () => {
    const rows = [await selected()]; const first = await admitted('publish');
    for (const changed of [{ nonce: createSyncToken() }, { requestId: createSyncToken() }, { requestHash: 'f'.repeat(64) }, { retainUntil: first.claim.retainUntil + 1 }]) {
      await expect(createHubStore(driver).publish(accountId, rows, { ...first, claim: { ...first.claim, ...changed } })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    }
    const result = await createHubStore(driver).publish(accountId, rows, first);
    now += 400_000;
    await createSyncStore(driver, () => now).pruneNonces();
    await expect(createHubStore(driver).publish(accountId, rows, first)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await driver.query({ sql: 'SELECT * FROM unity_sync_nonces' })).toEqual([]);
    expect((await createHubStore(driver).publish(accountId, rows, await admitted('publish', first.claim.requestId))).map((row) => row.id)).toEqual(result.map((row) => row.id));
    const fresh = await admitted('publish', first.claim.requestId);
    const duringRead: StoreDriver = { batch: (statements) => driver.batch(statements), async query<T>(statement: Parameters<StoreDriver['query']>[0]) {
      const result = await driver.query<T>(statement);
      if (statement.sql.includes('FROM unity_sync_receipts')) await createSyncStore(driver).setEnabled(actor, false);
      return result;
    } };
    await expect(createHubStore(duringRead).publish(accountId, rows, fresh)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await counts()).toMatchObject({ receipts: 1, publications: 1, guards: 0 });
    await expect(driver.batch([{ sql: "UPDATE unity_sync_receipts SET result_json = '[]'" }])).rejects.toThrow();
    await expect(driver.batch([{ sql: 'DELETE FROM unity_sync_receipts' }])).rejects.toThrow();
  });

  it('[R09] preserves operation identity through key rotation and isolates identical IDs belonging to different actors', async () => {
    const rows = [await selected()]; const first = await admitted('publish');
    const result = await createHubStore(driver).publish(accountId, rows, first);
    const sync = createSyncStore(driver, () => now);
    const rotated = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    await sync.addKey(actor, `${actor}#two`, rotated.publicKey); await sync.revokeKey(actor, keyId);
    await expect(createHubStore(driver).publish(accountId, rows, first)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const next = await admitted('publish', first.claim.requestId, 'selected operation', { actor, keyId: `${actor}#two`, key: rotated });
    expect(next.claim.requestHash).toBe(first.claim.requestHash);
    expect((await createHubStore(driver).publish(accountId, rows, next)).map((row) => row.id)).toEqual(result.map((row) => row.id));
    const otherAccount = (await createAccountStore(driver).create('Independent peer')).account.id;
    const otherWorkspace = (await createStore(driver).createWorkspace({ ownerId: otherAccount, name: 'Independent desk' })).id;
    const otherActor = 'https://peer.example/actors/two';
    await sync.grant({ actor: otherActor, accountId: otherAccount, workspaceId: otherWorkspace, scopes: ['publish'] });
    await sync.addKey(otherActor, `${otherActor}#one`, rotated.publicKey);
    const other = await admitted('publish', first.claim.requestId, 'selected operation', { actor: otherActor, keyId: `${otherActor}#one`, key: rotated });
    const otherResult = await createHubStore(driver).publish(otherAccount, [await selected(otherAccount, otherWorkspace)], other);
    expect(otherResult[0]!.id).not.toBe(result[0]!.id);
    await expect(createHubStore(driver).publish(accountId, rows, other)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await counts()).toMatchObject({ receipts: 2, publications: 2, guards: 0 });
  });

  it('[R08] upgrades populated v6 grants and nonces atomically while preserving all previous migration checksums', async () => {
    await close(); await rm(directory, { recursive: true, force: true }); directory = await mkdtemp(join(tmpdir(), 'unity-receipt-v6-')); await open();
    await driver.batch([{ sql: 'CREATE TABLE unity_migrations(version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)' }]);
    for (const migration of migrations.filter((item) => item.version <= 6)) await driver.batch([
      ...migration.statements.map((sql) => ({ sql })), { sql: 'INSERT INTO unity_migrations VALUES (?, ?, ?, ?)', params: [migration.version, migration.name,
        createHash('sha256').update(JSON.stringify(migration.statements)).digest('hex'), new Date(now).toISOString()] },
    ]);
    await provision(); const context = await admitted('publish'); const rows = [await selected()];
    const before = await driver.query({ sql: 'SELECT * FROM unity_migrations ORDER BY version' });
    const nonces = await driver.query({ sql: 'SELECT * FROM unity_sync_nonces' });
    const faulty: StoreDriver = { query: (query) => driver.query(query), batch: (statements) => driver.batch(statements.length > 1 ? [...statements, { sql: 'INSERT INTO nonexistent_table VALUES (1)' }] : statements) };
    await expect(migrate(faulty)).rejects.toThrow(); expect(await inspectSchema(driver)).toBe(6);
    expect(await driver.query({ sql: "SELECT name FROM sqlite_master WHERE name IN ('unity_sync_receipts', 'unity_sync_write_guards')" })).toEqual([]);
    await migrate(driver); await migrate(driver); expect(await inspectSchema(driver)).toBe(11);
    expect(await driver.query({ sql: 'SELECT * FROM unity_migrations WHERE version <= 6 ORDER BY version' })).toEqual(before);
    expect(await driver.query({ sql: 'SELECT * FROM unity_sync_nonces' })).toEqual(nonces);
    expect(await createHubStore(driver).publish(accountId, rows, context)).toHaveLength(1);
  });
});
