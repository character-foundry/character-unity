import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sillyTavernImages } from './sillytavern-images.mjs';

/** Run inside an already-owned SillyTavern temporary profile and real Unity sessions. */
export async function verifyAssetFlow({ checkout, alice, bob, aliceWorkspace, bobWorkspace, aster, saved, st }) {
  const sdk = await import(pathToFileURL(resolve('../.unity-foundry-sdk/packages/character-foundry/dist/identity.js')));
  const png = await import(pathToFileURL(resolve('../.unity-foundry-sdk/packages/character-foundry/dist/png.js')));
  const images = await sillyTavernImages(checkout);
  const sourcePath = `workspaces/${aliceWorkspace.id}/cards/${aster.card.id}`;
  const original = new Uint8Array(await (await alice(`${sourcePath}/original`)).arrayBuffer());
  const before = (await (await bob(`workspaces/${bobWorkspace.id}/cards`)).json()).cards.length;
  function body(revision, portrait, extra) {
    const document = structuredClone(revision.document);
    document.data.assets = [{ type: 'icon', name: 'Authored.Main', ext: 'png', uri: 'ccdefault:', license: { keep: true } }];
    const bindings = [{ path: 'portrait', source: { kind: 'upload', index: 0 } }, { path: 'declared/0', source: { kind: 'upload', index: 0 } }];
    const form = new FormData(); form.set('file:0', new Blob([portrait], { type: 'image/png' }), 'portrait.png');
    if (extra) {
      document.data.assets.push({ type: 'custom', name: 'notes', ext: 'txt', uri: 'embedded://notes.txt' });
      bindings.push({ path: 'declared/1', source: { kind: 'upload', index: 1 } });
      form.set('file:1', new Blob(['separate attachment'], { type: 'text/plain' }), 'notes.txt');
    }
    form.set('input', JSON.stringify({ expectedHead: revision.id, document, bindings })); return form;
  }
  // Alice explicitly adds an encoder-produced portrait as an edit. Nothing changes
  // the accepted Archive source, and publication/export perform no conversion.
  const edited = await (await alice(`${sourcePath}/asset-revisions`, 'POST', body(saved, images.encoded))).json();
  assert.notDeepEqual(edited.identity, saved.identity);
  assert.equal(edited.document.data.extensions.foundry.lineage.parents[0].revisionHash, saved.document.data.extensions.foundry.lineage.revisionHash);
  const receipt = await (await alice('hub/publications', 'POST', { workspaceId: aliceWorkspace.id, revisionIds: [edited.id],
    policy: { visibility: 'members', allowFork: true, allowOriginal: false } }, 201)).json();
  assert.equal(receipt.publications.length, 1);
  const fork = await (await bob(`hub/publications/${receipt.publications[0].id}/forks`, 'POST', { workspaceId: bobWorkspace.id }, 201)).json();
  const forkPath = `workspaces/${bobWorkspace.id}/cards/${fork.card.id}`;
  const forkSource = new Uint8Array(await (await bob(`${forkPath}/original`)).arrayBuffer());
  const exportPng = async (revision) => new Uint8Array(await (await bob(`${forkPath}/export?revisionId=${revision.id}&format=sillytavern-png`)).arrayBuffer());
  async function stImport(bytes, name) {
    const form = new FormData(); form.set('avatar', new Blob([bytes], { type: 'image/png' }), `${name}.png`); form.set('file_type', 'png');
    const result = await (await st('/api/characters/import', { method: 'POST', body: form })).json(); assert.ok(result.file_name); return `${result.file_name}.png`;
  }
  async function stExport(avatar) {
    return new Uint8Array(await (await st('/api/characters/export', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ avatar_url: avatar, format: 'png' }) })).arrayBuffer());
  }
  async function rejectChangedPortrait(bytes) {
    const hash = await sdk.hashBytes(png.removeAllTextChunks(bytes));
    await assert.rejects(sdk.restoreSillyTavernTransport(png.extractFromPNG(bytes).data,
      { portraitHash: hash, assets: [{ pointer: '/assets/0/uri', hash }] }), { code: 'LOSSY_FORMAT' });
    const response = await (await bob(`workspaces/${bobWorkspace.id}/imports`, 'POST', bytes, 400)).json();
    assert.equal(response.error.code, 'INVALID_INPUT'); return response;
  }
  const avatar = await stImport(await exportPng(fork.revision), 'asset-fork');
  const returned = await stExport(avatar);
  assert.deepEqual(png.removeAllTextChunks(returned), images.encoded);
  const accepted = await (await bob(`workspaces/${bobWorkspace.id}/imports`, 'POST', returned, 201)).json();
  assert.deepEqual(accepted.revision.identity, fork.revision.identity);
  assert.deepEqual(accepted.revision.document.data.extensions.foundry.lineage, fork.revision.document.data.extensions.foundry.lineage);
  assert.equal(accepted.card.originalHash, aster.card.originalHash);
  const acceptedPath = `workspaces/${bobWorkspace.id}/cards/${accepted.card.id}`;
  assert.deepEqual(new Uint8Array(await (await bob(`${acceptedPath}/original`)).arrayBuffer()), returned);
  for (const path of ['portrait', 'declared/0']) assert.deepEqual(new Uint8Array(await (await bob(`${acceptedPath}/asset?revisionId=${accepted.revision.id}&path=${encodeURIComponent(path)}`)).arrayBuffer()), images.encoded);
  assert.deepEqual(accepted.revision.document.data.assets[0].license, { keep: true });
  assert.equal(accepted.revision.document.data.assets[0].name, 'Authored.Main');
  // A meaningful image edit through SillyTavern must never restore stale lineage.
  const replacement = new FormData(); replacement.set('avatar', new Blob([images.changed], { type: 'image/png' }), 'changed.png'); replacement.set('avatar_url', avatar);
  await st('/api/characters/edit-avatar', { method: 'POST', body: replacement });
  const changed = await stExport(avatar);
  assert.deepEqual(png.removeAllTextChunks(changed), images.changed);
  const rejectedEdit = await rejectChangedPortrait(changed);
  // The same application also changes an ordinary, valid PNG with no user edit.
  // Retain that negative result instead of declaring arbitrary portraits compatible.
  const ordinary = png.removeAllTextChunks(images.ordinary);
  const revised = await (await bob(`${forkPath}/asset-revisions`, 'POST', body(fork.revision, ordinary))).json();
  const ordinaryAvatar = await stImport(await exportPng(revised), 'ordinary-portrait');
  const reencoded = await stExport(ordinaryAvatar);
  assert.notDeepEqual(png.removeAllTextChunks(reencoded), ordinary);
  const rejectedEncoding = await rejectChangedPortrait(reencoded);
  const attachment = await (await bob(`${forkPath}/asset-revisions`, 'POST', body(revised, images.encoded, true))).json();
  const rejectedAttachment = await (await bob(`${forkPath}/export?revisionId=${attachment.id}&format=sillytavern-png`, 'GET', undefined, 400)).json();
  assert.equal(rejectedAttachment.error.code, 'EXPORT_LOSS');
  assert.equal((await (await bob(`workspaces/${bobWorkspace.id}/cards`)).json()).cards.length, before + 2);
  assert.deepEqual(new Uint8Array(await (await alice(`${sourcePath}/original`)).arrayBuffer()), original);
  assert.deepEqual(new Uint8Array(await (await bob(`${forkPath}/original`)).arrayBuffer()), forkSource);
  assert.deepEqual(new Uint8Array(await (await bob(`${forkPath}/asset?revisionId=${fork.revision.id}&path=portrait`)).arrayBuffer()), images.encoded);
  return { profile: 'sillytavern-png', supportedCase: 'encoder-produced PNG portrait and its declared alias',
    explicitPortraitEdit: true, originalHash: accepted.card.originalHash, content: accepted.revision.identity,
    revisionHash: accepted.revision.document.data.extensions.foundry.lineage.revisionHash, portraitHash: await sdk.hashBytes(images.encoded),
    exactPortraitAndAlias: true, opaqueDescriptorPreserved: true, exactReturnedSource: true, unchangedOriginals: true,
    externalPortraitEditRejected: rejectedEdit.error.code, ordinaryReencodingRejected: rejectedEncoding.error.code,
    separateAttachmentExportRejected: rejectedAttachment.error.code, rejectedImportsCreateNoCards: true };
}
