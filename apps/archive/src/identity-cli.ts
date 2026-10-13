import { openExistingArchive } from './existing/store.js';
import { openNativeArchive } from './native/store.js';

const usage = 'Usage: pnpm --filter @character-unity/archive identity [--limit 1..100] [--after CURSOR]\nSet UNITY_ARCHIVE_MODE=existing with UNITY_ARCHIVE_DATABASE_PATH, UNITY_ARCHIVE_FILES_DIR and UNITY_ARCHIVE_OBJECT_DIR, or MODE=native with UNITY_ARCHIVE_DATA_DIR. Runs one bounded batch, prints JSON and exits. Existing-mode writer takeover safeguards apply; this never starts a scheduler or copies originals.';
const args = process.argv.slice(2);
if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); process.exit(0); }
const values = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  const key = args[i], value = args[i + 1];
  if (!key || !['--limit', '--after'].includes(key) || values.has(key) || !value || value.startsWith('--')) throw new Error(usage);
  values.set(key, value);
}
const rawLimit = values.get('--limit') ?? '16';
if (!/^[1-9][0-9]{0,2}$/.test(rawLimit) || Number(rawLimit) > 100) throw new Error(usage);
if (process.env.UNITY_ARCHIVE_READ_ONLY === '1') throw new Error('Identity indexing is an explicit writer operation, not a read-only connection');
const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required.\n${usage}`); return value; };
const mode = process.env.UNITY_ARCHIVE_MODE;
const archive = mode === 'existing' ? await openExistingArchive({ databasePath: required('UNITY_ARCHIVE_DATABASE_PATH'),
  filesDirectory: required('UNITY_ARCHIVE_FILES_DIR'), objectsDirectory: required('UNITY_ARCHIVE_OBJECT_DIR') })
  : mode === 'native' ? await openNativeArchive(required('UNITY_ARCHIVE_DATA_DIR')) : (() => { throw new Error(usage); })();
try {
  const after = values.get('--after');
  const result = await archive.indexIdentities({ limit: Number(rawLimit), ...(after === undefined ? {} : { after }) });
  console.log(JSON.stringify({ archiveId: archive.archiveId, ...result }));
} finally { archive.close(); }
