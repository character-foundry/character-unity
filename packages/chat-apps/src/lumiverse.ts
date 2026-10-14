import { ChatAppError, bearer, call, cardFingerprint, isObject, readJsonSnapshot } from './http.js';
import type { Fetch } from './http.js';
import type { ChatApp, ChatConnection, RemoteCopy } from './index.js';

const app = 'Lumiverse';
const pageSize = 100;

/**
 * Lumiverse's v1 API. Characters have UUIDs (the remote id) and keep `extensions`, so copies are found by the
 * transport marker. Auth is a Better Auth session: a pasted session token, or username and password exchanged
 * for one. Instances started without auth need neither.
 *
 * replace-card deliberately keeps the name and avatar, so a replace also sets the name and portrait.
 * Exports are rebuilt from stored fields, so edits are detected by fingerprint, not by the marker.
 */
export function createLumiverse(connection: ChatConnection, fetcher: Fetch): ChatApp {
  const base = connection.baseUrl.replace(/\/+$/, '');
  let token = connection.credentials.apiKey?.trim() || undefined;

  async function signIn(): Promise<string | undefined> {
    const { username, password } = connection.credentials;
    if (!username || password === undefined) return undefined;
    const response = await call(fetcher, app, `${base}/api/auth/sign-in/username`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const body = await response.json().catch(() => null) as { token?: unknown } | null;
    const issued = response.headers.get('set-auth-token') ?? (typeof body?.token === 'string' ? body.token : null);
    if (!issued) throw new ChatAppError('UNAUTHORIZED', 'Lumiverse did not issue a session token for that login');
    return issued;
  }
  /** One retry after signing in again covers expired sessions. */
  async function request(path: string, init: RequestInit & { timeoutMs?: number } = {}) {
    if (!token) token = await signIn();
    for (let attempt = 0; ; attempt++) {
      try {
        return await call(fetcher, app, `${base}/api/v1${path}`, { ...init, headers: { ...init.headers as Record<string, string>, ...bearer(token) } });
      } catch (error) {
        const canRetry = !attempt && error instanceof ChatAppError && error.code === 'UNAUTHORIZED' && !connection.credentials.apiKey && connection.credentials.username;
        if (!canRetry) throw error;
        token = await signIn();
      }
    }
  }
  async function json(path: string, init: RequestInit & { timeoutMs?: number } = {}) {
    const body = await (await request(path, init)).json().catch(() => null) as unknown;
    if (!isObject(body)) throw new ChatAppError('UNEXPECTED', `${base} does not look like Lumiverse`);
    return body;
  }
  async function copy(character: Record<string, unknown>): Promise<RemoteCopy | null> {
    if (typeof character.id !== 'string') return null;
    return { remoteId: character.id, name: typeof character.name === 'string' ? character.name : character.id,
      extensions: isObject(character.extensions) ? character.extensions : null, fingerprint: await cardFingerprint(character) };
  }
  const form = (field: string, bytes: Uint8Array, type: string, name: string) => {
    const data = new FormData();
    data.set(field, new Blob([bytes as Uint8Array<ArrayBuffer>], { type }), name);
    return data;
  };

  return {
    kind: 'lumiverse',
    async check() {
      const page = await json('/characters?limit=1&offset=0');
      if (!Array.isArray(page.data)) throw new ChatAppError('UNEXPECTED', `${base} does not look like Lumiverse`);
      return { characters: typeof page.total === 'number' ? page.total : page.data.length };
    },
    async list() {
      const copies: RemoteCopy[] = [];
      for (let offset = 0; ; offset += pageSize) {
        const page = await json(`/characters?limit=${pageSize}&offset=${offset}`, { timeoutMs: 60_000 });
        if (!Array.isArray(page.data)) throw new ChatAppError('UNEXPECTED', 'Lumiverse returned an unexpected character list');
        for (const item of page.data) if (isObject(item)) { const found = await copy(item); if (found) copies.push(found); }
        const total = typeof page.total === 'number' ? page.total : 0;
        if (page.data.length < pageSize || offset + pageSize >= total) return copies;
      }
    },
    async read(remoteId) {
      return json(`/characters/${encodeURIComponent(remoteId)}`);
    },
    async readForImport(remoteId) {
      const { bytes, value } = await readJsonSnapshot(await request(`/characters/${encodeURIComponent(remoteId)}`));
      // Character + rowToCharacter in the upstream source expose these app-local
      // row fields, not authored CC data. Unknown future fields remain visible
      // to the loss checks rather than being silently discarded.
      // https://github.com/prolix-oc/Lumiverse/blob/main/src/types/character.ts
      const fields = { ...value };
      for (const key of ['id', 'user_id', 'avatar_path', 'image_id', 'avatar_crop_image_id', 'folder', 'library_scope', 'created_at', 'updated_at']) delete fields[key];
      return { bytes, fields };
    },
    async upload(file, target) {
      const type = file.type === 'png' ? 'image/png' : 'application/json';
      let character: Record<string, unknown>;
      if (target.replace) {
        const id = encodeURIComponent(target.replace);
        await json(`/characters/${id}/replace-card`, { method: 'POST', body: form('file', file.bytes, type, file.fileName), timeoutMs: 120_000 });
        const name = typeof (file.card.data as { name?: unknown } | undefined)?.name === 'string' ? (file.card.data as { name: string }).name : undefined;
        character = name !== undefined
          ? await json(`/characters/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) })
          : await json(`/characters/${id}`);
        if (file.portrait) await json(`/characters/${id}/avatar`, { method: 'POST', body: form('avatar', file.portrait, 'image/png', 'avatar.png'), timeoutMs: 120_000 });
      } else {
        const created = await json('/characters/import', { method: 'POST', body: form('file', file.bytes, type, file.fileName), timeoutMs: 120_000 });
        if (!isObject(created.character) || typeof created.character.id !== 'string') throw new ChatAppError('REJECTED', 'Lumiverse could not import the card');
        character = created.character;
      }
      const found = await copy(character);
      if (!found) throw new ChatAppError('UNEXPECTED', 'Lumiverse returned an unexpected character');
      return { remoteId: found.remoteId, ...(found.fingerprint ? { fingerprint: found.fingerprint } : {}) };
    },
  };
}
