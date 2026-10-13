import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '@character-unity/api';
import { createNativeArchiveService } from '@character-unity/cards/native-archive';
import type { ScraperPlugin } from '@character-unity/scraper-kit';
import { openNativeArchive } from '../../archive/src/native/store.js';
import type { NativeArchive } from '../../archive/src/native/store.js';
import { createScheduler } from '../../archive/src/native/scheduler.js';
import { createNativeArchiveApp } from '../../archive/src/native/app.js';
import { openLocalServices } from './services.js';

const actor = { id: 'alice', uri: 'urn:unity:user:alice' };
const token = 'native-archive-admin-token-0123456789';
const encoder = new TextEncoder();
const portrait = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64'));
const card = (name: string) => encoder.encode(JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name, description: `${name} keeps maps.`,
  personality: '', scenario: '', first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
  alternate_greetings: [], tags: ['Fantasy'], creator: 'ash', character_version: '1', extensions: {} } }));

const demo: ScraperPlugin = {
  provider: 'chub', label: 'Demo Chub', minIntervalMs: 0, settings: [{ key: 'pages', label: 'Pages', type: 'number', default: 1, min: 1, max: 9 }],
  secrets: [{ key: 'apiKey', label: 'API key' }],
  async *discover() { yield { recordId: '101' }; yield { recordId: '102' }; },
  async fetch(_context, listing) {
    return { provider: 'chub', recordId: listing.recordId, url: `https://chub.ai/characters/ash/${listing.recordId}`, creator: 'ash',
      objects: [{ role: 'card', bytes: card(`Card ${listing.recordId}`), mediaType: 'application/json' }, { role: 'portrait', bytes: portrait, mediaType: 'image/png' }] };
  },
};

describe('native Archive through the API', () => {
  let directory: string, archive: NativeArchive, services: Awaited<ReturnType<typeof openLocalServices>>, workspace: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'unity-native-api-'));
    archive = await openNativeArchive(join(directory, 'archive'));
    services = await openLocalServices({ databasePath: ':memory:', blobDirectory: join(directory, 'blobs') });
    workspace = (await services.cards.createWorkspace(actor, 'Library')).id;
  });
  afterEach(async () => { services.close(); archive.close(); await rm(directory, { recursive: true, force: true }); });

  function setup() {
    const scheduler = createScheduler(archive, [demo]);
    const archiveApp = createNativeArchiveApp(archive, scheduler, [demo], { adminToken: token });
    const nativeArchive = createNativeArchiveService(services.cards, { origin: 'http://archive.test', adminToken: token,
      fetch: async (url, init) => archiveApp.fetch(new Request(url, init)) });
    const api = createApi({ cards: services.cards, nativeArchive, authenticate: () => actor });
    const call = (path: string, init?: RequestInit) => api.request(`/api/workspaces/${workspace}/archive/v2${path}`, init);
    return { scheduler, call };
  }

  it('drives a scrape from Settings, browses the result and adds a card to the library once', async () => {
    const { scheduler, call } = setup();
    const saved = await call('/sources/chub', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, secrets: { apiKey: 'shh' } }) });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(await saved.json())).not.toContain('shh');
    expect((await call('/sources/chub/runs', { method: 'POST' })).status).toBe(202);
    await scheduler.settled('chub');
    expect((await (await call('/runs?provider=chub')).json() as { runs: { status: string; added: number }[] }).runs[0]).toMatchObject({ status: 'done', added: 2 });

    const page = await (await call('/cards?sort=name')).json() as { total: number; cards: { id: string; libraryCardId: string | null; portrait: string }[] };
    expect(page.total).toBe(2);
    expect(page.cards.map((item) => [item.id, item.libraryCardId])).toEqual([['chub:101', null], ['chub:102', null]]);
    const image = await call(`/objects/${page.cards[0]!.portrait}`);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(portrait);

    const imported = await call('/cards/chub:101/import', { method: 'POST' });
    expect(imported.status).toBe(201);
    const { cardId, created } = await imported.json() as { cardId: string; created: boolean };
    expect(created).toBe(true);
    // A second add returns the same library card.
    expect(await (await call('/cards/chub:101/import', { method: 'POST' })).json()).toEqual({ cardId, created: false });
    const after = await (await call('/cards?sort=name')).json() as { cards: { id: string; libraryCardId: string | null }[] };
    expect(after.cards[0]!.libraryCardId).toBe(cardId);

    // In the library: source chub, the portrait came along, provenance names the Archive version.
    const summary = (await services.cards.summaries(actor, workspace, {})).cards.find((item) => item.id === cardId)!;
    expect(summary).toMatchObject({ name: 'Card 101', source: 'chub', hasPortrait: true });
    const opened = await services.cards.open(actor, workspace, cardId);
    expect(opened.source?.provenance).toMatchObject({ kind: 'archive', contract: 'unity.archive.native.v1', cardId: 'chub:101',
      source: { provider: 'chub', recordId: '101', url: 'https://chub.ai/characters/ash/101' } });

    // Deleting the library copy makes the Archive card addable again.
    await services.cards.delete(actor, workspace, cardId);
    expect((await (await call('/cards?sort=name')).json() as { cards: { libraryCardId: string | null }[] }).cards[0]!.libraryCardId).toBeNull();
  });

  it('passes Archive errors through and filters followed creators from the library', async () => {
    const { scheduler, call } = setup();
    await call('/sources/chub/runs', { method: 'POST' });
    await scheduler.settled('chub');
    expect((await call('/cards/chub:999')).status).toBe(404);
    expect((await call('/cards?has=bogus')).status).toBe(400);
    expect((await call('/cards?creators=ash')).status).toBe(400);
    expect((await (await call('/cards?has=followed')).json() as { total: number }).total).toBe(0);
    await services.cards.follow(actor, workspace, 'Ash', true);
    expect((await (await call('/cards?has=followed')).json() as { total: number }).total).toBe(2);
    expect((await call('/cards/chub:102/block', { method: 'POST' })).status).toBe(200);
    expect((await (await call('/cards')).json() as { total: number }).total).toBe(1);
  });

  it('adds large cards (past the old 32 MB limit) and refuses ones over the library limit before downloading', async () => {
    const { scheduler, call } = setup();
    await call('/sources/chub/runs', { method: 'POST' });
    await scheduler.settled('chub');
    // A 33 MB portrait on top of the card: RisuAI-sized, and it goes in whole.
    const big = new Uint8Array(33 * 1024 * 1024); big.set(portrait);
    await archive.put({ provider: 'chub', recordId: '103', url: 'https://chub.ai/characters/ash/103',
      objects: [{ role: 'card', bytes: card('Card 103'), mediaType: 'application/json' }, { role: 'portrait', bytes: big, mediaType: 'image/png' }] });
    const added = await call('/cards/chub:103/import', { method: 'POST' });
    expect(await added.json()).toMatchObject({ created: true });

    // Over the limit: refused from the card's file list, so nothing is downloaded.
    const downloads: string[] = [];
    const detail = { id: 'risuai:huge', provider: 'risuai', recordId: 'huge', url: 'https://realm.risuai.net/character/huge', versionId: 'v1',
      versionList: [{ id: 'v1', objects: [{ role: 'card', name: 'card.charx', sha256: 'a'.repeat(64), mediaType: 'application/zip', byteLength: 600 * 1024 * 1024 }] }] };
    const huge = createNativeArchiveService(services.cards, { origin: 'http://archive.test', fetch: async (url) => {
      if (url.includes('/objects/')) downloads.push(url);
      return Response.json(detail);
    } });
    await expect(huge.import(actor, workspace, 'risuai:huge')).rejects.toMatchObject({ code: 'TOO_LARGE', message: expect.stringContaining('stays in the Archive only') });
    expect(downloads).toEqual([]);
  });

  it('reports an unreachable Archive as unavailable', async () => {
    const nativeArchive = createNativeArchiveService(services.cards, { origin: 'http://archive.test', fetch: async () => { throw new Error('refused'); } });
    const api = createApi({ cards: services.cards, nativeArchive, authenticate: () => actor });
    const response = await api.request(`/api/workspaces/${workspace}/archive/v2/status`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'UNAVAILABLE' } });
  });
});
