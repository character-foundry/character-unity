import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openNodeStore } from '@character-unity/store/node';
import { publicAccountActorUri } from '@character-unity/store/accounts';
import type { AccountStore } from '@character-unity/store/accounts';

const usage = `Unity account management
  accounts create --name NAME --key-file FILE [--actor-uri HTTPS_URI] [--database FILE]
  accounts list [--after ID] [--database FILE]
  accounts rotate --id ID --key-file FILE [--database FILE]
  accounts disable --id ID [--database FILE]
  accounts enable --id ID [--database FILE]
  accounts migrate --worker-state DIRECTORY

Use --worker-state DIRECTORY instead of --database to manage a local Worker D1
simulation. Start wrangler dev with the same --persist-to DIRECTORY. No remote
bindings or Cloudflare account are accessed. Stop local dev during migrations.

Key files are created exclusively with mode 0600; existing files are never overwritten.
Database defaults to UNITY_DB_PATH or apps/api/runtime/unity.db. No server is required.
The optional public actor URI is immutable. Without it, new accounts retain local URN identities.
Rotation and disabling revoke all sessions. There is no public account-creation route.
`;
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['help', '--help', '-h'].includes(command)) { process.stdout.write(usage); return; }
  const allowed: Record<string, string[]> = { create: ['name', 'key-file', 'actor-uri'], list: ['after'], rotate: ['id', 'key-file'], disable: ['id'], enable: ['id'], migrate: [] };
  if (!Object.hasOwn(allowed, command)) throw new Error('Unknown account command; use --help');
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!, value = args[i + 1];
    const key = flag.slice(2);
    if (!flag.startsWith('--') || ![...allowed[command]!, 'database', 'worker-state'].includes(key) || options.has(key)
      || !value || value.startsWith('--')) throw new Error('Invalid or duplicate option; use --help');
    options.set(key, value);
  }
  for (const key of command === 'list' ? [] : allowed[command]!.filter((key) => key !== 'actor-uri')) if (!options.has(key)) throw new Error(`Missing --${key}`);
  if (options.has('database') && options.has('worker-state')) throw new Error('Choose --database or --worker-state, not both');
  if (command === 'migrate' && !options.has('worker-state')) throw new Error('Worker migration requires --worker-state');
  const path = options.get('database') ?? process.env.UNITY_DB_PATH ?? fileURLToPath(new URL('../runtime/unity.db', import.meta.url));
  if (!options.has('worker-state') && path === ':memory:') throw new Error('Account management requires a persistent Unity database');
  const actorUri = options.has('actor-uri') ? publicAccountActorUri(options.get('actor-uri')!) : undefined;
  const keyPath = options.get('key-file');
  // Reserve the output before changing credentials, so an existing/misconfigured
  // destination cannot silently rotate a usable account key.
  const output = keyPath ? await open(keyPath, 'wx', 0o600) : undefined;
  let database: { accounts: AccountStore; close(): unknown } | undefined;
  let changedAccount: string | undefined;
  try {
    if (options.has('worker-state')) {
      const { openLocalWorkerStore } = await import('./worker-local-store.js');
      database = await openLocalWorkerStore(options.get('worker-state')!);
    } else {
      await mkdir(dirname(path), { recursive: true });
      database = await openNodeStore(path);
    }
    if (command === 'migrate') {
      process.stdout.write(`${JSON.stringify({ status: 'ready', storage: 'local-worker' })}\n`);
    } else if (command === 'list') {
      const accounts = await database.accounts.list({ limit: 100, ...(options.has('after') ? { afterId: options.get('after')! } : {}) });
      process.stdout.write(`${JSON.stringify({ accounts, nextAfter: accounts.length === 100 ? accounts.at(-1)!.id : null })}\n`);
    } else if (command === 'create' || command === 'rotate') {
      const result = command === 'create' ? await database.accounts.create(options.get('name')!, actorUri ? { actorUri } : {}) : await database.accounts.rotateKey(options.get('id')!);
      changedAccount = 'account' in result ? result.account.id : result.accountId;
      await output!.writeFile(`${JSON.stringify(result, null, 2)}\n`); await output!.sync();
      process.stdout.write(`${JSON.stringify({ accountId: changedAccount, keyFile: keyPath })}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(await database.accounts.setEnabled(options.get('id')!, command === 'enable'))}\n`);
    }
  } catch (error) {
    if (changedAccount) throw new Error(`Account ${changedAccount} changed but writing its key file failed; rotate it to a new writable file`, { cause: error });
    throw error;
  } finally { await database?.close(); await output?.close(); }
}
try { await main(); }
catch (error) {
  // Do not log database SQL, credential hashes, tokens or a nested cause.
  const message = error instanceof Error ? error.message : 'Account operation failed';
  process.stderr.write(`Account operation failed: ${message}\n`); process.exitCode = 1;
}
