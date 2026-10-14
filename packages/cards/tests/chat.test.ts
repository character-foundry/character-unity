import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openNodeStore } from '@character-unity/store/node';
import { createNodeBlobStore } from '@character-unity/blob-store/node';
import { createAssetService } from '@character-unity/assets';
import { createChatApp } from '@character-unity/chat-apps';
import type { CardDocument } from '@character-unity/store';
import { createCardService } from '../src/index.js';
import { createChatService } from '../src/chat.js';
import { createNativeArchiveReader } from '../src/native-reader.js';
import { hashBytes, readCardLineage, verifyCardLineage } from '@character-foundry/character-foundry/identity';
import { parseCard } from '@character-foundry/character-foundry/loader';

const alice = { id: 'alice', uri: 'urn:unity:user:alice' };
const card = (description: string): CardDocument => ({ spec: 'chara_card_v2', spec_version: '2.0', data: {
  name: 'Aster', description, personality: '', scenario: '', first_mes: 'Hello.', mes_example: '', creator_notes: '',
  system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: ['forest'], creator: 'Fixture',
  character_version: '1', extensions: {},
} });

/** Just enough of SillyTavern's HTTP API: CSRF + cookie, import with preserved names, list and export. */
function fakeSillyTavern() {
  const files = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  let token = 'token-1';
  const fetcher = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input); calls.push(`${init.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname === '/csrf-token') return Response.json({ token }, { headers: { 'set-cookie': 'st=session; Path=/; HttpOnly' } });
    const headers = new Headers(init.headers);
    if (headers.get('x-csrf-token') !== token || headers.get('cookie') !== 'st=session') return new Response('Forbidden', { status: 403 });
    if (url.pathname === '/api/characters/import') {
      const form = init.body as FormData;
      const file = form.get('avatar') as File;
      const stored = parseCard(new Uint8Array(await file.arrayBuffer())).originalShape as unknown as Record<string, unknown>;
      const name = String(form.get('preserved_name') ?? (stored.data as { name: string }).name);
      files.set(`${name}.png`, stored);
      return Response.json({ file_name: name });
    }
    const body = JSON.parse(String(init.body ?? '{}')) as { avatar_url?: string };
    if (url.pathname === '/api/characters/all') {
      return Response.json([...files].map(([avatar, stored]) => ({ avatar, name: (stored.data as { name: string }).name, data: stored.data })));
    }
    if (url.pathname === '/api/characters/export') {
      const stored = files.get(body.avatar_url!);
      return stored ? new Response(JSON.stringify(stored, null, 4)) : new Response('', { status: 404 });
    }
    return new Response('', { status: 404 });
  };
  return { files, calls, fetcher, rotate() { token = 'token-2'; } };
}

describe('chat service with a SillyTavern-shaped app', () => {
  let directory: string;
  let database: Awaited<ReturnType<typeof openNodeStore>>;
  let cards: ReturnType<typeof createCardService>;
  let assets: ReturnType<typeof createAssetService>;
  let chat: ReturnType<typeof createChatService>;
  let st: ReturnType<typeof fakeSillyTavern>;
  let workspaceId: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'unity-chat-'));
    database = await openNodeStore(':memory:');
    assets = createAssetService(database.store, await createNodeBlobStore(directory));
    cards = createCardService(database.store, assets);
    st = fakeSillyTavern();
    chat = createChatService(database.store, database.chat, assets, (connection) => createChatApp(connection, st.fetcher));
    workspaceId = (await cards.createWorkspace(alice, 'Library')).id;
  });
  afterEach(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });

  it('sends, overwrites in place, tracks head, detects in-app edits and vanished copies', async () => {
    const target = await chat.addTarget(alice, workspaceId, { kind: 'sillytavern', baseUrl: 'http://st.test:8100', credentials: {} });
    expect(target.name).toBe('SillyTavern');
    const imported = await cards.import(alice, workspaceId, new TextEncoder().encode(JSON.stringify(card('A map keeper.'))));
    const id = imported.card.id;

    const first = await chat.send(alice, workspaceId, id, target.id);
    expect(first).toMatchObject({ remoteId: `${id}.png`, status: 'current', revisionId: imported.revision.id });
    expect((st.files.get(`${id}.png`)!.data as { extensions: { foundry: { local: unknown } } }).extensions.foundry.local).toBeTruthy();
    expect(await chat.scan(alice, workspaceId, target.id)).toEqual({ found: 1 });
    expect((await chat.placements(alice, workspaceId, [id]))[0]).toMatchObject({ status: 'current' });

    const saved = await cards.save(alice, workspaceId, id, imported.revision.id, card('A map keeper who travels.'));
    expect((await chat.placements(alice, workspaceId, [id]))[0]).toMatchObject({ status: 'behind', revisionSequence: 1, headSequence: 2 });
    await chat.scan(alice, workspaceId, target.id);
    expect((await chat.placements(alice, workspaceId, [id]))[0]).toMatchObject({ status: 'behind' });

    st.rotate(); // An expired CSRF session is renewed once.
    const second = await chat.send(alice, workspaceId, id, target.id);
    expect(second).toMatchObject({ remoteId: `${id}.png`, status: 'current', revisionId: saved.id });
    expect(st.files.size).toBe(1);

    ((st.files.get(`${id}.png`)!.data) as { description: string }).description = 'Rewritten inside SillyTavern.';
    await chat.scan(alice, workspaceId, target.id);
    expect((await chat.placements(alice, workspaceId, [id]))[0]).toMatchObject({ status: 'edited', revisionId: saved.id });
    await expect(chat.send(alice, workspaceId, id, target.id)).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
    await chat.send(alice, workspaceId, id, target.id, { overwriteEdited: true });
    expect((await chat.placements(alice, workspaceId, [id]))[0]).toMatchObject({ status: 'current' });

    // A copy renamed inside the app is found again by its marker; the old file name goes missing.
    st.files.set('Aster.png', st.files.get(`${id}.png`)!); st.files.delete(`${id}.png`);
    await chat.scan(alice, workspaceId, target.id);
    expect((await chat.placements(alice, workspaceId, [id])).map((row) => [row.remoteId, row.status])).toEqual([['Aster.png', 'current'], [`${id}.png`, 'missing']]);

    // Unrelated characters are ignored.
    st.files.set('Stranger.png', { spec: 'chara_card_v2', data: { name: 'Stranger', extensions: {} } });
    expect(await chat.scan(alice, workspaceId, target.id)).toEqual({ found: 1 });
    expect((await chat.targets(alice, workspaceId))[0]).not.toHaveProperty('credentials');
  });

  it('records an unreachable app without losing known copies', async () => {
    const target = await chat.addTarget(alice, workspaceId, { kind: 'sillytavern', baseUrl: 'http://st.test:8100', credentials: {} });
    const imported = await cards.import(alice, workspaceId, new TextEncoder().encode(JSON.stringify(card('A map keeper.'))));
    await chat.send(alice, workspaceId, imported.card.id, target.id);
    const offline = createChatService(database.store, database.chat, createAssetService(database.store, await createNodeBlobStore(directory)),
      (connection) => createChatApp(connection, async () => { throw new TypeError('fetch failed'); }));
    await expect(offline.scan(alice, workspaceId, target.id)).rejects.toMatchObject({ code: 'UNREACHABLE' });
    expect((await chat.placements(alice, workspaceId))[0]).toMatchObject({ status: 'current' });
    expect((await chat.targets(alice, workspaceId))[0]!.scanError).toMatch(/did not answer/);
    await expect(chat.targets({ id: 'bob', uri: 'urn:unity:user:bob' }, workspaceId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('reviews remote text edits without writes and accepts them as a private, verified fork', async () => {
    const original = card('Original description.');
    (original.data as Record<string, unknown>).opaque = { script: 'keep me' };
    const imported = await cards.import(alice, workspaceId, new TextEncoder().encode(JSON.stringify(original)));
    const target = await chat.addTarget(alice, workspaceId, { kind: 'sillytavern', baseUrl: 'http://st.test', credentials: {} });
    const sent = await chat.send(alice, workspaceId, imported.card.id, target.id);
    (st.files.get(sent.remoteId)!.data as Record<string, unknown>).description = 'Edited inside the app.';
    const review = await chat.reviewEdit(alice, workspaceId, target.id, sent.remoteId);
    expect(review).toMatchObject({ cardId: imported.card.id, baseRevisionId: imported.revision.id, expectedHead: imported.revision.id,
      changes: [{ field: 'description', before: 'Original description.', after: 'Edited inside the app.' }] });
    expect(await cards.list(alice, workspaceId)).toHaveLength(1);
    const result = await chat.acceptEdit(alice, workspaceId, target.id, review);
    expect(result.cardId).not.toBe(imported.card.id);
    const fork = await cards.open(alice, workspaceId, result.cardId);
    expect(fork.revision.document.data).toMatchObject({ description: 'Edited inside the app.', opaque: { script: 'keep me' } });
    expect(readCardLineage(fork.revision.document)).toMatchObject({ operation: 'fork', originalHash: imported.card.originalHash });
    expect(await verifyCardLineage(fork.revision.document)).toBe(true);
    expect((await cards.open(alice, workspaceId, imported.card.id)).revision.id).toBe(imported.revision.id);
    expect(await database.hub.list(null)).toEqual([]);
    expect(await chat.acceptEdit(alice, workspaceId, target.id, review)).toMatchObject({ cardId: result.cardId, duplicate: true });
    const exported = await cards.export(alice, workspaceId, result.cardId, result.revisionId, 'json');
    expect(new TextDecoder().decode(exported.bytes)).not.toContain('unityChatImport');
    await chat.removeTarget(alice, workspaceId, target.id);
    expect(await chat.acceptEdit(alice, workspaceId, target.id, review)).toMatchObject({ cardId: result.cardId, duplicate: true });
  });

  async function editedCopy() {
    const imported = await cards.import(alice, workspaceId, new TextEncoder().encode(JSON.stringify(card('Original.'))));
    const target = await chat.addTarget(alice, workspaceId, { kind: 'sillytavern', baseUrl: 'http://st.test', credentials: {} });
    const sent = await chat.send(alice, workspaceId, imported.card.id, target.id);
    const remote = st.files.get(sent.remoteId)!.data as Record<string, unknown>;
    remote.description = 'Remote edit.';
    return { imported, target, sent, remote };
  }

  it('explains a removed previous snapshot import without recreating or resurrecting its private fork', async () => {
    const fixture = await editedCopy();
    const review = await chat.reviewEdit(alice, workspaceId, fixture.target.id, fixture.sent.remoteId);
    const imported = await chat.acceptEdit(alice, workspaceId, fixture.target.id, review);
    await cards.delete(alice, workspaceId, imported.cardId);
    const freshReview = await chat.reviewEdit(alice, workspaceId, fixture.target.id, fixture.sent.remoteId);
    expect(freshReview).toEqual(review);
    for (const pin of [review, freshReview]) await expect(chat.acceptEdit(alice, workspaceId, fixture.target.id, pin)).rejects.toMatchObject({
      code: 'ACCESS_CHANGED', message: 'A previous import of this snapshot was removed; it will not be silently recreated.',
    });
    expect((await cards.list(alice, workspaceId)).map((item) => item.id)).toEqual([fixture.imported.card.id]);
    await expect(cards.open(alice, workspaceId, imported.cardId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await chat.placements(alice, workspaceId, [fixture.imported.card.id]))[0]).toMatchObject({ remoteId: fixture.sent.remoteId, status: 'current' });
  });

  it('refuses stale remote bytes, stale heads and changed connections without creating a fork', async () => {
    const fixture = await editedCopy();
    const review = await chat.reviewEdit(alice, workspaceId, fixture.target.id, fixture.sent.remoteId);
    fixture.remote.description = 'Another remote edit.';
    await expect(chat.acceptEdit(alice, workspaceId, fixture.target.id, review)).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
    fixture.remote.description = 'Remote edit.';
    await cards.save(alice, workspaceId, fixture.imported.card.id, fixture.imported.revision.id, card('Local edit.'));
    await expect(chat.acceptEdit(alice, workspaceId, fixture.target.id, review)).rejects.toMatchObject({ code: 'HEAD_CONFLICT' });
    await chat.updateTarget(alice, workspaceId, fixture.target.id, { baseUrl: 'http://other.test' });
    await expect(chat.acceptEdit(alice, workspaceId, fixture.target.id, review)).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
    expect(await cards.list(alice, workspaceId)).toHaveLength(1);
  });

  it.each(['configuration', 'removed target', 'forgotten placement'])('atomically refuses %s changes during the final owned fork', async (change) => {
    const fixture = await editedCopy();
    const review = await chat.reviewEdit(alice, workspaceId, fixture.target.id, fixture.sent.remoteId);
    const guarded = createChatService({ ...database.store, async forkCard(input, context) {
      if (change === 'configuration') await chat.updateTarget(alice, workspaceId, fixture.target.id, { credentials: { password: 'changed after final review read' } });
      else if (change === 'removed target') await chat.removeTarget(alice, workspaceId, fixture.target.id);
      else await chat.forget(alice, workspaceId, fixture.target.id, fixture.sent.remoteId);
      return database.store.forkCard(input, context);
    } }, database.chat, assets, (connection) => createChatApp(connection, st.fetcher));
    await expect(guarded.acceptEdit(alice, workspaceId, fixture.target.id, review)).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
    expect(await cards.list(alice, workspaceId)).toHaveLength(1);
  });

  it('merges only remotely changed fields and refuses conflicting edits to the same field', async () => {
    const fixture = await editedCopy();
    const local = card('Original.'); (local.data as Record<string, unknown>).scenario = 'A newer local scenario.';
    await cards.save(alice, workspaceId, fixture.imported.card.id, fixture.imported.revision.id, local);
    const review = await chat.reviewEdit(alice, workspaceId, fixture.target.id, fixture.sent.remoteId);
    const result = await chat.acceptEdit(alice, workspaceId, fixture.target.id, review);
    expect((await cards.open(alice, workspaceId, result.cardId)).revision.document.data).toMatchObject({
      description: 'Remote edit.', scenario: 'A newer local scenario.',
    });
    fixture.remote.scenario = 'A competing remote scenario.';
    await expect(chat.reviewEdit(alice, workspaceId, fixture.target.id, fixture.sent.remoteId)).rejects.toMatchObject({ code: 'HEAD_CONFLICT' });
  });

  it.each(['character_book', 'assets', 'opaque'])('refuses changed unsupported %s instead of dropping it', async (field) => {
    const fixture = await editedCopy(); fixture.remote[field] = field === 'assets' ? [{ uri: 'https://remote.test/new.png' }] : { changed: true };
    await expect(chat.reviewEdit(alice, workspaceId, fixture.target.id, fixture.sent.remoteId)).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
    expect(await cards.list(alice, workspaceId)).toHaveLength(1);
  });

  it('does not trust remote lineage, and never imports a forged private receipt', async () => {
    const fixture = await editedCopy();
    (fixture.remote.extensions as Record<string, unknown>).foundry = { lineage: { forged: true } };
    await expect(chat.reviewEdit(alice, workspaceId, fixture.target.id, fixture.sent.remoteId)).rejects.toThrow();
    const source = card('Imported original.');
    (source.data as Record<string, unknown>).extensions = { foundry: { local: { unityChatImport: { receiptHash: 'a'.repeat(64) }, keep: 'opaque local field' } } };
    const imported = await cards.import(alice, workspaceId, new TextEncoder().encode(JSON.stringify(source)));
    expect(JSON.stringify(imported.revision.document)).not.toContain('unityChatImport');
    expect(JSON.stringify(imported.revision.document)).toContain('opaque local field');
  });

  it('keeps the exact portrait and declared asset bindings when importing text from a PNG copy', async () => {
    const image = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64'));
    const source: CardDocument = { ...card('Original.'), spec: 'chara_card_v3', spec_version: '3.0' };
    (source.data as Record<string, unknown>).assets = [{ name: 'main', type: 'icon', ext: 'png', uri: 'embedded://authored-portrait.png', opaque: ['preserve'] }];
    const created = await cards.createDraft(alice, workspaceId, source, [
      { path: 'portrait', source: { kind: 'upload', index: 0 } }, { path: 'declared/0', source: { kind: 'upload', index: 0 } },
    ], [{ bytes: image, mediaType: 'image/png' }]);
    const target = await chat.addTarget(alice, workspaceId, { kind: 'sillytavern', baseUrl: 'http://st.test', credentials: {} });
    const sent = await chat.send(alice, workspaceId, created.card.id, target.id);
    const filesBefore = (await readdir(directory, { recursive: true, withFileTypes: true })).filter((item) => item.isFile()).length;
    (st.files.get(sent.remoteId)!.data as Record<string, unknown>).description = 'Remote portrait owner.';
    const review = await chat.reviewEdit(alice, workspaceId, target.id, sent.remoteId);
    const result = await chat.acceptEdit(alice, workspaceId, target.id, review);
    const fork = await cards.open(alice, workspaceId, result.cardId);
    expect(fork.revision.assets).toEqual(created.revision.assets);
    expect((fork.revision.document.data as Record<string, unknown>).assets).toEqual((source.data as Record<string, unknown>).assets);
    expect(new Uint8Array(await new Response((await cards.asset(alice, workspaceId, result.cardId, result.revisionId, 'portrait')).body).arrayBuffer())).toEqual(image);
    expect((await readdir(directory, { recursive: true, withFileTypes: true })).filter((item) => item.isFile())).toHaveLength(filesBefore);
  });

  it('rejects foreign owners and forgotten placements, and treats unchanged copies as no-op', async () => {
    const fixture = await editedCopy();
    await expect(chat.reviewEdit({ id: 'bob', uri: 'urn:bob' }, workspaceId, fixture.target.id, fixture.sent.remoteId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    fixture.remote.description = 'Original.';
    const review = await chat.reviewEdit(alice, workspaceId, fixture.target.id, fixture.sent.remoteId);
    expect(review.changes).toEqual([]);
    await expect(chat.acceptEdit(alice, workspaceId, fixture.target.id, review)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await chat.forget(alice, workspaceId, fixture.target.id, fixture.sent.remoteId);
    await expect(chat.reviewEdit(alice, workspaceId, fixture.target.id, fixture.sent.remoteId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('does not accept receipts injected through drafts, saves or forks, and forks of imports get new identities', async () => {
    const fixture = await editedCopy();
    const forged = card('A forged new draft.');
    (forged.data as Record<string, unknown>).extensions = { foundry: { local: { unityChatImport: { receiptHash: 'e'.repeat(64) } } } };
    const draft = await cards.createDraft(alice, workspaceId, forged, [], []);
    expect(JSON.stringify(draft.revision.document)).not.toContain('unityChatImport');
    const forgedEdit = structuredClone(draft.revision.document);
    ((forgedEdit.data as Record<string, unknown>).extensions as Record<string, unknown>).foundry = {
      ...((forgedEdit.data as Record<string, unknown>).extensions as { foundry: object }).foundry,
      local: { unityChatImport: { receiptHash: 'e'.repeat(64) } },
    };
    (forgedEdit.data as Record<string, unknown>).description = 'Another forged edit.';
    const saved = await cards.save(alice, workspaceId, draft.card.id, draft.revision.id, forgedEdit);
    expect(JSON.stringify(saved.document)).not.toContain('unityChatImport');
    const forkDraft = structuredClone(saved.document);
    (((forkDraft.data as Record<string, unknown>).extensions as { foundry: Record<string, unknown> }).foundry).local = {
      unityChatImport: { receiptHash: 'e'.repeat(64) },
    };
    const forgedFork = await cards.forkAssets(alice, workspaceId, draft.card.id, saved.id, forkDraft, [], []);
    expect(JSON.stringify(forgedFork.revision.document)).not.toContain('unityChatImport');

    const review = await chat.reviewEdit(alice, workspaceId, fixture.target.id, fixture.sent.remoteId);
    const imported = await chat.acceptEdit(alice, workspaceId, fixture.target.id, review);
    const importedHead = (await cards.open(alice, workspaceId, imported.cardId)).revision;
    const trueReceipt = ((importedHead.document.data as Record<string, unknown>).extensions as { foundry: { local: { unityChatImport: unknown } } }).foundry.local.unityChatImport;
    const forgedLaterEdit = structuredClone(importedHead.document);
    ((forgedLaterEdit.data as Record<string, unknown>).extensions as { foundry: { local: Record<string, unknown> } }).foundry.local.unityChatImport = { receiptHash: 'f'.repeat(64) };
    (forgedLaterEdit.data as Record<string, unknown>).scenario = 'An ordinary later edit.';
    const later = await cards.saveAssets(alice, workspaceId, imported.cardId, importedHead.id, forgedLaterEdit, [], []);
    expect(((later.document.data as Record<string, unknown>).extensions as { foundry: { local: { unityChatImport: unknown } } }).foundry.local.unityChatImport).toEqual(trueReceipt);
    const restored = await cards.restore(alice, workspaceId, imported.cardId, later.id, importedHead.id);
    expect(((restored.document.data as Record<string, unknown>).extensions as { foundry: { local: { unityChatImport: unknown } } }).foundry.local.unityChatImport).toEqual(trueReceipt);
    const fork = await cards.fork(alice, workspaceId, imported.cardId);
    expect(JSON.stringify(fork.revision.document)).not.toContain('unityChatImport');
    const assetFork = await cards.forkAssets(alice, workspaceId, imported.cardId, restored.id,
      (await cards.open(alice, workspaceId, imported.cardId)).revision.document, [], []);
    expect(JSON.stringify(assetFork.revision.document)).not.toContain('unityChatImport');
    const receiptFreeDraft = structuredClone(restored.document);
    ((receiptFreeDraft.data as Record<string, unknown>).extensions as { foundry: { local: Record<string, unknown> } }).foundry.local.unityChatImport = { receiptHash: 'f'.repeat(64) };
    const ordinaryFork = await cards.fork(alice, workspaceId, imported.cardId, { expectedHead: restored.id, document: receiptFreeDraft });
    expect(JSON.stringify(ordinaryFork.revision.document)).not.toContain('unityChatImport');
  });

  async function referenceFixture() {
    const bytes = new TextEncoder().encode(JSON.stringify(card('An archived map keeper.'))), hash = await hashBytes(bytes);
    let available = true; let beforeRead: (() => Promise<void>) | undefined;
    const reads: string[] = [];
    const archive = createNativeArchiveReader({ origin: 'http://archive.test', async fetch(input) {
      const url = new URL(input); reads.push(url.pathname + url.search);
      if (!available) return Response.json({ error: { code: 'SOURCE_UNAVAILABLE', message: 'The pinned source is unavailable' } }, { status: 404 });
      if (url.pathname === '/api/archive/v2/cards/source') {
        return Response.json({ archiveId: 'archive-a', id: 'source', provider: 'chub', recordId: 'source', url: 'https://chub.test/source',
          name: 'Aster', creator: 'Fixture', tags: [], versionId: url.searchParams.get('version') ?? 'newer-version',
          versionList: [{ id: 'old-version', sequence: 3, objects: [{ role: 'card', name: 'card.json', sha256: hash, byteLength: bytes.length, mediaType: 'application/json' }] }] });
      }
      if (url.pathname === `/api/archive/v2/objects/${hash}`) {
        await beforeRead?.();
        return new Response(new Uint8Array(bytes), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('', { status: 404 });
    } });
    cards = createCardService(database.store, assets, { archive });
    chat = createChatService(database.store, database.chat, assets, (connection) => createChatApp(connection, st.fetcher), { archive });
    const reference = await cards.addArchiveReference(alice, workspaceId, 'source', 'old-version', true);
    return { reference, archive, reads, unavailable() { available = false; }, onRead(callback: () => Promise<void>) { beforeRead = callback; } };
  }

  it('sends exact pinned references and scans renamed/edited/missing copies without making owned cards or blobs', async () => {
    const fixture = await referenceFixture(), id = fixture.reference.id;
    const target = await chat.addTarget(alice, workspaceId, { kind: 'sillytavern', baseUrl: 'http://st.test:8100', credentials: {} });
    const sent = await chat.send(alice, workspaceId, id, target.id);
    expect(sent).toMatchObject({ cardId: id, revisionId: 'old-version', revisionSequence: 3, status: 'current', reference: { sequence: 3 } });
    expect(fixture.reads.filter((path) => path.startsWith('/api/archive/v2/cards/'))).toEqual(expect.arrayContaining(['/api/archive/v2/cards/source?version=old-version']));
    expect(fixture.reads.some((path) => path.startsWith('/api/archive/v2/cards/') && !path.includes('version=old-version'))).toBe(false);
    expect(await database.store.listCards(workspaceId)).toEqual([]);
    expect((await readdir(directory, { recursive: true, withFileTypes: true })).filter((item) => item.isFile())).toEqual([]);
    expect(await chat.scan(alice, workspaceId, target.id)).toEqual({ found: 1 });
    expect((await chat.placements(alice, workspaceId, [id]))[0]).toMatchObject({ status: 'current' });

    await chat.forget(alice, workspaceId, target.id, sent.remoteId);
    expect(await chat.placements(alice, workspaceId, [id])).toEqual([]);
    expect(await chat.scan(alice, workspaceId, target.id)).toEqual({ found: 1 });
    st.files.set('renamed.png', st.files.get(sent.remoteId)!); st.files.delete(sent.remoteId);
    await chat.scan(alice, workspaceId, target.id);
    expect((await chat.placements(alice, workspaceId, [id])).map((row) => [row.remoteId, row.status])).toEqual([['renamed.png', 'current'], [sent.remoteId, 'missing']]);
    (st.files.get('renamed.png')!.data as { description: string }).description = 'Edited remotely';
    await chat.scan(alice, workspaceId, target.id);
    expect((await chat.placements(alice, workspaceId, [id]))[0]).toMatchObject({ status: 'edited' });
    await expect(chat.send(alice, workspaceId, id, target.id)).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
    expect(await chat.send(alice, workspaceId, id, target.id, { overwriteEdited: true })).toMatchObject({ remoteId: 'renamed.png', status: 'current' });
    st.files.clear();
    await chat.scan(alice, workspaceId, target.id);
    expect((await chat.placements(alice, workspaceId, [id])).every((item) => item.status === 'missing')).toBe(true);
    expect(await database.store.listCards(workspaceId)).toEqual([]);
    expect((await readdir(directory, { recursive: true, withFileTypes: true })).filter((item) => item.isFile())).toEqual([]);
  });

  it('imports a reviewed Archive copy as a lightweight owned fork and leaves the pinned original read-only', async () => {
    const fixture = await referenceFixture();
    const target = await chat.addTarget(alice, workspaceId, { kind: 'sillytavern', baseUrl: 'http://st.test', credentials: {} });
    const sent = await chat.send(alice, workspaceId, fixture.reference.id, target.id);
    (st.files.get(sent.remoteId)!.data as Record<string, unknown>).description = 'Archived copy edited remotely.';
    const review = await chat.reviewEdit(alice, workspaceId, target.id, sent.remoteId);
    expect(await cards.list(alice, workspaceId)).toHaveLength(0);
    const result = await chat.acceptEdit(alice, workspaceId, target.id, review);
    expect((await cards.open(alice, workspaceId, result.cardId)).revision.document.data).toMatchObject({ description: 'Archived copy edited remotely.' });
    expect((await cards.open(alice, workspaceId, fixture.reference.id)).revision.document.data).toMatchObject({ description: 'An archived map keeper.' });
    expect(await database.store.getArchiveForkSource(workspaceId, result.cardId)).toMatchObject({ referenceId: fixture.reference.id, pin: fixture.reference.pin });
    expect((await readdir(directory, { recursive: true, withFileTypes: true })).filter((item) => item.isFile())).toEqual([]);
    expect(await chat.acceptEdit(alice, workspaceId, target.id, review)).toMatchObject({ cardId: result.cardId, duplicate: true });
    const forged = structuredClone((await cards.open(alice, workspaceId, fixture.reference.id)).revision.document);
    (forged.data as Record<string, unknown>).description = 'A separate Archive fork.';
    (forged.data as Record<string, unknown>).extensions = { foundry: { local: { unityChatImport: { receiptHash: 'e'.repeat(64) } } } };
    const ordinary = await cards.forkAssets(alice, workspaceId, fixture.reference.id, 'old-version', forged, [], []);
    expect(JSON.stringify(ordinary.revision.document)).not.toContain('unityChatImport');
  });

  it('atomically refuses a target removed during the final Archive fork commit', async () => {
    const fixture = await referenceFixture();
    const target = await chat.addTarget(alice, workspaceId, { kind: 'sillytavern', baseUrl: 'http://st.test', credentials: {} });
    const sent = await chat.send(alice, workspaceId, fixture.reference.id, target.id);
    (st.files.get(sent.remoteId)!.data as Record<string, unknown>).description = 'Remote edit.';
    const review = await chat.reviewEdit(alice, workspaceId, target.id, sent.remoteId);
    const guarded = createChatService({ ...database.store, async createArchiveFork(input) {
      await chat.removeTarget(alice, workspaceId, target.id);
      return database.store.createArchiveFork(input);
    } }, database.chat, assets, (connection) => createChatApp(connection, st.fetcher), { archive: fixture.archive });
    await expect(guarded.acceptEdit(alice, workspaceId, target.id, review)).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
    expect(await cards.list(alice, workspaceId)).toEqual([]);
  });

  it('rejects unavailable/unlinked or foreign-workspace references before a remote upload', async () => {
    const fixture = await referenceFixture();
    const target = await chat.addTarget(alice, workspaceId, { kind: 'sillytavern', baseUrl: 'http://st.test:8100', credentials: {} });
    await expect(chat.send({ id: 'bob', uri: 'urn:bob' }, workspaceId, fixture.reference.id, target.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const other = await cards.createWorkspace(alice, 'Other');
    const otherTarget = await chat.addTarget(alice, other.id, { kind: 'sillytavern', baseUrl: 'http://st.test:8100', credentials: {} });
    await expect(chat.send(alice, other.id, fixture.reference.id, otherTarget.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    fixture.unavailable();
    await expect(chat.send(alice, workspaceId, fixture.reference.id, target.id)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    expect(st.calls).toEqual([]);
  });

  it('rechecks reference membership after reading and does not send a reference unlinked during export', async () => {
    const fixture = await referenceFixture();
    const target = await chat.addTarget(alice, workspaceId, { kind: 'sillytavern', baseUrl: 'http://st.test:8100', credentials: {} });
    fixture.onRead(async () => { await database.store.removeArchiveReference(workspaceId, fixture.reference.id); });
    await expect(chat.send(alice, workspaceId, fixture.reference.id, target.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(st.calls).toEqual([]);
    expect(await database.store.listCards(workspaceId)).toEqual([]);
  });
});
