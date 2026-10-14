import { expect, it } from 'vitest';
import { createApi } from './index.js';

it('awaits disposal of a HEAD body while preserving its GET status and download metadata', async () => {
  let disposed = false;
  const app = createApi();
  app.get('/stream', () => new Response(new ReadableStream<Uint8Array>({ async cancel() {
    await Promise.resolve(); disposed = true;
  } }), { status: 206, headers: { 'content-type': 'image/png', 'content-length': '4000000', 'etag': '"exact-version"', 'cache-control': 'no-store' } }));
  const response = await app.request('/stream', { method: 'HEAD' });
  expect(disposed).toBe(true);
  expect(response.status).toBe(206);
  expect(response.body).toBeNull();
  expect(Object.fromEntries(response.headers)).toEqual({ 'content-type': 'image/png', 'content-length': '4000000', 'etag': '"exact-version"', 'cache-control': 'no-store' });
});

it('leaves GET body ownership with the caller', async () => {
  let disposed = false;
  const app = createApi();
  app.get('/stream', () => new Response(new ReadableStream<Uint8Array>({ cancel() { disposed = true; } })));
  const response = await app.request('/stream');
  expect(disposed).toBe(false);
  await response.body!.cancel();
  expect(disposed).toBe(true);
});

it('awaits disposal when the request aborts before the route returns its response', async () => {
  const controller = new AbortController();
  const reason = new Error('Client disconnected');
  let disposed = false;
  let cancellation: unknown;
  const app = createApi();
  app.get('/stream', async () => {
    const body = new ReadableStream<Uint8Array>({ async cancel(value) {
      await Promise.resolve(); disposed = true; cancellation = value;
    } });
    controller.abort(reason);
    return new Response(body, { status: 206, headers: { 'content-length': '4000000', etag: '"exact-version"' } });
  });
  const response = await app.request(new Request('http://localhost/stream', { signal: controller.signal }));
  expect(disposed).toBe(true);
  expect(cancellation).toBe(reason);
  expect(response.body).toBeNull();
  expect(response.status).toBe(206);
  expect(response.headers.get('content-length')).toBe('4000000');
  expect(response.headers.get('etag')).toBe('"exact-version"');
});
