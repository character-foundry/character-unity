import type { StoreDriver } from './driver.js';
import { migrations } from './schema.js';
import { StoreError } from './types.js';

export const schemaVersion = migrations.at(-1)!.version;
interface Applied { version: number; name: string; checksum: string }

async function checksum(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function inspectSchema(driver: StoreDriver): Promise<number> {
  const rows = await driver.query<Applied>({ sql: 'SELECT version, name, checksum FROM unity_migrations ORDER BY version' });
  for (const [index, row] of rows.entries()) {
    const migration = migrations[index];
    if (!migration || row.version !== migration.version || row.name !== migration.name
      || row.checksum !== await checksum(JSON.stringify(migration.statements))) {
      throw new StoreError('SCHEMA_MISMATCH', 'Unknown, modified or non-contiguous Unity migration history');
    }
  }
  return rows.at(-1)?.version ?? 0;
}

/** Administrative operation, never called by the Worker request path. */
export async function migrate(driver: StoreDriver): Promise<void> {
  const tables = await driver.query<{ name: string }>({
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'",
  });
  if (tables.length && !tables.some((table) => table.name === 'unity_migrations')) {
    throw new StoreError('SCHEMA_MISMATCH', 'Refusing to initialize Unity in a database owned by another application');
  }
  await driver.batch([{ sql: `CREATE TABLE IF NOT EXISTS unity_migrations (
    version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
  )` }]);
  const current = await inspectSchema(driver);
  for (const migration of migrations.filter((item) => item.version > current)) {
    try {
      await driver.batch([
        ...migration.statements.map((sql) => ({ sql })),
        { sql: 'INSERT INTO unity_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
          params: [migration.version, migration.name, await checksum(JSON.stringify(migration.statements)), new Date().toISOString()] },
      ]);
    } catch (error) {
      // Another starter may have applied this exact migration after our initial read.
      // Revalidate its checksum; never suppress a failed migration with no committed history.
      if (await inspectSchema(driver) < migration.version) throw error;
    }
  }
}
