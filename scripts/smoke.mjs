import { createCopyFixture } from '../apps/archive/tests/copy-fixture.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, access, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';

// Exercise built executables on OS-assigned ports; only stop processes we started.
for (const [app, service, archiveMode] of [['api', 'unity-api', 'off'], ['archive', 'unity-archive', 'off'], ['archive', 'unity-archive', 'fixture'], ['archive', 'unity-archive', 'copy']]) {
  const blobDirectory = await mkdtemp(join(tmpdir(), 'unity-smoke-blobs-'));
  let copiedDatabase;
  if (archiveMode === 'copy') {
    try { await createCopyFixture(blobDirectory); copiedDatabase = await readFile(join(blobDirectory, 'archive.sqlite')); }
    catch (error) { await rm(blobDirectory, { recursive: true, force: true }); throw error; }
  }
  const env = { ...process.env, HOST: '127.0.0.1', PORT: '0', UNITY_PROFILE: 'local', UNITY_DB_PATH: ':memory:', UNITY_BLOB_DIR: blobDirectory, UNITY_WEB_DIR: app === 'api' ? resolve('apps/web/dist') : '', UNITY_ARCHIVE_MODE: archiveMode, UNITY_ARCHIVE_COPY_ROOT: archiveMode === 'copy' ? blobDirectory : '', UNITY_ARCHIVE_ORIGIN: '', UNITY_ARCHIVE_NATIVE_ORIGIN: '' };
  delete env.UNITY_REMOTE_CONNECTIONS_FILE;
  const child = spawn(process.execPath, [`apps/${app}/dist/node.js`], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout });
  try {
    const address = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${app} startup timed out: ${stderr}`)), 10_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`${app} exited ${code}: ${stderr}`)); });
      lines.on('line', (line) => {
        try {
          const message = JSON.parse(line);
          if (message.event === 'listening') { clearTimeout(timer); resolve(message); }
        } catch { /* Ignore unrelated startup output. */ }
      });
    });
    assert.equal(address.service, service);
    const response = await fetch(`http://127.0.0.1:${address.port}/api/health`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { service, status: 'ok', stage: 'scaffold' });
    if (app === 'api') {
      const ready = await fetch(`http://127.0.0.1:${address.port}/api/ready`, { signal: AbortSignal.timeout(5_000) });
      assert.equal(ready.status, 200);
      assert.deepEqual(await ready.json(), { status: 'ready', storage: { schemaVersion: 12 } });
      const apiOrigin = `http://127.0.0.1:${address.port}`;
      for (const path of ['/', '/new', '/card/example/edit', '/card/example/fork', '/archive']) {
        const page = await fetch(`${apiOrigin}${path}`, { signal: AbortSignal.timeout(5_000) });
        assert.equal(page.status, 200); assert.match(page.headers.get('content-type') ?? '', /text\/html/);
      }
      for (const path of ['/api/missing', '/runtime/unity.db', '/unexpected-file']) {
        assert.equal((await fetch(`${apiOrigin}${path}`, { signal: AbortSignal.timeout(5_000) })).status, 404);
      }
      const session = await fetch(`${apiOrigin}/api/local-session`, { method: 'POST', headers: { origin: apiOrigin, 'x-unity-session': 'local' }, signal: AbortSignal.timeout(5_000) });
      assert.equal(session.status, 200);
      const cookie = session.headers.get('set-cookie')?.split(';')[0];
      assert.ok(cookie);
      const headers = { origin: apiOrigin, cookie, 'content-type': 'application/json' };
      async function json(path, method, body) {
        const response = await fetch(`${apiOrigin}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5_000) });
        assert.ok(response.ok, `${path}: ${response.status}`);
        return response.json();
      }
      const workspace = await json('/api/workspaces', 'POST', { name: 'Smoke' });
      const input = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Aster', opaque: { preserve: true } } };
      const imported = await json(`/api/workspaces/${workspace.id}/imports`, 'POST', input);
      const path = `/api/workspaces/${workspace.id}/cards/${imported.card.id}`;
      const document = structuredClone(imported.revision.document);
      document.data.description = 'A built-server edit.';
      const saved = await json(`${path}/revisions`, 'POST', { expectedHead: imported.revision.id, document });
      assert.equal(saved.document.data.extensions.foundry.lineage.author, 'urn:unity:user:local');
      assert.equal((await json(path, 'GET')).revision.id, saved.id);
      const original = await fetch(`${apiOrigin}${path}/original`, { headers, signal: AbortSignal.timeout(5_000) });
      assert.equal(original.status, 200);
      assert.equal(await original.text(), JSON.stringify(input));
    }
    if (app === 'archive') {
      const archiveBase = `http://127.0.0.1:${address.port}/api/archive/v1`;
      const status = await fetch(`${archiveBase}/status`, { signal: AbortSignal.timeout(5_000) });
      assert.equal(status.status, archiveMode === 'off' ? 503 : 200);
      if (archiveMode === 'fixture' || archiveMode === 'copy') {
        const descriptor = await status.json();
        assert.equal(descriptor.mode, archiveMode);
        const page = await (await fetch(`${archiveBase}/cards?limit=1`, { signal: AbortSignal.timeout(5_000) })).json();
        assert.equal(page.cards.length, 1);
        assert.equal(page.snapshot, descriptor.snapshot);
        assert.ok(page.nextCursor);
        const manifest = await (await fetch(`${archiveBase}/manifest?snapshot=${page.snapshot}&id=${page.cards[0].id}`, { signal: AbortSignal.timeout(5_000) })).json();
        assert.equal(manifest.cards.length, 1);
        const original = manifest.cards[0].original;
        const bytes = await (await fetch(`${archiveBase}/originals/${original.hash}?snapshot=${page.snapshot}`, { signal: AbortSignal.timeout(5_000) })).arrayBuffer();
        assert.equal(bytes.byteLength, original.byteLength);
        assert.equal(createHash('sha256').update(new Uint8Array(bytes)).digest('hex'), original.hash);
      }
    }
    if (copiedDatabase) assert.deepEqual(await readFile(join(blobDirectory, 'archive.sqlite')), copiedDatabase);
    console.log(`${app}${app === 'archive' ? ` (${archiveMode})` : ''}: built Node server passed HTTP smoke`);
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5_000);
    const [code, signal] = await exited;
    clearTimeout(force);
    await rm(blobDirectory, { recursive: true, force: true });
    assert.equal(signal, null, `${app} did not shut down gracefully`);
    assert.equal(code, 0, `${app} shutdown failed: ${stderr}`);
  }
}
for (const app of ['architect', 'hub']) {
  const html = await readFile(`apps/${app}/dist/index.html`, 'utf8');
  assert.match(html, /Character Unity/);
  const script = html.match(/src="([^"]+\.js)"/);
  assert.ok(script, `${app} has no built entrypoint`);
  await access(`apps/${app}/dist/${script[1].replace(/^\//, '')}`);
  console.log(`${app}: static HTML and entrypoint present`);
}
