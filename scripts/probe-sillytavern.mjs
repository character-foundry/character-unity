import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withSillyTavern } from './sillytavern-host.mjs';
const checkout = process.argv[2];
if (!checkout) throw new Error('Pass an explicit clean SillyTavern checkout');
const sdk = await import(pathToFileURL(resolve(process.argv[3] ?? '../.unity-foundry-sdk/packages/character-foundry/dist/identity.js')));
await withSillyTavern(checkout, async ({ request, commit }) => {
  const document = { spec: 'chara_card_v3', spec_version: '3.0', opaque_envelope: { retained: true }, data: {
    name: 'Unity interoperability probe', description: 'A map keeper.', personality: '', scenario: '', first_mes: 'Hello.', mes_example: '',
    tags: ['fixture'], creator: 'Unity', character_version: '1', extensions: { foreign: { retained: true } },
  } };
  const original = new TextEncoder().encode(JSON.stringify(document));
  const edited = await sdk.createCardRevision(document, { originalHash: await sdk.hashBytes(original), operation: 'edit', parents: [], author: 'urn:unity:user:probe', createdAt: '2026-10-11T00:00:00.000Z', nonce: crypto.randomUUID() });
  const transport = await sdk.prepareSillyTavernTransport(edited.card);
  const form = new FormData(); form.set('avatar', new Blob([JSON.stringify(transport.card)], { type: 'application/json' }), 'probe.json'); form.set('file_type', 'json');
  const imported = await (await request('/api/characters/import', { method: 'POST', body: form })).json();
  if (!imported.file_name) throw new Error('SillyTavern did not return an imported character');
  const returned = await (await request('/api/characters/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ avatar_url: `${imported.file_name}.png`, format: 'json' }) })).json();
  const changes = [];
  function compare(a, b, pointer = '') {
    if (a === undefined || b === undefined) { if (a !== b) changes.push(pointer); return; }
    if (sdk.canonicalJson(a) === sdk.canonicalJson(b)) return;
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) compare(a[key], b[key], `${pointer}/${key}`);
    } else changes.push(pointer);
  }
  compare(edited.card, returned);
  const restored = await sdk.restoreSillyTavernTransport(returned);
  const result = { commit, version: 'unity.sillytavern-probe.v2', inputFormat: 'json', outputFormat: 'json',
    lineageMetadataRetained: sdk.canonicalJson(sdk.readCardLineage(returned)) === sdk.canonicalJson(edited.lineage),
    contentIdentityPreserved: sdk.canonicalJson(await sdk.computeCardContentIdentity(returned)) === sdk.canonicalJson(edited.lineage.content),
    lineageVerifiedBeforeRestoration: await sdk.verifyCardLineage(returned),
    lineageVerified: !!restored && await sdk.verifyCardLineage(restored.card),
    restoredContentIdentityPreserved: !!restored && sdk.canonicalJson(restored.content) === sdk.canonicalJson(edited.lineage.content), changedPointers: changes };
  await mkdir('runtime', { recursive: true });
  await writeFile('runtime/sillytavern-probe.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  if (!result.lineageVerified) process.exitCode = 1;
});
