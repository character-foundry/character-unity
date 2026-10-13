import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runScrape } from '@character-unity/scraper-kit';
import { openNativeArchive } from '../native/store.js';
import type { NativeArchive } from '../native/store.js';
import { ct } from './ct.js';
import { flatten, readSvelteKitData, unflatten } from './sveltekit.js';

function png(seed: number) {
  const bytes = new Uint8Array(60_000);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, 800); new DataView(bytes.buffer).setUint32(20, 1200);
  bytes[59_999] = seed;
  return bytes;
}
const hit = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `Card ${id}`, tagline: `Tagline ${id}`, path: `Maker One/Card ${id}`,
  author: 'maker_one', contentWarnings: [], permanentTokens: 1200, ...extra });
/** A SvelteKit `__data.json` answer: a layout node, the page node, and streamed chunks for its promises. */
function sveltekit(page: Record<string, unknown>, chunks: Record<number, unknown> = {}) {
  const lines = [JSON.stringify({ type: 'data', nodes: [{ type: 'data', data: flatten({ user: null }) }, null, { type: 'data', data: flatten(page) }] }),
    ...Object.entries(chunks).map(([id, value]) => JSON.stringify({ type: 'chunk', id: Number(id), data: flatten(value) }))];
  return new Response(lines.join('\n'), { headers: { 'content-type': 'text/sveltekit-data' } });
}

/** A fake Character Tavern: catalog data, card page data (with streamed greetings and lorebook) and card images. */
function fakeCt() {
  const requests: { url: string; headers: Headers }[] = [];
  const state = {
    pages: [[hit('a1'), hit('a2')], [hit('a3')], [hit('a4')]] as Record<string, unknown>[][],
    tags: { a1: ['Fantasy', 'Elf'], a2: ['Gore'], a3: ['Fantasy'], a4: ['Fantasy'] } as Record<string, string[]>,
    warnings: { a3: ['Underage'] } as Record<string, string[]>,
    updated: '2025-05-01T00:00:00.000Z',
    status: 200,
  };
  const fetch = async (url: string, init?: RequestInit) => {
    requests.push({ url, headers: new Headers(init?.headers) });
    if (state.status !== 200) return new Response('blocked', { status: state.status });
    const parsed = new URL(url);
    if (parsed.host === 'ct-cards.storage.character-tavern.com') {
      return parsed.pathname === '/maker_one/card_a2.png' ? new Response('<html>not an image</html>') : new Response(png(1));
    }
    if (parsed.pathname === '/search/cards/__data.json') {
      const page = Number(parsed.searchParams.get('page'));
      return sveltekit({ searchResults: { hits: state.pages[page - 1] ?? [], totalHits: 4, hitsPerPage: 30, page, totalPages: state.pages.length }, page });
    }
    const detail = parsed.pathname.match(/^\/character\/maker_one\/card_(\w+)\/__data\.json$/);
    if (detail) {
      const id = detail[1]!;
      return sveltekit({
        character: { id, name: `Card ${id}`, inChatName: `Card ${id}`, tagline: `Tagline ${id}`, description: 'Creator notes here.',
          definition_character_description: `${id} keeps maps.`, definition_personality: 'calm', definition_scenario: 'a library',
          definition_first_message: 'Hello.', definition_example_messages: ['<START>', { text: 'Hi there' }], definition_system_prompt: 'Be kind.',
          definition_post_history_prompt: null, versionId: 7, lorebookId: id === 'a1' ? 356 : null, tokenTotal: 1200,
          analytics_chats: 16, analytics_messages: 40, createdAt: '2025-02-19T21:20:00.000Z', lastUpdatedAt: state.updated },
        tags: state.tags[id] ?? [], contentWarnings: state.warnings[id] ?? [], authorUsername: 'maker_one', likesData: { likeCount: 4, dislikeCount: 0 },
        alternativeGreetings: { $promise: 1 }, follows: { $promise: 2 }, lorebook: { $promise: 3 },
      }, { 1: ['Good morning.', '  '], 2: { follows: [] }, 3: id === 'a1' ? { id: 356, name: 'World', scanDepth: 4, entries: [{ name: 'Town', content: 'A town.', keys: ['town'], insertionOrder: 2 }] } : null });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetch, requests, state };
}

describe('SvelteKit data', () => {
  it('reads devalue tables, settles streamed promises and never builds dangerous keys', () => {
    expect(unflatten(flatten({ a: [1, 'x', { b: true }], c: null }))).toEqual({ a: [1, 'x', { b: true }], c: null });
    expect(unflatten([{ when: 1, gone: -1, inf: -4 }, ['Date', '2026-01-01T00:00:00.000Z']])).toEqual({ when: '2026-01-01T00:00:00.000Z', gone: undefined, inf: Infinity });
    // JSON.parse makes a real "__proto__" key (an object literal would set the prototype instead).
    const hostile = unflatten(JSON.parse('[{"__proto__":1,"constructor":1,"ok":2},{"polluted":3},"fine",true]')) as Record<string, unknown>;
    expect(hostile).toEqual({ ok: 'fine' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(unflatten([['Function', 'alert(1)']])).toBeNull();
    const nodes = readSvelteKitData([JSON.stringify({ type: 'data', nodes: [null, { type: 'data', data: flatten({ list: { $promise: 1 }, later: { $promise: 9 } }) }] }),
      JSON.stringify({ type: 'chunk', id: 1, data: flatten(['x']) })].join('\n'));
    expect(nodes).toEqual([null, { list: ['x'], later: null }]);
    expect(() => readSvelteKitData('<html>')).toThrow();
    expect(() => unflatten([{ a: 99 }])).toThrow(/out of range/);
  });
});

describe('Character Tavern source', () => {
  let directory: string, archive: NativeArchive;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'unity-ct-')); archive = await openNativeArchive(directory); });
  afterEach(async () => { archive.close(); await rm(directory, { recursive: true, force: true }); });
  const run = (fake: ReturnType<typeof fakeCt>, settings: Record<string, unknown> = {}, secrets: Record<string, string> = {}) =>
    runScrape(ct, archive.sink, { fetch: fake.fetch, sleep: async () => undefined, settings: { pages: 2, bannedTags: ['gore'], ...settings }, secrets });

  it('stores cards built from CT records with their portrait, and skips banned tags and excluded warnings', async () => {
    const fake = fakeCt();
    expect(await run(fake)).toMatchObject({ status: 'done', listed: 3, added: 1, skipped: 2, errors: 0 });
    const [card] = archive.list().cards;
    expect(card).toMatchObject({ id: 'ct:a1', name: 'Card a1', creator: 'maker_one', tagline: 'Tagline a1', url: 'https://character-tavern.com/character/maker_one/card_a1',
      tags: ['Fantasy', 'Elf'], altGreetings: 1, lorebookEntries: 1, stats: { chats: 16, favorites: 4, messages: 40 },
      remoteUpdatedAt: '2025-05-01T00:00:00.000Z', flags: { systemPrompt: true, exampleDialogues: true } });
    expect(card!.portrait).not.toBeNull();
    const detail = await archive.card('ct:a1');
    expect(detail.versionList[0]!.objects.map((object) => `${object.role}:${object.name}`)).toEqual(['card:card.json', 'portrait:card.png', 'raw:record.json']);
    const data = (detail.document as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ description: 'a1 keeps maps.', personality: 'calm', creator_notes: 'Creator notes here.', mes_example: '<START>\nHi there',
      alternate_greetings: ['Good morning.'], character_version: '7', extensions: { character_tavern: { id: 'a1', versionId: 7, lorebookId: 356, contentWarnings: [] } } });
    expect((data.character_book as { entries: unknown[] }).entries).toEqual([expect.objectContaining({ name: 'Town', content: 'A town.', keys: ['town'], insertion_order: 2 })]);
  });

  it('rereads listed cards without making versions for unchanged ones, and keeps a card without a valid image', async () => {
    const fake = fakeCt();
    await run(fake, { bannedTags: [], excludedWarnings: [] });
    expect(archive.list().total).toBe(3);
    expect((await archive.card('ct:a2')).versionList[0]!.objects.some((object) => object.role === 'portrait')).toBe(false);
    expect(await run(fake, { bannedTags: [], excludedWarnings: [] })).toMatchObject({ listed: 3, unchanged: 3, added: 0, updated: 0 });
    expect((await archive.card('ct:a1')).versions).toBe(1);
  });

  it('sends the cookies and listing options CT expects', async () => {
    const fake = fakeCt();
    await run(fake, { allowedWarnings: ['nsfw', 'gore'], sort: 'trending', query: 'elf', minTokens: 500, maxTokens: 9000 }, { cfClearance: ' clear ', session: 'sess' });
    const search = fake.requests[0]!;
    expect(search.headers.get('cookie')).toBe('cf_clearance=clear; session=sess; content_warnings=nsfw,gore');
    expect(search.headers.get('referer')).toBe('https://character-tavern.com/');
    expect(Object.fromEntries(new URL(search.url).searchParams)).toEqual({ page: '1', sort: 'trending', query: 'elf', minimum_tokens: '500', maximum_tokens: '9000' });
    const bare = fakeCt();
    await run(bare);
    expect(bare.requests[0]!.headers.get('cookie')).toBeNull();
  });

  it('explains a Cloudflare refusal', async () => {
    const fake = fakeCt();
    fake.state.status = 403;
    expect(await run(fake)).toMatchObject({ status: 'failed', error: 'Character Tavern refused the request (403); refresh the cf_clearance cookie in Settings' });
  });

  it('walks every page with fullReconcile and stops at totalPages', async () => {
    const fake = fakeCt();
    expect(await run(fake, { pages: 1, fullReconcile: true, bannedTags: [], excludedWarnings: [] })).toMatchObject({ listed: 4, added: 4 });
    const pages = fake.requests.filter((request) => request.url.includes('/search/cards/__data.json')).map((request) => new URL(request.url).searchParams.get('page'));
    expect(pages).toEqual(['1', '2', '3']);
    const limited = fakeCt();
    await run(limited, { pages: 1, bannedTags: [], excludedWarnings: [] });
    expect(limited.requests.filter((request) => request.url.includes('/search/cards/__data.json')).length).toBe(1);
  });
});
