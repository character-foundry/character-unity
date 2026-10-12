import { ChatAppError, basicAuth, call, isObject } from './http.js';
import type { Fetch } from './http.js';
import type { ChatApp, ChatConnection, RemoteCopy } from './index.js';

const app = 'SillyTavern';
interface Session { token: string; cookie: string }

/**
 * SillyTavern's own API. Characters are PNG files named by `avatar`; that file name is the remote id.
 * Writes need its CSRF token and the cookie it was issued with. Failed imports answer 200 `{ error: true }`.
 */
export function createSillyTavern(connection: ChatConnection, fetcher: Fetch): ChatApp {
  const base = connection.baseUrl.replace(/\/+$/, '');
  const auth = basicAuth(connection.credentials);
  let session: Session | null = null;

  async function open(): Promise<Session> {
    const response = await call(fetcher, app, `${base}/csrf-token`, { headers: auth });
    const body = await response.json().catch(() => null) as { token?: unknown } | null;
    if (typeof body?.token !== 'string') throw new ChatAppError('UNEXPECTED', `${base} does not look like SillyTavern`);
    const cookie = response.headers.getSetCookie().map((value) => value.split(';')[0]!.trim()).filter(Boolean).join('; ');
    return { token: body.token, cookie };
  }
  /** One retry with a fresh session covers restarts and expired CSRF cookies. */
  async function post(path: string, body: BodyInit, json: boolean, timeoutMs?: number) {
    for (let attempt = 0; ; attempt++) {
      session ??= await open();
      try {
        return await call(fetcher, app, `${base}${path}`, { method: 'POST', body, ...(timeoutMs ? { timeoutMs } : {}),
          headers: { ...auth, 'x-csrf-token': session.token, ...(session.cookie ? { cookie: session.cookie } : {}), ...(json ? { 'content-type': 'application/json' } : {}) } });
      } catch (error) {
        session = null;
        if (attempt || !(error instanceof ChatAppError && error.code === 'UNAUTHORIZED')) throw error;
      }
    }
  }
  async function postJson(path: string, value: unknown, timeoutMs?: number) {
    return post(path, JSON.stringify(value), true, timeoutMs);
  }
  function copy(character: Record<string, unknown>): RemoteCopy | null {
    if (typeof character.avatar !== 'string' || !character.avatar) return null;
    const data = isObject(character.data) ? character.data : {};
    return { remoteId: character.avatar, name: typeof character.name === 'string' ? character.name : character.avatar,
      extensions: isObject(data.extensions) ? data.extensions : null };
  }

  return {
    kind: 'sillytavern',
    async check() {
      const response = await postJson('/api/characters/all', {}, 60_000);
      const list = await response.json() as unknown;
      if (!Array.isArray(list)) throw new ChatAppError('UNEXPECTED', 'SillyTavern returned an unexpected character list');
      return { characters: list.length };
    },
    async list() {
      const response = await postJson('/api/characters/all', {}, 60_000);
      const list = await response.json() as unknown;
      if (!Array.isArray(list)) throw new ChatAppError('UNEXPECTED', 'SillyTavern returned an unexpected character list');
      const copies: RemoteCopy[] = [];
      for (const item of list) {
        if (!isObject(item)) continue;
        // With lazy loading on, the list drops extensions; fetch those characters in full.
        const full = item.shallow === true && typeof item.avatar === 'string'
          ? await (await postJson('/api/characters/get', { avatar_url: item.avatar })).json() as unknown : item;
        const found = isObject(full) ? copy(full) : null;
        if (found) copies.push(found);
      }
      return copies;
    },
    async read(remoteId) {
      const response = await postJson('/api/characters/export', { avatar_url: remoteId, format: 'json' });
      return JSON.parse(await response.text()) as unknown;
    },
    async upload(file, target) {
      const form = new FormData();
      form.set('avatar', new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.type === 'png' ? 'image/png' : 'application/json' }), file.fileName);
      form.set('file_type', file.type);
      form.set('preserved_name', (target.replace ?? target.preferredName).replace(/\.png$/i, ''));
      const response = await post('/api/characters/import', form, false, 120_000);
      const body = await response.json().catch(() => null) as { file_name?: unknown; error?: unknown } | null;
      if (!body || body.error || typeof body.file_name !== 'string' || !body.file_name) throw new ChatAppError('REJECTED', 'SillyTavern could not import the card');
      return { remoteId: `${body.file_name}.png` };
    },
  };
}
