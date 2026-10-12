import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

assert.ok(process.argv[2], 'Pass the explicit built Foundry packages/character-foundry directory');
const directory = resolve(process.argv[2]), manifestPath = join(directory, 'package.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assert.equal(manifest.name, '@character-foundry/character-foundry');
const entry = manifest.exports['./sync'];
assert.ok(entry?.import?.default && entry?.require?.default, 'Foundry build lacks the signed sync subpath');
const esmPath = resolve(directory, entry.import.default);
const esm = await import(pathToFileURL(esmPath).href), cjs = createRequire(manifestPath)(entry.require.default);
// Independent synthetic Node-crypto vector, copied with provenance from the SDK.
// This is test data, not a second protocol implementation or an operational key.
const vector = JSON.parse(await readFile(new URL('./fixtures/sync-http-v1.json', import.meta.url), 'utf8'));
async function exercise(sdk, vector, publication, forkSubmission) {
  const decode = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  const privateKey = await crypto.subtle.importKey('pkcs8', decode(vector.privateKeyPkcs8), 'Ed25519', false, ['sign']);
  const publicKey = await crypto.subtle.importKey('spki', decode(vector.publicKeySpki), 'Ed25519', false, ['verify']);
  const request = await sdk.signSyncHttp({ actor: vector.actor, keyId: vector.keyId, privateKey,
    requestId: vector.requestId, nonce: vector.nonce, created: vector.created, method: 'POST', url: vector.url,
    contentType: 'application/json', body: new TextEncoder().encode(vector.body) });
  if (request.headers.get('signature') !== vector.signature || request.headers.get('signature-input') !== vector.signatureInput
    || request.headers.get('content-digest') !== vector.contentDigest) throw new Error('Independent signed transport vector mismatch');
  // Test double only. Production replay storage must be durable and atomic.
  const seen = new Set();
  const options = { now: vector.created, resolveKey: async () => ({ actor: vector.actor, keyId: vector.keyId, publicKey }),
    consumeNonce: async ({ actor, nonce }) => {
      const key = `${actor}\n${nonce}`; if (seen.has(key)) return false; seen.add(key); return true;
    } };
  async function rejects(message, code, extra = {}) {
    try { await sdk.verifySyncHttp(message, { ...options, ...extra }); }
    catch (error) { if (error.code === code) return true; throw error; }
    throw new Error(`Expected ${code} rejection`);
  }
  await rejects({ ...request, body: new TextEncoder().encode('tampered') }, 'INVALID_DIGEST');
  await rejects(request, 'UNTRUSTED_KEY', { resolveKey: async () => ({ actor: vector.actor + '-other', keyId: vector.keyId, publicKey }) });
  await rejects(request, 'EXPIRED', { now: vector.expires + 31 });
  const result = await sdk.verifySyncHttp(request, options);
  if (result.requestHash !== vector.requestHash || new TextDecoder().decode(result.body) !== vector.body) throw new Error('Verified operation differs from vector');
  await rejects(request, 'REPLAY');
  let tamper = false;
  const readClient = sdk.createSyncReadClient({ baseUrl: 'https://read-consumer.invalid/api/sync/v1', actor: vector.actor, keyId: vector.keyId, privateKey,
    fetch: async (url, init) => {
      if (init.credentials !== 'omit' || init.redirect !== 'manual') throw new Error('Read client leaked ambient credentials or allowed redirects');
      await sdk.verifySyncHttp({ method: init.method, url: String(url), headers: new Headers(init.headers), body: new Uint8Array() },
        { resolveKey: options.resolveKey, consumeNonce: options.consumeNonce });
      if (String(url).endsWith('/capabilities')) return Response.json(sdk.syncReadCapabilities());
      const value = structuredClone(publication);
      if (tamper) value.document.data.name = 'Changed by response';
      return Response.json({ version: sdk.SYNC_READ_VERSION, publication: value });
    } });
  if ((await readClient.capabilities()).version !== sdk.SYNC_READ_VERSION || (await readClient.get(publication.id)).id !== publication.id) throw new Error('Read protocol mismatch');
  tamper = true;
  try { await readClient.get(publication.id); throw new Error('Tampered read identity accepted'); }
  catch (error) { if (error.code !== 'INVALID_RESPONSE') throw error; }
  const commandHashes = new Set();
  const commandClient = sdk.createSyncCommandClient({ baseUrl: 'https://command-consumer.invalid/api/sync/v1', actor: vector.actor, keyId: vector.keyId, privateKey,
    fetch: async (url, init) => {
      if (init.credentials !== 'omit' || init.redirect !== 'manual') throw new Error('Command client allowed ambient credentials or redirects');
      const verified = await sdk.verifySyncHttp({ method: init.method, url: String(url), headers: new Headers(init.headers), body: new Uint8Array(await new Response(init.body).arrayBuffer()) },
        { resolveKey: options.resolveKey, consumeNonce: options.consumeNonce });
      if (String(url).endsWith(`/commands/submit-fork/${publication.id}`)) {
        if (verified.contentType !== 'application/octet-stream') throw new Error('Wrong fork media type');
        const decoded = await sdk.decodeSyncForkSubmission(verified.body);
        await sdk.verifySyncForkSubmission(decoded, publication, vector.actor);
        return Response.json({ version: sdk.SYNC_COMMAND_VERSION, operation: 'forks.submit', requestId: verified.requestId, cardId: 'remote-card', revisionId: 'remote-revision' });
      }
      const command = sdk.decodeSyncCommand(verified.body);
      if (command.operation !== 'publications.publish' || command.revisionIds.join(',') !== 'selected') throw new Error('Wrong signed selection');
      commandHashes.add(verified.requestHash);
      return Response.json({ version: sdk.SYNC_COMMAND_VERSION, operation: command.operation, requestId: verified.requestId,
        publications: [{ id: 'published', policyVersion: 1 }] });
    } });
  for (let i = 0; i < 2; i++) {
    const receipt = await commandClient.publish({ revisionIds: ['selected'], policy: { visibility: 'members', allowFork: true } }, vector.requestId);
    if (receipt.publications[0].id !== 'published') throw new Error('Invalid command receipt');
  }
  const forkBytes = await sdk.encodeSyncForkSubmission(forkSubmission);
  const forkReceipt = await commandClient.submitFork(forkBytes, sdk.createSyncToken());
  if (forkReceipt.operation !== 'forks.submit' || forkReceipt.cardId !== 'remote-card') throw new Error('Remote fork receipt mismatch');
  if (commandHashes.size !== 1) throw new Error('Retry command fingerprint changed');
  return { verifiedRemoteFork: true, commandProfile: sdk.SYNC_COMMAND_VERSION, verifiedCommands: true, readProfile: sdk.SYNC_READ_VERSION, verifiedReadIdentity: true, profile: sdk.SYNC_HTTP_PROFILE, requestHash: result.requestHash, rejectedTamper: true, rejectedActor: true,
    rejectedExpired: true, requiredReplayAdmission: true };
}
const identity = await import(pathToFileURL(resolve(directory, manifest.exports['./identity'].import.default)).href);
const document = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Sync consumer' } };
const publication = { id: 'consumer', document, identity: await identity.computeCardContentIdentity(document), originalHash: 'a'.repeat(64), parentId: null,
  publishedAt: '2026-10-11T00:00:00.000Z', policy: { visibility: 'public', allowFork: true, version: 1 }, assets: [] };
const fork = await identity.createCardRevision(document, { originalHash: publication.originalHash, operation: 'fork', author: vector.actor,
  createdAt: '2026-10-11T01:00:00.000Z', nonce: 'consumer_remote_fork_0001' });
const changed = structuredClone(fork.card); changed.data.description = 'Enriched by the external SDK client';
const final = await identity.createCardRevision(changed, { originalHash: publication.originalHash, operation: 'edit', author: vector.actor,
  parents: [fork.lineage], createdAt: '2026-10-11T02:00:00.000Z', nonce: 'consumer_remote_edit_0001' });
const forkSubmission = { manifest: { version: 'foundry.sync.fork.v1', publicationId: publication.id, baseIdentity: publication.identity,
  originalHash: publication.originalHash, document: final.card, identity: final.lineage.content, ancestry: [fork.lineage], assets: [] }, assets: [] };
const expected = { verifiedRemoteFork: true, commandProfile: 'foundry.sync.command.v1', verifiedCommands: true, readProfile: 'foundry.sync.read.v1', verifiedReadIdentity: true, profile: 'foundry-sync-v1', requestHash: vector.requestHash, rejectedTamper: true, rejectedActor: true,
  rejectedExpired: true, requiredReplayAdmission: true };
assert.deepEqual(await exercise(esm, vector, publication, forkSubmission), expected);
assert.deepEqual(await exercise(cjs, vector, publication, forkSubmission), expected);
const built = await build({ stdin: { contents: `import * as sdk from ${JSON.stringify(esmPath)};
  const vector = ${JSON.stringify(vector)}, publication = ${JSON.stringify(publication)}, forkSubmission = ${JSON.stringify(forkSubmission)}; ${exercise.toString()}
  export default { async fetch() { return Response.json(await exercise(sdk, vector, publication, forkSubmission)); } };`, resolveDir: directory },
  bundle: true, platform: 'browser', format: 'esm', target: 'es2022', write: false });
const worker = new Miniflare(convertV4MiniflareOptions({ port: 0, modules: true, script: built.outputFiles[0].text, compatibilityDate: '2026-10-11' }));
try {
  const response = await worker.dispatchFetch('https://sync-consumer.invalid');
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), expected);
} finally { await worker.dispose(); }
console.log('Foundry sync: Node ESM/CJS and local workerd pass independent signatures, replay admission, verified reads, signed command retries and remote fork bundles');
