import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { consumeVerified } from '../src/verify.js';

it('hashes and writes an owned chunk even when the producer reuses its buffer', async () => {
  const shared = new TextEncoder().encode('original');
  const expected = { hash: createHash('sha256').update(shared).digest('hex'), byteLength: shared.length };
  const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(shared); controller.close(); } });
  let written = '';
  await consumeVerified(source, expected, async (chunk) => {
    shared.fill(0);
    await Promise.resolve();
    written += new TextDecoder().decode(chunk);
  });
  expect(written).toBe('original');
});
