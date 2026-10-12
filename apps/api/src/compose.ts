import { createRemoteConnectionsService } from '@character-unity/cards/connections';
import type { ConfiguredRemote } from '@character-unity/cards/connections';
import { createRemoteReturnService } from '@character-unity/cards/remote-outbox';
import type { SyncOutboxStore } from '@character-unity/store/sync-outbox';
import { createAssetService } from '@character-unity/assets';
import { createCardService } from '@character-unity/cards';
import { createHubService } from '@character-unity/cards/hub';
import { createRemoteCardService } from '@character-unity/cards/remote';
import type { RemoteCardConnection } from '@character-unity/cards/remote';
import { createArchiveImportService } from '@character-unity/cards/archive';
import type { ArchiveImportOptions } from '@character-unity/cards/archive';
import type { createArchiveClient } from '@character-unity/archive-client';
import type { UnityStore } from '@character-unity/store';
import type { createHubStore } from '@character-unity/store/hub';
import type { BlobStore } from '@character-unity/blob-store';

/** Hosts supply adapters; both runtimes use the same domain composition. */
export function composeServices(storage: { store: UnityStore; hub: ReturnType<typeof createHubStore>; outbox: SyncOutboxStore },
  blobs: BlobStore, archiveClient?: ReturnType<typeof createArchiveClient>, connections: readonly ConfiguredRemote[] = [], archiveOptions?: ArchiveImportOptions) {
  const assets = createAssetService(storage.store, blobs);
  const cards = createCardService(storage.store, assets);
  const archive = archiveClient ? createArchiveImportService(cards, archiveClient, archiveOptions) : undefined;
  const hub = createHubService(storage.store, storage.hub, assets);
  const remote = (connection: RemoteCardConnection) => {
    const service = createRemoteCardService(storage.store, assets, connection);
    return { ...service, returns: createRemoteReturnService(storage.store, assets, storage.outbox, service, connection) };
  };
  return { store: storage.store, assets, cards, ...(archive ? { archive } : {}), hub, remote, remotes: createRemoteConnectionsService(storage.store, storage.outbox, connections, remote) };
}
