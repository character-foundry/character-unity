import { canonicalJson, computeCardContentIdentity, createCardRevision, hashBytes, readCardLineage, verifyCardLineage } from '@character-foundry/character-foundry/identity';
import type { CardIdentityOptions } from '@character-foundry/character-foundry/identity';
import { parseURI } from '@character-foundry/character-foundry/core';
import type { AssetService } from '@character-unity/assets';
import { StoreError } from '@character-unity/store';
import type { Card, CardDocument, Revision, RevisionInput, UnityStore } from '@character-unity/store';
import { revisionIdentityOptions } from './revision-assets.js';
import { documentByteLimit } from '@character-unity/store/validation';
import { CardError, declaredAssetLimit, importByteLimit, risuModulePath } from './types.js';
import type { Actor, AssetBinding, AssetUpload } from './types.js';

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function bindingPath(value: unknown): value is string {
  return typeof value === 'string' && (value === 'portrait' || /^declared\/(0|[1-9][0-9]{0,3})$/.test(value));
}
function descriptor(value: unknown): value is CardDocument & { uri: string } {
  return object(value) && typeof value.uri === 'string';
}
function archiveComparable(document: CardDocument): string {
  const value = JSON.parse(canonicalJson(document)) as CardDocument;
  const data = value.data;
  // Bound asset paths/digests are compared separately. Ignore only transport
  // URI relocation, never format changes or opaque fields omitted by identity.
  if (object(data) && Array.isArray(data.assets)) for (const asset of data.assets) {
    if (descriptor(asset)) asset.uri = 'unity:bound-asset';
  }
  return canonicalJson(value);
}

/** Explicit full asset binding replacement. Existing sources can only name paths
 * in this card's expected revision, never arbitrary asset/storage identifiers. */
export async function saveAssetRevision(store: UnityStore, assets: AssetService, actorInput: Actor, workspaceId: string, cardId: string,
  expectedHead: string, input: CardDocument, bindingsInput: readonly AssetBinding[], uploadsInput: readonly AssetUpload[], signal?: AbortSignal, operation: 'edit' | 'fork' = 'edit',
  archiveSource?: { card: Card; revision: Revision; commit(input: RevisionInput): Promise<Revision> }) {
  const actor = { ...actorInput };
  const document = JSON.parse(canonicalJson(input)) as CardDocument;
  if (new TextEncoder().encode(JSON.stringify(document)).byteLength > documentByteLimit) throw new CardError('TOO_LARGE', 'Draft exceeds the save limit');
  if (!Array.isArray(bindingsInput) || bindingsInput.length > declaredAssetLimit + 1 || !Array.isArray(uploadsInput) || uploadsInput.length > 64
    || uploadsInput.some((upload) => !object(upload) || !(upload.bytes instanceof Uint8Array))
    || uploadsInput.reduce((size, upload) => size + upload.bytes.byteLength, 0) > importByteLimit) throw new CardError('TOO_LARGE', `Asset uploads exceed ${importByteLimit / 1024 / 1024} MiB or 64 files`);
  const bindings = JSON.parse(canonicalJson(bindingsInput)) as AssetBinding[];
  const uploads = uploadsInput.map((upload) => {
    if (typeof upload.mediaType !== 'string' || upload.mediaType.length > 128 || !/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(upload.mediaType)) throw new CardError('INVALID_INPUT', 'Invalid upload media type');
    return { bytes: new Uint8Array(upload.bytes), mediaType: upload.mediaType };
  });
  const deadline = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
  const check = () => { if (deadline.aborted) throw new CardError('INVALID_INPUT', 'Asset edit was cancelled or timed out'); };
  check();
  const workspace = await store.getWorkspace(workspaceId);
  if (workspace.ownerId !== actor.id) throw new CardError('FORBIDDEN', 'Workspace belongs to another account');
  const card = archiveSource?.card ?? await store.getCard(workspaceId, cardId);
  if (card.headRevisionId !== expectedHead) throw new StoreError('HEAD_CONFLICT', 'The card has changed; reload before saving');
  const current = archiveSource?.revision ?? await store.getRevision(workspaceId, expectedHead);
  if (current.cardId !== cardId) throw new StoreError('NOT_FOUND', 'Revision does not belong to this card');
  if (!card.originalHash) throw new CardError('INVALID_LINEAGE', 'Card has no accepted original root');
  const previousOptions = await revisionIdentityOptions(store, current);
  const previous = readCardLineage(current.document);
  if (canonicalJson(previous) !== canonicalJson(readCardLineage(document))) throw new CardError('INVALID_LINEAGE', 'Draft cannot replace its lineage');
  if (canonicalJson(await computeCardContentIdentity(current.document, previousOptions)) !== canonicalJson(current.identity)
    || (previous && !await verifyCardLineage(current.document, previousOptions))) throw new CardError('INVALID_LINEAGE', 'Stored content or lineage failed verification');
  const data = document.data;
  if (!object(data)) throw new CardError('INVALID_INPUT', 'Expected a wrapped character document');
  const declared = Object.hasOwn(data, 'assets') ? data.assets : [];
  if (!Array.isArray(declared) || declared.length > declaredAssetLimit || !declared.every(descriptor)) {
    throw new CardError('INVALID_INPUT', `Expected up to ${declaredAssetLimit} declared asset descriptors`);
  }
  const paths = new Set<string>(), usedUploads = new Set<number>();
  const originals = new Map(await Promise.all(current.assets.map(async (reference) => [reference.path,
    await store.getAsset(workspaceId, reference.assetId)] as const)));
  const measured = await Promise.all(uploads.map(async (upload) => ({ ...upload, hash: await hashBytes(upload.bytes), byteLength: upload.bytes.byteLength })));
  const planned: { path: string; hash: string; byteLength: number; mediaType: string; assetId?: string; upload?: number }[] = [];
  for (const binding of bindings) {
    if (!object(binding) || Object.keys(binding).some((key) => !['path', 'source'].includes(key)) || !bindingPath(binding.path)
      || paths.has(binding.path) || !object(binding.source)) throw new CardError('INVALID_INPUT', 'Invalid or duplicate asset binding');
    paths.add(binding.path);
    const source = binding.source;
    if (source.kind === 'existing' && Object.keys(source).every((key) => ['kind', 'path'].includes(key)) && bindingPath(source.path)) {
      const original = originals.get(source.path);
      if (!original || original.state !== 'ready') throw new CardError('ASSET_UNAVAILABLE', 'Existing asset is not in the expected revision');
      planned.push({ path: binding.path, hash: original.hash, byteLength: original.byteLength, mediaType: original.mediaType, assetId: original.id });
    } else if (source.kind === 'upload' && Object.keys(source).every((key) => ['kind', 'index'].includes(key))
      && Number.isSafeInteger(source.index) && source.index >= 0 && source.index < measured.length) {
      const upload = measured[source.index]!; usedUploads.add(source.index);
      planned.push({ path: binding.path, hash: upload.hash, byteLength: upload.byteLength, mediaType: upload.mediaType, upload: source.index });
    } else throw new CardError('INVALID_INPUT', 'Invalid asset source');
  }
  if (usedUploads.size !== uploads.length || paths.size !== declared.length + (paths.has('portrait') ? 1 : 0)
    || declared.some((_, index) => !paths.has(`declared/${index}`))) throw new CardError('INVALID_INPUT', 'Every descriptor and upload must have an exact asset binding');
  if (planned.reduce((size, reference) => size + reference.byteLength, 0) > importByteLimit) throw new CardError('TOO_LARGE', `Revision assets exceed ${importByteLimit / 1024 / 1024} MiB`);
  const portrait = planned.find((reference) => reference.path === 'portrait');
  for (const [index, descriptor] of declared.entries()) {
    // ccdefault explicitly aliases the container portrait; it cannot bind other bytes.
    if (parseURI(descriptor.uri).scheme === 'ccdefault'
      && (!portrait || planned.find((reference) => reference.path === `declared/${index}`)!.hash !== portrait.hash)) {
      throw new CardError('INVALID_INPUT', 'Default portrait descriptors must bind the same bytes as the portrait');
    }
  }
  const options: CardIdentityOptions = { assets: planned.filter((reference) => reference.path !== 'portrait').map((reference) => ({
    pointer: `/assets/${reference.path.slice(9)}/uri`, hash: reference.hash,
  })), ...(portrait ? { portraitHash: portrait.hash } : {}) };
  // Ask the SDK to validate the complete document/binding combination before writes.
  await computeCardContentIdentity(document, options);
  check();
  // A RisuAI module is not an editable binding; it rides along unchanged.
  const module = current.assets.find((reference) => reference.path === risuModulePath);
  if (module) planned.push({ path: risuModulePath, hash: originals.get(risuModulePath)!.hash, byteLength: originals.get(risuModulePath)!.byteLength,
    mediaType: originals.get(risuModulePath)!.mediaType, assetId: module.assetId });
  const existingDigests = [...originals].map(([path, asset]) => ({ path, hash: asset.hash })).sort((a, b) => a.path.localeCompare(b.path));
  const nextDigests = planned.map(({ path, hash }) => ({ path, hash })).sort((a, b) => a.path.localeCompare(b.path));
  const sameDocument = archiveSource ? archiveComparable(document) === archiveComparable(current.document)
    : canonicalJson(document) === canonicalJson(current.document);
  if ((operation === 'edit' || archiveSource) && sameDocument && canonicalJson(existingDigests) === canonicalJson(nextDigests)) {
    if (!archiveSource && (await store.getCard(workspaceId, cardId)).headRevisionId !== expectedHead) throw new StoreError('HEAD_CONFLICT', 'The card has changed; reload before saving');
    check(); return current;
  }
  const saved = await createCardRevision(document, { ...options, originalHash: card.originalHash, parents: previous ? [previous] : [],
    operation, author: actor.uri, createdAt: new Date().toISOString(), nonce: crypto.randomUUID() });
  const uploaded = new Map<number, string>();
  const references: Revision['assets'] = [];
  for (const reference of planned) {
    check();
    let assetId = reference.assetId ?? uploaded.get(reference.upload!);
    if (!assetId) {
      const upload = measured[reference.upload!]!;
      const staged = await assets.stage({ workspaceId, hash: upload.hash, byteLength: upload.byteLength, mediaType: upload.mediaType });
      const completed = await assets.upload(workspaceId, staged.id, new ReadableStream({ start(controller) { controller.enqueue(upload.bytes); controller.close(); } }), deadline);
      assetId = completed.id; uploaded.set(reference.upload!, assetId);
    }
    references.push({ path: reference.path, assetId });
  }
  check();
  if (archiveSource) return archiveSource.commit({ authorId: actor.id, document: saved.card, identity: saved.lineage.content, assets: references });
  // Domain batch checks the expected head and every ready asset atomically. Account
  // hosts additionally guard this batch against session revocation during uploads.
  if (operation === 'fork') return (await store.forkCard({ workspaceId, sourceWorkspaceId: workspaceId, sourceRevisionId: expectedHead,
    expectedSourceHead: expectedHead, authorId: actor.id, document: saved.card, identity: saved.lineage.content, assets: references })).revision;
  return store.saveRevision({ workspaceId, cardId, expectedHead, authorId: actor.id,
    document: saved.card, identity: saved.lineage.content, assets: references });
}
