import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium, expect } from '@playwright/test';

// Real Wrangler CLI + built hub, isolated from normal local state and accounts.
const execute = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'unity-worker-ui-'));
const state = join(root, 'state');
async function availablePort() {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}
const port = await availablePort(), archivePort = await availablePort();
const origin = `http://127.0.0.1:${port}`;
const archiveOrigin = `http://127.0.0.1:${archivePort}`, archiveRoot = join(root, 'archive-fixture');
let child, exited, browser;
let archiveChild, archiveExited;
let log = '';
async function startArchive() {
  await execute(process.execPath, [resolve('apps/archive/dist/native-rehearsal.js'), 'seed', archiveRoot], { timeout: 30000 });
  archiveChild = spawn(process.execPath, [resolve('apps/archive/dist/node.js')], { stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, HOST: '127.0.0.1', PORT: String(archivePort), UNITY_ARCHIVE_MODE: 'copy', UNITY_ARCHIVE_COPY_ROOT: join(archiveRoot, 'copy'),
    UNITY_ARCHIVE_READ_ORIGINS: '', UNITY_ARCHIVE_EMBEDDING_CONFIG: '', UNITY_ARCHIVE_EMBEDDING_KEY: '',
  } });
  archiveExited = once(archiveChild, 'exit'); let archiveLog = '';
  for (const stream of [archiveChild.stdout, archiveChild.stderr]) stream.on('data', (chunk) => { archiveLog = (archiveLog + chunk).slice(-16000); });
  const deadline = Date.now() + 15000;
  while (true) {
    if (archiveChild.exitCode !== null || archiveChild.signalCode !== null || Date.now() > deadline) throw new Error(`Archive rehearsal startup failed: ${archiveLog}`);
    try { if ((await fetch(`${archiveOrigin}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Wait for owned process. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
async function stopArchive() {
  if (!archiveChild) return;
  if (archiveChild.exitCode === null && archiveChild.signalCode === null) archiveChild.kill('SIGTERM');
  const force = setTimeout(() => { if (archiveChild?.exitCode === null && archiveChild.signalCode === null) archiveChild.kill('SIGKILL'); }, 10000);
  try { await archiveExited; } finally { clearTimeout(force); archiveChild = undefined; }
}
async function stop() {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT');
  const force = setTimeout(() => { if (child?.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL'); }, 10_000);
  try { await exited; } finally { clearTimeout(force); child = undefined; }
}
async function start() {
  log = '';
  child = spawn(process.execPath, [resolve('apps/api/node_modules/wrangler/wrangler-dist/cli.js'), 'dev', '--local',
    '--ip', '127.0.0.1', '--port', String(port), '--persist-to', state, '--assets', '../hub/dist',
    '--var', `UNITY_PUBLIC_ORIGIN:${origin}`, '--var', `UNITY_ARCHIVE_ORIGIN:${archiveOrigin}`], {
    cwd: resolve('apps/api'), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
  });
  exited = once(child, 'exit');
  child.stderr.on('data', (chunk) => { log = (log + chunk).slice(-32_000); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Local Worker startup timed out: ${log}`)), 30_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Local Worker exited during startup: ${log}`)); });
    child.stdout.on('data', (chunk) => {
      log = (log + chunk).slice(-32_000);
      if (log.includes(`Ready on ${origin}`)) { clearTimeout(timer); resolve(); }
    });
  });
  const ready = await fetch(`${origin}/api/ready`, { signal: AbortSignal.timeout(5000) });
  assert.equal(ready.status, 200); assert.equal((await ready.json()).storage.schemaVersion, 9);
}
async function account(name) {
  const file = join(root, `${name}.json`);
  await execute(process.execPath, [resolve('apps/api/dist/accounts-cli.js'), 'create', '--name', name,
    '--key-file', file, '--worker-state', state], { timeout: 30_000 });
  return JSON.parse(await readFile(file, 'utf8'));
}
async function login(page, key) {
  await page.goto(origin);
  await page.getByLabel('Access key').fill(key);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
async function workspace(page, name) {
  await page.getByLabel('New workspace', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByLabel('Import a card')).toBeVisible();
}
try {
  await startArchive();
  const alice = await account('Worker Alice'), bob = await account('Worker Bob');
  await start();
  const unknown = await fetch(`${origin}/api/does-not-exist`, { headers: { accept: 'text/html' } });
  assert.equal(unknown.status, 401); assert.match(unknown.headers.get('content-type'), /application\/json/);
  browser = await chromium.launch();
  const a = await browser.newPage(), b = await browser.newPage({ viewport: { width: 390, height: 844 } });
  a.setDefaultTimeout(10_000); b.setDefaultTimeout(10_000);
  const errors = [];
  a.on('pageerror', (error) => errors.push(error.message)); b.on('pageerror', (error) => errors.push(error.message));
  await login(a, alice.key); await workspace(a, 'Worker originals');
  const original = JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: {
    name: 'Worker Aster', description: 'Accepted on Worker', extensions: { opaque: { retain: [1, null] } },
  } });
  const importedResponse = a.waitForResponse((response) => response.url().endsWith('/imports'));
  await a.getByLabel('Import a card').setInputFiles({ name: 'aster.json', mimeType: 'application/json', buffer: Buffer.from(original) });
  const imported = await (await importedResponse).json();
  const editor = a.getByRole('region', { name: 'Character editor', exact: true });
  await editor.getByRole('button', { name: 'Character', exact: true }).click();
  await editor.getByLabel('Description', { exact: true }).fill('Edited on Worker');
  await editor.getByRole('button', { name: 'Save revision' }).click();
  await expect(editor.getByRole('status')).toHaveText('Saved');
  await editor.getByRole('button', { name: 'Tokens', exact: true }).click();
  await expect(editor.getByRole('row').filter({ has: a.getByRole('rowheader', { name: 'Description', exact: true }) }).getByRole('cell')).toHaveText('3');
  await a.getByLabel('Select Worker Aster · revision 2', { exact: true }).check();
  await a.getByRole('button', { name: 'Review 1 selected' }).click();
  const publishing = a.waitForResponse((response) => response.url().endsWith('/hub/publications') && response.request().method() === 'POST');
  await a.getByRole('region', { name: 'Review publication' }).getByRole('button', { name: 'Publish selected revisions' }).click();
  assert.equal((await publishing).status(), 201);
  await login(b, bob.key); await workspace(b, 'Worker forks');
  const forking = b.waitForResponse((response) => response.url().endsWith('/forks') && response.request().method() === 'POST');
  await b.getByRole('button', { name: 'Fork Worker Aster', exact: true }).click();
  const fork = await (await forking).json();
  assert.equal(fork.revision.document.data.extensions.foundry.lineage.author, bob.account.uri);
  const second = b.getByRole('region', { name: 'Character editor', exact: true });
  await second.getByLabel('Name', { exact: true }).fill('Worker Aster by Bob');
  await second.getByRole('button', { name: 'Save revision' }).click();
  await expect(second.getByRole('status')).toHaveText('Saved');
  const originalPath = `${origin}/api/workspaces/${imported.card.workspaceId}/cards/${imported.card.id}/original`;
  assert.equal(await (await a.request.get(originalPath)).text(), original);
  // Exercise the built shared Archive UI through actual Worker -> Node HTTP.
  // No test fetch bridge, browser CORS permission or direct database connection.
  const browserArchiveReads = [];
  a.on('request', (request) => { if (request.url().startsWith(archiveOrigin)) browserArchiveReads.push(request.url()); });
  await editor.getByRole('button', { name: 'Character', exact: true }).click();
  await editor.getByLabel('Description', { exact: true }).fill('Keep this Worker draft');
  await a.getByRole('button', { name: 'Browse Archive', exact: true }).click();
  const panel = a.getByRole('region', { name: 'Archive import', exact: true });
  await panel.getByLabel('Search mode').selectOption('lexical');
  await panel.getByLabel('Search Archive', { exact: true }).fill('silver AND NOT ocean');
  await panel.getByLabel('Advanced filter', { exact: true }).fill('tokenCount >= 200');
  await panel.getByLabel('Result order').selectOption('tokens_desc');
  await panel.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(panel.getByRole('checkbox')).toHaveCount(2);
  await panel.getByRole('checkbox', { name: 'Aster', exact: true }).check();
  await panel.getByRole('checkbox', { name: 'Cinder', exact: true }).check();
  await panel.getByRole('button', { name: 'Review selection (2)', exact: true }).click();
  const archiveImportResponse = a.waitForResponse((response) => response.url().endsWith('/archive/imports'));
  await panel.getByRole('button', { name: 'Import selected originals', exact: true }).click();
  const archiveImport = await (await archiveImportResponse).json();
  assert.deepEqual(archiveImport.imported.map((item) => item.archiveCardId), ['1', '3']);
  await expect(panel.getByText('Imported 2 of 2 selected originals.')).toBeVisible();
  await expect(editor.getByLabel('Description', { exact: true })).toHaveValue('Keep this Worker draft');
  const archiveAccepted = [];
  for (const item of archiveImport.imported) {
    const path = `${origin}/api/workspaces/${imported.card.workspaceId}/cards/${item.card.id}/original`;
    const bytes = await readFile(join(archiveRoot, 'copy', `${item.archiveCardId}.json`));
    assert.deepEqual(await (await a.request.get(path)).body(), bytes); archiveAccepted.push({ path, bytes });
  }
  assert.deepEqual(browserArchiveReads, []);
  await stop(); await start();
  await b.reload(); await expect(b.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await b.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption(fork.card.workspaceId);
  await b.getByRole('button', { name: 'Edit Worker Aster by Bob', exact: true }).click();
  await expect(b.getByRole('region', { name: 'Character editor', exact: true }).getByLabel('Name', { exact: true })).toHaveValue('Worker Aster by Bob');
  assert.equal(await (await a.request.get(originalPath)).text(), original);
  for (const item of archiveAccepted) assert.deepEqual(await (await a.request.get(item.path)).body(), item.bytes);
  await stopArchive();
  const unchangedArchive = JSON.parse((await execute(process.execPath, [resolve('apps/archive/dist/native-rehearsal.js'), 'check', archiveRoot], { timeout: 30000 })).stdout);
  assert.equal(unchangedArchive.cards, 3);
  assert.deepEqual(errors, []);
  await mkdir('runtime', { recursive: true });
  await writeFile('runtime/worker-rehearsal.json', JSON.stringify({ version: 1, runtime: 'local-wrangler-workerd',
    passed: ['operator CLI and same persistent D1', 'built hub same origin', 'API misses stay JSON', 'independent account browsers',
      'import-edit-publish-fork-edit', 'browser tokenizer served by Worker assets', 'immutable originals', 'Worker restart with D1/R2 and sessions',
      'Archive HTTP search/filter/order and reviewed imports', 'Archive imports preserve unsaved drafts and exact D1/R2 originals after restart', 'copied Archive files and queues unchanged', 'no browser errors'],
    remoteDeployment: false }, null, 2) + '\n');
  console.log('Local Worker: built hub, two-account publication/fork, copied Archive search/import, exact originals and restart passed');
} finally {
  await browser?.close(); await stop(); await stopArchive(); await rm(root, { recursive: true, force: true });
}
