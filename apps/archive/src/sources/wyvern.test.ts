import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runScrape } from '@character-unity/scraper-kit';
import { openNativeArchive } from '../native/store.js';
import type { NativeArchive } from '../native/store.js';
import { wyvern } from './wyvern.js';

const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 9, 9, 9, 9]);
const listItem = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `Card ${id}`, updated_at: '2026-05-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z',
  statistics_record: { likes: 5, follows: 6, views: 7, messages: 8 }, ...extra });
const character = (id: string, extra: Record<string, unknown> = {}) => ({
  ...listItem(id), description: `${id} guards the tower.`, personality: 'stern', scenario: 'A tower.', first_mes: 'Halt.', mes_example: '<START> hi',
  alternate_greetings: ['Who goes there?'], tags: ['Fantasy', 'Knight'], creator_notes: 'notes', pre_history_instructions: 'Stay in character.',
  post_history_instructions: 'Be brief.', visual_description: 'Tall, armored.', rating: 'explicit', sprite_set: { neutral: 'x' }, commands: [], scripts: [],
  gallery: [{ url: 'g' }], avatar: `https://files.wyvern.test/${id}.webp`, creator: { displayName: 'Warden', uid: 'u1' },
  lorebooks: [{ entries: [{ keys: ['tower'], content: 'Old.' }] }, { entries: [{ keys: ['gate'], content: 'Iron.' }] }], ...extra });

/** A fake Wyvern: explore search, character records and the image proxy. */
function fakeWyvern() {
  const requests: { url: string; authorization: string | null }[] = [];
  const state = {
    pages: [[listItem('w1'), listItem('w2'), listItem('a/b'), listItem('')]] as Record<string, unknown>[][],
    characters: new Map<string, Record<string, unknown>>([['w1', character('w1')], ['w2', character('w2', { avatar: 'https://files.wyvern.test/broken.png', gallery: [], sprite_set: null })]]),
  };
  const fetch = async (url: string, init?: RequestInit) => {
    requests.push({ url, authorization: new Headers(init?.headers).get('authorization') });
    const parsed = new URL(url);
    if (parsed.host === 'api.wyvern.chat' && parsed.pathname === '/exploreSearch/characters') {
      return Response.json({ results: state.pages[Number(parsed.searchParams.get('page')) - 1] ?? [] });
    }
    const match = parsed.pathname.match(/^\/characters\/(.+)$/);
    if (parsed.host === 'api.wyvern.chat' && match) {
      const found = state.characters.get(decodeURIComponent(match[1]!));
      return found ? Response.json(found) : new Response('missing', { status: 404 });
    }
    if (parsed.host === 'app.wyvern.chat' && parsed.pathname === '/api/image-proxy') {
      const target = parsed.searchParams.get('url')!;
      return Response.json({ image: target.includes('broken') ? 'not-a-data-url' : `data:image/webp;base64,${Buffer.from(webp).toString('base64')}` });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetch, requests, state };
}

describe('Wyvern source', () => {
  let directory: string, archive: NativeArchive;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'unity-wyvern-')); archive = await openNativeArchive(directory); });
  afterEach(async () => { archive.close(); await rm(directory, { recursive: true, force: true }); });
  const run = (fake: ReturnType<typeof fakeWyvern>, settings: Record<string, unknown> = {}, secrets: Record<string, string> = {}) =>
    runScrape(wyvern, archive.sink, { fetch: fake.fetch, sleep: async () => undefined, settings, secrets });

  it('builds the card from the character record and keeps the portrait as served', async () => {
    const fake = fakeWyvern();
    expect(await run(fake)).toMatchObject({ status: 'done', listed: 2, added: 2, errors: 0 });
    const [first] = archive.list({ sort: 'name' }).cards;
    expect(first).toMatchObject({ id: 'wyvern:w1', name: 'Card w1', creator: 'Warden', url: 'https://app.wyvern.chat/characters/w1',
      tags: ['Fantasy', 'Knight', 'NSFW'], altGreetings: 1, lorebookEntries: 2, stats: { stars: 5, favorites: 6, chats: 7, messages: 8 },
      flags: { gallery: true, expressions: true, systemPrompt: true, exampleDialogues: true } });
    const detail = await archive.card('wyvern:w1');
    const data = (detail.document as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ system_prompt: 'Stay in character.', post_history_instructions: 'Be brief.', creator_notes: 'notes',
      extensions: { visual_description: 'Tall, armored.', wyvern: { id: 'w1', rating: 'explicit', sprite_set: { neutral: 'x' } } } });
    expect((data.character_book as { entries: { keys: string[] }[] }).entries.map((entry) => entry.keys[0])).toEqual(['tower', 'gate']);
    expect(data.tags).toEqual(['Fantasy', 'Knight']);
    const objects = detail.versionList[0]!.objects;
    expect(objects.map((object) => `${object.role}:${object.name}:${object.mediaType}`)).toEqual([
      'card:card.json:application/json', 'portrait:avatar.webp:image/webp', 'raw:character.json:application/json']);
    expect((await archive.object(objects[1]!.sha256)).bytes).toEqual(webp);
    // An unreadable proxy answer leaves the card without a portrait.
    const second = await archive.card('wyvern:w2');
    expect(second.versionList[0]!.objects.map((object) => object.role)).toEqual(['card', 'raw']);
    expect(second.portrait).toBeNull();
    expect(second.flags).toMatchObject({ gallery: false, expressions: false });
  });

  it('sends the bearer token on listing requests only, with the explore filters', async () => {
    const fake = fakeWyvern();
    await run(fake, { perPage: 20, order: 'ASC', rating: 'suggestive', sort: 'dateUpdated' }, { bearerToken: 'tok' });
    const listings = fake.requests.filter((request) => request.url.includes('/exploreSearch/'));
    expect(listings.every((request) => request.authorization === 'Bearer tok')).toBe(true);
    expect(fake.requests.filter((request) => !request.url.includes('/exploreSearch/')).every((request) => request.authorization === null)).toBe(true);
    expect(Object.fromEntries(new URL(listings[0]!.url).searchParams)).toEqual({ page: '1', limit: '20', sort: 'dateUpdated', order: 'ASC', rating: 'suggestive' });
  });

  it('stops at the first empty page and does not refetch unchanged cards', async () => {
    const fake = fakeWyvern();
    await run(fake, { pages: 5 });
    expect(fake.requests.filter((request) => request.url.includes('/exploreSearch/')).map((request) => new URL(request.url).searchParams.get('page'))).toEqual(['1', '2']);
    fake.requests.length = 0;
    expect(await run(fake, { pages: 5 })).toMatchObject({ listed: 2, unchanged: 2, added: 0 });
    expect(fake.requests.every((request) => request.url.includes('/exploreSearch/'))).toBe(true);
    fake.state.pages[0]![0] = listItem('w1', { updated_at: '2026-07-01T00:00:00Z', statistics_record: { likes: 99 } });
    expect(await run(fake)).toMatchObject({ unchanged: 2 });
    // Refetched (newer update time) but identical bytes: no new version.
    expect(fake.requests.some((request) => request.url.endsWith('/characters/w1'))).toBe(true);
    expect((await archive.card('wyvern:w1')).versions).toBe(1);
  });
});
