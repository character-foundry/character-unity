import { ScrapeHttpError } from '@character-unity/scraper-kit';
import type { Listing, ScrapeContext, ScrapedCard, ScrapedObject, ScraperPlugin, SourceStats } from '@character-unity/scraper-kit';

const gateway = 'https://gateway.chub.ai';
type Node = Record<string, unknown>;
const record = (value: unknown): Node => value && typeof value === 'object' && !Array.isArray(value) ? value as Node : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** Creator = the first segment of `fullPath` (`creator/card-slug`). */
const creatorOf = (node: Node) => text(node.fullPath).split('/')[0] ?? '';
const statsOf = (node: Node): SourceStats => {
  const stats: SourceStats = {};
  const pairs = [['stars', node.starCount], ['favorites', node.n_favorites], ['chats', node.nChats], ['messages', node.nMessages], ['rating', node.rating]] as const;
  for (const [key, value] of pairs) { const parsed = number(value); if (parsed !== undefined) stats[key] = parsed; }
  return stats;
};
const updatedOf = (node: Node) => text(node.lastActivityAt) || text(node.updatedAt) || text(node.createdAt) || undefined;

/** Chub's search answers `{ data: { nodes } }`; older answers put `nodes` at the top. */
const nodesOf = (body: unknown): Node[] => {
  const root = record(body);
  const nodes = record(root.data).nodes ?? root.nodes;
  return Array.isArray(nodes) ? nodes.map(record) : [];
};

async function optional(task: () => Promise<Uint8Array>): Promise<Uint8Array | null> {
  try { return await task(); } catch (error) {
    if (error instanceof ScrapeHttpError && (error.status === 404 || error.status === 403)) return null;
    throw error;
  }
}

/**
 * Chub (chub.ai). Listings come from the public search (or the account timeline with an API key) and
 * followed creators. Per card it fetches the repository's `card_v2.json` (falling back to `card.json`), the
 * full-size `chara_card_v2.png`, linked lorebooks, and whether the card has a gallery.
 */
export const chub: ScraperPlugin = {
  provider: 'chub',
  label: 'Chub',
  minIntervalMs: 1_000,
  headers(secrets) {
    const key = secrets.apiKey?.trim();
    return {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
      origin: 'https://chub.ai', referer: 'https://chub.ai/',
      ...(key ? { samwise: key, 'CH-API-KEY': key } : {}),
    };
  },
  secrets: [{ key: 'apiKey', label: 'API key', help: 'Needed for timeline mode; also lets search include cards only your account can see.' }],
  settings: [
    { key: 'mode', label: 'Listing', type: 'choice', default: 'search', choices: [{ value: 'search', label: 'Search (everything)' }, { value: 'timeline', label: 'My timeline (needs API key)' }] },
    { key: 'sort', label: 'Order', type: 'choice', default: 'last_activity_at', choices: [{ value: 'last_activity_at', label: 'Recently updated' }, { value: 'created_at', label: 'Newest' }] },
    { key: 'pages', label: 'Pages per run', type: 'number', default: 1, min: 1, max: 200 },
    { key: 'perPage', label: 'Cards per page', type: 'number', default: 100, min: 1, max: 500 },
    { key: 'startPage', label: 'Start page', type: 'number', default: 1, min: 1, max: 10_000 },
    { key: 'minTokens', label: 'Minimum tokens', type: 'number', default: 50, min: 0, max: 1_000_000 },
    { key: 'topics', label: 'Only these tags (any)', type: 'list', default: [] },
    { key: 'excludeTopics', label: 'Leave out these tags', type: 'list', default: [] },
    { key: 'nsfw', label: 'Include NSFW', type: 'boolean', default: true },
    { key: 'followedCreators', label: 'Followed creators', type: 'list', default: [], help: 'Their newest cards are fetched on every run.' },
    { key: 'followedOnly', label: 'Only followed creators', type: 'boolean', default: false },
    { key: 'blockedCreators', label: 'Blocked creators', type: 'list', default: [] },
    { key: 'checkGallery', label: 'Check for galleries', type: 'boolean', default: true, help: 'One extra request per new or changed card.' },
    { key: 'linkedLorebooks', label: 'Fetch linked lorebooks', type: 'boolean', default: true },
  ],

  async *discover(context) {
    const settings = context.settings;
    const blocked = new Set((settings.blockedCreators as string[]).map((name) => name.toLowerCase()));
    const minTokens = settings.minTokens as number;
    const keep = (node: Node) => {
      const id = number(node.id) ?? Number(text(node.id));
      if (!Number.isSafeInteger(id) || id === 88) return false; // 88 is Chub's own placeholder project
      if (blocked.has(creatorOf(node).toLowerCase())) return false;
      const tokens = number(node.nTokens) ?? number(node.tokenCount);
      return !(minTokens && tokens !== undefined && tokens < minTokens);
    };
    const listing = (node: Node): Listing => {
      const updatedAt = updatedOf(node);
      return { recordId: String(node.id), stats: statsOf(node), hint: node, ...(updatedAt ? { updatedAt } : {}) };
    };
    async function* search(extra: Record<string, string>) {
      const perPage = settings.perPage as number, first = settings.startPage as number;
      for (let page = first; page < first + (settings.pages as number); page++) {
        context.signal.throwIfAborted();
        const params = new URLSearchParams({ search: '', first: String(perPage), page: String(page), sort: settings.sort as string, asc: 'false',
          nsfw: String(settings.nsfw), nsfl: String(settings.nsfw), min_tokens: String(Math.max(minTokens, 0)), namespace: 'characters',
          include_forks: 'true', chub: 'true', inclusive_or: 'true', ...extra });
        if ((settings.topics as string[]).length && !extra.username) params.set('topics', (settings.topics as string[]).join(','));
        if ((settings.excludeTopics as string[]).length) params.set('excludetopics', (settings.excludeTopics as string[]).join(','));
        const nodes = nodesOf(await context.http.json(`${gateway}/search?${params}`));
        for (const node of nodes) if (keep(node)) yield listing(node);
        if (nodes.length < perPage) return;
      }
    }
    if (!settings.followedOnly) {
      if (settings.mode === 'timeline') {
        if (!context.secrets.apiKey?.trim()) throw new Error('Chub timeline mode needs an API key');
        const first = settings.startPage as number;
        for (let page = first; page < first + (settings.pages as number); page++) {
          context.signal.throwIfAborted();
          const nodes = nodesOf(await context.http.json(`${gateway}/api/timeline/v1?page=${page}&count=true`));
          if (!nodes.length) break;
          for (const node of nodes) {
            if (node.projectSpace !== undefined && node.projectSpace !== 'characters') continue;
            if (Array.isArray(node.labels) && node.labels.some((label) => record(label).title === 'Forked')) continue;
            if (keep(node)) yield listing(node);
          }
        }
      } else yield* search({});
    }
    for (const creator of settings.followedCreators as string[]) yield* search({ username: creator, sort: 'created_at', exclude_mine: 'false' });
  },

  async fetch(context: ScrapeContext, listing: Listing): Promise<ScrapedCard | null> {
    const node = record(listing.hint);
    const id = listing.recordId;
    const http = context.http;
    const raw = (path: string) => optional(async () => (await http.request(`${gateway}/api/v4/projects/${id}/repository/files/${path}/raw?ref=main&response_type=blob`)).bytes);
    const definition = await raw('card_v2.json') ?? await raw('card.json');
    const imageBase = text(node.max_res_url) || text(node.avatar_url);
    const slash = imageBase.lastIndexOf('/');
    const image = slash > 0 ? await optional(async () => (await http.request(`${imageBase.slice(0, slash + 1)}chara_card_v2.png`)).bytes) : null;
    if (!definition && !image) throw new Error(`Chub card ${id} has neither a card file nor a card image`);

    const objects: ScrapedObject[] = [];
    // The repository JSON is the card; the PNG is its portrait. Without the JSON, the PNG (which embeds the card) is the card.
    if (definition) {
      objects.push({ role: 'card', bytes: definition, mediaType: 'application/json', name: 'card_v2.json' });
      if (image) objects.push({ role: 'portrait', bytes: image, mediaType: 'image/png', name: 'chara_card_v2.png' });
    } else objects.push({ role: 'card', bytes: image!, mediaType: 'image/png', name: 'chara_card_v2.png' });
    objects.push({ role: 'raw', bytes: new TextEncoder().encode(JSON.stringify(node)), mediaType: 'application/json', name: 'node.json' });

    if (context.settings.linkedLorebooks) {
      for (const lorebook of (Array.isArray(node.related_lorebooks) ? node.related_lorebooks : []).slice(0, 20)) {
        const lorebookId = number(lorebook) ?? number(record(lorebook).id);
        if (lorebookId === undefined) continue;
        const bytes = await optional(async () => (await http.request(`${gateway}/api/v4/projects/${lorebookId}/repository/files/raw%252Fsillytavern_raw.json/raw?ref=main&response_type=blob`)).bytes);
        if (bytes) objects.push({ role: 'asset', bytes, mediaType: 'application/json', name: `lorebook/${lorebookId}.json` });
      }
    }
    let gallery: boolean | undefined;
    if (context.settings.checkGallery) {
      try {
        const body = record(await http.json(`${gateway}/api/gallery/project/${id}?limit=1&count=false`));
        const items = [body.items, body.data, body.gallery, body.nodes].find(Array.isArray) as unknown[] | undefined;
        gallery = !!items?.length;
      } catch (error) { if (!(error instanceof ScrapeHttpError)) throw error; }
    }
    const fullPath = text(node.fullPath);
    return {
      provider: 'chub', recordId: id, url: fullPath ? `https://chub.ai/characters/${fullPath}` : `https://chub.ai/characters/${id}`,
      name: text(node.name), creator: creatorOf(node), tagline: text(node.tagline), tags: list(node.topics),
      ...(text(node.createdAt) ? { createdAt: text(node.createdAt) } : {}), ...(listing.updatedAt ? { updatedAt: listing.updatedAt } : {}),
      stats: statsOf(node), flags: { ...(gallery !== undefined ? { gallery } : {}), ...(node.hasExpressions === true ? { expressions: true } : {}) },
      objects,
    };
  },
};
