import { readFile } from 'node:fs/promises';
import { assets, document as cardDocument, download, expect, gif, importCard, moduleRisum, notes, opaque, parse, png, save, screenshot, test } from './fixtures.js';

// Coverage: native file import + opaque roundtrip; asset revisions + portrait; failed/stale
// saves; explicit discard; New/Fork delayed persistence; small-screen editor navigation;
// changes during first Save; initial read failures; restoring saved history.
test('JSON, PNG and CharX imports edit without normalizing away opaque content', async ({ page }, info) => {
  for (const format of ['json', 'png', 'charx'] as const) {
    const name = `Opaque ${format}`;
    const imported = await importCard(page, name, format);
    await page.getByLabel('Name', { exact: true }).fill(`${name} edited`);
    await save(page);
    const saved = await (await page.request.get(imported.path)).json();
    expect(saved.revision.sequence).toBe(2);
    expect(saved.revision.document.vendor_envelope).toEqual(opaque);
    expect(saved.revision.document.data.extensions.vendor).toEqual(cardDocument(name).data.extensions.vendor);
    expect(saved.revision.assets).toEqual(imported.revision.assets);
    expect(await (await page.request.get(`${imported.path}/original`)).body()).toEqual(imported.bytes);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    const parsed = await parse(await download(page, format === 'json' ? 'Export JSON' : format === 'png' ? 'Download PNG' : 'Export CharX'));
    expect(parsed.originalShape.vendor_envelope).toEqual(opaque);
    expect(parsed.originalShape.data.name).toBe(`${name} edited`);
    expect(parsed.originalShape.data.extensions.vendor).toEqual(cardDocument(name).data.extensions.vendor);
    if (format === 'charx') {
      expect(Buffer.from(parsed.metadata!.moduleRisum!)).toEqual(moduleRisum);
      expect(Buffer.from(parsed.assets.find((asset) => asset.name === 'notes')!.data)).toEqual(notes);
      await screenshot(page, info, 'opaque-charx-saved-profile');
    }
  }
});

test('portrait and attachment drafts persist together only on Save and export exact bytes', async ({ page }, info) => {
  const imported = await importCard(page, 'Asset revision');
  await page.clock.install();
  await assets(page);
  await expect(page.getByText('notes', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Choose portrait', { exact: true }).setInputFiles({ name: 'new-portrait.gif', mimeType: 'image/gif', buffer: gif });
  await assets(page);
  await page.getByRole('button', { name: 'Upload Asset', exact: true }).click();
  await page.getByLabel('Attachment type', { exact: true }).selectOption('custom');
  await page.getByLabel('Attachment name', { exact: true }).fill('new attachment');
  const attachment = Buffer.from('New attachment: exact bytes\n');
  await page.getByLabel('Add attachment', { exact: true }).setInputFiles({ name: 'new.txt', mimeType: 'text/plain', buffer: attachment });
  await expect(page.getByText('new attachment', { exact: true }).first()).toBeVisible();
  await page.getByTitle('List view', { exact: true }).click();
  await page.getByRole('button', { name: 'Select asset notes', exact: true }).click();
  const attachmentDownload = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download Asset', exact: true }).click();
  expect(await readFile((await (await attachmentDownload).path())!)).toEqual(notes);
  await page.getByRole('button', { name: 'Rename asset', exact: true }).click();
  await page.getByLabel('Asset name', { exact: true }).fill('notes renamed');
  await page.getByRole('button', { name: 'Apply asset name', exact: true }).click();
  await expect(page.getByText('notes renamed', { exact: true }).first()).toBeVisible();
  await page.clock.fastForward(35_000);
  expect((await (await page.request.get(imported.path)).json()).revision.id).toBe(imported.revision.id);
  await screenshot(page, info, 'assets-before-save');
  await save(page);
  await page.reload();
  await assets(page);
  await expect(page.getByText('new attachment', { exact: true }).first()).toBeVisible();
  await screenshot(page, info, 'assets-reopened');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  const parsed = await parse(await download(page, 'Export CharX'));
  expect(Buffer.from(parsed.assets.find((asset) => asset.name === 'new attachment')!.data)).toEqual(attachment);
  expect(Buffer.from(parsed.assets.find((asset) => asset.isMain)!.data)).toEqual(gif);
  expect(Buffer.from(parsed.assets.find((asset) => asset.name === 'notes renamed')!.data)).toEqual(notes);
  expect(parsed.originalShape.data.assets!.find((asset) => asset.name === 'notes renamed')!.vendor_asset).toEqual({ preserve: true });
  expect(Buffer.from(parsed.metadata!.moduleRisum!)).toEqual(moduleRisum);
  expect(parsed.originalShape.vendor_envelope).toEqual(opaque);
  expect(await (await page.request.get(`${imported.path}/original`)).body()).toEqual(imported.bytes);
});

test('failed and stale saves keep the draft and uploaded portrait available for retry', async ({ page, diagnostics }, info) => {
  const imported = await importCard(page, 'Failed save');
  await page.getByLabel('Choose portrait', { exact: true }).setInputFiles({ name: 'unsaved.gif', mimeType: 'image/gif', buffer: gif });
  await page.getByLabel('Name', { exact: true }).fill('Draft survives');
  const portrait = page.getByAltText('Character Avatar', { exact: true });
  await expect(portrait).toHaveAttribute('src', /^blob:/);
  const draftPortraitUrl = (await portrait.getAttribute('src'))!;
  diagnostics.expectedStatuses.add(503);
  diagnostics.expectedConsole.push('[saveCard] FAILED to save card: Error: Test storage temporarily unavailable');
  const pattern = '**/asset-revisions';
  await page.route(pattern, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Test storage temporarily unavailable' } }) }));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Test storage temporarily unavailable');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Draft survives');
  await expect(portrait).toHaveAttribute('src', draftPortraitUrl);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  expect((await (await page.request.get(imported.path)).json()).revision.id).toBe(imported.revision.id);
  await screenshot(page, info, 'save-failure-retained-draft');
  await page.unroute(pattern);
  const competing = structuredClone(imported.revision.document);
  (competing.data as Record<string, unknown>).name = 'Another editor saved first';
  const response = await page.request.post(`${imported.path}/revisions`, { headers: { origin: new URL(page.url()).origin }, data: { expectedHead: imported.revision.id, document: competing } });
  expect(response.ok(), await response.text()).toBe(true);
  diagnostics.expectedStatuses.add(409);
  diagnostics.expectedConsole.push('[saveCard] FAILED to save card: Error: The card has changed; reload before saving');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/changed|conflict/i);
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Draft survives');
  await expect(portrait).toHaveAttribute('src', draftPortraitUrl);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await screenshot(page, info, 'stale-head-retained-draft');
});

test('discarding unsaved edits restores the saved document and assets without a revision', async ({ page }, info) => {
  const imported = await importCard(page, 'Discard draft');
  await page.getByLabel('Name', { exact: true }).fill('Must not be saved');
  await page.getByLabel('Choose portrait', { exact: true }).setInputFiles({ name: 'discard.gif', mimeType: 'image/gif', buffer: gif });
  await assets(page);
  await page.getByTitle('List view', { exact: true }).click();
  await page.getByRole('button', { name: 'Select asset notes', exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete Asset', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select asset notes', exact: true })).toHaveCount(0);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Discard draft');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect((await (await page.request.get(imported.path)).json()).revision.id).toBe(imported.revision.id);
  await assets(page);
  await expect(page.getByText('notes', { exact: true }).first()).toBeVisible();
  await screenshot(page, info, 'discard-restores-assets');
});

test('New and Fork with uploads create nothing until Save', async ({ page }, info) => {
  const imported = await importCard(page, 'Fork source');
  const workspacePath = `/api/workspaces/${imported.card.workspaceId}`;
  const count = async () => ((await (await page.request.get(`${workspacePath}/cards`)).json()).cards as unknown[]).length;
  const initialCount = await count();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('link', { name: 'Fork', exact: true }).click();
  await expect(page.getByText('Fork — not in the library until you save', { exact: true })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Saved fork');
  await page.getByLabel('Choose portrait', { exact: true }).setInputFiles({ name: 'fork.gif', mimeType: 'image/gif', buffer: gif });
  expect(await count()).toBe(initialCount);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(/\/card\/[^/]+\/edit$/);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect(await count()).toBe(initialCount + 1);
  const forkId = page.url().split('/').at(-2)!;
  const fork = await (await page.request.get(`${workspacePath}/cards/${forkId}`)).json();
  expect(fork.card.forkedFromRevisionId).toBe(imported.revision.id);
  expect(fork.revision.sequence).toBe(1);
  expect(await (await page.request.get(`${workspacePath}/cards/${forkId}/asset?revisionId=${fork.revision.id}&path=portrait`)).body()).toEqual(gif);
  expect((await (await page.request.get(imported.path)).json()).revision.id).toBe(imported.revision.id);
  await page.getByTitle('Create a new card in the editor').click();
  await expect(page.getByText('New card — not in the library until you save', { exact: true })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Saved new card');
  await page.getByLabel('Choose portrait', { exact: true }).setInputFiles({ name: 'new.gif', mimeType: 'image/gif', buffer: gif });
  expect(await count()).toBe(initialCount + 1);
  await screenshot(page, info, 'new-card-pending-portrait');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(/\/card\/[^/]+\/edit$/);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect(await count()).toBe(initialCount + 2);
});

test('mobile editor keeps assets and Save accessible', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await importCard(page, 'Mobile asset card');
  await screenshot(page, info, 'mobile-editor-initial');
  await assets(page);
  await expect(page.getByText('notes', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeInViewport();
  await screenshot(page, info, 'mobile-assets');
  await page.getByTitle('List view', { exact: true }).click();
  await page.getByRole('button', { name: 'Select asset notes', exact: true }).click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download Asset', exact: true }).click();
  expect(await readFile((await (await downloaded).path())!)).toEqual(notes);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeInViewport();
  await screenshot(page, info, 'mobile-asset-details');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'No page-level horizontal overflow').toBe(true);
});

test('New and Fork retain changes made while their first Save is in flight', async ({ page }, info) => {
  const source = await importCard(page, 'First-save race source');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  for (const mode of ['new', 'fork'] as const) {
    if (mode === 'new') await page.getByTitle('Create a new card in the editor').click();
    else {
      await page.goto(`/card/${source.card.id}`);
      await page.getByRole('link', { name: 'Fork', exact: true }).click();
    }
    await page.getByLabel('Name', { exact: true }).fill(`Delayed first Save ${mode}`);
    await page.getByLabel('Choose portrait', { exact: true }).setInputFiles({ name: 'first.gif', mimeType: 'image/gif', buffer: gif });
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pattern = mode === 'new' ? '**/api/workspaces/*/cards' : `**/cards/${source.card.id}/fork-assets`;
    await page.route(pattern, async (route) => {
      if (route.request().method() === 'POST') { entered(); await held; }
      await route.continue();
    });
    const description = `Description typed during the ${mode} first Save`;
    const lateBytes = Buffer.from(`Late ${mode} attachment\n`);
    try {
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await started;
      await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
      await page.getByRole('button', { name: 'Character', exact: true }).click();
      await page.getByLabel('Description', { exact: true }).fill(description);
      await assets(page);
      await page.getByRole('button', { name: 'Upload Asset', exact: true }).click();
      await page.getByLabel('Attachment type', { exact: true }).selectOption('custom');
      await page.getByLabel('Attachment name', { exact: true }).fill(`late ${mode}`);
      await page.getByLabel('Add attachment', { exact: true }).setInputFiles({ name: 'late.txt', mimeType: 'text/plain', buffer: lateBytes });
      await expect(page.getByText(`late ${mode}`, { exact: true }).first()).toBeVisible();
      release();
      await expect(page).toHaveURL(/\/card\/[^/]+\/edit$/);
    } finally { release(); await page.unroute(pattern); }
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('button', { name: 'Character', exact: true }).click();
    await expect(page.getByLabel('Description', { exact: true })).toHaveValue(description);
    await assets(page);
    await expect(page.getByText(`late ${mode}`, { exact: true }).first()).toBeVisible();
    await screenshot(page, info, `${mode}-first-save-retains-newer-draft`);
    const id = page.url().split('/').at(-2)!;
    const path = `/api/workspaces/${source.card.workspaceId}/cards/${id}`;
    const firstSaved = await (await page.request.get(path)).json();
    expect(firstSaved.revision.sequence).toBe(1);
    expect(firstSaved.revision.document.data.description).not.toBe(description);
    await save(page);
    await page.reload();
    await page.getByRole('button', { name: 'Character', exact: true }).click();
    await expect(page.getByLabel('Description', { exact: true })).toHaveValue(description);
    await assets(page);
    await expect(page.getByText(`late ${mode}`, { exact: true }).first()).toBeVisible();
    const secondSaved = await (await page.request.get(path)).json();
    expect(secondSaved.revision.sequence).toBe(2);
    const index = secondSaved.revision.document.data.assets.findIndex((asset: { name: string }) => asset.name === `late ${mode}`);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(await (await page.request.get(`${path}/asset?revisionId=${secondSaved.revision.id}&path=declared/${index}`)).body()).toEqual(lateBytes);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
  }
});

test('initial editor and fork reads show recoverable errors without leaving a loading screen', async ({ page, diagnostics }, info) => {
  diagnostics.expectedStatuses.add(404);
  for (const mode of ['edit', 'fork']) {
    await page.goto(`/card/00000000-0000-4000-8000-000000000999/${mode}`);
    await expect(page.getByRole('alert')).toContainText(/not found|could not be opened/i);
    await expect(page.getByText('Loading card…', { exact: true })).toHaveCount(0);
    await expect(page.getByTitle('Import card files')).toBeVisible();
  }
  const imported = await importCard(page, 'Initial GET failure');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  const pattern = `**/api/workspaces/*/cards/${imported.card.id}`;
  diagnostics.expectedStatuses.add(503);
  await page.route(pattern, (route) => route.fulfill({ status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Test card temporarily unavailable' } }) }));
  for (const mode of ['edit', 'fork']) {
    await page.goto(`/card/${imported.card.id}/${mode}`);
    await expect(page.getByRole('alert')).toContainText('Test card temporarily unavailable');
    await expect(page.getByText('Loading card…', { exact: true })).toHaveCount(0);
    await screenshot(page, info, `initial-${mode}-read-failure`);
  }
  await page.unroute(pattern);
  await page.reload();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Initial GET failure');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('history restore locks editing until its saved document and portrait are installed', async ({ page }, info) => {
  const imported = await importCard(page, 'Native history restore');
  await page.getByLabel('Name', { exact: true }).fill('Second saved revision');
  await page.getByLabel('Choose portrait', { exact: true }).setInputFiles({ name: 'second.gif', mimeType: 'image/gif', buffer: gif });
  await save(page);
  await page.getByLabel('Name', { exact: true }).fill('Unsaved changes to discard on restore');
  await page.getByRole('button', { name: 'Diff', exact: true }).click();
  const first = page.locator('.card').filter({ has: page.getByText('Version 1', { exact: true }) });
  await expect(first).toHaveCount(1);
  let release!: () => void;
  let entered!: () => void;
  let finished!: () => void;
  let intercepted = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const completed = new Promise<void>((resolve) => { finished = resolve; });
  const pattern = `**/cards/${imported.card.id}/restores`;
  await page.route(pattern, async (route) => {
    intercepted = true; entered();
    try { await held; await route.continue(); }
    finally { finished(); }
  });
  const restoredResponse = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith(`/cards/${imported.card.id}/restores`));
  try {
    page.once('dialog', (dialog) => dialog.accept());
    await first.getByRole('button', { name: 'Restore', exact: true }).click();
    await started;
    await expect(page.getByText('Restoring saved revision…', { exact: true })).toBeVisible();
    await expect(page.locator('.architect-root [inert]')).toHaveCount(1);
    for (const name of ['Save', 'Done', 'Discard changes']) await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Compare', exact: true }).first().click({ timeout: 300 })).rejects.toThrow(/Timeout/);
    await page.keyboard.press('Control+s');
    expect((await (await page.request.get(imported.path)).json()).revision.sequence).toBe(2);
    await screenshot(page, info, 'history-restore-pending');
    release();
    const restored = await restoredResponse;
    expect(restored.ok(), await restored.text()).toBe(true);
    await expect(page.locator('.architect-root [inert]')).toHaveCount(0);
  } finally { release(); if (intercepted) await completed; await page.unroute(pattern); }
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Native history restore');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  const restored = await (await page.request.get(imported.path)).json();
  expect(restored.revision.sequence).toBe(3);
  expect(restored.revision.assets).toEqual(imported.revision.assets);
  expect(await (await page.request.get(`${imported.path}/asset?revisionId=${restored.revision.id}&path=portrait`)).body()).toEqual(png);
  await screenshot(page, info, 'history-restored-original');
  await page.getByLabel('Name', { exact: true }).fill('Edited after history restore');
  await page.getByLabel('Choose portrait', { exact: true }).setInputFiles({ name: 'fourth.gif', mimeType: 'image/gif', buffer: gif });
  await save(page);
  await page.reload();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Edited after history restore');
  const saved = await (await page.request.get(imported.path)).json();
  expect(saved.revision.sequence).toBe(4);
  expect(await (await page.request.get(`${imported.path}/asset?revisionId=${saved.revision.id}&path=portrait`)).body()).toEqual(gif);
  expect(await (await page.request.get(`${imported.path}/original`)).body()).toEqual(imported.bytes);
});
