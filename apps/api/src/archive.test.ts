import { createCopyFixture, original as copiedOriginal } from '../../archive/tests/copy-fixture.js';
import { createBrowserSearchFixture, fixtureInventory } from '../../archive/tests/browser-search-fixture.js';
import { createQueryEmbedder } from '../../archive/src/embeddings.js';
import { openCopiedArchive } from '../../archive/src/copied.js';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createArchiveClient } from '@character-unity/archive-client';
import { createArchiveImportService } from '@character-unity/cards/archive';
import { createApi } from '@character-unity/api';
import type { CardDocument } from '@character-unity/store';
import { openLocalServices } from './services.js';
import { createArchiveApp } from '../../archive/src/app.js';
import { createFixtureArchive } from '../../archive/src/fixture.js';
import type { FixtureCard } from '../../archive/src/fixture.js';

const syntheticEmbedder = () => createQueryEmbedder({ provider: 'ollama', baseUrl: 'http://127.0.0.1:1', space: { model: 'unity-synthetic-v1', dimensions: 3, sourceDimensions: 3, queryInstruction: '' } }, '', async () => Response.json({ embeddings: [[0, 1, 0]] }));
const actor = { id: 'alice', uri: 'urn:unity:user:alice' };
const encoder = new TextEncoder();
const portrait = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64'));
function fixture(id: string, asset = false): FixtureCard {
  return { id, title: id, tags: ['selected'], source: { provider: 'fixture', recordId: `source-${id}`, url: `https://example.test/${id}` },
    original: { mediaType: 'application/json', bytes: encoder.encode(JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', opaque: { keep: true }, data: {
      name: id, description: 'Original', extensions: { foreign: { keep: [1, null] } },
      ...(asset ? { assets: [{ type: 'icon', name: 'main', ext: 'png', uri: 'https://example.test/portrait.png', unknown: 7 }] } : {}),
    } }) + '\n') },
    assets: asset ? [{ id: 'portrait', mediaType: 'image/png', bytes: portrait, binding: { kind: 'uri', uri: 'https://example.test/portrait.png' } }]
      : [{ id: 'missing', mediaType: 'image/png' }],
  };
}

describe('Archive selection import', () => {
  let directory: string, services: Awaited<ReturnType<typeof openLocalServices>>, workspace: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'unity-archive-import-'));
    services = await openLocalServices({ databasePath: ':memory:', blobDirectory: directory });
    workspace = (await services.cards.createWorkspace(actor, 'Imports')).id;
  });
  afterEach(async () => { services?.close(); if (directory) await rm(directory, { recursive: true, force: true }); vi.restoreAllMocks(); });
  function setup(fixtures = [fixture('a', true), fixture('b'), fixture('c')], transform?: (response: Response, url: URL) => Promise<Response>) {
    const source = createFixtureArchive('fixture-test', fixtures);
    const app = createArchiveApp(source);
    const reads: Request[] = [];
    const client = createArchiveClient('http://archive.test', { fetch: async (url, init) => {
      const request = new Request(url, init); reads.push(request);
      const response = await app.fetch(request);
      return transform ? transform(response, new URL(request.url)) : response;
    } });
    return { source, reads, client, importer: createArchiveImportService(services.cards, client) };
  }

  it('imports and edits an explicit copied SQL selection without changing its files, database or snapshot', async () => {
    const root = join(directory, 'archive-copy'); await mkdir(root); await createCopyFixture(root);
    const beforeDatabase = await readFile(join(root, 'archive.sqlite'));
    const source = await openCopiedArchive(root), app = createArchiveApp(source), before = source.status();
    const client = createArchiveClient('http://copied.test', { fetch: async (url, init) => app.fetch(new Request(url, init)) });
    const importer = createArchiveImportService(services.cards, client);
    const result = await importer.import(actor, workspace, before, ['1']);
    expect(result.imported).toHaveLength(1); expect(result.failures).toEqual([]);
    const imported = result.imported[0]!;
    const opened = await services.cards.open(actor, workspace, imported.card.id);
    expect(opened.source?.provenance).toMatchObject({ archiveId: 'copied-test', cardId: '1', snapshot: before.snapshot, unavailableAssets: ['10'] });
    const document = structuredClone(opened.revision.document); (document.data as CardDocument).description = 'Edited in Unity';
    await services.cards.save(actor, workspace, opened.card.id, opened.revision.id, document);
    const accepted = await services.cards.original(actor, workspace, opened.card.id);
    expect(new Uint8Array(await new Response(accepted.body).arrayBuffer())).toEqual(new Uint8Array(copiedOriginal));
    expect(await services.cards.list(actor, workspace)).toHaveLength(1);
    expect(await readFile(join(root, 'archive.sqlite'))).toEqual(beforeDatabase);
    expect(await readFile(join(root, 'files/aster.json'))).toEqual(copiedOriginal);
    expect(source.status()).toEqual(before);
  });

  it('copies exactly the selected originals and explicitly bound existing assets without mutating Archive', async () => {
    const { source, reads, importer } = setup();
    const before = source.status();
    const result = await importer.import(actor, workspace, before, ['c', 'a']);
    expect(result.imported.map((item) => item.archiveCardId)).toEqual(['a', 'c']);
    expect(result.failures).toEqual([]); expect(result.interrupted).toBe(false);
    expect(await services.cards.list(actor, workspace)).toHaveLength(2);
    const a = result.imported[0]!;
    expect(a.revision.assets.map((item) => item.path)).toEqual(['declared/0']);
    expect(await new Response((await services.cards.original(actor, workspace, a.card.id)).body).text()).toBe(new TextDecoder().decode(fixture('a', true).original.bytes));
    const open = await services.cards.open(actor, workspace, a.card.id);
    expect(open.source?.provenance).toMatchObject({ kind: 'archive', archiveId: 'fixture-test', snapshot: before.snapshot, cardId: 'a', originalHash: source.card(before.snapshot, 'a').card.original.hash });
    const asset = await services.assets.download(workspace, a.revision.assets[0]!.assetId);
    expect(new Uint8Array(await new Response(asset.body).arrayBuffer())).toEqual(portrait);
    const draft = structuredClone(a.revision.document); (draft.data as CardDocument).description = 'Edited after Archive import';
    const saved = await services.cards.save(actor, workspace, a.card.id, a.revision.id, draft);
    expect(saved.assets).toEqual(a.revision.assets);
    expect(saved.document).toMatchObject({ opaque: { keep: true }, data: { assets: [{ uri: 'https://example.test/portrait.png', unknown: 7 }], extensions: { foreign: { keep: [1, null] }, foundry: { lineage: { originalHash: a.card.originalHash } } } } });
    expect(source.status()).toEqual(before);
    expect(reads.every((request) => request.method === 'GET' && request.redirect === 'manual' && request.credentials === 'omit')).toBe(true);
    expect(reads.some((request) => request.url.startsWith('https://example.test'))).toBe(false);
    expect(reads.filter((request) => new URL(request.url).pathname.includes('/originals/'))).toHaveLength(2);
  });

  it('rejects stale, duplicate or missing selections and unauthorized callers before copying anything', async () => {
    const { importer, reads, source } = setup();
    const snapshot = source.status();
    const bob = { id: 'bob', uri: 'urn:unity:user:bob' };
    for (const run of [() => importer.list(bob, workspace), () => importer.select(bob, workspace, snapshot, ['a']), () => importer.import(bob, workspace, snapshot, ['a'])]) {
      await expect(run()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(reads).toHaveLength(0);
    await expect(importer.import(actor, workspace, { ...snapshot, snapshot: 'a'.repeat(64) }, ['a'])).rejects.toMatchObject({ code: 'SNAPSHOT_CHANGED' });
    for (const ids of [['a', 'a'], ['missing'], []]) await expect(importer.import(actor, workspace, snapshot, ids)).rejects.toThrow();
    expect(await services.cards.list(actor, workspace)).toEqual([]);
  });

  it('preflights every original and asset before writing any selected card', async () => {
    const { importer, source } = setup([fixture('a'), fixture('z', true)], async (response, url) => {
      if (!url.pathname.includes('/assets/')) return response;
      return new Response(new Uint8Array(portrait.length), { headers: response.headers });
    });
    await expect(importer.import(actor, workspace, source.status(), ['a', 'z'])).rejects.toMatchObject({ code: 'INTEGRITY' });
    expect(await services.cards.list(actor, workspace)).toEqual([]);
    const unbound = fixture('u', true); delete unbound.assets[0]!.binding;
    const second = setup([unbound]);
    await expect(second.importer.import(actor, workspace, second.source.status(), ['u'])).rejects.toMatchObject({ code: 'ASSET_UNAVAILABLE' });
    expect(await services.cards.list(actor, workspace)).toEqual([]);
  });

  it('reports exact completed cards when a later card cannot be stored, without continuing silently', async () => {
    const { importer, source } = setup([fixture('a'), fixture('b'), fixture('c')]);
    const perform = services.cards.import.bind(services.cards);
    vi.spyOn(services.cards, 'import').mockImplementation(async (...args) => {
      if (args[3]?.cardId === 'b') throw new Error('Injected storage path /private');
      return perform(...args);
    });
    const result = await importer.import(actor, workspace, source.status(), ['c', 'b', 'a']);
    expect(result.imported.map((item) => item.archiveCardId)).toEqual(['a']);
    expect(result.failures).toEqual([{ archiveCardId: 'b', code: 'IMPORT_FAILED', message: 'This card was not imported. Check storage and the library before retrying.' }]);
    expect(result.interrupted).toBe(true);
    expect(await services.cards.list(actor, workspace)).toHaveLength(1);
  });

  it('enforces aggregate limits and cancellation before fetching originals', async () => {
    const large = Array.from({ length: 3 }, (_, index) => fixture(`card-${index}`));
    const { importer, source, reads } = setup(large, async (response, url) => {
      if (!url.pathname.endsWith('/manifest')) return response;
      const body = await response.json();
      for (const card of body.cards) card.original.byteLength = 32 * 1024 * 1024;
      return Response.json(body);
    });
    await expect(importer.import(actor, workspace, source.status(), large.map((item) => item.id))).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(reads.every((request) => !request.url.includes('/originals/'))).toBe(true);
    const controller = new AbortController(); controller.abort();
    await expect(importer.import(actor, workspace, source.status(), ['card-0'], controller.signal)).rejects.toThrow();
    expect(await services.cards.list(actor, workspace)).toEqual([]);
  });

  it('serves authorized selection routes, pins source configuration and limits cross-origin reads', async () => {
    const { importer, source } = setup();
    let authenticated = true;
    const app = createApi({ cards: services.cards, archive: importer, authenticate: () => authenticated ? actor : null });
    const base = `/api/workspaces/${workspace}/archive`;
    const post = (route: string, body: unknown) => app.request(`${base}/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const list = await app.request(`${base}/cards?q=source-c&limit=1`); expect(list.status).toBe(200);
    expect((await list.json()).cards.map((card: { id: string }) => card.id)).toEqual(['c']);
    expect((await app.request(`${base}/cards?url=http://private/`)).status).toBe(400);
    expect((await post('imports', { snapshot: source.status(), ids: ['b'], url: 'http://private/' })).status).toBe(400);
    const selection = await post('selection', { snapshot: source.status(), ids: ['b'] }); expect(selection.status).toBe(200);
    const result = await post('imports', { snapshot: await selection.json(), ids: ['b'] }); expect(result.status).toBe(200);
    expect((await result.json()).imported).toHaveLength(1);
    authenticated = false; expect((await app.request(`${base}/cards`)).status).toBe(401);
    const cors = createArchiveApp(source, { readOrigins: ['http://127.0.0.1:9310'] });
    const path = '/api/archive/v1/status';
    expect((await cors.request(path, { headers: { origin: 'http://127.0.0.1:9310' } })).headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:9310');
    expect((await cors.request(path, { headers: { origin: 'https://other.test' } })).headers.get('access-control-allow-origin')).toBeNull();
    const card = source.card(source.status().snapshot, 'a').card;
    for (const suffix of [`originals/${card.original.hash}`, `assets/${card.assets[0]!.availability === 'available' ? card.assets[0]!.object.hash : ''}`]) {
      const bytes = await cors.request(`/api/archive/v1/${suffix}?snapshot=${source.status().snapshot}`, { headers: { origin: 'http://127.0.0.1:9310' } });
      expect(bytes.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:9310');
      expect(bytes.headers.get('access-control-expose-headers')).toContain('X-Archive-Snapshot');
    }
    expect((await cors.request(path, { method: 'POST', headers: { origin: 'http://127.0.0.1:9310' } })).status).toBe(404);
  });

  it('proxies copied lexical search within the authorized workspace and imports an exact cross-page selection', async () => {
    const root = join(directory, 'search-copy'); await createBrowserSearchFixture(root);
    const before = await fixtureInventory(root), source = await openCopiedArchive(root, syntheticEmbedder()), archive = createArchiveApp(source);
    const reads: string[] = [];
    const client = createArchiveClient('http://copy.test', { fetch: async (url, init) => {
      reads.push(String(url)); return archive.fetch(new Request(url, init));
    } });
    const importer = createArchiveImportService(services.cards, client);
    let authenticated = true;
    const api = createApi({ cards: services.cards, archive: importer, authenticate: () => authenticated ? actor : null });
    const base = `/api/workspaces/${workspace}/archive`;
    expect(await (await api.request(`${base}/status`)).json()).toMatchObject({ mode: 'copy', search: 'lance-fts-v1' });
    const first = await (await api.request(`${base}/search?text=forest%20AND%20NOT%20ocean&sort=title&limit=10`)).json();
    expect(first).toMatchObject({ total: 12, cards: [{ id: 'zlex-01' }, {}, {}, {}, {}, {}, {}, {}, {}, { id: 'zlex-10' }] });
    const next = await (await api.request(`${base}/search?` + new URLSearchParams({ text: 'forest AND NOT ocean', sort: 'title', limit: '10', snapshot: first.snapshot, cursor: first.nextCursor }))).json();
    expect(next.cards.map((card: { id: string }) => card.id)).toEqual(['zlex-11', 'zlex-12']); expect(next.nextCursor).toBeNull();
    const semantic = await api.request(`${base}/search?` + new URLSearchParams({ mode: 'semantic', text: 'sea voyage', provider: 'synthetic', limit: '1' }));
    expect(semantic.status).toBe(200); expect(await semantic.json()).toMatchObject({ total: 13, cards: [{ id: 'zlex-13' }], matches: [{ section: 'description' }] });
    const filtered = await api.request(`${base}/search?` + new URLSearchParams({ text: 'forest', filter: 'tokenCount 1100 TO 1300', sort: 'id' }));
    const browsed = await api.request(`${base}/search?` + new URLSearchParams({ mode: 'browse', filter: 'tokenCount 1100 TO 1300', sort: 'tokens_desc', limit: '1' }));
    expect(browsed.status).toBe(200);
    expect(await browsed.json()).toMatchObject({ total: 3, cards: [{ id: 'zlex-13' }], scores: [0] });
    expect(filtered.status).toBe(200);
    expect((await filtered.json()).cards.map((card: { id: string }) => card.id)).toEqual(['zlex-11', 'zlex-12']);
    for (const suffix of ['/status?url=http://private/', '/search?text=a&filter=id:1&filter=id:2', '/search?text=a&text=b', '/search?text=a&limit=101', '/search?text=a&sort=unknown', '/search?text=a&filter=x', '/search?text=a&url=http://private/']) {
      expect((await api.request(base + suffix)).status).toBe(400);
    }
    expect((await api.request(`${base}/search?text=forest&snapshot=${'a'.repeat(64)}`)).status).toBe(409);
    const foreign = await services.cards.createWorkspace({ id: 'bob', uri: 'urn:unity:user:bob' }, 'Other workspace');
    const count = reads.length;
    for (const suffix of ['/status', '/search?text=forest', '/search?mode=semantic&text=sea']) expect((await api.request(`/api/workspaces/${foreign.id}/archive${suffix}`)).status).toBe(403);
    authenticated = false;
    for (const suffix of ['/status', '/search?text=forest', '/search?mode=semantic&text=sea']) expect((await api.request(base + suffix)).status).toBe(401);
    expect(reads).toHaveLength(count);
    const result = await importer.import(actor, workspace, first, ['zlex-12', 'zlex-01']);
    expect(result.imported.map((item) => item.archiveCardId)).toEqual(['zlex-01', 'zlex-12']);
    expect(await services.cards.list(actor, workspace)).toHaveLength(2);
    for (const imported of result.imported) {
      const accepted = await services.cards.original(actor, workspace, imported.card.id);
      expect(new Uint8Array(await new Response(accepted.body).arrayBuffer())).toEqual(new Uint8Array(await readFile(join(root, `files/${imported.archiveCardId}.json`))));
    }
    expect(await fixtureInventory(root)).toEqual(before);
  });

  it('withholds Archive metadata and search results when the session is revoked during the remote read', async () => {
    const root = join(directory, 'revocation-copy'); await createBrowserSearchFixture(root);
    const source = await openCopiedArchive(root, syntheticEmbedder()), archive = createArchiveApp(source);
    const account = await services.accounts.create('Reader'), reader = { id: account.account.id, uri: account.account.uri };
    const desk = await services.cards.createWorkspace(reader, 'Scoped reads');
    for (const operation of ['status', 'search', 'semantic', 'list', 'select']) {
      const session = (await services.accounts.login(account.key))!;
      const client = createArchiveClient('http://copy.test', { fetch: async (url, init) => {
        const response = await archive.fetch(new Request(url, init)); await services.accounts.logout(session.token); return response;
      } });
      const service = createArchiveImportService(services.forSession(session.proof).cards, client);
      const result = operation === 'status' ? service.status(reader, desk.id)
        : operation === 'search' ? service.search(reader, desk.id, { text: 'forest' })
          : operation === 'semantic' ? service.search(reader, desk.id, { mode: 'semantic', text: 'sea' })
          : operation === 'list' ? service.list(reader, desk.id) : service.select(reader, desk.id, source.status(), ['aster']);
      await expect(result).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    }
    const cancelled = new AbortController(); cancelled.abort();
    const { importer, reads } = setup();
    await expect(importer.status(actor, workspace, cancelled.signal)).rejects.toThrow();
    await expect(importer.search(actor, workspace, { text: 'forest' }, cancelled.signal)).rejects.toThrow();
    expect(reads).toEqual([]);
  });
});
