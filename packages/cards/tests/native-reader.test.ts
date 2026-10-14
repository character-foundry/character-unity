import { describe, expect, it } from 'vitest';
import { hashBytes } from '@character-foundry/character-foundry/identity';
import { createNativeArchiveReader } from '../src/native-reader.js';
import { writeCharX } from '@character-foundry/character-foundry/charx';

/** A connected peer can return headers and then stop sending its body. */
function stalledBody() {
  let entered!: () => void, cancelled = false;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  const stream = new ReadableStream<Uint8Array>({
    pull() { entered(); },
    cancel() { cancelled = true; },
  });
  return { stream, reading, cancelled: () => cancelled };
}

describe('native Archive reader cancellation', () => {
  it('cancels a stalled object response body when its caller aborts', async () => {
    const body = stalledBody(), cancellation = new AbortController();
    const reader = createNativeArchiveReader({ origin: 'http://archive.test', fetch: async () => new Response(body.stream) });
    const reading = reader.object({ role: 'card', name: 'card.json', sha256: await hashBytes(new Uint8Array([1])), byteLength: 1, mediaType: 'application/json' }, cancellation.signal);
    await body.reading; cancellation.abort();
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    expect(body.cancelled()).toBe(true);
  });

  it('cancels a response returned late by a fetch adapter that ignored its signal', async () => {
    let release!: (value: Response) => void;
    const late = new Promise<Response>((resolve) => { release = resolve; });
    const body = stalledBody(), cancellation = new AbortController();
    const reader = createNativeArchiveReader({ origin: 'http://archive.test', fetch: async () => late });
    const reading = reader.status(cancellation.signal);
    cancellation.abort(); release(new Response(body.stream, { headers: { 'content-type': 'application/json' } }));
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    expect(body.cancelled()).toBe(true);
  });

  it('preserves cancellation of a stalled metadata body instead of reporting a malformed protocol', async () => {
    const body = stalledBody(), cancellation = new AbortController();
    const reader = createNativeArchiveReader({ origin: 'http://archive.test', fetch: async () => new Response(body.stream, { headers: { 'content-type': 'application/json' } }) });
    const reading = reader.card('source', 'pinned', cancellation.signal);
    await body.reading; cancellation.abort();
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    expect(body.cancelled()).toBe(true);
  });
});

describe('hosted Archive read budgets', () => {
  it('rejects oversized declared objects before fetching and rejects an aggregate version before reading sidecars', async () => {
    const document = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Small', assets: [
      { type: 'custom', uri: 'embeded://notes.txt', name: 'notes', ext: 'txt' },
    ] } }, bytes = new TextEncoder().encode(JSON.stringify(document)), calls: string[] = [];
    const card = { role: 'card' as const, name: 'card.json', sha256: await hashBytes(bytes), byteLength: bytes.length, mediaType: 'application/json' };
    const reader = createNativeArchiveReader({ origin: 'http://archive.test', maxReadBytes: bytes.length,
      fetch: async (url) => { calls.push(url); return new Response(bytes); } });
    await expect(reader.object({ ...card, byteLength: bytes.length + 1 })).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(calls).toEqual([]);
    const reference = { role: 'asset' as const, name: 'embeded://notes.txt', sha256: 'a'.repeat(64), byteLength: 1, mediaType: 'text/plain' };
    const pin = { archiveId: 'fixture', cardId: 'card', versionId: 'v1' };
    const aggregate = createNativeArchiveReader({ origin: 'http://archive.test', maxReadBytes: bytes.length, fetch: async (url) => {
      calls.push(url);
      return url.includes('/objects/') ? new Response(bytes) : Response.json({ archiveId: pin.archiveId, id: pin.cardId, versionId: pin.versionId,
        versionList: [{ id: pin.versionId, objects: [card, reference] }] });
    } });
    await expect(aggregate.load(pin)).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(calls.filter((url) => url.includes('/objects/'))).toEqual([`http://archive.test/api/archive/v2/objects/${card.sha256}`]);
  });

  it('bounds CharX expanded contents as well as wire bytes and rejects invalid host budgets', async () => {
    const document = { spec: 'chara_card_v3' as const, spec_version: '3.0' as const, data: {
      name: 'Expansion fixture', description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
      tags: [], creator: '', character_version: '', creator_notes: '', alternate_greetings: [], group_only_greetings: [], extensions: {}, assets: [
      { type: 'custom' as const, uri: 'embeded://other/notes.txt', name: 'notes', ext: 'txt' },
    ] } };
    const bytes = new Uint8Array(writeCharX(document, [{ type: 'custom', name: 'notes', ext: 'txt', data: new Uint8Array(128_000) }], { preserveDescriptors: true }).buffer);
    expect(bytes.byteLength).toBeLessThan(4096);
    const pin = { archiveId: 'fixture', cardId: 'card', versionId: 'v1' };
    const object = { role: 'card', name: 'card.charx', sha256: await hashBytes(bytes), byteLength: bytes.length, mediaType: 'application/zip' };
    const reader = createNativeArchiveReader({ origin: 'http://archive.test', maxReadBytes: 4096, fetch: async (url) => url.includes('/objects/')
      ? new Response(bytes) : Response.json({ archiveId: pin.archiveId, id: pin.cardId, versionId: pin.versionId, versionList: [{ id: pin.versionId, objects: [object] }] }) });
    const outcome = await reader.load(pin).then(() => 'accepted', (error: unknown) => error instanceof Error && 'code' in error ? error.code : 'unknown');
    expect(outcome).toBe('TOO_LARGE');
    for (const maxReadBytes of [0, -1, 1.5, Number.NaN, 513 * 1024 * 1024]) expect(() => createNativeArchiveReader({ origin: 'http://archive.test', maxReadBytes })).toThrow();
  });
});
