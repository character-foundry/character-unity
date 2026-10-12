import { ArchiveError } from '@character-unity/archive-client';
import { input, identifier, parseSnapshot } from '@character-unity/archive-client/contract';
import type { createArchiveClient, ListRequest, SearchRequest, SelectionManifest, Snapshot } from '@character-unity/archive-client';
import type { Card, CardDocument, Revision } from '@character-unity/store';
import type { Actor, CardService, ImportAsset } from './index.js';
import { prepareImport } from './import.js';
import { CardError } from './types.js';

export interface ArchiveImportResult {
  manifest: SelectionManifest;
  imported: { archiveCardId: string; card: Card; revision: Revision }[];
  failures: { archiveCardId: string; code: string; message: string }[];
  interrupted: boolean;
}
const batchLimit = 64 * 1024 * 1024;
export interface ArchiveImportOptions { maxSelectionBytes?: number }
type Client = ReturnType<typeof createArchiveClient>;

/** Hosts configure the read source. A caller can select IDs, never a URL or path. */
export function createArchiveImportService(cards: CardService, archive: Client, options: ArchiveImportOptions = {}) {
  const maxSelectionBytes = options.maxSelectionBytes ?? batchLimit;
  if (!Number.isSafeInteger(maxSelectionBytes) || maxSelectionBytes < 1 || maxSelectionBytes > batchLimit) throw new Error('Invalid Archive selection byte limit');
  const authorize = (actor: Actor, workspaceId: string) => cards.list(actor, workspaceId, { limit: 1 });
  async function read<T>(actor: Actor, workspaceId: string, operation: () => Promise<T>, signal?: AbortSignal) {
    actor = { ...actor }; signal?.throwIfAborted(); await authorize(actor, workspaceId);
    const result = await operation();
    signal?.throwIfAborted(); await authorize(actor, workspaceId); signal?.throwIfAborted();
    return result;
  }
  return {
    status: (actor: Actor, workspaceId: string, signal?: AbortSignal) => read(actor, workspaceId, () => archive.status(signal), signal),
    search(actor: Actor, workspaceId: string, query: SearchRequest, signal?: AbortSignal) {
      query = { ...query }; return read(actor, workspaceId, () => archive.search(query, signal), signal);
    },
    async list(actor: Actor, workspaceId: string, query: ListRequest = {}, signal?: AbortSignal) {
      query = { ...query }; return read(actor, workspaceId, () => archive.list(query, signal), signal);
    },
    async select(actor: Actor, workspaceId: string, snapshot: Snapshot, ids: readonly string[], signal?: AbortSignal) {
      snapshot = input(() => parseSnapshot(snapshot)); ids = [...ids];
      return read(actor, workspaceId, () => archive.select(snapshot, ids, signal), signal);
    },
    async import(actor: Actor, workspaceId: string, snapshot: Snapshot, ids: readonly string[], signal?: AbortSignal): Promise<ArchiveImportResult> {
      actor = { ...actor }; snapshot = input(() => parseSnapshot(snapshot)); ids = [...ids].map((id) => input(() => identifier(id)));
      await authorize(actor, workspaceId);
      const deadline = AbortSignal.any([AbortSignal.timeout(25_000), ...(signal ? [signal] : [])]);
      const manifest = await archive.select(snapshot, ids, deadline);
      const total = manifest.cards.reduce((size, card) => size + card.original.byteLength
        + card.assets.reduce((sum, asset) => sum + (asset.availability === 'available' ? asset.object.byteLength : 0), 0), 0);
      if (total > maxSelectionBytes) throw new ArchiveError('TOO_LARGE', `The selected originals and assets exceed ${maxSelectionBytes} bytes; select a smaller subset`);
      // Verify the entire manifest and all available bytes before creating a card.
      const prepared: { id: string; bytes: Uint8Array; assets: ImportAsset[]; provenance: CardDocument }[] = [];
      for (const card of manifest.cards) {
        deadline.throwIfAborted();
        const bytes = await archive.original(manifest, card.original, deadline);
        const assets: ImportAsset[] = [];
        const unbound: string[] = [];
        for (const asset of card.assets) {
          if (asset.availability !== 'available') continue;
          const bytes = await archive.asset(manifest, asset.object, deadline);
          if (asset.binding) assets.push({ bytes, binding: asset.binding, mediaType: asset.object.mediaType });
          else unbound.push(asset.object.hash);
        }
        const parsed = await prepareImport(bytes, assets);
        if (unbound.some((hash) => !parsed.resources.some((resource) => resource.hash === hash))) {
          throw new CardError('UNSUPPORTED_FORMAT', 'An Archive asset needs an explicit source binding before this card can be imported');
        }
        const provenance: CardDocument = { kind: 'archive', contract: manifest.version, archiveId: manifest.archiveId,
          snapshot: manifest.snapshot, cardId: card.id, originalHash: card.original.hash, source: { ...card.source },
          unavailableAssets: card.assets.filter((asset) => asset.availability === 'unavailable').map((asset) => asset.id) };
        if (new TextEncoder().encode(JSON.stringify(provenance)).length > 8000) throw new CardError('TOO_LARGE', 'Archive source provenance exceeds the import limit');
        prepared.push({ id: card.id, bytes, assets, provenance });
      }
      deadline.throwIfAborted();
      const result: ArchiveImportResult = { manifest, imported: [], failures: [], interrupted: false };
      for (const item of prepared) {
        if (deadline.aborted) { result.interrupted = true; break; }
        try {
          const imported = await cards.import(actor, workspaceId, item.bytes, item.provenance, item.assets);
          result.imported.push({ archiveCardId: item.id, ...imported });
        } catch {
          // A storage failure is per-card atomic, not an all-or-nothing selection.
          result.failures.push({ archiveCardId: item.id, code: 'IMPORT_FAILED', message: 'This card was not imported. Check storage and the library before retrying.' });
          result.interrupted = true;
          break;
        }
      }
      return result;
    },
  };
}
export type ArchiveImportService = ReturnType<typeof createArchiveImportService>;
