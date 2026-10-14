import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

it('closes Node read descriptors after consumption, cancellation and HTTP HEAD without GC cleanup', async () => {
  const source = fileURLToPath(new URL('../src/node.ts', import.meta.url));
  const output = await build({ bundle: true, platform: 'node', target: 'node24', format: 'esm', write: false,
    stdin: { resolveDir: fileURLToPath(new URL('../../api/src', import.meta.url)), contents: `
      import assert from 'node:assert/strict';
      import { createHash } from 'node:crypto';
      import { mkdtemp, rm } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { setImmediate } from 'node:timers/promises';
      import { Hono } from 'hono';
      import { disposeUnusedResponseBody } from ${JSON.stringify(fileURLToPath(new URL('../../api/src/response-body.ts', import.meta.url)))};
      import { createNodeBlobStore } from ${JSON.stringify(source)};
      const warnings = [];
      process.on('warning', warning => { if (warning.code === 'DEP0137' || /FileHandle|garbage collection/.test(warning.message)) warnings.push(warning.message); });
      const root = await mkdtemp(join(tmpdir(), 'unity-read-lifecycle-'));
      try {
        const blobs = await createNodeBlobStore(root);
        const bytes = new Uint8Array(256 * 1024).fill(65);
        await blobs.put('assets/lifecycle', new Blob([bytes]).stream(), { byteLength: bytes.length, hash: createHash('sha256').update(bytes).digest('hex') });
        const app = new Hono();
        app.use('*', disposeUnusedResponseBody);
        app.get('/asset', async () => { const object = await blobs.get('assets/lifecycle'); return new Response(object.body); });
        for (const mode of ['consume', 'cancel', 'cancel-after-read', 'head']) {
          for (let i = 0; i < 12; i++) {
            if (mode === 'head') { assert.equal((await app.request('/asset', { method: 'HEAD' })).body, null); continue; }
            const object = await blobs.get('assets/lifecycle');
            if (mode === 'consume') assert.equal((await new Response(object.body).arrayBuffer()).byteLength, bytes.length);
            else if (mode === 'cancel') await object.body.cancel();
            else { const reader = object.body.getReader(); await reader.read(); await reader.cancel(); reader.releaseLock(); }
          }
        }
        for (let i = 0; i < 12; i++) { globalThis.gc(); await setImmediate(); }
        assert.deepEqual(warnings, [], 'read streams must close descriptors, not leave cleanup to garbage collection');
      } finally { await rm(root, { recursive: true, force: true }); }
    ` } });
  const result = await promisify(execFile)(process.execPath, ['--expose-gc', '--input-type=module', '-e', output.outputFiles[0]!.text], { timeout: 10_000 })
    .catch((error: unknown) => { throw new Error(error instanceof Error && 'stderr' in error ? String(error.stderr) : String(error)); });
  expect(result.stderr).not.toMatch(/DEP0137|FileHandle|garbage collection/);
});

it.each(['before-return', 'partial-read'])('closes Node read descriptors when HTTP clients disconnect: %s', async (phase) => {
  const hono = createRequire(new URL('../../api/package.json', import.meta.url)).resolve('hono');
  const output = await build({ bundle: true, minify: true, platform: 'node', target: 'node24', format: 'esm', write: false,
    stdin: { resolveDir: fileURLToPath(new URL('../../../apps/api/src', import.meta.url)), contents: `
      import assert from 'node:assert/strict';
      import { createHash } from 'node:crypto';
      import { mkdtemp, rm } from 'node:fs/promises';
      import { get } from 'node:http';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { setImmediate } from 'node:timers/promises';
      import { serve } from '@hono/node-server';
      import { Hono } from ${JSON.stringify(hono)};
      import { disposeUnusedResponseBody } from ${JSON.stringify(fileURLToPath(new URL('../../api/src/response-body.ts', import.meta.url)))};
      import { createNodeBlobStore } from ${JSON.stringify(fileURLToPath(new URL('../src/node.ts', import.meta.url)))};
      const warnings = [];
      process.on('warning', warning => { if (warning.code === 'DEP0137' || /FileHandle|garbage collection/.test(warning.message)) warnings.push(warning.message); });
      const root = await mkdtemp(join(tmpdir(), 'unity-disconnected-read-'));
      let server;
      try {
        const blobs = await createNodeBlobStore(root);
        const bytes = new Uint8Array(8 * 1024 * 1024).fill(65);
        await blobs.put('assets/lifecycle', new Blob([bytes]).stream(), { byteLength: bytes.length, hash: createHash('sha256').update(bytes).digest('hex') });
        const app = new Hono();
        app.use('*', disposeUnusedResponseBody);
        let opened, returned, disconnected;
        app.get('/asset', async context => {
          const object = await blobs.get('assets/lifecycle');
          const aborted = new Promise(resolve => context.req.raw.signal.addEventListener('abort', () => { disconnected(); resolve(); }, { once: true }));
          opened();
          if (context.req.query('phase') === 'before-return') await aborted;
          returned();
          return new Response(object.body, { headers: { 'content-length': String(object.byteLength) } });
        });
        server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
        await new Promise(resolve => server.once('listening', resolve));
        const origin = 'http://127.0.0.1:' + server.address().port;
        const phase = ${JSON.stringify(phase)};
        for (let i = 0; i < 12; i++) {
          const ready = new Promise(resolve => { opened = resolve; });
          const done = new Promise(resolve => { returned = resolve; });
          const aborted = new Promise(resolve => { disconnected = resolve; });
          let received = 0;
          const client = get(origin + '/asset?phase=' + phase, response => {
            response.once('data', chunk => { received += chunk.byteLength; response.destroy(); });
          });
          client.on('error', () => {});
          await ready;
          if (phase === 'before-return') client.destroy();
          await done;
          await aborted;
          if (phase === 'partial-read') assert.ok(received > 0 && received < bytes.byteLength, 'client must disconnect after receiving only part of the file');
          await setImmediate();
        }
        await new Promise(resolve => server.close(resolve));
        server = undefined;
        for (let i = 0; i < 12; i++) { globalThis.gc(); await setImmediate(); }
        assert.deepEqual(warnings, [], 'disconnected HTTP responses must close descriptors rather than leave cleanup to garbage collection');
      } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        await rm(root, { recursive: true, force: true });
      }
    ` } });
  const result = await promisify(execFile)(process.execPath, ['--expose-gc', '--input-type=module', '-e', output.outputFiles[0]!.text], { timeout: 10_000 })
    .catch((error: unknown) => { throw new Error(error instanceof Error && 'stderr' in error ? String(error.stderr) : String(error)); });
  expect(result.stderr).not.toMatch(/DEP0137|FileHandle|garbage collection/);
});
