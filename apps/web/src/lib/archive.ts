import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { call, libraryId } from './unity';
import { libraryChanged, PAGE_SIZE, useLibraryVersion, writeSearch } from './library-search';
import type { LibrarySearch } from './library-search';
import { archiveSearchParams } from './archive-search';
import type { ArchiveStatus } from './archive-search';

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
  /** Library membership for this exact displayed version, if any. */
  libraryCardId: string | null;
  /** Owned Unity search projection in the same LanceDB, not an Archive original. */
  libraryOwned?: boolean;
  hasPortrait?: boolean;
  libraryFavorite?: boolean;
}
export interface ArchiveMatch { section: string; text: string; score: number }
export interface ArchivePage { cards: ArchiveCard[]; total: number; complete?: boolean; snapshot?: string; matches?: (ArchiveMatch | null)[]; scores?: number[];
  /** Raw upstream cursor, including hidden stale owned projections. */ nextOffset?: number;
  staleLibraryHits?: number }
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
  async status(signal?: AbortSignal) { return call<ArchiveStatus & { sources: { provider: string; label: string; enabled: boolean; running: number | null; lastRun: ArchiveRun | null }[] }>(await path('/status'), { signal }); },
  async list(params: URLSearchParams, signal?: AbortSignal) { return validateArchivePage(await call<ArchivePage>(await path(`/cards?${params}`), { signal })); },
  async card(id: string, versionId?: string, signal?: AbortSignal) {
    const query = versionId ? `?${new URLSearchParams({ version: versionId })}` : '';
    return call<ArchiveCardDetail>(await path(`/cards/${encodeURIComponent(id)}${query}`), { signal });
  },
  async tags() { return (await call<{ tags: { tag: string; count: number }[] }>(await path('/tags'))).tags; },
  async objectUrl(hash: string) { return path(`/objects/${hash}`); },
  async import(id: string, versionId?: string) {
    const result = await call<{ cardId: string; created: boolean }>(await path(`/cards/${encodeURIComponent(id)}/import`), { method: 'POST', ...(versionId ? jsonBody({ versionId }) : {}) });
    libraryChanged();
    return result;
  },
  async favorite(id: string, versionId?: string) {
    const result = await call<{ cardId: string; created: boolean }>(await path(`/cards/${encodeURIComponent(id)}/favorite`), { method: 'PUT', ...(versionId ? jsonBody({ versionId }) : {}) });
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

interface ArchiveView extends ArchivePage { status: ArchiveStatus; scrollY: number }
const archiveViews = new Map<string, ArchiveView>();
function remember(key: string, view: ArchiveView) {
  archiveViews.delete(key); archiveViews.set(key, view);
  while (archiveViews.size > 10) archiveViews.delete(archiveViews.keys().next().value!);
}

/** Abort stale reads and keep paging bound to the submitted URL query, never to an edited form. */
export function useArchiveFeed(search: LibrarySearch, hidden: { tags: readonly string[]; hideNsfw: boolean }) {
  const key = `${writeSearch(search)}|${JSON.stringify(hidden)}`;
  const version = useLibraryVersion();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; view: ArchiveView | null }>({ key, view: archiveViews.get(key) ?? null });
  const [status, setStatus] = useState<ArchiveStatus | null>(null);
  const [activity, setActivity] = useState<{ key: string; loading: boolean; error: string | null }>({ key, loading: true, error: null });
  const pending = useRef<AbortController | null>(null);
  const liveKey = useRef(key); liveKey.current = key;
  const fetchParams = useRef<URLSearchParams | null>(null);
  const view = state.key === key ? state.view : archiveViews.get(key) ?? null;
  const loading = activity.key === key ? activity.loading : true;
  const error = activity.key === key ? activity.error : null;

  useEffect(() => {
    const controller = new AbortController(); pending.current?.abort(); pending.current = controller;
    const remembered = archiveViews.get(key);
    setState({ key, view: remembered ?? null }); setActivity({ key, loading: true, error: null });
    fetchParams.current = null;
    void (async () => {
      const currentStatus = await archiveApi.status(controller.signal); controller.signal.throwIfAborted();
      setStatus(currentStatus);
      const params = archiveSearchParams(search, hidden, currentStatus); fetchParams.current = params;
      // Native offset pages are not immutable snapshots. Refresh a remembered range before paging it.
      const target = Math.min(480, Math.max(PAGE_SIZE, remembered ? archivePageOffset(remembered) : 0));
      let combined: ArchivePage | null = null;
      let offset = 0;
      while (offset < target) {
        const page = new URLSearchParams(params); page.set('offset', String(offset)); page.set('limit', String(Math.min(100, target - offset)));
        if (combined?.snapshot) page.set('snapshot', combined.snapshot);
        const next = await archiveApi.list(page, controller.signal); controller.signal.throwIfAborted();
        combined = combined ? mergeArchivePage(combined, next) : next;
        const consumed = archivePageOffset(combined);
        if (consumed <= offset && consumed < combined.total) throw new Error('Archive results changed while loading. Search again.');
        offset = consumed;
        if (offset >= combined.total) break;
      }
      const nextView = { ...combined!, status: currentStatus, scrollY: remembered?.scrollY ?? 0 };
      remember(key, nextView); setState({ key, view: nextView });
    })().catch((failure) => {
      if (!controller.signal.aborted) {
        // Never keep old semantic results under a withdrawn capability or failed refresh.
        archiveViews.delete(key); setState({ key, view: null });
        setActivity({ key, loading: false, error: failure instanceof Error ? failure.message : 'The Archive could not answer.' });
      }
    }).finally(() => {
      if (!controller.signal.aborted) { pending.current = null; setActivity((previous) => ({ ...previous, loading: false })); }
    });
    return () => { controller.abort(); pending.current?.abort(); pending.current = null; };
    // The key captures every submitted field and hidden-tag policy.
  }, [key, version, attempt]);

  const hasMore = !!view && archivePageOffset(view) < view.total;
  const loadMore = useCallback(async () => {
    if (pending.current || !view || !hasMore || !fetchParams.current) return;
    const controller = new AbortController(); pending.current = controller;
    setActivity({ key, loading: true, error: null });
    try {
      const page = new URLSearchParams(fetchParams.current); page.set('offset', String(archivePageOffset(view))); page.set('limit', String(PAGE_SIZE));
      if (view.snapshot) page.set('snapshot', view.snapshot);
      const next = await archiveApi.list(page, controller.signal); controller.signal.throwIfAborted();
      if (liveKey.current !== key) return;
      const merged = mergeArchivePage(view, next);
      const nextView = { ...view, ...merged, scrollY: archiveViews.get(key)?.scrollY ?? 0 };
      remember(key, nextView); setState({ key, view: nextView });
    } catch (failure) {
      if (!controller.signal.aborted && liveKey.current === key) setActivity({ key, loading: false, error: failure instanceof Error ? failure.message : 'More cards could not be loaded.' });
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted && liveKey.current === key) setActivity((previous) => ({ ...previous, loading: false }));
    }
  }, [hasMore, key, view]);

  useLayoutEffect(() => {
    window.scrollTo(0, archiveViews.get(key)?.scrollY ?? 0);
    const onScroll = () => { const remembered = archiveViews.get(key); if (remembered) remembered.scrollY = window.scrollY; };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [key]);
  const sentinel = useRef<HTMLDivElement>(null);
  // Explicit paging avoids surprising repeated embedding requests while scrolling.
  return { cards: view?.cards ?? [], total: view?.total ?? 0, complete: view?.complete ?? true, matches: view?.matches,
    staleLibraryHits: view?.staleLibraryHits ?? 0,
    status, loading, error, hasMore, loadMore, retry: () => setAttempt((value) => value + 1), sentinel };
}

export function archivePageOffset(page: ArchivePage) { return page.nextOffset ?? page.cards.length; }

/** Validate native page continuity; never hide duplicate/shifted candidate results with deduplication. */
export function mergeArchivePage(previous: ArchivePage, next: ArchivePage): ArchivePage {
  const stale = (previous.staleLibraryHits ?? 0) + (next.staleLibraryHits ?? 0);
  if (next.total !== previous.total || (next.complete !== previous.complete && !stale)) throw new Error('Archive results changed. Search again before loading more.');
  if (next.snapshot !== previous.snapshot) throw new Error('Archive snapshot changed. Search again before loading more.');
  const offset = archivePageOffset(previous), nextOffset = next.nextOffset ?? offset + next.cards.length;
  if (nextOffset <= offset && offset < previous.total) throw new Error('Archive results changed. Search again before loading more.');
  if (next.nextOffset !== undefined && nextOffset !== offset + next.cards.length + (next.staleLibraryHits ?? 0)) throw new Error('Archive results changed. Search again before loading more.');
  const seen = new Set(previous.cards.map((card) => card.id));
  if (next.cards.some((card) => seen.has(card.id))) throw new Error('Archive result order changed. Search again before loading more.');
  if (previous.matches && (!next.matches || previous.matches.length !== previous.cards.length || next.matches.length !== next.cards.length)) throw new Error('Archive match excerpts changed. Search again.');
  if (previous.scores && (!next.scores || previous.scores.length !== previous.cards.length || next.scores.length !== next.cards.length)) throw new Error('Archive match scores changed. Search again.');
  return { ...next, cards: [...previous.cards, ...next.cards], nextOffset, staleLibraryHits: stale,
    ...(previous.complete === false || next.complete === false ? { complete: false } : {}),
    ...(previous.matches && next.matches ? { matches: [...previous.matches, ...next.matches] } : {}),
    ...(previous.scores && next.scores ? { scores: [...previous.scores, ...next.scores] } : {}) };
}

export function validateArchivePage(page: ArchivePage): ArchivePage {
  if (!page || !Array.isArray(page.cards) || !Number.isSafeInteger(page.total) || page.total < page.cards.length
    || page.cards.length > 100 || new Set(page.cards.map((card) => card.id)).size !== page.cards.length
    || (page.complete !== undefined && typeof page.complete !== 'boolean')
    || (page.nextOffset !== undefined && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset < page.cards.length + (page.staleLibraryHits ?? 0) || page.nextOffset > page.total))
    || (page.staleLibraryHits !== undefined && (!Number.isSafeInteger(page.staleLibraryHits) || page.staleLibraryHits < 0 || page.staleLibraryHits > 100
      || (page.staleLibraryHits > 0 && (page.complete !== false || page.nextOffset === undefined))))
    || (page.snapshot !== undefined && !/^[a-f0-9]{64}$/.test(page.snapshot))
    || (page.matches !== undefined && (!Array.isArray(page.matches) || page.matches.length !== page.cards.length
      || page.matches.some((match) => match !== null && (typeof match.section !== 'string' || typeof match.text !== 'string' || !Number.isFinite(match.score)))))
    || (page.scores !== undefined && (!Array.isArray(page.scores) || page.scores.length !== page.cards.length || page.scores.some((score) => !Number.isFinite(score))))) {
    throw new Error('The Archive returned an invalid result page. Search again.');
  }
  return page;
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
