import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir, realpath, rename } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { connect, Index, makeArrowTable } from '@lancedb/lancedb';
import { ArchiveError, limits } from '@character-unity/archive-client/contract';
import { readCopy } from './copy-files.js';
import { openCopiedArchive } from './copied.js';
import { openCopiedSearch } from './copied-search.js';
import { buildSearchDocument, scoringDate, searchDocumentSchema, searchSourceColumns } from './search-document.js';
import { prepareVectorGeneration } from './vector-generation.js';
import type { SemanticGenerationOptions } from './vector-generation.js';

interface CopyManifest {
  version: string; archiveId: string; database: { path: string; sha256: string };
  cards: { id: string; original: { path: string; mediaType: string }; assets: { id: string; file: { path: string; mediaType: string } | null; binding?: unknown }[] }[];
  search?: unknown;
}
function invalid(message: string): never { throw new ArchiveError('INVALID_INPUT', message); }
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

interface GenerationInput { copy: string; output: string; asOf: string }
/** Lexical builds cannot make provider requests. Semantic builds require an
 * explicitly supplied document embedder and share the same publication boundary. */
export const buildLexicalGeneration = (input: GenerationInput, signal?: AbortSignal) => buildGeneration(input, signal);
export const buildSemanticGeneration = (input: GenerationInput, options: SemanticGenerationOptions, signal?: AbortSignal) => buildGeneration(input, signal, options);
async function buildGeneration(input: GenerationInput, signal?: AbortSignal, semantic?: SemanticGenerationOptions) {
  const kind = semantic ? 'semantic' : 'lexical';
  const asOf = scoringDate(input.asOf), root = resolve(input.copy), output = resolve(input.output);
  if (output === root || output.startsWith(`${root}${sep}`) || root.startsWith(`${output}${sep}`)) invalid('Generation output must be separate from its input copy');
  if (await realpath(dirname(output)) !== dirname(output) || !(await lstat(dirname(output))).isDirectory()) invalid('Output parent must already exist without symlink components');
  try { await lstat(output); invalid('Generation output already exists; choose a new directory'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  signal?.throwIfAborted();
  const captured = await readCopy(root, 'copy-manifest.json', limits.jsonBytes, true);
  const source = await openCopiedArchive(root), status = source.status();
  if ((await readCopy(root, 'copy-manifest.json', limits.jsonBytes, false)).hash !== captured.hash) throw new ArchiveError('SNAPSHOT_CHANGED', 'Input manifest changed during validation');
  // openCopiedArchive has validated all fields, paths, selected IDs and objects.
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(captured.bytes)) as CopyManifest;
  if (!manifest.cards.length) invalid('A lexical generation requires at least one selected card');
  const plans = new Map<string, { path: string; hash: string; bytes: number; max: number }>();
  const database = await readCopy(root, manifest.database.path, 1024 ** 3, false);
  if (database.hash !== manifest.database.sha256) throw new ArchiveError('INTEGRITY', 'Input database changed');
  plans.set('archive.sqlite', { path: manifest.database.path, hash: database.hash, bytes: database.byteLength, max: 1024 ** 3 });
  let total = database.byteLength;
  const cards = [...manifest.cards].sort((a, b) => compare(a.id, b.id)).map((entry) => {
    const card = source.card(status.snapshot, entry.id).card;
    function plan(file: { path: string; mediaType: string }, object: { hash: string; byteLength: number }) {
      const path = `objects/${object.hash}`;
      if (!plans.has(path)) { total += object.byteLength; plans.set(path, { path: file.path, hash: object.hash, bytes: object.byteLength, max: limits.objectBytes }); }
      return { path, mediaType: file.mediaType };
    }
    return { id: entry.id, original: plan(entry.original, card.original), assets: entry.assets.map((asset) => {
      const indexed = card.assets.find((value) => value.id === asset.id)!;
      return { ...asset, file: asset.file && indexed.availability === 'available' ? plan(asset.file, indexed.object) : null };
    }) };
  });
  if (total > 4 * 1024 ** 3) throw new ArchiveError('TOO_LARGE', 'Generation copied database and unique objects exceed 4 GiB');
  // Read only required physical columns; never import the legacy initializer.
  const db = new Database(database.target, { readonly: true, fileMustExist: true });
  const documents: ReturnType<typeof buildSearchDocument>[] = []; let metadataBytes = 0;
  try {
    db.pragma('query_only = ON'); db.pragma('trusted_schema = OFF'); db.defaultSafeIntegers(true);
    const columns = new Set((db.prepare('PRAGMA table_info(cards)').all() as { name: string }[]).map((field) => field.name));
    for (const name of searchSourceColumns) if (!columns.has(name)) invalid(`Copied database lacks search column ${name}`);
    const size = db.prepare(`SELECT (${searchSourceColumns.map((name) => `COALESCE(length(CAST("${name}" AS BLOB)), 0)`).join(' + ')}) AS bytes FROM cards WHERE id = ?`);
    const statement = db.prepare(`SELECT ${searchSourceColumns.map((name) => `"${name}"`).join(', ')} FROM cards WHERE id = ?`);
    db.exec('BEGIN');
    for (const card of cards) {
      signal?.throwIfAborted();
      const measured = size.get(card.id) as { bytes: bigint } | undefined;
      if (!measured || measured.bytes > 1_048_576n) throw new ArchiveError('TOO_LARGE', 'Search input row exceeds 1 MiB or is missing');
      const row = statement.get(card.id) as Record<string, unknown> | undefined;
      if (!row || String(row.id) !== card.id) invalid('Selected search row is missing');
      // Bound the projection before constructing Arrow buffers.
      const rowBytes = Buffer.byteLength(JSON.stringify(row, (_, value) => typeof value === 'bigint' ? String(value) : value));
      if (rowBytes > 1024 ** 2) throw new ArchiveError('TOO_LARGE', 'Search input row exceeds 1 MiB');
      const document = buildSearchDocument(row, asOf);
      metadataBytes += Buffer.byteLength(JSON.stringify(document));
      if (metadataBytes > 64 * 1024 ** 2) throw new ArchiveError('TOO_LARGE', 'Search projection exceeds 64 MiB');
      documents.push(document);
    }
    db.exec('ROLLBACK');
  } finally { db.close(); }
  const vectorPlan = semantic ? prepareVectorGeneration(documents, semantic) : undefined;
  if ((await readCopy(root, manifest.database.path, 1024 ** 3, false)).hash !== database.hash) throw new ArchiveError('SNAPSHOT_CHANGED', 'Input database changed during projection');
  signal?.throwIfAborted();
  await mkdir(output, { mode: 0o700 }); // Exclusive reservation; never merge/replace.
  await mkdir(join(output, 'objects'), { mode: 0o700 });
  async function write(name: string, value: unknown) {
    const json = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(json) > limits.jsonBytes) throw new ArchiveError('TOO_LARGE', 'Generated manifest exceeds the copy JSON limit');
    const handle = await open(join(output, name), 'wx', 0o600);
    try { await handle.writeFile(json); await handle.sync(); }
    finally { await handle.close(); }
  }
  // On failure keep the reserved directory for inspection, without a readable
  // top-level copy manifest. Retrying must use a new output path.
  await write('generation.json', { version: 'unity.archive-generation.v1', state: 'building', kind, inputSnapshot: status.snapshot, asOf: input.asOf,
    ...(vectorPlan ? { embeddings: vectorPlan.summary } : {}) });
  for (const [path, plan] of plans) {
    signal?.throwIfAborted();
    const before = await readCopy(root, plan.path, plan.max, false);
    if (before.hash !== plan.hash || before.byteLength !== plan.bytes) throw new ArchiveError('INTEGRITY', 'Input object changed before generation copy');
    await copyFile(before.target, join(output, path), constants.COPYFILE_EXCL);
    const copied = await readCopy(output, path, plan.max, false);
    if (copied.hash !== plan.hash || copied.byteLength !== plan.bytes) throw new ArchiveError('INTEGRITY', 'Generation copy bytes do not match their input');
  }
  signal?.throwIfAborted();
  const connection = await connect(join(output, 'search.lance')); let version: number;
  let vectors: Awaited<ReturnType<NonNullable<typeof vectorPlan>['write']>> | undefined;
  try {
    const table = await connection.createTable('cards', makeArrowTable(documents, { schema: searchDocumentSchema }));
    try {
      await table.createIndex('searchText', { config: Index.fts({ withPosition: true, lowercase: true, asciiFolding: true }) });
      version = await table.version();
    } finally { table.close(); }
    if (vectorPlan) vectors = await vectorPlan.write(connection, signal);
  } finally { connection.close(); }
  const files: { path: string; sha256: string }[] = []; let indexBytes = 0, entries = 0;
  async function inventory(prefix = '', depth = 0): Promise<void> {
    if (depth > 16) invalid('Generated index exceeds directory depth limit');
    for (const entry of (await readdir(join(output, 'search.lance', prefix), { withFileTypes: true })).sort((a, b) => compare(a.name, b.name))) {
      signal?.throwIfAborted();
      if (++entries > 8192) invalid('Generated index has too many entries');
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await inventory(`${path}/`, depth + 1);
      else {
        if (!entry.isFile() || files.length >= 4096) invalid('Generated index has invalid or too many files');
        const file = await readCopy(join(output, 'search.lance'), path, 512 * 1024 ** 2 - indexBytes, false);
        indexBytes += file.byteLength; files.push({ path, sha256: file.hash });
      }
    }
  }
  await inventory();
  const search = { path: 'search.lance', table: 'cards', version, files, ...(vectors ? { vector: vectors.manifest } : {}) };
  await openCopiedSearch(output, search, cards.map((card) => card.id));
  // Revalidate the entire input selection, including old search generations and
  // every mapped source object, immediately before publishing the new copy.
  if ((await openCopiedArchive(root)).status().snapshot !== status.snapshot) throw new ArchiveError('SNAPSHOT_CHANGED', 'Input selection changed during generation');
  const result = { version: manifest.version, archiveId: manifest.archiveId, database: { path: 'archive.sqlite', sha256: database.hash }, cards, search };
  const report = { version: 'unity.archive-generation.v1', state: 'ready', kind, inputSnapshot: status.snapshot, inputManifestSha256: captured.hash,
    asOf: input.asOf, projection: 'archive-b99dcd1-utc-v1', rowSha256: digest(JSON.stringify(documents)), cardCount: cards.length, copiedBytes: total, indexBytes,
    replacedSearch: manifest.search !== undefined, vectorsGenerated: Boolean(vectors), ...(vectors ? { embeddings: vectors.report } : {}), output };
  await write('generation.ready.json', report);
  await write('copy-manifest.pending.json', result);
  signal?.throwIfAborted();
  await rename(join(output, 'generation.ready.json'), join(output, 'generation.json'));
  await rename(join(output, 'copy-manifest.pending.json'), join(output, 'copy-manifest.json'));
  const directory = await open(output, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await directory.sync(); } finally { await directory.close(); }
  return report;
}
