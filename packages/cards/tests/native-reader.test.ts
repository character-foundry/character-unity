import { describe, expect, it } from 'vitest';
import { hashBytes } from '@character-foundry/character-foundry/identity';
import { createNativeArchiveReader } from '../src/native-reader.js';

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
