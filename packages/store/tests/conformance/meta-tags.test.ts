import Database from 'better-sqlite3';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createStore, type UnityStore } from '../../src/index.js';
import { createNodeDriver } from '../../src/node.js';
import { createD1Driver } from '../../src/d1.js';
import { migrate, schemaVersion } from '../../src/migrations.js';
import { migrations } from '../../src/schema.js';
import { createAccountStore, createSessionDriver } from '../../src/accounts.js';
import { resolveMetaTagFilters, validateMetaTagWrite, type MetaTagWrite } from '../../src/meta-tags.js';
import type { StoreDriver } from '../../src/driver.js';

const group = { id: 'genre-fantasy', name: ' Fantasy ', members: [' Magic ', 'MAGIC', 'Elves'] };
for (const adapter of ['sqlite', 'd1']) describe(`meta-tags contract / ${adapter}`, () => {
  let driver: StoreDriver, store: UnityStore, close: () => void | Promise<void>, workspaceId: string;
  async function open() {
    if (adapter === 'sqlite') {
      const db = new Database(':memory:'); driver = createNodeDriver(db); close = () => { db.close(); };
    } else {
      const mf = new Miniflare(convertV4MiniflareOptions({ port: 0, workers: [{ name: 'meta-tags-test', modules: true,
        script: 'export default { fetch() { return new Response("test"); } };', compatibilityDate: '2026-10-11', d1Databases: ['DB'] }] }));
      driver = createD1Driver(await mf.getD1Database('DB')); close = () => mf.dispose();
    }
  }
  beforeEach(async () => { await open(); await migrate(driver); store = createStore(driver); workspaceId = (await store.createWorkspace({ ownerId: 'alice', name: 'Library' })).id; });
  afterEach(async () => { await close?.(); });

  it('[MT01] reads the version-zero default without writes or side effects on cards, roots and search jobs', async () => {
    const card = await store.createCard({ workspaceId, authorId: 'alice', originalHash: 'b'.repeat(64),
      identity: { algorithm: 'fixture', hash: 'a'.repeat(64) }, document: { data: { name: 'Original', tags: ['MAGIC'] }, opaque: { keep: [1, null] } } });
    const jobs = await store.listSearchJobs();
    const readonly = createStore({ query: (statement) => driver.query(statement), batch: async () => { throw new Error('Reading metadata must never write'); } });
    expect(await readonly.readMetaTags(workspaceId)).toEqual({ version: 0, groups: [] });
    expect(await driver.query({ sql: 'SELECT workspace_id FROM unity_meta_tag_catalogs' })).toEqual([]);
    await store.writeMetaTags(workspaceId, { expectedVersion: 0, groups: [group] });
    expect(await store.getCard(workspaceId, card.card.id)).toEqual(card.card);
    expect(await store.getRevision(workspaceId, card.revision.id)).toEqual(card.revision);
    expect(await store.listSearchJobs()).toEqual(jobs);
  });

  it('[MT02] snapshots normalized replacements, preserves first spelling and scopes catalogs to their workspace', async () => {
    const input = { expectedVersion: 0, groups: [structuredClone(group), { id: 'theme-magic', name: 'Theme', members: ['Magic'] }] };
    const pending = store.writeMetaTags(workspaceId, input);
    input.expectedVersion = 10; input.groups[0]!.name = 'Changed later'; input.groups[0]!.members[0] = 'Replaced';
    const saved = await pending;
    expect(saved).toEqual({ version: 1, groups: [{ id: 'genre-fantasy', name: 'Fantasy', members: ['Magic', 'Elves'] }, { id: 'theme-magic', name: 'Theme', members: ['Magic'] }] });
    saved.groups[0]!.members[0] = 'Mutated returned value';
    expect((await store.readMetaTags(workspaceId)).groups[0]!.members).toEqual(['Magic', 'Elves']);
    const other = await store.createWorkspace({ ownerId: 'bob', name: 'Other' });
    expect(await store.readMetaTags(other.id)).toEqual({ version: 0, groups: [] });
    await expect(store.writeMetaTags(other.id, { expectedVersion: 1, groups: [] })).rejects.toMatchObject({ code: 'HEAD_CONFLICT' });
    await expect(store.readMetaTags('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(store.writeMetaTags('missing', { expectedVersion: 0, groups: [] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await store.writeMetaTags(workspaceId, { expectedVersion: 1, groups: [] })).toEqual({ version: 2, groups: [] });
    expect(await store.readMetaTags(workspaceId)).toEqual({ version: 2, groups: [] });
  });

  it('[MT03] atomically admits only one competing initial or replacement write and refuses stale saves', async () => {
    for (const expectedVersion of [0, 1]) {
      const attempts = await Promise.allSettled([store.writeMetaTags(workspaceId, { expectedVersion, groups: [group] }),
        createStore(driver).writeMetaTags(workspaceId, { expectedVersion, groups: [{ id: 'second', name: 'Second', members: ['Other'] }] })]);
      expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
      const failure = attempts.find((attempt) => attempt.status === 'rejected');
      expect(failure?.status === 'rejected' && failure.reason).toMatchObject({ code: 'HEAD_CONFLICT' });
      expect((await store.readMetaTags(workspaceId)).version).toBe(expectedVersion + 1);
    }
    await expect(store.writeMetaTags(workspaceId, { expectedVersion: 0, groups: [] })).rejects.toMatchObject({ code: 'HEAD_CONFLICT' });
    expect((await store.readMetaTags(workspaceId)).version).toBe(2);
  });

  it('[MT04] validates bounded strict metadata without partially replacing the previous catalog', async () => {
    const saved = await store.writeMetaTags(workspaceId, { expectedVersion: 0, groups: [group] });
    const invalid: unknown[] = [null, { expectedVersion: -1, groups: [] }, { expectedVersion: 0.5, groups: [] },
      { expectedVersion: 1, groups: Array(1) },
      { expectedVersion: Number.MAX_SAFE_INTEGER, groups: [] }, { expectedVersion: 1, groups: [], actor: 'forged' },
      ...[{ ...group, id: '../unsafe' }, { ...group, id: 'a'.repeat(129) }, { ...group, name: '' }, { ...group, name: 'a'.repeat(129) }, { ...group, name: 'bad\u0000name' },
        { ...group, members: [] }, { ...group, members: null }, { ...group, members: [false] }, { ...group, members: [' '] }, { ...group, members: ['x'.repeat(129)] }, { ...group, future: true },
        { ...group, members: Array.from({ length: 101 }, (_, index) => `tag-${index}`) }].map((entry) => ({ expectedVersion: 1, groups: [entry] })),
      { expectedVersion: 1, groups: [group, { ...group, id: 'other', name: 'FANTASY' }] }, { expectedVersion: 1, groups: [group, { ...group, name: 'Other' }] },
      { expectedVersion: 1, groups: Array.from({ length: 101 }, (_, index) => ({ id: `g-${index}`, name: `Group ${index}`, members: ['tag'] })) },
      { expectedVersion: 1, groups: Array.from({ length: 11 }, (_, index) => ({ id: `g-${index}`, name: `Group ${index}`, members: Array.from({ length: 100 }, (_, member) => `tag-${member}`) })) }];
    for (const input of invalid) await expect(store.writeMetaTags(workspaceId, input as MetaTagWrite)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await store.readMetaTags(workspaceId)).toEqual(saved);
    expect(validateMetaTagWrite({ expectedVersion: 1, groups: [{ id: 'upper', name: 'Ä', members: ['ONE', 'one'] }, { id: 'lower', name: 'ä', members: ['one'] }] }).groups).toHaveLength(2);
    const maximum = Array.from({ length: 10 }, (_, index) => ({ id: `g-${index}`, name: `Group ${index}`,
      members: Array.from({ length: 100 }, (_, member) => `tag-${member}`) }));
    expect((await store.writeMetaTags(workspaceId, { expectedVersion: 1, groups: maximum })).groups.flatMap((entry) => entry.members)).toHaveLength(1000);
  });

  it('[MT05] checks account revocation in the same commit as a catalog replacement', async () => {
    const accounts = createAccountStore(driver), owner = await accounts.create('Owner'), session = (await accounts.login(owner.key))!;
    const ownWorkspace = await store.createWorkspace({ ownerId: owner.account.id, name: 'Protected' });
    await store.writeMetaTags(ownWorkspace.id, { expectedVersion: 0, groups: [group] });
    let revoke = true;
    const guarded = createStore(createSessionDriver({ query: (statement) => driver.query(statement), async batch(statements) {
      if (revoke) { revoke = false; await accounts.setEnabled(owner.account.id, false); }
      return driver.batch(statements);
    } }, session.proof));
    await expect(guarded.writeMetaTags(ownWorkspace.id, { expectedVersion: 1, groups: [] })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect((await store.readMetaTags(ownWorkspace.id)).version).toBe(1);
    expect((await store.readMetaTags(ownWorkspace.id)).groups).toHaveLength(1);
    expect(await driver.query({ sql: 'SELECT * FROM unity_session_write_guards' })).toEqual([]);
  });

  it('[MT06] upgrades populated schema16 with unchanged original documents, roots and search work', async () => {
    await close(); await open();
    await driver.batch([{ sql: 'CREATE TABLE unity_migrations(version INTEGER PRIMARY KEY NOT NULL,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)' }]);
    for (const migration of migrations.filter((entry) => entry.version <= 16)) await driver.batch([
      ...migration.statements.map((sql) => ({ sql })), { sql: 'INSERT INTO unity_migrations VALUES (?,?,?,?)', params: [migration.version, migration.name,
        createHash('sha256').update(JSON.stringify(migration.statements)).digest('hex'), new Date().toISOString()] },
    ]);
    const old = createStore(driver), workspace = await old.createWorkspace({ ownerId: 'alice', name: 'Existing' });
    const card = await old.createCard({ workspaceId: workspace.id, authorId: 'alice', originalHash: 'b'.repeat(64),
      identity: { algorithm: 'fixture', hash: 'a'.repeat(64) }, document: { data: { name: 'Untouched', tags: ['Magic'] }, opaque: [false, null] } });
    const jobs = await old.listSearchJobs();
    await migrate(driver);
    expect(await old.readiness()).toEqual({ schemaVersion });
    expect(await old.readMetaTags(workspace.id)).toEqual({ version: 0, groups: [] });
    expect(await old.getCard(workspace.id, card.card.id)).toEqual(card.card);
    expect(await old.getRevision(workspace.id, card.revision.id)).toEqual(card.revision);
    expect(await old.listSearchJobs()).toEqual(jobs);
  });

  it('[MT07] resolves only explicit group IDs to name-or-member terms, with versioned bounded filters', async () => {
    const catalog = await store.writeMetaTags(workspaceId, { expectedVersion: 0, groups: [group, { id: 'theme-magic', name: 'Theme', members: ['Magic'] }] });
    expect(resolveMetaTagFilters(catalog, { metaTags: ['genre-fantasy', 'genre-fantasy'], excludeMetaTags: ['theme-magic'] })).toEqual({
      tagGroups: [['Fantasy', 'Magic', 'Elves']], excludeTagGroups: [['Theme', 'Magic']], catalogVersion: 1,
    });
    expect(() => resolveMetaTagFilters(catalog, { metaTags: ['Magic'] })).toThrow('no longer in this workspace catalog');
    expect(() => resolveMetaTagFilters(catalog, { metaTags: Array(21).fill('genre-fantasy') })).toThrow('at most 20');
    const large = { version: 2, groups: Array.from({ length: 10 }, (_, index) => ({ id: `g-${index}`, name: `Group ${index}`,
      members: Array.from({ length: 100 }, (_, member) => `tag-${member}`) })) };
    expect(resolveMetaTagFilters(large, { metaTags: ['g-0'] }).tagGroups[0]).toHaveLength(101);
    expect(() => resolveMetaTagFilters(large, { metaTags: large.groups.map((entry) => entry.id) })).toThrow('more than 1000');
  });
});
