import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createNodeBlobStore } from '../src/node.js';
import type { BlobIntegrity, BlobStore } from '../src/index.js';

const bytes = new TextEncoder().encode('Aster: exact original bytes.\n');
const integrity = (value: Uint8Array): BlobIntegrity => ({ hash: createHash('sha256').update(value).digest('hex'), byteLength: value.byteLength });
const stream = (value: Uint8Array) => new ReadableStream<Uint8Array>({ start(controller) {
  for (let offset = 0; offset < value.byteLength; offset += 3) controller.enqueue(value.slice(offset, offset + 3));
  controller.close();
} });

let worker: string;
beforeAll(async () => {
  const source = fileURLToPath(new URL('../src/r2.ts', import.meta.url));
  const built = await build({ bundle: true, platform: 'browser', target: 'es2022', format: 'esm', write: false,
    stdin: { resolveDir: dirname(source), contents: `
      import { createR2BlobStore } from ${JSON.stringify(source)};
      export default { async fetch(request, env) {
        const blobs = createR2BlobStore(env.BUCKET, (size) => new FixedLengthStream(size), { maxBytes: 1024 });
        const key = new URL(request.url).pathname.slice(1);
        try {
          if (key === '__abort') {
            const stalled = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([65])); } });
            await blobs.put('assets/aborted', stalled, { hash: request.headers.get('x-hash'), byteLength: 4 }, { signal: AbortSignal.timeout(20) });
            return new Response('unexpected success', { status: 500 });
          }
          if (request.method === 'PUT') {
            // Buffer only the tiny test transport envelope, then exercise the adapter with chunks.
            // This keeps an intentional early body cancellation from becoming a TCP reset to the runner.
            const data = new Uint8Array(await request.arrayBuffer());
            const body = new ReadableStream({ start(c) {
              for (let offset = 0; offset < data.length; offset += 3) c.enqueue(data.slice(offset, offset + 3));
              c.close();
            } });
            const result = await blobs.put(key, body, {
              hash: request.headers.get('x-hash'), byteLength: Number(request.headers.get('x-length')),
            });
            return Response.json(result);
          }
          const object = await blobs.get(key);
          return object ? new Response(object.body, { headers: { 'x-length': String(object.byteLength) } }) : new Response(null, { status: 404 });
        } catch (error) { return Response.json({ code: error.code ?? 'INTERNAL', message: error.message }, { status: 400 }); }
      } };
    ` },
  });
  worker = built.outputFiles[0]!.text;
});

interface Fixture { blobs: BlobStore; pending(): Promise<number>; close(): Promise<void>; abort?(): Promise<Response> }
const factories: Record<string, () => Promise<Fixture>> = {
  node: async () => {
    const root = await mkdtemp(join(tmpdir(), 'unity-blobs-'));
    return { blobs: await createNodeBlobStore(root, { maxBytes: 1024 }),
      pending: async () => (await readdir(join(root, '.pending'))).length,
      close: () => rm(root, { recursive: true, force: true }) };
  },
  r2: async () => {
    const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: worker,
      compatibilityDate: '2026-10-11', r2Buckets: ['BUCKET'], port: 0 }));
    const address = await mf.ready;
    const bucket = await mf.getR2Bucket('BUCKET');
    const blobs: BlobStore = {
      async put(key, body, expected) {
        const request: RequestInit & { duplex: 'half' } = { method: 'PUT', body, duplex: 'half',
          headers: { 'x-hash': expected.hash, 'x-length': String(expected.byteLength) } };
        const response = await fetch(new URL(`/${key}`, address), request);
        const data: unknown = await response.json();
        if (!data || typeof data !== 'object') throw new Error('Invalid fixture response');
        if (!response.ok) throw Object.assign(new Error('Blob operation rejected'), data);
        if (!('hash' in data) || !('byteLength' in data) || typeof data.hash !== 'string' || typeof data.byteLength !== 'number') throw new Error('Invalid integrity response');
        return { hash: data.hash, byteLength: data.byteLength };
      },
      async get(key) {
        const response = await fetch(new URL(`/${key}`, address));
        if (response.status === 404) return null;
        if (!response.ok) throw Object.assign(new Error('Read rejected'), await response.json());
        if (!response.body) throw new Error('Missing response body');
        return { body: response.body, byteLength: Number(response.headers.get('x-length')) };
      },
    };
    return { blobs, pending: async () => (await bucket.list({ prefix: 'pending/' })).objects.length,
      close: () => mf.dispose(), abort: () => fetch(new URL('/__abort', address), { headers: { 'x-hash': 'a'.repeat(64) } }) };
  },
};

for (const [adapter, createFixture] of Object.entries(factories)) {
  describe(`blob contract / ${adapter}`, () => {
    let fixture: Fixture;
    beforeEach(async () => { fixture = await createFixture(); });
    afterEach(async () => { await fixture?.close(); });
    it('[B01] streams exact bytes and completes without pending objects', async () => {
      expect(await fixture.blobs.put('originals/test-original', stream(bytes), integrity(bytes))).toEqual(integrity(bytes));
      const object = await fixture.blobs.get('originals/test-original');
      expect(object?.byteLength).toBe(bytes.byteLength);
      expect(new Uint8Array(await new Response(object!.body).arrayBuffer())).toEqual(bytes);
      expect(await fixture.pending()).toBe(0);
    });
    it('[B02] rejects hash mismatch, truncation and excess bytes without publishing', async () => {
      const invalid = [
        { hash: 'a'.repeat(64), byteLength: bytes.byteLength },
        { ...integrity(bytes), byteLength: bytes.byteLength + 1 },
        { ...integrity(bytes), byteLength: bytes.byteLength - 1 },
      ];
      for (const expected of invalid) {
        await expect(fixture.blobs.put('assets/rejected', stream(bytes), expected)).rejects.toThrow();
        expect(await fixture.blobs.get('assets/rejected')).toBeNull();
        expect(await fixture.pending()).toBe(0);
      }
    });
    it('[B03] rejects declared oversize before publishing and cleans up', async () => {
      const large = new Uint8Array(1025);
      await expect(fixture.blobs.put('assets/large', stream(large), integrity(large))).rejects.toMatchObject({ code: 'TOO_LARGE' });
      expect(await fixture.blobs.get('assets/large')).toBeNull();
      expect(await fixture.pending()).toBe(0);
    });
    it('[B04] accepts identical retries without overwriting a different original', async () => {
      await fixture.blobs.put('originals/immutable', stream(bytes), integrity(bytes));
      expect(await fixture.blobs.put('originals/immutable', stream(bytes), integrity(bytes))).toEqual(integrity(bytes));
      const altered = new TextEncoder().encode('replacement bytes');
      await expect(fixture.blobs.put('originals/immutable', stream(altered), integrity(altered))).rejects.toThrow();
      const saved = await fixture.blobs.get('originals/immutable');
      expect(new Uint8Array(await new Response(saved!.body).arrayBuffer())).toEqual(bytes);
      expect(await fixture.pending()).toBe(0);
    });
    it('[B05] concurrent equal writes remain idempotent', async () => {
      const writes = await Promise.all([1, 2].map(() => fixture.blobs.put('assets/concurrent', stream(bytes), integrity(bytes))));
      expect(writes).toEqual([integrity(bytes), integrity(bytes)]);
      expect(await fixture.pending()).toBe(0);
    });
    it('[B06] represents an empty object distinctly from an absent object', async () => {
      expect(await fixture.blobs.get('assets/absent')).toBeNull();
      const empty = new Uint8Array();
      await fixture.blobs.put('assets/empty', stream(empty), integrity(empty));
      const object = await fixture.blobs.get('assets/empty');
      expect(object?.byteLength).toBe(0);
      expect(await new Response(object!.body).text()).toBe('');
    });
    it('[B07] aborts stalled input without publishing or leaving pending objects', async () => {
      if (fixture.abort) {
        const response = await fixture.abort();
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ code: 'ABORTED' });
      } else {
        let cancelled = false;
        const stalled = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([65])); }, cancel() { cancelled = true; } });
        await expect(fixture.blobs.put('assets/aborted', stalled, { hash: 'a'.repeat(64), byteLength: 4 }, { signal: AbortSignal.timeout(20) })).rejects.toMatchObject({ code: 'ABORTED' });
        expect(cancelled).toBe(true);
      }
      expect(await fixture.blobs.get('assets/aborted')).toBeNull();
      expect(await fixture.pending()).toBe(0);
    });
    it('[B08] rejects keys outside the immutable namespaces', async () => {
      for (const key of ['outside', 'assets/file.png', 'assets/%2e%2e', 'pending/hidden']) {
        await expect(fixture.blobs.put(key, stream(bytes), integrity(bytes))).rejects.toMatchObject({ code: 'INVALID_KEY' });
      }
      expect(await fixture.pending()).toBe(0);
    });
  });
}
