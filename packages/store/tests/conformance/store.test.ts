import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createStore, StoreError } from '../../src/index.js';
import type { CardDocument, RevisionInput, UnityStore } from '../../src/index.js';
import { createNodeDriver } from '../../src/node.js';
import { createD1Driver } from '../../src/d1.js';
import { inspectSchema, migrate } from '../../src/migrations.js';
import { migrations } from '../../src/schema.js';
import type { StoreDriver } from '../../src/driver.js';

// Synthetic JSON and digests exercise persistence only. These are not Foundry canonical vectors.
const document: CardDocument = { spec: 'chara_card_v2', data: { name: 'Aster', description: 'A keeper of maps.', extensions: { foreign: { nested: ['keep', 7, null] } } } };
const input: RevisionInput = { authorId: 'alice', document, identity: { algorithm: 'test-fixture-v1', hash: 'a'.repeat(64) } };
const originalHash = 'b'.repeat(64);

interface Fixture { driver: StoreDriver; close(): void | Promise<void> }
const factories: Record<string, () => Promise<Fixture>> = {
  sqlite: async () => {
    const db = new Database(':memory:');
    return { driver: createNodeDriver(db), close: () => { db.close(); } };
  },
  d1: async () => {
    const mf = new Miniflare(convertV4MiniflareOptions({ port: 0, workers: [{ name: 'store-test', modules: true,
      script: 'export default { fetch() { return new Response("test"); } };',
      compatibilityDate: '2026-10-11', d1Databases: ['DB'] }] }));
    const db = await mf.getD1Database('DB');
    return { driver: createD1Driver(db), close: () => mf.dispose() };
  },
};

for (const [adapter, createFixture] of Object.entries(factories)) {
  describe(`store contract / ${adapter}`, () => {
    let fixture: Fixture;
    let store: UnityStore;
    let workspaceId: string;
    let failAfter: number | undefined;
    let faultDriver: StoreDriver;
    beforeEach(async () => {
      fixture = await createFixture();
      await migrate(fixture.driver);
      failAfter = undefined;
      faultDriver = {
        query: (query) => fixture.driver.query(query),
        batch: (statements) => {
          const modified = [...statements];
          if (failAfter !== undefined) modified.splice(failAfter, 0, {
            sql: "INSERT INTO unity_workspaces(id, owner_id, name, created_at) VALUES (NULL, 'injected', 'injected', 'injected')",
          });
          return fixture.driver.batch(modified);
        },
      };
      store = createStore(faultDriver);
      workspaceId = (await store.createWorkspace({ ownerId: 'alice', name: 'Desk' })).id;
    });
    afterEach(async () => { await fixture?.close(); });

    async function readyAsset() {
      const asset = await store.stageAsset({ workspaceId, hash: 'c'.repeat(64), byteLength: 17, mediaType: 'image/png' });
      return store.completeAsset({ workspaceId, assetId: asset.id, measuredHash: asset.hash, measuredByteLength: asset.byteLength });
    }
    async function counts() {
      const tables = ['cards', 'revisions', 'revision_assets', 'revision_seals', 'card_sources'];
      return Promise.all(tables.map(async (table) => fixture.driver.query({ sql: `SELECT COUNT(*) AS count FROM unity_${table}` })));
    }

    it('[S15] commits immutable source provenance with the card or rolls everything back', async () => {
      const asset = await readyAsset();
      const before = await counts();
      const source = { assetId: asset.id, provenance: { kind: 'archive', archiveId: 'fixture', cardId: 'a' } };
      for (failAfter = 0; failAfter <= 5; failAfter++) {
        await expect(store.createCard({ ...input, workspaceId, originalHash, source, assets: [{ path: 'portrait', assetId: asset.id }] })).rejects.toThrow();
        expect(await counts()).toEqual(before);
      }
      failAfter = undefined;
      const pending = store.createCard({ ...input, workspaceId, originalHash, source });
      source.provenance.cardId = 'mutated';
      const created = await pending;
      expect(await store.getSource(workspaceId, created.card.id)).toMatchObject({ assetId: asset.id, provenance: { cardId: 'a' } });
      const staged = await store.stageAsset({ workspaceId, hash: asset.hash, byteLength: 17, mediaType: 'image/png' });
      await expect(store.createCard({ ...input, workspaceId, source: { ...source, assetId: staged.id } })).rejects.toMatchObject({ code: 'ASSET_NOT_READY' });
      const foreign = await store.createWorkspace({ ownerId: 'bob', name: 'Other' });
      await expect(store.createCard({ ...input, workspaceId: foreign.id, source })).rejects.toMatchObject({ code: 'ASSET_NOT_READY' });
      await expect(store.getSource(foreign.id, created.card.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(fixture.driver.batch([{ sql: 'UPDATE unity_card_sources SET provenance_json = ? WHERE card_id = ?', params: ['{}', created.card.id] }])).rejects.toThrow();
      await expect(fixture.driver.batch([{ sql: 'DELETE FROM unity_card_sources WHERE card_id = ?', params: [created.card.id] }])).rejects.toThrow();
      const unsourced = await store.createCard({ ...input, workspaceId });
      await expect(fixture.driver.batch([{ sql: 'INSERT INTO unity_card_sources VALUES (?, ?, ?, ?)', params: [unsourced.card.id, workspaceId, asset.id, '{}'] }])).rejects.toThrow();
    });

    it('[S16] upgrades a populated v1 database without rewriting revisions or inventing source bytes', async () => {
      const old = await createFixture();
      try {
        const migration = migrations[0];
        await old.driver.batch([
          { sql: 'CREATE TABLE unity_migrations(version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)' },
          ...migration.statements.map((sql) => ({ sql })),
          { sql: 'INSERT INTO unity_migrations VALUES (1, ?, ?, ?)', params: [migration.name, createHash('sha256').update(JSON.stringify(migration.statements)).digest('hex'), '2026-10-11T00:00:00.000Z'] },
        ]);
        const legacy = createStore(old.driver);
        const workspace = await legacy.createWorkspace({ ownerId: 'alice', name: 'Existing' });
        const card = await legacy.createCard({ ...input, workspaceId: workspace.id, originalHash });
        expect(await inspectSchema(old.driver)).toBe(1);
        await migrate(old.driver);
        expect(await inspectSchema(old.driver)).toBe(10);
        expect(await legacy.getRevision(workspace.id, card.revision.id)).toEqual(card.revision);
        expect(await legacy.getCard(workspace.id, card.card.id)).toEqual(card.card);
        expect(await legacy.getSource(workspace.id, card.card.id)).toBeNull();
      } finally { await old.close(); }
    });

    it('[S01] applies versioned migrations idempotently and rejects drift or future history', async () => {
      await migrate(fixture.driver);
      expect(await inspectSchema(fixture.driver)).toBe(10);
      expect(await store.readiness()).toEqual({ schemaVersion: 10 });
      await fixture.driver.batch([{ sql: "UPDATE unity_migrations SET checksum = 'changed' WHERE version = 1" }]);
      await expect(migrate(fixture.driver)).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' });
      await fixture.driver.batch([{ sql: 'UPDATE unity_migrations SET version = 99 WHERE version = 1' }]);
      await expect(migrate(fixture.driver)).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' });
    });

    it('[S02] refuses a foreign database without creating Unity tables', async () => {
      const other = await createFixture();
      try {
        await other.driver.batch([{ sql: 'CREATE TABLE archived_originals(id TEXT)' }]);
        await expect(migrate(other.driver)).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' });
        const tables = await other.driver.query({ sql: "SELECT name FROM sqlite_master WHERE name GLOB 'unity_*'" });
        expect(tables).toEqual([]);
      } finally { await other.close(); }
    });

    it('[S03] preserves full JSON and snapshots caller values before asynchronous writes', async () => {
      const draft = structuredClone(input);
      const saving = store.createCard({ ...draft, workspaceId, originalHash });
      draft.document.data = 'mutated after save began';
      draft.identity.hash = 'd'.repeat(64);
      const result = await saving;
      expect(result.revision.document).toEqual(document);
      expect(result.revision.identity).toEqual(input.identity);
      expect(result.card.originalHash).toBe(originalHash);
      expect(result.revision.parentRevisionId).toBeNull();
      expect(result.revision.sequence).toBe(1);
      result.revision.document.data = 'changed returned snapshot';
      expect((await store.getRevision(workspaceId, result.revision.id)).document).toEqual(document);
    });

    it('[S04] rolls back card, revision, head and assets after failure at every create step', async () => {
      const asset = await readyAsset();
      const before = await counts();
      for (const step of [1, 2, 3, 4]) {
        failAfter = step;
        await expect(store.createCard({ ...input, workspaceId, assets: [{ path: 'portrait.png', assetId: asset.id }] })).rejects.toThrow();
        expect(await counts()).toEqual(before);
        expect(await store.listCards(workspaceId)).toEqual([]);
      }
    });

    it('[S05] rolls back a save after each statement including final sealing', async () => {
      const base = await store.createCard({ ...input, workspaceId });
      const asset = await readyAsset();
      const before = await counts();
      for (const step of [1, 2, 3]) {
        failAfter = step;
        await expect(store.saveRevision({ ...input, workspaceId, cardId: base.card.id,
          expectedHead: base.revision.id, assets: [{ path: 'portrait.png', assetId: asset.id }] })).rejects.toThrow();
        expect(await counts()).toEqual(before);
        expect((await store.getCard(workspaceId, base.card.id)).headRevisionId).toBe(base.revision.id);
      }
    });

    it('[S06] admits exactly one concurrent save for the same expected head', async () => {
      const base = await store.createCard({ ...input, workspaceId });
      const save = () => store.saveRevision({ ...input, workspaceId, cardId: base.card.id, expectedHead: base.revision.id });
      const outcomes = await Promise.allSettled([save(), save()]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const failure = outcomes.find((outcome) => outcome.status === 'rejected');
      expect(failure?.status === 'rejected' && failure.reason).toMatchObject({ code: 'HEAD_CONFLICT' });
      const revisions = await store.listRevisions(workspaceId, base.card.id);
      expect(revisions.map((item) => item.sequence)).toEqual([1, 2]);
      expect((await store.getCard(workspaceId, base.card.id)).headRevisionId).toBe(revisions[1]?.id);
      await expect(save()).rejects.toMatchObject({ code: 'HEAD_CONFLICT' });
      expect(await store.listRevisions(workspaceId, base.card.id)).toHaveLength(2);
    });

    it('[S07] forks preserve root provenance and parents without deduplicating equal-content revisions', async () => {
      const base = await store.createCard({ ...input, workspaceId, originalHash });
      const target = (await store.createWorkspace({ ownerId: 'bob', name: 'Other desk' })).id;
      const fork = await store.forkCard({ ...input, authorId: 'bob', workspaceId: target, sourceWorkspaceId: workspaceId, sourceRevisionId: base.revision.id });
      expect(fork.card.originalHash).toBe(originalHash);
      expect(fork.card.forkedFromRevisionId).toBe(base.revision.id);
      expect(fork.revision.parentRevisionId).toBe(base.revision.id);
      expect(fork.revision.identity).toEqual(base.revision.identity);
      expect(fork.revision.id).not.toBe(base.revision.id);
      expect(fork.revision.sequence).toBe(1);
      expect(await store.listForks(target, base.revision.id)).toEqual([fork.card]);
      expect((await store.getCard(workspaceId, base.card.id)).headRevisionId).toBe(base.revision.id);
      const grandchild = await store.forkCard({ ...input, workspaceId: target, sourceWorkspaceId: target, sourceRevisionId: fork.revision.id });
      expect(grandchild.card.originalHash).toBe(originalHash);
      expect(grandchild.revision.parentRevisionId).toBe(fork.revision.id);
    });

    it('[S17] lists library summaries newest-touched first with filters, totals and fork counts', async () => {
      const doc = (name: string, creator: string, tags: string[]): CardDocument => ({ spec: 'chara_card_v2', data: { name, creator, tags } });
      const a = await store.createCard({ ...input, workspaceId, document: doc('Aster 50%', 'Mapmaker', ['Fantasy', 'Guide']) });
      const b = await store.createCard({ ...input, workspaceId, document: doc('Briar', 'Gardener', ['fantasy']) });
      await store.createCard({ ...input, workspaceId, document: doc('Cinder', 'Smith', ['SciFi']) });
      await store.saveRevision({ ...input, workspaceId, cardId: a.card.id, expectedHead: a.revision.id, document: doc('Aster 50%', 'Mapmaker', ['Fantasy', 'Guide']) });
      await store.forkCard({ ...input, workspaceId, sourceWorkspaceId: workspaceId, sourceRevisionId: b.revision.id });
      const all = await store.listCardSummaries(workspaceId);
      expect(all.total).toBe(4);
      const touched = all.items.map((item) => item.revision.createdAt);
      expect(touched).toEqual([...touched].sort().reverse());
      expect(all.items.find((item) => item.card.id === a.card.id)!.revision.sequence).toBe(2);
      expect(all.items.find((item) => item.card.id === b.card.id)!.forkCount).toBe(1);
      const tagged = await store.listCardSummaries(workspaceId, { tag: 'FANTASY' });
      expect(tagged.total).toBe(2);
      expect((await store.listCardSummaries(workspaceId, { q: 'gard' })).items.map((item) => item.card.id)).toEqual([b.card.id]);
      expect((await store.listCardSummaries(workspaceId, { q: '50%' })).total).toBe(1);
      expect((await store.listCardSummaries(workspaceId, { q: '_' })).total).toBe(0);
      const page = await store.listCardSummaries(workspaceId, { limit: 2, offset: 2 });
      expect(page).toMatchObject({ total: 4 });
      expect(page.items.map((item) => item.card.id)).toEqual(all.items.slice(2).map((item) => item.card.id));
    });

    it('[S08] scopes reads, saves and asset references to their workspace', async () => {
      const base = await store.createCard({ ...input, workspaceId });
      const asset = await readyAsset();
      const target = (await store.createWorkspace({ ownerId: 'bob', name: 'Other desk' })).id;
      await expect(store.getCard(target, base.card.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(store.getRevision(target, base.revision.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(store.getAsset(target, asset.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(store.saveRevision({ ...input, workspaceId: target, cardId: base.card.id, expectedHead: base.revision.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(store.createCard({ ...input, workspaceId: target, assets: [{ path: 'portrait.png', assetId: asset.id }] })).rejects.toMatchObject({ code: 'ASSET_NOT_READY' });
      expect(await store.listCards(target)).toEqual([]);
      expect(await store.listRevisions(target, base.card.id)).toEqual([]);
    });

    it('[S09] prevents rewriting, deleting or adding to committed revision snapshots', async () => {
      const asset = await readyAsset();
      const base = await store.createCard({ ...input, workspaceId, assets: [{ path: 'portrait.png', assetId: asset.id }] });
      for (const sql of [
        "UPDATE unity_revisions SET document_json = '{}'",
        'DELETE FROM unity_revisions',
        "UPDATE unity_revision_assets SET path = 'changed.png'",
        'DELETE FROM unity_revision_assets',
        'DELETE FROM unity_revision_seals',
        "UPDATE unity_assets SET content_hash = 'tampered'",
        "UPDATE unity_cards SET original_hash = 'tampered'",
        'UPDATE unity_cards SET head_revision_id = NULL',
      ]) await expect(fixture.driver.batch([{ sql }])).rejects.toThrow();
      await expect(fixture.driver.batch([{ sql: 'INSERT INTO unity_revision_assets VALUES (?, ?, ?, ?)',
        params: [base.revision.id, workspaceId, 'extra.png', asset.id] }])).rejects.toThrow();
      expect(await store.getRevision(workspaceId, base.revision.id)).toEqual(base.revision);
    });

    it('[S10] attaches only complete assets and refuses mismatched upload measurements', async () => {
      const asset = await store.stageAsset({ workspaceId, hash: 'c'.repeat(64), byteLength: 17, mediaType: 'image/png' });
      const create = () => store.createCard({ ...input, workspaceId, assets: [{ path: 'portrait.png', assetId: asset.id }] });
      await expect(create()).rejects.toMatchObject({ code: 'ASSET_NOT_READY' });
      await expect(store.completeAsset({ workspaceId, assetId: asset.id, measuredHash: asset.hash, measuredByteLength: 18 })).rejects.toMatchObject({ code: 'INTEGRITY' });
      await expect(store.completeAsset({ workspaceId, assetId: asset.id, measuredHash: 'd'.repeat(64), measuredByteLength: 17 })).rejects.toMatchObject({ code: 'INTEGRITY' });
      expect((await store.getAsset(workspaceId, asset.id)).state).toBe('staged');
      const completed = await store.completeAsset({ workspaceId, assetId: asset.id, measuredHash: asset.hash, measuredByteLength: 17 });
      expect(completed.state).toBe('ready');
      expect((await create()).revision.assets).toEqual([{ path: 'portrait.png', assetId: asset.id }]);
      expect(await store.completeAsset({ workspaceId, assetId: asset.id, measuredHash: asset.hash, measuredByteLength: 17 })).toEqual(completed);
    });

    it('[S11] bounds payloads and rejects values that JSON would silently change', async () => {
      const invalidDocuments = [
        { data: Number.NaN }, { data: Number.POSITIVE_INFINITY }, { data: 'x'.repeat(262_145) },
      ];
      for (const document of invalidDocuments) {
        await expect(store.createCard({ ...input, workspaceId, document })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      }
      const cyclic: CardDocument = {}; cyclic.self = cyclic;
      await expect(store.createCard({ ...input, workspaceId, document: cyclic })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(store.createCard({ ...input, workspaceId, assets: [{ path: '../portrait.png', assetId: 'missing' }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(store.createCard({ ...input, workspaceId, identity: { algorithm: 'test', hash: 'bad' } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(store.createCard({ ...input, workspaceId, identity: { algorithm: 'test', hash: `${'a'.repeat(64)}\n` } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(store.listCards(workspaceId, { limit: 101 })).rejects.toBeInstanceOf(StoreError);
      expect(await store.listCards(workspaceId)).toEqual([]);
    });

    it('[S12] pages cards and revision history deterministically without dropping equal timestamps', async () => {
      const one = await store.createCard({ ...input, workspaceId });
      await store.createCard({ ...input, workspaceId });
      const first = await store.listCards(workspaceId, { limit: 1 });
      const second = await store.listCards(workspaceId, { limit: 1, afterId: first[0]!.id });
      expect(first[0]?.id).not.toBe(second[0]?.id);
      expect(await store.listCards(workspaceId, { afterId: second[0]!.id })).toEqual([]);
      const revision = await store.saveRevision({ ...input, workspaceId, cardId: one.card.id, expectedHead: one.revision.id });
      expect(await store.listRevisions(workspaceId, one.card.id, { afterSequence: 1 })).toEqual([revision]);
    });

    it('[S13] rolls back a fork without changing its source', async () => {
      const base = await store.createCard({ ...input, workspaceId, originalHash });
      const before = await counts();
      for (const step of [1, 2, 3]) {
        failAfter = step;
        await expect(store.forkCard({ ...input, workspaceId, sourceWorkspaceId: workspaceId, sourceRevisionId: base.revision.id })).rejects.toThrow();
        expect(await counts()).toEqual(before);
        expect(await store.getCard(workspaceId, base.card.id)).toEqual(base.card);
      }
    });

    it('[S14] rolls back migration DDL and history together when a migration fails', async () => {
      const other = await createFixture();
      try {
        const faulty: StoreDriver = { query: (query) => other.driver.query(query), batch: (statements) => other.driver.batch(
          statements.length > 1 ? [...statements, { sql: "INSERT INTO unity_migrations(version, name, checksum, applied_at) VALUES (999, NULL, 'injected', 'injected')" }] : statements,
        ) };
        await expect(migrate(faulty)).rejects.toThrow();
        expect(await other.driver.query({ sql: 'SELECT * FROM unity_migrations' })).toEqual([]);
        expect(await other.driver.query({ sql: "SELECT name FROM sqlite_master WHERE name = 'unity_cards'" })).toEqual([]);
        await Promise.all([migrate(other.driver), migrate(other.driver)]);
        expect(await inspectSchema(other.driver)).toBe(10);
      } finally { await other.close(); }
    });
  });
}
