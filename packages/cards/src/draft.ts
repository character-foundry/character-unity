import { canonicalJson, createCardRevision, hashBytes, readCardLineage } from '@character-foundry/character-foundry/identity';
import { parseURI } from '@character-foundry/character-foundry/core';
import type { AssetService } from '@character-unity/assets';
import type { Asset, CardDocument, UnityStore } from '@character-unity/store';
import { documentByteLimit } from '@character-unity/store/validation';
import { CardError, declaredAssetLimit, importByteLimit } from './types.js';
import type { Actor, AssetBinding, AssetUpload } from './types.js';
import { setChatImportReceipt } from './private-chat-receipt.js';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** New cards have no stored bindings to inherit. Validate the entire draft before
 * storing bytes, then publish its first revision and references in one batch. */
export async function createAssetDraft(store: UnityStore, assets: AssetService, actorInput: Actor, workspaceId: string,
  input: CardDocument, bindingsInput: readonly AssetBinding[], uploadsInput: readonly AssetUpload[], signal?: AbortSignal) {
  const actor = { ...actorInput }, document = setChatImportReceipt(JSON.parse(canonicalJson(input)) as CardDocument);
  const original = new TextEncoder().encode(canonicalJson(document));
  if (original.byteLength > documentByteLimit) throw new CardError('TOO_LARGE', 'Draft exceeds the save limit');
  if (!Array.isArray(bindingsInput) || bindingsInput.length > declaredAssetLimit + 1 || !Array.isArray(uploadsInput)
    || uploadsInput.length > 64 || uploadsInput.some((upload) => !object(upload) || !(upload.bytes instanceof Uint8Array))
    || uploadsInput.reduce((size, upload) => size + upload.bytes.byteLength, 0) > importByteLimit) throw new CardError('TOO_LARGE', 'Draft assets exceed upload limits');
  const bindings = JSON.parse(canonicalJson(bindingsInput)) as AssetBinding[];
  const uploads = uploadsInput.map((upload) => {
    if (typeof upload.mediaType !== 'string' || upload.mediaType.length > 128 || !/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(upload.mediaType)) throw new CardError('INVALID_INPUT', 'Invalid upload media type');
    return { bytes: new Uint8Array(upload.bytes), mediaType: upload.mediaType };
  });
  const deadline = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
  const check = () => { if (deadline.aborted) throw new CardError('INVALID_INPUT', 'Draft save was cancelled or timed out'); };
  if ((await store.getWorkspace(workspaceId)).ownerId !== actor.id) throw new CardError('FORBIDDEN', 'Workspace belongs to another account');
  check();
  if (readCardLineage(document)) throw new CardError('INVALID_LINEAGE', 'A new card cannot claim an existing lineage; use Fork or Import');
  const data = document.data;
  if (!object(data)) throw new CardError('INVALID_INPUT', 'Expected a wrapped character document');
  const declared = data.assets ?? [];
  if (!Array.isArray(declared) || declared.length > declaredAssetLimit
    || !declared.every((item) => object(item) && typeof item.uri === 'string')) throw new CardError('INVALID_INPUT', 'Invalid declared asset descriptors');
  const paths = new Set<string>(), used = new Set<number>();
  for (const binding of bindings) {
    if (!object(binding) || Object.keys(binding).some((key) => !['path', 'source'].includes(key)) || typeof binding.path !== 'string'
      || (binding.path !== 'portrait' && !/^declared\/(0|[1-9][0-9]{0,3})$/.test(binding.path)) || paths.has(binding.path)
      || !object(binding.source) || binding.source.kind !== 'upload' || Object.keys(binding.source).some((key) => !['kind', 'index'].includes(key))
      || !Number.isSafeInteger(binding.source.index) || binding.source.index < 0 || binding.source.index >= uploads.length) throw new CardError('INVALID_INPUT', 'New cards require explicit upload bindings');
    paths.add(binding.path); used.add(binding.source.index);
  }
  if (used.size !== uploads.length || paths.size !== declared.length + (paths.has('portrait') ? 1 : 0)
    || declared.some((_, index) => !paths.has(`declared/${index}`))) throw new CardError('INVALID_INPUT', 'Every descriptor and upload must have an exact asset binding');
  const measured = await Promise.all(uploads.map(async (upload) => ({ ...upload, hash: await hashBytes(upload.bytes) })));
  const planned = bindings.map((binding) => ({ path: binding.path, index: (binding.source as { index: number }).index }));
  if (planned.reduce((size, item) => size + measured[item.index]!.bytes.byteLength, 0) > importByteLimit) throw new CardError('TOO_LARGE', 'Revision assets exceed the save limit');
  const portrait = planned.find((item) => item.path === 'portrait');
  for (const [index, descriptor] of declared.entries()) {
    if (parseURI((descriptor as { uri: string }).uri).scheme === 'ccdefault'
      && (!portrait || measured[planned.find((item) => item.path === `declared/${index}`)!.index]!.hash !== measured[portrait.index]!.hash)) {
      throw new CardError('INVALID_INPUT', 'Default portrait descriptors must bind the portrait bytes');
    }
  }
  const acceptedHash = await hashBytes(original);
  const saved = await createCardRevision(document, { assets: planned.filter((item) => item.path !== 'portrait').map((item) => ({
    pointer: `/assets/${item.path.slice(9)}/uri`, hash: measured[item.index]!.hash,
  })), ...(portrait ? { portraitHash: measured[portrait.index]!.hash } : {}), originalHash: acceptedHash,
    operation: 'edit', parents: [], author: actor.uri, createdAt: new Date().toISOString(), nonce: crypto.randomUUID() });
  check();
  async function persist(bytes: Uint8Array, hash: string, mediaType: string) {
    check();
    const staged = await assets.stage({ workspaceId, hash, byteLength: bytes.byteLength, mediaType });
    return assets.upload(workspaceId, staged.id, new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), deadline);
  }
  const source = await persist(original, acceptedHash, 'application/json');
  const stored: Asset[] = [];
  for (const upload of measured) stored.push(await persist(upload.bytes, upload.hash, upload.mediaType));
  check();
  return store.createCard({ workspaceId, authorId: actor.id, document: saved.card, identity: saved.lineage.content, originalHash: acceptedHash,
    assets: planned.map((item) => ({ path: item.path, assetId: stored[item.index]!.id })),
    source: { assetId: source.id, provenance: { kind: 'new', format: document.spec ?? 'unknown' } } });
}
