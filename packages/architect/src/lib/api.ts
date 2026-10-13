// The editor speaks Unity's revision and asset contracts directly.
import { registry } from '@character-foundry/character-foundry/tokenizers';
import type { CardListOptions } from './card-list';
import type { Card, CardMeta, CCv2Data, CCv3Data, TokenizeRequest, TokenizeResponse } from './types';
import { setCardImageUrl, unityHost } from '../unity/config';
import { assetPlanForm, editorAssets } from '../unity/assets';
import type { AssetMetadata } from '../unity/assets';

type Result<T> = { data?: T; error?: string };
type Json = Record<string, unknown>;
interface UnityRevision { id: string; sequence: number; document: Json; createdAt: string; assets?: { path: string; assetId: string }[] }
interface UnityOpened { card: { id: string; headRevisionId: string; createdAt: string; forkedFromRevisionId: string | null }; revision: UnityRevision }
export interface UnityVersion { id: string; cardId: string; version: number; createdAt: string; message?: string; data?: Card['data'] }
interface UnitySummary { id: string; headRevisionId: string; name: string; creator: string; tags: string[]; spec: 'v2' | 'v3'; hasPortrait: boolean; favorite: boolean; createdAt: string; updatedAt: string }

/** Last known head revision per card; saves must name the head they replace. */
const heads = new Map<string, string>();
const imageHeads = new Map<string, string>();
const portraits = new Map<string, boolean>();
const favorites = new Map<string, boolean>();

function base() {
  const host = unityHost();
  if (!host) throw new Error('The unity host is not configured');
  return `/api/workspaces/${encodeURIComponent(host.workspaceId)}/cards`;
}

async function send(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
  const response = await fetch(path, { credentials: 'same-origin', ...init });
  const reconnect = unityHost()?.reconnect;
  if (response.status === 401 && !retried && reconnect) { await reconnect(); return send(path, init, true); }
  return response;
}

async function unity<T>(path: string, init: RequestInit = {}): Promise<Result<T>> {
  try {
    const response = await send(path, init);
    const body = await response.json().catch(() => null) as (T & { error?: { message?: string } }) | null;
    if (!response.ok) return { error: body?.error?.message ?? `HTTP ${response.status}` };
    return { data: body as T };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Network error' };
  }
}

function text(value: unknown) { return typeof value === 'string' ? value : ''; }

function toCard(id: string, revision: UnityRevision, createdAt: string): Card {
  const data = (revision.document.data ?? {}) as Json;
  const tags = Array.isArray(data.tags) ? data.tags.filter((tag): tag is string => typeof tag === 'string') : [];
  heads.set(id, revision.id);
  imageHeads.set(id, revision.id);
  portraits.set(id, (revision.assets ?? []).some((asset) => asset.path === 'portrait'));
  const meta: CardMeta = {
    id, name: text(data.name) || 'Untitled', spec: revision.document.spec === 'chara_card_v3' ? 'v3' : 'v2', tags, favorite: favorites.get(id) ?? false,
    creator: text(data.creator) || undefined, characterVersion: text(data.character_version) || undefined,
    rating: tags.some((tag) => tag.toLowerCase() === 'nsfw') ? 'NSFW' : 'SFW',
    createdAt, updatedAt: revision.createdAt, assetCount: (revision.assets ?? []).filter((asset) => asset.path.startsWith('declared/')).length,
  };
  return { meta, data: revision.document as unknown as CCv2Data | CCv3Data };
}

function summaryCard(summary: UnitySummary): Card {
  imageHeads.set(summary.id, summary.headRevisionId);
  portraits.set(summary.id, summary.hasPortrait);
  favorites.set(summary.id, summary.favorite);
  const spec = summary.spec === 'v3' ? 'chara_card_v3' : 'chara_card_v2';
  return {
    meta: { id: summary.id, name: summary.name, spec: summary.spec, tags: summary.tags, favorite: summary.favorite, creator: summary.creator || undefined, createdAt: summary.createdAt, updatedAt: summary.updatedAt },
    data: { spec, spec_version: summary.spec === 'v3' ? '3.0' : '2.0', data: { name: summary.name, creator: summary.creator, tags: summary.tags } } as unknown as CCv2Data | CCv3Data,
  };
}

async function readRevision(cardId: string, revisionId: string) {
  return unity<UnityRevision>(`${base()}/${encodeURIComponent(cardId)}/revisions/${encodeURIComponent(revisionId)}`);
}

export class UnityApiClient {
  async listCards(query?: string, page = 1, limit = 50, favoritesOnly = false, options: CardListOptions = {}) {
    const params = new URLSearchParams({ limit: String(Math.min(100, limit)), offset: String((page - 1) * Math.min(100, limit)) });
    if (query) params.set('q', query);
    if (favoritesOnly || options.filter === 'favorites') params.set('favorite', 'fav');
    const sort = { edited: 'edited', newest: 'added', oldest: 'oldest', name: 'name' } as const;
    if (options.sort) params.set('sort', sort[options.sort]);
    const result = await unity<{ cards: UnitySummary[]; total: number }>(`${base().replace(/\/cards$/, '')}/card-summaries?${params}`);
    if (result.error || !result.data) return { error: result.error };
    return { data: { items: result.data.cards.map(summaryCard), total: result.data.total } };
  }

  async getCard(id: string, options: { signal?: AbortSignal } = {}): Promise<Result<Card>> {
    const result = await unity<UnityOpened>(`${base()}/${encodeURIComponent(id)}`, { signal: options.signal });
    if (result.error || !result.data) return { error: result.error };
    return { data: toCard(id, result.data.revision, result.data.card.createdAt) };
  }

  async updateCard(id: string, updates: Partial<Card>): Promise<Result<Card>> {
    const expectedHead = heads.get(id);
    if (!expectedHead) return { error: 'Reload this card before saving' };
    if (!updates.data) return { error: 'Nothing to save' };
    const card = updates as Card;
    const changedAssets = editorAssets.hasChanges(card);
    const plan = changedAssets ? await editorAssets.prepare(card) : undefined;
    const result = await unity<UnityRevision>(`${base()}/${encodeURIComponent(id)}/${changedAssets ? 'asset-revisions' : 'revisions'}`, plan ? {
      method: 'POST', body: assetPlanForm(plan, expectedHead),
    } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedHead, document: updates.data }) });
    if (result.error || !result.data) return { error: result.error };
    const saved = toCard(id, result.data, updates.meta?.createdAt ?? result.data.createdAt);
    if (plan) editorAssets.accept(saved, plan, result.data.id);
    return { data: saved };
  }

  /** First save of an editor draft: the document becomes a library card through the import path. */
  async createCard(card: unknown): Promise<Result<Card>> {
    const draft = card as Card | null;
    if (!draft?.data) return { error: 'Nothing to save' };
    const forkOf = draft.meta.forkOf;
    const expectedHead = forkOf ? heads.get(forkOf) : undefined;
    if (forkOf && !expectedHead) return { error: 'Reload the original card before saving this fork' };
    const plan = await editorAssets.prepare(draft);
    const created = await unity<{ cardId: string; revisionId: string; revision: UnityRevision }>(forkOf
      ? `${base()}/${encodeURIComponent(forkOf)}/fork-assets` : base(), { method: 'POST', body: assetPlanForm(plan, expectedHead) });
    if (created.error || !created.data) return { error: created.error };
    const saved = toCard(created.data.cardId, created.data.revision, created.data.revision.createdAt);
    editorAssets.accept(saved, plan, created.data.revisionId);
    return { data: saved };
  }

  async deleteCard(id: string): Promise<Result<void>> {
    const result = await unity<null>(`${base()}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return result.error ? { error: result.error } : { data: undefined };
  }

  getCardImageUrl(cardId: string): string {
    const head = imageHeads.get(cardId);
    if (!head || portraits.get(cardId) === false) return '';
    return `${base()}/${encodeURIComponent(cardId)}/asset?${new URLSearchParams({ revisionId: head, path: 'portrait' })}`;
  }

  async importFile(file: File, options: { signal?: AbortSignal } = {}): Promise<Result<Card>> {
    const created = await unity<{ card: { id: string } }>(`${base().replace(/\/cards$/, '')}/imports`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name), 'x-file-name-encoding': 'uri' }, body: file, signal: options.signal,
    });
    if (created.error || !created.data) return { error: created.error };
    return this.getCard(created.data.card.id, options);
  }

  async getFavorite(cardId: string): Promise<Result<{ favorite: boolean }>> { return { data: { favorite: favorites.get(cardId) ?? false } }; }
  async setFavorite(cardId: string, favorite: boolean): Promise<Result<{ favorite: boolean }>> {
    const result = await unity<null>(`${base()}/${encodeURIComponent(cardId)}/favorite`, { method: favorite ? 'PUT' : 'DELETE' });
    if (result.error) return { error: result.error };
    favorites.set(cardId, favorite); return { data: { favorite } };
  }

  async listVersions(cardId: string): Promise<Result<UnityVersion[]>> {
    const versions: UnityVersion[] = [];
    let afterSequence = 0, throughSequence: number | undefined;
    do {
      const params = new URLSearchParams({ limit: '20', afterSequence: String(afterSequence), ...(throughSequence ? { throughSequence: String(throughSequence) } : {}) });
      const history = await unity<{ revisions: { id: string; sequence: number; createdAt: string }[]; throughSequence: number; headRevisionId: string; nextAfter: number | null }>(`${base()}/${encodeURIComponent(cardId)}/revisions?${params}`);
      if (history.error || !history.data) return { error: history.error };
      const page = history.data;
      throughSequence ??= page.throughSequence;
      versions.push(...page.revisions.map((row) => ({ id: row.id, cardId, version: row.sequence, createdAt: row.createdAt,
        ...(row.id === page.headRevisionId ? { message: 'Current' } : {}) })));
      if (page.nextAfter === null) break;
      if (page.nextAfter <= afterSequence) return { error: 'Revision history did not advance' };
      afterSequence = page.nextAfter;
    } while (throughSequence === undefined || afterSequence < throughSequence);
    return { data: versions.sort((a, b) => b.version - a.version) };
  }

  async getVersion(cardId: string, revisionId: string): Promise<Result<UnityVersion & { data: Card['data'] }>> {
    const result = await readRevision(cardId, revisionId);
    if (result.error || !result.data) return { error: result.error };
    const revision = result.data;
    return { data: { id: revision.id, cardId, version: revision.sequence, createdAt: revision.createdAt, data: revision.document as unknown as Card['data'] } };
  }

  async restoreVersion(cardId: string, versionId: string): Promise<Result<Card>> {
    const expectedHead = heads.get(cardId);
    if (!expectedHead) return { error: 'Reload this card before restoring a revision' };
    const revision = await unity<UnityRevision>(`${base()}/${encodeURIComponent(cardId)}/restores`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedHead, revisionId: versionId }),
    });
    if (revision.error || !revision.data) return { error: revision.error };
    return { data: toCard(cardId, revision.data, revision.data.createdAt) };
  }

  async tokenize(req: TokenizeRequest): Promise<Result<TokenizeResponse>> {
    try {
      const tokenizer = registry.get(req.model);
      const fields: Record<string, number> = {};
      let total = 0;
      for (const [key, value] of Object.entries(req.payload)) { fields[key] = tokenizer.count(value); total += fields[key]!; }
      return { data: { model: req.model, fields, total } };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Tokenizer unavailable' };
    }
  }

  async exportCard(cardId: string, format: 'json' | 'png' | 'charx' | 'voxta'): Promise<{ data: Blob; error?: undefined } | { data?: undefined; error: string }> {
    const head = heads.get(cardId);
    if (!head) return { error: 'Reload this card first' };
    if (format === 'voxta') return { error: 'Voxta export is not available in the unified app yet' };
    try {
      const response = await send(`${base()}/${encodeURIComponent(cardId)}/export?${new URLSearchParams({ format, revisionId: head })}`);
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        return { error: body?.error?.message ?? 'Export failed' };
      }
      return { data: await response.blob() };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Export failed' };
    }
  }
}

export const api = new UnityApiClient();
editorAssets.configure({
  head: (cardId) => heads.get(cardId),
  list: async (cardId, revisionId) => {
    const result = await unity<{ assets: AssetMetadata[] }>(`${base()}/${encodeURIComponent(cardId)}/assets?${new URLSearchParams({ revisionId })}`);
    if (result.error || !result.data) throw new Error(result.error ?? 'Asset listing failed');
    return result.data.assets;
  },
  url: (cardId, revisionId, path) => `${base()}/${encodeURIComponent(cardId)}/asset?${new URLSearchParams({ revisionId, path })}`,
});
setCardImageUrl((cardId) => api.getCardImageUrl(cardId));
