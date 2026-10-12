import { StoreError } from '@character-unity/store';
import { request, transaction } from './transaction.js';

const version = 2;
const storesV1 = ['meta', 'workspaces', 'cards', 'revisions', 'assets', 'sources', 'blobs'];
// Version 2: library annotations (deleted cards, favorites, followed creators, revision token counts).
const stores = [...storesV1, 'deletions', 'favorites', 'follows', 'metrics'];
const marker = { key: 'schema', format: 'character-unity-indexeddb', version };

export async function openDatabase(name: string): Promise<IDBDatabase> {
  if (!/^character-unity:[a-z0-9-]{1,80}$/.test(name)) throw new StoreError('INVALID_INPUT', 'Browser database name must use the character-unity namespace');
  if (typeof indexedDB === 'undefined') throw new Error('This browser does not provide IndexedDB storage');
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open(name, version);
    let cancelled = false, foreign = false;
    opening.onblocked = () => { cancelled = true; reject(new Error('Another tab is blocking the storage upgrade. Close it and reopen this app.')); };
    opening.onerror = () => reject(foreign ? new StoreError('SCHEMA_MISMATCH', 'This is not a recognized Unity browser database') : opening.error);
    opening.onupgradeneeded = (event) => {
      const db = opening.result, names = [...db.objectStoreNames].sort().join();
      if (!cancelled && event.oldVersion === 1 && names === [...storesV1].sort().join()) {
        addAnnotations(db);
        opening.transaction!.objectStore('meta').put(marker);
        return;
      }
      if (cancelled || event.oldVersion !== 0 || db.objectStoreNames.length !== 0) {
        foreign = !cancelled; opening.transaction!.abort(); return;
      }
      db.createObjectStore('meta', { keyPath: 'key' }).add(marker);
      db.createObjectStore('workspaces', { keyPath: 'id' }).createIndex('owner', ['ownerId', 'createdAt', 'id']);
      const cards = db.createObjectStore('cards', { keyPath: 'id' });
      cards.createIndex('workspace', ['workspaceId', 'id']);
      cards.createIndex('forks', ['workspaceId', 'forkedFromRevisionId', 'id']);
      db.createObjectStore('revisions', { keyPath: 'id' }).createIndex('history', ['workspaceId', 'cardId', 'sequence'], { unique: true });
      db.createObjectStore('assets', { keyPath: 'id' });
      db.createObjectStore('sources', { keyPath: 'cardId' });
      db.createObjectStore('blobs', { keyPath: 'key' });
      addAnnotations(db);
    };
    opening.onsuccess = () => {
      if (cancelled) opening.result.close();
      else resolve(opening.result);
    };
  });
  db.onversionchange = () => db.close();
  try { await inspectDatabase(db); return db; }
  catch (error) { db.close(); throw error; }
}

function addAnnotations(db: IDBDatabase) {
  db.createObjectStore('deletions', { keyPath: 'cardId' });
  db.createObjectStore('favorites', { keyPath: 'cardId' });
  db.createObjectStore('follows', { keyPath: ['workspaceId', 'key'] }).createIndex('workspace', ['workspaceId', 'key']);
  db.createObjectStore('metrics', { keyPath: 'revisionId' });
}

export async function inspectDatabase(db: IDBDatabase): Promise<{ schemaVersion: typeof version }> {
  if (db.version !== version || [...db.objectStoreNames].sort().join() !== [...stores].sort().join()) {
    throw new StoreError('SCHEMA_MISMATCH', 'This is not a recognized Unity browser database');
  }
  const value = await transaction(db, ['meta'], 'readonly', function* (tx) {
    return yield* request(tx.objectStore('meta').get('schema'));
  });
  if (value?.format !== marker.format || value?.version !== version) throw new StoreError('SCHEMA_MISMATCH', 'Browser storage metadata is not recognized');
  return { schemaVersion: version };
}
