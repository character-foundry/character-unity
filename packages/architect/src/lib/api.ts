// Unity port: Architect's components call `api.*` unchanged. Card persistence,
// versions, tokens and export go to the unity API; everything else falls through
// to Architect's original client (lib/api-architect.ts), whose server routes are
// not hosted by unity and therefore report an error that the UI already handles.
import { registry } from '@character-foundry/character-foundry/tokenizers';
import { ApiClient } from './api-architect';
import type { CardListOptions } from './card-list';
import type { Card, CardMeta, CCv2Data, CCv3Data, TokenizeRequest, TokenizeResponse } from './types';
import { setCardImageUrl, unityHost } from '../unity/config';

type Result<T> = { data?: T; error?: string };
type Json = Record<string, unknown>;
interface UnityRevision { id: string; sequence: number; document: Json; createdAt: string; assets?: { path: string; assetId: string }[] }
interface UnityOpened { card: { id: string; headRevisionId: string; createdAt: string; forkedFromRevisionId: string | null }; revision: UnityRevision }
interface UnitySummary { id: string; headRevisionId: string; name: string; creator: string; tags: string[]; spec: 'v2' | 'v3'; hasPortrait: boolean; createdAt: string; updatedAt: string }

/** Last known head revision per card; saves must name the head they replace. */
const heads = new Map<string, string>();
const portraits = new Map<string, boolean>();

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
  portraits.set(id, (revision.assets ?? []).some((asset) => asset.path === 'portrait'));
  const meta: CardMeta = {
    id, name: text(data.name) || 'Untitled', spec: revision.document.spec === 'chara_card_v3' ? 'v3' : 'v2', tags,
    creator: text(data.creator) || undefined, characterVersion: text(data.character_version) || undefined,
    rating: tags.some((tag) => tag.toLowerCase() === 'nsfw') ? 'NSFW' : 'SFW',
    createdAt, updatedAt: revision.createdAt, assetCount: (revision.assets ?? []).filter((asset) => asset.path !== 'portrait').length,
  };
  return { meta, data: revision.document as unknown as CCv2Data | CCv3Data };
}

function summaryCard(summary: UnitySummary): Card {
  heads.set(summary.id, summary.headRevisionId);
  portraits.set(summary.id, summary.hasPortrait);
  const spec = summary.spec === 'v3' ? 'chara_card_v3' : 'chara_card_v2';
  return {
    meta: { id: summary.id, name: summary.name, spec: summary.spec, tags: summary.tags, creator: summary.creator || undefined, createdAt: summary.createdAt, updatedAt: summary.updatedAt },
    data: { spec, spec_version: summary.spec === 'v3' ? '3.0' : '2.0', data: { name: summary.name, creator: summary.creator, tags: summary.tags } } as unknown as CCv2Data | CCv3Data,
  };
}

async function readRevision(cardId: string, revisionId: string) {
  return unity<UnityRevision>(`${base()}/${encodeURIComponent(cardId)}/revisions/${encodeURIComponent(revisionId)}`);
}

class UnityApiClient extends ApiClient {
  override async listCards(query?: string, page = 1, limit = 50, _favoritesOnly = false, _options: CardListOptions = {}) {
    void _favoritesOnly; void _options;
    const params = new URLSearchParams({ limit: String(Math.min(100, limit)), offset: String((page - 1) * Math.min(100, limit)) });
    if (query) params.set('q', query);
    const result = await unity<{ cards: UnitySummary[]; total: number }>(`${base().replace(/\/cards$/, '')}/card-summaries?${params}`);
    if (result.error || !result.data) return { error: result.error };
    return { data: { items: result.data.cards.map(summaryCard), total: result.data.total } };
  }

  override async getCard(id: string): Promise<Result<Card>> {
    const result = await unity<UnityOpened>(`${base()}/${encodeURIComponent(id)}`);
    if (result.error || !result.data) return { error: result.error };
    return { data: toCard(id, result.data.revision, result.data.card.createdAt) };
  }

  override async updateCard(id: string, updates: Partial<Card>): Promise<Result<Card>> {
    const expectedHead = heads.get(id);
    if (!expectedHead) return { error: 'Reload this card before saving' };
    if (!updates.data) return { error: 'Nothing to save' };
    const result = await unity<UnityRevision>(`${base()}/${encodeURIComponent(id)}/revisions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedHead, document: updates.data }),
    });
    if (result.error || !result.data) return { error: result.error };
    return { data: toCard(id, result.data, updates.meta?.createdAt ?? result.data.createdAt) };
  }

  /** First save of an editor draft: the document becomes a library card through the import path. */
  override async createCard(card: unknown): Promise<Result<Card>> {
    const document = (card as Partial<Card> | null)?.data;
    if (!document) return { error: 'Nothing to save' };
    const forkOf = (card as Partial<Card>).meta?.forkOf;
    if (forkOf) {
      // A fork draft: the fork and its edits are created together, against the head the draft was opened from.
      const expectedHead = heads.get(forkOf);
      if (!expectedHead) return { error: 'Reload the original card before saving this fork' };
      const forked = await unity<{ card: { id: string } }>(`${base()}/${encodeURIComponent(forkOf)}/forks`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedHead, document }),
      });
      if (forked.error || !forked.data) return { error: forked.error };
      return this.getCard(forked.data.card.id);
    }
    const created = await unity<{ card: { id: string } }>(`${base().replace(/\/cards$/, '')}/imports`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'new-character.json' },
      body: new TextEncoder().encode(JSON.stringify(document)),
    });
    if (created.error || !created.data) return { error: created.error };
    return this.getCard(created.data.card.id);
  }

  override async deleteCard(id: string): Promise<Result<void>> {
    const result = await unity<null>(`${base()}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return result.error ? { error: result.error } : { data: undefined };
  }

  override getCardImageUrl(cardId: string): string {
    const head = heads.get(cardId);
    if (!head || portraits.get(cardId) === false) return '';
    return `${base()}/${encodeURIComponent(cardId)}/asset?${new URLSearchParams({ revisionId: head, path: 'portrait' })}`;
  }

  // Assets are mapped to unity bindings in a later step (assetsEnabled is off).
  override async getCardAssets(_cardId: string): Promise<Result<never[]>> { void _cardId; return { data: [] }; }

  override async listVersions(cardId: string): Promise<Result<unknown[]>> {
    const history = await unity<{ revisions: { id: string; sequence: number; createdAt: string }[] }>(`${base()}/${encodeURIComponent(cardId)}/revisions?limit=20`);
    if (history.error || !history.data) return { error: history.error };
    const rows = [...history.data.revisions].sort((a, b) => b.sequence - a.sequence);
    const versions = await Promise.all(rows.map(async (row) => {
      const revision = await readRevision(cardId, row.id);
      return { id: row.id, cardId, version: row.sequence, data: revision.data?.document, createdAt: row.createdAt, message: row.id === heads.get(cardId) ? 'Current' : undefined };
    }));
    return { data: versions.filter((version) => version.data) };
  }

  /** Every unity save is already an immutable revision; a snapshot just confirms the saved head. */
  override async createVersion(cardId: string, _message?: string): Promise<Result<unknown>> {
    void _message;
    const head = heads.get(cardId);
    return head ? { data: { id: head } } : { error: 'Reload this card first' };
  }

  override async restoreVersion(cardId: string, versionId: string): Promise<Result<Card>> {
    const revision = await readRevision(cardId, versionId);
    if (revision.error || !revision.data) return { error: revision.error };
    return this.updateCard(cardId, { data: revision.data.document as unknown as Card['data'] });
  }

  override async deleteVersion(_cardId: string, _versionId: string): Promise<Result<void>> {
    void _cardId; void _versionId;
    return { error: 'Saved revisions are permanent' };
  }

  override async tokenize(req: TokenizeRequest): Promise<Result<TokenizeResponse>> {
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

  override async exportCard(cardId: string, format: 'json' | 'png' | 'charx' | 'voxta'): Promise<{ data: Blob; error?: undefined } | { data?: undefined; error: string }> {
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
setCardImageUrl((cardId) => api.getCardImageUrl(cardId));
