import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { schemaVersion } from './schema-version.mjs';

// Real native UI + Wrangler/workerd. Every database, account and Archive source
// belongs to this disposable fixture; no deployment or live migration occurs.
const execute = promisify(execFile), root = await mkdtemp(join(tmpdir(), 'unity-worker-native-'));
const state = join(root, 'state'), archiveRoot = join(root, 'archive');
const artifactRoot = resolve('runtime/worker-ui');
const require = createRequire(new URL('../packages/cards/package.json', import.meta.url));
const Database = createRequire(new URL('../packages/store/package.json', import.meta.url))('better-sqlite3');
const { writeCharX } = require('@character-foundry/character-foundry/charx');
const environment = { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' };
for (const key of Object.keys(environment)) if (key.startsWith('UNITY_')) delete environment[key];
const passed = [], errors = [], browserArchiveReads = [], tokenWorkers = [];
let browser, child, exited, archiveChild, archiveExited, log = '';
async function availablePort() {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const address = probe.address(); assert.ok(address && typeof address !== 'string');
  await new Promise((done, reject) => probe.close((error) => error ? reject(error) : done()));
  return address.port;
}
const port = await availablePort(), archivePort = await availablePort(), origin = `http://127.0.0.1:${port}`;
const archiveOrigin = `http://127.0.0.1:${archivePort}`;
async function ready(url, process, output, timeout = 30_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (process.exitCode !== null || process.signalCode !== null) throw new Error(`Owned rehearsal process exited: ${output()}`);
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Owned process is still starting. */ }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Owned rehearsal process timed out: ${output()}`);
}
async function startArchive() {
  let output = '';
  archiveChild = spawn(process.execPath, ['--import', resolve('apps/archive/node_modules/tsx/dist/loader.mjs'),
    'apps/archive/tests/unity-browser-fixture.ts', archiveRoot, String(archivePort)], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  archiveExited = once(archiveChild, 'exit');
  for (const stream of [archiveChild.stdout, archiveChild.stderr]) stream.on('data', (chunk) => { output = (output + chunk).slice(-16_000); });
  await ready(`${archiveOrigin}/api/health`, archiveChild, () => output);
}
async function stopArchive() {
  if (!archiveChild) return;
  if (archiveChild.exitCode === null && archiveChild.signalCode === null) archiveChild.kill('SIGTERM');
  const timer = setTimeout(() => { if (archiveChild?.exitCode === null && archiveChild.signalCode === null) archiveChild.kill('SIGKILL'); }, 10_000);
  try { await archiveExited; } finally { clearTimeout(timer); archiveChild = undefined; }
}
async function start(profile = 'hub') {
  log = '';
  const args = [resolve('apps/api/node_modules/wrangler/wrangler-dist/cli.js'), 'dev', '--local', '--ip', '127.0.0.1',
    '--port', String(port), '--persist-to', state];
  if (profile === 'browser') args.push('--config', 'wrangler.browser.jsonc');
  else args.push('--var', `UNITY_PUBLIC_ORIGIN:${origin}`, '--var', `UNITY_ARCHIVE_ORIGIN:${archiveOrigin}`,
    '--var', 'UNITY_SYNC_ENABLED:false', '--var', 'UNITY_SYNC_WRITES_ENABLED:false');
  child = spawn(process.execPath, args, { cwd: resolve('apps/api'), detached: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  exited = once(child, 'exit');
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { log = (log + chunk).slice(-32_000); });
  await ready(profile === 'hub' ? `${origin}/api/ready` : origin, child, () => log);
  if (profile === 'hub') assert.deepEqual(await (await fetch(`${origin}/api/ready`)).json(), { status: 'ready', storage: { schemaVersion } });
}
async function stop() {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT');
  const timer = setTimeout(() => { if (child?.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL'); }, 10_000);
  try { await exited; } finally { clearTimeout(timer); child = undefined; }
}
async function account(name) {
  const file = join(root, `${name}.json`);
  await execute(process.execPath, ['--import', resolve('apps/api/node_modules/tsx/dist/loader.mjs'), resolve('apps/api/src/accounts-cli.ts'), 'create', '--name', name,
    '--key-file', file, '--worker-state', state], { timeout: 30_000, env: environment });
  return JSON.parse(await readFile(file, 'utf8'));
}
function audit(page, actor) {
  const unpinned = [];
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('worker', (worker) => tokenWorkers.push(worker.url()));
  page.on('request', (request) => {
    if (request.url().startsWith(archiveOrigin)) browserArchiveReads.push(request.url());
    if (actor && /^\/api\/(?:workspaces|hub|remotes)(?:\/|$)/.test(new URL(request.url()).pathname)
      && request.headers()['x-unity-actor'] !== actor.account.id) unpinned.push(request.url());
  });
  return unpinned;
}
const headers = (actor) => ({ origin, 'x-unity-actor': actor.account.id });
async function login(page, actor) {
  await page.goto(origin); await page.getByLabel('Access key', { exact: true }).fill(actor.key);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByTitle('Import card files')).toBeVisible();
}
async function importBytes(page, name, bytes) {
  const imported = page.waitForResponse((response) => response.url().endsWith('/imports') && response.request().method() === 'POST');
  const chooser = page.waitForEvent('filechooser'); await page.getByTitle('Import card files').click();
  await (await chooser).setFiles({ name: `${name}.charx`, mimeType: 'application/octet-stream', buffer: bytes });
  const response = await imported; assert.equal(response.status(), 201, await response.text());
  const result = await response.json(); await expect(page.getByRole('status')).toContainText('Imported 1 card');
  return result;
}
async function save(page) {
  const saving = page.waitForResponse((response) => /\/(?:asset-)?revisions$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const response = await saving; assert.ok(response.ok(), await response.text());
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
}
const publicationRow = (page, name) => page.getByRole('listitem').filter({ has: page.getByRole('heading', { name, exact: true, level: 3 }) });
async function fitAndCapture(page, name) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'No horizontal viewport overflow');
  await page.screenshot({ path: join(artifactRoot, `${name}.png`), fullPage: false });
}
async function inventory(directory) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false, 'Synthetic file tree contains no links');
    const path = join(directory, entry.name);
    result[entry.name] = entry.isDirectory() ? await inventory(path) : createHash('sha256').update(await readFile(path)).digest('hex');
  }
  return result;
}
function archiveRows() {
  const db = new Database(join(archiveRoot, 'cards.db'), { readonly: true });
  try {
    return { cards: db.prepare('SELECT * FROM cards ORDER BY id').all(), queue: db.prepare('SELECT * FROM search_index_queue ORDER BY id').all() };
  } finally { db.close(); }
}
try {
  await mkdir(artifactRoot, { recursive: true });
  await startArchive(); const archiveBefore = { rows: archiveRows(), files: await inventory(join(archiveRoot, 'files')), versions: await inventory(join(archiveRoot, 'versions')) };
  const alice = await account('Worker Alice'), bob = await account('Worker Bob'); await start();
  for (const path of ['/api', '/api/does-not-exist']) {
    const response = await fetch(`${origin}${path}`, { headers: { accept: 'text/html' } });
    assert.equal(response.status, path === '/api' ? 404 : 401); assert.match(response.headers.get('content-type'), /application\/json/);
  }
  assert.deepEqual(await (await fetch(`${origin}/api/client`)).json(), { profile: 'hub', capabilities: { browserLLM: false } });
  browser = await chromium.launch(); const a = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const b = await browser.newPage({ viewport: { width: 390, height: 844 } }), aliceUnpinned = audit(a, alice), bobUnpinned = audit(b, bob);
  await login(a, alice);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
  const notes = Buffer.from('Worker attachment: αβ\nexact original bytes\n');
  const document = { spec: 'chara_card_v3', spec_version: '3.0', vendor_envelope: [null, 'keep'], data: {
    name: 'Worker Aster', description: 'Accepted on Worker', first_mes: 'Hello from workerd', creator: 'Worker fixture', tags: ['worker-proof'],
    assets: [{ type: 'icon', uri: 'ccdefault:', name: 'main', ext: 'png' }, { type: 'custom', uri: 'embeded://other/notes.txt', name: 'notes', ext: 'txt' }],
    extensions: { opaque: { retain: [1, null] } },
  } };
  const original = Buffer.from(writeCharX(document, [{ type: 'icon', name: 'main', ext: 'png', data: png, isMain: true },
    { type: 'custom', name: 'notes', ext: 'txt', data: notes }], { preserveDescriptors: true }).buffer);
  const imported = await importBytes(a, 'Worker Aster', original), cardPath = `/api/workspaces/${imported.card.workspaceId}/cards/${imported.card.id}`;
  await a.getByRole('button', { name: 'Quick view Worker Aster', exact: true }).click();
  await a.getByRole('link', { name: 'Edit', exact: true }).click();
  await a.getByRole('button', { name: 'Character', exact: true }).click();
  await a.getByLabel('Description', { exact: true }).fill('Edited on Worker'); await save(a);
  await a.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(a.locator('[data-card-tokens] dl')).toBeVisible();
  await fitAndCapture(a, 'native-worker-owned-viewer-desktop');
  assert.ok(tokenWorkers.some((url) => url.includes('tokenizer.worker')), 'Native browser tokenizer loaded from same-origin assets');
  assert.deepEqual(await (await a.request.get(`${origin}${cardPath}/original`, { headers: headers(alice) })).body(), original);
  passed.push('native Vite shell, account profile, actor-pinned import/edit/view/tokenizer and exact original bytes');

  await a.goto(`${origin}/sharing`); await a.getByRole('button', { name: 'Publish saved revisions', exact: true }).click();
  await a.getByRole('checkbox', { name: 'Select Worker Aster', exact: true }).check();
  await a.getByRole('button', { name: 'Review 1 selected', exact: true }).click();
  const review = a.getByRole('dialog', { name: 'Review publication', exact: true });
  await expect(review).toContainText('Edited on Worker');
  const publishing = a.waitForResponse((response) => response.url().endsWith('/hub/publications') && response.request().method() === 'POST');
  await review.getByRole('button', { name: 'Publish selected revisions', exact: true }).click(); assert.equal((await publishing).status(), 201);
  await login(b, bob); await b.goto(`${origin}/sharing`);
  await publicationRow(b, 'Worker Aster').getByRole('button', { name: 'View publication', exact: true }).click();
  const detail = b.getByRole('dialog', { name: 'Published character', exact: true });
  const forking = b.waitForResponse((response) => response.url().endsWith('/forks') && response.request().method() === 'POST');
  await detail.getByRole('button', { name: 'Fork to library', exact: true }).click();
  const fork = await (await forking).json(); assert.equal(fork.revision.document.data.extensions.foundry.lineage.author, bob.account.uri);
  await b.getByRole('link', { name: 'Edit', exact: true }).click(); await b.getByLabel('Name', { exact: true }).fill('Worker Aster by Bob');
  await save(b); await b.getByRole('button', { name: 'Done', exact: true }).click(); await expect(b.locator('[data-card-tokens] dl')).toBeVisible();
  await fitAndCapture(b, 'native-worker-fork-viewer-mobile');
  await b.locator('[data-card-tokens]').scrollIntoViewIfNeeded(); await fitAndCapture(b, 'native-worker-fork-tokens-mobile');
  passed.push('two independent account browsers, reviewed exact publication and authored fork/save on mobile');

  const statsPath = `${origin}/api/workspaces/${imported.card.workspaceId}/statistics`;
  const beforeReference = await (await a.request.get(statsPath, { headers: headers(alice) })).json();
  await a.goto(`${origin}/archive`); await expect(a.getByRole('button', { name: 'Quick view Archive CHARX', exact: true })).toBeVisible();
  const query = '"silver forest" AND NOT ocean';
  await a.getByLabel('Archive search mode', { exact: true }).selectOption('lexical'); await a.getByLabel('Archive query', { exact: true }).fill(query);
  const searching = a.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/archive/v2/cards') && new URL(response.url()).searchParams.get('q') === query);
  await a.getByRole('button', { name: 'Search Archive', exact: true }).click(); assert.equal((await searching).status(), 200);
  await expect(a.getByRole('button', { name: 'Quick view Archive JSON', exact: true })).toHaveCount(1);
  await a.getByRole('button', { name: 'Quick view Archive JSON', exact: true }).click();
  await expect(a.getByRole('button', { name: 'Remove from Archive', exact: true })).toHaveCount(0);
  await a.getByRole('button', { name: 'Close', exact: true }).click();
  await a.getByLabel('Archive query', { exact: true }).fill(''); await a.getByRole('button', { name: 'Search Archive', exact: true }).click();
  const tile = a.locator('article').filter({ has: a.getByRole('button', { name: 'Quick view Archive CHARX', exact: true }) });
  const adding = a.waitForResponse((response) => /\/archive\/v2\/cards\/[^/]+\/favorite$/.test(new URL(response.url()).pathname));
  await tile.getByTitle('Favorite and add a library link', { exact: true }).click();
  const reference = await (await adding).json(); await tile.getByRole('link', { name: 'In library ✓', exact: true }).click();
  await expect(a.getByRole('heading', { name: 'Archive CHARX', exact: true, level: 1 })).toBeVisible();
  await expect(a.getByText('Linked to Archive version', { exact: false })).toBeVisible();
  const afterReference = await (await a.request.get(statsPath, { headers: headers(alice) })).json();
  assert.equal(afterReference.membership.owned, beforeReference.membership.owned); assert.equal(afterReference.membership.archiveReferences, beforeReference.membership.archiveReferences + 1);
  assert.deepEqual(afterReference.storage, beforeReference.storage, 'Favorites and reference reads do not register or copy asset bytes');
  const referencePath = `${origin}/api/workspaces/${imported.card.workspaceId}/cards/${reference.cardId}`;
  const originalRef = await a.request.get(`${referencePath}/original`, { headers: headers(alice) });
  assert.equal(originalRef.status(), 200); assert.equal(originalRef.headers()['cache-control'], 'no-store');
  const linkedOriginal = await originalRef.body();
  const admin = await a.request.get(`${origin}/api/workspaces/${imported.card.workspaceId}/archive/v2/sources`, { headers: headers(alice) });
  assert.equal(admin.status(), 403, 'Hub accounts cannot administer the configured Archive');
  const switched = await a.request.get(`${referencePath}/original`, { headers: headers(bob) }); assert.equal(switched.status(), 409);
  await fitAndCapture(a, 'native-worker-archive-reference-desktop');
  await a.goto(`${origin}/stats`); await expect(a.getByRole('heading', { name: 'Collection stats', exact: true })).toBeVisible();
  await expect(a.getByRole('alert')).toHaveCount(0); await fitAndCapture(a, 'native-worker-statistics-desktop');
  passed.push('native Archive HTTP query/favorite exact-version reference with zero copied rows/assets, protected original and no admin access', 'actor-scoped native statistics');

  await stop(); await start(); await b.reload(); await expect(b.getByRole('heading', { name: 'Worker Aster by Bob', exact: true, level: 1 })).toBeVisible();
  assert.deepEqual(await (await a.request.get(`${origin}${cardPath}/original`, { headers: headers(alice) })).body(), original);
  assert.deepEqual(await (await a.request.get(`${referencePath}/original`, { headers: headers(alice) })).body(), linkedOriginal);
  assert.deepEqual(aliceUnpinned, []); assert.deepEqual(bobUnpinned, []); assert.deepEqual(browserArchiveReads, []);
  assert.deepEqual({ rows: archiveRows(), files: await inventory(join(archiveRoot, 'files')), versions: await inventory(join(archiveRoot, 'versions')) }, archiveBefore);
  passed.push('workerd restart preserves D1/R2, sessions, forks and linked originals; Archive originals/rows/queues unchanged');

  await stop(); await start('browser'); const local = await browser.newPage({ viewport: { width: 390, height: 844 } }), apiReads = [];
  audit(local); local.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/api/')) apiReads.push(request.url()); });
  await local.goto(origin); await expect(local.getByTitle('Import card files')).toBeVisible();
  const chooser = local.waitForEvent('filechooser'); await local.getByTitle('Import card files').click();
  await (await chooser).setFiles({ name: 'browser.charx', mimeType: 'application/octet-stream', buffer: original });
  await expect(local.getByRole('status')).toContainText('Imported 1 card');
  await local.getByRole('button', { name: 'Quick view Worker Aster', exact: true }).click();
  await local.getByRole('link', { name: 'Edit', exact: true }).click(); await local.getByLabel('Name', { exact: true }).fill('Browser-only Worker Aster');
  await local.getByRole('button', { name: 'Save', exact: true }).click(); await expect(local.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await local.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(local.getByRole('heading', { name: 'Browser-only Worker Aster', exact: true, level: 1 })).toBeVisible();
  await expect(local.locator('[data-card-tokens] dl')).toBeVisible(); await fitAndCapture(local, 'native-worker-browser-only-mobile');
  await stop(); await start('browser'); await local.reload();
  await expect(local.getByRole('heading', { name: 'Browser-only Worker Aster', exact: true, level: 1 })).toBeVisible();
  assert.deepEqual(apiReads, [], 'Browser-light profile has no hosted account or storage API traffic');
  for (const path of ['/api', '/api/client', '/api/missing']) {
    const response = await fetch(`${origin}${path}`, { headers: { accept: 'text/html' } });
    assert.equal(response.status, 404); assert.equal((await response.json()).error.code, 'BROWSER_STORAGE_ONLY');
  }
  assert.deepEqual(errors, []);
  passed.push('browser-light native UI import/edit/restart keeps same-origin IndexedDB with no D1/R2/account API calls');
  await writeFile('runtime/worker-rehearsal.json', JSON.stringify({ version: 2, runtime: 'local-wrangler-workerd', schemaVersion,
    passed, screenshots: await readdir(artifactRoot), remoteDeployment: false, liveMigration: false }, null, 2) + '\n');
  console.log('Native Worker and browser-light rehearsals passed: accounts, editor, tokenizer, sharing/forks, Archive references, stats and restart');
} finally {
  await browser?.close(); await stop(); await stopArchive(); await rm(root, { recursive: true, force: true });
}
