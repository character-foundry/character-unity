import { SyncCommandError, decodeSyncForkSubmission, verifySyncForkSubmission, parseSyncReadPublication, SYNC_FORK_MAX_BYTES } from '@character-foundry/character-foundry/sync';
import type { SyncReadPublication } from '@character-foundry/character-foundry/sync';
import { snapshotSyncContext } from '@character-unity/store/sync';
import type { SyncWriteContext } from '@character-unity/store/sync';
import { canonicalJson, computeCardContentIdentity, createCardRevision, hashBytes, readCardLineage,
  sanitizeCardForPublish, verifyCardLineage } from '@character-foundry/character-foundry/identity';
import { StoreError } from '@character-unity/store';
import type { UnityStore } from '@character-unity/store';
import { publicationPolicy } from '@character-unity/store/hub';
import type { HubStore, Publication, PublicationPolicy, PublishInput } from '@character-unity/store/hub';
import type { AssetService } from '@character-unity/assets';
import { CardError } from './types.js';
import { risuModulePath } from './types.js';
import type { Actor } from './types.js';
import { revisionIdentityOptions } from './revision-assets.js';

/** This host cannot project an opaque file into the current public wire profile. */
export class UnsupportedSyncResourceError extends Error {
  constructor() {
    super('This publication contains an opaque RisuAI module (module.risum), which the current signed-sync profile cannot transfer. Its complete publication and original remain available on the source hub.');
    this.name = 'UnsupportedSyncResourceError';
  }
}

/** Explicit public wire projection shared by read and incoming-fork verification. */
export function publicationToSyncRead(value: Pick<Publication, 'id' | 'document' | 'identity' | 'originalHash' | 'parentId' | 'createdAt' | 'visibility' | 'allowFork' | 'policyVersion'>
  & { assets: { path: string; hash: string; byteLength: number; mediaType: string }[] }): SyncReadPublication {
  if (value.assets.some((asset) => asset.path === risuModulePath)) throw new UnsupportedSyncResourceError();
  return parseSyncReadPublication({ id: value.id, document: value.document, identity: value.identity, originalHash: value.originalHash,
    parentId: value.parentId, publishedAt: value.createdAt, policy: { visibility: value.visibility, allowFork: value.allowFork, version: value.policyVersion },
    assets: value.assets.map((asset) => ({ ...asset, binding: asset.path === 'portrait' ? { kind: 'portrait' }
      : /^declared\/(0|[1-9][0-9]*)$/.test(asset.path) ? { kind: 'uri', pointer: `/assets/${asset.path.slice(9)}/uri` }
        : (() => { throw new StoreError('INTEGRITY', 'Publication asset has no portable binding'); })() })),
  });
}

/** Policy and format orchestration shared by hub hosts. Authentication is supplied by the host. */
export function createHubService(store: UnityStore, hub: HubStore, assets: AssetService) {
  async function authorize(actor: Actor, workspaceId: string) {
    if ((await store.getWorkspace(workspaceId)).ownerId !== actor.id) throw new CardError('FORBIDDEN', 'Workspace belongs to another account');
  }
  async function present(publication: Publication) {
    const revision = await store.getRevision(publication.workspaceId, publication.revisionId);
    const references = await Promise.all(revision.assets.map(async (reference) => {
      const asset = await store.getAsset(publication.workspaceId, reference.assetId);
      return { path: reference.path, hash: asset.hash, byteLength: asset.byteLength, mediaType: asset.mediaType };
    }));
    // Explicit allowlist: no workspace/revision/source IDs, source provenance or storage keys.
    const { id, ownerId, document, identity, originalHash, parentId, createdAt, visibility, allowOriginal, allowFork, policyVersion } = publication;
    return { id, ownerId, document, identity, originalHash, parentId, createdAt, visibility, allowOriginal, allowFork, policyVersion, assets: references };
  }
  async function stillVisible(actor: Actor | null, publication: Publication) {
    const current = await hub.get(actor?.id ?? null, publication.id);
    if (current.policyVersion !== publication.policyVersion) throw new StoreError('ACCESS_CHANGED', 'Publication policy changed; reload');
  }
  return {
    async publish(actor: Actor, workspaceId: string, selectedRevisionIds: readonly string[], inputPolicy: PublicationPolicy, syncContext?: SyncWriteContext) {
      const context = snapshotSyncContext(syncContext);
      actor = { ...actor };
      const ids = [...selectedRevisionIds];
      const policy = publicationPolicy(inputPolicy);
      if (!ids.length || ids.length > 20 || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== 'string')) throw new CardError('INVALID_INPUT', 'Select 1–20 distinct revisions');
      await authorize(actor, workspaceId);
      if (context) {
        const existing = await hub.findSyncPublication(actor.id, workspaceId, context);
        if (existing) return existing.map(({ id }) => ({ id, policyVersion: 1 }));
      }
      const inputs: PublishInput[] = [];
      for (const id of ids) {
        const revision = await store.getRevision(workspaceId, id);
        const card = await store.getCard(workspaceId, revision.cardId);
        if (!card.originalHash) throw new CardError('INVALID_LINEAGE', 'Publication requires an accepted original root');
        if (policy.allowOriginal && !await store.getSource(workspaceId, card.id)) throw new CardError('ASSET_UNAVAILABLE', 'Original bytes are unavailable');
        const options = await revisionIdentityOptions(store, revision);
        const sanitized = sanitizeCardForPublish(revision.document).card;
        const identity = await computeCardContentIdentity(sanitized, options);
        if (canonicalJson(identity) !== canonicalJson(revision.identity)) throw new CardError('INVALID_LINEAGE', 'Revision content identity failed verification');
        if (readCardLineage(sanitized) && !await verifyCardLineage(sanitized, options)) throw new CardError('INVALID_LINEAGE', 'Publication lineage failed verification');
        inputs.push({ workspaceId, revisionId: id, document: sanitized, identity, originalHash: card.originalHash, ...policy });
      }
      const published = await hub.publish(actor.id, inputs, context);
      // Receipts cannot disclose a parent's current document or private revision identifiers.
      // A sync acknowledgement describes creation (version 1), even after later policy edits.
      return published.map(({ id, policyVersion }) => ({ id, policyVersion: context ? 1 : policyVersion }));
    },
    async get(actor: Actor | null, id: string) {
      actor = actor ? { ...actor } : null;
      const publication = await hub.get(actor?.id ?? null, id);
      const result = await present(publication);
      await stillVisible(actor, publication);
      return result;
    },
    async list(actor: Actor | null, options: Parameters<HubStore['list']>[1] = {}) {
      actor = actor ? { ...actor } : null;
      options = { ...options };
      if (options.parentId) await hub.get(actor?.id ?? null, options.parentId);
      const publications = await hub.list(actor?.id ?? null, options);
      const result = await Promise.all(publications.map(present));
      for (const publication of publications) await stillVisible(actor, publication);
      return result;
    },
    async updatePolicy(actor: Actor, id: string, expectedVersion: number, policy: PublicationPolicy) {
      return hub.updatePolicy(actor.id, id, expectedVersion, policy);
    },
    async lineage(actor: Actor | null, id: string, options: { afterId?: string; limit?: number } = {}) {
      actor = actor ? { ...actor } : null; options = { ...options };
      const anchor = await hub.get(actor?.id ?? null, id);
      const page = await hub.rootPage(actor?.id ?? null, anchor.originalHash, options);
      const nodes = page.records.map((publication) => {
        const lineage = readCardLineage(publication.document);
        if (lineage && lineage.originalHash !== anchor.originalHash) throw new StoreError('INTEGRITY', 'Publication lineage has a different original root');
        const data = publication.document.data;
        const name = data && typeof data === 'object' && !Array.isArray(data) ? data.name : null;
        return { publicationId: publication.id, title: typeof name === 'string' && name.trim() ? name.slice(0, 200) : 'Untitled character',
          ownerId: publication.ownerId, publishedAt: publication.createdAt, content: publication.identity,
          revisionHash: lineage?.revisionHash ?? null, operation: lineage?.operation ?? 'original',
          parents: lineage?.parents ?? [], forkedFromPublicationId: publication.parentId };
      });
      // Parent hashes are already public in the selected card's lineage. Do not look
      // up unpublished revisions to enrich them with private titles, authors or JSON.
      for (const publication of page.records) await stillVisible(actor, publication);
      await stillVisible(actor, anchor);
      return { version: 'unity.lineage-view.v1' as const, originalHash: anchor.originalHash, anchorId: anchor.id, nodes, nextAfter: page.nextAfter };
    },
    async original(actor: Actor | null, id: string) {
      actor = actor ? { ...actor } : null;
      const publication = await hub.get(actor?.id ?? null, id);
      if (actor?.id !== publication.ownerId && !publication.allowOriginal) throw new StoreError('NOT_FOUND', 'Original download is not available');
      const revision = await store.getRevision(publication.workspaceId, publication.revisionId);
      const source = await store.getSource(publication.workspaceId, revision.cardId);
      if (!source) throw new StoreError('NOT_FOUND', 'Original bytes are unavailable');
      const result = await assets.download(publication.workspaceId, source.assetId);
      try { await stillVisible(actor, publication); return result; }
      catch (error) { await result.body.cancel(); throw error; }
    },
    async asset(actor: Actor | null, id: string, path: string) {
      actor = actor ? { ...actor } : null;
      const publication = await hub.get(actor?.id ?? null, id);
      const revision = await store.getRevision(publication.workspaceId, publication.revisionId);
      const reference = revision.assets.find((asset) => asset.path === path);
      if (!reference) throw new StoreError('NOT_FOUND', 'Publication asset not found');
      const result = await assets.download(publication.workspaceId, reference.assetId);
      try { await stillVisible(actor, publication); return result; }
      catch (error) { await result.body.cancel(); throw error; }
    },
    async submitFork(actor: Actor, id: string, workspaceId: string, input: Uint8Array, syncContext: SyncWriteContext) {
      const context = snapshotSyncContext(syncContext);
      if (!context) throw new CardError('INVALID_INPUT', 'Remote fork requires a verified host context');
      if (!(input instanceof Uint8Array) || input.length > SYNC_FORK_MAX_BYTES) throw new CardError('TOO_LARGE', 'Remote fork exceeds the bundle limit');
      actor = { ...actor }; const bytes = new Uint8Array(input);
      await authorize(actor, workspaceId);
      // The receipt checks its exact request fingerprint and current source policy.
      // A committed retry does not decode or stage the same assets again.
      const existing = await store.findSyncFork(actor.id, workspaceId, context);
      if (existing) return existing;
      const publication = await hub.canFork(actor.id, id);
      const parent = publicationToSyncRead(await present(publication));
      let submission: Awaited<ReturnType<typeof decodeSyncForkSubmission>>;
      try {
        const decoded = await decodeSyncForkSubmission(bytes);
        submission = await verifySyncForkSubmission(decoded, parent, context.claim.actor);
        if (canonicalJson(sanitizeCardForPublish(submission.manifest.document).card) !== canonicalJson(submission.manifest.document)) {
          throw new Error('Incoming fork includes nonportable machine state');
        }
      } catch (error) {
        if (error instanceof SyncCommandError && error.code === 'TOO_LARGE') throw new CardError('TOO_LARGE', 'Remote fork metadata exceeds its limit');
        throw new CardError('INVALID_LINEAGE', 'Remote fork content, assets or lineage do not match its parent and signed actor');
      }
      const references = [];
      for (const [index, resource] of submission.manifest.assets.entries()) {
        const staged = await assets.stage({ workspaceId, hash: resource.hash, byteLength: resource.byteLength, mediaType: resource.mediaType });
        const resourceBytes = submission.assets[index]!;
        const saved = await assets.upload(workspaceId, staged.id, new ReadableStream({ start(controller) { controller.enqueue(resourceBytes); controller.close(); } }));
        references.push({ path: resource.binding.kind === 'portrait' ? 'portrait' : `declared/${resource.binding.pointer.split('/')[2]}`, assetId: saved.id });
      }
      // Preserve the exact accepted signed payload, separately from the original root.
      const source = await assets.stage({ workspaceId, hash: await hashBytes(bytes), byteLength: bytes.length, mediaType: 'application/octet-stream' });
      await assets.upload(workspaceId, source.id, new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }));
      return store.forkCard({ workspaceId, sourceWorkspaceId: publication.workspaceId, sourceRevisionId: publication.revisionId,
        authorId: actor.id, document: submission.manifest.document as Publication['document'], identity: submission.manifest.identity, assets: references,
        source: { assetId: source.id, provenance: { kind: 'sync-fork', version: submission.manifest.version, publicationId: id,
          actor: context.claim.actor, requestId: context.claim.requestId, requestHash: context.claim.requestHash } },
        publication: { publicationId: id, policyVersion: publication.policyVersion, actorId: actor.id } }, context);
    },
    async fork(actor: Actor, id: string, workspaceId: string, syncContext?: SyncWriteContext) {
      const context = snapshotSyncContext(syncContext);
      actor = { ...actor };
      await authorize(actor, workspaceId);
      if (context) {
        const existing = await store.findSyncFork(actor.id, workspaceId, context);
        if (existing) return existing;
      }
      const publication = await hub.canFork(actor.id, id);
      const revision = await store.getRevision(publication.workspaceId, publication.revisionId);
      const options = await revisionIdentityOptions(store, revision);
      const previous = readCardLineage(publication.document);
      if (previous && !await verifyCardLineage(publication.document, options)) throw new CardError('INVALID_LINEAGE', 'Publication lineage failed verification');
      const identity = await computeCardContentIdentity(publication.document, options);
      if (canonicalJson(identity) !== canonicalJson(publication.identity)) throw new CardError('INVALID_LINEAGE', 'Publication identity failed verification');
      const references = await Promise.all(revision.assets.map(async (reference) => ({ ...reference, asset: await store.getAsset(revision.workspaceId, reference.assetId) })));
      if (references.reduce((size, reference) => size + reference.asset.byteLength, 0) > 64 * 1024 * 1024) throw new CardError('TOO_LARGE', 'Fork assets exceed 64 MiB');
      const copied = [];
      for (const reference of references) {
        const staged = await assets.stage({ workspaceId, hash: reference.asset.hash, byteLength: reference.asset.byteLength, mediaType: reference.asset.mediaType });
        const source = await assets.download(revision.workspaceId, reference.assetId);
        // Upload rehashes the bytes and rejects corruption before completing the target asset.
        const saved = await assets.upload(workspaceId, staged.id, source.body);
        copied.push({ path: reference.path, assetId: saved.id });
      }
      // A fork accepts the public snapshot as its source. It never copies an ancestor's
      // original file, which may contain private extensions or unpublished container data.
      const bytes = new TextEncoder().encode(canonicalJson(publication.document));
      const source = await assets.stage({ workspaceId, hash: await hashBytes(bytes), byteLength: bytes.length, mediaType: 'application/json' });
      await assets.upload(workspaceId, source.id, new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }));
      const forked = await createCardRevision(publication.document, { ...options, originalHash: publication.originalHash,
        parents: previous ? [previous] : [], operation: 'fork', author: actor.uri, createdAt: new Date().toISOString(), nonce: crypto.randomUUID() });
      // SQL checks the current publication AND all ancestor policies in this same batch.
      return store.forkCard({ workspaceId, sourceWorkspaceId: publication.workspaceId, sourceRevisionId: revision.id,
        authorId: actor.id, identity: forked.lineage.content, document: forked.card, assets: copied,
        source: { assetId: source.id, provenance: { kind: 'hub-fork', publicationId: id } },
        publication: { publicationId: id, policyVersion: publication.policyVersion, actorId: actor.id } }, context);
    },
  };
}
export type HubService = ReturnType<typeof createHubService>;
