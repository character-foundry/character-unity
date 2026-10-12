import { mkdtemp, readFile, rm, stat, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { build } from 'esbuild';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openNodeStore } from '@character-unity/store/node';
import { signSyncHttp, verifySyncHttp, createSyncToken } from '@character-foundry/character-foundry/sync';
import { openLocalWorkerStore } from './worker-local-store.js';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/peers-cli.js', import.meta.url));
const actor = 'https://sender.example/actors/one';
beforeAll(async () => {
  await build({ entryPoints: [fileURLToPath(new URL('./peers-cli.ts', import.meta.url))], outfile: cli,
    bundle: true, platform: 'node', target: 'node24', format: 'esm', external: ['better-sqlite3', 'wrangler'] });
});
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'unity-peers-cli-')); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
async function run(...args: string[]) {
  const result = await execute(process.execPath, [cli, ...args], { timeout: 30_000, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  return { ...result, value: JSON.parse(result.stdout) };
}
async function rejected(...args: string[]) {
  try { await run(...args); throw new Error('Expected command failure'); }
  catch (error) {
    const result = error as Error & { code?: number; stdout?: string; stderr?: string };
    expect(result.code).not.toBe(0); expect(result.stdout).toBe('');
    return JSON.parse(result.stderr!);
  }
}
async function generated(name: string) {
  const privatePath = join(root, `${name}.private.pem`), publicPath = join(root, `${name}.public.pem`);
  const command = await run('keygen', '--private-key-file', privatePath, '--public-key-file', publicPath);
  const secret = await readFile(privatePath, 'utf8');
  const der = new Uint8Array(createPrivateKey(secret).export({ format: 'der', type: 'pkcs8' }));
  const privateKey = await crypto.subtle.importKey('pkcs8', der, 'Ed25519', false, ['sign']);
  return { privatePath, publicPath, command, secret, privateKey };
}

it('generates exclusive restricted key files without emitting secrets, and refuses invalid commands before touching a database', async () => {
  const keys = await generated('first');
  expect(keys.command.stdout + keys.command.stderr).not.toContain(keys.secret);
  expect(keys.command.stdout + keys.command.stderr).not.toContain('BEGIN PRIVATE KEY');
  expect(keys.command.value.fingerprint).toMatch(/^SHA256:[a-f0-9]{64}$/);
  expect((await stat(keys.privatePath)).mode & 0o777).toBe(0o600);
  expect((await stat(keys.publicPath)).mode & 0o777).toBe(0o600);
  await rejected('keygen', '--private-key-file', keys.privatePath, '--public-key-file', join(root, 'new.pem'));
  expect(await readFile(keys.privatePath, 'utf8')).toBe(keys.secret);
  const empty = join(root, 'reserved.pem');
  await rejected('keygen', '--private-key-file', empty, '--public-key-file', keys.publicPath);
  expect(await readFile(empty, 'utf8')).toBe('');
  const untouched = join(root, 'untouched.db');
  for (const args of [
    ['grant', '--actor', actor], ['list', '--limit', '0'], ['list', '--limit', '101'], ['list', '--after', actor, '--after', actor],
    ['list', '--worker-state', join(root, 'state')], ['scopes', '--actor', actor, '--scopes', 'pull,pull'],
    ['grant', '--actor', actor, '--account', 'one', '--workspace', 'two', '--scopes', 'none'],
  ]) expect((await rejected(...args, '--database', untouched)).error.code).toBe('INVALID_ARGUMENT');
  for (const path of [keys.privatePath, join(root, 'missing.pem')]) {
    expect((await rejected('add-key', '--actor', actor, '--key-id', `${actor}#one`, '--public-key-file', path, '--database', untouched)).error.code).toBe('INVALID_PUBLIC_KEY');
  }
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'pem', type: 'spki' });
  const invalidFiles = [join(root, 'rsa.pem'), join(root, 'oversized.pem'), join(root, 'linked.pem')];
  await writeFile(invalidFiles[0]!, rsa); await writeFile(invalidFiles[1]!, 'x'.repeat(16385)); await symlink(keys.publicPath, invalidFiles[2]!);
  for (const path of invalidFiles) expect((await rejected('add-key', '--actor', actor, '--key-id', `${actor}#one`, '--public-key-file', path, '--database', untouched)).error.code).toBe('INVALID_PUBLIC_KEY');
  await expect(stat(untouched)).rejects.toMatchObject({ code: 'ENOENT' });
  const help = await execute(process.execPath, [cli, 'grant', '--help']); expect(help.stdout).toContain('remote bindings are disabled');
}, 30_000);

for (const adapter of ['sqlite', 'd1'] as const) describe(`peer operator / ${adapter}`, () => {
  it('configures persisted grants and rotated keys usable by the public verifier, with explicit scopes and revocation', async () => {
    const path = join(root, adapter === 'sqlite' ? 'unity.db' : 'state');
    const flags = [adapter === 'sqlite' ? '--database' : '--worker-state', path];
    const open = () => adapter === 'sqlite' ? openNodeStore(path) : openLocalWorkerStore(path);
    const first = await generated('one'), second = await generated('two');
    const setup = await open();
    let accountId: string; let workspaceId: string;
    try {
      accountId = (await setup.accounts.create('Receiver')).account.id;
      workspaceId = (await setup.store.createWorkspace({ ownerId: accountId, name: 'Inbox desk' })).id;
    } finally { await setup.close(); }
    const command = (...args: string[]) => run(...args, ...flags);
    expect((await command('workspaces', '--account', accountId)).value.workspaces).toMatchObject([{ id: workspaceId }]);
    await command('grant', '--actor', actor, '--account', accountId, '--workspace', workspaceId, '--scopes', 'pull,publish');
    await command('add-key', '--actor', actor, '--key-id', `${actor}#one`, '--public-key-file', first.publicPath);
    const initial = (await command('show', '--actor', actor)).value;
    expect(initial.peer).toMatchObject({ actor, accountId, workspaceId, enabled: true, accountEnabled: true, scopes: ['publish', 'pull'] });
    expect(initial.keys).toMatchObject([{ keyId: `${actor}#one`, revoked: false, fingerprint: first.command.value.fingerprint }]);
    expect((await command('list', '--limit', '1')).value).toMatchObject({ peers: [{ actor }], nextAfter: actor });
    expect((await command('list', '--after', actor)).value.peers).toEqual([]);
    const signed = await signSyncHttp({ actor, keyId: `${actor}#one`, privateKey: first.privateKey, requestId: createSyncToken(), method: 'POST',
      url: 'https://receiver.example/sync/publish', body: new TextEncoder().encode('{}'), contentType: 'application/json' });
    const receiver = await open();
    let originalNonce: string;
    try {
      originalNonce = (await verifySyncHttp(signed, { resolveKey: (actor, id) => receiver.sync.resolveKey(actor, id, 'publish'),
        consumeNonce: (claim) => receiver.sync.consumeNonce(claim, 'publish') })).nonce;
    } finally { await receiver.close(); }
    await command('disable', '--actor', actor); expect((await command('show', '--actor', actor)).value.peer.enabled).toBe(false);
    await command('enable', '--actor', actor); await command('scopes', '--actor', actor, '--scopes', 'none');
    expect((await command('show', '--actor', actor)).value.peer.scopes).toEqual([]);
    await command('scopes', '--actor', actor, '--scopes', 'publish');
    await command('rotate-key', '--actor', actor, '--old-key-id', `${actor}#one`, '--key-id', `${actor}#two`, '--public-key-file', second.publicPath);
    const shown = (await command('show', '--actor', actor, '--limit', '1')).value;
    expect(shown.keys).toMatchObject([{ keyId: `${actor}#one`, revoked: true }]);
    expect(shown.nextAfterKeyId).toBe(`${actor}#one`);
    expect((await command('show', '--actor', actor, '--after-key', shown.nextAfterKeyId)).value.keys).toMatchObject([{ keyId: `${actor}#two`, revoked: false, fingerprint: second.command.value.fingerprint }]);
    await rejected('rotate-key', '--actor', actor, '--old-key-id', `${actor}#two`, '--key-id', `${actor}#one`, '--public-key-file', first.publicPath, ...flags);
    const reopened = await open();
    try {
      const verify = (message: Awaited<ReturnType<typeof signSyncHttp>>) => verifySyncHttp(message, {
        resolveKey: (actor, id) => reopened.sync.resolveKey(actor, id, 'publish'), consumeNonce: (claim) => reopened.sync.consumeNonce(claim, 'publish'),
      });
      await expect(verify(signed)).rejects.toMatchObject({ code: 'UNTRUSTED_KEY' });
      const next = { actor, keyId: `${actor}#two`, privateKey: second.privateKey, requestId: createSyncToken(), method: 'POST' as const,
        url: 'https://receiver.example/sync/publish', body: new TextEncoder().encode('{}'), contentType: 'application/json' as const };
      await expect(verify(await signSyncHttp({ ...next, nonce: originalNonce }))).rejects.toMatchObject({ code: 'REPLAY' });
      expect((await verify(await signSyncHttp(next))).actor).toBe(actor);
      expect(await reopened.sync.resolveKey(actor, `${actor}#two`, 'fork')).toBeNull();
    } finally { await reopened.close(); }
    expect((await command('prune-nonces')).value.removed).toBe(0);
    await command('revoke-key', '--actor', actor, '--key-id', `${actor}#two`);
    expect((await command('show', '--actor', actor, '--after-key', `${actor}#one`)).value.keys[0].revoked).toBe(true);
    expect(JSON.stringify(initial)).not.toContain(first.secret);
  }, 120_000);
});
