import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ScrapedCard } from '@character-unity/scraper-kit';
import { openNativeArchive } from './store.js';
import type { NativeArchive } from './store.js';

const encoder = new TextEncoder();
function cardJson(data: Record<string, unknown>) {
  return encoder.encode(JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: {
    name: 'Aster', description: 'A map keeper.', personality: '', scenario: '', first_mes: 'Hello.', mes_example: '',
    creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '1', extensions: {}, ...data } }));
}
function png(width: number, height: number, size: number) {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width); new DataView(bytes.buffer).setUint32(20, height);
  bytes[size - 1] = width % 251;
  return bytes;
}
function scraped(recordId: string, data: Record<string, unknown> = {}, extra: Partial<ScrapedCard> = {}): ScrapedCard {
  return { provider: 'chub', recordId, url: `https://chub.test/${recordId}`, creator: 'ash', tags: ['Fantasy'],
    updatedAt: '2026-05-01T00:00:00Z', stats: { stars: 3 }, objects: [{ role: 'card', bytes: cardJson(data), mediaType: 'application/json' }], ...extra };
}

describe('native Archive store', () => {
  let directory: string, archive: NativeArchive, clock = 0;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'unity-native-archive-'));
    clock = 0;
    archive = await openNativeArchive(directory, { now: () => new Date(Date.UTC(2026, 9, 1, 0, 0, clock++)).toISOString() });
  });
  afterEach(async () => { archive.close(); await rm(directory, { recursive: true, force: true }); });

  it('adds a card, keeps unchanged bytes as one version and appends a version when the card changes', async () => {
    expect(await archive.put(scraped('1', { alternate_greetings: ['Hi again'], character_book: { entries: [{ keys: ['a'], content: 'b' }] } }))).toBe('added');
    expect(await archive.put(scraped('1', { alternate_greetings: ['Hi again'], character_book: { entries: [{ keys: ['a'], content: 'b' }] } }, { stats: { stars: 9 } }))).toBe('unchanged');
    let [card] = archive.list().cards;
    expect(card).toMatchObject({ id: 'chub:1', name: 'Aster', creator: 'ash', tags: ['Fantasy'], altGreetings: 1, lorebookEntries: 1, versions: 1, stats: { stars: 9 } });
    expect(card!.tokens).toBeGreaterThan(0);
    expect(await archive.put(scraped('1', { description: 'A changed map keeper.' }, { updatedAt: '2026-06-01T00:00:00Z' }))).toBe('updated');
    const detail = await archive.card('chub:1');
    expect(detail.versions).toBe(2);
    expect(detail.versionList.map((version) => version.sequence)).toEqual([2, 1]);
    expect((detail.document as { data: { description: string } }).data.description).toBe('A changed map keeper.');
    // The first version's bytes are still there.
    const first = detail.versionList[1]!.objects.find((object) => object.role === 'card')!;
    expect(new TextDecoder().decode((await archive.object(first.sha256)).bytes)).toContain('A map keeper.');
    [card] = archive.list().cards;
    expect(card!.remoteUpdatedAt).toBe('2026-06-01T00:00:00.000Z');
  });

  it('searches with the library syntax, tags, flags, provider, tokens and sorts', async () => {
    await archive.put(scraped('1', { name: 'Vampire Queen', description: 'Rules a modern city at night.' }, { tags: ['Fantasy', 'Vampire'], stats: { stars: 50 } }));
    await archive.put(scraped('2', { name: 'Werewolf Pal', description: 'Lives in the woods.', system_prompt: 'Be kind.' }, { tags: ['Fantasy'], stats: { stars: 5 } }));
    await archive.put(scraped('3', { name: 'Space Elf', description: 'Sci-fi elf pilot.', mes_example: '<START> hi' }, { tags: ['SciFi'], creator: 'birch', provider: 'ct', url: 'https://ct.test/3' }));
    const names = (query: Parameters<NativeArchive['list']>[0]) => archive.list(query).cards.map((card) => card.name).sort();
    expect(names({ q: 'vampire OR werewolf' })).toEqual(['Vampire Queen', 'Werewolf Pal']);
    expect(names({ q: '"modern city"' })).toEqual(['Vampire Queen']);
    expect(names({ q: 'fantasy -vamp' })).toEqual(['Werewolf Pal']);
    expect(names({ q: 'creator:birch' })).toEqual(['Space Elf']);
    expect(names({ q: 'sci-fi' })).toEqual(['Space Elf']);
    expect(names({ q: 'tag:vampire' })).toEqual(['Vampire Queen']);
    expect(names({ q: '!!!' })).toEqual([]);
    expect(names({ tags: ['fantasy'], exclude: ['VAMPIRE'] })).toEqual(['Werewolf Pal']);
    expect(names({ tags: ['vampire', 'scifi'], tagMode: 'any' })).toEqual(['Space Elf', 'Vampire Queen']);
    expect(names({ has: ['systemPrompt'] })).toEqual(['Werewolf Pal']);
    expect(names({ has: ['exampleDialogues'] })).toEqual(['Space Elf']);
    expect(names({ has: ['followed'], creators: ['BIRCH '] })).toEqual(['Space Elf']);
    expect(names({ has: ['followed'] })).toEqual([]);
    expect(names({ provider: 'ct' })).toEqual(['Space Elf']);
    expect(archive.list({ sort: 'stars' }).cards[0]!.name).toBe('Vampire Queen');
    expect(archive.list({ limit: 1, offset: 1, sort: 'name' })).toMatchObject({ total: 3, cards: [{ name: 'Vampire Queen' }] });
    expect(archive.tags()).toEqual([{ tag: 'Fantasy', count: 2 }, { tag: 'SciFi', count: 1 }, { tag: 'Vampire', count: 1 }]);
    expect(archive.status()).toMatchObject({ cards: 3, providers: { chub: 2, ct: 1 } });
  });

  it('hides blocked records everywhere and tells the run loop not to fetch them', async () => {
    await archive.put(scraped('1'));
    archive.block('chub', '1');
    expect(archive.list().total).toBe(0);
    await expect(archive.card('chub:1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await archive.sink.blocked('chub', '1')).toBe(true);
    expect(archive.status().cards).toBe(0);
    archive.unblock('chub', '1');
    expect(archive.list().total).toBe(1);
  });

  it('never replaces a real portrait with a placeholder', async () => {
    const real = png(800, 1200, 60_000), fuzz = png(240, 240, 20_000);
    await archive.put(scraped('1', {}, { objects: [{ role: 'card', bytes: cardJson({}), mediaType: 'application/json' }, { role: 'portrait', bytes: real, mediaType: 'image/png' }] }));
    const before = archive.list().cards[0]!.portrait;
    await archive.put(scraped('1', { description: 'new text' }, { objects: [{ role: 'card', bytes: cardJson({ description: 'new text' }), mediaType: 'application/json' }, { role: 'portrait', bytes: fuzz, mediaType: 'image/png' }] }));
    const after = archive.list().cards[0]!;
    expect(after.versions).toBe(2);
    expect(after.portrait).toBe(before);
  });

  it('refuses unreadable card files and malformed records without storing a card', async () => {
    await expect(archive.put(scraped('1', {}, { objects: [{ role: 'card', bytes: encoder.encode('not a card'), mediaType: 'application/json' }] }))).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
    await expect(archive.put(scraped('a/b'))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(archive.put(scraped('2', {}, { objects: [] }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(archive.list().total).toBe(0);
  });

  it('keeps sources, secrets and runs; a run left running is closed on reopen', async () => {
    archive.saveSource({ provider: 'chub', enabled: true, intervalMinutes: 60, settings: { pages: 2 }, secrets: { apiKey: 'k' } });
    expect(archive.source('chub')).toMatchObject({ enabled: true, intervalMinutes: 60, settings: { pages: 2 }, secrets: { apiKey: 'k' } });
    expect(archive.source('ct')).toMatchObject({ enabled: false, updatedAt: null });
    const id = archive.startRun('chub', 'manual');
    archive.progressRun(id, { listed: 4, added: 1, updated: 0, unchanged: 3, skipped: 0, blocked: 0, errors: 0 });
    archive.close();
    archive = await openNativeArchive(directory);
    expect(archive.runs('chub')[0]).toMatchObject({ id, status: 'failed', listed: 4, error: 'The Archive stopped during this run' });
    expect((await readdir(join(directory, 'objects'))).length).toBe(0);
  });
});
