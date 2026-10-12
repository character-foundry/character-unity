import { describe, expect, it } from 'vitest';
import { createHttp, isPlaceholderImage, resolveSettings, runScrape, ScrapeHttpError } from '../src/index.js';
import type { Listing, ScrapedCard, ScraperPlugin, ScrapeSink } from '../src/index.js';

const reply = (status: number, body = '{}', headers: Record<string, string> = {}) => new Response(body, { status, headers });

describe('polite HTTP', () => {
  it('spaces requests, retries transient failures and fails fast on other 4xx', async () => {
    const waits: number[] = [], calls: string[] = [];
    const answers = [reply(429, '', { 'retry-after': '2' }), reply(503), reply(200, '{"ok":true}'), reply(404)];
    const http = createHttp({ minIntervalMs: 1000, retryDelaysMs: [10, 20, 30], sleep: async (ms) => { waits.push(ms); },
      fetch: async (url) => { calls.push(url); return answers.shift()!; } });
    expect(await http.json('https://source.test/a')).toEqual({ ok: true });
    // Retry-After (2 s) on the 429, then the second backoff step after the 503; the test clock does not move, so spacing waits are interleaved.
    expect(waits.filter((ms) => ms === 2000 || ms === 20)).toEqual([2000, 20]);
    await expect(http.json('https://source.test/b')).rejects.toMatchObject({ status: 404 });
    expect(calls).toEqual(['https://source.test/a', 'https://source.test/a', 'https://source.test/a', 'https://source.test/b']);
    // Every request after the first waited for the spacing.
    expect(waits.filter((ms) => ms > 900 && ms <= 1000).length).toBeGreaterThanOrEqual(2);
  });

  it('gives up after the retry budget with the last status', async () => {
    const http = createHttp({ minIntervalMs: 0, retryDelaysMs: [1, 1], sleep: async () => undefined, fetch: async () => reply(502) });
    const failure = await http.json('https://source.test/x').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ScrapeHttpError);
    expect(failure).toMatchObject({ status: 502 });
  });

  it('refuses oversized bodies', async () => {
    const http = createHttp({ minIntervalMs: 0, maxBytes: 4, fetch: async () => reply(200, '0123456789') });
    await expect(http.text('https://source.test/big')).rejects.toThrow(/larger than 4 bytes/);
  });
});

describe('settings', () => {
  it('fills defaults and clamps values to their specs', () => {
    const plugin = { settings: [
      { key: 'pages', label: 'Pages', type: 'number' as const, default: 1, min: 1, max: 50 },
      { key: 'tags', label: 'Tags', type: 'list' as const, default: [] },
      { key: 'sort', label: 'Sort', type: 'choice' as const, default: 'a', choices: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
    ] };
    expect(resolveSettings(plugin, { pages: 900, tags: [' x ', 'x', 3, ''], sort: 'z' })).toEqual({ pages: 50, tags: ['x'], sort: 'a' });
  });
});

describe('placeholder images', () => {
  it('treats tiny and 240×240 low-weight PNGs as placeholders', () => {
    const png = (width: number, height: number, size: number) => {
      const bytes = new Uint8Array(size);
      bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
      new DataView(bytes.buffer).setUint32(16, width); new DataView(bytes.buffer).setUint32(20, height);
      return bytes;
    };
    expect(isPlaceholderImage(png(240, 240, 40_000))).toBe(true);
    expect(isPlaceholderImage(png(32, 32, 40_000))).toBe(true);
    expect(isPlaceholderImage(new Uint8Array(100))).toBe(true);
    expect(isPlaceholderImage(png(800, 1200, 400_000))).toBe(false);
  });
});

describe('run loop', () => {
  function setup(listings: Listing[], failing = new Set<string>()) {
    const fetched: string[] = [];
    const plugin: ScraperPlugin = {
      provider: 'demo', label: 'Demo', minIntervalMs: 0, settings: [], secrets: [],
      async *discover() { for (const listing of listings) yield listing; },
      async fetch(_context, listing): Promise<ScrapedCard | null> {
        fetched.push(listing.recordId);
        if (failing.has(listing.recordId)) throw new Error(`boom ${listing.recordId}`);
        if (listing.recordId === 'skip') return null;
        return { provider: 'demo', recordId: listing.recordId, url: `https://demo.test/${listing.recordId}`, objects: [] };
      },
    };
    const store = new Map<string, string | null>([['old', '2026-01-01T00:00:00Z'], ['stale', '2026-01-01T00:00:00Z']]);
    const touched: string[] = [];
    const sink: ScrapeSink = {
      blocked: (_p, id) => id === 'banned',
      known: (_p, id) => store.has(id) ? { updatedAt: store.get(id)! } : null,
      seen: (_p, id) => { touched.push(id); },
      async put(card) { const had = store.has(card.recordId); store.set(card.recordId, null); return had ? 'updated' : 'added'; },
    };
    return { plugin, sink, fetched, touched };
  }

  it('fetches only new or changed cards, never blocked ones, and counts each outcome', async () => {
    const { plugin, sink, fetched, touched } = setup([
      { recordId: 'new' }, { recordId: 'old', updatedAt: '2026-01-01T00:00:00.400Z' }, { recordId: 'stale', updatedAt: '2026-03-01T00:00:00Z' },
      { recordId: 'banned' }, { recordId: 'skip' }, { recordId: 'new' },
    ]);
    const result = await runScrape(plugin, sink, {});
    expect(result).toMatchObject({ status: 'done', listed: 5, added: 1, updated: 1, unchanged: 1, blocked: 1, skipped: 1, errors: 0 });
    expect(fetched).toEqual(['new', 'stale', 'skip']);
    expect(touched).toEqual(['old']);
  });

  it('keeps going past a failing card but stops when a source keeps failing', async () => {
    const one = setup([{ recordId: 'a' }, { recordId: 'b' }], new Set(['a']));
    expect(await runScrape(one.plugin, one.sink, {})).toMatchObject({ status: 'done', errors: 1, added: 1, error: 'Last card error: boom a' });
    const many = setup(['a', 'b', 'c', 'd'].map((recordId) => ({ recordId })), new Set(['a', 'b', 'c', 'd']));
    const result = await runScrape(many.plugin, many.sink, { maxConsecutiveErrors: 3 });
    expect(result.status).toBe('failed');
    expect(many.fetched).toEqual(['a', 'b', 'c']);
  });

  it('stops between cards when cancelled', async () => {
    const controller = new AbortController();
    const { plugin, sink, fetched } = setup(['a', 'b', 'c'].map((recordId) => ({ recordId })));
    const result = await runScrape(plugin, sink, { signal: controller.signal, onProgress: () => controller.abort() });
    expect(result.status).toBe('cancelled');
    expect(fetched).toEqual(['a']);
  });
});
