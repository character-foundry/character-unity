import { ChatAppError, basicAuth, call, cardFingerprint, isObject, readJsonSnapshot } from './http.js';
import type { Fetch } from './http.js';
import type { ChatApp, ChatConnection, RemoteCopy } from './index.js';

const app = 'Marinara Engine';

/**
 * Marinara Engine's API. Characters have string ids (the remote id) and store the card's `data` as a JSON
 * string, extensions included. Optional HTTP Basic auth; every request carries the CSRF header its
 * frontend sends. Imports answer 200 `{ success: false }` on failure.
 *
 * Updates PATCH the card fields and merge extensions, keeping Marinara's own keys (sprites, import
 * metadata, tracker colours). Edits are detected by fingerprint.
 */
export function createMarinara(connection: ChatConnection, fetcher: Fetch): ChatApp {
  const base = connection.baseUrl.replace(/\/+$/, '');
  const headers = { ...basicAuth(connection.credentials), 'x-marinara-csrf': '1' };

  async function json(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<unknown> {
    const response = await call(fetcher, app, `${base}/api${path}`, { ...init, headers: { ...headers, ...init.headers as Record<string, string> } });
    return response.json().catch(() => { throw new ChatAppError('UNEXPECTED', `${base} does not look like Marinara Engine`); });
  }
  function fields(row: Record<string, unknown>): Record<string, unknown> {
    if (isObject(row.data)) return row.data;
    if (typeof row.data !== 'string') return {};
    try { const parsed = JSON.parse(row.data) as unknown; return isObject(parsed) ? parsed : {}; } catch { return {}; }
  }
  async function copy(row: Record<string, unknown>): Promise<RemoteCopy | null> {
    if (typeof row.id !== 'string') return null;
    const data = fields(row);
    return { remoteId: row.id, name: typeof data.name === 'string' ? data.name : row.id,
      extensions: isObject(data.extensions) ? data.extensions : null, fingerprint: await cardFingerprint(data) };
  }
  async function get(id: string) {
    const row = await json(`/characters/${encodeURIComponent(id)}`);
    if (!isObject(row)) throw new ChatAppError('UNEXPECTED', 'Marinara Engine returned an unexpected character');
    return row;
  }
  const base64 = (bytes: Uint8Array) => {
    let text = '';
    for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(text);
  };

  return {
    kind: 'marinara',
    async check() {
      const list = await json('/characters', { timeoutMs: 60_000 });
      if (!Array.isArray(list)) throw new ChatAppError('UNEXPECTED', `${base} does not look like Marinara Engine`);
      return { characters: list.length };
    },
    async list() {
      const list = await json('/characters', { timeoutMs: 60_000 });
      if (!Array.isArray(list)) throw new ChatAppError('UNEXPECTED', 'Marinara Engine returned an unexpected character list');
      const copies: RemoteCopy[] = [];
      for (const item of list) if (isObject(item)) { const found = await copy(item); if (found) copies.push(found); }
      return copies;
    },
    async read(remoteId) {
      return { spec: 'chara_card_v2', spec_version: '2.0', data: fields(await get(remoteId)) };
    },
    async readForImport(remoteId) {
      const { bytes, value } = await readJsonSnapshot(await call(fetcher, app, `${base}/api/characters/${encodeURIComponent(remoteId)}`, { headers }));
      const data = fields(value);
      if (!Object.keys(data).length) throw new ChatAppError('UNEXPECTED', 'Marinara Engine returned invalid card fields');
      return { bytes, fields: data };
    },
    async upload(file, target) {
      let id: string;
      if (target.replace) {
        id = target.replace;
        const current = fields(await get(id));
        const incoming = isObject(file.card.data) ? file.card.data : {};
        const extensions = { ...(isObject(current.extensions) ? current.extensions : {}), ...(isObject(incoming.extensions) ? incoming.extensions : {}) };
        await json(`/characters/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data: { ...incoming, extensions }, versionSource: 'character-unity', versionReason: 'Updated from Character Unity' }), timeoutMs: 120_000 });
        if (file.portrait) {
          await json(`/characters/${encodeURIComponent(id)}/avatar`, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ avatar: `data:image/png;base64,${base64(file.portrait)}`, filename: 'avatar.png' }), timeoutMs: 120_000 });
        }
      } else {
        const form = new FormData();
        form.set('file', new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.type === 'png' ? 'image/png' : 'application/json' }), file.fileName);
        const result = await json('/import/st-character', { method: 'POST', body: form, timeoutMs: 120_000 });
        if (!isObject(result) || result.success !== true || typeof result.characterId !== 'string') {
          throw new ChatAppError('REJECTED', `Marinara Engine could not import the card${isObject(result) && typeof result.error === 'string' ? `: ${result.error}` : ''}`);
        }
        id = result.characterId;
      }
      const found = await copy(await get(id));
      if (!found) throw new ChatAppError('UNEXPECTED', 'Marinara Engine returned an unexpected character');
      return { remoteId: found.remoteId, ...(found.fingerprint ? { fingerprint: found.fingerprint } : {}) };
    },
  };
}
