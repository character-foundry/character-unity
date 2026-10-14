import type { Actor, CardService } from './index.js';
import { CardError } from './types.js';
import { createNativeArchiveReader } from './native-reader.js';
import type { NativeArchiveOptions } from './native-reader.js';
export { NativeArchiveUnavailable } from './native-reader.js';
export type { Fetch, NativeArchiveOptions } from './native-reader.js';
const readPrefix = '/api/archive/v2', adminPrefix = '/api/archive/admin/v1';

/**
 * The library's side of the native Archive: read-through for browsing (annotated with what is already in
 * the library), admin pass-through for Settings, and adding a reference to the library. The Archive
 * itself is never written from here except through its admin routes.
 */
export function createNativeArchiveService(cards: CardService, options: NativeArchiveOptions, access: { admin?: boolean } = {}) {
  const reader = createNativeArchiveReader(options);
  const { call, json } = reader;
  const authorize = (actor: Actor, workspaceId: string) => cards.list(actor, workspaceId, { limit: 1 });
  const authorizeAdmin = async (actor: Actor, workspaceId: string) => {
    if (access.admin !== true) throw new CardError('FORBIDDEN', 'Archive administration is available only to the local operator');
    await authorize(actor, workspaceId);
  };

  return {
    async status(actor: Actor, workspaceId: string, signal?: AbortSignal) {
      await authorize(actor, workspaceId);
      const result = await reader.status(signal); await authorize(actor, workspaceId); return result;
    },
    /** Archive cards and authorized owned projections, annotated with exact library membership. */
    async list(actor: Actor, workspaceId: string, params: URLSearchParams, signal?: AbortSignal) {
      await authorize(actor, workspaceId);
      const query = new URLSearchParams(params);
      // Followed creators live in the library; the Archive filters on the names it is given.
      if ((query.get('has') ?? '').split(',').includes('followed')) query.set('creators', (await cards.followed(actor, workspaceId)).join(','));
      // Public read-only attachment needs no admin token. Only authenticated
      // host requests may opt into private Unity projection scope.
      const scoped: RequestInit = { ...(signal ? { signal } : {}),
        ...(options.libraryIndex && options.adminToken ? { headers: { 'x-unity-library-workspace': workspaceId } } : {}) };
      const page = await json<{ cards: { id: string; versionId: string; libraryOwned?: boolean; libraryCardId?: string }[];
        total: number; complete?: boolean; scores?: number[]; matches?: unknown[] }>(`${readPrefix}/cards?${query}`, scoped, true);
      const status = await reader.status(signal);
      const memberships = await cards.archiveMemberships(actor, workspaceId, status.archiveId, page.cards.filter((card) => !card.libraryOwned).map((card) => ({ cardId: card.id, versionId: card.versionId })));
      const favorites = await cards.libraryFavorites(actor, workspaceId, page.cards.filter((card) => card.libraryOwned).map((card) => card.libraryCardId!));
      const visible = page.cards.map((card, index) => ({ card, index })).filter(({ card }) => !card.libraryOwned || Object.hasOwn(favorites, card.libraryCardId!));
      const staleLibraryHits = page.cards.length - visible.length;
      return { ...page, nextOffset: Number(query.get('offset') ?? 0) + page.cards.length, staleLibraryHits,
        ...(staleLibraryHits ? { complete: false } : {}),
        ...(page.scores ? { scores: visible.map(({ index }) => page.scores![index]!) } : {}),
        ...(page.matches ? { matches: visible.map(({ index }) => page.matches![index]!) } : {}),
        cards: visible.map(({ card }) => ({ ...card, libraryCardId: card.libraryOwned ? card.libraryCardId : memberships[card.id]?.id ?? null,
          libraryFavorite: card.libraryOwned ? favorites[card.libraryCardId!] ?? false : memberships[card.id]?.favorite ?? false })) };
    },
    async card(actor: Actor, workspaceId: string, id: string, signal?: AbortSignal, versionId?: string) {
      await authorize(actor, workspaceId);
      const card = await reader.card(id, versionId, signal);
      const archiveId = card.archiveId ?? (await reader.status(signal)).archiveId;
      const memberships = await cards.archiveMemberships(actor, workspaceId, archiveId, [{ cardId: card.id, versionId: card.versionId }]);
      return { ...card, libraryCardId: memberships[card.id]?.id ?? null, libraryFavorite: memberships[card.id]?.favorite ?? false };
    },
    async tags(actor: Actor, workspaceId: string) {
      await authorize(actor, workspaceId);
      const result = await json<{ tags: { tag: string; count: number }[] }>(`${readPrefix}/tags`);
      await authorize(actor, workspaceId); return result;
    },
    async object(actor: Actor, workspaceId: string, hash: string) {
      await authorize(actor, workspaceId);
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new CardError('INVALID_INPUT', 'Invalid object hash');
      const response = await call(`${readPrefix}/objects/${hash}`);
      try { await authorize(actor, workspaceId); return response; }
      catch (error) { await response.body?.cancel(); throw error; }
    },
    /** Only membership/projection rows are stored; no original or asset bytes. */
    async import(actor: Actor, workspaceId: string, id: string, versionId?: string, favorite = false) {
      await authorize(actor, workspaceId);
      const selected = await reader.card(id, versionId);
      const archiveId = selected.archiveId ?? (await reader.status()).archiveId;
      const existing = (await cards.archiveMemberships(actor, workspaceId, archiveId, [{ cardId: id, versionId: selected.versionId }]))[id];
      const reference = await cards.addArchiveReference(actor, workspaceId, id, versionId, favorite);
      return { cardId: reference.id, created: existing?.id !== reference.id };
    },
    admin: {
      async sources(actor: Actor, workspaceId: string) {
        await authorizeAdmin(actor, workspaceId);
        return json<Record<string, unknown>>(`${adminPrefix}/sources`, {}, true);
      },
      async saveSource(actor: Actor, workspaceId: string, provider: string, body: unknown) {
        await authorizeAdmin(actor, workspaceId);
        return json<Record<string, unknown>>(`${adminPrefix}/sources/${encodeURIComponent(provider)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, true);
      },
      async run(actor: Actor, workspaceId: string, provider: string) {
        await authorizeAdmin(actor, workspaceId);
        return json<{ runId: number }>(`${adminPrefix}/sources/${encodeURIComponent(provider)}/runs`, { method: 'POST' }, true);
      },
      async runs(actor: Actor, workspaceId: string, provider?: string) {
        await authorizeAdmin(actor, workspaceId);
        return json<Record<string, unknown>>(`${adminPrefix}/runs?${new URLSearchParams(provider ? { provider, limit: '20' } : { limit: '20' })}`, {}, true);
      },
      async cancel(actor: Actor, workspaceId: string, runId: number) {
        await authorizeAdmin(actor, workspaceId);
        return json<Record<string, unknown>>(`${adminPrefix}/runs/${runId}/cancel`, { method: 'POST' }, true);
      },
      async block(actor: Actor, workspaceId: string, id: string) {
        await authorizeAdmin(actor, workspaceId);
        return json<Record<string, unknown>>(`${adminPrefix}/cards/${encodeURIComponent(id)}/block`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, true);
      },
    },
  };
}
export type NativeArchiveService = ReturnType<typeof createNativeArchiveService>;
