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
import { hashBytes } from '@character-foundry/character-foundry/identity';

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
      if (form.get('file_type') !== 'json') return Response.json({ error: true });
      const stored = JSON.parse(await file.text()) as Record<string, unknown>;
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
