import { mkdtemp, writeFile, symlink, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { parseRemoteConnections, remoteConfigurationLimit } from './remote-config.js';
import { loadRemoteConnections } from './remote-config-node.js';
import { nodeConfig } from './node-config.js';

async function configuration() {
  const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const encoded = Buffer.from(await crypto.subtle.exportKey('pkcs8', key.privateKey)).toString('base64');
  return { version: 'unity.remote-connections.v1', connections: [{ id: 'friends', name: 'Friends hub', accountId: 'account',
    actor: 'https://sender.example/actors/editor', baseUrl: 'https://peer.example/api/sync/v1', keyId: 'https://sender.example/actors/editor#one',
    privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----\n` }] };
}
test('remote configuration is bounded, owned, account-bound and imports only non-extractable Ed25519 signing keys', async () => {
  const source = await configuration(); const values = await parseRemoteConnections(JSON.stringify(source));
  expect(values).toHaveLength(1); expect(values[0]).toMatchObject({ id: 'friends', accountId: 'account', connection: { actor: source.connections[0]!.actor } });
  expect(values[0]!.connection.privateKey.extractable).toBe(false);
  expect(values[0]!.connection.privateKey.usages).toEqual(['sign']);
  expect(Object.isFrozen(values)).toBe(true); expect(Object.isFrozen(values[0]!.connection)).toBe(true);
  expect(await parseRemoteConnections()).toEqual([]); expect(await loadRemoteConnections()).toEqual([]);
  for (const value of ['', '{secret-broken', JSON.stringify({ ...source, unknown: true }), JSON.stringify({ ...source, version: 'other' }),
    JSON.stringify({ ...source, connections: Array(17).fill(source.connections[0]) }), ' '.repeat(remoteConfigurationLimit + 1)]) {
    await expect(parseRemoteConnections(value)).rejects.toThrow(/^Invalid remote connection configuration;/);
  }
  for (const changed of [{ actor: 'urn:local' }, { baseUrl: 'http://peer.example/api/sync/v1' }, { baseUrl: 'https://peer.example/api/sync/v1/' },
    { keyId: 'https://unrelated.example/key' }, { privateKeyPem: 'TOP_SECRET_INVALID_KEY' }, { accountId: '' }, { privateKeyFile: '/tmp/key' }]) {
    await expect(parseRemoteConnections(JSON.stringify({ ...source, connections: [{ ...source.connections[0], ...changed }] }))).rejects.toThrow(/^Invalid remote connection configuration;/);
  }
  for (const second of [source.connections[0], { ...source.connections[0], id: 'duplicate-destination' }]) {
    await expect(parseRemoteConnections(JSON.stringify({ ...source, connections: [...source.connections, second] }))).rejects.toThrow('Invalid remote connection');
  }
});

test('Node loads only an explicit protected regular file and rejects accidental local-profile configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'unity-remote-config-'));
  try {
    const file = join(directory, 'connections.json'), source = await configuration();
    await writeFile(file, JSON.stringify(source), { mode: 0o600 }); expect(await loadRemoteConnections(file)).toHaveLength(1);
    await symlink(file, join(directory, 'linked')); await expect(loadRemoteConnections(join(directory, 'linked'))).rejects.toThrow('owner-only regular JSON');
    await chmod(file, 0o644); await expect(loadRemoteConnections(file)).rejects.toThrow('owner-only regular JSON');
    await expect(loadRemoteConnections(directory)).rejects.toThrow('owner-only regular JSON');
    await expect(loadRemoteConnections(join(directory, 'missing'))).rejects.toThrow('owner-only regular JSON');
    await expect(loadRemoteConnections('')).rejects.toThrow('owner-only regular JSON');
    expect(() => nodeConfig({ UNITY_REMOTE_CONNECTIONS_FILE: file })).toThrow('hub profile');
    expect(() => nodeConfig({ UNITY_PROFILE: 'hub', UNITY_PUBLIC_ORIGIN: 'http://127.0.0.1:9312', UNITY_REMOTE_CONNECTIONS_FILE: '' })).toThrow('configuration file');
    expect(nodeConfig({ UNITY_PROFILE: 'hub', UNITY_PUBLIC_ORIGIN: 'http://127.0.0.1:9312', UNITY_REMOTE_CONNECTIONS_FILE: file }).profile).toBe('hub');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
