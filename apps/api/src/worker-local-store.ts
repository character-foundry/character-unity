import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createD1Driver } from '@character-unity/store/d1';
import { migrate, inspectSchema, schemaVersion } from '@character-unity/store/migrations';
import { createAssetMaintenanceStore } from '@character-unity/store/asset-maintenance';
import { createR2BlobRemover } from '@character-unity/blob-store/maintenance';
import { createStore } from '@character-unity/store';
import { createSyncStore } from '@character-unity/store/sync';
import { createAccountStore } from '@character-unity/store/accounts';

/** Operator-only local simulation. Remote bindings are explicitly disabled. */
export async function openLocalWorkerStore(stateDirectory: string, options: { migrate?: boolean } = {}) {
  const { getPlatformProxy } = await import('wrangler');
  const proxy = await getPlatformProxy<{ UNITY_DB: Parameters<typeof createD1Driver>[0]; UNITY_BLOBS: Parameters<typeof createR2BlobRemover>[0] }>({
    configPath: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)),
    persist: { path: resolve(stateDirectory, 'v3') }, remoteBindings: false,
  });
  try {
    const driver = createD1Driver(proxy.env.UNITY_DB);
    if (options.migrate !== false) await migrate(driver);
    if (await inspectSchema(driver) !== schemaVersion) throw new Error('Migrate the Unity schema before maintenance');
    return { accounts: createAccountStore(driver), store: createStore(driver), sync: createSyncStore(driver),
      maintenance: createAssetMaintenanceStore(driver), retiredBlobs: createR2BlobRemover(proxy.env.UNITY_BLOBS), close: proxy.dispose };
  } catch (error) { await proxy.dispose(); throw error; }
}
