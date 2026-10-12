export type SqlValue = string | number | null;
export interface Statement { sql: string; params?: readonly SqlValue[] }

/** Internal driver seam. Each batch MUST commit all statements or none. No async callbacks. */
export interface StoreDriver {
  query<T>(statement: Statement): Promise<T[]>;
  batch(statements: readonly Statement[]): Promise<readonly number[]>;
}
