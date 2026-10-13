import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '@character-unity/api';
import { openLocalServices } from './services.js';
import type { LibraryIndexMutation } from '@character-unity/archive-client';
import { openNativeArchive } from '../../archive/src/native/store.js';
import { createNativeArchiveApp } from '../../archive/src/native/app.js';
import { createScheduler } from '../../archive/src/native/scheduler.js';
import { openLibraryIndex } from '../../archive/src/library-index.js';
import { computeCardContentIdentity } from '@character-foundry/character-foundry/identity';

const actor = { id: 'local', uri: 'urn:unity:user:local' };
const bytes = (name = 'Aster') => new TextEncoder().encode(JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: { name, description: 'Silver forest', character_book: { entries: [{ keys: ['silver'], content: 'Lore.' }] } } }));

describe('event-driven library search index delivery', () => {
  let root: string, services: Awaited<ReturnType<typeof openLocalServices>> | undefined;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'unity-library-index-')); });
  afterEach(async () => { services?.close(); services = undefined; await rm(root, { recursive: true, force: true }); });
  async function open(send: (body: LibraryIndexMutation, init: RequestInit) => Promise<Response>, config: { adminToken?: string; enabled?: boolean } = { adminToken: 'fixture-index-token-0123456789', enabled: true }) {
    services = await openLocalServices({ databasePath: join(root, 'unity.sqlite'), blobDirectory: join(root, 'blobs'), nativeArchive: {
      origin: 'http://archive.invalid', ...(config.adminToken ? { adminToken: config.adminToken } : {}), libraryIndex: config.enabled ?? true,
      async fetch(url, init = {}) {
        if (url.includes('/identity?')) return Response.json({ archiveId: 'fixture-archive', matches: [], complete: true, unresolved: 0 });
        if (url.endsWith('/admin/v1/library-index')) return send(JSON.parse(String(init.body)) as LibraryIndexMutation, init);
        throw new Error(`Unexpected fixture request: ${url}`);
      },
    } });
    return services;
  }

  it('commits Save before embedding, delivers exact revisions, and never wakes for reads/favorites', async () => {
    const received: LibraryIndexMutation[] = [];
    let release!: () => void, started!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; }), seen = new Promise<void>((resolve) => { started = resolve; });
    const service = await open(async (body, init) => {
      received.push(body);
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture-index-token-0123456789');
      expect(init.redirect).toBe('manual'); expect(init.credentials).toBe('omit');
      started(); if (received.length === 1) await held;
      return Response.json({ eventSequence: body.eventSequence, applied: true, semantic: true });
    });
    const workspace = await service.cards.createWorkspace(actor, 'Desk');
    const imported = await service.cards.import(actor, workspace.id, bytes());
    await seen;
    expect((await service.store.listSearchJobs()).length).toBe(1);
    const document = structuredClone(imported.revision.document); (document.data as Record<string, unknown>).description = 'New saved island';
    const saved = await service.cards.save(actor, workspace.id, imported.card.id, imported.revision.id, document);
    expect(saved.sequence).toBe(2); // network/embedding remains held
    release(); await service.searchIndex.settle();
    expect(received.map((body) => body.revisionId)).toEqual([imported.revision.id, saved.id]);
    expect(received[0]!.projection).toMatchObject({ name: 'Aster', description: 'Silver forest', lorebookEntries: 1 });
    expect(received[1]!.projection).toMatchObject({ description: 'New saved island', updatedAt: saved.createdAt });
    expect(await service.store.listSearchJobs()).toEqual([]);
    await service.cards.open(actor, workspace.id, imported.card.id);
    await service.cards.favorite(actor, workspace.id, imported.card.id, true);
    await service.searchIndex.settle(); expect(received).toHaveLength(2);
    await service.cards.delete(actor, workspace.id, imported.card.id); await service.searchIndex.settle();
    expect(received[2]).toMatchObject({ operation: 'delete', revisionId: saved.id });
    expect(received[2]).not.toHaveProperty('projection'); expect(received[2]).not.toHaveProperty('error');
    expect(await service.store.listSearchJobs()).toEqual([]);
  });

  it('keeps failures durable without retry polling and exposes authorized status/retry', async () => {
    let requests = 0, unavailable = true;
    const service = await open(async (body) => { requests++; return unavailable ? Response.json({ error: { code: 'UNAVAILABLE', message: 'Embedding provider offline' } }, { status: 503 })
      : Response.json({ eventSequence: body.eventSequence, applied: true, semantic: true }); });
    const workspace = await service.cards.createWorkspace(actor, 'Desk');
    const imported = await service.cards.import(actor, workspace.id, bytes()); await service.searchIndex.settle();
    expect(requests).toBe(1);
    expect(await service.store.listSearchJobs()).toMatchObject([{ cardId: imported.card.id, error: 'Embedding provider offline' }]);
    await service.cards.favorite(actor, workspace.id, imported.card.id, true); await service.searchIndex.settle(); expect(requests).toBe(1);
    const app = createApi({ cards: service.cards, libraryIndex: service.libraryIndex!, authenticate: async (request) => request.headers.get('x-actor') === 'owner' ? actor : request.headers.get('x-actor') === 'foreign' ? { id: 'foreign', uri: 'urn:unity:foreign' } : null });
    const path = `/api/workspaces/${workspace.id}/search-index`;
    expect((await app.request(path)).status).toBe(401);
    expect((await app.request(path, { headers: { 'x-actor': 'foreign' } })).status).toBe(403);
    expect((await app.request(`${path}/retry`, { method: 'POST' })).status).toBe(401);
    expect((await app.request(`${path}/retry`, { method: 'POST', headers: { 'x-actor': 'foreign' } })).status).toBe(403);
    const status = await app.request(path, { headers: { 'x-actor': 'owner' } });
    expect(status.headers.get('cache-control')).toBe('no-store');
    expect(await status.json()).toMatchObject({ enabled: true, pending: 1, failed: 1, lastError: 'Embedding provider offline' });
    unavailable = false;
    const retried = await app.request(`${path}/retry`, { method: 'POST', headers: { 'x-actor': 'owner' } });
    expect(retried.status).toBe(200); expect(await retried.json()).toMatchObject({ pending: 0, failed: 0, semantic: true });
    expect(requests).toBe(2);
  });

  it('does not discard queued work when indexing is disabled or admin credentials are missing', async () => {
    let requests = 0;
    const service = await open(async () => { requests++; throw new Error('Must not send'); }, { enabled: true });
    const workspace = await service.cards.createWorkspace(actor, 'Desk');
    await service.cards.import(actor, workspace.id, bytes()); await service.searchIndex.settle();
    expect(await service.libraryIndex!.status(actor, workspace.id)).toMatchObject({ enabled: false, pending: 1, reason: 'The Archive admin token is not configured' });
    await service.libraryIndex!.retry(actor, workspace.id); expect(requests).toBe(0);
  });

  it('restarts with one bounded metadata-only batch and retains the remainder for explicit retry', async () => {
    const disabled = await open(async () => { throw new Error('Disabled dispatcher must not call Archive'); }, { enabled: false, adminToken: 'fixture-index-token-0123456789' });
    const workspace = await disabled.cards.createWorkspace(actor, 'Desk');
    for (let index = 0; index < 17; index++) await disabled.cards.import(actor, workspace.id, bytes(`Card ${index}`));
    expect(await disabled.store.listSearchJobs({ limit: 100 })).toHaveLength(17);
    disabled.close(); services = undefined;
    let requests = 0;
    const restarted = await open(async (body) => { requests++; return Response.json({ eventSequence: body.eventSequence, applied: true, semantic: true }); });
    await restarted.searchIndex.settle();
    expect(requests).toBe(16);
    expect(await restarted.store.listSearchJobs()).toHaveLength(1);
    await restarted.searchIndex.settle(); expect(requests).toBe(16);
    await restarted.libraryIndex!.retry(actor, workspace.id);
    expect(requests).toBe(17); expect(await restarted.store.listSearchJobs()).toEqual([]);
  });

  it('preserves account proof checks in wrapped mutation stores', async () => {
    let requests = 0;
    const service = await open(async (body) => { requests++; return Response.json({ eventSequence: body.eventSequence, applied: true, semantic: true }); });
    const account = await service.accounts.create('Alice'), session = (await service.accounts.login(account.key))!;
    const scoped = service.forSession(session.proof), alice = { id: account.account.id, uri: account.account.uri };
    const workspace = await scoped.cards.createWorkspace(alice, 'Private library');
    await service.accounts.logout(session.token);
    await expect(scoped.cards.import(alice, workspace.id, bytes())).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(scoped.libraryIndex!.retry(alice, workspace.id)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await service.searchIndex.settle();
    expect(await service.store.listSearchJobs()).toEqual([]); expect(requests).toBe(0);
  });

  it('drains coalesced mutation bursts in bounded batches and does not acknowledge missing vectors', async () => {
    let requests = 0, vectorAvailable = true;
    const service = await open(async (body) => { requests++; return Response.json({ eventSequence: body.eventSequence, applied: true, semantic: vectorAvailable }); });
    const workspace = await service.cards.createWorkspace(actor, 'Burst');
    const document = JSON.parse(new TextDecoder().decode(bytes())) as { spec: string; spec_version: string; data: { name: string } };
    const identity = await computeCardContentIdentity(document);
    await Promise.all(Array.from({ length: 33 }, () => service.store.createCard({ workspaceId: workspace.id, authorId: actor.id, document, identity })));
    await service.searchIndex.settle();
    expect(requests).toBe(33); expect(await service.store.listSearchJobs()).toEqual([]);
    vectorAvailable = false;
    await service.store.createCard({ workspaceId: workspace.id, authorId: actor.id, document, identity }); await service.searchIndex.settle();
    expect(await service.libraryIndex!.status(actor, workspace.id)).toMatchObject({ pending: 1, failed: 1, lastError: expect.stringContaining('did not index saved-card embeddings') });
    expect(requests).toBe(34); await service.searchIndex.settle(); expect(requests).toBe(34);
    vectorAvailable = true;
    await service.libraryIndex!.retry(actor, workspace.id);
    expect(requests).toBe(35); expect(await service.store.listSearchJobs()).toEqual([]);
  });

  it('indexes a saved Archive fork through the real read/admin transport into the same Lance directory without copying originals', async () => {
    const archive = await openNativeArchive(join(root, 'archive'));
    const space = { model: 'synthetic-library-integration', dimensions: 2, sourceDimensions: 2, queryInstruction: '' };
    const queryEmbedder = { space, async embed() { return [1, 0]; } };
    let index = await openLibraryIndex({ lanceDirectory: join(root, 'search.lance'), space, queryEmbedder });
    let app = createNativeArchiveApp(archive, createScheduler(archive, []), [], { adminToken: 'fixture-index-token-0123456789', libraryIndex: index });
    try {
      await archive.put({ provider: 'demo', recordId: 'original', url: 'https://demo.test/original', objects: [{ role: 'card', bytes: bytes(), mediaType: 'application/json' }] });
      services = await openLocalServices({ databasePath: join(root, 'unity.sqlite'), blobDirectory: join(root, 'blobs'), nativeArchive: { origin: 'http://archive.invalid', adminToken: 'fixture-index-token-0123456789', libraryIndex: true,
        fetch: async (url, init) => app.fetch(new Request(url, init)) } });
      const workspace = await services.cards.createWorkspace(actor, 'Desk');
      const reference = await services.cards.addArchiveReference(actor, workspace.id, 'demo:original');
      const original = await services.cards.open(actor, workspace.id, reference.id);
      await services.searchIndex.settle(); expect(await services.store.listSearchJobs()).toEqual([]);
      expect((await index.search(workspace.id, { q: 'forest', mode: 'lexical' })).cards).toEqual([]);
      const document = structuredClone(original.revision.document); (document.data as Record<string, unknown>).description = 'New saved island';
      const fork = await services.cards.forkAssets(actor, workspace.id, reference.id, original.revision.id, document, [], []);
      await services.searchIndex.settle();
      expect(await services.libraryIndex!.status(actor, workspace.id)).toMatchObject({ pending: 1, failed: 1, lastError: expect.stringContaining('embedding provider') });
      expect((await index.search(workspace.id, { q: 'island', mode: 'lexical' })).cards).toEqual([]);
      await index.close();
      index = await openLibraryIndex({ lanceDirectory: join(root, 'search.lance'), space, queryEmbedder,
        documentEmbedder: { space, async embed(texts) { return texts.map(() => [1, 0]); } } });
      app = createNativeArchiveApp(archive, createScheduler(archive, []), [], { adminToken: 'fixture-index-token-0123456789', libraryIndex: index });
      await services.libraryIndex!.retry(actor, workspace.id);
      expect(await services.store.listSearchJobs()).toEqual([]);
      const lexical = await index.search(workspace.id, { q: 'island', mode: 'lexical' });
      expect(lexical.cards).toMatchObject([{ id: `unity:${fork.cardId}`, libraryCardId: fork.cardId, versionId: fork.revisionId, libraryOwned: true }]);
      const semantic = await index.search(workspace.id, { q: 'island', mode: 'semantic' });
      expect(semantic.cards.map((card) => card.libraryCardId)).toEqual([fork.cardId]);
      expect((await archive.card('demo:original')).document).toMatchObject({ data: { description: 'Silver forest' } });
      expect((await readdir(join(root, 'blobs'), { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile())).toEqual([]);
      await services.cards.delete(actor, workspace.id, fork.cardId); await services.searchIndex.settle();
      expect((await index.search(workspace.id, { q: 'island', mode: 'lexical' })).cards).toEqual([]);
    } finally { services?.close(); services = undefined; await index.close(); archive.close(); }
  });

  it('keeps Archive results available and hides deleted owned hits while index deletion is held or failed', async () => {
    const archive = await openNativeArchive(join(root, 'archive'));
    const space = { model: 'synthetic-held-delete', dimensions: 2, sourceDimensions: 2, queryInstruction: '' };
    const index = await openLibraryIndex({ lanceDirectory: join(root, 'search.lance'), space,
      queryEmbedder: { space, async embed() { return [1, 0]; } }, documentEmbedder: { space, async embed(texts) { return texts.map(() => [1, 0]); } } });
    const archiveApp = createNativeArchiveApp(archive, createScheduler(archive, []), [], { adminToken: 'fixture-index-token-0123456789', libraryIndex: index });
    let holdDelete = false, failDelete = true, release!: () => void, started!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; }), seen = new Promise<void>((resolve) => { started = resolve; });
    try {
      for (const recordId of ['original', 'other']) await archive.put({ provider: 'demo', recordId, url: `https://demo.test/${recordId}`,
        objects: [{ role: 'card', bytes: bytes(recordId), mediaType: 'application/json' }] });
      services = await openLocalServices({ databasePath: join(root, 'unity.sqlite'), blobDirectory: join(root, 'blobs'), nativeArchive: { origin: 'http://archive.invalid', adminToken: 'fixture-index-token-0123456789', libraryIndex: true,
        async fetch(url, init) {
          const request = new URL(url);
          if (request.pathname === '/api/archive/admin/v1/library-index' && JSON.parse(String(init?.body)).operation === 'delete' && holdDelete) {
            started(); await held;
            if (failDelete) return Response.json({ error: { code: 'UNAVAILABLE', message: 'Index deletion is temporarily unavailable' } }, { status: 503 });
          }
          if (request.pathname === '/api/archive/v2/cards') {
            // The existing backend merges these real Lance-owned hits with source cards.
            // Native fixture storage does not merge them, so only that bounded page is adapted here.
            const workspaceId = new Headers(init?.headers).get('x-unity-library-workspace')!;
            const owned = await index.search(workspaceId, { q: request.searchParams.get('q') ?? 'island', mode: 'semantic' });
            const originals = archive.list({ sort: 'name' }).cards;
            const all = [...owned.cards, ...originals], offset = Number(request.searchParams.get('offset') ?? 0), limit = Number(request.searchParams.get('limit') ?? 3);
            const scores = [...owned.cards.map((card) => owned.scores.get(card.id)!), ...originals.map((_, position) => 0.8 - position * 0.1)];
            const matches = [...owned.cards.map((card) => owned.matches.get(card.id)!), ...originals.map((card) => ({ section: 'description', text: `Archive ${card.name}`, score: 0.5 }))];
            return Response.json({ cards: all.slice(offset, offset + limit), total: all.length, complete: true, snapshot: 'a'.repeat(64),
              scores: scores.slice(offset, offset + limit), matches: matches.slice(offset, offset + limit) });
          }
          return archiveApp.fetch(new Request(url, init));
        } } });
      const workspace = await services.cards.createWorkspace(actor, 'Desk');
      const reference = await services.cards.addArchiveReference(actor, workspace.id, 'demo:original');
      const original = await services.cards.open(actor, workspace.id, reference.id);
      const document = structuredClone(original.revision.document); (document.data as Record<string, unknown>).description = 'Saved island fork';
      const fork = await services.cards.forkAssets(actor, workspace.id, reference.id, original.revision.id, document, [], []);
      await services.searchIndex.settle();
      holdDelete = true;
      await services.cards.delete(actor, workspace.id, fork.cardId); await seen;
      const api = createApi({ cards: services.cards, nativeArchive: services.nativeArchive!, authenticate: () => actor });
      const path = `/api/workspaces/${workspace.id}/archive/v2/cards?q=island&mode=semantic`;
      const first = await api.request(`${path}&offset=0&limit=1`);
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ cards: [], scores: [], matches: [], nextOffset: 1, staleLibraryHits: 1, complete: false });
      const response = await api.request(`${path}&offset=0&limit=3`);
      expect(response.status).toBe(200);
      const page = await response.json() as { cards: { id: string; name: string }[]; scores: number[]; matches: { text: string }[]; nextOffset: number; staleLibraryHits: number; complete: boolean };
      expect(page.cards.map((card) => card.id)).toEqual(['demo:original', 'demo:other']);
      expect(page.scores).toEqual([0.8, 0.7000000000000001]);
      expect(page.matches.map((match) => match.text)).toEqual(page.cards.map((card) => `Archive ${card.name}`));
      expect(page).toMatchObject({ nextOffset: 3, staleLibraryHits: 1, complete: false });
      release(); await services.searchIndex.settle();
      expect(await services.libraryIndex!.status(actor, workspace.id)).toMatchObject({ pending: 1, failed: 1 });
      const failed = await api.request(`${path}&offset=1&limit=2`);
      expect(failed.status).toBe(200);
      expect(await failed.json()).toMatchObject({ cards: [{ id: 'demo:original' }, { id: 'demo:other' }], nextOffset: 3 });
      holdDelete = false; failDelete = false;
      await services.libraryIndex!.retry(actor, workspace.id);
      expect((await index.search(workspace.id, { q: 'island', mode: 'semantic' })).cards).toEqual([]);
    } finally { release(); services?.close(); services = undefined; await index.close(); archive.close(); }
  });
});
