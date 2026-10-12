import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Explicit development input: never silently import whichever sibling checkout exists.
assert.ok(process.argv[2], 'Usage: pnpm verify:foundry <built Foundry packages/character-foundry directory>');
const directory = resolve(process.argv[2]);
const manifestPath = join(directory, 'package.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assert.equal(manifest.name, '@character-foundry/character-foundry');
const entry = manifest.exports['./identity'];
assert.ok(entry?.import?.default && entry?.require?.default, 'Foundry build lacks the additive identity subpath');
const esmPath = resolve(directory, entry.import.default);
const esm = await import(pathToFileURL(esmPath).href);
const cjs = createRequire(manifestPath)(entry.require.default);
const charxEntry = manifest.exports['./charx'];
const charxPath = resolve(directory, charxEntry.import.default);
const esmCharx = await import(pathToFileURL(charxPath).href);
const cjsCharx = createRequire(manifestPath)(charxEntry.require.default);
const golden = {
  content: 'c77f25b32b63189951ca162e4781166974d6f9aa14b87cc3cb89f09520a81f98',
  revision: '0f41042272aa6491f7b777d1aef5c2e9b568d27d77f8647b19630eaf5ef5fe12',
  valid: true,
  transportValid: true,
  charxValid: true,
};

// This same consumer runs in Node ESM/CJS and in an actual local Worker.
async function exercise(sdk, charx) {
  const card = {spec:'chara_card_v3',spec_version:'3.0',data:{name:'Aster'}};
  const saved = await sdk.createCardRevision(card, {
    originalHash:'a'.repeat(64), operation:'edit', author:'urn:unity:user:aster',
    createdAt:'2026-10-11T12:00:00.000Z', nonce:'0000000000000001'
  });
  if (card.data.extensions !== undefined) throw new Error('SDK mutated the original');
  const valid = await sdk.verifyCardLineage(saved.card);
  const transported = await sdk.prepareSillyTavernTransport(saved.card);
  transported.card.name = 'Aster'; transported.card.fav = false;
  transported.card.data.extensions.fav = false;
  transported.card.create_date = '2026-10-11T13:00:00.000Z';
  if (await sdk.verifyCardLineage(transported.card)) throw new Error('Transport changed ordinary hash semantics');
  const restored = await sdk.restoreSillyTavernTransport(transported.card);
  const transportValid = !!restored && await sdk.verifyCardLineage(restored.card)
    && restored.content.hash === saved.lineage.content.hash;
  transported.card.data.name = transported.card.name = 'External edit';
  let rejected = false;
  try { await sdk.restoreSillyTavernTransport(transported.card); } catch { rejected = true; }
  if (!rejected) throw new Error('Transport accepted an external edit as its previous revision');
  const assetBytes = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
  const withAssets = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Opaque assets', assets: [
    { type: 'custom', name: 'data.file', ext: 'TXT', uri: 'first', opaque: [1, null] },
    { type: 'custom', name: 'data_file', ext: 'TXT', uri: 'second', opaque: [2, false] },
  ] } };
  const bindings = { assets: await Promise.all(assetBytes.map(async (bytes, i) => ({ pointer: `/assets/${i}/uri`, hash: await sdk.hashBytes(bytes) }))) };
  const expected = await sdk.computeCardContentIdentity(withAssets, bindings);
  const encoded = charx.writeCharX(withAssets, withAssets.data.assets.map((asset, i) => ({ ...asset, data: assetBytes[i] })), { preserveDescriptors: true });
  const decoded = charx.readCharX(encoded.buffer);
  const actualBindings = { assets: await Promise.all(decoded.assets.map(async (asset, i) => ({ pointer: `/assets/${i}/uri`, hash: await sdk.hashBytes(asset.buffer) }))) };
  const charxValid = decoded.assets.length === 2 && decoded.assets[0].path !== decoded.assets[1].path
    && (await sdk.computeCardContentIdentity(decoded.card, actualBindings)).hash === expected.hash;
  saved.card.data.name = 'Tampered';
  if (await sdk.verifyCardLineage(saved.card)) throw new Error('SDK accepted tampered content');
  return {content:saved.lineage.content.hash,revision:saved.lineage.revisionHash,valid,transportValid,charxValid};
}
// Compile a tiny consumer instead of exposing library exports as Worker entrypoints.
const consumer = await build({
  stdin: { contents: `import * as sdk from ${JSON.stringify(esmPath)}; import * as charx from ${JSON.stringify(charxPath)}; ${exercise.toString()}
    export default { async fetch() { return Response.json(await exercise(sdk, charx)); } };`, resolveDir: directory },
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
});
assert.deepEqual(await exercise(esm, esmCharx), golden);
assert.deepEqual(await exercise(cjs, cjsCharx), golden);
const worker = new Miniflare(convertV4MiniflareOptions({
  modules: true, script: consumer.outputFiles[0].text, compatibilityDate: '2026-10-11',
}));
try {
  const response = await worker.dispatchFetch('http://foundry-identity.test');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), golden);
} finally { await worker.dispose(); }
console.log('Foundry identity: Node ESM, Node CJS and local workerd pass independent vectors, input isolation, transport restoration, CharX descriptor/byte preservation and tamper rejection.');
