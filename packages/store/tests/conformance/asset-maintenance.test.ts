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
import { createAccountStore } from '../../src/accounts.js';
import { createStore } from '../../src/index.js';
import { createAssetMaintenanceStore } from '../../src/asset-maintenance.js';
import { createSyncOutboxStore } from '../../src/sync-outbox.js';
import { createHubStore } from '../../src/hub.js';
import { migrate, inspectSchema, schemaVersion } from '../../src/migrations.js';
import { migrations } from '../../src/schema.js';
import type { StoreDriver } from '../../src/driver.js';
import type { Asset } from '../../src/types.js';

const clock = { now: () => new Date('2100-01-03T00:00:00.000Z') }, cutoff = '2100-01-01T00:00:00.000Z';
const actor = 'https://sender.example/actors/alice';
for (const adapter of ['sqlite', 'd1']) describe(`asset-maintenance contract / ${adapter}`, () => {
  let directory: string, driver: StoreDriver, close: () => void | Promise<void>, workspaceId: string, accountId: string;
  async function open() {
    if (adapter === 'sqlite') {
      const db = new Database(join(directory, 'unity.db')); driver = createNodeDriver(db); close = () => { db.close(); };
    } else {
      const mf = new Miniflare({ ...convertV4MiniflareOptions({ port: 0, workers: [{ name: 'maintenance-test', modules: true,
        script: 'export default { fetch() { return new Response("test"); } };', compatibilityDate: '2026-10-11', d1Databases: ['DB'] }] }),
      resourcePersistencePath: join(directory, 'state') });
      driver = createD1Driver(await mf.getD1Database('DB')); close = () => mf.dispose();
    }
  }
  async function provision() {
    accountId = (await createAccountStore(driver).create('Alice', { actorUri: actor })).account.id;
    workspaceId = (await createStore(driver).createWorkspace({ ownerId: accountId, name: 'Desk' })).id;
  }
  const maintenance = () => createAssetMaintenanceStore(driver, clock);
  const input = () => ({ workspaceId, authorId: accountId, document: { name: 'Fixture' }, identity: { algorithm: 'test', hash: 'a'.repeat(64) } });
  async function asset(ready = true) {
    const store = createStore(driver), result = await store.stageAsset({ workspaceId, hash: 'b'.repeat(64), byteLength: 10, mediaType: 'application/octet-stream' });
    return ready ? store.completeAsset({ workspaceId, assetId: result.id, measuredHash: result.hash, measuredByteLength: result.byteLength }) : result;
  }
  async function job(frame: Asset) {
    const card = await createStore(driver).createCard(input());
    return { accountId, workspaceId, requestId: createSyncToken(), actor, baseUrl: 'https://hub.example/api/sync/v1', publicationId: 'parent',
      cardId: card.card.id, revisionId: card.revision.id, assetId: frame.id, frameHash: frame.hash, byteLength: frame.byteLength };
  }
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'unity-maintenance-')); await open(); await migrate(driver); await provision(); });
  afterEach(async () => { await close?.(); await rm(directory, { recursive: true, force: true }); });

  it('[M01] previews old unused staged and ready assets without writes, with stable pagination and a minimum age', async () => {
    const assets = [await asset(), await asset(false), await asset()];
    expect(await createAssetMaintenanceStore(driver).preview(new Date(Date.now() - 172800000).toISOString())).toEqual([]);
    for (const before of ['2100-01-02T00:00:00Z', '2100-01-02T23:00:00.000Z', 'bad']) {
      await expect(maintenance().preview(before)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    const first = await maintenance().preview(cutoff, { limit: 1 });
    const rest = await maintenance().preview(cutoff, { afterId: first[0]!.id });
    expect([...first, ...rest].map((value) => value.id)).toEqual(assets.map((value) => value.id).sort());
    expect(await maintenance().retired()).toEqual([]);
    for (const value of assets) expect(await createStore(driver).getAsset(workspaceId, value.id)).toEqual(value);
  });

  it('[M02] protects historical revisions, original sources and acknowledged outbox frames, including direct SQL retirement', async () => {
    const store = createStore(driver), historical = await asset(), source = await asset(), frame = await asset();
    const card = await store.createCard({ ...input(), assets: [{ path: 'portrait', assetId: historical.id }], source: { assetId: source.id, provenance: { kind: 'fixture' } } });
    await store.saveRevision({ ...input(), cardId: card.card.id, expectedHead: card.revision.id, assets: [] });
    const command = await job(frame), outbox = createSyncOutboxStore(driver);
    await outbox.enqueue(command); await outbox.beginAttempt(command, command.requestId);
    await outbox.acknowledge(command, command.requestId, { version: SYNC_COMMAND_VERSION, operation: 'forks.submit', requestId: command.requestId, cardId: 'remote', revisionId: 'received' });
    expect(await maintenance().preview(cutoff)).toEqual([]);
    for (const value of [historical, source, frame]) {
      await expect(maintenance().retire([value.id], cutoff)).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
      await expect(driver.batch([{ sql: 'INSERT INTO unity_asset_retirements VALUES (?, ?, ?)', params: [value.id, cutoff, clock.now().toISOString()] }])).rejects.toThrow('UNITY_ASSET_IN_USE');
    }
    expect(await store.getRevision(workspaceId, card.revision.id)).toEqual(card.revision);
  });

  it('[M03] fences completion and all new references, rolling back a card with a retired asset', async () => {
    const store = createStore(driver), ready = await asset(), staged = await asset(false), command = await job(ready);
    await maintenance().retire([ready.id, staged.id], cutoff);
    const cards = await store.listCards(workspaceId);
    for (const value of [ready, staged]) {
      await expect(store.getAsset(workspaceId, value.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(store.completeAsset({ workspaceId, assetId: value.id, measuredHash: value.hash, measuredByteLength: value.byteLength })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(driver.batch([{ sql: "UPDATE unity_assets SET state = 'ready' WHERE id = ?", params: [value.id] }])).rejects.toThrow('UNITY_ASSET_NOT_READY');
    }
    await expect(store.createCard({ ...input(), assets: [{ path: 'portrait', assetId: ready.id }] })).rejects.toMatchObject({ code: 'ASSET_NOT_READY' });
    await expect(store.createCard({ ...input(), source: { assetId: ready.id, provenance: {} } })).rejects.toMatchObject({ code: 'ASSET_NOT_READY' });
    await expect(createSyncOutboxStore(driver).enqueue(command)).rejects.toThrow('UNITY_ASSET_NOT_READY');
    expect(await store.listCards(workspaceId)).toEqual(cards);
    expect(await driver.query({ sql: 'SELECT * FROM unity_sync_outbox' })).toEqual([]);
  });

  it('[M04] serializes attachment against retirement so exactly one succeeds and a stale preview never authorizes deletion', async () => {
    for (const retireFirst of [true, false]) {
      const value = await asset(), store = createStore(driver);
      expect((await maintenance().preview(cutoff)).some((row) => row.id === value.id)).toBe(true);
      const attach = () => store.createCard({ ...input(), assets: [{ path: 'portrait', assetId: value.id }] });
      const retire = () => maintenance().retire([value.id], cutoff);
      const operations = retireFirst ? [retire, attach] : [attach, retire];
      const outcomes = await Promise.allSettled(operations.map((operation) => operation()));
      expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const refs = await driver.query({ sql: 'SELECT * FROM unity_revision_assets WHERE asset_id = ?', params: [value.id] });
      const retired = (await maintenance().retired()).some((row) => row.id === value.id);
      expect(Number(retired) + refs.length).toBe(1);
    }
  });

  it('[M05] retires exact selections atomically, survives lost responses and restart, and preserves immutable tombstones', async () => {
    const unused = await asset(), used = await asset();
    await createStore(driver).createCard({ ...input(), assets: [{ path: 'portrait', assetId: used.id }] });
    await expect(maintenance().retire([unused.id, used.id], cutoff)).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
    expect(await maintenance().retired()).toEqual([]);
    for (const ids of [[], [unused.id, unused.id], ['missing']]) await expect(maintenance().retire(ids, cutoff)).rejects.toThrow();
    const lost = createAssetMaintenanceStore({ query: (query) => driver.query(query), async batch(statements) {
      await driver.batch(statements); throw new Error('response lost');
    } }, clock);
    await expect(lost.retire([unused.id], cutoff)).rejects.toThrow('response lost');
    await close(); await open();
    expect(await maintenance().retire([unused.id], cutoff)).toEqual({ retired: [unused.id] });
    expect(await maintenance().retired()).toMatchObject([{ id: unused.id, storageKey: unused.storageKey }]);
    for (const table of ['unity_asset_lifetimes', 'unity_asset_retirements']) {
      await expect(driver.batch([{ sql: `DELETE FROM ${table} WHERE asset_id = ?`, params: [unused.id] }])).rejects.toThrow('UNITY_IMMUTABLE_ASSET');
      await expect(driver.batch([{ sql: `UPDATE ${table} SET asset_id = asset_id WHERE asset_id = ?`, params: [unused.id] }])).rejects.toThrow('UNITY_IMMUTABLE_ASSET');
    }
    await expect(driver.batch([{ sql: 'DELETE FROM unity_assets WHERE id = ?', params: [unused.id] }])).rejects.toThrow();
  });

  it('[M07] reclaims old deleted cards while preserving immutable revision and source provenance', async () => {
    const store = createStore(driver), historical = await asset(), source = await asset(), current = await asset();
    const card = await store.createCard({ ...input(), assets: [{ path: 'portrait', assetId: historical.id }],
      source: { assetId: source.id, provenance: { kind: 'fixture' } } });
    const head = await store.saveRevision({ ...input(), cardId: card.card.id, expectedHead: card.revision.id,
      assets: [{ path: 'portrait', assetId: current.id }] });
    await store.deleteCard(workspaceId, card.card.id);
    expect((await maintenance().preview(cutoff)).map((value) => value.id).sort())
      .toEqual([historical.id, source.id, current.id].sort());
    await maintenance().retire([historical.id, source.id, current.id], cutoff);
    expect(await store.getRevision(workspaceId, card.revision.id)).toEqual(card.revision);
    expect(await store.getRevision(workspaceId, head.id)).toEqual(head);
    await expect(store.getAsset(workspaceId, historical.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('[M08] retains source originals and all history through deleted intermediates to a live descendant fork', async () => {
    const store = createStore(driver), portrait = await asset(), source = await asset();
    const root = await store.createCard({ ...input(), assets: [{ path: 'portrait', assetId: portrait.id }],
      source: { assetId: source.id, provenance: { kind: 'fixture' } } });
    const child = await store.forkCard({ ...input(), sourceWorkspaceId: workspaceId, sourceRevisionId: root.revision.id });
    const descendant = await store.forkCard({ ...input(), sourceWorkspaceId: workspaceId, sourceRevisionId: child.revision.id });
    await store.deleteCard(workspaceId, root.card.id); await store.deleteCard(workspaceId, child.card.id);
    expect(await maintenance().preview(cutoff)).toEqual([]);
    await expect(maintenance().retire([portrait.id, source.id], cutoff)).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
    await store.deleteCard(workspaceId, descendant.card.id);
    expect((await maintenance().preview(cutoff)).map((value) => value.id).sort()).toEqual([portrait.id, source.id].sort());
  });

  it('[M13] retains deleted private publications and unacknowledged or failed durable sync jobs', async () => {
    const store = createStore(driver), portrait = await asset(), source = await asset(), originalHash = 'd'.repeat(64);
    const published = await store.createCard({ ...input(), originalHash, assets: [{ path: 'portrait', assetId: portrait.id }],
      source: { assetId: source.id, provenance: { kind: 'fixture' } } });
    const [publication] = await createHubStore(driver).publish(accountId, [{ workspaceId, revisionId: published.revision.id,
      document: published.revision.document, identity: published.revision.identity, originalHash,
      visibility: 'private', allowOriginal: false, allowFork: false }]);
    await store.deleteCard(workspaceId, published.card.id);
    for (const attempted of [false, true]) {
      const owned = await asset(), frame = await asset();
      const card = await store.createCard({ ...input(), assets: [{ path: 'portrait', assetId: owned.id }] });
      const command = { ...await job(frame), cardId: card.card.id, revisionId: card.revision.id }, outbox = createSyncOutboxStore(driver);
      await outbox.enqueue(command);
      if (attempted) await outbox.beginAttempt(command, command.requestId);
      await store.deleteCard(workspaceId, card.card.id);
      await expect(maintenance().retire([owned.id, frame.id], cutoff)).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
    }
    expect(await maintenance().preview(cutoff)).toEqual([]);
    expect(await createHubStore(driver).get(accountId, publication!.id)).toMatchObject({ id: publication!.id });
    await expect(maintenance().retire([portrait.id, source.id], cutoff)).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
  });

  it('[M09] grants deleted-card bytes the full age floor independently of asset age', async () => {
    const store = createStore(driver), value = await asset(), card = await store.createCard({ ...input(), assets: [{ path: 'portrait', assetId: value.id }] });
    await driver.batch([{ sql: 'INSERT INTO unity_card_deletions VALUES (?,?,?)', params: [card.card.id, workspaceId, '2100-01-02T00:00:00.000Z'] }]);
    expect(await maintenance().preview(cutoff)).toEqual([]);
    await expect(maintenance().retire([value.id], cutoff)).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
    const later = createAssetMaintenanceStore(driver, { now: () => new Date('2100-01-04T00:00:00.000Z') });
    expect(await later.preview('2100-01-02T00:00:00.000Z')).toMatchObject([{ id: value.id }]);
  });

  it('[M10] cannot resurrect retired deleted ancestry through publications, forks, outbox jobs or undelete', async () => {
    const store = createStore(driver), value = await asset(), frame = await asset(), originalHash = 'd'.repeat(64);
    const card = await store.createCard({ ...input(), originalHash, assets: [{ path: 'portrait', assetId: value.id }] });
    const command = { ...await job(frame), cardId: card.card.id, revisionId: card.revision.id };
    await store.deleteCard(workspaceId, card.card.id); await maintenance().retire([value.id], cutoff);
    await expect(createHubStore(driver).publish(accountId, [{ workspaceId, revisionId: card.revision.id, document: card.revision.document,
      identity: card.revision.identity, originalHash, visibility: 'public', allowOriginal: true, allowFork: true }])).rejects.toThrow();
    await expect(driver.batch([{ sql: 'INSERT INTO unity_cards(id,workspace_id,forked_from_revision_id,created_at) VALUES (?,?,?,?)',
      params: [crypto.randomUUID(), workspaceId, card.revision.id, clock.now().toISOString()] }])).rejects.toThrow();
    await expect(createSyncOutboxStore(driver).enqueue(command)).rejects.toThrow();
    await expect(driver.batch([{ sql: 'INSERT INTO unity_archive_assets(asset_id,workspace_id,archive_id,archive_card_id,archive_version_id,path) VALUES (?,?,?,?,?,?)',
      params: [value.id, workspaceId, 'archive', 'card', 'version', 'portrait.png'] }])).rejects.toThrow();
    await expect(driver.batch([{ sql: 'DELETE FROM unity_card_deletions WHERE card_id = ?', params: [card.card.id] }])).rejects.toThrow();
    await expect(driver.batch([{ sql: 'UPDATE unity_card_deletions SET deleted_at = ? WHERE card_id = ?', params: [clock.now().toISOString(), card.card.id] }])).rejects.toThrow();
  });

  it('[M11] serializes a new pinned publication against reclamation of its deleted card', async () => {
    for (const retireFirst of [true, false]) {
      const store = createStore(driver), value = await asset(), originalHash = 'e'.repeat(64);
      const card = await store.createCard({ ...input(), originalHash, assets: [{ path: 'portrait', assetId: value.id }] });
      await store.deleteCard(workspaceId, card.card.id);
      const publish = () => createHubStore(driver).publish(accountId, [{ workspaceId, revisionId: card.revision.id,
        document: card.revision.document, identity: card.revision.identity, originalHash, visibility: 'members', allowOriginal: true, allowFork: false }]);
      const retire = () => maintenance().retire([value.id], cutoff);
      const outcomes = await Promise.allSettled((retireFirst ? [retire, publish] : [publish, retire]).map((operation) => operation()));
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect((await maintenance().retired()).some((row) => row.id === value.id)).toBe(retireFirst);
    }
  });

  it('[M06] upgrades populated v8 conservatively and rolls back failed migration DDL and history together', async () => {
    await close(); await rm(directory, { recursive: true, force: true }); directory = await mkdtemp(join(tmpdir(), 'unity-maintenance-v8-')); await open();
    await driver.batch([{ sql: 'CREATE TABLE unity_migrations(version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)' }]);
    for (const migration of migrations.filter((item) => item.version <= 8)) await driver.batch([
      ...migration.statements.map((sql) => ({ sql })), { sql: 'INSERT INTO unity_migrations VALUES (?, ?, ?, ?)', params: [migration.version, migration.name,
        createHash('sha256').update(JSON.stringify(migration.statements)).digest('hex'), new Date().toISOString()] },
    ]);
    await provision(); const staged = await asset(false);
    const history = await driver.query({ sql: 'SELECT * FROM unity_migrations ORDER BY version' });
    const faulty: StoreDriver = { query: (query) => driver.query(query), batch: (statements) => driver.batch(statements.length > 1 ? [...statements, { sql: 'INSERT INTO nonexistent_table VALUES (1)' }] : statements) };
    await expect(migrate(faulty)).rejects.toThrow(); expect(await inspectSchema(driver)).toBe(8);
    expect(await driver.query({ sql: "SELECT name FROM sqlite_master WHERE name IN ('unity_asset_lifetimes', 'unity_asset_retirements')" })).toEqual([]);
    const started = new Date().toISOString(); await migrate(driver); await migrate(driver); expect(await inspectSchema(driver)).toBe(schemaVersion);
    expect(await driver.query({ sql: 'SELECT * FROM unity_migrations WHERE version <= 8 ORDER BY version' })).toEqual(history);
    expect(await createStore(driver).getAsset(workspaceId, staged.id)).toEqual(staged);
    expect((await maintenance().preview(cutoff))[0]!.createdAt >= started).toBe(true);
    expect(await createAssetMaintenanceStore(driver).preview(new Date(Date.now() - 172800000).toISOString())).toEqual([]);
  });

  it('[M12] upgrades populated v13 without rewriting history and rolls retention DDL back on failure', async () => {
    await close(); await rm(directory, { recursive: true, force: true }); directory = await mkdtemp(join(tmpdir(), 'unity-maintenance-v13-')); await open();
    await driver.batch([{ sql: 'CREATE TABLE unity_migrations(version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)' }]);
    for (const migration of migrations.filter((item) => item.version <= 13)) await driver.batch([
      ...migration.statements.map((sql) => ({ sql })), { sql: 'INSERT INTO unity_migrations VALUES (?, ?, ?, ?)', params: [migration.version, migration.name,
        createHash('sha256').update(JSON.stringify(migration.statements)).digest('hex'), new Date().toISOString()] },
    ]);
    await provision();
    const store = createStore(driver), retained = await asset(), released = await asset();
    const parent = await store.createCard({ ...input(), assets: [{ path: 'portrait', assetId: retained.id }] });
    const child = await store.forkCard({ ...input(), sourceWorkspaceId: workspaceId, sourceRevisionId: parent.revision.id });
    const deleted = await store.createCard({ ...input(), assets: [{ path: 'portrait', assetId: released.id }] });
    await store.deleteCard(workspaceId, parent.card.id); await store.deleteCard(workspaceId, deleted.card.id);
    const history = await driver.query({ sql: 'SELECT * FROM unity_migrations ORDER BY version' });
    const faulty: StoreDriver = { query: (query) => driver.query(query), batch: (statements) => driver.batch(statements.length > 1 ? [...statements, { sql: 'INSERT INTO nonexistent_table VALUES (1)' }] : statements) };
    await expect(migrate(faulty)).rejects.toThrow(); expect(await inspectSchema(driver)).toBe(13);
    await expect(driver.batch([{ sql: 'INSERT INTO unity_asset_retirements VALUES (?,?,?)', params: [released.id, cutoff, clock.now().toISOString()] }])).rejects.toThrow('UNITY_ASSET_IN_USE');
    await migrate(driver);
    expect(await driver.query({ sql: 'SELECT * FROM unity_migrations WHERE version <= 13 ORDER BY version' })).toEqual(history);
    expect(await store.getRevision(workspaceId, parent.revision.id)).toEqual(parent.revision);
    expect(await store.getRevision(workspaceId, child.revision.id)).toEqual(child.revision);
    expect(await store.getRevision(workspaceId, deleted.revision.id)).toEqual(deleted.revision);
    expect(await maintenance().preview(cutoff)).toMatchObject([{ id: released.id }]);
    await maintenance().retire([released.id], cutoff);
    await expect(maintenance().retire([retained.id], cutoff)).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
  });
});
