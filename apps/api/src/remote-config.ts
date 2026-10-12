import { createSyncReadClient, createSyncToken, signSyncHttp } from '@character-foundry/character-foundry/sync';
import type { ConfiguredRemote } from '@character-unity/cards/connections';

export const remoteConfigurationLimit = 128 * 1024;
const invalid = () => new Error('Invalid remote connection configuration; expected bounded account-bound connections and Ed25519 private keys');
function text(value: unknown, maximum: number): value is string { return typeof value === 'string' && !!value.trim() && value.length <= maximum; }
/** Shared Node/Worker secret parser. All errors are fixed text; never include input or key material. */
export async function parseRemoteConnections(encoded?: string): Promise<readonly ConfiguredRemote[]> {
  if (encoded === undefined) return [];
  try {
    if (new TextEncoder().encode(encoded).length > remoteConfigurationLimit) throw invalid();
    const value: unknown = JSON.parse(encoded);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
      || !('version' in value) || value.version !== 'unity.remote-connections.v1' || !('connections' in value)
      || !Array.isArray(value.connections) || value.connections.length > 16) throw invalid();
    const ids = new Set<string>(), destinations = new Set<string>(), result: ConfiguredRemote[] = [];
    for (const item of value.connections) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid();
      const row = item as Record<string, unknown>;
      const fields = ['id', 'name', 'accountId', 'actor', 'baseUrl', 'keyId', 'privateKeyPem'];
      if (Object.keys(row).length !== fields.length || fields.some((key) => !Object.hasOwn(row, key))
        || !text(row.id, 80) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(row.id) || !text(row.name, 120)
        || !text(row.accountId, 200) || !text(row.actor, 1024) || !text(row.baseUrl, 1024) || !text(row.keyId, 1105)
        || !text(row.privateKeyPem, 4096)) throw invalid();
      const destination = JSON.stringify([row.accountId, row.actor, row.baseUrl]);
      if (ids.has(row.id) || destinations.has(destination)) throw invalid(); ids.add(row.id); destinations.add(destination);
      const match = /^-----BEGIN PRIVATE KEY-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END PRIVATE KEY-----\s*$/.exec(row.privateKeyPem);
      if (!match) throw invalid();
      const bytes = Uint8Array.from(atob(match[1]!.replace(/[\r\n]/g, '')), (character) => character.charCodeAt(0));
      const privateKey = await crypto.subtle.importKey('pkcs8', bytes, 'Ed25519', false, ['sign']);
      const connection = { baseUrl: row.baseUrl, actor: row.actor, keyId: row.keyId, privateKey };
      createSyncReadClient(connection);
      // Use the SDK's actor/key validation without dispatching a request.
      await signSyncHttp({ ...connection, requestId: createSyncToken(), method: 'GET', url: `${connection.baseUrl}/capabilities`,
        contentType: 'application/json', body: new Uint8Array() });
      result.push(Object.freeze({ id: row.id, name: row.name, accountId: row.accountId, connection: Object.freeze(connection) }));
    }
    return Object.freeze(result);
  } catch { throw invalid(); }
}
