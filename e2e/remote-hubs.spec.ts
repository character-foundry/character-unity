import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';

const sender = 'http://127.0.0.1:19314', receiver = 'https://127.0.0.1:19315';
interface Credentials { account: { id: string; uri: string }; key: string }
interface Fixture { publisher: Credentials; receiver: Credentials; editor: Credentials; outsider: Credentials; workspaceId: string; lostResponseFile: string }
const fixture = async () => JSON.parse(await readFile('runtime/e2e-remote.json', 'utf8')) as Fixture;
async function login(page: Page, origin: string, key: string) {
  await page.goto(origin); await page.getByLabel('Access key').fill(key); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
async function workspace(page: Page, name: string) {
  await page.getByLabel('New workspace', { exact: true }).fill(name); await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByLabel('Import a card')).toBeEnabled();
}

test('two running hubs pull, edit, review and retry the exact return over HTTPS before a separate publication', async ({ browser }, info) => {
  test.setTimeout(60_000);
  const data = await fixture(), publisherContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const editorContext = await browser.newContext({ viewport: { width: 390, height: 844 } }), receiverContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const publisher = await publisherContext.newPage(), editor = await editorContext.newPage(), recipient = await receiverContext.newPage();
  const errors: string[] = []; for (const page of [publisher, editor, recipient]) page.on('pageerror', (error) => errors.push(error.message));
  try {
    await login(publisher, receiver, data.publisher.key); await workspace(publisher, 'Public originals');
    const original = JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Remote Aster', description: 'Original from another hub.', first_mes: 'Hello from afar.', extensions: {} } });
    await publisher.getByLabel('Import a card').setInputFiles({ name: 'aster.json', mimeType: 'application/json', buffer: Buffer.from(original) });
    const publisherEditor = publisher.getByRole('region', { name: 'Character editor', exact: true });
    const attachment = 'Exact attachment shared between two hubs.\n';
    await publisherEditor.getByRole('button', { name: 'Assets', exact: true }).click();
    await expect(publisherEditor.getByLabel('Add attachment')).toBeEnabled();
    await publisherEditor.getByLabel('Add attachment').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from(attachment) });
    await expect(publisherEditor.getByRole('status')).toHaveText('Unsaved changes');
    await publisherEditor.getByRole('button', { name: 'Save revision' }).click(); await expect(publisherEditor.getByRole('status')).toHaveText('Saved');
    await publisher.getByLabel('Select Remote Aster · revision 2', { exact: true }).check();
    await publisher.getByRole('button', { name: 'Review 1 selected' }).click();
    await publisher.getByRole('button', { name: 'Publish selected revisions', exact: true }).click();
    await expect(publisher.getByRole('region', { name: 'Review publication' })).not.toBeVisible();
    const published = (await (await publisher.request.get(`${receiver}/api/hub/publications`)).json()).publications[0];

    await login(editor, sender, data.editor.key); await workspace(editor, 'Pulled characters');
    const remotes = editor.getByRole('region', { name: 'Remote hubs', exact: true });
    await remotes.getByLabel('Remote hub', { exact: true }).selectOption('friends');
    await remotes.getByRole('button', { name: 'Browse remote publications' }).click();
    const pullResponse = editor.waitForResponse((response) => response.url().endsWith('/connections/friends/pulls'));
    await remotes.getByRole('button', { name: 'Pull fork of Remote Aster' }).click();
    const pulled = await (await pullResponse).json();
    await editor.getByRole('button', { name: 'Edit Remote Aster', exact: true }).click();
    const pane = editor.getByRole('region', { name: 'Character editor', exact: true });
    await pane.getByRole('button', { name: 'Character', exact: true }).click();
    await pane.getByLabel('Description', { exact: true }).fill('A saved return from the second hub.');
    await pane.getByRole('button', { name: 'Save revision' }).click(); await expect(pane.getByRole('status')).toHaveText('Saved');
    await remotes.getByLabel('Saved revision to return').selectOption({ label: 'Remote Aster · revision 2' });
    // A lost enqueue response must retain its operation ID even across browser reload.
    let dropEnqueue = true;
    await editor.route('**/api/remotes/workspaces/*/jobs', async (route) => {
      if (route.request().method() === 'POST' && dropEnqueue) { dropEnqueue = false; const response = await route.fetch(); expect(response.status()).toBe(201); await route.abort('failed'); }
      else await route.continue();
    });
    await remotes.getByRole('button', { name: 'Prepare return', exact: true }).click();
    await expect(remotes.getByRole('group', { name: 'Pending preparation' })).toBeVisible();
    await expect(remotes.getByRole('button', { name: 'Retry preparation' })).toBeEnabled();
    await editor.reload(); await editor.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption(pulled.card.workspaceId);
    await remotes.getByRole('button', { name: 'Retry preparation' }).click();
    const review = remotes.getByRole('region', { name: 'Review remote return' });
    await expect(review).toContainText('A saved return from the second hub.');
    await expect(review).toContainText('1 attached asset');
    await expect(review).toContainText('Ready to send');
    const jobsPath = `${sender}/api/remotes/workspaces/${pulled.card.workspaceId}/jobs`;
    const jobs = (await (await editor.request.get(jobsPath)).json()).jobs; expect(jobs).toHaveLength(1);
    const job = jobs[0]; expect(job.sequence).toBe(2); expect(job.state).toBe('prepared');
    // Keep both a newer saved head and an unsaved editor draft out of the queued return.
    await editor.getByRole('button', { name: 'Edit Remote Aster', exact: true }).click();
    await pane.getByRole('button', { name: 'Character', exact: true }).click();
    await pane.getByLabel('Description', { exact: true }).fill('A newer saved head that must not be sent.');
    await pane.getByRole('button', { name: 'Save revision' }).click(); await expect(pane.getByRole('status')).toHaveText('Saved');
    await pane.getByLabel('Description', { exact: true }).fill('Unsaved draft must survive remote actions.');
    await writeFile(data.lostResponseFile, 'Lose the next successful remote return response.');
    await review.getByRole('button', { name: 'Send saved return' }).click();
    await expect(review).toContainText('Outcome uncertain');
    await expect(pane.getByLabel('Description', { exact: true })).toHaveValue('Unsaved draft must survive remote actions.');
    await expect(editor.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await review.getByRole('button', { name: 'Retry saved return' }).click();
    await expect(review).toContainText('Remote draft acknowledged.');
    const acknowledged = await (await editor.request.get(`${jobsPath}/${job.requestId}`)).json();
    expect(acknowledged).toMatchObject({ requestId: job.requestId, revisionId: job.revisionId, frameHash: job.frameHash, attempts: 2, state: 'acknowledged' });
    await expect(pane.getByLabel('Description', { exact: true })).toHaveValue('Unsaved draft must survive remote actions.');

    await login(recipient, receiver, data.receiver.key);
    await recipient.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption(data.workspaceId);
    await expect(recipient.getByRole('button', { name: 'Edit Remote Aster', exact: true })).toBeVisible();
    const cards = (await (await recipient.request.get(`${receiver}/api/workspaces/${data.workspaceId}/cards`)).json()).cards;
    expect(cards).toHaveLength(1);
    const returned = await (await recipient.request.get(`${receiver}/api/workspaces/${data.workspaceId}/cards/${acknowledged.receipt.cardId}`)).json();
    expect(returned.revision.document.data.description).toBe('A saved return from the second hub.');
    expect(returned.revision.document.data.extensions.foundry.lineage.author).toBe(data.editor.account.uri);
    expect(await (await recipient.request.get(`${receiver}/api/workspaces/${data.workspaceId}/cards/${acknowledged.receipt.cardId}/asset?revisionId=${acknowledged.receipt.revisionId}&path=declared%2F0`)).body()).toEqual(Buffer.from(attachment));
    expect((await (await publisher.request.get(`${receiver}/api/hub/publications`)).json()).publications).toHaveLength(1);
    await recipient.getByLabel('Select Remote Aster · revision 1', { exact: true }).check();
    await recipient.getByRole('button', { name: 'Review 1 selected' }).click();
    await recipient.getByRole('button', { name: 'Publish selected revisions', exact: true }).click();
    await expect(recipient.getByRole('region', { name: 'Review publication' })).not.toBeVisible();
    const visible = (await (await publisher.request.get(`${receiver}/api/hub/publications`)).json()).publications;
    expect(visible).toHaveLength(2); expect(visible.find((value: { parentId: string | null }) => value.parentId === published.id)).toBeTruthy();
    expect(await (await publisher.request.get(`${receiver}/api/hub/publications/${published.id}/original`)).text()).toBe(original);
    await editor.screenshot({ path: info.outputPath('remote-return-mobile.png'), fullPage: true });
    expect(await editor.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]);
  } finally { await Promise.allSettled([publisherContext.close(), editorContext.close(), receiverContext.close()]); }
});

test('another account cannot discover or use a configured peer', async ({ page }) => {
  const data = await fixture(); await login(page, sender, data.outsider.key); await workspace(page, 'Unconnected account');
  const panel = page.getByRole('region', { name: 'Remote hubs', exact: true });
  await expect(panel).toContainText('No remote hubs are connected to your account.');
  await expect(panel.getByLabel('Remote hub', { exact: true })).not.toBeVisible();
  expect((await page.request.get(`${sender}/api/remotes/connections/friends/publications?workspaceId=missing`)).status()).toBe(403);
});
