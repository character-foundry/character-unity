import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';
import { document, expect, moduleRisum, notes, png, type Imported } from './fixtures.js';

const foundry = createRequire(new URL('../../packages/cards/package.json', import.meta.url));
export const remoteAsset = 'https://viewer-qa.invalid/must-not-fetch.png';
export const creator = 'Native Viewer QA';
export const tag = 'native-viewer';
export const descriptionEnd = 'END OF LONG NATIVE DESCRIPTION';
export const greetingEnd = 'END OF LONG NATIVE GREETING';

export function viewerDocument(name: string, options: { long?: boolean } = {}) {
  const original = document(name);
  const descriptionTail = options.long ? `\n${'A long forest journal line.\n'.repeat(310)}${descriptionEnd}` : '';
  const greetingTail = options.long ? `\n${'A long lantern greeting line.\n'.repeat(310)}${greetingEnd}` : '';
  return { ...original, data: { ...original.data,
    creator, tags: [tag, 'quiet forest'],
    description: `A keeper of the quiet forest.\nEvery visitor gets a different story.${descriptionTail}`,
    personality: 'Patient, curious, and meticulous.', scenario: 'A lantern-lit clearing after the rain.',
    first_mes: 'Welcome to the quiet forest.', alternate_greetings: [`The lantern is still burning.${greetingTail}`, 'You found the hidden path.'],
    group_only_greetings: ['There is room for every traveler.'],
    mes_example: '{{user}}: Is this the right way?\n{{char}}: There is more than one right way.',
    creator_notes: `# Field notes\nA native reader preserves **these notes**.\n![Remote image](${remoteAsset})\n<img src="${remoteAsset}" onerror="window.__viewerUnsafe=true">`,
    system_prompt: 'Stay in character and remember the forest.', post_history_instructions: 'Leave a lantern for the next traveler.',
    character_book: { name: 'Forest atlas', description: 'Places and keepsakes', scan_depth: 4, token_budget: 700, recursive_scanning: true,
      extensions: { opaque_book: true }, entries: [
        { id: 1, keys: ['lantern'], secondary_keys: ['light'], content: 'The lantern remembers the road.', enabled: true, insertion_order: 10, name: 'The lantern', comment: 'A recurring motif', selective: true, priority: 20, position: 'before_char', extensions: { opaque_entry: [1, 2] } },
        { id: 2, keys: ['clearing'], content: 'The clearing is quiet after rain.', enabled: false, insertion_order: 20, name: 'The clearing', extensions: {} },
      ] },
  } };
}

export async function viewerFixture(name: string, format: 'json' | 'png' | 'charx', options: { long?: boolean } = {}) {
  const card = viewerDocument(name, options);
  if (format === 'json') return Buffer.from(JSON.stringify(card));
  const descriptors = [{ type: 'icon', uri: 'ccdefault:', name: 'main', ext: 'png', vendor_asset: { preserve: true } }];
  if (format === 'charx') descriptors.push(
    { type: 'custom', uri: 'embeded://other/notes.txt', name: 'notes', ext: 'txt', vendor_asset: { preserve: true } },
    { type: 'image', uri: 'embeded://images/forest.png', name: 'forest', ext: 'png', vendor_asset: { preserve: true } },
  );
  const wrapped = { ...card, data: { ...card.data, assets: descriptors } };
  if (format === 'png') {
    const { embedIntoPNG } = foundry('@character-foundry/character-foundry/png');
    return Buffer.from(embedIntoPNG(png, wrapped, { key: 'ccv3' }));
  }
  const { writeCharX } = foundry('@character-foundry/character-foundry/charx');
  return Buffer.from(writeCharX(wrapped, [
    { type: 'icon', name: 'main', ext: 'png', data: png, isMain: true },
    { type: 'custom', name: 'notes', ext: 'txt', data: notes },
    { type: 'image', name: 'forest', ext: 'png', data: png },
  ], { preserveDescriptors: true, moduleRisum }).buffer);
}

/** Import through the native shell's actual file picker, leaving the card in the library. */
export async function importViewerCard(page: Page, name: string, format: 'json' | 'png' | 'charx' = 'charx', options: { long?: boolean } = {}) {
  await page.goto('/');
  await expect(page.getByTitle('Import card files')).toBeVisible();
  const bytes = await viewerFixture(name, format, options);
  const response = page.waitForResponse((response) => response.url().endsWith('/imports') && response.request().method() === 'POST');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTitle('Import card files').click();
  await (await chooser).setFiles({ name: `${name}.${format}`, mimeType: 'application/octet-stream', buffer: bytes });
  const received = await response;
  expect(received.status(), await received.text()).toBe(201);
  const imported: Imported = await received.json();
  await expect(page.getByRole('status')).toContainText('Imported 1 card');
  await expect(page.getByRole('button', { name: `Quick view ${name}`, exact: true })).toBeVisible();
  return { ...imported, bytes, name, path: `/api/workspaces/${imported.card.workspaceId}/cards/${imported.card.id}` };
}
