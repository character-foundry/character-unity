import { createHash } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { connect } from '@lancedb/lancedb';
import { fixtureInventory } from './browser-search-fixture.js';

const originalTables = ['cards', 'card_vectors'] as const;
const projectionTable = 'unity_library_search_v1';
type Inventory = Record<string, string>;
export interface NativeArchiveInvariant {
  sqlite: { schema: string; userVersion: number; tables: Record<string, { count: number; rows: string }> };
  originals: Inventory;
  versions: Inventory;
  lance: { tables: Record<string, { version: number; schema: string; indices: string; count: number; rows: string }>; files: Inventory };
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return { integer: item.toString() };
    if (item instanceof Uint8Array) return { bytes: Buffer.from(item).toString('hex') };
    if (item instanceof Map) return Object.fromEntries([...item.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))));
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  });
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function rowsDigest(rows: unknown[]): string { return digest(rows.map(canonical).sort()); }

/** Synthetic fixtures only. Logical SQL avoids WAL/checkpoint false positives;
 * immutable file inventories additionally detect same-row/index rewrites. */
export async function captureNativeArchiveInvariant(root: string): Promise<NativeArchiveInvariant> {
  const db = new Database(join(root, 'cards.db'), { readonly: true, fileMustExist: true });
  let sqlite: NativeArchiveInvariant['sqlite'];
  try {
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    const tables: NativeArchiveInvariant['sqlite']['tables'] = {};
    for (const { name } of db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]) {
      const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" LIMIT 10001`).all();
      if (rows.length > 10000) throw new Error('The disposable Archive SQL fixture exceeds its verification bound');
      tables[name] = { count: rows.length, rows: rowsDigest(rows) };
    }
    sqlite = { schema: digest(schema), userVersion: db.pragma('user_version', { simple: true }) as number, tables };
  } finally { db.close(); }
  const connection = await connect(join(root, 'search.lance'), { readConsistencyInterval: 0 });
  const tables: NativeArchiveInvariant['lance']['tables'] = {};
  try {
    const names = await connection.tableNames();
    if (originalTables.some(name => !names.includes(name)) || names.some(name => !originalTables.includes(name as typeof originalTables[number]) && name !== projectionTable)) {
      throw new Error('The disposable Archive has unexpected original Lance tables');
    }
    for (const name of originalTables) {
      const table = await connection.openTable(name);
      try {
        const count = await table.countRows();
        if (count > 1000) throw new Error('The disposable Archive Lance fixture exceeds its verification bound');
        const schema = await table.schema();
        const rows = await table.query().limit(Math.max(1, count + 1)).toArray();
        tables[name] = { version: await table.version(), count, rows: rowsDigest(rows.map(row => row.toJSON())),
          schema: digest({ fields: schema.fields.map(field => ({ name: field.name, type: String(field.type), nullable: field.nullable, metadata: field.metadata })), metadata: schema.metadata }),
          indices: digest((await table.listIndices()).map(canonical).sort()),
        };
      } finally { table.close(); }
    }
  } finally { connection.close(); }
  const inventory = await fixtureInventory(join(root, 'search.lance'));
  // Verified against a newly created local SDK fixture: NativeTable.display()
  // reports <root>/<name>.lance, and readdir returns exactly that directory.
  // Fail explicitly if that disposable layout changes; never infer live paths.
  for (const name of originalTables) if (inventory[`${name}.lance/`] !== 'directory') throw new Error('The disposable Lance table layout changed');
  const projectionDirectory = `${projectionTable}.lance/`;
  const files = Object.fromEntries(Object.entries(inventory).filter(([path]) => !path.startsWith(projectionDirectory)));
  return { sqlite, originals: await fixtureInventory(join(root, 'files')), versions: await fixtureInventory(join(root, 'versions')), lance: { tables, files } };
}

export async function assertNativeArchiveInvariant(root: string, before: NativeArchiveInvariant): Promise<void> {
  const after = await captureNativeArchiveInvariant(root);
  for (const [label, actual, expected] of [
    ['SQLite logical rows/schema', after.sqlite, before.sqlite], ['accepted original files', after.originals, before.originals],
    ['retained version objects', after.versions, before.versions], ['original Lance tables and files', after.lance, before.lance],
  ] as const) {
    if (canonical(actual) !== canonical(expected)) throw new Error(`Archive immutability failed: ${label} changed`);
  }
}
