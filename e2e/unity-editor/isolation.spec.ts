import type { Locator, Page } from '@playwright/test';
import { document, expect, fixture, gif, png, screenshot, test, type Imported } from './fixtures.js';

const origin = 'http://127.0.0.1:19430';
const fixturePath = '/assets/isolation/isolation.html';
const pane = (page: Page, name: 'Alpha' | 'Beta') => page.getByRole('region', { name: `Editor ${name}`, exact: true });
const cardPath = (workspace: string, card: string) => `/api/workspaces/${workspace}/cards/${card}`;

async function workspace(page: Page, name: string) {
  const session = await page.request.post('/api/local-session', { headers: { origin, 'x-unity-session': 'local' } });
  expect(session.ok(), await session.text()).toBe(true);
  const result = await page.request.post('/api/workspaces', { headers: { origin }, data: { name } });
  expect(result.ok(), await result.text()).toBe(true);
  return (await result.json() as { id: string }).id;
}

async function seed(page: Page, workspaceId: string, name: string, format: 'json' | 'charx' = 'json') {
  const data = document(name); data.data.description = `${name} original description`;
  const bytes = format === 'json' ? Buffer.from(JSON.stringify(data)) : await fixture(name, format);
  const response = await page.request.post(`/api/workspaces/${workspaceId}/imports`, {
    headers: { origin, 'content-type': 'application/octet-stream', 'x-file-name': `${name}.${format}` }, data: bytes,
  });
  expect(response.status(), await response.text()).toBe(201);
  const imported: Imported = await response.json();
  return { ...imported, workspace: workspaceId, path: cardPath(workspaceId, imported.card.id), name };
}

async function pair(page: Page, alpha: { workspace: string; card: { id: string } }, beta: { workspace: string; card: { id: string } }, options: Record<string, string> = {}) {
  await page.setViewportSize({ width: 1920, height: 1100 });
  const query = new URLSearchParams({ alphaWorkspace: alpha.workspace, alphaCard: alpha.card.id,
    betaWorkspace: beta.workspace, betaCard: beta.card.id, ...options });
  await page.goto(`${fixturePath}?${query}`);
  await expect(page.getByRole('heading', { name: 'Two independent native Architect hosts', exact: true })).toBeVisible();
}

async function save(page: Page, editor: Locator, path: string) {
  const pending = page.waitForResponse((response) => new URL(response.url()).pathname.startsWith(`${path}/`) && /\/(?:asset-)?revisions$/.test(new URL(response.url()).pathname)
    && response.request().method() === 'POST');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  const response = await pending;
  expect(response.ok(), await response.text()).toBe(true);
  await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
}

async function assets(editor: Locator) {
  await editor.getByRole('button', { name: 'Assets', exact: true }).click();
  await expect(editor.getByRole('button', { name: 'Upload Asset', exact: true })).toBeVisible();
}

async function attachment(editor: Locator, name: string, bytes: Buffer) {
  await assets(editor);
  await editor.getByRole('button', { name: 'Upload Asset', exact: true }).click();
  await editor.getByLabel('Attachment type', { exact: true }).selectOption('custom');
  await editor.getByLabel('Attachment name', { exact: true }).fill(name);
  const chooser = editor.page().waitForEvent('filechooser');
  await editor.getByText('Drop file or click to browse', { exact: true }).click();
  await (await chooser).setFiles({ name: `${name}.txt`, mimeType: 'text/plain', buffer: bytes });
  await expect(editor.getByText(name, { exact: true }).first()).toBeVisible();
}

async function portrait(editor: Locator, name: string, mimeType: string, buffer: Buffer) {
  const chooser = editor.page().waitForEvent('filechooser');
  await editor.getByText('Upload Image', { exact: true }).click();
  await (await chooser).setFiles({ name, mimeType, buffer });
}

test('two workspaces with colliding wire card IDs retain independent reads, heads, saves and focused hotkeys', async ({ page }, info) => {
  const alpha = await seed(page, await workspace(page, 'Isolation Alpha'), 'Alpha identity');
  const beta = await seed(page, await workspace(page, 'Isolation Beta'), 'Beta identity');
  // SQLite IDs are globally unique; only this read/write transport fixture aliases
  // two real IDs. Workspaces, revisions, bytes and commits still use the real API.
  const alias = '00000000-0000-4000-8000-000000000321';
  let releaseRead!: () => void, enteredRead!: () => void;
  const heldRead = new Promise<void>((resolve) => { releaseRead = resolve; });
  const readStarted = new Promise<void>((resolve) => { enteredRead = resolve; });
  const saveHolds = new Map<string, { entered(): void; wait: Promise<void>; release(): void }>();
  const requestedWrites: string[] = [];
  for (const item of [alpha, beta]) {
    await page.route(`**/workspaces/${item.workspace}/cards/${alias}**`, async (route) => {
      const request = route.request();
      const incoming = new URL(request.url());
      if (item === alpha && request.method() === 'GET' && incoming.pathname.endsWith(`/cards/${alias}`)) { enteredRead(); await heldRead; }
      if (request.method() === 'POST') {
        requestedWrites.push(incoming.pathname);
        const hold = saveHolds.get(item.workspace);
        if (hold) { hold.entered(); await hold.wait; }
      }
      const target = request.url().replace(`/cards/${alias}`, `/cards/${item.card.id}`);
      const response = await route.fetch({ url: target });
      if (response.headers()['content-type']?.includes('application/json')) {
        const body = await response.json();
        if (body.card) body.card.id = alias;
        if (body.revision) body.revision.cardId = alias;
        await route.fulfill({ response, json: body });
      } else await route.fulfill({ response });
    });
  }
  try {
    await pair(page, { ...alpha, card: { id: alias } }, { ...beta, card: { id: alias } });
    await readStarted;
    await expect(pane(page, 'Beta').getByLabel('Name', { exact: true })).toHaveValue(beta.name);
    await pane(page, 'Beta').getByLabel('Name', { exact: true }).fill('Beta draft while Alpha loads');
    releaseRead();
    await expect(pane(page, 'Alpha').getByLabel('Name', { exact: true })).toHaveValue(alpha.name);
    await expect(pane(page, 'Beta').getByLabel('Name', { exact: true })).toHaveValue('Beta draft while Alpha loads');
    await pane(page, 'Alpha').getByLabel('Name', { exact: true }).fill('Alpha hotkey target');
    const alphaSaved = page.waitForResponse((response) => new URL(response.url()).pathname === `${cardPath(alpha.workspace, alias)}/revisions` && response.request().method() === 'POST');
    await pane(page, 'Alpha').getByLabel('Name', { exact: true }).press('Control+s');
    expect((await alphaSaved).ok()).toBe(true);
    await expect(pane(page, 'Alpha').getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await expect(pane(page, 'Beta').getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    expect(requestedWrites).toEqual([`${cardPath(alpha.workspace, alias)}/revisions`]);
    await pane(page, 'Alpha').getByLabel('Name', { exact: true }).fill('Alpha reversed completion');
    await pane(page, 'Beta').getByLabel('Name', { exact: true }).fill('Beta reversed completion');
    const starts: Promise<void>[] = [];
    for (const item of [alpha, beta]) {
      let entered!: () => void, release!: () => void;
      starts.push(new Promise<void>((resolve) => { entered = resolve; }));
      const wait = new Promise<void>((resolve) => { release = resolve; });
      saveHolds.set(item.workspace, { entered, wait, release });
    }
    await pane(page, 'Alpha').getByRole('button', { name: 'Save', exact: true }).click();
    await pane(page, 'Beta').getByRole('button', { name: 'Save', exact: true }).click();
    await Promise.all(starts);
    saveHolds.get(beta.workspace)!.release();
    await expect(pane(page, 'Beta').getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await expect(pane(page, 'Alpha').getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    saveHolds.get(alpha.workspace)!.release();
    await expect(pane(page, 'Alpha').getByLabel('Name', { exact: true })).toHaveValue('Alpha reversed completion');
    await expect(pane(page, 'Beta').getByLabel('Name', { exact: true })).toHaveValue('Beta reversed completion');
    await expect.poll(async () => (await (await page.request.get(alpha.path)).json()).revision.document.data.name).toBe('Alpha reversed completion');
    await expect.poll(async () => (await (await page.request.get(beta.path)).json()).revision.document.data.name).toBe('Beta reversed completion');
    await screenshot(page, info, 'two-workspaces-colliding-ids-reversed-saves');
  } finally { releaseRead(); for (const hold of saveHolds.values()) hold.release(); }
});

test('tabs, staged files, portrait URLs and dialog roots stay owned when another host is disposed mid-save', async ({ page }, info) => {
  const alpha = await seed(page, await workspace(page, 'Isolation asset Alpha'), 'Alpha asset owner', 'charx');
  const beta = await seed(page, await workspace(page, 'Isolation asset Beta'), 'Beta asset owner', 'charx');
  await pair(page, alpha, beta);
  const first = pane(page, 'Alpha'), second = pane(page, 'Beta');
  await expect(first.getByLabel('Name', { exact: true })).toHaveValue(alpha.name);
  await expect(second.getByLabel('Name', { exact: true })).toHaveValue(beta.name);
  await portrait(first, 'alpha.gif', 'image/gif', gif);
  await portrait(second, 'beta.png', 'image/png', png);
  await expect(first.getByAltText('Character Avatar', { exact: true })).toHaveAttribute('src', /^blob:/);
  await expect(second.getByAltText('Character Avatar', { exact: true })).toHaveAttribute('src', /^blob:/);
  const alphaUrl = await first.getByAltText('Character Avatar', { exact: true }).getAttribute('src');
  const betaUrl = await second.getByAltText('Character Avatar', { exact: true }).getAttribute('src');
  expect(alphaUrl).toMatch(/^blob:/); expect(betaUrl).toMatch(/^blob:/); expect(alphaUrl).not.toBe(betaUrl);
  await attachment(first, 'Alpha only attachment', Buffer.from('Alpha bytes'));
  await expect(second.getByLabel('Name', { exact: true })).toHaveValue(beta.name);
  await expect(second.getByRole('button', { name: 'Upload Asset', exact: true })).toHaveCount(0);
  await attachment(second, 'Beta only attachment', Buffer.from('Beta bytes'));
  await expect(first.getByText('Beta only attachment', { exact: true })).toHaveCount(0);
  await expect(second.getByText('Alpha only attachment', { exact: true })).toHaveCount(0);
  for (const [index, editor] of [first, second].entries()) {
    await editor.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(editor.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
    expect(await editor.getByRole('dialog', { name: 'Settings', exact: true }).evaluate((dialog) =>
      dialog.closest('.architect-root')?.closest('section')?.getAttribute('aria-label'))).toBe(`Editor ${index === 0 ? 'Alpha' : 'Beta'}`);
    await editor.getByRole('button', { name: 'Close settings', exact: true }).click();
  }
  await screenshot(page, info, 'two-editor-independent-asset-drafts');
  let release!: () => void, entered!: () => void, finished!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const completed = new Promise<void>((resolve) => { finished = resolve; });
  const pattern = `**/cards/${alpha.card.id}/asset-revisions`;
  await page.route(pattern, async (route) => { entered(); try { await held; await route.continue().catch(() => undefined); } finally { finished(); } });
  try {
    await first.getByRole('button', { name: 'Save', exact: true }).click(); await started;
    await first.getByRole('button', { name: 'Close Alpha editor', exact: true }).click();
    await expect(first).toHaveCount(0);
    await second.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(second.getByAltText('Character Avatar', { exact: true })).toHaveAttribute('src', betaUrl!);
    await expect(second.getByAltText('Character Avatar', { exact: true })).toHaveJSProperty('naturalWidth', 1);
    await second.getByLabel('Name', { exact: true }).fill('Beta after Alpha disposal');
    release(); await completed;
    await save(page, second, beta.path);
    const saved = await (await page.request.get(beta.path)).json();
    expect(saved.revision.document.data.name).toBe('Beta after Alpha disposal');
    const names = saved.revision.document.data.assets.map((asset: { name: string }) => asset.name);
    expect(names).toContain('Beta only attachment'); expect(names).not.toContain('Alpha only attachment');
    expect(await (await page.request.get(`${beta.path}/asset?revisionId=${saved.revision.id}&path=portrait`)).body()).toEqual(png);
    await screenshot(page, info, 'remaining-editor-after-other-disposal');
  } finally { release(); await page.unroute(pattern); }
});

test('two hosts of the same saved card conflict without sharing or overwriting their drafts', async ({ page, diagnostics }, info) => {
  const source = await seed(page, await workspace(page, 'Isolation shared card'), 'Shared saved source');
  await pair(page, source, source);
  const first = pane(page, 'Alpha'), second = pane(page, 'Beta');
  await expect(first.getByLabel('Name', { exact: true })).toHaveValue(source.name);
  await expect(second.getByLabel('Name', { exact: true })).toHaveValue(source.name);
  await first.getByLabel('Name', { exact: true }).fill('First independent draft');
  await second.getByLabel('Name', { exact: true }).fill('Second independent draft');
  await save(page, first, source.path);
  diagnostics.expectedStatuses.add(409); diagnostics.expectedConsole.push('[saveCard] FAILED to save card:');
  await second.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(second.getByRole('alert')).toContainText(/changed|conflict/i);
  await expect(second.getByLabel('Name', { exact: true })).toHaveValue('Second independent draft');
  await expect(first.getByLabel('Name', { exact: true })).toHaveValue('First independent draft');
  await expect(first.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(second.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  const saved = await (await page.request.get(source.path)).json();
  expect(saved.revision.sequence).toBe(2); expect(saved.revision.document.data.name).toBe('First independent draft');
  await screenshot(page, info, 'same-card-two-hosts-head-conflict');
});

test('returning from a pending fork of the current card cancels the fork without affecting the other host', async ({ page }, info) => {
  const alpha = await seed(page, await workspace(page, 'Isolation pending fork Alpha'), 'Current Alpha card');
  const beta = await seed(page, await workspace(page, 'Isolation pending fork Beta'), 'Current Beta card');
  await pair(page, alpha, beta, { alphaFork: alpha.card.id });
  const first = pane(page, 'Alpha'), second = pane(page, 'Beta');
  await expect(first.getByLabel('Name', { exact: true })).toHaveValue(alpha.name);
  await expect(second.getByLabel('Name', { exact: true })).toHaveValue(beta.name);
  let release!: () => void, entered!: () => void, finished!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const completed = new Promise<void>((resolve) => { finished = resolve; });
  const aborted: string[] = [];
  page.on('requestfailed', (request) => { if (new URL(request.url()).pathname === alpha.path) aborted.push(request.url()); });
  const pattern = `**${alpha.path}`;
  await page.route(pattern, async (route) => { entered(); try { await held; await route.continue().catch(() => undefined); } finally { finished(); } });
  try {
    await first.getByRole('button', { name: 'Start Alpha fork', exact: true }).click(); await started;
    await second.getByLabel('Name', { exact: true }).fill('Beta draft during pending Alpha fork');
    await first.getByRole('button', { name: 'Return Alpha original', exact: true }).click();
    await expect(first.getByLabel('Name', { exact: true })).toHaveValue(alpha.name);
    await expect.poll(() => aborted.length, 'The abandoned same-card fork read is aborted').toBe(1);
    release(); await completed;
    await expect(first.getByLabel('Name', { exact: true })).toHaveValue(alpha.name);
    await expect(first.getByText('Fork — not in the library until you save', { exact: true })).toHaveCount(0);
    await expect(first.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await expect(second.getByLabel('Name', { exact: true })).toHaveValue('Beta draft during pending Alpha fork');
    expect((await (await page.request.get(alpha.path)).json()).revision.sequence).toBe(1);
    await screenshot(page, info, 'same-card-pending-fork-return-original');
  } finally { release(); await page.unroute(pattern); }
});

test('failed card selection never exposes or saves the previous card and the other host remains usable', async ({ page, diagnostics }, info) => {
  const alpha = await seed(page, await workspace(page, 'Isolation failed selection Alpha'), 'Previous Alpha card');
  const alternate = await seed(page, alpha.workspace, 'Requested Alpha alternate');
  const beta = await seed(page, await workspace(page, 'Isolation failed selection Beta'), 'Unaffected Beta card');
  await pair(page, alpha, beta, { alphaAlternate: alternate.card.id });
  const first = pane(page, 'Alpha'), second = pane(page, 'Beta');
  await expect(first.getByLabel('Name', { exact: true })).toHaveValue(alpha.name);
  await expect(second.getByLabel('Name', { exact: true })).toHaveValue(beta.name);
  await second.getByLabel('Name', { exact: true }).fill('Beta still editable');
  const mutations: string[] = [];
  page.on('request', (request) => { if (request.method() === 'POST') mutations.push(new URL(request.url()).pathname); });
  diagnostics.expectedStatuses.add(503);
  const pattern = `**${alternate.path}`;
  await page.route(pattern, (route) => route.fulfill({ status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Test alternate card unavailable' } }) }));
  await first.getByRole('button', { name: 'Open Alpha alternate', exact: true }).click();
  await expect(first.getByRole('alert')).toContainText('Test alternate card unavailable');
  await expect(first.getByLabel('Name', { exact: true })).toHaveCount(0);
  await expect(first.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await first.getByRole('button', { name: 'Settings', exact: true }).focus();
  await page.keyboard.press('Control+s');
  expect(mutations).toEqual([]);
  await expect(second.getByLabel('Name', { exact: true })).toHaveValue('Beta still editable');
  await save(page, second, beta.path);
  expect((await (await page.request.get(alpha.path)).json()).revision.sequence).toBe(1);
  await screenshot(page, info, 'failed-selection-gates-stale-card');
  await first.getByRole('button', { name: 'Return Alpha original', exact: true }).click();
  await expect(first.getByLabel('Name', { exact: true })).toHaveValue(alpha.name);
  await page.unroute(pattern);
  await first.getByRole('button', { name: 'Open Alpha alternate', exact: true }).click();
  await expect(first.getByLabel('Name', { exact: true })).toHaveValue(alternate.name);
  await expect(first.getByRole('alert')).toHaveCount(0);
});

test('discarding a recovery prompt stays dismissed without deleting another live owner draft', async ({ page }, info) => {
  const source = await seed(page, await workspace(page, 'Isolation recovery owners'), 'Saved recovery source');
  await pair(page, source, source, { recovery: '1' });
  const first = pane(page, 'Alpha'), second = pane(page, 'Beta');
  const banner = () => first.getByText(/^You have unsaved changes from/);
  await expect(first.getByLabel('Name', { exact: true })).toHaveValue(source.name);
  await expect(second.getByLabel('Name', { exact: true })).toHaveValue(source.name);
  // Two distinct recovery writes deliberately share the exact same millisecond.
  // Acknowledging the first snapshot must not hide the second fresh owner edit.
  await page.clock.install({ time: new Date('2030-01-01T12:00:00.000Z') });
  await page.clock.pauseAt(new Date('2030-01-01T12:00:01.000Z'));
  const recoveryTimestamp = await page.evaluate(() => Date.now());
  await second.getByLabel('Name', { exact: true }).fill('Beta recovery snapshot one');
  await second.getByRole('button', { name: 'Flush Beta recovery', exact: true }).click();
  await expect(second.getByLabel('Beta recovery flushes', { exact: true })).toHaveText('1');
  await first.getByRole('button', { name: 'Close Alpha editor', exact: true }).click();
  await page.getByRole('button', { name: 'Reopen Alpha editor', exact: true }).click();
  await expect(banner()).toBeVisible();
  await expect(first.getByLabel('Name', { exact: true })).toHaveValue(source.name);
  await first.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(banner()).toHaveCount(0);
  await expect(second.getByLabel('Name', { exact: true })).toHaveValue('Beta recovery snapshot one');
  await expect(second.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await first.getByRole('button', { name: 'Close Alpha editor', exact: true }).click();
  await page.getByRole('button', { name: 'Reopen Alpha editor', exact: true }).click();
  await expect(first.getByLabel('Name', { exact: true })).toHaveValue(source.name);
  await expect(banner()).toHaveCount(0);
  await second.getByLabel('Name', { exact: true }).fill('Beta recovery snapshot two');
  await second.getByRole('button', { name: 'Flush Beta recovery', exact: true }).click();
  await expect(second.getByLabel('Beta recovery flushes', { exact: true })).toHaveText('2');
  expect(await page.evaluate(() => Date.now())).toBe(recoveryTimestamp);
  await first.getByRole('button', { name: 'Close Alpha editor', exact: true }).click();
  await page.getByRole('button', { name: 'Reopen Alpha editor', exact: true }).click();
  await expect(banner()).toBeVisible();
  await first.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(first.getByLabel('Name', { exact: true })).toHaveValue('Beta recovery snapshot two');
  await expect(banner()).toHaveCount(0);
  await expect(second.getByLabel('Name', { exact: true })).toHaveValue('Beta recovery snapshot two');
  await save(page, first, source.path);
  await expect(second.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  page.once('dialog', (dialog) => dialog.accept());
  await second.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(second.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await second.getByRole('button', { name: 'Close Beta editor', exact: true }).click();
  await page.getByRole('button', { name: 'Reopen Beta editor', exact: true }).click();
  await expect(second.getByLabel('Name', { exact: true })).toHaveValue('Beta recovery snapshot two');
  await expect(second.getByText(/^You have unsaved changes from/)).toHaveCount(0);
  expect((await (await page.request.get(source.path)).json()).revision.sequence).toBe(2);
  await screenshot(page, info, 'recovery-dismissal-ownership-and-reopen');
});

async function assistant(editor: Locator, instruction: string) {
  await editor.getByRole('button', { name: 'Character', exact: true }).click();
  await editor.locator('.standard-editor-field').filter({ has: editor.page().getByLabel('Description', { exact: true }) }).getByTitle('AI Assist', { exact: true }).click();
  const sidebar = editor.getByRole('complementary', { name: 'AI assistant', exact: true });
  await sidebar.getByRole('button', { name: /^Custom Instruction/ }).click();
  await sidebar.getByPlaceholder('Describe what you want to do...', { exact: true }).fill(instruction);
  return sidebar;
}

test('AI completions stay with their owner and cannot apply after selection changes or disposal', async ({ page }, info) => {
  const alpha = await seed(page, await workspace(page, 'Isolation AI Alpha'), 'Alpha AI source');
  const alternate = await seed(page, alpha.workspace, 'Alpha AI alternate');
  const beta = await seed(page, await workspace(page, 'Isolation AI Beta'), 'Beta AI source');
  const requests: { text: string; release(): void; done: Promise<void> }[] = [];
  await page.route('**/qa-ai/**', async (route) => {
    const body = route.request().postDataJSON() as { messages: { role: string; content: string }[] };
    const text = body.messages.find((message) => message.role === 'user')!.content;
    let release!: () => void, finished!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const done = new Promise<void>((resolve) => { finished = resolve; });
    requests.push({ text, release, done });
    try { await held; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: `Revised: ${text}` } }] }) }).catch(() => undefined); }
    finally { finished(); }
  });
  try {
    await pair(page, alpha, beta, { ai: '1', alphaAlternate: alternate.card.id });
    const first = pane(page, 'Alpha'), second = pane(page, 'Beta');
    await expect(first.getByLabel('Name', { exact: true })).toHaveValue(alpha.name);
    await expect(second.getByLabel('Name', { exact: true })).toHaveValue(beta.name);
    const alphaAI = await assistant(first, 'Rewrite Alpha only');
    await alphaAI.getByRole('button', { name: 'Generate revision', exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    const betaAI = await assistant(second, 'Rewrite Beta only');
    await betaAI.getByRole('button', { name: 'Generate revision', exact: true }).click();
    await expect.poll(() => requests.length).toBe(2);
    requests[1]!.release(); await requests[1]!.done;
    await betaAI.getByRole('button', { name: 'Replace', exact: true }).click();
    await expect(second.getByLabel('Description', { exact: true })).toHaveValue(`Revised: ${beta.name} original description`);
    await expect(first.getByLabel('Description', { exact: true })).toHaveValue(`${alpha.name} original description`);
    requests[0]!.release(); await requests[0]!.done;
    await expect(alphaAI.getByRole('button', { name: 'Replace', exact: true })).toBeVisible();
    await first.getByRole('button', { name: 'Open Alpha alternate', exact: true }).click();
    await expect(first.getByLabel('Name', { exact: true })).toHaveValue(alternate.name);
    await first.getByRole('button', { name: 'Character', exact: true }).click();
    await expect(first.getByLabel('Description', { exact: true })).toHaveValue(`${alternate.name} original description`);
    await expect(first.getByRole('button', { name: 'Replace', exact: true })).toHaveCount(0);
    await expect(second.getByLabel('Description', { exact: true })).toHaveValue(`Revised: ${beta.name} original description`);
    if (await first.getByRole('button', { name: 'Close AI assistant', exact: true }).count()) await first.getByRole('button', { name: 'Close AI assistant', exact: true }).click();
    const pendingAI = await assistant(first, 'Will be disposed');
    await pendingAI.getByRole('button', { name: 'Generate revision', exact: true }).click();
    await expect.poll(() => requests.length).toBe(3);
    await first.getByRole('button', { name: 'Close Alpha editor', exact: true }).click();
    requests[2]!.release(); await requests[2]!.done;
    await expect(second.getByLabel('Description', { exact: true })).toHaveValue(`Revised: ${beta.name} original description`);
    await save(page, second, beta.path);
    expect((await (await page.request.get(beta.path)).json()).revision.document.data.description).toBe(`Revised: ${beta.name} original description`);
    await screenshot(page, info, 'AI-session-isolation-and-disposal');
  } finally { for (const request of requests) request.release(); }
});
