import type { D1Database } from '@cloudflare/workers-types';
import type { Statement, StoreDriver } from './driver.js';
import { createStore } from './index.js';
import { StoreError } from './types.js';

/** D1 refuses strings and blobs over 2 MB; say so instead of failing the whole batch. */
const d1ValueLimit = 1_900_000;
function checkValues(params: readonly unknown[]) {
  for (const value of params) {
    const size = typeof value === 'string' ? new TextEncoder().encode(value).byteLength : value instanceof Uint8Array || value instanceof ArrayBuffer ? value.byteLength : 0;
    if (size > d1ValueLimit) throw new StoreError('INVALID_INPUT', 'This card is too large for a Cloudflare-hosted library (2 MB per document); keep it in a local library');
  }
}

/** Accept a D1 database or a request-scoped session; never opens Node/native dependencies. */
export function createD1Driver(database: Pick<D1Database, 'prepare' | 'batch'>): StoreDriver {
  return {
    async query<T>({ sql, params = [] }: Statement) {
      const result = await database.prepare(sql).bind(...params).all<T>();
      if (!result.success) throw new Error('D1 query failed');
      return result.results;
    },
    async batch(statements) {
      if (!statements.length) return [];
      for (const statement of statements) checkValues(statement.params ?? []);
      const results = await database.batch(statements.map(({ sql, params = [] }) => database.prepare(sql).bind(...params)));
      if (results.some((result) => !result.success)) throw new Error('D1 batch failed');
      return results.map((result) => result.meta.changes);
    },
  };
}

export function createD1Store(database: Pick<D1Database, 'prepare' | 'batch'>) {
  return createStore(createD1Driver(database));
}
