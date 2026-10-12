import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sillyTavernImages } from './sillytavern-images.mjs';
import { withSillyTavern } from './sillytavern-host.mjs';

const checkout = process.argv[2];
if (!checkout) throw new Error('Pass an explicit clean SillyTavern checkout with installed dependencies');
const sdkPath = resolve(process.argv[3] ?? '../.unity-foundry-sdk/packages/character-foundry/dist');
const identity = await import(pathToFileURL(`${sdkPath}/identity.js`));
const png = await import(pathToFileURL(`${sdkPath}/png.js`));
const document = { spec: 'chara_card_v3', spec_version: '3.0', opaque: { keep: true }, data: {
  name: 'Unity asset probe', description: 'An asset-bearing character.', extensions: { vendor: { keep: true } },
  assets: [{ type: 'icon', name: 'main', ext: 'png', uri: 'ccdefault:', license: { keep: true } }],
} };
await withSillyTavern(checkout, async ({ request, commit }) => {
  const images = await sillyTavernImages(checkout);
  const encoded = images.encoded, ordinary = png.removeAllTextChunks(images.ordinary);
  const results = [];
  for (const [name, portrait, attachment] of [['ordinary-png', ordinary, false], ['encoder-png', encoded, false], ['encoder-with-attachment', encoded, true]]) {
    const card = structuredClone(document), portraitHash = await identity.hashBytes(portrait);
    const payload = new TextEncoder().encode('An exact attachment.\n');
    const options = { portraitHash, assets: [{ pointer: '/assets/0/uri', hash: portraitHash }] };
    if (attachment) { card.data.assets.push({ type: 'custom', name: 'notes', ext: 'txt', uri: 'pngchunk:1' }); options.assets.push({ pointer: '/assets/1/uri', hash: await identity.hashBytes(payload) }); }
    const revision = await identity.createCardRevision(card, { ...options, originalHash: await identity.hashBytes(new TextEncoder().encode(JSON.stringify(card))),
      operation: 'edit', author: 'urn:unity:user:probe', parents: [], createdAt: '2026-10-11T00:00:00.000Z', nonce: crypto.randomUUID() });
    const transport = await identity.prepareSillyTavernTransport(revision.card, options);
    let bytes = png.embedIntoPNG(portrait, transport.card, { key: 'ccv3' });
    if (attachment) bytes = png.injectTextChunk(bytes, 'chara-ext-asset_:1', Buffer.from(payload).toString('base64'));
    const form = new FormData(); form.set('avatar', new Blob([bytes], { type: 'image/png' }), `${name}.png`); form.set('file_type', 'png');
    const imported = await (await request('/api/characters/import', { method: 'POST', body: form })).json(); assert.ok(imported.file_name);
    const output = new Uint8Array(await (await request('/api/characters/export', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ avatar_url: `${imported.file_name}.png`, format: 'png' }) })).arrayBuffer());
    const returned = png.extractFromPNG(output), returnedHash = await identity.hashBytes(png.removeAllTextChunks(output));
    const chunks = returned.extraChunks ?? [];
    const attachmentPresent = !attachment || chunks.some((chunk) => chunk.keyword === 'chara-ext-asset_:1' && chunk.text === Buffer.from(payload).toString('base64'));
    const returnedOptions = { portraitHash: returnedHash, assets: [{ pointer: '/assets/0/uri', hash: returnedHash }, ...(attachment && attachmentPresent ? options.assets.slice(1) : [])] };
    let restored = false, error = null;
    try { restored = !!await identity.restoreSillyTavernTransport(returned.data, returnedOptions); } catch (failure) { error = { code: failure.code, message: failure.message }; }
    results.push({ name, inputPortraitHash: portraitHash, returnedPortraitHash: returnedHash, exactPortrait: returnedHash === portraitHash, attachmentPresent, restored, error });
  }
  const result = { version: 'unity.sillytavern-assets-probe.v1', sillyTavernCommit: commit, results };
  await mkdir('runtime', { recursive: true }); await writeFile('runtime/sillytavern-assets-probe.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
});
