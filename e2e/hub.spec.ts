import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const origin = 'http://127.0.0.1:19312';
const original = (name: string) => JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', unknown: [1, null], data: {
  name, description: 'Original description.', personality: '', scenario: '', first_mes: 'Hello.', mes_example: '',
  extensions: { vendor: { keep: true }, foundry: { local: { note: 'synthetic local metadata' } } },
} });
async function credentials() {
  return JSON.parse(await readFile('runtime/e2e-hub-accounts.json', 'utf8')) as Record<string, { account: { id: string; uri: string }; key: string }>;
}
async function login(page: Page, key: string) {
  await page.goto(origin);
  await page.getByLabel('Access key').fill(key);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
async function workspace(page: Page, name: string) {
  await page.getByLabel('New workspace', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByLabel('Import a card')).toBeVisible();
}
async function upload(page: Page, name: string) {
  await page.getByLabel('Import a card').setInputFiles({ name: `${name}.json`, mimeType: 'application/json', buffer: Buffer.from(original(name)) });
  await expect(page.getByRole('region', { name: 'Character editor', exact: true })).toBeVisible();
}
async function publish(page: Page, name: string, revision: number) {
  await page.getByLabel(`Select ${name} · revision ${revision}`, { exact: true }).check();
  await page.getByRole('button', { name: 'Review 1 selected' }).click();
  const review = page.getByRole('region', { name: 'Review publication' });
  await expect(review.getByLabel('Who can read')).toHaveValue('members');
  await expect(review.getByLabel('Allow original-file downloads')).not.toBeChecked();
  const response = page.waitForResponse((value) => value.url().endsWith('/api/hub/publications') && value.request().method() === 'POST');
  await review.getByRole('button', { name: 'Publish selected revisions' }).click();
  expect((await response).status()).toBe(201);
  await expect(review).not.toBeVisible();
}

test('operator-created accounts publish an exact subset, fork in a second browser and edit with the shared editor', async ({ browser }, info) => {
  const accounts = await credentials();
  const aliceContext = await browser.newContext(); const bobContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const alice = await aliceContext.newPage(), bob = await bobContext.newPage();
  const errors: string[] = [];
  alice.on('pageerror', (value) => errors.push(value.message)); bob.on('pageerror', (value) => errors.push(value.message));
  try {
    await login(alice, accounts.Alice!.key); await workspace(alice, 'Publisher desk');
    await upload(alice, 'Unselected character'); await alice.getByRole('button', { name: 'Close editor' }).click();
    await upload(alice, 'Aster');
    const editor = alice.getByRole('region', { name: 'Character editor', exact: true });
    await editor.getByRole('button', { name: 'Character', exact: true }).click();
    await editor.getByLabel('Description', { exact: true }).fill('A published edit.');
    await editor.getByRole('button', { name: 'Save revision' }).click();
    await expect(editor.getByRole('status')).toHaveText('Saved');
    await publish(alice, 'Aster', 2);
    const list = await alice.request.get(`${origin}/api/hub/publications`);
    const { publications } = await list.json();
    expect(publications).toHaveLength(1);
    const root = publications[0];
    expect(root.document.data.description).toBe('A published edit.');
    expect(root.document.data.extensions.foundry.local).toBeUndefined();
    const rootRevisionHash = root.document.data.extensions.foundry.lineage.revisionHash;
    expect(await (await alice.request.get(`${origin}/api/hub/publications/${root.id}/original`)).text()).toBe(original('Aster'));
    await login(bob, accounts.Bob!.key); await workspace(bob, 'Forks desk');
    expect((await bob.request.get(`${origin}/api/hub/publications/${root.id}/original`)).status()).toBe(404);
    const response = bob.waitForResponse((value) => value.url().endsWith(`/publications/${root.id}/forks`));
    await bob.getByRole('button', { name: 'Fork Aster', exact: true }).click();
    const fork = await (await response).json();
    expect(fork.revision.document.data.extensions.foundry.lineage).toMatchObject({ operation: 'fork', author: accounts.Bob!.account.uri, parents: [{ revisionHash: rootRevisionHash }] });
    const second = bob.getByRole('region', { name: 'Character editor', exact: true });
    await second.getByLabel('Name', { exact: true }).fill('Aster by Bob');
    await second.getByRole('button', { name: 'Save revision' }).click(); await expect(second.getByRole('status')).toHaveText('Saved');
    await publish(bob, 'Aster by Bob', 2);
    await second.getByLabel('Export format', { exact: true }).selectOption('sillytavern-json');
    const forkDownload = bob.waitForEvent('download');
    await second.getByRole('button', { name: 'Download saved revision', exact: true }).click();
    const exportedFork = JSON.parse(await readFile((await (await forkDownload).path())!, 'utf8'));
    expect(exportedFork.data.name).toBe('Aster by Bob');
    expect(exportedFork.data.extensions.foundry.local.sillyTavernTransport.profile).toBe('foundry-sillytavern-json-v1');
    expect(exportedFork.data.extensions.foundry.lineage.originalHash).toBe(root.originalHash);
    expect(exportedFork.data.extensions.foundry.lineage.parents).toMatchObject([{ revisionHash: fork.revision.document.data.extensions.foundry.lineage.revisionHash }]);

    await bob.getByRole('button', { name: 'View lineage of Aster', exact: true }).click();
    const graph = bob.getByRole('region', { name: 'Published lineage', exact: true });
    await expect(graph.getByRole('heading', { name: 'Aster', exact: true })).toBeVisible();
    await expect(graph.getByRole('heading', { name: 'Aster by Bob', exact: true })).toBeVisible();
    await expect(graph).toContainText('Forked from Aster');
    await expect(graph).toContainText('End of visible publications.');
    await graph.getByRole('link', { name: 'Aster', exact: true }).click();
    await expect(graph.getByRole('heading', { name: 'Aster', exact: true })).toBeInViewport();
    await alice.getByRole('button', { name: 'View forks of Aster', exact: true }).click();
    await expect(alice.getByRole('heading', { name: 'Aster by Bob', exact: true })).toBeVisible();
    await bob.screenshot({ path: info.outputPath('hub-mobile-fork.png'), fullPage: true });
    expect(await bob.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await bob.reload(); await expect(bob.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await bob.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption(fork.card.workspaceId);
    await bob.getByRole('button', { name: 'Edit Aster by Bob', exact: true }).click();
    await expect(bob.getByRole('region', { name: 'Character editor', exact: true }).getByLabel('Name', { exact: true })).toHaveValue('Aster by Bob');
    await alice.getByRole('button', { name: 'All publications' }).click();
    await alice.getByRole('button', { name: 'Make Aster private', exact: true }).click();
    await bob.getByRole('button', { name: 'Refresh publications' }).click();
    await expect(bob.getByText('No publications are visible here yet.')).toBeVisible();
    await expect(bob.getByRole('button', { name: 'Edit Aster by Bob' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await aliceContext.close(); await bobContext.close(); }
});

test('expired session keeps a hub draft, same-account sign-in recovers it and explicit logout discards only after confirmation', async ({ page }) => {
  const accounts = await credentials();
  await login(page, accounts.Alice!.key); await workspace(page, 'Session recovery'); await upload(page, 'Draft safety');
  const editor = page.getByRole('region', { name: 'Character editor', exact: true });
  await editor.getByLabel('Name', { exact: true }).fill('Unsaved draft');
  const logout = await page.request.delete(`${origin}/api/session`, { headers: { origin } }); expect(logout.status()).toBe(204);
  await editor.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByLabel('Access key')).toBeVisible();
  await expect(page.getByText('Your draft is still here.', { exact: false })).toBeVisible();
  await page.getByLabel('Access key').fill(accounts.Alice!.key); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('Unsaved draft');
  await editor.getByRole('button', { name: 'Save revision' }).click(); await expect(editor.getByRole('status')).toHaveText('Saved');
  await editor.getByLabel('Name', { exact: true }).fill('Discard this edit');
  await page.getByRole('button', { name: 'Sign out' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' }); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep editing' }).click(); await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('Discard this edit');
  await page.getByRole('button', { name: 'Sign out' }).click(); await dialog.getByRole('button', { name: 'Discard and continue' }).click();
  await expect(page.getByRole('region', { name: 'Sign in', exact: true })).toBeVisible();
  expect((await page.request.get(`${origin}/api/workspaces`)).status()).toBe(401);
});

test('a different account signing in in another tab cannot silently receive an old tab’s workspace writes', async ({ page, context }) => {
  const accounts = await credentials();
  await login(page, accounts.Alice!.key);
  await page.getByLabel('New workspace', { exact: true }).fill('Wrong account workspace');
  const other = await context.newPage();
  try {
    await other.goto(origin); await expect(other.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await other.getByRole('button', { name: 'Sign out' }).click();
    await other.getByLabel('Access key').fill(accounts.Bob!.key); await other.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(other.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await expect(page.getByRole('heading', { name: 'Reconnect as Alice' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('another account');
    const { workspaces } = await (await other.request.get(`${origin}/api/workspaces`)).json();
    expect(workspaces.some((value: { name: string }) => value.name === 'Wrong account workspace')).toBe(false);
    await page.getByLabel('Access key').fill(accounts.Alice!.key); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  } finally { await other.close(); }
});

test('Archive selection reaches the hub editor, selected publication and a second-account fork without changing originals or replacing a draft', async ({ browser }, info) => {
  const accounts = await credentials();
  const firstContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const secondContext = await browser.newContext();
  const alice = await firstContext.newPage(), bob = await secondContext.newPage();
  const archiveOrigin = 'http://127.0.0.1:19313/api/archive/v1';
  try {
    const snapshot = await (await alice.request.get(`${archiveOrigin}/status`)).json();
    const record = await (await alice.request.get(`${archiveOrigin}/cards/aster?snapshot=${snapshot.snapshot}`)).json();
    const originalUrl = `${archiveOrigin}/originals/${record.card.original.hash}?snapshot=${snapshot.snapshot}`;
    const accepted = await (await alice.request.get(originalUrl)).body();
    await login(alice, accounts.Alice!.key); await workspace(alice, 'Archive publisher');
    const before = await (await alice.request.get(`${origin}/api/hub/publications`)).json();
    const beforeIds = new Set(before.publications.map((value: { id: string }) => value.id));
    await alice.getByRole('button', { name: 'Browse Archive', exact: true }).click();
    const panel = alice.getByRole('region', { name: 'Archive import', exact: true });
    await panel.getByLabel('Search Archive', { exact: true }).fill('not a card');
    await panel.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(panel.getByText('No Archive cards match these filters.')).toBeVisible();
    await panel.getByLabel('Search Archive', { exact: true }).fill('');
    await panel.getByLabel('Provider', { exact: true }).fill('fixture');
    await panel.getByLabel('Tag', { exact: true }).fill('demo');
    await panel.getByRole('button', { name: 'Search', exact: true }).click();
    await panel.getByRole('checkbox', { name: 'Aster', exact: true }).check();
    await panel.getByRole('checkbox', { name: 'Cinder', exact: true }).check();
    await panel.getByRole('button', { name: 'Review selection (2)', exact: true }).click();
    const selection = panel.getByRole('region', { name: 'Selected originals', exact: true });
    await expect(selection).toContainText('Aster'); await expect(selection).toContainText('Cinder'); await expect(selection).not.toContainText('Birch');
    await selection.scrollIntoViewIfNeeded();
    await alice.screenshot({ path: info.outputPath('hub-archive-selection.png'), fullPage: false });
    expect(await alice.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const importing = alice.waitForResponse((value) => value.url().endsWith('/archive/imports'));
    await panel.getByRole('button', { name: 'Import selected originals', exact: true }).click();
    const imported = await (await importing).json();
    expect(imported.imported.map((value: { archiveCardId: string }) => value.archiveCardId)).toEqual(['aster', 'cinder']);
    await expect(panel.getByText('Imported 2 of 2 selected originals.')).toBeVisible();
    await expect(alice.getByRole('button', { name: 'Edit birch', exact: true })).toHaveCount(0);
    const editor = alice.getByRole('region', { name: 'Character editor', exact: true });
    await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('aster');
    await editor.getByLabel('Name', { exact: true }).fill('Archive Aster');
    await editor.getByRole('button', { name: 'Save revision' }).click(); await expect(editor.getByRole('status')).toHaveText('Saved');
    await publish(alice, 'Archive Aster', 2);
    const after = await (await alice.request.get(`${origin}/api/hub/publications`)).json();
    const selected = after.publications.filter((value: { id: string }) => !beforeIds.has(value.id));
    expect(selected).toHaveLength(1);
    const publication = selected[0];
    expect(publication.document.data.name).toBe('Archive Aster');
    expect(publication.originalHash).toBe(record.card.original.hash);
    expect(await (await alice.request.get(`${origin}/api/hub/publications/${publication.id}/original`)).body()).toEqual(accepted);
    await login(bob, accounts.Bob!.key); await workspace(bob, 'Archive forks');
    const forking = bob.waitForResponse((value) => value.url().endsWith(`/publications/${publication.id}/forks`));
    await bob.getByRole('button', { name: 'Fork Archive Aster', exact: true }).click();
    const fork = await (await forking).json();
    expect(fork.revision.document.data.extensions.foundry.lineage).toMatchObject({ originalHash: record.card.original.hash,
      operation: 'fork', author: accounts.Bob!.account.uri, parents: [{ revisionHash: publication.document.data.extensions.foundry.lineage.revisionHash }] });
    await expect(bob.getByRole('region', { name: 'Character editor', exact: true }).getByLabel('Name', { exact: true })).toHaveValue('Archive Aster');
    // Importing another selection must not replace the already-open, unsaved draft.
    await editor.getByLabel('Name', { exact: true }).fill('Keep this open draft');
    await panel.getByRole('checkbox', { name: 'Birch', exact: true }).check();
    await panel.getByRole('button', { name: 'Review selection (1)', exact: true }).click();
    await panel.getByRole('button', { name: 'Import selected originals', exact: true }).click();
    await expect(panel.getByText('Imported 1 of 1 selected originals.')).toBeVisible();
    await expect(alice.getByRole('button', { name: 'Edit birch', exact: true })).toBeVisible();
    await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('Keep this open draft');
    await expect(editor.getByRole('status')).toHaveText('Unsaved changes');
    expect(await (await alice.request.get(`${archiveOrigin}/status`)).json()).toEqual(snapshot);
    expect(await (await alice.request.get(originalUrl)).body()).toEqual(accepted);
    const stored = await (await alice.request.get(`${origin}/api/workspaces/${imported.imported[0].card.workspaceId}/cards/${imported.imported[0].card.id}`)).json();
    expect(stored.source.provenance).toMatchObject({ kind: 'archive', archiveId: snapshot.archiveId, cardId: 'aster', snapshot: snapshot.snapshot });
  } finally { await firstContext.close(); await secondContext.close(); }
});

test('an expired Archive browser request locks the hub and retains the selection for same-account recovery', async ({ page }) => {
  const accounts = await credentials();
  await login(page, accounts.Alice!.key); await workspace(page, 'Archive session recovery');
  await page.getByRole('button', { name: 'Browse Archive', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Archive import', exact: true });
  await panel.getByRole('checkbox', { name: 'Cinder', exact: true }).check();
  await page.request.delete(`${origin}/api/session`, { headers: { origin } });
  await panel.getByRole('button', { name: 'Review selection (1)', exact: true }).click();
  await expect(page.getByLabel('Access key')).toBeVisible();
  await page.getByLabel('Access key').fill(accounts.Alice!.key); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(panel.getByRole('checkbox', { name: 'Cinder', exact: true })).toBeChecked();
  await panel.getByRole('button', { name: 'Review selection (1)', exact: true }).click();
  await panel.getByRole('button', { name: 'Import selected originals', exact: true }).click();
  await expect(panel.getByText('Imported 1 of 1 selected originals.')).toBeVisible();
});
