import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useSearchParams } from 'react-router';
import { libraryId, listCardTags, listCards, listFollowedCreators } from './unity';
import type { LibraryQuery } from './unity';
import { toListItem } from './adapt';
import type { CardListItem } from '@/types/card';

/** Library search state as it lives in the URL. Defaults are left out so links stay short. */
export interface LibrarySearch {
  q: string;
  /** The Filters drawer's advanced search; combined with the top box's `q` as `(q) (expr)`. */
  expr: string;
  tags: string[];
  tagMode: 'all' | 'any';
  exclude: string[];
  has: string[];
  fork: '' | 'only' | 'none';
  favorite: '' | 'fav' | 'not_fav';
  source: string;
  minTokens: string;
  sort: string;
}
export const emptySearch: LibrarySearch = { q: '', expr: '', tags: [], tagMode: 'all', exclude: [], has: [], fork: '', favorite: '', source: '', minTokens: '', sort: 'edited' };

export const sortOptions = [
  { value: 'edited', label: 'Recently edited' },
  { value: 'added', label: 'Recently added' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'name', label: 'Name A–Z' },
  { value: 'name_desc', label: 'Name Z–A' },
  { value: 'tokens_desc', label: 'Most tokens' },
  { value: 'tokens_asc', label: 'Fewest tokens' },
  { value: 'greetings', label: 'Most greetings' },
  { value: 'lorebook', label: 'Biggest lorebook' },
  { value: 'revisions', label: 'Most revisions' },
  { value: 'forks', label: 'Most forks' },
] as const;
export const flagOptions = [
  { value: 'greetings', label: 'Alternate greetings' },
  { value: 'lorebook', label: 'Lorebook' },
  { value: 'gallery', label: 'Gallery' },
  { value: 'embeddedImages', label: 'Embedded images' },
  { value: 'expressions', label: 'Expressions' },
  { value: 'chat', label: 'Loaded in a chat app' },
  { value: 'followed', label: 'Followed creators only' },
  { value: 'portrait', label: 'Portrait' },
  { value: 'systemPrompt', label: 'System prompt' },
  { value: 'exampleDialogues', label: 'Example dialogues' },
] as const;
export const sourceOptions = [
  { value: '', label: 'All' },
  { value: 'chub', label: 'Chub' },
  { value: 'ct', label: 'Character Tavern' },
  { value: 'risuai', label: 'RisuAI' },
  { value: 'wyvern', label: 'Wyvern' },
  { value: 'file', label: 'Imported file' },
] as const;

const list = (value: string | null) => (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
export function readSearch(params: URLSearchParams): LibrarySearch {
  const fork = params.get('fork'), favorite = params.get('favorite'), tokens = params.get('minTokens') ?? '';
  return {
    // `search` and `tags` are the Hub names that card links already use.
    q: params.get('search') ?? params.get('q') ?? '',
    expr: params.get('expr') ?? '',
    tags: list(params.get('tags') ?? params.get('tag')),
    tagMode: params.get('match') === 'any' ? 'any' : 'all',
    exclude: list(params.get('exclude')),
    has: list(params.get('has')),
    fork: fork === 'only' || fork === 'none' ? fork : '',
    favorite: favorite === 'fav' || favorite === 'not_fav' ? favorite : '',
    source: sourceOptions.some((option) => option.value && option.value === params.get('source')) ? params.get('source')! : '',
    minTokens: /^[1-9][0-9]{0,6}$/.test(tokens) ? tokens : '',
    sort: sortOptions.some((option) => option.value === params.get('sort')) ? params.get('sort')! : 'edited',
  };
}
export function writeSearch(search: LibrarySearch): URLSearchParams {
  const params = new URLSearchParams();
  if (search.q.trim()) params.set('search', search.q.trim());
  if (search.expr.trim()) params.set('expr', search.expr.trim());
  if (search.tags.length) params.set('tags', search.tags.join(','));
  if (search.tagMode === 'any') params.set('match', 'any');
  if (search.exclude.length) params.set('exclude', search.exclude.join(','));
  if (search.has.length) params.set('has', search.has.join(','));
  if (search.fork) params.set('fork', search.fork);
  if (search.favorite) params.set('favorite', search.favorite);
  if (search.source) params.set('source', search.source);
  if (search.minTokens) params.set('minTokens', search.minTokens);
  if (search.sort !== 'edited') params.set('sort', search.sort);
  return params;
}
/**
 * Search state backed by the URL. Writes build on the last write, not the last render: router updates can
 * land a render later, and two quick changes (a tag, then a sort) must not drop the first.
 */
export function useSearchState() {
  const [params, setParams] = useSearchParams();
  const latest = useRef(params), seen = useRef(params);
  if (params !== seen.current) { seen.current = params; latest.current = params; }
  const replace = useCallback((next: LibrarySearch) => {
    const written = writeSearch(next);
    latest.current = written;
    setParams(written, { replace: true });
  }, [setParams]);
  const update = useCallback((changes: Partial<LibrarySearch>) => replace({ ...readSearch(latest.current), ...changes }), [replace]);
  return { search: readSearch(params), update, replace };
}
export function isFiltered(search: LibrarySearch) {
  return !!(search.q.trim() || search.expr.trim() || search.tags.length || search.exclude.length || search.has.length || search.fork
    || search.favorite || search.source || search.minTokens);
}
export const sameTag = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// ---- Tag counts ----------------------------------------------------------------------------------

let tagVersion = 0;
const tagListeners = new Set<() => void>();
/** Call after imports, edits or deletes so tag counts reload. */
export function libraryChanged() { tagVersion++; for (const listener of tagListeners) listener(); }
function useLibraryVersion() {
  return useSyncExternalStore((listener) => { tagListeners.add(listener); return () => tagListeners.delete(listener); }, () => tagVersion);
}
let lastTags: { tag: string; count: number }[] = [];
/** Tag counts for pickers; refetched on each mount (edits change them) but shown from the last fetch at once. */
export function useCardTags() {
  const version = useLibraryVersion();
  const [tags, setTags] = useState(lastTags);
  useEffect(() => {
    let active = true;
    listCardTags().then((value) => { lastTags = value; if (active) setTags(value); }).catch(() => undefined);
    return () => { active = false; };
  }, [version]);
  return tags;
}

let lastFollowed: string[] = [];
/** Creators followed in this library; refreshed after follow changes (libraryChanged). */
export function useFollowedCreators() {
  const version = useLibraryVersion();
  const [creators, setCreators] = useState(lastFollowed);
  useEffect(() => {
    let active = true;
    listFollowedCreators().then((value) => { lastFollowed = value; if (active) setCreators(value); }).catch(() => undefined);
    return () => { active = false; };
  }, [version]);
  return creators;
}

/** Tags left out by Settings (hidden tags, and NSFW when hidden), lower-cased. */
function hiddenTags(hidden: { tags: readonly string[]; hideNsfw: boolean }) {
  return [...hidden.tags, ...(hidden.hideNsfw ? ['nsfw'] : [])].map((tag) => tag.toLowerCase());
}

/** Cards in the library, less those Settings hides; the bar shows matches against it. */
export function useLibraryTotal(hidden: { tags: readonly string[]; hideNsfw: boolean }) {
  const version = useLibraryVersion();
  const exclude = [...new Set(hiddenTags(hidden))].sort().join(',');
  const [total, setTotal] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    listCards({ exclude: exclude ? exclude.split(',') : [], limit: 1 }).then((page) => { if (active) setTotal(page.total); }).catch(() => undefined);
    return () => { active = false; };
  }, [exclude, version]);
  return total;
}

// ---- Infinite list with place-keeping ------------------------------------------------------------

export const PAGE_SIZE = 48;
interface View { cards: CardListItem[]; total: number; scrollY: number }
/** Loaded results and scroll position per query, so returning from a card lands where you left. */
const views = new Map<string, View>();

export function useLibraryFeed(search: LibrarySearch, hidden: { tags: readonly string[]; hideNsfw: boolean }) {
  const exclude = [...new Set([...search.exclude.map((tag) => tag.toLowerCase()), ...hiddenTags(hidden)])];
  const text = [search.q.trim(), search.expr.trim()].filter(Boolean);
  const query: LibraryQuery = { q: text.length > 1 ? text.map((part) => `(${part})`).join(' ') : text[0] ?? '', tags: search.tags, tagMode: search.tagMode, exclude, has: search.has,
    ...(search.fork ? { fork: search.fork } : {}), ...(search.favorite ? { favorite: search.favorite } : {}),
    ...(search.source ? { source: search.source } : {}), ...(search.minTokens ? { minTokens: Number(search.minTokens) } : {}), sort: search.sort };
  const key = JSON.stringify(query);
  const version = useLibraryVersion();
  const cached = views.get(key);
  const [state, setState] = useState<{ key: string; cards: CardListItem[]; total: number }>(
    () => ({ key, cards: cached?.cards ?? [], total: cached?.total ?? 0 }));
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const busy = useRef(false);
  const queryRef = useRef(query); queryRef.current = query;
  const current = state.key === key ? state : { key, cards: views.get(key)?.cards ?? [], total: views.get(key)?.total ?? 0 };

  const fetchRange = useCallback(async (offset: number, count: number) => {
    const [workspace, ...pages] = await Promise.all([libraryId(),
      ...Array.from({ length: Math.max(1, Math.ceil(count / 100)) }, (_, index) =>
        listCards({ ...queryRef.current, offset: offset + index * 100, limit: Math.min(100, count - index * 100) || PAGE_SIZE }))]);
    const seen = new Set<string>(), cards: CardListItem[] = [];
    for (const page of pages) for (const summary of page.cards) if (!seen.has(summary.id)) { seen.add(summary.id); cards.push(toListItem(workspace, summary)); }
    return { cards, total: pages[0]?.total ?? 0 };
  }, []);

  // A new query starts over; a remembered one refreshes the range it had loaded, keeping its height.
  useEffect(() => {
    const id = ++request.current, remembered = views.get(key);
    busy.current = true; setError(null);
    if (!remembered) { setLoading(true); setState({ key, cards: [], total: 0 }); }
    fetchRange(0, Math.max(PAGE_SIZE, remembered?.cards.length ?? 0)).then((result) => {
      if (id !== request.current) return;
      setState({ key, ...result });
      views.set(key, { ...result, scrollY: views.get(key)?.scrollY ?? 0 });
    }).catch((failure: unknown) => {
      if (id === request.current) setError(failure instanceof Error ? failure.message : 'The library could not be loaded.');
    }).finally(() => { if (id === request.current) { busy.current = false; setLoading(false); } });
  }, [key, version, fetchRange]);

  const hasMore = current.cards.length < current.total;
  const loadMore = useCallback(async () => {
    if (busy.current || !hasMore) return;
    const id = ++request.current, offset = current.cards.length;
    busy.current = true; setLoading(true); setError(null);
    try {
      const result = await fetchRange(offset, PAGE_SIZE);
      if (id !== request.current) return;
      const seen = new Set(current.cards.map((card) => card.id));
      const cards = [...current.cards, ...result.cards.filter((card) => !seen.has(card.id))];
      // An empty page means cards were removed while browsing; stop at what is loaded.
      const total = result.cards.length ? result.total : cards.length;
      setState({ key, cards, total });
      views.set(key, { cards, total, scrollY: views.get(key)?.scrollY ?? 0 });
    } catch (failure) {
      if (id === request.current) setError(failure instanceof Error ? failure.message : 'More cards could not be loaded.');
    } finally {
      if (id === request.current) { busy.current = false; setLoading(false); }
    }
  }, [current.cards, hasMore, key, fetchRange]);

  // Remember the scroll position for this query and put it back when the page is revisited.
  useLayoutEffect(() => {
    const saved = views.get(key)?.scrollY ?? 0;
    window.scrollTo(0, saved);
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { const view = views.get(key); if (view) view.scrollY = window.scrollY; });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { cancelAnimationFrame(frame); window.removeEventListener('scroll', onScroll); };
  }, [key]);

  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasMore || loading || error) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { rootMargin: '800px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loading, error, loadMore]);

  const retry = () => { if (current.cards.length) void loadMore(); else libraryChanged(); };
  return { cards: current.cards, total: current.total, loading, error, hasMore, loadMore, retry, sentinel };
}

// ---- Saved searches -------------------------------------------------------------------------------

export interface SavedSearch { name: string; params: string }
const savedKey = 'unity-saved-searches';
export function loadSavedSearches(): SavedSearch[] {
  try {
    const value = JSON.parse(localStorage.getItem(savedKey) ?? '[]') as unknown;
    return Array.isArray(value) ? value.filter((item): item is SavedSearch => typeof item?.name === 'string' && typeof item?.params === 'string') : [];
  } catch { return []; }
}
export function storeSavedSearches(searches: SavedSearch[]) {
  try { localStorage.setItem(savedKey, JSON.stringify(searches)); } catch { /* private mode: searches last for this visit */ }
}

// ---- Inputs --------------------------------------------------------------------------------------

export const fieldClass = 'w-full rounded-lg border border-nebula/30 bg-deep-space/60 px-3 py-2 text-sm text-starlight placeholder:text-starlight/30 focus:border-nebula focus:outline-none';

/** Text box that reports changes after a pause, and follows outside changes (header search, tag links). */
export function useDebouncedText(value: string, onCommit: (value: string) => void, delay = 300) {
  const [text, setText] = useState(value);
  const committed = useRef(value);
  useEffect(() => { if (value !== committed.current) { committed.current = value; setText(value); } }, [value]);
  useEffect(() => {
    if (text === committed.current) return;
    const timer = setTimeout(() => { committed.current = text; onCommit(text); }, delay);
    return () => clearTimeout(timer);
  }, [text, delay, onCommit]);
  const flush = () => { if (text !== committed.current) { committed.current = text; onCommit(text); } };
  return [text, setText, flush] as const;
}
