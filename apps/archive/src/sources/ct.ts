import { ScrapeHttpError } from '@character-unity/scraper-kit';
import type { Listing, ScrapeContext, ScrapedCard, ScrapedObject, ScraperPlugin, SourceStats } from '@character-unity/scraper-kit';
import { readSvelteKitData } from './sveltekit.js';

const site = 'https://character-tavern.com';
const images = 'https://ct-cards.storage.character-tavern.com';
type Node = Record<string, unknown>;
const record = (value: unknown): Node => value && typeof value === 'object' && !Array.isArray(value) ? value as Node : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';
const number = (value: unknown) => {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
};
const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** `author/slug`, lowercased with spaces as underscores (CT's own path form). */
function normalizePath(value: unknown) {
  const [author = '', ...rest] = text(value).trim().replace(/^\/+|\/+$/g, '').split('/');
  const part = (item: string) => item.trim().toLowerCase().replace(/\s+/g, '_');
  return [part(author), part(rest.join('/'))].filter(Boolean).join('/');
}
/** CT timestamps arrive as epoch seconds, epoch milliseconds or ISO strings. */
function iso(value: unknown): string | undefined {
  const epoch = number(value);
  const date = epoch !== undefined ? new Date(epoch < 1e12 ? epoch * 1000 : epoch) : typeof value === 'string' ? new Date(value) : null;
  return date && epoch !== 0 && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
const updatedOf = (node: Node) => iso(node.lastUpdatedAt) ?? iso(node.lastUpdateAt) ?? iso(node.updatedAt) ?? iso(node.updated_at) ?? iso(node.createdAt) ?? iso(node.created_at);
const tokensOf = (node: Node) => number(node.tokenTotal) ?? number(node.totalTokens);
/** Example messages may be a string or a list of strings/objects. */
function examples(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((entry) => typeof entry === 'string' ? entry : text(record(entry).example) || text(record(entry).text) || text(record(entry).message)).filter(Boolean).join('\n');
}
const names = (value: unknown) => [...new Set((Array.isArray(value) ? value : [])
  .map((item) => (typeof item === 'string' ? item : text(record(item).name)).trim()).filter(Boolean))];

/** Cookies CT expects: Cloudflare clearance, the session, and which content warnings the account allows. */
function cookie(context: ScrapeContext): Record<string, string> {
  const parts = [['cf_clearance', context.secrets.cfClearance], ['session', context.secrets.session],
    ['content_warnings', (context.settings.allowedWarnings as string[]).join(',')]]
    .filter(([, value]) => value?.trim()).map(([key, value]) => `${key}=${value!.trim()}`);
  return parts.length ? { cookie: parts.join('; ') } : {};
}

/** A SvelteKit page's data nodes, with CT's Cloudflare refusal explained. */
async function pageData(context: ScrapeContext, url: string) {
  try { return readSvelteKitData(new TextDecoder().decode((await context.http.request(url, { headers: cookie(context) })).bytes)); }
  catch (error) {
    if (error instanceof ScrapeHttpError && error.status === 403) throw new Error('Character Tavern refused the request (403); refresh the cf_clearance cookie in Settings', { cause: error });
    throw error;
  }
}

/**
 * Character Tavern (character-tavern.com). Listings come from the catalog page's data; per card it reads the
 * card page's data (record, tags, content warnings, likes, alternate greetings, lorebook) and the card image. CT serves fields,
 * not a card file, so the card JSON is built from them and the records are kept alongside it.
 */
export const ct: ScraperPlugin = {
  provider: 'ct',
  label: 'Character Tavern',
  minIntervalMs: 1_000,
  headers() {
    return {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
      accept: '*/*', referer: `${site}/`, dnt: '1',
    };
  },
  secrets: [
    { key: 'cfClearance', label: 'cf_clearance cookie', help: 'From a browser signed in to character-tavern.com; it expires, so refresh it when runs start failing with 403.' },
    { key: 'session', label: 'session cookie', help: 'Needed to see cards behind content warnings.' },
  ],
  settings: [
    { key: 'sort', label: 'Order', type: 'choice', default: 'newest', choices: [{ value: 'newest', label: 'Newest' }, { value: 'trending', label: 'Trending' }, { value: 'oldest', label: 'Oldest' }] },
    { key: 'query', label: 'Search text', type: 'text', default: '' },
    { key: 'pages', label: 'Pages per run', type: 'number', default: 3, min: 1, max: 200 },
    { key: 'fullReconcile', label: 'Walk every page', type: 'boolean', default: false, help: 'Ignores the page limit and goes through the whole listing.' },
    { key: 'minTokens', label: 'Minimum tokens', type: 'number', default: 300, min: 0, max: 10_000_000 },
    { key: 'maxTokens', label: 'Maximum tokens (0 = no limit)', type: 'number', default: 0, min: 0, max: 10_000_000 },
    { key: 'bannedTags', label: 'Leave out these tags', type: 'list', default: [] },
    { key: 'excludedWarnings', label: 'Leave out these content warnings', type: 'list', default: ['underage'] },
    { key: 'allowedWarnings', label: 'Content warnings to show', type: 'list', default: [], help: 'Sent as the content_warnings cookie.' },
  ],

  async *discover(context) {
    const settings = context.settings;
    const minTokens = settings.minTokens as number, maxTokens = settings.maxTokens as number;
    for (let page = 1; ; page++) {
      context.signal.throwIfAborted();
      const params = new URLSearchParams({ page: String(page), sort: settings.sort as string });
      if ((settings.query as string).trim()) params.set('query', (settings.query as string).trim());
      if (minTokens) params.set('minimum_tokens', String(minTokens));
      if (maxTokens) params.set('maximum_tokens', String(maxTokens));
      // The catalog page's own data (SvelteKit): { searchResults: { hits, totalPages } }.
      const nodes = await pageData(context, `${site}/search/cards/__data.json?${params}`);
      const results = record(nodes.map(record).find((node) => node.searchResults)?.searchResults);
      const hits = Array.isArray(results.hits) ? results.hits.map(record) : [];
      for (const hit of hits) {
        const id = text(hit.id);
        if (!id || /[\s/]/.test(id) || !normalizePath(hit.path).includes('/')) continue;
        const tokens = number(hit.permanentTokens) ?? tokensOf(hit);
        if (tokens !== undefined && (tokens < minTokens || (maxTokens && tokens > maxTokens))) continue;
        // Listings carry no update time, so every listed card is read again; unchanged files make no new version.
        yield { recordId: id, hint: hit } satisfies Listing;
      }
      const totalPages = number(results.totalPages);
      if (!hits.length || (totalPages !== undefined && page >= totalPages)) return;
      if (!settings.fullReconcile && page >= (settings.pages as number)) return;
    }
  },

  async fetch(context: ScrapeContext, listing: Listing): Promise<ScrapedCard | null> {
    const hit = record(listing.hint);
    const path = normalizePath(hit.path);
    const http = context.http, headers = cookie(context);
    // The card page's data: the card record, tags, warnings and likes, with greetings and lorebook streamed after.
    const page = record((await pageData(context, `${site}/character/${path}/__data.json`)).map(record).find((node) => node.character));
    const card = record(page.character);
    const cardId = text(card.id);
    if (!cardId) throw new Error(`Character Tavern returned no card for ${path}`);
    // CT marks adult cards with a flag, not a tag; the shared NSFW tag lets Settings blur or hide them.
    const tags = [...names(page.tags), ...(card.isNSFW === true && !names(page.tags).some((tag) => tag.toLowerCase() === 'nsfw') ? ['NSFW'] : [])];
    const alternate = (Array.isArray(page.alternativeGreetings) ? page.alternativeGreetings : [])
      .map((value) => typeof value === 'string' ? value : text(record(value).greeting) || text(record(value).content) || text(record(value).text))
      .filter((value) => !!value.trim());
    const warnings = names(page.contentWarnings);
    const lorebook = page.lorebook && typeof page.lorebook === 'object' ? record(page.lorebook) : null;

    const banned = new Set((context.settings.bannedTags as string[]).map((tag) => tag.toLowerCase()));
    if (tags.some((tag) => banned.has(tag.toLowerCase()))) return null;
    const excluded = new Set((context.settings.excludedWarnings as string[]).map((warning) => warning.toLowerCase()));
    if (warnings.some((warning) => excluded.has(warning.toLowerCase()))) return null;
    const tokens = tokensOf(card);
    const maxTokens = context.settings.maxTokens as number;
    if (tokens !== undefined && (tokens < (context.settings.minTokens as number) || (maxTokens && tokens > maxTokens))) return null;

    let image: Uint8Array | null = null;
    try { image = (await http.request(`${images}/${path}.png`, { headers: { ...headers, accept: 'image/png' } })).bytes; }
    catch (error) { if (!(error instanceof ScrapeHttpError) || ![403, 404].includes(error.status)) throw error; }
    if (image && pngSignature.some((value, index) => image![index] !== value)) image = null;

    const creator = path.split('/')[0] ?? '';
    const entries = Array.isArray(lorebook?.entries) ? lorebook.entries.map(record).map((entry) => ({
      name: text(entry.name), content: text(entry.content), enabled: entry.enabled !== false, insertion_order: number(entry.insertionOrder) ?? 0,
      constant: entry.constant === true, keys: Array.isArray(entry.keys) ? entry.keys.filter((key): key is string => typeof key === 'string') : [], extensions: {},
    })) : [];
    const data: Node = {
      name: text(card.inChatName) || text(card.name) || 'Untitled',
      description: text(card.definition_character_description) || text(card.description),
      personality: text(card.definition_personality), scenario: text(card.definition_scenario),
      first_mes: text(card.definition_first_message), mes_example: examples(card.definition_example_messages),
      creator_notes: text(card.description), system_prompt: text(card.definition_system_prompt),
      post_history_instructions: text(card.definition_post_history_prompt), alternate_greetings: alternate, tags, creator,
      character_version: card.versionId === undefined || card.versionId === null ? '' : String(card.versionId),
      extensions: { character_tavern: { id: cardId, versionId: card.versionId ?? null, contentWarnings: warnings, lorebookId: card.lorebookId ?? null } },
    };
    if (entries.length) {
      data.character_book = { name: text(lorebook!.name), description: text(lorebook!.description), ...(number(lorebook!.scanDepth) !== undefined ? { scan_depth: number(lorebook!.scanDepth) } : {}), extensions: {}, entries };
    }
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    const objects: ScrapedObject[] = [{ role: 'card', bytes: encode({ spec: 'chara_card_v2', spec_version: '2.0', data }), mediaType: 'application/json', name: 'card.json' }];
    if (image) objects.push({ role: 'portrait', bytes: image, mediaType: 'image/png', name: 'card.png' });
    objects.push({ role: 'raw', bytes: encode({ hit, page }), mediaType: 'application/json', name: 'record.json' });

    const createdAt = iso(card.createdAt) ?? iso(hit.createdAt);
    const updatedAt = updatedOf(card) ?? listing.updatedAt;
    const stats: SourceStats = {};
    for (const [key, value] of [['chats', card.analytics_chats], ['messages', card.analytics_messages], ['favorites', record(page.likesData).likeCount]] as const) {
      const parsed = number(value); if (parsed !== undefined) stats[key] = parsed;
    }
    return {
      provider: 'ct', recordId: listing.recordId, url: `${site}/character/${path}`,
      name: text(card.name) || text(card.inChatName), creator: text(page.authorUsername) || creator, tagline: text(card.tagline), tags,
      ...(createdAt ? { createdAt } : {}), ...(updatedAt ? { updatedAt } : {}), stats, objects,
    };
  },
};
