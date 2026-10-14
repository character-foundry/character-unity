import { canonicalJson, hashBytes, readCardLineage, restoreSillyTavernTransport } from '@character-foundry/character-foundry/identity';
import { createChatApp, ChatAppError, chatAppNames } from '@character-unity/chat-apps';
import type { ChatApp, ChatConnection, RemoteCopy } from '@character-unity/chat-apps';
import type { AssetService } from '@character-unity/assets';
import type { UnityStore } from '@character-unity/store';
import { StoreError } from '@character-unity/store';
import type { ChatCredentials, ChatKind, ChatStore, ChatTargetWithCredentials, ObservedPlacement, ReferencePlacementIdentity } from '@character-unity/store/chat';
import { exportRevision } from './export.js';
import { revisionIdentityOptions } from './revision-assets.js';
import { CardError } from './types.js';
import type { Actor } from './types.js';
import { createReferenceService } from './references.js';
import { NativeArchiveUnavailable, type NativeArchiveReader } from './native-reader.js';
import { hash as validateHash, text as validateText } from '@character-unity/store/validation';
import { createCardService } from './index.js';
import { prepareChatEdit, type ChatEditPin, type ChatEditReview } from './chat-edits.js';
import { authorizeChatImport } from './private-chat-receipt.js';
export type { ChatEditPin, ChatEditReview } from './chat-edits.js';

export { ChatAppError } from '@character-unity/chat-apps';
export type { ChatPlacement, ChatTarget, PlacementStatus } from '@character-unity/store/chat';

interface TransportMarker { content?: { hash?: unknown }; revisionHash?: unknown }
/** The machine-local marker written by the SDK's SillyTavern transport profile, if the copy kept it. */
function marker(extensions: Record<string, unknown> | null): { contentHash: string; revisionHash: string | null } | null {
  const foundry = extensions?.foundry as { local?: { sillyTavernTransport?: TransportMarker } } | undefined;
  const value = foundry?.local?.sillyTavernTransport;
  const hash = value?.content?.hash;
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) return null;
  return { contentHash: hash, revisionHash: typeof value?.revisionHash === 'string' ? value.revisionHash : null };
}
function safeName(value: unknown) {
  return (typeof value === 'string' ? value : 'card').replace(/[^\p{L}\p{N} _.-]+/gu, '').trim().slice(0, 80) || 'card';
}

/**
 * Sends library cards to chat applications and keeps track of where each copy lives.
 * Copies are matched by the transport marker every send embeds, so a copy is found again
 * even after the app renames its file, and edits made inside the app are detected.
 */
export function createChatService(store: UnityStore, chat: ChatStore, assets: AssetService, connect: (connection: ChatConnection) => ChatApp = createChatApp,
  options: { archive?: NativeArchiveReader } = {}) {
  const references = createReferenceService(store, assets, options.archive);
  const cards = createCardService(store, assets, options);
  async function authorize(actor: Actor, workspaceId: string) {
    const workspace = await store.getWorkspace(workspaceId);
    if (workspace.ownerId !== actor.id) throw new CardError('FORBIDDEN', 'Workspace belongs to another account');
  }
  function app(target: ChatTargetWithCredentials) {
    return connect({ kind: target.kind, baseUrl: target.baseUrl, credentials: target.credentials });
  }
  async function resolveCard(workspaceId: string, cardId: string) {
    const reference = await references.get(workspaceId, cardId);
    if (reference) {
      const loaded = await references.resolve(reference);
      const revision = loaded.opened.revision;
      const identity: ReferencePlacementIdentity = { sequence: revision.sequence, contentHash: revision.identity.hash,
        revisionHash: readCardLineage(revision.document)?.revisionHash ?? null };
      return { revision, exportStore: loaded.virtualStore, exportAssets: loaded.virtualAssets, reference: identity,
        async assertCurrent() {
          const current = await store.getArchiveReference(workspaceId, cardId);
          if (current.pin.versionId !== revision.id || current.pin.archiveId !== reference.pin.archiveId || current.pin.cardId !== reference.pin.cardId) {
            throw new StoreError('ACCESS_CHANGED', 'The Archive reference changed before sending');
          }
        } };
    }
    const card = await store.getCard(workspaceId, cardId);
    const revision = await store.getRevision(workspaceId, card.headRevisionId);
    return { revision, exportStore: store, exportAssets: assets, reference: undefined,
      async assertCurrent() { await store.getCard(workspaceId, cardId); } };
  }
  /** Resolves one remote copy to a library revision and decides whether it was edited inside the app. */
  async function observe(workspaceId: string, client: ChatApp, copy: RemoteCopy, known?: { cardId: string; revisionId: string | null; fingerprint: string | null; reference?: ReferencePlacementIdentity }): Promise<ObservedPlacement | null> {
    const found = marker(copy.extensions);
    if (!found) {
      // The marker is gone: the copy was rewritten inside the app. Keep tracking it as edited.
      return known ? { remoteId: copy.remoteId, remoteName: copy.name, cardId: known.cardId, revisionId: known.revisionId, edited: true,
        ...(known.reference ? { reference: known.reference } : {}) } : null;
    }
    const hit = await chat.resolveRevision(workspaceId, { ...found, ...(known ? { preferCardId: known.cardId } : {}) });
    if (!hit) return null;
    if (copy.fingerprint !== undefined) {
      // Apps that rebuild cards on export: compare with the fingerprint taken when the copy was sent or first seen.
      // A copy now carrying a different revision was re-sent from elsewhere, so it starts a new baseline.
      const baseline = known?.fingerprint && known.revisionId === hit.id ? known.fingerprint : copy.fingerprint;
      return { remoteId: copy.remoteId, remoteName: copy.name, cardId: hit.cardId, revisionId: hit.id, edited: baseline !== copy.fingerprint, fingerprint: baseline,
        ...(hit.reference ? { reference: hit.reference } : {}) };
    }
    const loaded = hit.reference ? await resolveCard(workspaceId, hit.cardId) : null;
    const revision = loaded?.revision ?? await store.getRevision(workspaceId, hit.id);
    const exported = await client.read(copy.remoteId);
    // The SDK only restores an unchanged copy; any meaningful edit made inside the app is rejected.
    const edited = !await restoreSillyTavernTransport(exported, await revisionIdentityOptions(loaded?.exportStore ?? store, revision)).catch(() => null);
    return { remoteId: copy.remoteId, remoteName: copy.name, cardId: hit.cardId, revisionId: hit.id, edited,
      ...(hit.reference ? { reference: hit.reference } : {}) };
  }

  async function edit(actor: Actor, workspaceId: string, targetId: string, remoteId: string) {
    validateText(remoteId, 'remote copy ID', 500);
    await authorize(actor, workspaceId);
    const target = await chat.target(workspaceId, targetId);
    const placement = (await chat.placements(workspaceId)).find((item) => item.targetId === targetId && item.remoteId === remoteId);
    if (!placement?.revisionId || placement.status === 'missing') throw new StoreError('NOT_FOUND', 'The tracked remote copy is no longer available; scan the app again');
    const loaded = await resolveCard(workspaceId, placement.cardId), current = { revision: loaded.revision };
    const base = current.revision.id === placement.revisionId ? current.revision : await cards.revision(actor, workspaceId, placement.cardId, placement.revisionId);
    const snapshot = await app(target).readForImport(remoteId);
    const merged = prepareChatEdit(base.document, current.revision.document, snapshot, target.kind, await revisionIdentityOptions(loaded.exportStore, base));
    const pin: ChatEditPin = { cardId: placement.cardId, remoteId, baseRevisionId: base.id, expectedHead: current.revision.id,
      remoteHash: await hashBytes(snapshot.bytes), targetKind: target.kind, targetUrl: target.baseUrl, targetConfiguration: target.configurationVersion };
    await authorize(actor, workspaceId);
    const targetNow = await chat.target(workspaceId, targetId);
    if (canonicalJson(targetNow) !== canonicalJson(target)) throw new StoreError('ACCESS_CHANGED', 'The chat connection changed; review the copy again');
    const placementNow = (await chat.placements(workspaceId, [placement.cardId])).find((item) => item.targetId === targetId && item.remoteId === remoteId);
    if (!placementNow || placementNow.revisionId !== placement.revisionId || placementNow.status === 'missing') throw new StoreError('ACCESS_CHANGED', 'The tracked copy changed; review it again');
    if ((await cards.open(actor, workspaceId, placement.cardId)).revision.id !== pin.expectedHead) throw new StoreError('HEAD_CONFLICT', 'The library card changed; review the copy again');
    return { ...merged, pin, revision: current.revision };
  }

  return {
    async reviewEdit(actor: Actor, workspaceId: string, targetId: string, remoteId: string): Promise<ChatEditReview> {
      const result = await edit({ ...actor }, workspaceId, targetId, remoteId);
      return { ...result.pin, changes: result.changes, preserved: result.preserved };
    },
    async acceptEdit(actor: Actor, workspaceId: string, targetId: string, input: ChatEditPin) {
      actor = { ...actor }; input = { cardId: input.cardId, remoteId: input.remoteId, baseRevisionId: input.baseRevisionId,
        expectedHead: input.expectedHead, remoteHash: input.remoteHash, targetUrl: input.targetUrl, targetKind: input.targetKind, targetConfiguration: input.targetConfiguration };
      for (const key of ['cardId', 'remoteId', 'baseRevisionId', 'expectedHead', 'targetUrl', 'targetKind'] as const) validateText(input[key], key, 500);
      validateHash(input.remoteHash);
      if (!Number.isSafeInteger(input.targetConfiguration) || input.targetConfiguration < 1) throw new CardError('INVALID_INPUT', 'Expected the reviewed connection version');
      await authorize(actor, workspaceId);
      const receiptHash = await hashBytes(new TextEncoder().encode(canonicalJson({ workspaceId, targetId, ...input })));
      async function previous() {
        const found = await chat.importedEdit(workspaceId, actor.id, receiptHash, input.expectedHead);
        if (!found) return null;
        try { await cards.open(actor, workspaceId, found.cardId); }
        catch (error) {
          if (error instanceof StoreError && error.code === 'NOT_FOUND') {
            // An inaccessible source asset must keep its own error; only a
            // removed result card explains a permanent snapshot receipt this way.
            try { await store.getCard(workspaceId, found.cardId); }
            catch (missing) {
              if (missing instanceof StoreError && missing.code === 'NOT_FOUND') throw new StoreError('ACCESS_CHANGED',
                'A previous import of this snapshot was removed; it will not be silently recreated.', { cause: error });
              throw missing;
            }
          }
          throw error;
        }
        return { ...found, duplicate: true };
      }
      const existing = await previous(); if (existing) return existing;
      const target = await chat.target(workspaceId, targetId);
      if (target.baseUrl !== input.targetUrl || target.kind !== input.targetKind || target.configurationVersion !== input.targetConfiguration) throw new StoreError('ACCESS_CHANGED', 'The chat connection changed; review the copy again');
      const result = await edit(actor, workspaceId, targetId, input.remoteId);
      if (canonicalJson(result.pin) !== canonicalJson(input)) throw new StoreError('ACCESS_CHANGED', 'The remote copy or library changed after review; review it again');
      if (!result.changes.length) throw new CardError('INVALID_INPUT', 'There are no new text edits to import');
      const authorization = authorizeChatImport({ ...input, targetId, receiptHash });
      try {
        const fork = await cards.forkAssets(actor, workspaceId, input.cardId, input.expectedHead, result.document,
          result.revision.assets.filter((asset) => asset.path !== 'module.risum').map((asset) => ({ path: asset.path, source: { kind: 'existing', path: asset.path } })), [], undefined, authorization);
        return { cardId: fork.cardId, revisionId: fork.revisionId, duplicate: false };
      } catch (error) {
        const committed = await previous(); if (committed) return committed;
        throw error;
      }
    },
    async targets(actor: Actor, workspaceId: string) {
      await authorize(actor, workspaceId);
      return chat.targets(workspaceId);
    },
    async addTarget(actor: Actor, workspaceId: string, input: { kind: ChatKind; name?: string; baseUrl: string; credentials: ChatCredentials }) {
      await authorize(actor, workspaceId);
      return chat.addTarget({ workspaceId, kind: input.kind, name: input.name?.trim() || chatAppNames[input.kind] || 'Chat app', baseUrl: input.baseUrl, credentials: input.credentials });
    },
    async updateTarget(actor: Actor, workspaceId: string, targetId: string, input: { name?: string; baseUrl?: string; credentials?: ChatCredentials }) {
      await authorize(actor, workspaceId);
      return chat.updateTarget(workspaceId, targetId, input);
    },
    async removeTarget(actor: Actor, workspaceId: string, targetId: string) {
      await authorize(actor, workspaceId);
      await chat.removeTarget(workspaceId, targetId);
    },
    async check(actor: Actor, workspaceId: string, targetId: string) {
      await authorize(actor, workspaceId);
      return app(await chat.target(workspaceId, targetId)).check();
    },
    /** Lists the app, records every copy of a library card it holds, and marks vanished copies missing. */
    async scan(actor: Actor, workspaceId: string, targetId: string) {
      actor = { ...actor };
      await authorize(actor, workspaceId);
      const target = await chat.target(workspaceId, targetId);
      const client = app(target);
      const known = new Map((await chat.placements(workspaceId)).filter((row) => row.targetId === targetId).map((row) => [row.remoteId, row]));
      try {
        const observed: ObservedPlacement[] = [];
        for (const copy of await client.list()) {
          const item = await observe(workspaceId, client, copy, known.get(copy.remoteId));
          if (item) observed.push(item);
        }
        await authorize(actor, workspaceId);
        await chat.recordPlacements(workspaceId, targetId, observed, { complete: true });
        return { found: observed.length };
      } catch (error) {
        if (error instanceof ChatAppError || error instanceof NativeArchiveUnavailable) await chat.recordPlacements(workspaceId, targetId, [], { complete: false, error: error.message });
        throw error;
      }
    },
    /**
     * Sends the card's head revision. An existing copy is overwritten in place, which keeps its chats;
     * a copy edited inside the app is only overwritten when the caller confirms.
     */
    async send(actor: Actor, workspaceId: string, cardId: string, targetId: string, options: { overwriteEdited?: boolean } = {}) {
      actor = { ...actor };
      await authorize(actor, workspaceId);
      const target = await chat.target(workspaceId, targetId);
      const loaded = await resolveCard(workspaceId, cardId);
      const { revision } = loaded;
      const copies = (await chat.placements(workspaceId, [cardId])).filter((row) => row.targetId === targetId && row.status !== 'missing');
      const existing = copies.find((row) => row.status !== 'edited') ?? copies[0];
      if (existing?.status === 'edited' && !options.overwriteEdited) {
        throw new StoreError('ACCESS_CHANGED', `The copy in ${target.name} was edited there. Overwrite it to replace those edits.`);
      }
      const portrait = revision.assets.some((asset) => asset.path === 'portrait');
      let exported;
      try {
        exported = await exportRevision(loaded.exportStore, loaded.exportAssets, revision, portrait ? 'sillytavern-png' : 'sillytavern-json');
      } catch (error) {
        // A non-PNG portrait cannot be embedded; the JSON profile still carries the card and its marker.
        if (!(portrait && error instanceof CardError && error.code === 'EXPORT_LOSS')) throw error;
        exported = await exportRevision(loaded.exportStore, loaded.exportAssets, revision, 'sillytavern-json');
      }
      const type = exported.mediaType === 'image/png' ? 'png' : 'json';
      // Field-updating apps take the card itself: the same transported card (and marker) the file embeds.
      const cardJson = exported.transport ?? JSON.parse(new TextDecoder().decode(exported.bytes)) as Record<string, unknown>;
      const name = safeName((revision.document.data as { name?: unknown } | undefined)?.name);
      await authorize(actor, workspaceId);
      await loaded.assertCurrent();
      const sent = await app(target).upload({ bytes: exported.bytes, type, fileName: `${name}.${type}`, card: cardJson, portrait: type === 'png' ? exported.bytes : null },
        { ...(existing ? { replace: existing.remoteId } : {}), preferredName: cardId });
      await authorize(actor, workspaceId);
      await loaded.assertCurrent();
      await chat.recordPlacements(workspaceId, targetId, [{ remoteId: sent.remoteId, remoteName: name, cardId, revisionId: revision.id, edited: false, sent: true,
        fingerprint: sent.fingerprint ?? null, ...(loaded.reference ? { reference: loaded.reference } : {}) }], { complete: false });
      return (await chat.placements(workspaceId, [cardId])).find((row) => row.targetId === targetId && row.remoteId === sent.remoteId)!;
    },
    async placements(actor: Actor, workspaceId: string, cardIds?: readonly string[]) {
      await authorize(actor, workspaceId);
      return chat.placements(workspaceId, cardIds);
    },
    async forget(actor: Actor, workspaceId: string, targetId: string, remoteId: string) {
      await authorize(actor, workspaceId);
      await chat.forgetPlacement(workspaceId, targetId, remoteId);
    },
  };
}
export type ChatService = ReturnType<typeof createChatService>;
