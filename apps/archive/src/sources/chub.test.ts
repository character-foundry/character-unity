import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runScrape } from '@character-unity/scraper-kit';
import { openNativeArchive } from '../native/store.js';
import type { NativeArchive } from '../native/store.js';
import { chub } from './chub.js';

const encoder = new TextEncoder();
const card = (name: string) => encoder.encode(JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: {
  name, description: `${name} keeps maps.`, personality: '', scenario: '', first_mes: 'Hi.', mes_example: '', creator_notes: '', system_prompt: '',
  post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '1', extensions: {} } }));
function portrait(seed: number) {
  const bytes = new Uint8Array(60_000);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, 800); new DataView(bytes.buffer).setUint32(20, 1200);
  bytes[59_999] = seed;
  return bytes;
}
const node = (id: number, extra: Record<string, unknown> = {}) => ({ id, name: `Card ${id}`, fullPath: `maker${id % 2}/card-${id}`, nTokens: 900,
  topics: ['Fantasy'], starCount: id, n_favorites: 2, nChats: 3, nMessages: 4, lastActivityAt: '2026-05-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z',
  max_res_url: `https://avatars.chub.test/avatars/maker/card-${id}/chara_card_v2.webp`, related_lorebooks: [], tagline: `Tagline ${id}`, ...extra });

/** A fake Chub: search, timeline, repository files, card images and galleries. */
function fakeChub() {
  const requests: string[] = [];
  const state = {
    search: [node(1), node(2), node(88), node(3, { fullPath: 'spammer/card-3' })] as Record<string, unknown>[],
    timeline: [node(5, { projectSpace: 'characters' }), node(6, { projectSpace: 'lorebooks' }), node(7, { labels: [{ title: 'Forked' }] })] as Record<string, unknown>[],
    noJson: new Set<number>([2]), oldJson: new Set<number>(), headers: [] as Headers[], redirects: [] as (RequestRedirect | undefined)[],
  };
  const fetch = async (url: string, init?: RequestInit) => {
    requests.push(url);
    state.headers.push(new Headers(init?.headers));
    state.redirects.push(init?.redirect);
    const parsed = new URL(url);
    if (parsed.pathname === '/search') {
      const username = parsed.searchParams.get('username');
      const nodes = username ? state.search.filter((item) => String(item.fullPath).startsWith(`${username}/`)) : state.search;
      return Response.json({ data: { nodes: parsed.searchParams.get('page') === '1' ? nodes : [] } });
    }
    if (parsed.pathname === '/api/timeline/v1') return Response.json({ data: { nodes: parsed.searchParams.get('page') === '1' ? state.timeline : [] } });
    const repo = parsed.pathname.match(/^\/api\/v4\/projects\/(\d+)\/repository\/files\/(.+)\/raw$/);
    if (repo) {
      const id = Number(repo[1]);
      if (repo[2] === 'card_v2.json' && !state.noJson.has(id) && !state.oldJson.has(id)) return new Response(card(`Card ${id}`));
      if (repo[2] === 'card.json' && state.oldJson.has(id)) return new Response(card(`Card ${id} (old)`));
      return new Response('missing', { status: 404 });
    }
    if (parsed.pathname.startsWith('/api/gallery/project/')) return Response.json({ nodes: parsed.pathname.endsWith('/1') ? [{ id: 'g' }] : [] });
    const image = parsed.pathname.match(/card-(\d+)\/chara_card_v2\.png$/);
    if (image) {
      const id = Number(image[1]);
      // Card 2 has no repository JSON: its card image embeds the card instead.
      if (state.noJson.has(id)) return new Response(new Uint8Array(await embedded(`Card ${id}`)));
      return new Response(portrait(id));
    }
    return new Response('not found', { status: 404 });
  };
  return { fetch, requests, state };
}

async function embedded(name: string) {
  const { embedIntoPNG } = await import('@character-foundry/character-foundry/png');
  const base = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89,
    0, 0, 0, 13, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0, 0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99, 0x3d, 0x1d,
    0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  return embedIntoPNG(base, JSON.parse(new TextDecoder().decode(card(name))) as never);
}

describe('Chub source', () => {
  let directory: string, archive: NativeArchive;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'unity-chub-')); archive = await openNativeArchive(directory); });
  afterEach(async () => { archive.close(); await rm(directory, { recursive: true, force: true }); });
  const run = (fake: ReturnType<typeof fakeChub>, settings: Record<string, unknown> = {}, secrets: Record<string, string> = {}) =>
    runScrape(chub, archive.sink, { fetch: fake.fetch, sleep: async () => undefined, settings: { blockedCreators: ['spammer'], ...settings }, secrets });

  it('stores search results with their files, skips placeholders and blocked creators, and only refetches changed cards', async () => {
    const fake = fakeChub();
    expect(await run(fake)).toMatchObject({ status: 'done', listed: 2, added: 2, errors: 0 });
    const cards = archive.list({ sort: 'name' }).cards;
    expect(cards.map((item) => [item.id, item.name, item.creator, item.url])).toEqual([
      ['chub:1', 'Card 1', 'maker1', 'https://chub.ai/characters/maker1/card-1'],
      ['chub:2', 'Card 2', 'maker0', 'https://chub.ai/characters/maker0/card-2'],
    ]);
    expect(cards[0]).toMatchObject({ tags: ['Fantasy'], tagline: 'Tagline 1', stats: { stars: 1, favorites: 2, chats: 3, messages: 4 }, flags: { gallery: true } });
    expect(cards[0]!.portrait).not.toBeNull();
    const detail = await archive.card('chub:1');
    expect(detail.versionList[0]!.objects.map((object) => `${object.role}:${object.name}`)).toEqual(['card:card_v2.json', 'portrait:chara_card_v2.png', 'raw:node.json']);
    // Card 2 had no repository JSON, so its card image is the card.
    expect((await archive.card('chub:2')).versionList[0]!.objects.map((object) => `${object.role}:${object.name}`)).toEqual(['card:chara_card_v2.png', 'raw:node.json']);
    expect(fake.requests.some((url) => url.includes('/projects/88/') || url.includes('/projects/3/'))).toBe(false);
    expect(fake.state.headers[0]!.get('origin')).toBe('https://chub.ai');

    // Same update time: no card requests, but fresh stats.
    fake.requests.length = 0;
    fake.state.search[0] = node(1, { starCount: 77 });
    expect(await run(fake)).toMatchObject({ listed: 2, unchanged: 2, added: 0 });
    expect(fake.requests.every((url) => url.includes('/search'))).toBe(true);
    expect(archive.list({ sort: 'stars' }).cards[0]!.stats.stars).toBe(77);

    // A newer update time is fetched again; identical bytes do not make a new version.
    fake.state.search[0] = node(1, { lastActivityAt: '2026-06-01T00:00:00Z' });
    expect(await run(fake)).toMatchObject({ unchanged: 2 });
    expect((await archive.card('chub:1')).versions).toBe(1);
  });

  it('never fetches a blocked record again', async () => {
    const fake = fakeChub();
    await run(fake);
    archive.block('chub', '1');
    fake.requests.length = 0;
    fake.state.search[0] = node(1, { lastActivityAt: '2027-01-01T00:00:00Z' });
    expect(await run(fake)).toMatchObject({ blocked: 1 });
    expect(fake.requests.some((url) => url.includes('/projects/1/'))).toBe(false);
  });

  it('falls back to card.json, follows creators, and needs a key for the timeline', async () => {
    const fake = fakeChub();
    fake.state.oldJson.add(1);
    expect(await run(fake, { followedOnly: true, followedCreators: ['maker1'] })).toMatchObject({ added: 1, listed: 1 });
    expect(archive.list().cards.map((item) => item.name)).toEqual(['Card 1 (old)']);
    expect(fake.requests.find((url) => url.includes('username=maker1'))).toContain('sort=created_at');

    expect(await run(fake, { mode: 'timeline' })).toMatchObject({ status: 'failed', error: 'Chub timeline mode needs an API key' });
    const keyed = await run(fake, { mode: 'timeline' }, { apiKey: 'secret' });
    expect(keyed).toMatchObject({ status: 'done', listed: 1, added: 1 });
    expect(fake.state.headers.at(-1)!.get('ch-api-key')).toBe('secret');
  });

  it('sends the search filters Chub expects', async () => {
    const fake = fakeChub();
    await run(fake, { topics: ['Fantasy', 'Elf'], excludeTopics: ['Gore'], minTokens: 300, nsfw: false, perPage: 20, sort: 'created_at' });
    const search = new URL(fake.requests[0]!).searchParams;
    expect(Object.fromEntries(search)).toMatchObject({ topics: 'Fantasy,Elf', excludetopics: 'Gore', min_tokens: '300', nsfw: 'false', nsfl: 'false', first: '20', sort: 'created_at', namespace: 'characters' });
  });

  it('sends account keys only to gateway requests and refuses redirects for those requests', async () => {
    const fake = fakeChub();
    fake.state.search = [node(1, { related_lorebooks: [42] })];
    expect(await run(fake, {}, { apiKey: ' secret ' })).toMatchObject({ status: 'done', added: 1, errors: 0 });
    expect(chub.headers?.({ apiKey: 'secret' })).not.toHaveProperty('samwise');
    expect(chub.headers?.({ apiKey: 'secret' })).not.toHaveProperty('CH-API-KEY');
    const gatewayPaths: string[] = [];
    let avatarCalls = 0;
    for (const [index, url] of fake.requests.entries()) {
      const headers = fake.state.headers[index]!;
      const parsed = new URL(url);
      if (parsed.origin === 'https://gateway.chub.ai') {
        gatewayPaths.push(parsed.pathname);
        expect(headers.get('samwise')).toBe('secret');
        expect(headers.get('ch-api-key')).toBe('secret');
        expect(fake.state.redirects[index]).toBe('error');
      } else {
        avatarCalls++;
        expect(headers.has('samwise')).toBe(false);
        expect(headers.has('ch-api-key')).toBe(false);
      }
    }
    expect(avatarCalls).toBe(1);
    expect(gatewayPaths).toEqual(expect.arrayContaining([
      '/search', '/api/v4/projects/1/repository/files/card_v2.json/raw',
      '/api/v4/projects/42/repository/files/raw%252Fsillytavern_raw.json/raw', '/api/gallery/project/1',
    ]));
  });
});
