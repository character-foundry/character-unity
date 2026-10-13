import type { CardListOptions } from './card-list';
import type { Card, CardMeta, CCv2Data, CCv3Data, TokenizeRequest, TokenizeResponse } from './types';
import type { UnityHostConfig } from '../unity/config';
import { assetPlanForm, EditorAssetService } from '../unity/assets';
import type { AssetMetadata } from '../unity/assets';

export type Result<T> = { data?: T; error?: string };
type Json = Record<string, unknown>;
interface RequestOptions { signal?: AbortSignal }
interface UnityRevision { id: string; sequence: number; document: Json; createdAt: string; assets?: { path: string; assetId: string }[] }
interface ArchiveReference { archiveId: string; cardId: string; versionId: string }
interface UnityOpened { card: { id: string; createdAt: string }; revision: UnityRevision; favorite?: boolean; reference?: ArchiveReference }
export interface UnityVersion { id: string; cardId: string; version: number; createdAt: string; message?: string; data?: Card['data'] }
interface UnitySummary { id: string; headRevisionId: string; name: string; creator: string; tags: string[]; spec: 'v2' | 'v3'; hasPortrait: boolean; favorite: boolean; createdAt: string; updatedAt: string }
const text = (value: unknown) => typeof value === 'string' ? value : '';

/** A client belongs to exactly one editor and immutable workspace. Neither a
 * background read nor another editor can advance this draft's expected head. */
export class UnityApiClient {
  readonly assets: EditorAssetService;
  readonly workspaceId: string;
  private readonly config: UnityHostConfig;
  private readonly lifetime = new AbortController();
  private readonly signal: AbortSignal;
  private readonly heads = new Map<string, string>();
  private readonly imageHeads = new Map<string, string>();
  private readonly portraits = new Map<string, boolean>();
  private readonly favorites = new Map<string, boolean>();
  private readonly references = new Set<string>();
  private readonly reads = new Map<string, number>();
  private epoch = 0;

  constructor(config: UnityHostConfig, options: RequestOptions = {}) {
    if (!config.workspaceId.trim()) throw new Error('An editor workspace is required');
    this.config = Object.freeze({ ...config });
    this.workspaceId = config.workspaceId;
    this.signal = AbortSignal.any([this.lifetime.signal, ...(options.signal ? [options.signal] : [])]);
    this.assets = new EditorAssetService({
      head: (cardId) => this.headRevision(cardId),
      list: async (cardId, revisionId) => {
        const result = await this.unity<{ assets: AssetMetadata[] }>(`${this.base()}/${encodeURIComponent(cardId)}/assets?${new URLSearchParams({ revisionId })}`);
        if (result.error || !result.data) throw new Error(result.error ?? 'Asset listing failed');
        return result.data.assets;
      },
      url: (cardId, revisionId, path) => `${this.base()}/${encodeURIComponent(cardId)}/asset?${new URLSearchParams({ revisionId, path })}`,
    });
  }
  headRevision(cardId: string) { return this.heads.get(cardId); }
  pinRevision(cardId: string, revisionId: string) { this.heads.set(cardId, revisionId); this.imageHeads.set(cardId, revisionId); }
  select() { this.epoch++; }
  dispose() { this.select(); this.lifetime.abort(); this.assets.reset(); this.heads.clear(); this.imageHeads.clear(); this.reads.clear(); this.references.clear(); }
  private base() { return `/api/workspaces/${encodeURIComponent(this.workspaceId)}/cards`; }
  private current(epoch: number, signal?: AbortSignal) { return epoch === this.epoch && !this.signal.aborted && !signal?.aborted; }
  private async send(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
    const signal = AbortSignal.any([this.signal, ...(init.signal ? [init.signal] : [])]);
    signal.throwIfAborted();
    const response = await fetch(path, { credentials: 'same-origin', ...init, signal });
    signal.throwIfAborted();
    if (response.status === 401 && !retried && this.config.reconnect) {
      await this.config.reconnect(signal); signal.throwIfAborted();
      return this.send(path, { ...init, signal }, true);
    }
    return response;
  }
  private async unity<T>(path: string, init: RequestInit = {}): Promise<Result<T>> {
    try {
      const response = await this.send(path, init);
      const body = await response.json().catch(() => null) as (T & { error?: { message?: string } }) | null;
      if (!response.ok) return { error: body?.error?.message ?? `HTTP ${response.status}` };
      if (body === null) return { error: 'The server returned no saved result' };
      return { data: body };
    } catch (failure) { return { error: failure instanceof Error ? failure.message : 'Network error' }; }
  }
  private toCard(id: string, revision: UnityRevision, createdAt: string, remember = true): Card {
    const data = (revision.document.data ?? {}) as Json;
    const tags = Array.isArray(data.tags) ? data.tags.filter((tag): tag is string => typeof tag === 'string') : [];
    if (remember) {
      this.pinRevision(id, revision.id);
      this.portraits.set(id, (revision.assets ?? []).some((asset) => asset.path === 'portrait'));
    }
    const meta: CardMeta = { id, name: text(data.name) || 'Untitled', spec: revision.document.spec === 'chara_card_v3' ? 'v3' : 'v2',
      tags, favorite: this.favorites.get(id) ?? false, creator: text(data.creator) || undefined,
      characterVersion: text(data.character_version) || undefined, rating: tags.some((tag) => tag.toLowerCase() === 'nsfw') ? 'NSFW' : 'SFW',
      createdAt, updatedAt: revision.createdAt, assetCount: (revision.assets ?? []).filter((asset) => asset.path.startsWith('declared/')).length,
      ...(this.references.has(id) ? { archiveReference: true } : {}) };
    return { meta, data: revision.document as unknown as CCv2Data | CCv3Data };
  }
  async listCards(query?: string, page = 1, limit = 50, favoritesOnly = false, options: CardListOptions = {}, request: RequestOptions = {}) {
    const params = new URLSearchParams({ limit: String(Math.min(100, limit)), offset: String((page - 1) * Math.min(100, limit)) });
    if (query) params.set('q', query);
    if (favoritesOnly || options.filter === 'favorites') params.set('favorite', 'fav');
    const sort = { edited: 'edited', newest: 'added', oldest: 'oldest', name: 'name' } as const;
    if (options.sort) params.set('sort', sort[options.sort]);
    if (options.has?.length) params.set('has', options.has.join(','));
    const result = await this.unity<{ cards: UnitySummary[]; total: number }>(`${this.base().replace(/\/cards$/, '')}/card-summaries?${params}`, request);
    if (result.error || !result.data) return { error: result.error };
    return { data: { total: result.data.total, items: result.data.cards.map((summary) => {
      this.imageHeads.set(summary.id, summary.headRevisionId); this.portraits.set(summary.id, summary.hasPortrait); this.favorites.set(summary.id, summary.favorite);
      return { meta: { id: summary.id, name: summary.name, spec: summary.spec, tags: summary.tags, favorite: summary.favorite,
        creator: summary.creator || undefined, createdAt: summary.createdAt, updatedAt: summary.updatedAt },
        data: { spec: summary.spec === 'v3' ? 'chara_card_v3' : 'chara_card_v2', spec_version: summary.spec === 'v3' ? '3.0' : '2.0',
          data: { name: summary.name, creator: summary.creator, tags: summary.tags } } as unknown as Card['data'] };
    }) } };
  }
  async getCard(id: string, options: RequestOptions & { pinHead?: boolean } = {}): Promise<Result<Card>> {
    const key = JSON.stringify([options.pinHead !== false, id]);
    const epoch = this.epoch, read = (this.reads.get(key) ?? 0) + 1; this.reads.set(key, read);
    const result = await this.unity<UnityOpened>(`${this.base()}/${encodeURIComponent(id)}`, options);
    if (result.error || !result.data) return { error: result.error };
    if (!this.current(epoch, options.signal) || this.reads.get(key) !== read) return { error: 'This card read was superseded' };
    this.favorites.set(id, result.data.favorite === true);
    if (options.pinHead !== false) {
      if (result.data.reference) this.references.add(id); else this.references.delete(id);
    }
    return { data: this.toCard(id, result.data.revision, result.data.card.createdAt, options.pinHead !== false) };
  }
  async updateCard(id: string, updates: Partial<Card>, options: RequestOptions = {}): Promise<Result<Card>> {
    const epoch = this.epoch, expectedHead = this.heads.get(id);
    if (!expectedHead) return { error: 'Reload this card before saving' };
    if (!updates.data) return { error: 'Nothing to save' };
    if (this.references.has(id)) return this.createCard({ ...updates, meta: { ...updates.meta, id: '', forkOf: id } } as Card, options);
    const card = updates as Card, plan = this.assets.hasChanges(card) ? await this.assets.prepare(card) : undefined;
    const result = await this.unity<UnityRevision>(`${this.base()}/${encodeURIComponent(id)}/${plan ? 'asset-revisions' : 'revisions'}`, plan ? {
      method: 'POST', body: assetPlanForm(plan, expectedHead), signal: options.signal,
    } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedHead, document: updates.data }), signal: options.signal });
    if (result.error || !result.data) return { error: result.error };
    const remember = this.current(epoch, options.signal);
    const saved = this.toCard(id, result.data, updates.meta?.createdAt ?? result.data.createdAt, remember);
    if (plan && remember) this.assets.accept(saved, plan, result.data.id);
    return { data: saved };
  }
  async createCard(card: Card, options: RequestOptions = {}): Promise<Result<Card>> {
    const epoch = this.epoch, forkOf = card.meta.forkOf, expectedHead = forkOf ? this.heads.get(forkOf) : undefined;
    if (forkOf && !expectedHead) return { error: 'Reload the original card before saving this fork' };
    const plan = await this.assets.prepare(card);
    const result = await this.unity<{ cardId: string; revisionId: string; revision: UnityRevision; reference?: ArchiveReference }>(forkOf
      ? `${this.base()}/${encodeURIComponent(forkOf)}/fork-assets` : this.base(), { method: 'POST', body: assetPlanForm(plan, expectedHead), signal: options.signal });
    if (result.error || !result.data) return { error: result.error };
    const remember = this.current(epoch, options.signal);
    if (remember) {
      if (result.data.reference) this.references.add(result.data.cardId); else this.references.delete(result.data.cardId);
    }
    const saved = this.toCard(result.data.cardId, result.data.revision, result.data.revision.createdAt, remember);
    if (remember) this.assets.accept(saved, plan, result.data.revisionId);
    return { data: saved };
  }
  async deleteCard(id: string, options: RequestOptions = {}): Promise<Result<void>> {
    try { const response = await this.send(`${this.base()}/${encodeURIComponent(id)}`, { method: 'DELETE', signal: options.signal });
      return response.ok ? { data: undefined } : { error: `Delete failed (${response.status})` };
    } catch (failure) { return { error: failure instanceof Error ? failure.message : 'Delete failed' }; }
  }
  getCardImageUrl(cardId: string) {
    const head = this.imageHeads.get(cardId);
    return !head || this.portraits.get(cardId) === false ? '' : `${this.base()}/${encodeURIComponent(cardId)}/asset?${new URLSearchParams({ revisionId: head, path: 'portrait' })}`;
  }
  async importFile(file: File, options: RequestOptions = {}): Promise<Result<Card>> {
    const result = await this.unity<{ card: { id: string } }>(`${this.base().replace(/\/cards$/, '')}/imports`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name), 'x-file-name-encoding': 'uri' }, body: file, signal: options.signal });
    if (result.error || !result.data) return { error: result.error };
    return this.getCard(result.data.card.id, options);
  }
  async getFavorite(cardId: string): Promise<Result<{ favorite: boolean }>> { return { data: { favorite: this.favorites.get(cardId) ?? false } }; }
  async setFavorite(cardId: string, favorite: boolean, options: RequestOptions = {}): Promise<Result<{ favorite: boolean }>> {
    try { const response = await this.send(`${this.base()}/${encodeURIComponent(cardId)}/favorite`, { method: favorite ? 'PUT' : 'DELETE', signal: options.signal });
      if (!response.ok) return { error: `Favorite failed (${response.status})` };
      this.favorites.set(cardId, favorite); return { data: { favorite } };
    } catch (failure) { return { error: failure instanceof Error ? failure.message : 'Favorite failed' }; }
  }
  async listVersions(cardId: string, options: RequestOptions = {}): Promise<Result<UnityVersion[]>> {
    const versions: UnityVersion[] = []; let afterSequence = 0, throughSequence: number | undefined;
    do {
      const params = new URLSearchParams({ limit: '20', afterSequence: String(afterSequence), ...(throughSequence ? { throughSequence: String(throughSequence) } : {}) });
      const result = await this.unity<{ revisions: { id: string; sequence: number; createdAt: string }[]; throughSequence: number; headRevisionId: string; nextAfter: number | null }>(`${this.base()}/${encodeURIComponent(cardId)}/revisions?${params}`, options);
      if (result.error || !result.data) return { error: result.error };
      const page = result.data; throughSequence ??= page.throughSequence;
      versions.push(...page.revisions.map((row) => ({ id: row.id, cardId, version: row.sequence, createdAt: row.createdAt, ...(row.id === page.headRevisionId ? { message: 'Current' } : {}) })));
      if (page.nextAfter === null) break;
      if (page.nextAfter <= afterSequence) return { error: 'Revision history did not advance' };
      afterSequence = page.nextAfter;
    } while (throughSequence === undefined || afterSequence < throughSequence);
    return { data: versions.sort((a, b) => b.version - a.version) };
  }
  async getVersion(cardId: string, revisionId: string, options: RequestOptions = {}): Promise<Result<UnityVersion & { data: Card['data'] }>> {
    const result = await this.unity<UnityRevision>(`${this.base()}/${encodeURIComponent(cardId)}/revisions/${encodeURIComponent(revisionId)}`, options);
    if (result.error || !result.data) return { error: result.error };
    const revision = result.data;
    return { data: { id: revision.id, cardId, version: revision.sequence, createdAt: revision.createdAt, data: revision.document as unknown as Card['data'] } };
  }
  async restoreVersion(cardId: string, revisionId: string, options: RequestOptions = {}): Promise<Result<Card>> {
    const epoch = this.epoch, expectedHead = this.heads.get(cardId);
    if (!expectedHead) return { error: 'Reload this card before restoring a revision' };
    const result = await this.unity<UnityRevision>(`${this.base()}/${encodeURIComponent(cardId)}/restores`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedHead, revisionId }), signal: options.signal });
    return result.error || !result.data ? { error: result.error } : { data: this.toCard(cardId, result.data, result.data.createdAt, this.current(epoch, options.signal)) };
  }
  async tokenize(req: TokenizeRequest, options: RequestOptions = {}): Promise<Result<TokenizeResponse>> {
    try {
      this.signal.throwIfAborted(); options.signal?.throwIfAborted();
      const { registry } = await import('@character-foundry/character-foundry/tokenizers');
      this.signal.throwIfAborted(); options.signal?.throwIfAborted();
      const tokenizer = registry.get(req.model), fields: Record<string, number> = {}; let total = 0;
      for (const [key, value] of Object.entries(req.payload)) { fields[key] = tokenizer.count(value); total += fields[key]!; }
      return { data: { model: req.model, fields, total } };
    } catch (failure) { return { error: failure instanceof Error ? failure.message : 'Tokenizer unavailable' }; }
  }
  async exportCard(cardId: string, format: 'json' | 'png' | 'charx' | 'voxta', options: RequestOptions = {}): Promise<Result<Blob>> {
    const revisionId = this.heads.get(cardId);
    if (!revisionId) return { error: 'Reload this card first' };
    if (format === 'voxta') return { error: 'Voxta export is not available in the unified app yet' };
    try { const response = await this.send(`${this.base()}/${encodeURIComponent(cardId)}/export?${new URLSearchParams({ format, revisionId })}`, options);
      if (!response.ok) { const body = await response.json().catch(() => null) as { error?: { message?: string } } | null; return { error: body?.error?.message ?? 'Export failed' }; }
      return { data: await response.blob() };
    } catch (failure) { return { error: failure instanceof Error ? failure.message : 'Export failed' }; }
  }
}
