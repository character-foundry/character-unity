import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openNodeStore } from '@character-unity/store/node';
import { createNodeBlobStore } from '@character-unity/blob-store/node';
import { createAssetService } from '@character-unity/assets';
import { createChatApp } from '@character-unity/chat-apps';
import type { ChatKind } from '@character-unity/chat-apps';
import type { CardDocument } from '@character-unity/store';
import { createCardService } from '../src/index.js';
import { createChatService } from '../src/chat.js';

const alice = { id: 'alice', uri: 'urn:unity:user:alice' };
const card = (name: string, description: string): CardDocument => ({ spec: 'chara_card_v2', spec_version: '2.0', data: {
  name, description, personality: '', scenario: '', first_mes: 'Hello.', mes_example: '', creator_notes: '',
  system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: ['forest'], creator: 'Fixture',
  character_book: { entries: [{ keys: ['map'], content: 'Maps.', enabled: true, insertion_order: 0 }] },
  character_version: '1', extensions: {},
} });
type Stored = Record<string, unknown> & { id: string; extensions: Record<string, unknown> };
const textFields = ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator', 'creator_notes', 'system_prompt', 'post_history_instructions', 'tags', 'alternate_greetings'];
const json = (body: unknown, status = 200) => Response.json(body, { status });

/** Lumiverse-shaped: Better Auth bearer sessions, paged list, replace-card that keeps name/avatar and app-local extensions. */
function fakeLumiverse(options: { auth: boolean }) {
  const characters = new Map<string, Stored>(); let next = 1; const calls: string[] = [];
  const fetcher = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input), method = init.method ?? 'GET'; calls.push(`${method} ${url.pathname}`);
    if (url.pathname === '/api/auth/sign-in/username') {
      const body = JSON.parse(String(init.body)) as { username: string; password: string };
      return body.username === 'vega' && body.password === 'pw' ? new Response('{}', { headers: { 'set-auth-token': 'session-1' } }) : json({ error: 'bad' }, 401);
    }
    if (options.auth && new Headers(init.headers).get('authorization') !== 'Bearer session-1') return json({ error: 'Unauthorized' }, 401);
    const path = url.pathname.replace('/api/v1/characters', '');
    if (path === '' && method === 'GET') {
      const all = [...characters.values()], offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'));
      return json({ data: all.slice(offset, offset + limit), total: all.length, limit, offset });
    }
    const fileCard = async () => (JSON.parse(await ((init.body as FormData).get('file') as File).text()) as { data: Record<string, unknown> }).data;
    if (path === '/import' && method === 'POST') {
      const data = await fileCard(); const id = `uuid-${next++}`;
      const stored: Stored = { id, name: data.name, ...Object.fromEntries(textFields.map((key) => [key, data[key]])),
        extensions: { ...data.extensions as object, _lumiverse_source_filename: 'x' }, avatar_path: null, updated_at: 1 };
      characters.set(id, stored);
      return json({ character: stored }, 201);
    }
    const [, id, action] = path.split('/');
    const stored = characters.get(id!);
    if (!stored) return json({ error: 'Not found' }, 404);
    if (action === 'replace-card') {
      const data = await fileCard();
      const preserved = Object.fromEntries(Object.entries(stored.extensions).filter(([key]) => key.startsWith('_lumiverse_')));
      Object.assign(stored, Object.fromEntries(textFields.map((key) => [key, data[key]])), { extensions: { ...data.extensions as object, ...preserved } });
      return json(stored);
    }
    if (action === 'avatar') { stored.avatar_path = 'new.png'; return json(stored); }
    if (method === 'PUT') { Object.assign(stored, JSON.parse(String(init.body))); return json(stored); }
    return json(stored);
  };
  return { characters, calls, fetcher };
}

/** Marinara-shaped: CSRF header on writes, data stored as a JSON string, 200 {success:false} import failures, PATCH updates. */
function fakeMarinara() {
  const characters = new Map<string, { id: string; data: string; avatarPath: string | null }>(); let next = 1; const calls: string[] = [];
  const fetcher = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input), method = init.method ?? 'GET'; calls.push(`${method} ${url.pathname}`);
    if (method !== 'GET' && new Headers(init.headers).get('x-marinara-csrf') !== '1') return json({ error: 'Missing x-marinara-csrf header' }, 403);
    if (url.pathname === '/api/characters' && method === 'GET') return json([...characters.values()]);
    if (url.pathname === '/api/import/st-character') {
      let parsed: { data?: Record<string, unknown> };
      try { parsed = JSON.parse(await ((init.body as FormData).get('file') as File).text()) as typeof parsed; } catch { return json({ success: false, error: 'Bad card' }); }
      const id = `m${next++}`;
      characters.set(id, { id, avatarPath: null, data: JSON.stringify({ ...parsed.data, extensions: { ...parsed.data!.extensions as object, importMetadata: { source: 'st' } } }) });
      return json({ success: true, characterId: id, name: parsed.data!.name });
    }
    const [, , , id, action] = url.pathname.split('/');
    const stored = characters.get(id!);
    if (!stored) return json({ error: 'Character not found' }, 404);
    if (action === 'avatar') { stored.avatarPath = '/api/avatars/file/x.png'; return json({ ok: true }); }
    if (method === 'PATCH') {
      const { data } = JSON.parse(String(init.body)) as { data: Record<string, unknown> };
      stored.data = JSON.stringify({ ...JSON.parse(stored.data) as object, ...data });
      return json(stored);
    }
    return json(stored);
  };
  const edit = (id: string, change: Record<string, unknown>) => { const stored = characters.get(id)!; stored.data = JSON.stringify({ ...JSON.parse(stored.data) as object, ...change }); };
  return { characters, calls, fetcher, edit };
}

describe.each<{ kind: ChatKind; credentials: Record<string, string> }>([
  { kind: 'lumiverse', credentials: { username: 'vega', password: 'pw' } },
  { kind: 'marinara', credentials: {} },
])('chat service with a $kind-shaped app', ({ kind, credentials }) => {
  let directory: string;
  let database: Awaited<ReturnType<typeof openNodeStore>>;
  let cards: ReturnType<typeof createCardService>;
  let chat: ReturnType<typeof createChatService>;
  let lumi: ReturnType<typeof fakeLumiverse>, marinara: ReturnType<typeof fakeMarinara>;
  let workspaceId: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'unity-chat-'));
    database = await openNodeStore(':memory:');
    const assets = createAssetService(database.store, await createNodeBlobStore(directory));
    cards = createCardService(database.store, assets);
    lumi = fakeLumiverse({ auth: true }); marinara = fakeMarinara();
    chat = createChatService(database.store, database.chat, assets, (connection) => createChatApp(connection, kind === 'lumiverse' ? lumi.fetcher : marinara.fetcher));
    workspaceId = (await cards.createWorkspace(alice, 'Library')).id;
  });
  afterEach(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });

  const remoteName = (id: string) => kind === 'lumiverse' ? lumi.characters.get(id)!.name : (JSON.parse(marinara.characters.get(id)!.data) as { name: string }).name;
  const editInApp = (id: string) => {
    if (kind === 'lumiverse') lumi.characters.get(id)!.description = 'Rewritten inside Lumiverse.';
    else marinara.edit(id, { description: 'Rewritten inside Marinara.' });
  };
  const deleteInApp = (id: string) => { if (kind === 'lumiverse') lumi.characters.delete(id); else marinara.characters.delete(id); };
  const appExtensions = (id: string) => kind === 'lumiverse' ? lumi.characters.get(id)!.extensions : (JSON.parse(marinara.characters.get(id)!.data) as { extensions: Record<string, unknown> }).extensions;

  it('sends, updates in place (name included), tracks head, detects in-app edits and vanished copies', async () => {
    const target = await chat.addTarget(alice, workspaceId, { kind, baseUrl: `http://${kind}.test:7000`, credentials });
    expect(await chat.check(alice, workspaceId, target.id)).toEqual({ characters: 0 });
    const imported = await cards.import(alice, workspaceId, new TextEncoder().encode(JSON.stringify(card('Aster', 'A map keeper.'))));
    const id = imported.card.id;

    const first = await chat.send(alice, workspaceId, id, target.id);
    expect(first).toMatchObject({ status: 'current', revisionId: imported.revision.id });
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(appExtensions(first.remoteId).foundry).toBeTruthy();
    // Scanning an untouched copy keeps it current: the app's own bookkeeping is not an edit.
    expect(await chat.scan(alice, workspaceId, target.id)).toEqual({ found: 1 });
    expect((await chat.placements(alice, workspaceId, [id]))[0]).toMatchObject({ status: 'current', remoteId: first.remoteId });

    const saved = await cards.save(alice, workspaceId, id, imported.revision.id, card('Aster Vale', 'A map keeper, now older.'));
    await chat.scan(alice, workspaceId, target.id);
    expect((await chat.placements(alice, workspaceId, [id]))[0]).toMatchObject({ status: 'behind', revisionSequence: 1, headSequence: 2 });

    const updated = await chat.send(alice, workspaceId, id, target.id);
    expect(updated).toMatchObject({ remoteId: first.remoteId, status: 'current', revisionId: saved.id });
    expect(remoteName(first.remoteId)).toBe('Aster Vale');
    // App-local extension keys survive an update.
    expect(Object.keys(appExtensions(first.remoteId))).toEqual(expect.arrayContaining(['foundry', kind === 'lumiverse' ? '_lumiverse_source_filename' : 'importMetadata']));
    await chat.scan(alice, workspaceId, target.id);
    expect((await chat.placements(alice, workspaceId, [id]))[0]).toMatchObject({ status: 'current' });

    editInApp(first.remoteId);
    await chat.scan(alice, workspaceId, target.id);
    expect((await chat.placements(alice, workspaceId, [id]))[0]).toMatchObject({ status: 'edited' });
    await expect(chat.send(alice, workspaceId, id, target.id)).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
    expect(await chat.send(alice, workspaceId, id, target.id, { overwriteEdited: true })).toMatchObject({ remoteId: first.remoteId, status: 'current' });
    await chat.scan(alice, workspaceId, target.id);
    expect((await chat.placements(alice, workspaceId, [id]))[0]).toMatchObject({ status: 'current' });

    deleteInApp(first.remoteId);
    await chat.scan(alice, workspaceId, target.id);
    expect((await chat.placements(alice, workspaceId, [id]))[0]).toMatchObject({ status: 'missing' });
  });

  it('finds copies of library cards that were already in the app and ignores unrelated characters', async () => {
    const target = await chat.addTarget(alice, workspaceId, { kind, baseUrl: `http://${kind}.test:7000`, credentials });
    const imported = await cards.import(alice, workspaceId, new TextEncoder().encode(JSON.stringify(card('Aster', 'A map keeper.'))));
    const sent = await chat.send(alice, workspaceId, imported.card.id, target.id);
    await chat.forget(alice, workspaceId, target.id, sent.remoteId);
    expect(await chat.placements(alice, workspaceId, [imported.card.id])).toEqual([]);
    expect(await chat.scan(alice, workspaceId, target.id)).toEqual({ found: 1 });
    expect((await chat.placements(alice, workspaceId, [imported.card.id]))[0]).toMatchObject({ remoteId: sent.remoteId, status: 'current' });
  });
});

describe('field-updating app connections', () => {
  it('signs in to Lumiverse with a username and password, or uses a pasted token, and reports bad logins', async () => {
    const lumi = fakeLumiverse({ auth: true });
    const login = createChatApp({ kind: 'lumiverse', baseUrl: 'http://lumi.test', credentials: { username: 'vega', password: 'pw' } }, lumi.fetcher);
    expect(await login.check()).toEqual({ characters: 0 });
    expect(lumi.calls[0]).toBe('POST /api/auth/sign-in/username');
    const pasted = createChatApp({ kind: 'lumiverse', baseUrl: 'http://lumi.test', credentials: { apiKey: 'session-1' } }, lumi.fetcher);
    expect(await pasted.check()).toEqual({ characters: 0 });
    const wrong = createChatApp({ kind: 'lumiverse', baseUrl: 'http://lumi.test', credentials: { username: 'vega', password: 'nope' } }, lumi.fetcher);
    await expect(wrong.check()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const open = createChatApp({ kind: 'lumiverse', baseUrl: 'http://lumi.test', credentials: {} }, fakeLumiverse({ auth: false }).fetcher);
    expect(await open.check()).toEqual({ characters: 0 });
  });

  it('sends the Marinara CSRF header and surfaces 200 {success:false} import failures', async () => {
    const marinara = fakeMarinara();
    const client = createChatApp({ kind: 'marinara', baseUrl: 'http://marinara.test', credentials: {} }, marinara.fetcher);
    await expect(client.upload({ bytes: new TextEncoder().encode('not json'), type: 'json', fileName: 'x.json', card: {}, portrait: null }, { preferredName: 'x' }))
      .rejects.toMatchObject({ code: 'REJECTED', message: expect.stringContaining('Bad card') });
  });
});
