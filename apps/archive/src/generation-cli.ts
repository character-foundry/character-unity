import { basename, dirname, resolve } from 'node:path';
import { buildLexicalGeneration, buildSemanticGeneration } from './generation.js';
import { createDocumentEmbedder } from './embeddings.js';
import { readCopy } from './copy-files.js';
import { ArchiveError } from '@character-unity/archive-client/contract';

const usage = `Build an Archive generation from an explicitly prepared copy
  archive:index lexical --copy DIRECTORY --output NEW_DIRECTORY --as-of UTC_TIMESTAMP
  archive:index semantic --copy DIRECTORY --output NEW_DIRECTORY --as-of UTC_TIMESTAMP
    --embedding-config FILE [--batch-size 32] [--token-budget 24000]

Example timestamp: 2026-10-12T00:00:00.000Z
The output parent must already exist. Existing outputs and paths within the input
are rejected. Requires all legacy search metadata columns. Writes a new SQLite/
object copy and lexical Lance index. Semantic also generates whole-card vectors
using the explicit provider configuration (and UNITY_ARCHIVE_EMBEDDING_KEY for
OpenAI-compatible endpoints). Document text is sent to that provider, in serial
batches of 1–128. The 512–24000 token budget uses the legacy characters/4 estimate,
not a tokenizer; text is truncated to budget*4 characters, with counts reported.
No source writes, live-path discovery, jobs or active-pointer changes. Lexical
never makes model calls. Semantic has no automatic retry or provider fallback.
Only copy-manifest.json marks a published generation. An interrupted build leaves
an incomplete directory for inspection; retry with a new output path.
`;
async function main() {
  const args = process.argv.slice(2);
  if (!args.length || (args.length === 1 && ['--help', '-h', 'help'].includes(args[0]!))) { process.stdout.write(usage); return; }
  if (args[0] !== 'lexical' && args[0] !== 'semantic') throw new ArchiveError('INVALID_INPUT', 'Expected lexical or semantic; use --help');
  const semantic = args[0] === 'semantic';
  const allowed = ['--copy', '--output', '--as-of', ...(semantic ? ['--embedding-config', '--batch-size', '--token-budget'] : [])];
  const options = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index]!, value = args[index + 1];
    if (!allowed.includes(flag) || options.has(flag) || !value || value.startsWith('--')) throw new ArchiveError('INVALID_INPUT', 'Invalid, missing or duplicate option; use --help');
    options.set(flag, value);
  }
  for (const flag of ['--copy', '--output', '--as-of', ...(semantic ? ['--embedding-config'] : [])]) if (!options.has(flag)) throw new ArchiveError('INVALID_INPUT', `Missing ${flag}; use --help`);
  for (const flag of ['--batch-size', '--token-budget']) if (options.has(flag) && !/^[1-9][0-9]{0,4}$/.test(options.get(flag)!)) throw new ArchiveError('INVALID_INPUT', `Invalid ${flag}`);
  const controller = new AbortController();
  const interrupted = () => controller.abort(new Error('Generation interrupted'));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, interrupted);
  try {
    const input = { copy: options.get('--copy')!, output: options.get('--output')!, asOf: options.get('--as-of')! };
    const configPath = semantic ? resolve(options.get('--embedding-config')!) : undefined;
    const config = configPath ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode((await readCopy(dirname(configPath), basename(configPath), 16384, true)).bytes)) : undefined;
    const report = semantic ? await buildSemanticGeneration(input, { embedder: createDocumentEmbedder(config, process.env.UNITY_ARCHIVE_EMBEDDING_KEY ?? ''),
      ...(options.has('--batch-size') ? { batchSize: Number(options.get('--batch-size')) } : {}),
      ...(options.has('--token-budget') ? { tokenBudget: Number(options.get('--token-budget')) } : {}),
    }, controller.signal) : await buildLexicalGeneration(input, controller.signal);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally { for (const signal of ['SIGINT', 'SIGTERM'] as const) process.removeListener(signal, interrupted); }
}
try { await main(); }
catch (error) {
  // Do not echo SQLite rows, object text, native error bodies or credentials.
  process.stderr.write(`${JSON.stringify({ error: error instanceof ArchiveError ? error.code : 'GENERATION_FAILED', message: error instanceof ArchiveError ? error.message : 'Generation failed or interrupted; inspect the output and retry with a new directory' })}\n`);
  process.exitCode = 1;
}
