import { createRemoteConnectionsService } from '@character-unity/cards/connections';
import type { ConfiguredRemote } from '@character-unity/cards/connections';
import { createRemoteReturnService } from '@character-unity/cards/remote-outbox';
import type { SyncOutboxStore } from '@character-unity/store/sync-outbox';
import { createAssetService } from '@character-unity/assets';
import { createCardService } from '@character-unity/cards';
import { createHubService } from '@character-unity/cards/hub';
import { createChatService } from '@character-unity/cards/chat';
import { createStatisticsService } from '@character-unity/cards/statistics';
import { createMetaTagService } from '@character-unity/api/meta-tags';
import type { StatisticsReader } from '@character-unity/store/statistics';
import { createContentService } from '@character-unity/content';
import type { ContentStore } from '@character-unity/store/content';
import type { ChatStore } from '@character-unity/store/chat';
import { createRemoteCardService } from '@character-unity/cards/remote';
import type { RemoteCardConnection } from '@character-unity/cards/remote';
import { createArchiveImportService } from '@character-unity/cards/archive';
import type { ArchiveImportOptions } from '@character-unity/cards/archive';
import type { createArchiveClient } from '@character-unity/archive-client';
import type { UnityStore } from '@character-unity/store';
import type { createHubStore } from '@character-unity/store/hub';
import type { BlobStore } from '@character-unity/blob-store';
import { createNativeArchiveReader, createNativeArchiveAssetResolver } from '@character-unity/cards/native-reader';
import type { NativeArchiveOptions } from '@character-unity/cards/native-reader';
import type { LibraryIndexDispatcher } from './library-index.js';
import { createNativeArchiveService } from '@character-unity/cards/native-archive';

/** Hosts supply adapters; both runtimes use the same domain composition. */
export function composeServices(storage: { store: UnityStore; hub: ReturnType<typeof createHubStore>; outbox: SyncOutboxStore; chat?: ChatStore; statistics?: StatisticsReader; content?: ContentStore },
  blobs: BlobStore, archiveClient?: ReturnType<typeof createArchiveClient>, connections: readonly ConfiguredRemote[] = [], archiveOptions?: ArchiveImportOptions,
  /** Local hosts take whole RisuAI packages; hosted ones keep the blob store's default. */
  assetMaxBytes?: number, nativeArchive?: NativeArchiveOptions, libraryIndex?: LibraryIndexDispatcher,
  /** Only the local single-owner host grants scraper/settings administration. */
  archiveAdmin = false) {
  const store = libraryIndex?.wrap(storage.store) ?? storage.store;
  const reader = nativeArchive ? createNativeArchiveReader(nativeArchive) : undefined;
  const assets = createAssetService(storage.store, blobs, { ...(assetMaxBytes ? { maxBytes: assetMaxBytes } : {}),
    external: createNativeArchiveAssetResolver(store, reader) });
  const cards = createCardService(store, assets, { ...(reader ? { archive: reader } : {}) });
  const native = nativeArchive ? createNativeArchiveService(cards, nativeArchive, { admin: archiveAdmin }) : undefined;
  const archive = archiveClient ? createArchiveImportService(cards, archiveClient, archiveOptions) : undefined;
  const hub = createHubService(store, storage.hub, assets);
  const remote = (connection: RemoteCardConnection) => {
    const service = createRemoteCardService(store, assets, connection);
    return { ...service, returns: createRemoteReturnService(store, assets, storage.outbox, service, connection) };
  };
  // Chat apps are reached from the owner's machine only; hosts without a chat store never get the service.
  const chat = storage.chat ? createChatService(store, storage.chat, assets, undefined, { ...(reader ? { archive: reader } : {}) }) : undefined;
  const statistics = storage.statistics ? createStatisticsService(store, storage.statistics) : undefined;
  const content = storage.content ? createContentService(store, storage.content) : undefined;
  return { store, assets, cards, metaTags: createMetaTagService(store), ...(content ? { content } : {}), ...(statistics ? { statistics } : {}), ...(native ? { nativeArchive: native } : {}), ...(libraryIndex ? { libraryIndex: libraryIndex.service(store) } : {}), ...(chat ? { chat } : {}), ...(archive ? { archive } : {}), hub, remote, remotes: createRemoteConnectionsService(store, storage.outbox, connections, remote) };
}
