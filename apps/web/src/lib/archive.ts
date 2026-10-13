import { useEffect, useState } from 'react';
import { call, libraryId } from './unity';
import { archiveSortOptions, excludedTags, fetchPages, libraryChanged, searchText, useFeed } from './library-search';
import type { LibrarySearch } from './library-search';

/** A card in the native Archive (scraped from a source), as the API lists it. */
export interface ArchiveCard {
  id: string; provider: string; recordId: string; url: string;
  name: string; creator: string; tagline: string; tags: string[]; spec: 'v2' | 'v3'; tokens: number;
  altGreetings: number; lorebookEntries: number;
  flags: { gallery: boolean; expressions: boolean; embeddedImages: boolean; systemPrompt: boolean; exampleDialogues: boolean };
  stats: { stars?: number; favorites?: number; chats?: number; messages?: number; downloads?: number; rating?: number };
  portrait: string | null;
  remoteCreatedAt: string | null; remoteUpdatedAt: string | null; firstSeenAt: string; changedAt: string;
  versionId: string; versions: number;
  /** The library card it was copied into, if any. */
  libraryCardId: string | null;
}
export interface ArchiveObjectRef { role: 'card' | 'portrait' | 'raw' | 'asset'; name: string; sha256: string; mediaType: string; byteLength: number }
export interface ArchiveCardDetail extends ArchiveCard {
  document: { data?: Record<string, unknown> } | null;
  versionList: { id: string; sequence: number; fetchedAt: string; remoteUpdatedAt: string | null; objects: ArchiveObjectRef[] }[];
}
export interface ArchiveRun {
  id: number; provider: string; trigger: string; status: 'running' | 'done' | 'cancelled' | 'failed'; startedAt: string; finishedAt: string | null; error: string | null;
  listed: number; added: number; updated: number; unchanged: number; skipped: number; blocked: number; errors: number;
}
export type SettingValue = string | number | boolean | string[];
export interface ArchiveSource {
  provider: string; label: string; enabled: boolean; running: number | null; lastRun: ArchiveRun | null; intervalMinutes: number;
  settings: Record<string, SettingValue>;
  settingSpecs: { key: string; label: string; type: 'number' | 'boolean' | 'text' | 'list' | 'choice'; default: SettingValue; help?: string; choices?: { value: string; label: string }[]; min?: number; max?: number }[];
  secretSpecs: { key: string; label: string; help?: string }[];
  secretsSet: string[];
}

export const providerLabels: Record<string, string> = { chub: 'Chub', ct: 'Character Tavern', risuai: 'RisuAI', wyvern: 'Wyvern' };
export const providerShort: Record<string, string> = { chub: 'CHUB', ct: 'CT', risuai: 'RISU', wyvern: 'WYV' };

async function path(rest: string) { return `/api/workspaces/${encodeURIComponent(await libraryId())}/archive/v2${rest}`; }
const jsonBody = (body: unknown): RequestInit => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const archiveApi = {
  async status() { return call<{ archiveId: string; cards: number; providers: Record<string, number>; sources: { provider: string; label: string; enabled: boolean; running: number | null; lastRun: ArchiveRun | null }[] }>(await path('/status')); },
  async list(params: URLSearchParams) { return call<{ cards: ArchiveCard[]; total: number }>(await path(`/cards?${params}`)); },
  async card(id: string) { return call<ArchiveCardDetail>(await path(`/cards/${encodeURIComponent(id)}`)); },
  async tags() { return (await call<{ tags: { tag: string; count: number }[] }>(await path('/tags'))).tags; },
  async objectUrl(hash: string) { return path(`/objects/${hash}`); },
  async import(id: string) {
    const result = await call<{ cardId: string; created: boolean }>(await path(`/cards/${encodeURIComponent(id)}/import`), { method: 'POST' });
    libraryChanged();
    return result;
  },
  async block(id: string) { await call(await path(`/cards/${encodeURIComponent(id)}/block`), { method: 'POST' }); libraryChanged(); },
  async sources() { return (await call<{ sources: ArchiveSource[] }>(await path('/sources'))).sources; },
  async saveSource(provider: string, body: { enabled?: boolean; intervalMinutes?: number; settings?: Record<string, SettingValue>; secrets?: Record<string, string | null> }) {
    return call<ArchiveSource>(await path(`/sources/${provider}`), { method: 'PUT', ...jsonBody(body) });
  },
  async run(provider: string) { return call<{ runId: number }>(await path(`/sources/${provider}/runs`), { method: 'POST' }); },
  async runs(provider?: string) { return (await call<{ runs: ArchiveRun[] }>(await path(`/runs${provider ? `?provider=${provider}` : ''}`))).runs; },
  async cancel(runId: number) { await call(await path(`/runs/${runId}/cancel`), { method: 'POST' }); },
};

/** The URL of an Archive object (portraits); objects never change, so the browser may cache them. */
export function useObjectUrl(hash: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (hash) void archiveApi.objectUrl(hash).then((value) => { if (active) setUrl(value); });
    else setUrl(null);
    return () => { active = false; };
  }, [hash]);
  return url;
}

/** Search params for the Archive's card list, from the shared search state. */
export function archiveParams(search: LibrarySearch, hidden: { tags: readonly string[]; hideNsfw: boolean }) {
  const params = new URLSearchParams();
  const q = searchText(search);
  if (q) params.set('q', q);
  if (search.tags.length) params.set('tags', search.tags.join(','));
  if (search.tagMode === 'any') params.set('match', 'any');
  const exclude = excludedTags(search, hidden);
  if (exclude.length) params.set('exclude', exclude.join(','));
  const has = search.has.filter((flag) => flag !== 'chat');
  if (has.length) params.set('has', has.join(','));
  if (search.source && search.source !== 'file') params.set('provider', search.source);
  if (search.minTokens) params.set('minTokens', search.minTokens);
  params.set('sort', archiveSortOptions.some((option) => option.value === search.sort) ? search.sort : 'updated');
  return params;
}

export function useArchiveFeed(search: LibrarySearch, hidden: { tags: readonly string[]; hideNsfw: boolean }) {
  const params = archiveParams(search, hidden);
  return useFeed<ArchiveCard>(`archive:${params}`, (offset, count) => fetchPages(offset, count, async (from, limit) => {
    const page = new URLSearchParams(params);
    page.set('offset', String(from)); page.set('limit', String(limit));
    const result = await archiveApi.list(page);
    return { items: result.cards, total: result.total };
  }));
}

/** Archive totals for the filter bar (less what Settings hides) and whether the Archive is reachable. */
export function useArchiveTotal(hidden: { tags: readonly string[]; hideNsfw: boolean }) {
  const exclude = [...new Set([...hidden.tags.map((tag) => tag.toLowerCase()), ...(hidden.hideNsfw ? ['nsfw'] : [])])].sort().join(',');
  const [total, setTotal] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    archiveApi.list(new URLSearchParams({ limit: '1', ...(exclude ? { exclude } : {}) })).then((page) => { if (active) setTotal(page.total); }).catch(() => undefined);
    return () => { active = false; };
  }, [exclude]);
  return total;
}

let lastTags: { tag: string; count: number }[] = [];
export function useArchiveTags() {
  const [tags, setTags] = useState(lastTags);
  useEffect(() => {
    let active = true;
    archiveApi.tags().then((value) => { lastTags = value; if (active) setTags(value); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  return tags;
}
