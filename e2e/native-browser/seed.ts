import { openBrowserStorage } from '../../packages/browser-storage/src/index.js';
import { createAssetService } from '../../packages/assets/src/index.js';
import { createCardService } from '../../packages/cards/src/index.js';

/** Test-only setup on the same origin, before the native application is opened.
 * It uses the retained browser store contract, not an application test endpoint. */
document.getElementById('seed')!.addEventListener('click', () => {
  void (async () => {
    const storage = await openBrowserStorage();
    try {
      const actor = { id: 'browser', uri: 'urn:unity:user:browser' };
      const cards = createCardService(storage.store, createAssetService(storage.store, storage.blobs));
      const workspace = await cards.createWorkspace(actor, 'Existing browser desk');
      const bytes = new TextEncoder().encode(JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', opaque: { keep: true },
        data: { name: 'Browser Aster', description: 'An offline astronomer.', extensions: { foreign: { untouched: [1, null] } } } }));
      const imported = await cards.import(actor, workspace.id, bytes, { kind: 'file', filename: 'aster.json' });
      await cards.favorite(actor, workspace.id, imported.card.id, true);
      document.getElementById('status')!.textContent = 'Existing browser library ready';
    } finally { storage.close(); }
  })().catch((error: unknown) => { document.getElementById('status')!.textContent = error instanceof Error ? error.message : 'Fixture failed'; });
});
