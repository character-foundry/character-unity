import { createRequire } from 'node:module';
import type { Locator, Response } from '@playwright/test';
import { document, expect, screenshot, test, type Imported } from './fixtures.js';
import { viewerFixture } from './viewer-fixtures.js';

const foundry = createRequire(new URL('../../packages/cards/package.json', import.meta.url));
// A real, silent 40ms PCM WAV and a tiny VP8 WebM, not placeholder media responses.
function silentWav() {
  const bytes = Buffer.alloc(44 + 640);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(640, 40);
  return bytes;
}
const webm = Buffer.from('GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwH/////////EU2bdKtNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHNTbuMU6uEElTDZ1OsggET7AEAAAAAAABoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmpyrXsYMPQkBNgI1MYXZmNjAuMTYuMTAwV0GNTGF2ZjYwLjE2LjEwMBZUrmvBrgEAAAAAAAA414EBc8WINZ2vym8cuX+cgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QCYloA4ImwgRC6gRCagQISVMNn2HNzoGPAgGfImkWjh0VOQ09ERVJEh41MYXZmNjAuMTYuMTAwc3OyY8CLY8WINZ2vym8cuX9nyKFFo4dFTkNPREVSRIeUTGF2YzYwLjMxLjEwMiBsaWJ2cHgfQ7Z1wueBAKOjgQAAgBACAJ0BKhAAEAAARwiFhYiZhIgCAgAMDWAA/v+rUICjmIEAKACxAQAFEKwAGAAwP/QMAAAA/va5AA==', 'base64');

async function displayedMediaBytes(media: Locator) {
  await expect(media).toHaveAttribute('src', /^blob:/);
  // Chromium can omit the consumed HTTP body from its debugger response cache;
  // inspect the actual preview blob instead, after the user's real Load action.
  const bytes = await media.evaluate(async (element) => Array.from(new Uint8Array(await (await fetch((element as HTMLMediaElement).src)).arrayBuffer())));
  return Buffer.from(bytes);
}

test('offscreen native portraits acquire no bytes until scrolled near the viewport', async ({ page }, info) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  const imported: Promise<Imported>[] = [];
  const capture = (response: Response) => {
    if (response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/imports')) imported.push(response.json() as Promise<Imported>);
  };
  page.on('response', capture);
  const chooser = page.waitForEvent('filechooser');
  await page.getByTitle('Import card files').click();
  await (await chooser).setFiles(await Promise.all(Array.from({ length: 12 }, async (_, index) => {
    const name = `Lazy portrait QA ${String(index).padStart(2, '0')}`;
    return { name: `${name}.png`, mimeType: 'image/png', buffer: await viewerFixture(name, 'png') };
  })));
  await expect(page.getByRole('status').filter({ hasText: 'Imported 12 cards.' })).toBeVisible();
  page.off('response', capture);
  const records = await Promise.all(imported);
  expect(records).toHaveLength(12);
  const last = records.find((record) => record.revision.document.data && (record.revision.document.data as { name?: string }).name === 'Lazy portrait QA 11')!;
  // The final import is legitimately visible in the old newest-first grid.
  // Dispose that document before observing the fresh name-sorted viewport;
  // its trailing portrait acquisition is not an offscreen read in this view.
  await page.goto('about:blank');
  const requests: { id: string; actor: string | undefined }[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url()), match = /\/cards\/([^/]+)\/asset$/.exec(url.pathname);
    if (match && url.searchParams.get('path') === 'portrait') requests.push({ id: match[1]!, actor: request.headers()['x-unity-actor'] });
  });
  await page.goto(`/?${new URLSearchParams({ search: 'name:"Lazy portrait QA"', sort: 'name' })}`);
  const firstTile = page.locator('article').filter({ has: page.getByRole('button', { name: 'Quick view Lazy portrait QA 00', exact: true }) });
  const lastTile = page.locator('article').filter({ has: page.getByRole('button', { name: 'Quick view Lazy portrait QA 11', exact: true }) });
  await expect(firstTile.locator('img')).toHaveJSProperty('naturalWidth', 1);
  expect((await lastTile.boundingBox())!.y).toBeGreaterThan(page.viewportSize()!.height + 200);
  expect(requests.some((request) => request.id === last.card.id), 'A below-margin portrait must not acquire stored bytes').toBe(false);
  await screenshot(page, info, 'native-lazy-portraits-initial-mobile');
  await page.mouse.wheel(0, 2000);
  await expect(lastTile.locator('img')).toHaveJSProperty('naturalWidth', 1);
  expect(requests.some((request) => request.id === last.card.id)).toBe(true);
  expect(requests.every((request) => request.actor === last.revision.authorId), 'Every fetched portrait carries its captured actor proof').toBe(true);
  await screenshot(page, info, 'native-lazy-portraits-after-user-scroll');
});

test('native audio and video previews fetch exact stored bytes only after explicit Load controls', async ({ page }, info) => {
  const wav = silentWav(), card = document('Explicit media QA');
  const wrapped = { ...card, data: { ...card.data, assets: [
    { type: 'custom', uri: 'embeded://other/silence.wav', name: 'silence', ext: 'wav' },
    { type: 'custom', uri: 'embeded://other/clip.webm', name: 'clip', ext: 'webm' },
  ] } };
  const { writeCharX } = foundry('@character-foundry/character-foundry/charx');
  const bytes = Buffer.from(writeCharX(wrapped, [
    { type: 'custom', name: 'silence', ext: 'wav', data: wav },
    { type: 'custom', name: 'clip', ext: 'webm', data: webm },
  ], { preserveDescriptors: true }).buffer);
  await page.goto('/');
  const importing = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/imports') && response.request().method() === 'POST');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTitle('Import card files').click();
  await (await chooser).setFiles({ name: 'explicit-media.charx', mimeType: 'application/zip', buffer: bytes });
  const accepted = await importing;
  expect(accepted.ok(), await accepted.text()).toBe(true);
  const imported: Imported = await accepted.json();
  const media: string[] = [];
  page.on('request', (request) => { const url = new URL(request.url()); if (url.pathname.endsWith(`/cards/${imported.card.id}/asset`)) media.push(url.searchParams.get('path') ?? ''); });
  await page.getByRole('button', { name: 'Quick view Explicit media QA', exact: true }).click();
  await page.getByRole('link', { name: 'View Full Profile', exact: true }).click();
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Load audio preview', exact: true })).toBeVisible();
  expect(media).toEqual([]);
  const audioRead = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith(`/cards/${imported.card.id}/asset`) && new URL(response.url()).searchParams.get('path') === 'declared/0');
  await page.getByRole('button', { name: 'Load audio preview', exact: true }).click();
  const audio = await audioRead;
  expect(audio.status()).toBe(200);
  expect(audio.headers()['content-length']).toBe(String(wav.length));
  expect(audio.request().headers()['x-unity-actor']).toBe(imported.revision.authorId);
  expect(await displayedMediaBytes(page.locator('audio')), 'The actual audio preview blob has every accepted WAV byte').toEqual(wav);
  await page.getByRole('button', { name: 'clip', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Load video preview', exact: true })).toBeVisible();
  expect(media).toEqual(['declared/0']);
  const videoRead = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith(`/cards/${imported.card.id}/asset`) && new URL(response.url()).searchParams.get('path') === 'declared/1');
  await page.getByRole('button', { name: 'Load video preview', exact: true }).click();
  const video = await videoRead;
  expect(video.status()).toBe(200);
  expect(video.headers()['content-length']).toBe(String(webm.length));
  expect(video.request().headers()['x-unity-actor']).toBe(imported.revision.authorId);
  expect(await displayedMediaBytes(page.locator('video')), 'The actual video preview blob has every accepted WebM byte').toEqual(webm);
  expect(media).toEqual(['declared/0', 'declared/1']);
  await screenshot(page, info, 'native-explicit-video-preview-loaded');
});
