import type { Context } from 'hono';
import { CardError } from '@character-unity/cards/contract';

export async function bytes(c: Context, max: number) {
  const body = c.req.raw.body;
  if (!body) throw new CardError('INVALID_INPUT', 'A request body is required');
  const reader = body.getReader();
  const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30_000)]);
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (signal.aborted) throw new CardError('INVALID_INPUT', 'Request was cancelled or timed out');
    while (true) {
      const value = await reader.read();
      if (signal.aborted) throw new CardError('INVALID_INPUT', 'Request was cancelled or timed out');
      if (value.done) break;
      size += value.value.length;
      if (size > max) throw new CardError('TOO_LARGE', 'Request exceeds its byte limit');
      chunks.push(new Uint8Array(value.value));
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
export async function json(c: Context, max: number): Promise<Record<string, unknown>> {
  if (c.req.header('content-type')?.split(';')[0] !== 'application/json') throw new CardError('INVALID_INPUT', 'Expected application/json');
  const body = await bytes(c, max);
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new CardError('INVALID_INPUT', 'Expected a JSON object'); }
}
