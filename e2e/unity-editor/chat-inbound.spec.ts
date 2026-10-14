import { createServer } from 'node:http';
import { once } from 'node:events';
import { test, expect, screenshot } from './fixtures.js';
import { importViewerCard } from './viewer-fixtures.js';

/** A separate app at a real loopback HTTP origin. Unity uses its shipped ST
 * adapter, CSRF handshake, upload, scan, review and accept routes unchanged. */
async function chatApp() {
  const files = new Map<string, { data: Record<string, unknown>; [key: string]: unknown }>();
  const server = createServer(async (request, response) => {
    try {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/csrf-token') { response.setHeader('set-cookie', 'st=fixture; Path=/; HttpOnly'); response.end(JSON.stringify({ token: 'fixture' })); return; }
      if (request.headers['x-csrf-token'] !== 'fixture' || request.headers.cookie !== 'st=fixture') { response.writeHead(403); response.end('{}'); return; }
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      if (request.url === '/api/characters/import') {
        const headers = new Headers(); for (const [key, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(key, value);
        const incoming = new Request('http://chat.invalid/import', { method: 'POST', headers, body: new Blob([bytes]) });
        const form = await incoming.formData(), file = form.get('avatar') as File;
        const card = JSON.parse(await file.text()) as { data: Record<string, unknown> };
        const name = String(form.get('preserved_name')); files.set(`${name}.png`, card);
        response.end(JSON.stringify({ file_name: name })); return;
      }
      if (request.url === '/api/characters/all') {
        response.end(JSON.stringify([...files].map(([avatar, card]) => ({ avatar, name: card.data.name, data: card.data })))); return;
      }
      if (request.url === '/api/characters/export') {
        const body = JSON.parse(bytes.toString()) as { avatar_url: string };
        const card = files.get(body.avatar_url);
        if (!card) response.writeHead(404);
        response.end(JSON.stringify(card ?? {}, null, 4)); return;
      }
      response.writeHead(404); response.end('{}');
    } catch { response.writeHead(500); response.end('{}'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  return { origin: `http://127.0.0.1:${address.port}`, files, async close() { await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

test('reviews remote text on desktop/mobile, rejects a stale snapshot, then creates a private fork', async ({ page, diagnostics }, info) => {
  const app = await chatApp(); let targetId: string | undefined;
  const imported = await importViewerCard(page, 'Inbound chat browser QA', 'json');
  const headers = { origin: new URL(page.url()).origin, 'x-unity-actor': imported.revision.authorId };
  const targetPath = `/api/workspaces/${imported.card.workspaceId}/chat/targets`;
  try {
    const added = await page.request.post(targetPath, { headers, data: { kind: 'sillytavern', name: 'Inbound Test Chat', baseUrl: app.origin, credentials: {} } });
    expect(added.ok(), await added.text()).toBe(true); targetId = (await added.json() as { id: string }).id;
    await page.goto(`/card/${imported.card.id}`);
    const panel = page.locator('[data-where-it-lives]');
    await panel.getByRole('button', { name: 'Send to Inbound Test Chat', exact: true }).click();
    await expect(panel.getByText('Current', { exact: true })).toBeVisible();
    const remote = [...app.files.values()][0]!;
    remote.data.description = 'Edited in the chat app, with its source lorebook and opaque fields kept intact.';
    await panel.getByRole('button', { name: 'Check now', exact: true }).click();
    await expect(panel.getByText('Edited there', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Review text edits', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Review chat text edits', exact: true });
    await expect(dialog).toBeVisible(); await expect(dialog.getByText('Original portrait and asset bytes', { exact: true })).toBeVisible();
    await expect(dialog.getByText(String(remote.data.description), { exact: true })).toBeVisible();
    await expect(dialog.getByText('Import the changes below', { exact: false })).toBeVisible();
    await screenshot(page, info, 'chat-inbound-review-desktop');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await panel.getByRole('button', { name: 'Review text edits', exact: true }).click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
    await panel.getByRole('button', { name: 'Review text edits', exact: true }).click();
    await expect(dialog).toBeVisible();
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(dialog.getByRole('button', { name: 'Import as private fork', exact: true })).toBeVisible();
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await screenshot(page, info, 'chat-inbound-review-mobile');

    diagnostics.expectedStatuses.add(409);
    remote.data.description = 'A newer remote draft, not the reviewed bytes.';
    await dialog.getByRole('button', { name: 'Import as private fork', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('changed after review');
    await expect(dialog).toBeVisible();
    await screenshot(page, info, 'chat-inbound-stale-review-mobile');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await panel.getByRole('button', { name: 'Review text edits', exact: true }).click();
    await expect(dialog.getByText(String(remote.data.description), { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Import as private fork', exact: true }).click();
    await expect(page).not.toHaveURL(new RegExp(`/card/${imported.card.id}$`));
    await expect(dialog).not.toBeVisible();
    const forkId = new URL(page.url()).pathname.split('/').at(-1)!;
    const forkResponse = await page.request.get(`/api/workspaces/${imported.card.workspaceId}/cards/${forkId}`, { headers });
    expect(forkResponse.ok(), await forkResponse.text()).toBe(true);
    const fork = await forkResponse.json() as { revision: { document: { data: Record<string, unknown> } } };
    expect(fork.revision.document.data.description).toBe(remote.data.description);
    const original = await page.request.get(imported.path, { headers });
    expect((await original.json() as { revision: { id: string } }).revision.id).toBe(imported.revision.id);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: 'Character Card', exact: true }).click();
    await expect(page.locator('[data-card-section="character"]')).toContainText(String(remote.data.description));
    await screenshot(page, info, 'chat-inbound-private-fork-result');
  } finally {
    if (targetId) expect((await page.request.delete(`${targetPath}/${targetId}`, { headers })).ok()).toBe(true);
    await app.close();
  }
});
