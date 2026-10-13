import type { CardDocument } from '@character-unity/store';
import type { Actor, CardService, ImportAsset } from './index.js';
import { CardError, importByteLimit } from './types.js';

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export interface NativeArchiveOptions { origin: string; adminToken?: string; fetch?: Fetch }

export class NativeArchiveUnavailable extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); this.name = 'NativeArchiveUnavailable'; }
}

interface ObjectRef { role: 'card' | 'portrait' | 'raw' | 'asset'; name: string; sha256: string; mediaType: string; byteLength: number }
interface ArchiveCardDetail { id: string; provider: string; recordId: string; url: string; versionId: string; versionList: { id: string; objects: ObjectRef[] }[] }
const readPrefix = '/api/archive/v2', adminPrefix = '/api/archive/admin/v1';
async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The library's side of the native Archive: read-through for browsing (annotated with what is already in
 * the library), admin pass-through for Settings, and copying an Archive card into the library. The Archive
 * itself is never written from here except through its admin routes.
 */
export function createNativeArchiveService(cards: CardService, options: NativeArchiveOptions) {
  const origin = new URL(options.origin).origin;
  const fetcher = options.fetch ?? fetch;
  const authorize = (actor: Actor, workspaceId: string) => cards.list(actor, workspaceId, { limit: 1 });

  async function call(path: string, init: RequestInit = {}, admin = false): Promise<Response> {
    let response: Response;
    try {
      response = await fetcher(`${origin}${path}`, { ...init, redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(30_000),
        headers: { ...init.headers as Record<string, string>, ...(admin && options.adminToken ? { authorization: `Bearer ${options.adminToken}` } : {}) } });
    } catch (error) {
      throw new NativeArchiveUnavailable(503, 'UNAVAILABLE', `The Archive did not answer at ${origin}${error instanceof Error && error.name === 'TimeoutError' ? ' in time' : ''}`);
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
      throw new NativeArchiveUnavailable(response.status, body?.error?.code ?? 'UNAVAILABLE', body?.error?.message ?? `The Archive answered HTTP ${response.status}`);
    }
    return response;
  }
  const json = async <T>(path: string, init?: RequestInit, admin = false) => await (await call(path, init, admin)).json() as T;
  async function bytes(ref: ObjectRef) {
    const data = new Uint8Array(await (await call(`${readPrefix}/objects/${ref.sha256}`)).arrayBuffer());
    if (data.byteLength !== ref.byteLength || await sha256(data) !== ref.sha256) throw new CardError('INVALID_INPUT', 'An Archive file did not match its digest');
    return data;
  }

  return {
    async status(actor: Actor, workspaceId: string) {
      await authorize(actor, workspaceId);
      return json<Record<string, unknown>>(`${readPrefix}/status`);
    },
    /** Archive cards for a query, each marked with the library card it was copied into (if any). */
    async list(actor: Actor, workspaceId: string, params: URLSearchParams) {
      await authorize(actor, workspaceId);
      const query = new URLSearchParams(params);
      // Followed creators live in the library; the Archive filters on the names it is given.
      if ((query.get('has') ?? '').split(',').includes('followed')) query.set('creators', (await cards.followed(actor, workspaceId)).join(','));
      const page = await json<{ cards: { id: string }[]; total: number }>(`${readPrefix}/cards?${query}`);
      const links = await cards.archiveLinks(actor, workspaceId, page.cards.map((card) => card.id));
      return { total: page.total, cards: page.cards.map((card) => ({ ...card, libraryCardId: links[card.id] ?? null })) };
    },
    async card(actor: Actor, workspaceId: string, id: string) {
      await authorize(actor, workspaceId);
      const card = await json<ArchiveCardDetail>(`${readPrefix}/cards/${encodeURIComponent(id)}`);
      const links = await cards.archiveLinks(actor, workspaceId, [card.id]);
      return { ...card, libraryCardId: links[card.id] ?? null };
    },
    async tags(actor: Actor, workspaceId: string) {
      await authorize(actor, workspaceId);
      return json<{ tags: { tag: string; count: number }[] }>(`${readPrefix}/tags`);
    },
    async object(actor: Actor, workspaceId: string, hash: string) {
      await authorize(actor, workspaceId);
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new CardError('INVALID_INPUT', 'Invalid object hash');
      return call(`${readPrefix}/objects/${hash}`);
    },
    /**
     * Copies the Archive card's current version into the library: the card file as fetched, with the
     * portrait as its image when the card file is JSON. Bytes are checked against their digests first.
     */
    async import(actor: Actor, workspaceId: string, id: string) {
      actor = { ...actor };
      await authorize(actor, workspaceId);
      const card = await json<ArchiveCardDetail>(`${readPrefix}/cards/${encodeURIComponent(id)}`);
      const existing = (await cards.archiveLinks(actor, workspaceId, [card.id]))[card.id];
      if (existing) return { cardId: existing, created: false };
      const current = card.versionList.find((version) => version.id === card.versionId);
      const container = current?.objects.find((object) => object.role === 'card');
      if (!current || !container) throw new CardError('UNSUPPORTED_FORMAT', 'This Archive card has no card file');
      const portrait = current.objects.find((object) => object.role === 'portrait');
      const megabytes = (bytes: number) => `${Math.ceil(bytes / 1024 / 1024)} MB`;
      if (container.byteLength + (portrait?.byteLength ?? 0) > importByteLimit) {
        throw new CardError('TOO_LARGE', `This card is ${megabytes(container.byteLength)}; the library imports up to ${megabytes(importByteLimit)}, so it stays in the Archive only.`);
      }
      const assets: ImportAsset[] = [];
      if (portrait && container.mediaType === 'application/json') assets.push({ bytes: await bytes(portrait), binding: { kind: 'portrait' }, mediaType: portrait.mediaType });
      const provenance: CardDocument = { kind: 'archive', contract: 'unity.archive.native.v1', cardId: card.id, versionId: card.versionId,
        originalHash: container.sha256, source: { provider: card.provider, recordId: card.recordId, url: card.url } };
      try {
        const imported = await cards.import(actor, workspaceId, await bytes(container), provenance, assets);
        return { cardId: imported.card.id, created: true };
      } catch (error) {
        // The Archive keeps every file as fetched; the library only takes what it can edit and export without loss.
        if (error instanceof CardError && error.code === 'UNSUPPORTED_FORMAT') {
          throw new CardError('UNSUPPORTED_FORMAT', `The library can't keep everything in this ${container.name} yet (for example a RisuAI module), so it stays in the Archive only.`);
        }
        if (error instanceof CardError && error.code === 'ASSET_UNAVAILABLE') {
          throw new CardError('ASSET_UNAVAILABLE', `This ${container.name} lists files it does not contain, so the library can't take it; it stays in the Archive.`);
        }
        throw error;
      }
    },
    admin: {
      async sources(actor: Actor, workspaceId: string) {
        await authorize(actor, workspaceId);
        return json<Record<string, unknown>>(`${adminPrefix}/sources`, {}, true);
      },
      async saveSource(actor: Actor, workspaceId: string, provider: string, body: unknown) {
        await authorize(actor, workspaceId);
        return json<Record<string, unknown>>(`${adminPrefix}/sources/${encodeURIComponent(provider)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, true);
      },
      async run(actor: Actor, workspaceId: string, provider: string) {
        await authorize(actor, workspaceId);
        return json<{ runId: number }>(`${adminPrefix}/sources/${encodeURIComponent(provider)}/runs`, { method: 'POST' }, true);
      },
      async runs(actor: Actor, workspaceId: string, provider?: string) {
        await authorize(actor, workspaceId);
        return json<Record<string, unknown>>(`${adminPrefix}/runs?${new URLSearchParams(provider ? { provider, limit: '20' } : { limit: '20' })}`, {}, true);
      },
      async cancel(actor: Actor, workspaceId: string, runId: number) {
        await authorize(actor, workspaceId);
        return json<Record<string, unknown>>(`${adminPrefix}/runs/${runId}/cancel`, { method: 'POST' }, true);
      },
      async block(actor: Actor, workspaceId: string, id: string) {
        await authorize(actor, workspaceId);
        return json<Record<string, unknown>>(`${adminPrefix}/cards/${encodeURIComponent(id)}/block`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, true);
      },
    },
  };
}
export type NativeArchiveService = ReturnType<typeof createNativeArchiveService>;
