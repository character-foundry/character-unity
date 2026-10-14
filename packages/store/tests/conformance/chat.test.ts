import Database from 'better-sqlite3';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStore } from '../../src/index.js';
import type { UnityStore } from '../../src/index.js';
import { createChatStore } from '../../src/chat.js';
import type { ChatStore } from '../../src/chat.js';
import { createNodeDriver } from '../../src/node.js';
import { createD1Driver } from '../../src/d1.js';
import { migrate } from '../../src/migrations.js';
import { migrations } from '../../src/schema.js';
import { createHash } from 'node:crypto';
import type { StoreDriver } from '../../src/driver.js';

const lineage = (revisionHash: string) => ({ data: { name: 'Aster', extensions: { foundry: { lineage: { revisionHash } } } } });
for (const adapter of ['sqlite', 'd1']) describe(`chat contract / ${adapter}`, () => {
  let close: () => void | Promise<void>;
  let driver: StoreDriver;
  let store: UnityStore;
  let chat: ChatStore;
  let ws: string;
  beforeEach(async () => {
    if (adapter === 'sqlite') {
      const db = new Database(':memory:'); driver = createNodeDriver(db); close = () => { db.close(); };
    } else {
      const mf = new Miniflare(convertV4MiniflareOptions({ port: 0, workers: [{ name: 'chat-test', modules: true,
        script: 'export default { fetch() { return new Response("test"); } };', compatibilityDate: '2026-10-11', d1Databases: ['DB'] }] }));
      driver = createD1Driver(await mf.getD1Database('DB')); close = () => mf.dispose();
    }
    await migrate(driver); store = createStore(driver); chat = createChatStore(driver);
    ws = (await store.createWorkspace({ ownerId: 'alice', name: 'Library' })).id;
  });
  afterEach(async () => { await close?.(); });

  it('[C01] stores targets without exposing credentials and keeps secrets on partial updates', async () => {
    const target = await chat.addTarget({ workspaceId: ws, kind: 'sillytavern', name: 'ST', baseUrl: 'http://127.0.0.1:9000/', credentials: { username: 'u', password: 'p' } });
    expect(target).not.toHaveProperty('credentials');
    expect(target.baseUrl).toBe('http://127.0.0.1:9000');
    expect(target.configurationVersion).toBe(1);
    expect(await chat.targets(ws)).toEqual([target]);
    await expect(chat.addTarget({ workspaceId: ws, kind: 'sillytavern', name: 'Again', baseUrl: 'http://127.0.0.1:9000', credentials: {} })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(chat.addTarget({ workspaceId: ws, kind: 'sillytavern', name: 'Bad', baseUrl: 'http://u:p@host', credentials: {} })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await chat.updateTarget(ws, target.id, { name: 'Tavern', credentials: { password: 'q' } });
    expect((await chat.target(ws, target.id)).credentials).toEqual({ username: 'u', password: 'q' });
    expect((await chat.target(ws, target.id)).configurationVersion).toBe(2);
    await expect(chat.target('other', target.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('[C02] derives current/behind/edited/missing from the card head and complete scans', async () => {
    const target = await chat.addTarget({ workspaceId: ws, kind: 'sillytavern', name: 'ST', baseUrl: 'http://st.lan:9000', credentials: {} });
    const created = await store.createCard({ workspaceId: ws, authorId: 'alice', document: lineage('1'.repeat(64)), identity: { algorithm: 't', hash: 'a'.repeat(64) }, originalHash: 'b'.repeat(64) });
    const card = created.card.id; const first = created.revision.id;
    await chat.recordPlacements(ws, target.id, [{ remoteId: 'Aster.png', remoteName: 'Aster', cardId: card, revisionId: first, edited: false, sent: true }], { complete: false });
    expect((await chat.placements(ws, [card]))[0]).toMatchObject({ status: 'current', revisionSequence: 1, headSequence: 1, kind: 'sillytavern' });
    const second = await store.saveRevision({ workspaceId: ws, cardId: card, expectedHead: first, authorId: 'alice', document: lineage('2'.repeat(64)), identity: { algorithm: 't', hash: 'c'.repeat(64) } });
    expect((await chat.placements(ws, [card]))[0]).toMatchObject({ status: 'behind', revisionSequence: 1, headSequence: 2 });
    await chat.recordPlacements(ws, target.id, [{ remoteId: 'Aster1.png', remoteName: 'Aster', cardId: card, revisionId: second.id, edited: true }], { complete: true });
    const rows = await chat.placements(ws);
    expect(rows.map((row) => [row.remoteId, row.status])).toEqual([['Aster1.png', 'edited'], ['Aster.png', 'missing']]);
    expect(rows[1]!.sentAt).not.toBeNull();
    expect((await chat.targets(ws))[0]!.scannedAt).not.toBeNull();
    await chat.recordPlacements(ws, target.id, [], { complete: false, error: 'offline' });
    expect((await chat.placements(ws)).map((row) => row.status)).toEqual(['edited', 'missing']);
    expect((await chat.targets(ws))[0]).toMatchObject({ scanError: 'offline' });
    await chat.forgetPlacement(ws, target.id, 'Aster.png');
    expect((await chat.placements(ws)).map((row) => row.remoteId)).toEqual(['Aster1.png']);
    await chat.removeTarget(ws, target.id);
    expect(await chat.placements(ws)).toEqual([]);
  });

  it('[C03] resolves exported copies by lineage revision hash, then content hash, preferring the known card', async () => {
    const a = await store.createCard({ workspaceId: ws, authorId: 'alice', document: lineage('3'.repeat(64)), identity: { algorithm: 't', hash: 'd'.repeat(64) }, originalHash: 'b'.repeat(64) });
    const b = await store.createCard({ workspaceId: ws, authorId: 'alice', document: { data: { name: 'Dup' } }, identity: { algorithm: 't', hash: 'd'.repeat(64) }, originalHash: 'b'.repeat(64) });
    expect(await chat.resolveRevision(ws, { revisionHash: '3'.repeat(64), contentHash: 'x'.repeat(64) })).toEqual({ id: a.revision.id, cardId: a.card.id });
    expect(await chat.resolveRevision(ws, { revisionHash: null, contentHash: 'd'.repeat(64), preferCardId: b.card.id })).toEqual({ id: b.revision.id, cardId: b.card.id });
    expect(await chat.resolveRevision(ws, { revisionHash: '9'.repeat(64), contentHash: 'e'.repeat(64) })).toBeNull();
    expect(await chat.resolveRevision('elsewhere', { revisionHash: '3'.repeat(64), contentHash: 'd'.repeat(64) })).toBeNull();
  });

  it('[C04] tracks reference placements without owned copies, retains rediscovery receipts and cascades unlinking', async () => {
    const target = await chat.addTarget({ workspaceId: ws, kind: 'sillytavern', name: 'ST', baseUrl: 'http://st.lan:9000', credentials: {} });
    const reference = await store.addArchiveReference({ workspaceId: ws, pin: { archiveId: 'archive', cardId: 'original', versionId: 'version-3' },
      summary: { name: 'Aster', creator: 'Maker', description: '', tags: [], source: 'chub', format: 'json', changedAt: '2026-10-13', portrait: false, tokensTotal: null, flags: [] } });
    const identity = { sequence: 3, contentHash: 'a'.repeat(64), revisionHash: 'b'.repeat(64) };
    const observed = { remoteId: 'Aster.png', remoteName: 'Aster', cardId: reference.id, revisionId: 'version-3', edited: false, sent: true, reference: identity };
    await chat.recordPlacements(ws, target.id, [observed], { complete: false });
    expect((await chat.placements(ws, [reference.id]))[0]).toMatchObject({ cardId: reference.id, status: 'current', revisionId: 'version-3', revisionSequence: 3, headSequence: 3, reference: identity });
    expect(await store.listCards(ws)).toEqual([]);
    expect(await driver.query({ sql: 'SELECT id FROM unity_revisions' })).toEqual([]);
    expect(await chat.placements('elsewhere')).toEqual([]);
    const match = { revisionHash: identity.revisionHash, contentHash: identity.contentHash };
    expect(await chat.resolveRevision(ws, match)).toEqual({ id: 'version-3', cardId: reference.id, reference: identity });
    expect(await chat.resolveRevision('elsewhere', match)).toBeNull();

    await chat.recordPlacements(ws, target.id, [{ ...observed, remoteId: 'renamed.png', edited: true }], { complete: true });
    expect((await chat.placements(ws)).map((item) => [item.remoteId, item.status])).toEqual([['renamed.png', 'edited'], ['Aster.png', 'missing']]);
    await chat.recordPlacements(ws, target.id, [], { complete: false, error: 'offline' });
    expect((await chat.placements(ws)).map((item) => item.status)).toEqual(['edited', 'missing']);
    await chat.forgetPlacement(ws, target.id, 'renamed.png');
    await chat.forgetPlacement(ws, target.id, 'Aster.png');
    expect(await chat.placements(ws)).toEqual([]);
    expect(await chat.resolveRevision(ws, match)).toMatchObject({ cardId: reference.id });
    await chat.recordPlacements(ws, target.id, [observed], { complete: false });
    await expect(chat.recordPlacements(ws, target.id, [{ ...observed, revisionId: 'wrong-version' }], { complete: false })).rejects.toThrow();
    expect((await chat.placements(ws))[0]).toMatchObject({ revisionId: 'version-3' });
    await store.removeArchiveReference(ws, reference.id);
    expect(await chat.placements(ws)).toEqual([]);
    expect(await chat.resolveRevision(ws, match)).toBeNull();
    await chat.removeTarget(ws, target.id);
  });

  it('[C05] atomically deduplicates first-save inbound receipts, scopes lookup and retains provenance on later edits', async () => {
    const original = await store.createCard({ workspaceId: ws, authorId: 'alice', document: { data: { name: 'Source' } },
      identity: { algorithm: 't', hash: 'a'.repeat(64) }, originalHash: 'b'.repeat(64) });
    const receiptHash = 'c'.repeat(64);
    const target = await chat.addTarget({ workspaceId: ws, kind: 'sillytavern', name: 'Chat', baseUrl: 'http://chat.test', credentials: {} });
    await chat.recordPlacements(ws, target.id, [{ remoteId: 'remote', remoteName: 'Source', cardId: original.card.id, revisionId: original.revision.id, edited: true }], { complete: false });
    const input = { workspaceId: ws, sourceWorkspaceId: ws, sourceRevisionId: original.revision.id, expectedSourceHead: original.revision.id,
      authorId: 'alice', document: { data: { name: 'Remote edit', extensions: { foundry: { local: { unityChatImport: { receiptHash } } } } } },
      identity: { algorithm: 't', hash: 'd'.repeat(64) }, chatImport: { receiptHash, sourceCardId: original.card.id, expectedHead: original.revision.id,
        targetId: target.id, targetConfiguration: 1, remoteId: 'remote', baseRevisionId: original.revision.id } };
    const attempts = await Promise.allSettled([store.forkCard(input), store.forkCard(input)]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await store.listCards(ws)).toHaveLength(2);
    const saved = await chat.importedEdit(ws, 'alice', receiptHash, original.revision.id);
    expect(saved).not.toBeNull();
    expect(await chat.importedEdit(ws, 'other', receiptHash, original.revision.id)).toBeNull();
    expect(await chat.importedEdit('elsewhere', 'alice', receiptHash, original.revision.id)).toBeNull();
    expect(await chat.importedEdit(ws, 'alice', receiptHash, 'another-head')).toBeNull();
    const next = await store.saveRevision({ workspaceId: ws, cardId: saved!.cardId, expectedHead: saved!.revisionId,
      authorId: 'alice', document: input.document, identity: { algorithm: 't', hash: 'e'.repeat(64) } });
    expect(next.sequence).toBe(2);
    expect(await chat.importedEdit(ws, 'alice', receiptHash, original.revision.id)).toEqual(saved);
    await chat.removeTarget(ws, target.id);
    expect(await chat.importedEdit(ws, 'alice', receiptHash, original.revision.id)).toEqual(saved);
  });

  it('[C06] upgrades schema13 duplicate opaque receipt metadata without treating authored JSON as authority', async () => {
    await close();
    if (adapter === 'sqlite') {
      const db = new Database(':memory:'); driver = createNodeDriver(db); close = () => { db.close(); };
    } else {
      const mf = new Miniflare(convertV4MiniflareOptions({ port: 0, workers: [{ name: 'chat-upgrade-test', modules: true,
        script: 'export default { fetch() { return new Response("test"); } };', compatibilityDate: '2026-10-11', d1Databases: ['DB'] }] }));
      driver = createD1Driver(await mf.getD1Database('DB')); close = () => mf.dispose();
    }
    await driver.batch([{ sql: 'CREATE TABLE unity_migrations(version INTEGER PRIMARY KEY NOT NULL,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)' }]);
    for (const migration of migrations.filter((entry) => entry.version <= 13)) await driver.batch([
      ...migration.statements.map((sql) => ({ sql })), { sql: 'INSERT INTO unity_migrations VALUES (?,?,?,?)', params: [migration.version, migration.name,
        createHash('sha256').update(JSON.stringify(migration.statements)).digest('hex'), new Date().toISOString()] },
    ]);
    store = createStore(driver); chat = createChatStore(driver);
    ws = (await store.createWorkspace({ ownerId: 'alice', name: 'Legacy' })).id;
    const document = { data: { name: 'Legacy opaque data', extensions: { foundry: { local: { unityChatImport: { receiptHash: 'c'.repeat(64) } } } } } };
    const one = await store.createCard({ workspaceId: ws, authorId: 'alice', document, identity: { algorithm: 't', hash: 'a'.repeat(64) } });
    const two = await store.createCard({ workspaceId: ws, authorId: 'alice', document, identity: { algorithm: 't', hash: 'b'.repeat(64) } });
    await migrate(driver);
    expect(await store.getRevision(ws, one.revision.id)).toEqual(one.revision);
    expect(await store.getRevision(ws, two.revision.id)).toEqual(two.revision);
    expect(await chat.importedEdit(ws, 'alice', 'c'.repeat(64), one.revision.id)).toBeNull();
    const forged = await store.forkCard({ workspaceId: ws, sourceWorkspaceId: ws, sourceRevisionId: one.revision.id,
      authorId: 'alice', document, identity: { algorithm: 't', hash: 'd'.repeat(64) } });
    expect(forged.revision.document).toEqual(document);
    expect(await chat.importedEdit(ws, 'alice', 'c'.repeat(64), one.revision.id)).toBeNull();
  });
});
