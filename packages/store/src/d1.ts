import type { D1Database } from '@cloudflare/workers-types';
import type { Statement, StoreDriver } from './driver.js';
import { createStore } from './index.js';

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
      const results = await database.batch(statements.map(({ sql, params = [] }) => database.prepare(sql).bind(...params)));
      if (results.some((result) => !result.success)) throw new Error('D1 batch failed');
      return results.map((result) => result.meta.changes);
    },
  };
}

export function createD1Store(database: Pick<D1Database, 'prepare' | 'batch'>) {
  return createStore(createD1Driver(database));
}
