import { createRequire } from 'node:module';
import { document, expect, png, screenshot, test, type Imported } from './fixtures.js';

const foundry = createRequire(new URL('../../packages/cards/package.json', import.meta.url));

test('editor previews resolve stored images without remote, cookie-only API or CSS loads and preserve authored sources', async ({ page, diagnostics }, info) => {
  const name = 'Authored editor media boundary';
  const remote = 'https://authored-media.invalid/track.png';
  const unscoped = '/api/unscoped-authored-image';
  const css = 'https://authored-media.invalid/style-track.png';
  const responsive = 'https://authored-media.invalid/srcset-track.png';
  // Foundry writes this logical image to its canonical CharX member path.
  // The authored identifier must name that actual sealed binding, not a
  // different URI that merely resembles the exported filename.
  const uri = 'embeded://assets/image/images/stored.png';
  const description = `![Stored image](${uri})\n\n![Stored portrait](ccdefault:)\n\n![Remote image](${remote})\n\n<img src="${unscoped}" srcset="${responsive} 2x" alt="Unscoped image"><div style="background-image:url(${css})">Untrusted style</div>`;
  const creatorNotes = `<h2>Safe authored notes</h2><img src="${uri}" alt="Stored HTML image"><img src="${remote}" alt="Remote HTML image"><img src="${unscoped}" srcset="${responsive} 2x" alt="Unscoped HTML image"><div class="untrusted-image-class" style="background-image:url(${css})">Untrusted HTML style</div>`;
  const input = document(name);
  const card = { ...input, data: { ...input.data, description, creator_notes: creatorNotes, assets: [
    { type: 'icon', name: 'main', ext: 'png', uri: 'ccdefault:' }, { type: 'image', name: 'stored', ext: 'png', uri },
  ] } };
  const { writeCharX } = foundry('@character-foundry/character-foundry/charx');
  const bytes = Buffer.from(writeCharX(card, [{ type: 'icon', name: 'main', ext: 'png', data: png, isMain: true },
    { type: 'image', name: 'stored', ext: 'png', data: png }], { preserveDescriptors: true }).buffer);
  const forbidden: string[] = [], unpinned: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.url().startsWith('https://authored-media.invalid/') || path === unscoped) forbidden.push(request.url());
    if (path.startsWith('/api/workspaces/') && !request.headers()['x-unity-actor']) unpinned.push(`${request.method()} ${path}`);
  });
  await page.route('https://authored-media.invalid/**', (route) => route.abort());
  await page.route(`**${unscoped}`, (route) => route.abort());
  await page.goto('/');
  const importing = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/imports') && response.request().method() === 'POST');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTitle('Import card files').click();
  await (await chooser).setFiles({ name: 'authored-media.charx', mimeType: 'application/zip', buffer: bytes });
  const accepted = await importing;
  expect(accepted.ok(), await accepted.text()).toBe(true);
  const imported: Imported = await accepted.json();
  expect((imported.revision.document.data as { assets: { uri: string }[] }).assets[1]!.uri).toBe(uri);
  const reads: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith(`/cards/${imported.card.id}/asset`)) reads.push(request.headers()['x-unity-actor'] ?? 'missing');
  });
  await page.getByRole('button', { name: `Quick view ${name}`, exact: true }).click();
  await page.getByRole('link', { name: 'View Full Profile', exact: true }).click();
  const nativeNotes = page.locator('[data-section="notes"]');
  await nativeNotes.getByRole('heading', { name: 'Safe authored notes', exact: true }).scrollIntoViewIfNeeded();
  await expect(nativeNotes.getByAltText('Stored HTML image', { exact: true })).toHaveAttribute('src', /^blob:/);
  await expect(nativeNotes.getByAltText('Stored HTML image', { exact: true })).toHaveJSProperty('naturalWidth', 1);
  await expect(nativeNotes.getByText('[Image not stored: Remote HTML image]', { exact: true })).toBeVisible();
  await expect(nativeNotes.getByText('[Image not stored: Unscoped HTML image]', { exact: true })).toBeVisible();
  expect(await nativeNotes.evaluate((element) => !element.querySelector('[style], [srcset], .untrusted-image-class'))).toBe(true);
  expect(forbidden).toEqual([]); expect(unpinned).toEqual([]);
  await screenshot(page, info, 'authored-native-viewer-html-stored-images-only');
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(name);
  const editorRoot = await page.locator('.architect-root').elementHandle();
  const draftName = `${name} unsaved recovery draft`;
  await page.getByLabel('Name', { exact: true }).fill(draftName);
  // The local runtime renews its connection active→active after this one 401.
  // The renewed snapshot must restart captured authored image reads in place.
  diagnostics.expectedStatuses.add(401);
  let rejectedImage = false, renewals = 0;
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/local-session') renewals++; });
  await page.route(`**/cards/${imported.card.id}/asset?**`, async (route) => {
    if (!rejectedImage && new URL(route.request().url()).searchParams.get('path') === 'declared/1') {
      rejectedImage = true;
      await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Local media session expired once' } }) });
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByAltText('Stored image')).toHaveAttribute('src', /^blob:/);
  await expect(page.getByAltText('Stored image')).toHaveJSProperty('naturalWidth', 1);
  await expect(page.getByAltText('Stored portrait')).toHaveAttribute('src', /^blob:/);
  await expect(page.getByAltText('Stored portrait')).toHaveJSProperty('naturalWidth', 1);
  expect(rejectedImage).toBe(true); expect(renewals).toBeGreaterThan(0);
  expect(await editorRoot!.evaluate((element) => element.isConnected), 'Automatic reconnect preserves the mounted editor').toBe(true);
  await expect(page.getByText('[Image not stored: Remote image]', { exact: true })).toBeVisible();
  await expect(page.getByText('[Image not stored: Unscoped image]', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Focused', exact: true }).click();
  await expect(page.locator('.milkdown img[src^="blob:"]').first()).toHaveJSProperty('naturalWidth', 1);
  await expect(page.locator('.milkdown')).toContainText('Untrusted style');
  await expect(page.getByRole('status').filter({ hasText: 'External images are not loaded' })).toBeVisible();
  await page.getByTitle('Show raw markdown', { exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText(uri);
  await expect(page.locator('.cm-content')).toContainText(remote);
  await expect(page.locator('.cm-content')).toContainText('ccdefault:');
  await screenshot(page, info, 'authored-focused-markdown-stored-images-only');

  // Enable HTML mode through its actual module settings, not a test-only store mutation.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Editors', exact: true }).click();
  await settings.getByRole('tab', { name: 'Focused', exact: true }).click();
  await settings.getByLabel('HTML Mode', { exact: true }).check();
  await settings.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.getByRole('button', { name: /^Creator Notes(?:\s+HTML)?$/ }).click();
  await expect(page.getByText('HTML Preview', { exact: true })).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText(uri);
  await expect(page.locator('.cm-content')).toContainText('srcset=');
  await expect(page.locator('.cm-content')).toContainText(css);
  await expect(page.getByAltText('Stored HTML image', { exact: true })).toHaveAttribute('src', /^blob:/);
  await expect(page.getByAltText('Stored HTML image', { exact: true })).toHaveJSProperty('naturalWidth', 1);
  await expect(page.getByText('[Image not stored: Remote HTML image]', { exact: true })).toBeVisible();
  await expect(page.getByText('[Image not stored: Unscoped HTML image]', { exact: true })).toBeVisible();
  expect(await page.locator('.architect-root .prose').evaluateAll((elements) => elements.every((element) =>
    !element.querySelector('[style], [srcset], .untrusted-image-class')))).toBe(true);
  await screenshot(page, info, 'authored-focused-html-inert-sanitized-preview');

  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  expect(forbidden).toEqual([]);
  expect(unpinned, 'No cookie-only business or image requests').toEqual([]);
  expect(reads.length).toBeGreaterThan(0);
  expect(reads.every((actor) => actor === imported.revision.authorId)).toBe(true);
  const base = `/api/workspaces/${imported.card.workspaceId}/cards/${imported.card.id}`;
  const headers = { 'x-unity-actor': imported.revision.authorId };
  const original = await page.request.get(`${base}/original`, { headers });
  expect(await original.body()).toEqual(bytes);
  const reopened = await page.request.get(base, { headers });
  const saved = await reopened.json();
  expect(saved.revision.document.data.description).toBe(description);
  expect(saved.revision.document.data.creator_notes).toBe(creatorNotes);
  expect(saved.revision.id).toBe(imported.revision.id);
  // A display-only round trip through the raw field does not rewrite source URIs.
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(draftName);
  await page.getByRole('button', { name: 'Character', exact: true }).click();
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue(description);
  await screenshot(page, info, 'authored-images-resolve-without-unsolicited-loads');
  await info.attach('authored-image-network-audit', { body: JSON.stringify({ forbidden, unpinned, actors: reads, rejectedImage, renewals }, null, 2), contentType: 'application/json' });
});
