import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createArchiveClient } from '@character-unity/archive-client';
import { archivePrefix, limits } from '@character-unity/archive-client/contract';
import { createArchiveApp } from './app.js';
import { createFixtureArchive } from './fixture.js';
import type { FixtureCard } from './fixture.js';

const encoder = new TextEncoder();
const original = encoder.encode('{ "name": "Aster 🌳", "unknown": [null, {"x":1}] }\n');
const portrait = new Uint8Array([0, 255, 13, 10, 0, 128]);
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function fixture(id: string, tags = ['forest']): FixtureCard {
  return {
    id, title: id.toUpperCase(), tags,
    source: { provider: 'demo', recordId: `remote-${id}`, url: `https://example.test/cards/${id}` },
    original: { bytes: new Uint8Array(original), mediaType: 'application/json' },
    assets: [{ id: 'portrait', bytes: new Uint8Array(portrait), mediaType: 'image/png' }, { id: 'missing', mediaType: 'image/png' }],
  };
}
function setup(fixtures = [fixture('c'), fixture('a'), fixture('b', ['mountain'])]) {
  const source = createFixtureArchive('fixture-test', fixtures);
  const app = createArchiveApp(source);
  const requests: Request[] = [];
  const send: typeof fetch = async (url, init) => {
    const request = new Request(url, init);
    requests.push(request);
    return app.fetch(request);
  };
  return { source, app, requests, client: createArchiveClient('http://archive.test', { fetch: send }) };
}
function reply(json: unknown) { return new Response(JSON.stringify(json), { headers: { 'content-type': 'application/json' } }); }

describe('archive contract / fixture', () => {
  it('[A01] original bytes and available assets match their descriptors exactly', async () => {
    const { client, requests } = setup();
    const status = await client.status();
    expect(status.mode).toBe('fixture');
    const { card } = await client.card(status, 'a');
    expect(card.original.hash).toBe(digest(original));
    expect(await client.original(status, card.original)).toEqual(original);
    const asset = card.assets[0];
    expect(asset?.availability).toBe('available');
    if (asset?.availability !== 'available') throw new Error('Expected fixture asset');
    expect(await client.asset(status, asset.object)).toEqual(portrait);
    expect(requests.every((request) => request.method === 'GET' && request.redirect === 'manual' && request.credentials === 'omit')).toBe(true);
  });

  it('[A02] bounded filtered pages retain one snapshot and deterministic ordering', async () => {
    const { client } = setup();
    const first = await client.list({ limit: 1, q: 'remote', tag: 'forest', provider: 'demo' });
    expect(first.cards.map((card) => card.id)).toEqual(['a']);
    expect(first.nextCursor).not.toBeNull();
    const next = await client.list({ snapshot: first.snapshot, cursor: first.nextCursor ?? '', limit: 1, q: 'remote', tag: 'forest', provider: 'demo' });
    expect(next.cards.map((card) => card.id)).toEqual(['c']);
    expect(next.nextCursor).toBeNull();
    await expect(client.list({ snapshot: first.snapshot, cursor: first.nextCursor ?? '', tag: 'mountain' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(client.list({ cursor: first.nextCursor ?? '' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await client.list({ q: 'nothing' })).cards).toEqual([]);
  });

  it('[A03] manifests contain exactly the selected IDs and never substitute missing cards', async () => {
    const { client } = setup();
    const status = await client.status();
    const selection = await client.select(status, ['c', 'a']);
    expect(selection.cards.map((card) => card.id)).toEqual(['a', 'c']);
    expect(selection).toEqual(await client.select(status, ['a', 'c']));
    expect(selection.cards.every((card) => card.original.hash === digest(original))).toBe(true);
    await expect(client.select(status, ['a', 'absent'])).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(client.select(status, ['a', 'a'])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(client.select(status, [])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(client.select(status, Array.from({ length: 101 }, (_, i) => `card-${i}`))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('[A04] missing assets are explicit and reads have no repair or mutation route', async () => {
    const { source, app, client, requests } = setup();
    const before = source.status();
    const { card } = await client.card(before, 'a');
    expect(card.assets[1]).toEqual({ id: 'missing', availability: 'unavailable' });
    await expect(client.asset(before, { ...card.original, hash: '0'.repeat(64) })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    for (const [path, method] of [
      [`${archivePrefix}/cards/a`, 'POST'], [`${archivePrefix}/manifest`, 'POST'],
      [`${archivePrefix}/originals/${card.original.hash}`, 'PUT'], ['/api/sync/chub', 'GET'],
      ['/api/federation/inbox', 'POST'], ['/api/config', 'POST'],
    ]) expect((await app.request(path ?? '', { method: method ?? 'GET' })).status).toBe(404);
    expect(requests.every((request) => new URL(request.url).origin === 'http://archive.test')).toBe(true);
    expect(source.status()).toEqual(before);
    expect(await client.original(before, card.original)).toEqual(original);
  });

  it('[A05] snapshots and bytes are detached from callers and changed corpora reject old cursors', async () => {
    const input = fixture('a');
    const { source, client } = setup([input, fixture('b')]);
    const before = await client.list({ limit: 1 });
    input.original.bytes.fill(0);
    input.title = 'Changed';
    input.tags.push('changed');
    const exposed = source.card(before.snapshot, 'a');
    exposed.card.title = 'Caller changed response';
    const bytes = source.object('originals', before.snapshot, digest(original));
    bytes.bytes.fill(0);
    expect((await client.card(before, 'a')).card.title).toBe('A');
    expect(await client.original(before, exposed.card.original)).toEqual(original);
    const replacement = setup([fixture('a'), fixture('b'), fixture('d')]);
    await expect(replacement.client.list({ snapshot: before.snapshot, cursor: before.nextCursor ?? '' })).rejects.toMatchObject({ code: 'SNAPSHOT_CHANGED' });
    await expect(replacement.client.select(before, ['a'])).rejects.toMatchObject({ code: 'SNAPSHOT_CHANGED' });
    expect(source.status().snapshot).toBe(before.snapshot);
  });

  it('[A06] request bounds and malformed cursors fail without exposing a source', async () => {
    const { app, client, source } = setup();
    const status = source.status();
    for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'limit=1&limit=2', 'repair=true', 'cursor=broken', `snapshot=${status.snapshot}&cursor=broken`]) {
      expect((await app.request(`${archivePrefix}/cards?${query}`)).status).toBe(400);
    }
    await expect(client.card(status, '../config')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(client.list({ limit: 101 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(client.list({ snapshot: `${status.snapshot}\n` })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(client.list({ q: 'x'.repeat(201) })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const off = createArchiveApp();
    const response = await off.request(`${archivePrefix}/status`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'UNAVAILABLE' } });
    expect(() => createFixtureArchive('bad', [fixture('a'), fixture('a')])).toThrow();
  });

  it('[A07] clients reject corrupt, truncated and oversized originals before returning bytes', async () => {
    const { source } = setup();
    const status = source.status();
    const { card } = source.card(status.snapshot, 'a');
    for (const bytes of [encoder.encode('corrupt'), original.slice(0, -1), encoder.encode('x'.repeat(original.length)), new Uint8Array(original.length + 1)]) {
      let cancelled = false;
      const client = createArchiveClient('http://archive.test', { fetch: async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(bytes); if (bytes.length <= original.length) controller.close(); },
        cancel() { cancelled = true; },
      }), { headers: { 'x-archive-snapshot': status.snapshot, 'x-archive-id': status.archiveId } }) });
      await expect(client.original(status, card.original)).rejects.toMatchObject({ code: bytes.length > original.length ? 'TOO_LARGE' : 'INTEGRITY' });
      if (bytes.length > original.length) expect(cancelled).toBe(true);
    }
  });

  it('[A08] clients validate versions, response shapes and exact selection membership', async () => {
    const { source } = setup();
    const status = source.status();
    const card = source.card(status.snapshot, 'a').card;
    for (const data of [
      { ...status, version: 'v99', cards: [card] },
      { ...status, cards: [{ ...card, original: { ...card.original, algorithm: 'md5' } }] },
      { ...status, cards: [{ ...card, assets: [{ id: 'x', availability: 'loading' }] }] },
      { ...status, cards: [card, card] },
      { ...status, cards: [] },
      { ...status, cards: [{ ...card, id: 'unselected' }] },
    ]) {
      const client = createArchiveClient('http://archive.test', { fetch: async () => reply(data) });
      await expect(client.select(status, ['a'])).rejects.toMatchObject({ code: 'PROTOCOL' });
    }
    let cancelled = false;
    const oversized = createArchiveClient('http://archive.test', { fetch: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(limits.jsonBytes + 1)); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'application/json' } }) });
    await expect(oversized.status()).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(cancelled).toBe(true);
  });

  it('[A09] a different archive or snapshot cannot satisfy an existing manifest', async () => {
    const { source } = setup();
    const status = source.status();
    const card = source.card(status.snapshot, 'a').card;
    for (const wrong of [{ ...status, archiveId: 'another-archive' }, { ...status, snapshot: '0'.repeat(64) }]) {
      const client = createArchiveClient('http://archive.test', { fetch: async () => reply({ ...wrong, cards: [card] }) });
      await expect(client.select(status, ['a'])).rejects.toMatchObject({ code: 'SNAPSHOT_CHANGED' });
      const bytesClient = createArchiveClient('http://archive.test', { fetch: async () => new Response(original, { headers: {
        'x-archive-snapshot': wrong.snapshot, 'x-archive-id': wrong.archiveId,
      } }) });
      await expect(bytesClient.original(status, card.original)).rejects.toMatchObject({ code: 'SNAPSHOT_CHANGED' });
    }
  });

  it('[A10] real HTTP reads honor cancellation and deadlines and refuse redirects', async () => {
    let mode = 'redirect';
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      if (mode === 'redirect') { response.writeHead(302, { location: '/another-source' }); response.end(); }
      else { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test address');
    const client = createArchiveClient(`http://127.0.0.1:${address.port}`, { timeoutMs: 250 });
    try {
      await expect(client.status()).rejects.toThrow();
      expect(requests).toBe(1);
      mode = 'stall';
      await expect(client.status()).rejects.toThrow();
      const abort = new AbortController();
      abort.abort();
      await expect(client.status(abort.signal)).rejects.toThrow();
      expect(requests).toBe(2);
    } finally {
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    }
  });
});

it('rejects an oversized metadata response before sending it and permits a smaller page', async () => {
  const fixtures = Array.from({ length: 100 }, (_, index) => ({ ...fixture(`large-${index}`), assets: Array.from({ length: 64 }, (_, asset) => ({
    id: `asset-${asset}`, mediaType: 'image/png', binding: { kind: 'uri' as const, uri: `https://example.invalid/${'x'.repeat(1950)}` },
  })) }));
  const { client } = setup(fixtures);
  await expect(client.list({ limit: 100 })).rejects.toMatchObject({ code: 'TOO_LARGE', status: 413 });
  expect((await client.list({ limit: 1 })).cards).toHaveLength(1);
});
