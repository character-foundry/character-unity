import { createSyncOutboxStore } from './sync-outbox.js';
import Database from 'better-sqlite3';
import type { Statement, StoreDriver } from './driver.js';
import { createStore } from './index.js';
import { migrate } from './migrations.js';
import { createSyncStore } from './sync.js';
import { createHubStore } from './hub.js';
import { createAccountStore, createSessionDriver } from './accounts.js';
import type { SessionProof } from './accounts.js';

export function createNodeDriver(database: Database.Database): StoreDriver {
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  return {
    async query<T>({ sql, params = [] }: Statement) {
      return database.prepare(sql).all(...params) as T[];
    },
    async batch(statements) {
      // The SQLite callback is strictly synchronous. A thrown statement rolls back the whole batch.
      return database.transaction(() => statements.map(({ sql, params = [] }) =>
        database.prepare(sql).run(...params).changes))();
    },
  };
}

export async function openNodeStore(filename: string) {
  const database = new Database(filename);
  try {
    const driver = createNodeDriver(database);
    await migrate(driver);
    database.pragma('journal_mode = WAL');
    return { store: createStore(driver), hub: createHubStore(driver), outbox: createSyncOutboxStore(driver), accounts: createAccountStore(driver), sync: createSyncStore(driver),
      forSession(proof: SessionProof) {
        const scoped = createSessionDriver(driver, proof);
        return { store: createStore(scoped), hub: createHubStore(scoped), outbox: createSyncOutboxStore(scoped) };
      }, close: () => database.close() };
  } catch (error) {
    database.close();
    throw error;
  }
}
