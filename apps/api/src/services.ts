import type { ConfiguredRemote } from '@character-unity/cards/connections';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { openNodeStore } from '@character-unity/store/node';
import { createNodeBlobStore } from '@character-unity/blob-store/node';
import { createArchiveClient } from '@character-unity/archive-client';
import type { SessionProof } from '@character-unity/store/accounts';
import { composeServices } from './compose.js';
import { importByteLimit } from '@character-unity/cards';
import { createLibraryIndexDispatcher } from './library-index.js';

/** Local composition root. No Archive paths or remote bindings are inferred here. */
export async function openLocalServices(options: { databasePath: string; blobDirectory: string; archiveOrigin?: string; remoteConnections?: readonly ConfiguredRemote[];
  /** The native Archive service (scraped cards) and its admin token. */
  nativeArchive?: import('@character-unity/cards/native-reader').NativeArchiveOptions }) {
  if (options.databasePath !== ':memory:') await mkdir(dirname(options.databasePath), { recursive: true });
  const database = await openNodeStore(options.databasePath);
  try {
    // A local library keeps cards as large as the importer takes (big RisuAI CharX assets included).
    const blobs = await createNodeBlobStore(options.blobDirectory, { maxBytes: importByteLimit });
    const archiveClient = options.archiveOrigin ? createArchiveClient(options.archiveOrigin) : undefined;
    const libraryIndex = createLibraryIndexDispatcher(database.store, options.nativeArchive);
    function compose(storage: Pick<typeof database, 'store' | 'hub' | 'outbox'> & { chat?: typeof database.chat }, archiveAdmin: boolean) {
      return composeServices(storage, blobs, archiveClient, options.remoteConnections, undefined, importByteLimit, options.nativeArchive, libraryIndex, archiveAdmin);
    }
    const local = compose(database, true);
    return { ...local, accounts: database.accounts, sync: database.sync,
      forSession: (proof: SessionProof) => compose(database.forSession(proof), false),
      searchIndex: libraryIndex,
      close() { libraryIndex.stop(); database.close(); } };
  } catch (error) {
    database.close();
    throw error;
  }
}
