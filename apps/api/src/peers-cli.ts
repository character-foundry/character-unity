import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { createHash, createPublicKey } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openNodeStore } from '@character-unity/store/node';
import { StoreError } from '@character-unity/store';
import type { UnityStore } from '@character-unity/store';
import type { SyncScope, SyncStore } from '@character-unity/store/sync';

const usage = `Unity peer management (local operator only)
  peers list [--after ACTOR] [--limit 1..100]
  peers show --actor URL [--after-key KEY_ID] [--limit 1..100]
  peers workspaces --account ID
  peers grant --actor URL --account ID --workspace ID --scopes pull,publish,fork
  peers scopes --actor URL --scopes pull,publish,fork|none
  peers enable --actor URL
  peers disable --actor URL
  peers add-key --actor URL --key-id URL#ID --public-key-file FILE
  peers rotate-key --actor URL --old-key-id URL#OLD --key-id URL#NEW --public-key-file FILE
  peers revoke-key --actor URL --key-id URL#ID
  peers prune-nonces
  peers keygen --private-key-file FILE --public-key-file FILE

Database commands accept --database FILE or --worker-state DIRECTORY (mutually
exclusive). The default is UNITY_DB_PATH or apps/api/runtime/unity.db. Local D1
uses the same --persist-to DIRECTORY as wrangler dev; remote bindings are disabled.
Stop local dev before migrating an older database. Opening a store applies migrations.

Create the local account with 'accounts create', then its workspace in the hub.
'workspaces' lists up to 100 workspaces for the account. Grants bind one actor to
one existing account/workspace; scopes are explicit, never granted by key import.
Public keys must be Ed25519 SPKI PEM files. No key URL is fetched.
Rotation adds the replacement and permanently revokes the old ID in one transaction.
Disabling a peer preserves its keys and receipts. 'scopes --scopes none' removes all scopes.

keygen needs no database. It writes Ed25519 PKCS8 private/SPKI public PEM to new
files with mode 0600. Existing files are never overwritten. Output contains only
file paths and the SHA-256 fingerprint of the raw public key. Failed file creation
may leave a newly reserved empty file; no existing file is removed or replaced.
All command results and errors are JSON; --help is text. No sync HTTP route is enabled.
`;
class CliError extends Error { constructor(readonly code: string, message: string) { super(message); } }
const commands: Record<string, { required: string[]; optional?: string[] }> = {
  list: { required: [], optional: ['after', 'limit'] }, show: { required: ['actor'], optional: ['after-key', 'limit'] },
  workspaces: { required: ['account'] }, grant: { required: ['actor', 'account', 'workspace', 'scopes'] },
  scopes: { required: ['actor', 'scopes'] }, enable: { required: ['actor'] }, disable: { required: ['actor'] },
  'add-key': { required: ['actor', 'key-id', 'public-key-file'] },
  'rotate-key': { required: ['actor', 'old-key-id', 'key-id', 'public-key-file'] }, 'revoke-key': { required: ['actor', 'key-id'] },
  'prune-nonces': { required: [] }, keygen: { required: ['private-key-file', 'public-key-file'] },
};
const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const fingerprint = (bytes: Uint8Array) => `SHA256:${createHash('sha256').update(bytes).digest('hex')}`;
function scopes(value: string, allowNone: boolean): SyncScope[] {
  if (value === 'none' && allowNone) return [];
  const items = value.split(',');
  if (!items.length || new Set(items).size !== items.length || items.some((item) => !['pull', 'publish', 'fork'].includes(item))) {
    throw new CliError('INVALID_ARGUMENT', 'Use a comma-separated subset of pull,publish,fork; scopes may also be none');
  }
  return items as SyncScope[];
}
function pem(label: string, data: ArrayBuffer) {
  return `-----BEGIN ${label}-----\n${Buffer.from(data).toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`;
}
async function keygen(privatePath: string, publicPath: string) {
  if (resolve(privatePath) === resolve(publicPath)) throw new CliError('INVALID_ARGUMENT', 'Private and public output files must differ');
  const handles: Awaited<ReturnType<typeof open>>[] = [];
  try {
    // Reserve both paths before generating or writing key material.
    handles.push(await open(privatePath, 'wx', 0o600)); handles.push(await open(publicPath, 'wx', 0o600));
    const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const privateBytes = await crypto.subtle.exportKey('pkcs8', keys.privateKey);
    const publicBytes = await crypto.subtle.exportKey('spki', keys.publicKey);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
    await handles[0]!.writeFile(pem('PRIVATE KEY', privateBytes)); await handles[0]!.sync();
    await handles[1]!.writeFile(pem('PUBLIC KEY', publicBytes)); await handles[1]!.sync();
    output({ privateKeyFile: privatePath, publicKeyFile: publicPath, fingerprint: fingerprint(raw) });
  } catch {
    throw new CliError('KEY_FILE_FAILED', 'Key generation or file creation failed; existing files were not overwritten. Newly reserved files may be empty or incomplete');
  } finally { await Promise.all(handles.map((handle) => handle.close())); }
}
async function readPublicKey(path: string) {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 16384) throw new Error('Invalid public key file');
    const bytes = Buffer.alloc(16385);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 16384) throw new Error('Oversized public key');
    const value = bytes.subarray(0, bytesRead).toString('utf8').trim();
    if (!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PUBLIC KEY-----$/.test(value)) throw new Error('Expected only a public SPKI PEM');
    const key = createPublicKey({ key: value, format: 'pem', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('Expected Ed25519');
    const der = new Uint8Array(key.export({ format: 'der', type: 'spki' }));
    return await crypto.subtle.importKey('spki', der, 'Ed25519', true, ['verify']);
  } catch { throw new CliError('INVALID_PUBLIC_KEY', 'Expected a regular, bounded Ed25519 SPKI public PEM file; private keys and symlinks are not accepted'); }
  finally { await file?.close(); }
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['help', '--help', '-h'].includes(command)) { process.stdout.write(usage); return; }
  const spec = commands[command];
  if (!Object.hasOwn(commands, command) || !spec) throw new CliError('INVALID_ARGUMENT', 'Unknown peer command; use --help');
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { process.stdout.write(usage); return; }
  const options = new Map<string, string>();
  const allowed = [...spec.required, ...(spec.optional ?? []), ...(command === 'keygen' ? [] : ['database', 'worker-state'])];
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!, value = args[i + 1], name = flag.slice(2);
    if (!flag.startsWith('--') || !allowed.includes(name) || options.has(name) || !value || value.startsWith('--')) throw new CliError('INVALID_ARGUMENT', 'Invalid or duplicate option; use --help');
    options.set(name, value);
  }
  for (const required of spec.required) if (!options.has(required)) throw new CliError('INVALID_ARGUMENT', `Missing --${required}`);
  if (options.has('database') && options.has('worker-state')) throw new CliError('INVALID_ARGUMENT', 'Choose --database or --worker-state');
  const count = options.get('limit') ?? '50';
  if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(count)) throw new CliError('INVALID_ARGUMENT', '--limit must be between 1 and 100');
  const limit = Number(count);
  const requestedScopes = options.has('scopes') ? scopes(options.get('scopes')!, command === 'scopes') : undefined;
  if (command === 'keygen') { await keygen(options.get('private-key-file')!, options.get('public-key-file')!); return; }
  const publicKey = options.has('public-key-file') ? await readPublicKey(options.get('public-key-file')!) : undefined;
  const path = options.get('database') ?? process.env.UNITY_DB_PATH ?? fileURLToPath(new URL('../runtime/unity.db', import.meta.url));
  if (!options.has('worker-state') && path === ':memory:') throw new CliError('INVALID_ARGUMENT', 'Peer management requires a persistent Unity database');
  let database: { sync: SyncStore; store: UnityStore; close(): unknown } | undefined;
  try {
    if (options.has('worker-state')) {
      const { openLocalWorkerStore } = await import('./worker-local-store.js');
      database = await openLocalWorkerStore(options.get('worker-state')!);
    } else { await mkdir(dirname(path), { recursive: true }); database = await openNodeStore(path); }
    const actor = options.get('actor')!;
    if (command === 'list') {
      const peers = await database.sync.listPeers({ limit, ...(options.has('after') ? { afterActor: options.get('after')! } : {}) });
      output({ peers, nextAfter: peers.length === limit ? peers.at(-1)!.actor : null });
    } else if (command === 'show') {
      const peer = await database.sync.inspectPeer(actor);
      const keys = await database.sync.listKeys(actor, { limit, ...(options.has('after-key') ? { afterKeyId: options.get('after-key')! } : {}) });
      output({ peer, keys: keys.map((key) => ({ ...key, fingerprint: fingerprint(Buffer.from(key.publicKeyHex, 'hex')) })),
        nextAfterKeyId: keys.length === limit ? keys.at(-1)!.keyId : null });
    } else if (command === 'workspaces') {
      const workspaces = await database.store.listWorkspaces(options.get('account')!);
      output({ workspaces, limit: 100, possiblyTruncated: workspaces.length === 100 });
    } else if (command === 'grant') {
      output({ peer: await database.sync.grant({ actor, accountId: options.get('account')!, workspaceId: options.get('workspace')!, scopes: requestedScopes! }) });
    } else if (command === 'scopes') {
      await database.sync.setScopes(actor, requestedScopes!); output({ actor, scopes: requestedScopes });
    } else if (command === 'enable' || command === 'disable') {
      await database.sync.setEnabled(actor, command === 'enable'); output({ actor, enabled: command === 'enable' });
    } else if (command === 'add-key' || command === 'rotate-key') {
      const id = options.get('key-id')!;
      if (command === 'add-key') await database.sync.addKey(actor, id, publicKey!);
      else await database.sync.rotateKey(actor, options.get('old-key-id')!, id, publicKey!);
      const raw = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey!));
      output({ actor, keyId: id, ...(command === 'rotate-key' ? { revokedKeyId: options.get('old-key-id')! } : {}), fingerprint: fingerprint(raw) });
    } else if (command === 'revoke-key') {
      await database.sync.revokeKey(actor, options.get('key-id')!); output({ actor, keyId: options.get('key-id'), revoked: true });
    } else output({ removed: await database.sync.pruneNonces() });
  } finally { await database?.close(); }
}
try { await main(); }
catch (error) {
  const known = error instanceof CliError || error instanceof StoreError;
  const code = known ? error.code : 'OPERATION_FAILED';
  const message = known ? error.message : 'Peer operation failed; check database access, actor/key uniqueness and the enabled account/workspace grant';
  process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`); process.exitCode = 1;
}
