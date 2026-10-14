import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ScraperPlugin } from '@character-unity/scraper-kit';
import { openNativeArchive } from './store.js';
import type { NativeArchive } from './store.js';
import { createScheduler } from './scheduler.js';
import { createNativeArchiveApp, nativeAdminPrefix, nativeReadPrefix } from './app.js';
import { serve } from '@hono/node-server';
import { serializeNativeArchiveQuery } from '@character-unity/archive-client/native';

const token = 'test-admin-token-0123456789abcdef';
const encoder = new TextEncoder();
const cardBytes = (name: string) => encoder.encode(JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name, description: `${name} desc`,
  personality: '', scenario: '', first_mes: 'Hi', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
  alternate_greetings: [], tags: ['Demo'], creator: 'maker', character_version: '1', extensions: {} } }));

/** A source whose listings come from a list the test controls; `gate` holds fetches until released. */
function demoSource(names: string[]) {
  let release: () => void = () => undefined;
  const gate = { held: false, wait: Promise.resolve() as Promise<void> };
  const plugin: ScraperPlugin = {
    provider: 'demo', label: 'Demo', minIntervalMs: 0,
    settings: [{ key: 'pages', label: 'Pages', type: 'number', default: 1, min: 1, max: 5 }],
    secrets: [{ key: 'apiKey', label: 'API key' }],
    async *discover() { for (const name of names) yield { recordId: name.toLowerCase(), updatedAt: '2026-05-01T00:00:00Z' }; },
    async fetch(context, listing) {
      if (gate.held) await gate.wait;
      context.signal.throwIfAborted();
      return { provider: 'demo', recordId: listing.recordId, url: `https://demo.test/${listing.recordId}`,
        objects: [{ role: 'card', bytes: cardBytes(listing.recordId), mediaType: 'application/json' }] };
    },
  };
  return { plugin, hold() { gate.held = true; gate.wait = new Promise((resolve) => { release = resolve; }); }, release: () => { gate.held = false; release(); } };
}

async function http(app: ReturnType<typeof createNativeArchiveApp>) {
  return new Promise<{ base: string; close(): Promise<void> }>(done => {
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, address => done({ base: `http://127.0.0.1:${address.port}`,
      close: () => new Promise<void>(closed => { server.close(() => closed()); if ('closeAllConnections' in server) server.closeAllConnections(); }),
    }));
  });
}

describe('native Archive service', () => {
  let directory: string, archive: NativeArchive;
  let clock = Date.UTC(2026, 9, 1);
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'unity-native-app-')); archive = await openNativeArchive(directory); clock = Date.UTC(2026, 9, 1); });
  afterEach(async () => { archive.close(); await rm(directory, { recursive: true, force: true }); });
  const setup = (names = ['Aster', 'Birch']) => {
    const demo = demoSource(names);
    const scheduler = createScheduler(archive, [demo.plugin], { now: () => clock });
    const app = createNativeArchiveApp(archive, scheduler, [demo.plugin], { adminToken: token });
    const admin = (path: string, init: RequestInit = {}) => app.request(`${nativeAdminPrefix}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers as Record<string, string> } });
    return { demo, scheduler, app, admin };
  };

  it('validates bounded JSON tag groups on the public read route and pins normalized group paging', async () => {
    const { app } = setup();
    for (const [recordId, name, tags] of [['a', 'Aster', ['Fantasy', 'female']], ['b', 'Birch', ['SciFi', 'robot']]] as const) {
      await archive.put({ provider: 'demo', recordId, url: `https://demo.test/${recordId}`, tags: [...tags],
        objects: [{ role: 'card', bytes: cardBytes(name), mediaType: 'application/json' }] });
    }
    const before = await archive.card('demo:a');
    const read = (params: URLSearchParams) => app.request(`${nativeReadPrefix}/cards?${params}`);
    const first = await read(serializeNativeArchiveQuery({ tagGroups: [[' Fantasy ', 'SciFi']], sort: 'name', limit: 1 }));
    expect(first.status).toBe(200);
    const body = await first.json(); expect(body.total).toBe(2); expect(body.cards[0].name).toBe('Aster');
    const second = await read(serializeNativeArchiveQuery({ tagGroups: [['SCIFI', 'fantasy']], sort: 'name', limit: 1, offset: 1, snapshot: body.snapshot }));
    expect(second.status).toBe(200); expect((await second.json()).cards[0].name).toBe('Birch');
    expect((await read(serializeNativeArchiveQuery({ tagGroups: [['robot']], sort: 'name', offset: 1, snapshot: body.snapshot }))).status).toBe(409);
    const excluded = await read(serializeNativeArchiveQuery({ tagGroups: [['fantasy', 'scifi']], excludeTagGroups: [['female']] }));
    expect(excluded.status).toBe(200); expect((await excluded.json()).cards.map((card: { name: string }) => card.name)).toEqual(['Birch']);
    const boundary = await read(serializeNativeArchiveQuery({ tagGroups: [Array.from({ length: 101 }, (_, index) => index === 100 ? 'fantasy' : `absent-${index}`)] }));
    expect(boundary.status).toBe(200); expect((await boundary.json()).total).toBe(1);
    for (const value of [null, 0, {}, [['fantasy', 1]], [[]], [[' ']], [['x'.repeat(129)]],
      Array.from({ length: 21 }, () => ['fantasy']), [Array.from({ length: 102 }, () => 'fantasy')],
      Array.from({ length: 10 }, () => Array.from({ length: 101 }, () => 'fantasy'))]) {
      const response = await read(new URLSearchParams({ tagGroups: JSON.stringify(value) }));
      expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    }
    expect((await read(new URLSearchParams({ tagGroups: JSON.stringify(Array.from({ length: 20 }, () => ['fantasy'])), excludeTagGroups: '[["robot"]]' }))).status).toBe(400);
    const duplicate = new URLSearchParams({ tagGroups: '[["fantasy"]]' }); duplicate.append('tagGroups', '[["robot"]]');
    expect((await read(duplicate)).status).toBe(400);
    expect(() => serializeNativeArchiveQuery({ tagGroups: Array.from({ length: 10 }, () => Array.from({ length: 100 }, () => 'x'.repeat(128))) })).toThrow('URL exceeds');
    expect((await archive.card('demo:a')).versionList).toEqual(before.versionList);
  });

  it('guards admin routes with the token and never returns secrets', async () => {
    const { app, admin } = setup();
    expect((await app.request(`${nativeAdminPrefix}/sources`)).status).toBe(401);
    expect((await app.request(`${nativeAdminPrefix}/sources`, { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    const saved = await admin('/sources/demo', { method: 'PUT', body: JSON.stringify({ enabled: true, intervalMinutes: 60, settings: { pages: 99 }, secrets: { apiKey: 'very-secret' } }) });
    expect(saved.status).toBe(200);
    const body = await saved.json() as Record<string, unknown>;
    expect(body).toMatchObject({ enabled: true, intervalMinutes: 60, settings: { pages: 5 }, secretsSet: ['apiKey'] });
    expect(JSON.stringify(body)).not.toContain('very-secret');
    expect(archive.source('demo').secrets).toEqual({ apiKey: 'very-secret' });
    // Omitted secrets are kept; null clears.
    await admin('/sources/demo', { method: 'PUT', body: JSON.stringify({ settings: { pages: 2 } }) });
    expect(archive.source('demo').secrets).toEqual({ apiKey: 'very-secret' });
    await admin('/sources/demo', { method: 'PUT', body: JSON.stringify({ secrets: { apiKey: null } }) });
    expect(archive.source('demo').secrets).toEqual({});
    expect((await admin('/sources/demo', { method: 'PUT', body: JSON.stringify({ intervalMinutes: 1 }) })).status).toBe(400);
    expect((await admin('/sources/demo', { method: 'PUT', body: JSON.stringify({ secrets: { other: 'x' } }) })).status).toBe(400);
    expect((await admin('/sources/nope', { method: 'PUT', body: '{}' })).status).toBe(404);
  });

  it('opt-in exact-origin native reads work over HTTP for JSON, bytes and HEAD without granting credentials', async () => {
    const { scheduler } = setup();
    const origin = 'http://127.0.0.1:19435';
    const app = createNativeArchiveApp(archive, scheduler, [], { adminToken: token, readOrigins: [origin] });
    await archive.put({ provider: 'demo', recordId: 'cors', url: 'https://demo.test/cors', objects: [
      { role: 'card', bytes: cardBytes('CORS Aster'), mediaType: 'application/json' },
    ] });
    const card = await archive.card('demo:cors');
    const hash = card.versionList[0]!.objects[0]!.sha256;
    const listening = await http(app);
    try {
      for (const [method, path] of [['GET', '/status'], ['GET', '/cards'], ['GET', '/cards/demo:cors'], ['GET', '/cards/demo:cors/files'],
        ['GET', `/identity?fileHash=${hash}`], ['GET', '/tags'], ['GET', `/objects/${hash}`], ['HEAD', `/objects/${hash}`]] as const) {
        const response = await fetch(`${listening.base}${nativeReadPrefix}${path}`, { method, headers: { origin } });
        expect(response.status).toBe(200);
        expect(response.headers.get('access-control-allow-origin')).toBe(origin);
        expect(response.headers.get('vary')?.split(/,\s*/)).toContain('Origin');
        expect(response.headers.get('access-control-allow-credentials')).toBeNull();
        expect(response.headers.get('access-control-allow-methods')).toBeNull();
        expect(response.headers.get('access-control-allow-headers')).toBeNull();
        if (method === 'HEAD') expect(await response.text()).toBe('');
        else await response.arrayBuffer();
      }
    } finally {
      await listening.close();
    }
  });

  it('denies CORS by default and denies nonexact origins, credentials, scoped reads, admin routes and every preflight', async () => {
    const { scheduler } = setup();
    const origin = 'http://127.0.0.1:19435';
    const unconfigured = await http(createNativeArchiveApp(archive, scheduler, [], { adminToken: token }));
    try {
      const response = await fetch(`${unconfigured.base}${nativeReadPrefix}/status`, { headers: { origin } });
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      await response.arrayBuffer();
    } finally { await unconfigured.close(); }
    const listening = await http(createNativeArchiveApp(archive, scheduler, [], { adminToken: token, readOrigins: [origin] }));
    const deny = async (path: string, init: RequestInit = {}) => {
      const response = await fetch(`${listening.base}${path}`, { ...init, headers: { origin, ...init.headers as Record<string, string> } });
      for (const header of ['access-control-allow-origin', 'access-control-allow-credentials', 'access-control-allow-methods', 'access-control-allow-headers']) {
        expect(response.headers.get(header), `${init.method ?? 'GET'} ${path} must not grant ${header}`).toBeNull();
      }
      await response.arrayBuffer();
      return response.status;
    };
    try {
      for (const rejected of ['null', `${origin}/`, 'http://127.0.0.1:19436', 'https://127.0.0.1:19435', 'http://127.0.0.1.evil.test:19435']) {
        expect(await deny(`${nativeReadPrefix}/status`, { headers: { origin: rejected } })).toBe(200);
      }
      for (const headers of [{ cookie: 'archive-admin=present' }, { authorization: `Bearer ${token}` },
        { authorization: `Bearer ${token}`, 'x-unity-library-workspace': 'private-workspace' }]) {
        expect(await deny(`${nativeReadPrefix}/cards`, { headers })).toBe(200);
      }
      expect(await deny(`${nativeAdminPrefix}/sources`, { headers: { authorization: `Bearer ${token}` } })).toBe(200);
      expect(await deny(`${nativeAdminPrefix}/sources`)).toBe(401);
      expect(await deny('/api/health')).toBe(200);
      expect(await deny(`${nativeReadPrefix}/not-a-route`)).toBe(404);
      for (const method of ['POST', 'PUT', 'DELETE']) expect(await deny(`${nativeReadPrefix}/cards`, { method })).toBe(404);
      for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE']) {
        expect(await deny(`${nativeReadPrefix}/cards`, { method: 'OPTIONS', headers: {
          'access-control-request-method': method, 'access-control-request-headers': 'authorization,x-unity-library-workspace',
        } })).toBe(404);
      }
      expect(await deny(`${nativeAdminPrefix}/library-index`, { method: 'OPTIONS', headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } })).toBe(401);
      const invalid = await fetch(`${listening.base}${nativeReadPrefix}/objects/invalid`, { headers: { origin } });
      expect(invalid.status).toBe(400);
      expect(invalid.headers.get('access-control-allow-origin')).toBe(origin);
      await invalid.arrayBuffer();
    } finally { await listening.close(); }
  });

  it.each(['*', 'null', 'file:///tmp/browser', 'https://browser.test/', 'https://browser.test/path', 'https://user:secret@browser.test', 'http://browser.test:80', 'https://browser.test?query'])(
    'rejects unsafe or noncanonical configured read origin %s', readOrigin => {
      const { scheduler } = setup();
      expect(() => createNativeArchiveApp(archive, scheduler, [], { readOrigins: [readOrigin] })).toThrow();
    });

  it('runs a source on demand, refuses a second run, and serves what it stored', async () => {
    const { app, admin, scheduler, demo } = setup();
    demo.hold();
    const started = await admin('/sources/demo/runs', { method: 'POST' });
    expect(started.status).toBe(202);
    const { runId } = await started.json() as { runId: number };
    expect((await admin('/sources/demo/runs', { method: 'POST' })).status).toBe(409);
    demo.release();
    await scheduler.settled('demo');
    const runs = await (await admin('/runs?provider=demo')).json() as { runs: { id: number; status: string; added: number }[] };
    expect(runs.runs[0]).toMatchObject({ id: runId, status: 'done', added: 2 });

    const page = await (await app.request(`${nativeReadPrefix}/cards?sort=name&limit=1`)).json() as { cards: { id: string; name: string }[]; total: number };
    expect(page).toMatchObject({ total: 2, cards: [{ id: 'demo:aster', name: 'aster' }] });
    const detail = await (await app.request(`${nativeReadPrefix}/cards/demo:aster`)).json() as { versionList: { objects: { sha256: string; role: string }[] }[] };
    const file = detail.versionList[0]!.objects.find((object) => object.role === 'card')!;
    const object = await app.request(`${nativeReadPrefix}/objects/${file.sha256}`);
    expect(object.headers.get('cache-control')).toContain('immutable');
    expect(new TextDecoder().decode(await object.arrayBuffer())).toContain('"aster desc"');
    expect(await (await app.request(`${nativeReadPrefix}/tags`)).json()).toEqual({ tags: [{ tag: 'Demo', count: 2 }] });
    const status = await (await app.request(`${nativeReadPrefix}/status`)).json() as { cards: number; sources: { provider: string; lastRun: { status: string } }[] };
    expect(status).toMatchObject({ cards: 2, sources: [{ provider: 'demo', lastRun: { status: 'done' } }] });

    expect((await admin('/cards/demo:aster/block', { method: 'POST', body: '{}' })).status).toBe(200);
    expect((await app.request(`${nativeReadPrefix}/cards/demo:aster`)).status).toBe(404);
  });

  it('cancels a running scrape and records it', async () => {
    const { admin, scheduler, demo } = setup();
    demo.hold();
    const { runId } = await (await admin('/sources/demo/runs', { method: 'POST' })).json() as { runId: number };
    expect((await admin(`/runs/${runId}/cancel`, { method: 'POST' })).status).toBe(200);
    demo.release();
    await scheduler.settled('demo');
    expect(archive.runs('demo')[0]).toMatchObject({ id: runId, status: 'cancelled' });
    expect((await admin(`/runs/${runId}/cancel`, { method: 'POST' })).status).toBe(404);
  });

  it('starts enabled sources when their interval has passed', async () => {
    const { scheduler } = setup();
    scheduler.due();
    expect(scheduler.running('demo')).toBeNull();
    archive.saveSource({ provider: 'demo', enabled: true, intervalMinutes: 60, settings: {}, secrets: {} });
    scheduler.due();
    expect(scheduler.running('demo')).not.toBeNull();
    await scheduler.settled('demo');
    clock += 30 * 60_000;
    scheduler.due();
    expect(scheduler.running('demo')).toBeNull();
  });

  it('validates read queries', async () => {
    const { app } = setup();
    expect((await app.request(`${nativeReadPrefix}/cards?has=bogus`)).status).toBe(400);
    expect((await app.request(`${nativeReadPrefix}/cards?sort=bogus`)).status).toBe(400);
    expect((await app.request(`${nativeReadPrefix}/cards?limit=500`)).status).toBe(400);
    expect((await app.request(`${nativeReadPrefix}/cards?nope=1`)).status).toBe(400);
    expect((await app.request(`${nativeReadPrefix}/cards?mode=semantic`)).status).toBe(400);
    expect((await app.request(`${nativeReadPrefix}/cards?mode=browse&q=forest`)).status).toBe(400);
    expect((await app.request(`${nativeReadPrefix}/cards?mode=browse`)).status).toBe(200);
    expect((await app.request(`${nativeReadPrefix}/cards?mode=browse&filter=name%20%3D%20forest`)).status).toBe(400);
    expect((await app.request(`${nativeReadPrefix}/cards?snapshot=bad`)).status).toBe(400);
    expect((await app.request(`${nativeReadPrefix}/cards?offset=1`)).status).toBe(400);
    expect((await app.request(`${nativeReadPrefix}/cards?filter=a&filter=b`)).status).toBe(400);
    expect((await app.request(`${nativeReadPrefix}/cards?q=${'a'.repeat(2001)}`)).status).toBe(400);
    expect((await app.request(`${nativeReadPrefix}/objects/abc`)).status).toBe(400);
    expect((await app.request(`${nativeReadPrefix}/identity`)).status).toBe(400);
    expect((await app.request(`${nativeReadPrefix}/identity?fileHash=abc`)).status).toBe(400);
    expect((await app.request(`${nativeReadPrefix}/identity?fileHash=${'a'.repeat(64)}&fileHash=${'b'.repeat(64)}`)).status).toBe(400);
    expect((await app.request(`${nativeReadPrefix}/cards/demo:aster?version=a&version=b`)).status).toBe(400);
    expect((await app.request(`${nativeReadPrefix}/cards?q=tag:demo&has=greetings,lorebook&match=any&minTokens=10`)).status).toBe(200);
  });

  it('exposes exact versions and bounded byte-first identity matches through read-only routes', async () => {
    const { app } = setup();
    await archive.put({ provider: 'demo', recordId: 'aster', url: 'https://demo.test/aster', objects: [{ role: 'card', bytes: cardBytes('Aster'), mediaType: 'application/json' }] });
    const first = await archive.card('demo:aster');
    const file = first.versionList[0]!.objects.find((object) => object.role === 'card')!;
    await archive.put({ provider: 'demo', recordId: 'aster', url: 'https://demo.test/aster', objects: [{ role: 'card', bytes: cardBytes('Changed'), mediaType: 'application/json' }] });
    const pinned = await app.request(`${nativeReadPrefix}/cards/demo:aster?version=${first.versionId}`);
    expect(pinned.status).toBe(200);
    expect(await pinned.json()).toMatchObject({ archiveId: archive.archiveId, versionId: first.versionId, document: { data: { name: 'Aster' } } });
    const identity = await app.request(`${nativeReadPrefix}/identity?fileHash=${file.sha256}`);
    expect(await identity.json()).toMatchObject({ archiveId: archive.archiveId, complete: true, matches: [{ cardId: 'demo:aster', versionId: first.versionId, matchedBy: 'bytes' }] });
    const files = await app.request(`${nativeReadPrefix}/cards/demo:aster/files?version=${first.versionId}`);
    expect(await files.json()).toMatchObject({ files: [{ sha256: file.sha256 }] });
    expect((await app.request(`${nativeReadPrefix}/cards/demo:aster?version=unknown`)).status).toBe(404);
  });

  it('rejects stale and changed-query paging receipts with 409 instead of mixing result pages', async () => {
    const { app, admin, scheduler } = setup();
    await admin('/sources/demo/runs', { method: 'POST' });
    await scheduler.settled('demo');
    const first = await (await app.request(`${nativeReadPrefix}/cards?sort=name&limit=1`)).json() as { snapshot: string };
    expect(first.snapshot).toMatch(/^[a-f0-9]{64}$/);
    expect((await app.request(`${nativeReadPrefix}/cards?sort=name&limit=1&offset=1&snapshot=${first.snapshot}`)).status).toBe(200);
    expect((await app.request(`${nativeReadPrefix}/cards?sort=updated&snapshot=${first.snapshot}`)).status).toBe(409);
    await admin('/cards/demo:aster/block', { method: 'POST', body: '{}' });
    expect((await app.request(`${nativeReadPrefix}/cards?sort=name&offset=1&snapshot=${first.snapshot}`)).status).toBe(409);
  });
});
