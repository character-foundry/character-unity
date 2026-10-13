import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runScrape } from '@character-unity/scraper-kit';
import { writeCharX } from '@character-foundry/character-foundry/charx';
import { embedIntoPNG } from '@character-foundry/character-foundry/png';
import { openNativeArchive } from '../native/store.js';
import type { NativeArchive } from '../native/store.js';
import { imageType, parseCount, parseRealmDate, parseRealmPage, readLiteral, risuai, unchangedSentinel } from './risuai.js';

const encoder = new TextEncoder();
const v3 = (name: string) => ({ spec: 'chara_card_v3', spec_version: '3.0', data: { name, description: `${name} sails.`, personality: '', scenario: '',
  first_mes: 'Ahoy.', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [],
  creator: 'risu-maker', character_version: '1', extensions: {}, group_only_greetings: [] } });
const tinyPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89,
  0, 0, 0, 13, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0, 0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99, 0x3d, 0x1d,
  0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 26, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c]);

/** A Realm character page the way SvelteKit inlines it: `data: [null, {...}]` inside a script, with non-data expressions around. */
function page(card: Record<string, unknown>) {
  const props = Object.entries(card).map(([key, value]) => `${key}:${JSON.stringify(value)}`).join(',');
  return `<html><body><a href="/character/other">x</a><script>
    __sveltekit_x = { base: new URL(".", location).pathname.slice(0, -1) };
    Promise.all([import("./app.js")]).then(([app]) => { app.start(node, { node_ids: [0, 7], data: [null,{type:"data",data:{${props},created:new Date(1),uses:{params:["id"]}},uses:{}}], form: null }); });
  </script></body></html>`;
}

describe('safe Realm literal reader', () => {
  it('reads objects, arrays, strings, numbers and keywords', () => {
    expect(readLiteral(`{a:1,'b':"two",c:[true,false,null,undefined,void 0],"d e":-1.5e2,f:'it\\'s',g:\`tpl\`,h:{i:[ ,2]},}`).value).toEqual({
      a: 1, b: 'two', c: [true, false, null, null, null], 'd e': -150, f: "it's", g: 'tpl', h: { i: [null, 2] } });
    expect(readLiteral('"\\u0041\\x42\\n"').value).toBe('AB\n');
    expect(readLiteral('[0x1F, .5, /* note */ 3 // tail\n]').value).toEqual([31, 0.5, 3]);
  });

  it('never executes anything: calls, identifiers, functions and templates become null', () => {
    const scope = globalThis as { pwned?: boolean };
    delete scope.pwned;
    const hostile = readLiteral(`{a:alert(1),b:(globalThis.pwned=true),c:function(){globalThis.pwned=true}(),d:\`\${globalThis.pwned=true}\`,e:new Date(5),f:x.y[z],g:"ok",__proto__:{polluted:1},h:() => {globalThis.pwned = true}}`).value as Record<string, unknown>;
    expect(hostile).toEqual({ a: null, b: null, c: null, d: null, e: null, f: null, g: 'ok', h: null });
    expect(scope.pwned).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(hostile)).toBe(Object.prototype);
  });

  it('fails on broken input instead of looping', () => {
    expect(() => readLiteral('{a:1')).toThrow();
    expect(() => readLiteral('"unterminated')).toThrow();
    expect(() => readLiteral('{a:1 b:2}')).toThrow();
    expect(() => readLiteral('[1 2]')).toThrow();
  });

  it('finds the card record on a page and falls back through data/card wrappers', () => {
    expect(parseRealmPage(page({ id: 'abc', name: 'Sailor', authorname: 'kai', tags: ['Sea'], download: '1.2k', img: 'deadbeef.png', hasEmotion: true })))
      .toMatchObject({ id: 'abc', name: 'Sailor', authorname: 'kai', tags: ['Sea'], download: '1.2k', created: null });
    expect(parseRealmPage('<script>x = { data: [null, {card: {id: 7, name: "Old"}}] }</script>')).toMatchObject({ id: 7, name: 'Old' });
    expect(parseRealmPage('<script>x = { data: [null, null] }</script>')).toBeNull();
    expect(parseRealmPage('<p>no data here</p>')).toBeNull();
  });

  it('parses counts, Realm dates and image types', () => {
    expect([parseCount('1.2k'), parseCount('3m'), parseCount('42'), parseCount(7), parseCount('n/a')]).toEqual([1200, 3_000_000, 42, 7, undefined]);
    expect(parseRealmDate(17_000_000)).toBe(new Date(17_000_000 * 100_000).toISOString());
    expect(parseRealmDate(5)).toBeUndefined();
    expect(parseRealmDate(null)).toBeUndefined();
    expect([imageType(tinyPng), imageType(jpeg), imageType(webp), imageType(new Uint8Array([1, 2, 3]))]).toEqual(['image/png', 'image/jpeg', 'image/webp', null]);
  });
});

/** A fake Realm: browse pages, character pages, download formats and the image host. */
function fakeRealm() {
  const requests: string[] = [];
  const state = {
    pages: [['r1', 'r2'], ['r2', 'r3', 'r4'], []] as string[][],
    cards: {
      r1: { formats: { 'charx-v3': () => writeCharX(v3('Charx One') as never, []).buffer }, img: 'one.webp', imgBytes: webp, date: 17_000_000 },
      r2: { formats: { 'png-v3': () => embedIntoPNG(tinyPng, v3('Png Two') as never) }, img: 'two.jpg', imgBytes: jpeg, date: null },
      r3: { formats: { 'json-v2': () => encoder.encode(JSON.stringify(v3('Json Three'))), 'charx-v3': () => encoder.encode('<html>error</html>') }, img: '', imgBytes: tinyPng, date: null },
      // Realm also serves CharX wrapped in a JPEG preview (the zip appended after the image).
      r4: { formats: { 'charx-v3': () => { const zip = writeCharX(v3('Jpeg Charx') as never, []).buffer; const out = new Uint8Array(jpeg.length + zip.length); out.set(jpeg); out.set(zip, jpeg.length); return out; } }, img: '', imgBytes: tinyPng, date: null },
    } as Record<string, { formats: Record<string, () => Uint8Array>; img: string; imgBytes: Uint8Array; date: number | null }>,
  };
  const fetch = async (url: string) => {
    requests.push(url);
    const parsed = new URL(url);
    if (parsed.host === 'sv.risuai.xyz') {
      const card = Object.values(state.cards).find((item) => parsed.pathname === `/resource/${item.img}`);
      return card ? new Response(new Uint8Array(card.imgBytes)) : new Response('missing', { status: 404 });
    }
    if (parsed.pathname === '/') {
      const ids = state.pages[Number(parsed.searchParams.get('page')) - 1] ?? [];
      return new Response(`<main>${ids.map((id) => `<a href="/character/${id}">${id}</a><a href='/character/${id}?ref=list'>again</a>`).join('')}<a href="/creator/x">no</a></main>`);
    }
    const character = parsed.pathname.match(/^\/character\/(\w+)$/);
    if (character) {
      const card = state.cards[character[1]!];
      return card ? new Response(page({ id: character[1]!, name: `Name ${character[1]}`, authorname: 'kai', tags: ['Sea', 'Pirate'], desc: 'A sailor.',
        download: '2.5k', img: card.img, hasAsset: character[1] === 'r1', hasEmotion: character[1] === 'r2', ...(card.date ? { date: card.date } : {}) })) : new Response('no', { status: 404 });
    }
    const download = parsed.pathname.match(/^\/api\/v1\/download\/([\w-]+)\/(\w+)$/);
    if (download) {
      const make = state.cards[download[2]!]?.formats[download[1]!];
      return make ? new Response(new Uint8Array(make())) : new Response('not found', { status: 404 });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetch, requests, state };
}

describe('RisuAI source', () => {
  let directory: string, archive: NativeArchive;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'unity-risu-')); archive = await openNativeArchive(directory); });
  afterEach(async () => { archive.close(); await rm(directory, { recursive: true, force: true }); });
  const run = (fake: ReturnType<typeof fakeRealm>, settings: Record<string, unknown> = {}) =>
    runScrape(risuai, archive.sink, { fetch: fake.fetch, sleep: async () => undefined, settings });

  it('pages the browse list, downloads the best format and keeps the thumbnail with its real type', async () => {
    const fake = fakeRealm();
    expect(await run(fake)).toMatchObject({ status: 'done', listed: 4, added: 4, errors: 0 });
    // Paging stops at the first empty page; each card is fetched once.
    expect(fake.requests.filter((url) => new URL(url).pathname === '/').map((url) => new URL(url).searchParams.get('page'))).toEqual(['1', '2', '3']);
    expect(fake.requests[0]).toBe('https://realm.risuai.net/?sort=latest&page=1');

    const files = async (id: string) => (await archive.card(id)).versionList[0]!.objects.map((object) => `${object.role}:${object.name}:${object.mediaType}`);
    expect(await files('risuai:r1')).toEqual(['card:card.charx:application/zip', 'portrait:portrait.webp:image/webp', 'raw:record.json:application/json']);
    // charx 404 → png
    expect(await files('risuai:r2')).toEqual(['card:card.png:image/png', 'portrait:portrait.jpeg:image/jpeg', 'raw:record.json:application/json']);
    // charx answered HTML (not a zip) and png/json-v3 404 → json-v2; no image name → no portrait
    expect(await files('risuai:r3')).toEqual(['card:card.json:application/json', 'raw:record.json:application/json']);
    expect(await files('risuai:r4')).toEqual(['card:card.charx:application/zip', 'raw:record.json:application/json']);
    expect(fake.requests.filter((url) => url.includes('/download/') && url.includes('/r2'))).toEqual([
      'https://realm.risuai.net/api/v1/download/charx-v3/r2?non_commercial=true', 'https://realm.risuai.net/api/v1/download/png-v3/r2?non_commercial=true']);

    const cards = archive.list({ sort: 'name' }).cards;
    expect(cards.map((card) => card.name)).toEqual(['Charx One', 'Jpeg Charx', 'Json Three', 'Png Two']);
    expect(cards[0]).toMatchObject({ id: 'risuai:r1', creator: 'kai', url: 'https://realm.risuai.net/character/r1', tagline: 'A sailor.',
      stats: { downloads: 2500 }, flags: { gallery: true, expressions: false }, remoteUpdatedAt: new Date(17_000_000 * 100_000).toISOString() });
    expect(cards[0]!.tags).toEqual(expect.arrayContaining(['Sea', 'Pirate']));
    expect(cards[3]).toMatchObject({ flags: { expressions: true }, remoteUpdatedAt: unchangedSentinel });
  });

  it('does not refetch cards it already has unless asked to', async () => {
    const fake = fakeRealm();
    await run(fake);
    fake.requests.length = 0;
    expect(await run(fake)).toMatchObject({ listed: 4, unchanged: 4, added: 0 });
    expect(fake.requests.every((url) => new URL(url).pathname === '/')).toBe(true);

    fake.requests.length = 0;
    expect(await run(fake, { forceUpdate: true })).toMatchObject({ listed: 4, unchanged: 4 });
    expect(fake.requests.some((url) => url.includes('/download/'))).toBe(true);
    expect((await archive.card('risuai:r1')).versions).toBe(1);
  });

  it('reports a card that no format can deliver, and honours sort and page settings', async () => {
    const fake = fakeRealm();
    fake.state.cards.r1!.formats = {};
    const result = await run(fake, { sort: 'download', pages: 1 });
    expect(result).toMatchObject({ listed: 2, added: 1, errors: 1 });
    expect(result.error).toContain('RisuAI card r1 could not be downloaded in any format (charx-v3: HTTP 404; png-v3: HTTP 404; json-v3: HTTP 404; json-v2: HTTP 404)');
    expect(fake.requests[0]).toBe('https://realm.risuai.net/?sort=download&page=1');
    expect(fake.requests.some((url) => url.includes('page=2'))).toBe(false);
  });

  it('fails clearly when a card page is missing or carries no data', async () => {
    const fake = fakeRealm();
    fake.state.pages = [['gone'], []];
    const result = await run(fake);
    expect(result).toMatchObject({ errors: 1, added: 0 });
    expect(result.error).toContain('HTTP 404');
    fake.state.pages = [['empty'], []];
    fake.state.cards.empty = { formats: {}, img: '', imgBytes: tinyPng, date: null };
    const original = fake.fetch;
    const blank = await runScrape(risuai, archive.sink, { sleep: async () => undefined,
      fetch: async (url) => new URL(url).pathname === '/character/empty' ? new Response('<html>nothing inlined</html>') : original(url) });
    expect(blank.error).toBe('Last card error: The RisuAI page for empty has no card data');
  });
});
