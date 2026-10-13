import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { expect, test as base, type Page, type TestInfo } from '@playwright/test';
import type { Card, Revision } from '../../packages/store/src/types.js';

// Resolve Foundry from its actual consumer, without introducing a second SDK dependency.
const foundry = createRequire(new URL('../../packages/cards/package.json', import.meta.url));
export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
export const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
export const notes = Buffer.from('Original attachment: αβ\nkeep every byte\n');
export const moduleRisum = Buffer.from([82, 73, 83, 85, 1, 2, 250, 251]);
export const opaque = { array: [null, false, 0, 'unchanged'], nested: { preserve: 'envelope' } };

export interface Imported { card: Card; revision: Revision }
interface Parsed {
  originalShape: { vendor_envelope: unknown; data: { name: string; extensions: { vendor: unknown }; assets?: { name: string; [key: string]: unknown }[] } };
  assets: { name: string; data: Uint8Array; type: string; isMain?: boolean }[];
  metadata?: { moduleRisum?: Uint8Array };
}

export function document(name: string) {
  return { spec: 'chara_card_v3', spec_version: '3.0', vendor_envelope: opaque, data: {
    name, description: 'Original description', personality: '', scenario: '', first_mes: 'Hello', mes_example: '',
    creator: 'Unity browser QA', creator_notes: '', character_version: '1.0', tags: ['browser-regression'],
    system_prompt: '', post_history_instructions: '', alternate_greetings: [], group_only_greetings: [],
    extensions: { vendor: { keep: [null, 'opaque extension', { deep: true }] } },
  } };
}

export async function fixture(name: string, format: 'json' | 'png' | 'charx') {
  const card = document(name);
  if (format === 'json') return Buffer.from(JSON.stringify(card));
  const assets = [{ type: 'icon', uri: 'ccdefault:', name: 'main', ext: 'png', vendor_asset: { preserve: true } }];
  const wrapped = { ...card, data: { ...card.data, assets } };
  if (format === 'png') {
    const { embedIntoPNG } = foundry('@character-foundry/character-foundry/png');
    return Buffer.from(embedIntoPNG(png, wrapped, { key: 'ccv3' }));
  }
  assets.push({ type: 'custom', uri: 'embeded://other/notes.txt', name: 'notes', ext: 'txt', vendor_asset: { preserve: true } });
  const { writeCharX } = foundry('@character-foundry/character-foundry/charx');
  return Buffer.from(writeCharX(wrapped, [
    { type: 'icon', name: 'main', ext: 'png', data: png, isMain: true },
    { type: 'custom', name: 'notes', ext: 'txt', data: notes },
  ], { preserveDescriptors: true, moduleRisum }).buffer);
}

export async function parse(bytes: Buffer): Promise<Parsed> {
  const { parseCard } = foundry('@character-foundry/character-foundry/loader');
  return parseCard(bytes, { extractAssets: true });
}

export async function importCard(page: Page, name: string, format: 'json' | 'png' | 'charx' = 'charx') {
  await page.goto('/');
  await expect(page.getByTitle('Import card files')).toBeVisible();
  const bytes = await fixture(name, format);
  const response = page.waitForResponse((response) => response.url().endsWith('/imports') && response.request().method() === 'POST');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTitle('Import card files').click();
  await (await chooser).setFiles({ name: `${name}.${format}`, mimeType: 'application/octet-stream', buffer: bytes });
  const received = await response;
  expect(received.status(), await received.text()).toBe(201);
  const imported: Imported = await received.json();
  await expect(page.getByRole('status')).toContainText('Imported 1 card');
  await page.getByText(name, { exact: true }).first().click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(name);
  return { ...imported, bytes, path: `/api/workspaces/${imported.card.workspaceId}/cards/${imported.card.id}` };
}

export async function save(page: Page) {
  const response = page.waitForResponse((response) => /\/(?:asset-)?revisions$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const received = await response;
  expect(received.ok(), await received.text()).toBe(true);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
}

export async function assets(page: Page) {
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Upload Asset', exact: true })).toBeVisible();
}

export async function download(page: Page, button: string) {
  const event = page.waitForEvent('download', { timeout: 10_000 });
  await page.getByRole('button', { name: button, exact: true }).click();
  return readFile((await (await event).path())!);
}

export async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: false });
  await info.attach(name, { path, contentType: 'image/png' });
}

interface Diagnostics { errors: string[]; console: string[]; network: string[]; expectedStatuses: Set<number>; expectedConsole: string[] }
export const test = base.extend<{ diagnostics: Diagnostics }>({
  diagnostics: [async ({ page }, use, info) => {
    const diagnostics: Diagnostics = { errors: [], console: [], network: [], expectedStatuses: new Set(), expectedConsole: [] };
    page.on('pageerror', (error) => diagnostics.errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') diagnostics.console.push(message.text()); });
    page.on('response', (response) => {
      if (response.status() >= 400 && new URL(response.url()).pathname.startsWith('/api/') && !diagnostics.expectedStatuses.has(response.status())) {
        diagnostics.network.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
      }
    });
    await use(diagnostics);
    await info.attach('browser-diagnostics', { body: JSON.stringify(diagnostics, (_key, value) => value instanceof Set ? [...value] : value, 2), contentType: 'application/json' });
    expect(diagnostics.errors, 'Uncaught browser errors').toEqual([]);
    expect(diagnostics.network, 'Unexpected API failures').toEqual([]);
    const unexpected = diagnostics.console.filter((message) => ![...diagnostics.expectedStatuses].some((status) => message.includes(`${status} (`))
      && !diagnostics.expectedConsole.some((prefix) => message.startsWith(prefix)));
    expect(unexpected, 'Unexpected console errors').toEqual([]);
  }, { auto: true }],
});
export { expect };
