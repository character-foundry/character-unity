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
import type { StoreDriver } from '../../src/driver.js';

const lineage = (revisionHash: string) => ({ data: { name: 'Aster', extensions: { foundry: { lineage: { revisionHash } } } } });
for (const adapter of ['sqlite', 'd1']) describe(`chat placements contract / ${adapter}`, () => {
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
    expect(await chat.targets(ws)).toEqual([target]);
    await expect(chat.addTarget({ workspaceId: ws, kind: 'sillytavern', name: 'Again', baseUrl: 'http://127.0.0.1:9000', credentials: {} })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(chat.addTarget({ workspaceId: ws, kind: 'sillytavern', name: 'Bad', baseUrl: 'http://u:p@host', credentials: {} })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await chat.updateTarget(ws, target.id, { name: 'Tavern', credentials: { password: 'q' } });
    expect((await chat.target(ws, target.id)).credentials).toEqual({ username: 'u', password: 'q' });
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
});
