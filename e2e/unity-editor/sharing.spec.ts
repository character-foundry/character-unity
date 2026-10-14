import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { download, expect, gif, importCard, moduleRisum, notes, parse, png, save, screenshot, test, type Imported } from './fixtures.js';

const origin = 'http://127.0.0.1:19432';
interface Credentials { account: { id: string; uri: string; name: string }; key: string; workspaces?: { library: string; second: string } }
interface AccountFixture { accounts: { Alice: Credentials; Bob: Credentials }; databasePath: string; blobDirectory: string }
interface Publication { id: string; ownerId: string; parentId: string | null; originalHash: string; visibility: string; allowOriginal: boolean; allowFork: boolean;
  document: { data: { name: string; description: string; extensions?: { foundry?: { lineage?: { author: string; operation: string; originalHash: string } } } } };
  assets: { path: string; hash: string }[] }
interface RemoteFixture { publisher: Credentials; receiver: Credentials; editor: Credentials; outsider: Credentials; workspaceId: string; lostResponseFile: string }
const accounts = async () => JSON.parse(await readFile('runtime/e2e-native-hub.json', 'utf8')) as AccountFixture;
const remoteFixture = async () => JSON.parse(await readFile('runtime/e2e-remote.json', 'utf8')) as RemoteFixture;
const headers = (actor: Credentials, host = origin) => ({ origin: host, 'x-unity-actor': actor.account.id });

function audit(page: Page, actor: Credentials) {
  const errors: string[] = [], unpinned: string[] = [], requests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (!/^\/api\/(?:workspaces|hub|remotes)(?:\/|$)/.test(path)) return;
    requests.push(`${request.method()} ${path}`);
    if (request.headers()['x-unity-actor'] !== actor.account.id) unpinned.push(`${request.method()} ${path}`);
  });
  return { errors, unpinned, requests };
}
async function assertAudit(value: ReturnType<typeof audit>, info: TestInfo, label: string) {
  await info.attach(label, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
  expect(value.errors, 'Uncaught errors').toEqual([]);
  expect(value.unpinned, 'Every business/binary browser request pins its immutable actor').toEqual([]);
}
async function login(page: Page, actor: Credentials, host = origin) {
  await page.goto(host);
  await page.getByLabel('Access key', { exact: true }).fill(actor.key);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByTitle('Import card files')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account and workspace', exact: true })).toBeVisible();
}
async function accountMenu(page: Page) {
  const menu = page.getByRole('region', { name: 'Account and workspace', exact: true });
  if (!await menu.isVisible()) await page.getByRole('button', { name: 'Account and workspace', exact: true }).click();
  await expect(menu).toBeVisible();
  return menu;
}
async function gotoSharing(page: Page, host = origin) {
  await page.goto(`${host}/sharing`);
  await expect(page.getByRole('heading', { name: 'Sharing', exact: true, level: 1 })).toBeVisible();
}
function publicationRow(page: Page, name: string) {
  return page.getByRole('listitem').filter({ has: page.getByRole('heading', { name, exact: true, level: 3 }) });
}
async function beginReview(page: Page, name: string, sequence?: number) {
  await page.getByRole('button', { name: 'Publish saved revisions', exact: true }).click();
  const row = page.getByRole('listitem').filter({ has: page.getByRole('link', { name, exact: true }) });
  await expect(row).toBeVisible();
  if (sequence !== undefined) {
    await row.getByRole('button', { name: 'Choose revision', exact: true }).click();
    await page.getByRole('dialog', { name: 'Choose saved revision', exact: true }).getByRole('button', { name: `Select revision ${sequence}`, exact: true }).click();
  } else await row.getByRole('checkbox', { name: `Select ${name}`, exact: true }).check();
  await page.getByRole('button', { name: 'Review 1 selected', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review publication', exact: true });
  await expect(review).toBeVisible();
  await expect(review.getByLabel('Who can read', { exact: true })).toHaveValue('members');
  await expect(review.getByLabel('Allow forks', { exact: true })).toBeChecked();
  await expect(review.getByLabel('Allow original-file downloads', { exact: true })).not.toBeChecked();
  return review;
}
async function publish(page: Page, review: Locator) {
  const response = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/hub/publications' && response.request().method() === 'POST');
  await review.getByRole('button', { name: 'Publish selected revisions', exact: true }).click();
  const received = await response;
  expect(received.status(), await received.text()).toBe(201);
  const result = await received.json() as { publications: { id: string }[] };
  expect(result.publications).toHaveLength(1);
  await expect(review).not.toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Published 1 saved revision' })).toBeVisible();
  return result.publications[0]!.id;
}
async function readPublication(page: Page, actor: Credentials, id: string, host = origin) {
  const response = await page.request.get(`${host}/api/hub/publications/${id}`, { headers: headers(actor, host) });
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as Publication;
}
async function fit(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal viewport overflow').toBe(true);
}
async function blobs(directory: string): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) names.push(...(await blobs(join(directory, entry.name))).map((name) => `${entry.name}/${name}`));
    else names.push(entry.name);
  }
  return names.sort();
}
function storedCounts(path: string, workspaceId: string) {
  const require = createRequire(new URL('../../packages/store/package.json', import.meta.url));
  const Database = require('better-sqlite3') as new (path: string, options: { readonly: boolean }) => {
    prepare(sql: string): { get(...workspaceIds: string[]): unknown }; close(): void;
  };
  const db = new Database(path, { readonly: true });
  try { return db.prepare('SELECT (SELECT count(*) FROM unity_cards WHERE workspace_id = ?) AS cards, (SELECT count(*) FROM unity_assets WHERE workspace_id = ?) AS assets').get(workspaceId, workspaceId); }
  finally { db.close(); }
}

test('native sharing reviews a historical exact revision and a second account forks, edits and publishes it', async ({ page, browser, diagnostics }, info) => {
  diagnostics.expectedStatuses.add(401); diagnostics.expectedStatuses.add(404);
  const data = await accounts(), aliceAudit = audit(page, data.accounts.Alice);
  const second = await browser.newContext({ viewport: { width: 390, height: 844 } }), bob = await second.newPage();
  const bobAudit = audit(bob, data.accounts.Bob);
  try {
    await login(page, data.accounts.Alice);
    const imported = await importCard(page, 'Native historical Aster');
    await page.getByRole('button', { name: 'Character', exact: true }).click();
    await page.getByLabel('Description', { exact: true }).fill('A newer saved head, deliberately excluded from this publication.');
    await save(page); await page.getByRole('button', { name: 'Done', exact: true }).click();
    await gotoSharing(page);
    const review = await beginReview(page, 'Native historical Aster', 1);
    await expect(review).toContainText('revision 1'); await expect(review).toContainText('Original description');
    await expect(review).not.toContainText('A newer saved head');
    await fit(page); await screenshot(page, info, 'native-historical-publication-review');
    await review.getByRole('button', { name: 'Cancel publication', exact: true }).click();
    await page.getByRole('button', { name: 'Review 1 selected', exact: true }).click();
    const rootId = await publish(page, review), root = await readPublication(page, data.accounts.Alice, rootId);
    expect(root).toMatchObject({ visibility: 'members', allowFork: true, allowOriginal: false, document: { data: { description: 'Original description' } } });
    await fit(page); await screenshot(page, info, 'native-sharing-desktop-published-list');
    await publicationRow(page, 'Native historical Aster').getByRole('button', { name: 'View publication', exact: true }).click();
    const detail = page.getByRole('dialog', { name: 'Published character', exact: true });
    expect(await download(page, 'Download original')).toEqual(imported.bytes);
    await detail.getByRole('button', { name: 'Close publication', exact: true }).click();

    await login(bob, data.accounts.Bob); await gotoSharing(bob);
    const source = publicationRow(bob, 'Native historical Aster');
    await source.getByRole('button', { name: 'View publication', exact: true }).click();
    const bobDetail = bob.getByRole('dialog', { name: 'Published character', exact: true });
    await expect(bobDetail.getByRole('button', { name: 'Download original', exact: true })).toHaveCount(0);
    expect((await bob.request.get(`${origin}/api/hub/publications/${rootId}/original`, { headers: headers(data.accounts.Bob) })).status()).toBe(404);
    const forkResponse = bob.waitForResponse((response) => response.url().endsWith(`/publications/${rootId}/forks`) && response.request().method() === 'POST');
    await bobDetail.getByRole('button', { name: 'Fork to library', exact: true }).click();
    const fork = await (await forkResponse).json() as Imported;
    await expect(bob).toHaveURL(new RegExp(`/card/${fork.card.id}$`));
    await expect.poll(() => bob.locator('[data-card-page] img').first().evaluate((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
    await bob.getByRole('link', { name: 'Edit', exact: true }).click();
    await expect(bob.getByLabel('Name', { exact: true })).toHaveValue('Native historical Aster');
    await bob.getByLabel('Name', { exact: true }).fill('Native Aster by Bob');
    await save(bob); await bob.getByRole('button', { name: 'Done', exact: true }).click();
    await gotoSharing(bob);
    const childId = await publish(bob, await beginReview(bob, 'Native Aster by Bob'));
    const child = await readPublication(bob, data.accounts.Bob, childId);
    expect(child.parentId).toBe(rootId); expect(child.originalHash).toBe(root.originalHash);
    expect(child.document.data.extensions?.foundry?.lineage).toMatchObject({ author: data.accounts.Bob.account.uri, originalHash: root.originalHash });
    await publicationRow(bob, 'Native Aster by Bob').getByRole('button', { name: 'View publication', exact: true }).click();
    await bobDetail.getByRole('button', { name: 'View lineage', exact: true }).click();
    const lineage = bob.getByRole('region', { name: 'Published lineage', exact: true });
    await expect(lineage).toContainText('Forked from Native historical Aster');
    await fit(bob); await screenshot(bob, info, 'native-mobile-publication-detail');
    await lineage.scrollIntoViewIfNeeded(); await screenshot(bob, info, 'native-mobile-published-fork-lineage');
    await bobDetail.getByRole('button', { name: 'Close publication', exact: true }).click();

    await publicationRow(page, 'Native historical Aster').getByRole('button', { name: 'View publication', exact: true }).click();
    const policy = detail.getByRole('region', { name: 'Publication policy', exact: true });
    await policy.getByLabel('Allow forks', { exact: true }).uncheck(); await policy.getByRole('button', { name: 'Save publication policy', exact: true }).click();
    await expect(policy.getByLabel('Allow forks', { exact: true })).not.toBeChecked();
    await bob.getByRole('button', { name: 'Refresh publications', exact: true }).click();
    await expect(publicationRow(bob, 'Native historical Aster').getByRole('button', { name: 'Fork to library', exact: true })).toBeDisabled();
    await policy.getByLabel('Allow forks', { exact: true }).check(); await policy.getByRole('button', { name: 'Save publication policy', exact: true }).click();
    await expect(policy.getByLabel('Allow forks', { exact: true })).toBeChecked();
    await policy.getByLabel('Who can read', { exact: true }).selectOption('private'); await policy.getByRole('button', { name: 'Save publication policy', exact: true }).click();
    await expect(policy.getByLabel('Who can read', { exact: true })).toHaveValue('private');
    await bob.getByRole('button', { name: 'Refresh publications', exact: true }).click();
    await expect(publicationRow(bob, 'Native historical Aster')).toHaveCount(0);
    await expect(publicationRow(bob, 'Native Aster by Bob')).toHaveCount(0);
    await bob.goto(origin);
    await expect(bob.getByRole('button', { name: 'Quick view Native Aster by Bob', exact: true })).toBeVisible();
    await assertAudit(aliceAudit, info, 'alice-immutable-request-audit'); await assertAudit(bobAudit, info, 'bob-immutable-request-audit');
  } finally { await second.close(); }
});

test('native account recovery retains unsaved text and staged portrait, rejects another actor, and resumes the same editor', async ({ page, diagnostics }, info) => {
  diagnostics.expectedStatuses.add(401); diagnostics.expectedStatuses.add(409);
  const data = await accounts(), value = audit(page, data.accounts.Alice);
  await login(page, data.accounts.Alice); await importCard(page, 'Native recovery Aster');
  await expect((await accountMenu(page)).getByRole('combobox', { name: 'Workspace', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByLabel('Name', { exact: true }).fill('Unsaved native account draft');
  await page.getByLabel('Choose portrait', { exact: true }).setInputFiles({ name: 'recovery.gif', mimeType: 'image/gif', buffer: gif });
  const preview = page.getByAltText('Character Avatar', { exact: true }), objectUrl = await preview.getAttribute('src');
  expect(objectUrl).toMatch(/^blob:/);
  const revoked = await page.request.delete('/api/session', { headers: headers(data.accounts.Alice) }); expect(revoked.status()).toBe(204);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const recovery = page.getByRole('dialog', { name: 'Reconnect as Alice', exact: true });
  await expect(recovery).toContainText('Your draft is still here');
  await screenshot(page, info, 'native-locked-editor-recovery');
  await recovery.getByLabel('Access key', { exact: true }).fill(data.accounts.Bob.key);
  await recovery.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(recovery.getByRole('alert')).toContainText('Sign in as Alice');
  await recovery.getByLabel('Access key', { exact: true }).fill(data.accounts.Alice.key);
  await recovery.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(recovery).not.toBeVisible();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Unsaved native account draft');
  await expect(preview).toHaveAttribute('src', objectUrl!); await save(page);
  await page.getByLabel('Name', { exact: true }).fill('Discard only after confirmation');
  await accountMenu(page);
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Discard only after confirmation');
  await screenshot(page, info, 'native-recovered-draft-and-staged-portrait');
  await accountMenu(page);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to Unity', exact: true })).toBeVisible();
  await assertAudit(value, info, 'recovery-immutable-request-audit');
});

test('cross-tab account replacement cannot retarget an old download or favorite action', async ({ page, context, diagnostics }, info) => {
  diagnostics.expectedStatuses.add(401); diagnostics.expectedStatuses.add(409);
  await page.addInitScript(() => {
    const observed: { path: string; cache: RequestCache | undefined }[] = [];
    Object.assign(window, { __unityBinaryCacheAudit: observed });
    const transport = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
      if (/\/api\/workspaces\/.*\/(?:asset|original|export)$/.test(path)) observed.push({ path, cache: init?.cache });
      return transport(input, init);
    };
  });
  const data = await accounts(), value = audit(page, data.accounts.Alice);
  await login(page, data.accounts.Alice); const imported = await importCard(page, 'Native cross-tab Aster');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  expect(await download(page, 'Download original')).toEqual(imported.bytes);
  const actionTab = await context.newPage(), replacingTab = await context.newPage();
  const actionAudit = audit(actionTab, data.accounts.Alice);
  try {
    await actionTab.goto(`${origin}/card/${imported.card.id}`);
    await expect(actionTab.getByRole('heading', { name: 'Native cross-tab Aster', exact: true, level: 1 })).toBeVisible();
    await replacingTab.goto(origin); await expect(replacingTab.getByTitle('Import card files')).toBeVisible();
    await accountMenu(replacingTab);
    replacingTab.once('dialog', (dialog) => dialog.accept());
    await replacingTab.getByRole('button', { name: 'Sign out', exact: true }).click();
    await replacingTab.getByLabel('Access key', { exact: true }).fill(data.accounts.Bob.key);
    await replacingTab.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(replacingTab.getByTitle('Import card files')).toBeVisible();
    let downloads = 0; page.on('download', () => { downloads++; });
    const rejected = page.waitForResponse((response) => response.url().endsWith(`/${imported.card.id}/original`));
    await page.getByRole('button', { name: 'Download original', exact: true }).click();
    expect((await rejected).status()).toBe(409);
    await expect(page.getByRole('dialog', { name: 'Reconnect as Alice', exact: true })).toContainText('another account');
    expect(downloads).toBe(0);
    const rejectedFavorite = actionTab.waitForResponse((response) => response.url().endsWith(`/${imported.card.id}/favorite`));
    await actionTab.getByTitle('Add to favorites', { exact: true }).click();
    expect((await rejectedFavorite).status()).toBe(409);
    await expect(actionTab.getByRole('dialog', { name: 'Reconnect as Alice', exact: true })).toContainText('another account');
    const forbidden = await replacingTab.request.get(`/api/workspaces/${imported.card.workspaceId}/cards/${imported.card.id}`, { headers: headers(data.accounts.Bob) });
    expect(forbidden.status()).toBe(403);
    await screenshot(page, info, 'native-cross-tab-binary-denied');
    await page.getByLabel('Access key', { exact: true }).fill(data.accounts.Alice.key);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Reconnect as Alice', exact: true })).not.toBeVisible();
    expect(await download(page, 'Download original')).toEqual(imported.bytes);
    const cache = await page.evaluate(() => (window as Window & { __unityBinaryCacheAudit?: { path: string; cache?: RequestCache }[] }).__unityBinaryCacheAudit ?? []);
    expect(cache.some((read) => read.path.endsWith('/asset')), 'Warm real portrait fetched through authenticated client').toBe(true);
    expect(cache.filter((read) => read.path.endsWith('/original')).length).toBeGreaterThanOrEqual(3);
    expect(cache.every((read) => read.cache === 'no-store'), 'Every warm binary read bypasses browser cache before checking session ownership').toBe(true);
    await assertAudit(value, info, 'cross-tab-binary-request-audit'); await assertAudit(actionAudit, info, 'cross-tab-action-request-audit');
  } finally { await actionTab.close(); await replacingTab.close(); }
});

test('expiry over native publication review and policy dialogs keeps their exact selection and allows top-layer reauthentication', async ({ page, diagnostics }, info) => {
  diagnostics.expectedStatuses.add(401);
  const data = await accounts(), actor = data.accounts.Alice, value = audit(page, actor);
  await login(page, actor); const imported = await importCard(page, 'Native modal recovery Aster', 'json');
  await page.getByRole('button', { name: 'Done', exact: true }).click(); await gotoSharing(page);
  const review = await beginReview(page, 'Native modal recovery Aster');
  expect((await page.request.delete('/api/session', { headers: headers(actor) })).status()).toBe(204);
  await review.getByRole('button', { name: 'Publish selected revisions', exact: true }).click();
  const recovery = page.getByRole('dialog', { name: 'Reconnect as Alice', exact: true });
  await expect(recovery.getByLabel('Access key', { exact: true })).toBeVisible();
  await recovery.getByLabel('Access key', { exact: true }).fill(actor.key);
  await recovery.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(recovery).not.toBeVisible(); await expect(review).toContainText('Native modal recovery Aster');
  await expect(review).toContainText('revision 1');
  await screenshot(page, info, 'native-publication-review-survives-top-layer-recovery');
  const publishing = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/hub/publications' && request.method() === 'POST');
  const id = await publish(page, review);
  expect((await publishing).postDataJSON()).toMatchObject({ revisionIds: [imported.revision.id] });
  await publicationRow(page, 'Native modal recovery Aster').getByRole('button', { name: 'View publication', exact: true }).click();
  const detail = page.getByRole('dialog', { name: 'Published character', exact: true });
  const policy = detail.getByRole('region', { name: 'Publication policy', exact: true });
  await policy.getByLabel('Allow original-file downloads', { exact: true }).check();
  expect((await page.request.delete('/api/session', { headers: headers(actor) })).status()).toBe(204);
  await policy.getByRole('button', { name: 'Save publication policy', exact: true }).click();
  await expect(recovery.getByLabel('Access key', { exact: true })).toBeVisible();
  await recovery.getByLabel('Access key', { exact: true }).fill(actor.key);
  await recovery.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(recovery).not.toBeVisible();
  await expect(policy.getByLabel('Allow original-file downloads', { exact: true })).toBeChecked();
  await policy.getByRole('button', { name: 'Save publication policy', exact: true }).click();
  await expect.poll(async () => (await readPublication(page, actor, id)).allowOriginal).toBe(true);
  await screenshot(page, info, 'native-policy-dialog-survives-top-layer-recovery');
  await assertAudit(value, info, 'modal-recovery-immutable-request-audit');
});

for (const view of ['viewer', 'editor'] as const) test(`a ${view} portrait read that expires its account retries in place after same-actor recovery`, async ({ page, diagnostics }, info) => {
  diagnostics.expectedStatuses.add(401);
  const data = await accounts(), actor = data.accounts.Alice, value = audit(page, actor);
  const name = `Native recovering ${view} portrait`;
  await login(page, actor); const imported = await importCard(page, name, 'png');
  await page.getByRole('button', { name: 'Done', exact: true }).click(); await gotoSharing(page);
  await page.getByRole('button', { name: 'Publish saved revisions', exact: true }).click();
  let revoked = false, reads = 0, armed = view === 'viewer';
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/cards/${imported.card.id}/asset?*`, async (route) => {
    if (new URL(route.request().url()).searchParams.get('path') === 'portrait') {
      reads++;
      if (!revoked && armed && (view === 'viewer' || new URL(page.url()).pathname.endsWith('/edit'))) {
        revoked = true;
        if (view === 'editor') await hold;
        expect((await page.request.delete('/api/session', { headers: headers(actor) })).status()).toBe(204);
      }
    }
    await route.continue();
  });
  await page.getByRole('link', { name, exact: true }).click();
  if (view === 'editor') {
    await expect.poll(() => page.locator('[data-card-page] img').first().evaluate((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
    await page.getByRole('link', { name: 'Edit', exact: true }).click();
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue(name);
    await expect.poll(() => page.getByAltText('Character Avatar', { exact: true }).evaluate((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
    await page.getByLabel('Name', { exact: true }).fill('Unsaved recovered editor portrait');
    await page.getByRole('button', { name: 'Character', exact: true }).click();
    await page.getByLabel('Description', { exact: true }).fill('Unsaved text survives the portrait session failure.');
    armed = true;
    await page.getByRole('button', { name: 'Basic Info', exact: true }).click();
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Unsaved recovered editor portrait');
    release();
  }
  const recovery = page.getByRole('dialog', { name: 'Reconnect as Alice', exact: true });
  await expect(recovery.getByLabel('Access key', { exact: true })).toBeVisible();
  await recovery.getByLabel('Access key', { exact: true }).fill(actor.key);
  await recovery.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(recovery).not.toBeVisible();
  const image = view === 'editor' ? page.getByAltText('Character Avatar', { exact: true }) : page.locator('[data-card-page] img').first();
  await expect.poll(() => image.evaluate((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
  expect(reads).toBeGreaterThanOrEqual(2);
  if (view === 'editor') {
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Unsaved recovered editor portrait');
    await page.getByRole('button', { name: 'Character', exact: true }).click();
    await expect(page.getByLabel('Description', { exact: true })).toHaveValue('Unsaved text survives the portrait session failure.');
    await save(page);
    await page.getByRole('button', { name: 'Basic Info', exact: true }).click();
    await expect.poll(() => image.evaluate((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
  } else {
    await expect(page.getByRole('heading', { name, exact: true, level: 1 })).toBeVisible();
    expect(await download(page, 'Download original')).toEqual(imported.bytes);
  }
  await page.setViewportSize({ width: 390, height: 844 }); await fit(page);
  await screenshot(page, info, `native-${view}-portrait-recovers-in-place-after-expiry`);
  await assertAudit(value, info, 'media-recovery-immutable-request-audit');
});

test('workspace changes remount the native client only after closing its editor', async ({ page, diagnostics }, info) => {
  diagnostics.expectedStatuses.add(401);
  const data = await accounts(), actor = data.accounts.Bob, value = audit(page, actor);
  await login(page, actor); await importCard(page, 'Native workspace Aster', 'json');
  await expect((await accountMenu(page)).getByRole('combobox', { name: 'Workspace', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByLabel('Name', { exact: true }).fill('Saved in original workspace'); await save(page);
  await page.getByRole('button', { name: 'Done', exact: true }).click(); await page.goto(origin);
  await (await accountMenu(page)).getByRole('combobox', { name: 'Workspace', exact: true }).selectOption(actor.workspaces!.second);
  await expect(page.getByRole('button', { name: 'Quick view Saved in original workspace', exact: true })).toHaveCount(0);
  await (await accountMenu(page)).getByRole('button', { name: 'New workspace', exact: true }).click();
  await page.getByLabel('Workspace name', { exact: true }).fill('Native browser-created workspace');
  const creating = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/workspaces' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  expect((await creating).status()).toBe(201);
  await expect((await accountMenu(page)).getByRole('combobox', { name: 'Workspace', exact: true })).toHaveValue(await (await creating).json().then((workspace: { id: string }) => workspace.id));
  await (await accountMenu(page)).getByRole('combobox', { name: 'Workspace', exact: true }).selectOption(actor.workspaces!.library);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Quick view Saved in original workspace', exact: true })).toBeVisible();
  await fit(page); await screenshot(page, info, 'native-workspace-remount-isolated'); await assertAudit(value, info, 'workspace-immutable-request-audit');
});

test('Archive references remain unpublishable metadata links, while an edited fork publishes inherited assets', async ({ page, diagnostics }, info) => {
  diagnostics.expectedStatuses.add(401);
  const data = await accounts(), actor = data.accounts.Alice, value = audit(page, actor), workspaceId = actor.workspaces!.library;
  await login(page, actor);
  const before = storedCounts(data.databasePath, workspaceId), beforeBlobs = await blobs(data.blobDirectory);
  await page.goto('/archive');
  const tile = page.locator('article').filter({ has: page.getByRole('button', { name: 'Quick view Archive CHARX', exact: true }) });
  await tile.getByRole('button', { name: '+ Library', exact: true }).click();
  await tile.getByRole('link', { name: 'In library ✓', exact: true }).click();
  const referenceId = page.url().split('/').at(-1)!;
  await expect(page.getByRole('heading', { name: 'Archive CHARX', exact: true, level: 1 })).toBeVisible();
  await expect.poll(() => page.locator('[data-card-page] img').first().evaluate((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
  expect(storedCounts(data.databasePath, workspaceId)).toEqual(before); expect(await blobs(data.blobDirectory)).toEqual(beforeBlobs);
  await gotoSharing(page); await page.getByRole('button', { name: 'Publish saved revisions', exact: true }).click();
  const selection = page.getByRole('checkbox', { name: 'Select Archive CHARX', exact: true });
  await expect(selection).toBeDisabled();
  await expect(selection.locator('..')).toContainText('Read-only Archive reference');
  await screenshot(page, info, 'native-archive-reference-not-a-publication-copy');
  expect(storedCounts(data.databasePath, workspaceId)).toEqual(before); expect(await blobs(data.blobDirectory)).toEqual(beforeBlobs);
  await page.goto(`/card/${referenceId}/edit`);
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Archive CHARX');
  await page.getByLabel('Name', { exact: true }).fill('Native published Archive attachment fork');
  const saving = page.waitForResponse((response) => response.url().endsWith(`/${referenceId}/fork-assets`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = await (await saving).json() as { cardId: string };
  expect(saved.cardId).not.toBe(referenceId);
  await expect(page).toHaveURL(new RegExp(`/card/${saved.cardId}/edit$`));
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect(await blobs(data.blobDirectory)).toEqual(beforeBlobs);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await gotoSharing(page); const publicationId = await publish(page, await beginReview(page, 'Native published Archive attachment fork'));
  const publication = await readPublication(page, actor, publicationId);
  expect(publication.assets.length).toBeGreaterThanOrEqual(2);
  const attachment = publication.assets.find((asset) => asset.hash === createHash('sha256').update(notes).digest('hex'))!;
  expect(attachment).toBeDefined();
  expect(await (await page.request.get(`/api/hub/publications/${publicationId}/asset?${new URLSearchParams({ path: attachment.path })}`, { headers: headers(actor) })).body()).toEqual(notes);
  expect(await (await page.request.get(`/api/hub/publications/${publicationId}/asset?path=portrait`, { headers: headers(actor) })).body()).toEqual(png);
  expect(await blobs(data.blobDirectory)).toEqual(beforeBlobs);
  await publicationRow(page, 'Native published Archive attachment fork').getByRole('button', { name: 'View publication', exact: true }).click();
  expect(Buffer.from((await parse(await download(page, 'Download original'))).assets.find((asset) => asset.name === 'notes')!.data)).toEqual(notes);
  await screenshot(page, info, 'native-published-archive-inherited-asset-fork'); await assertAudit(value, info, 'archive-publication-immutable-request-audit');
});

test('native connected-hub empty and failed states are explicit and recoverable', async ({ page, diagnostics }, info) => {
  diagnostics.expectedStatuses.add(401); diagnostics.expectedStatuses.add(503);
  const data = await accounts(), value = audit(page, data.accounts.Bob);
  await login(page, data.accounts.Bob); await page.goto('/remotes');
  await expect(page.getByRole('heading', { name: 'No connected hubs', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prepare return', exact: true })).toBeDisabled();
  await page.route('**/api/remotes/connections', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Synthetic connection service unavailable' } }) }));
  await page.getByRole('button', { name: 'Refresh connections and returns', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Synthetic connection service unavailable');
  await page.setViewportSize({ width: 390, height: 844 }); await fit(page); await screenshot(page, info, 'native-remotes-mobile-explicit-failure');
  await page.unroute('**/api/remotes/connections');
  await page.getByRole('button', { name: 'Refresh connections and returns', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0); await expect(page.getByRole('heading', { name: 'No connected hubs', exact: true })).toBeVisible();
  await screenshot(page, info, 'native-remotes-mobile-empty-recovered'); await assertAudit(value, info, 'remote-empty-immutable-request-audit');
});

test('native configured TLS hubs pull and return one exact saved revision through lost responses and separate publication', async ({ browser }, info) => {
  test.setTimeout(120_000);
  const data = await remoteFixture(), sender = 'http://127.0.0.1:19314', receiver = 'https://127.0.0.1:19315';
  const publisherContext = await browser.newContext({ baseURL: receiver, ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const editorContext = await browser.newContext({ baseURL: sender, viewport: { width: 390, height: 844 } });
  const recipientContext = await browser.newContext({ baseURL: receiver, ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const publisher = await publisherContext.newPage(), editor = await editorContext.newPage(), recipient = await recipientContext.newPage();
  const publisherAudit = audit(publisher, data.publisher), editorAudit = audit(editor, data.editor), recipientAudit = audit(recipient, data.receiver);
  try {
    await login(publisher, data.publisher, receiver);
    const original = await importCard(publisher, 'Native remote Aster', 'png');
    await publisher.getByRole('button', { name: 'Assets', exact: true }).click();
    await publisher.getByRole('button', { name: 'Upload Asset', exact: true }).click();
    await publisher.getByLabel('Attachment type', { exact: true }).selectOption('custom');
    await publisher.getByLabel('Attachment name', { exact: true }).fill('notes');
    await publisher.getByLabel('Add attachment', { exact: true }).setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: notes });
    await save(publisher);
    await publisher.getByRole('button', { name: 'Done', exact: true }).click(); await gotoSharing(publisher, receiver);
    const rootId = await publish(publisher, await beginReview(publisher, 'Native remote Aster'));
    await login(editor, data.editor, sender); await editor.goto(`${sender}/remotes`);
    await editor.getByLabel('Connected hub', { exact: true }).selectOption('friends');
    await editor.getByRole('button', { name: 'Browse remote publications', exact: true }).click();
    const pulledResponse = editor.waitForResponse((response) => response.url().endsWith('/connections/friends/pulls') && response.request().method() === 'POST');
    await editor.getByRole('button', { name: 'Pull fork of Native remote Aster', exact: true }).click();
    const pulled = await (await pulledResponse).json() as Imported;
    await expect(editor).toHaveURL(new RegExp(`/card/${pulled.card.id}/edit$`));
    await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('Native remote Aster');
    await editor.getByRole('button', { name: 'Character', exact: true }).click();
    await editor.getByLabel('Description', { exact: true }).fill('The exact native saved return, revision two.');
    await save(editor); await editor.getByRole('button', { name: 'Done', exact: true }).click();
    await editor.goto(`${sender}/remotes`);
    await editor.getByLabel('Connected hub', { exact: true }).selectOption('friends');
    await editor.getByLabel('Saved revision to return', { exact: true }).selectOption({ label: 'Native remote Aster · revision 2' });
    let loseEnqueue = true;
    await editor.route('**/api/remotes/workspaces/*/jobs', async (route) => {
      if (route.request().method() === 'POST' && loseEnqueue) {
        loseEnqueue = false; const response = await route.fetch(); expect(response.status()).toBe(201); await route.abort('failed');
      } else await route.continue();
    });
    await editor.getByRole('button', { name: 'Prepare return', exact: true }).click();
    await expect(editor.getByRole('region', { name: 'Pending preparation', exact: true })).toBeVisible();
    await expect(editor.getByRole('button', { name: 'Retry preparation', exact: true })).toBeEnabled();
    await editor.reload(); await editor.getByRole('button', { name: 'Retry preparation', exact: true }).click();
    const review = editor.getByRole('region', { name: 'Review remote return', exact: true });
    await expect(review).toContainText('The exact native saved return, revision two.');
    await expect(review).toContainText('Ready to send');
    const reviewHeading = review.getByRole('heading', { name: 'Native remote Aster · revision 2', exact: true });
    await expect.poll(async () => (await reviewHeading.boundingBox())?.y ?? -1, 'New review heading is not obscured by the fixed native header').toBeGreaterThanOrEqual(48);
    await screenshot(editor, info, 'native-mobile-exact-return-review');
    const jobsPath = `${sender}/api/remotes/workspaces/${pulled.card.workspaceId}/jobs`;
    const queued = await (await editor.request.get(jobsPath, { headers: headers(data.editor, sender) })).json() as { jobs: { requestId: string; revisionId: string; frameHash: string; state: string; sequence: number }[] };
    expect(queued.jobs).toHaveLength(1); const job = queued.jobs[0]!;
    expect(job).toMatchObject({ state: 'prepared', sequence: 2 });
    const newer = await editorContext.newPage(), newerAudit = audit(newer, data.editor);
    await newer.goto(`${sender}/card/${pulled.card.id}/edit`);
    await expect(newer.getByLabel('Name', { exact: true })).toHaveValue('Native remote Aster');
    await newer.getByRole('button', { name: 'Character', exact: true }).click();
    await newer.getByLabel('Description', { exact: true }).fill('A newer saved head that must never replace this return.');
    await save(newer);
    await newer.getByLabel('Description', { exact: true }).fill('A dirty draft in another native editor tab.');
    await writeFile(data.lostResponseFile, 'Lose one accepted synthetic return response.');
    await review.getByRole('button', { name: 'Send saved return', exact: true }).click();
    await expect(review).toContainText('Outcome uncertain');
    await expect(newer.getByLabel('Description', { exact: true })).toHaveValue('A dirty draft in another native editor tab.');
    await fit(editor); await screenshot(editor, info, 'native-mobile-remote-return-uncertain');
    await review.getByRole('button', { name: 'Retry saved return', exact: true }).click();
    await expect(review.getByRole('status')).toContainText('Private draft acknowledged');
    const acknowledged = await (await editor.request.get(`${jobsPath}/${job.requestId}`, { headers: headers(data.editor, sender) })).json() as { receipt: { cardId: string; revisionId: string }; [key: string]: unknown };
    expect(acknowledged).toMatchObject({ requestId: job.requestId, revisionId: job.revisionId, frameHash: job.frameHash, attempts: 2, state: 'acknowledged' });
    await expect(newer.getByLabel('Description', { exact: true })).toHaveValue('A dirty draft in another native editor tab.');
    await screenshot(editor, info, 'native-mobile-remote-return-acknowledged');

    await login(recipient, data.receiver, receiver);
    await (await accountMenu(recipient)).getByRole('combobox', { name: 'Workspace', exact: true }).selectOption(data.workspaceId);
    await recipient.keyboard.press('Escape');
    await expect(recipient.getByRole('button', { name: 'Quick view Native remote Aster', exact: true })).toBeVisible();
    const returned = await (await recipient.request.get(`${receiver}/api/workspaces/${data.workspaceId}/cards/${acknowledged.receipt.cardId}`, { headers: headers(data.receiver, receiver) })).json() as Imported;
    expect(returned.revision.document.data).toMatchObject({ description: 'The exact native saved return, revision two.' });
    const attachment = returned.revision.assets.find((asset) => asset.path === 'declared/1')!;
    expect(await (await recipient.request.get(`${receiver}/api/workspaces/${data.workspaceId}/cards/${acknowledged.receipt.cardId}/asset?${new URLSearchParams({ revisionId: acknowledged.receipt.revisionId, path: attachment.path })}`, { headers: headers(data.receiver, receiver) })).body()).toEqual(notes);
    expect((await (await publisher.request.get(`${receiver}/api/hub/publications`, { headers: headers(data.publisher, receiver) })).json()).publications).toHaveLength(1);
    await gotoSharing(recipient, receiver);
    const childId = await publish(recipient, await beginReview(recipient, 'Native remote Aster'));
    expect((await readPublication(recipient, data.receiver, childId, receiver)).parentId).toBe(rootId);
    await publicationRow(publisher, 'Native remote Aster').getByRole('button', { name: 'View publication', exact: true }).click();
    expect(await download(publisher, 'Download original')).toEqual(original.bytes);
    await assertAudit(publisherAudit, info, 'tls-publisher-immutable-request-audit'); await assertAudit(editorAudit, info, 'tls-editor-immutable-request-audit');
    await assertAudit(recipientAudit, info, 'tls-recipient-immutable-request-audit'); await assertAudit(newerAudit, info, 'tls-dirty-editor-immutable-request-audit');
  } finally { await Promise.allSettled([publisherContext.close(), editorContext.close(), recipientContext.close()]); }
});

test('native remote connections remain account-specific', async ({ page, diagnostics }, info) => {
  diagnostics.expectedStatuses.add(401);
  const data = await remoteFixture(), sender = 'http://127.0.0.1:19314', value = audit(page, data.outsider);
  await login(page, data.outsider, sender); await page.goto(`${sender}/remotes`);
  await expect(page.getByRole('heading', { name: 'No connected hubs', exact: true })).toBeVisible();
  await expect(page.getByLabel('Connected hub', { exact: true })).toHaveCount(0);
  const workspaces = await (await page.request.get(`${sender}/api/workspaces`, { headers: headers(data.outsider, sender) })).json() as { workspaces: { id: string }[] };
  expect((await page.request.get(`${sender}/api/remotes/connections/friends/publications?${new URLSearchParams({ workspaceId: workspaces.workspaces[0]!.id })}`, { headers: headers(data.outsider, sender) })).status()).toBe(403);
  await assertAudit(value, info, 'tls-outsider-immutable-request-audit');
});

test('opaque Risu publications show explicit transport policy while compatible remote neighbors remain usable', async ({ browser }, info) => {
  const data = await remoteFixture(), sender = 'http://127.0.0.1:19314', receiver = 'https://127.0.0.1:19315';
  const publisherContext = await browser.newContext({ baseURL: receiver, ignoreHTTPSErrors: true });
  const editorContext = await browser.newContext({ baseURL: sender, viewport: { width: 390, height: 844 } });
  const publisher = await publisherContext.newPage(), editor = await editorContext.newPage(), value = audit(editor, data.editor);
  try {
    await login(publisher, data.publisher, receiver); await importCard(publisher, 'Native compatible neighbor', 'json');
    await publisher.getByRole('button', { name: 'Done', exact: true }).click(); await gotoSharing(publisher, receiver);
    await publish(publisher, await beginReview(publisher, 'Native compatible neighbor'));
    const imported = await importCard(publisher, 'Native opaque Risu publication');
    await publisher.getByRole('button', { name: 'Done', exact: true }).click(); await gotoSharing(publisher, receiver);
    const id = await publish(publisher, await beginReview(publisher, 'Native opaque Risu publication'));
    expect((await readPublication(publisher, data.publisher, id, receiver)).assets.some((asset) => asset.path === 'module.risum')).toBe(true);
    await expect(publicationRow(publisher, 'Native opaque Risu publication')).toContainText('Not listed for remote sync');
    await publicationRow(publisher, 'Native opaque Risu publication').getByRole('button', { name: 'View publication', exact: true }).click();
    await expect(publisher.getByRole('dialog', { name: 'Published character', exact: true })).toContainText('module.risum');
    const original = await download(publisher, 'Download original');
    expect(original).toEqual(imported.bytes);
    expect(Buffer.from((await parse(original)).metadata!.moduleRisum!)).toEqual(moduleRisum);
    await screenshot(publisher, info, 'native-opaque-risu-source-diagnostic');
    await login(editor, data.editor, sender); await editor.goto(`${sender}/remotes`);
    await expect(editor.getByText(/Remote listings omit whole publications with opaque RisuAI modules/)).toBeVisible();
    await editor.getByLabel('Connected hub', { exact: true }).selectOption('friends');
    const listing = editor.waitForResponse((response) => new URL(response.url()).pathname === '/api/remotes/connections/friends/publications');
    await editor.getByRole('button', { name: 'Browse remote publications', exact: true }).click();
    expect((await listing).status()).toBe(200);
    await expect(editor.getByRole('alert')).toHaveCount(0);
    await expect(editor.getByRole('button', { name: 'Pull fork of Native opaque Risu publication', exact: true })).toHaveCount(0);
    await expect(editor.getByRole('button', { name: 'Pull fork of Native compatible neighbor', exact: true })).toBeVisible();
    await fit(editor); await screenshot(editor, info, 'native-opaque-risu-mobile-policy-and-supported-neighbor');
    await editor.setViewportSize({ width: 1440, height: 1000 });
    await fit(editor); await screenshot(editor, info, 'native-opaque-risu-desktop-policy-and-supported-neighbor');
    await editor.getByRole('button', { name: 'Pull fork of Native compatible neighbor', exact: true }).click();
    await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('Native compatible neighbor');
    await assertAudit(value, info, 'tls-opaque-policy-immutable-request-audit');
  } finally { await publisherContext.close(); await editorContext.close(); }
});
