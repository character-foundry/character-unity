import Database from 'better-sqlite3';
import { createNodeDriver } from '@character-unity/store/node';
import { createAssetMaintenanceStore } from '@character-unity/store/asset-maintenance';
import { inspectSchema, schemaVersion } from '@character-unity/store/migrations';
import { createNodeBlobRemover } from '@character-unity/blob-store/node-maintenance';
import type { BlobRemover } from '@character-unity/blob-store/maintenance';
import { sweepRetiredAssets } from '@character-unity/assets/maintenance';

const usage = `Unity asset maintenance (explicit operator commands; no remote resources)
  assets preview --database FILE --before UTC_TIMESTAMP [--after ID] [--limit 1..100]
  assets retire --database FILE --before UTC_TIMESTAMP --id ID [--id ID ...]
  assets sweep --database FILE --blob-dir DIRECTORY [--after ID] [--limit 1..100]

Use --worker-state DIRECTORY instead of --database/--blob-dir for local D1/R2.
Run migrations first. These commands do not initialize or migrate a database.
Timestamps use YYYY-MM-DDTHH:mm:ss.sssZ and must be at least 24 hours old.
Preview identifies unreferenced assets; retire rechecks exact IDs atomically.
Retirement is permanent. Sweep deletes only retired keys and can be retried.
Repeat complete sweeps from the beginning after uploads have quiesced: a delayed
upload can recreate unreachable bytes, so retirement records are never removed.
Node database and blob directory must be the matching Unity-owned pair.
`;
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['--help', '-h', 'help'].includes(command)) { process.stdout.write(usage); return; }
  if (!['preview', 'retire', 'sweep'].includes(command)) throw new Error('Unknown command; use --help');
  const options = new Map<string, string>(), ids: string[] = [];
  const allowed = command === 'retire' ? ['before', 'id'] : command === 'preview' ? ['before', 'after', 'limit'] : ['blob-dir', 'after', 'limit'];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!, value = args[index + 1], key = flag.slice(2);
    if (!flag.startsWith('--') || ![...allowed, 'database', 'worker-state'].includes(key) || !value || value.startsWith('--')
      || (key !== 'id' && options.has(key))) throw new Error('Invalid or duplicate option; use --help');
    if (key === 'id') ids.push(value); else options.set(key, value);
  }
  if (Number(options.has('database')) + Number(options.has('worker-state')) !== 1) throw new Error('Choose exactly one explicit --database or --worker-state');
  if (options.has('worker-state') && options.has('blob-dir')) throw new Error('Local Worker cleanup uses its R2 binding; omit --blob-dir');
  if (command !== 'sweep' && !options.has('before')) throw new Error('Missing --before');
  if (command === 'retire' && (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length)) throw new Error('Pass 1–100 unique --id values from the preview');
  if (command === 'sweep' && options.has('database') && !options.has('blob-dir')) throw new Error('Sweep requires the matching --blob-dir');
  const page = { limit: options.has('limit') ? Number(options.get('limit')) : 50, ...(options.has('after') ? { afterId: options.get('after')! } : {}) };
  if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100) throw new Error('Limit must be 1–100');
  let close: (() => void | Promise<void>) | undefined;
  try {
    let maintenance: ReturnType<typeof createAssetMaintenanceStore>, remover: BlobRemover | undefined;
    if (options.has('worker-state')) {
      const { openLocalWorkerStore } = await import('./worker-local-store.js');
      const opened = await openLocalWorkerStore(options.get('worker-state')!, { migrate: false });
      close = opened.close; maintenance = opened.maintenance; remover = opened.retiredBlobs;
    } else {
      const path = options.get('database')!;
      if (path === ':memory:') throw new Error('Maintenance requires an existing persistent Unity database');
      const db = new Database(path, { readonly: command !== 'retire', fileMustExist: true });
      close = () => { db.close(); };
      const driver = createNodeDriver(db);
      if (await inspectSchema(driver) !== schemaVersion) throw new Error('Migrate the Unity schema before maintenance');
      maintenance = createAssetMaintenanceStore(driver);
      if (command === 'sweep') remover = await createNodeBlobRemover(options.get('blob-dir')!);
    }
    let result: unknown;
    if (command === 'preview') {
      const assets = await maintenance.preview(options.get('before')!, page);
      result = { assets, nextAfter: assets.length === page.limit ? assets.at(-1)!.id : null };
    } else if (command === 'retire') result = await maintenance.retire(ids, options.get('before')!);
    else {
      const swept = await sweepRetiredAssets(maintenance, remover!, page);
      if (swept.results.some((item) => item.status === 'failed')) process.exitCode = 1;
      result = swept;
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { await close?.(); }
}
try { await main(); } catch (error) {
  process.stderr.write(`Asset maintenance failed: ${error instanceof Error ? error.message : 'Unknown error'}\n`); process.exitCode = 1;
}
