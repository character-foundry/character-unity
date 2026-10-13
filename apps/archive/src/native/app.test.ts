import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ScraperPlugin } from '@character-unity/scraper-kit';
import { openNativeArchive } from './store.js';
import type { NativeArchive } from './store.js';
import { createScheduler } from './scheduler.js';
import { createNativeArchiveApp, nativeAdminPrefix, nativeReadPrefix } from './app.js';

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
    expect((await app.request(`${nativeReadPrefix}/objects/abc`)).status).toBe(400);
    expect((await app.request(`${nativeReadPrefix}/cards?q=tag:demo&has=greetings,lorebook&match=any&minTokens=10`)).status).toBe(200);
  });
});
