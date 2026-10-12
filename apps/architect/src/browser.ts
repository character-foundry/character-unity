import { createCardService } from '@character-unity/cards';
import { createAssetService } from '@character-unity/assets';
import { openBrowserStorage } from '@character-unity/browser-storage';
import type { ArchitectHost } from './api.js';
import type { ArchiveHost } from './api.js';
import { createArchiveClient } from '@character-unity/archive-client';
import { createArchiveImportService } from '@character-unity/cards/archive';

const actor = Object.freeze({ id: 'browser', uri: 'urn:unity:user:browser' });
export function createBrowserHost(): ArchitectHost {
  const origin = import.meta.env.VITE_UNITY_ARCHIVE_ORIGIN as string | undefined;
  let storage: ReturnType<typeof openBrowserStorage> | undefined;
  async function service() {
    storage ??= openBrowserStorage().catch((error: unknown) => { storage = undefined; throw error; });
    const current = await storage;
    return createCardService(current.store, createAssetService(current.store, current.blobs));
  }
  async function action<T>(run: (cards: Awaited<ReturnType<typeof service>>) => Promise<T>): Promise<T> {
    try { return await run(await service()); }
    catch (error) {
      if (error instanceof DOMException && error.name === 'QuotaExceededError') throw new Error('Browser storage is full. Your draft is still open; free some space before saving again.', { cause: error });
      if (error instanceof DOMException && ['InvalidStateError', 'VersionError'].includes(error.name)) {
        throw new Error('Browser storage changed in another tab. Preserve any unsaved text, then reload this app.', { cause: error });
      }
      throw error;
    }
  }
  return {
    kind: 'browser',
    ...(origin ? { archive: {
      status: (workspace, signal) => action((cards) => createArchiveImportService(cards, createArchiveClient(origin)).status(actor, workspace, signal)),
      search: (workspace, query, signal) => action((cards) => createArchiveImportService(cards, createArchiveClient(origin)).search(actor, workspace, query, signal)),
      list: (workspace, query, signal) => action((cards) => createArchiveImportService(cards, createArchiveClient(origin)).list(actor, workspace, query, signal)),
      select: (workspace, snapshot, ids, signal) => action((cards) => createArchiveImportService(cards, createArchiveClient(origin)).select(actor, workspace, snapshot, ids, signal)),
      import: (workspace, snapshot, ids, signal) => action((cards) => createArchiveImportService(cards, createArchiveClient(origin)).import(actor, workspace, snapshot, ids, signal)),
    } satisfies ArchiveHost } : {}),
    async session() { await service(); },
    workspaces: () => action((cards) => cards.workspaces(actor)),
    createWorkspace: (name) => action((cards) => cards.createWorkspace(actor, name)),
    list: (workspace, afterId) => action((cards) => cards.list(actor, workspace, { limit: 10, ...(afterId ? { afterId } : {}) })),
    open: (workspace, card) => action((cards) => cards.open(actor, workspace, card)),
    history: (workspace, card, options, signal) => action(async (cards) => {
      signal?.throwIfAborted(); const page = await cards.history(actor, workspace, card, options); signal?.throwIfAborted(); return page;
    }),
    revision: (workspace, card, revision, signal) => action(async (cards) => {
      signal?.throwIfAborted(); const value = await cards.revision(actor, workspace, card, revision); signal?.throwIfAborted(); return value;
    }),
    assetList: (workspace, card, revisionId, signal) => action(async (cards) => {
      signal?.throwIfAborted(); const result = await cards.assetList(actor, workspace, card, revisionId); signal?.throwIfAborted(); return result;
    }),
    asset: (workspace, card, revisionId, path, signal) => action(async (cards) => {
      signal?.throwIfAborted(); const result = await cards.asset(actor, workspace, card, revisionId, path);
      if (signal?.aborted) { await result.body.cancel(); signal.throwIfAborted(); }
      const blob = await new Response(result.body, { headers: { 'content-type': result.mediaType } }).blob(); signal?.throwIfAborted(); return blob;
    }),
    saveAssets: (workspace, card, expectedHead, document, plan) => action(async (cards) => {
      const uploads = await Promise.all(plan.files.map(async (file) => ({ bytes: new Uint8Array(await file.arrayBuffer()), mediaType: file.type || 'application/octet-stream' })));
      return cards.saveAssets(actor, workspace, card, expectedHead, document, plan.bindings, uploads);
    }),
    async import(workspace, file) {
      if (file.size > 32 * 1024 * 1024) throw new Error('Choose a card smaller than 32 MiB.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      return action((cards) => cards.import(actor, workspace, bytes, { kind: 'file', filename: file.name }));
    },
    save: (workspace, card, expectedHead, document) => action((cards) => cards.save(actor, workspace, card, expectedHead, document)),
    export: (workspace, card, revisionId, format) => action(async (cards) => {
      const result = await cards.export(actor, workspace, card, revisionId, format);
      return new Blob([new Uint8Array(result.bytes)], { type: result.mediaType });
    }),
    downloadOriginal: (workspace, card) => action(async (cards) => {
      const original = await cards.original(actor, workspace, card);
      return new Response(original.body, { headers: { 'content-type': original.mediaType } }).blob();
    }),
  };
}
