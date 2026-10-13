import { ScrapeHttpError } from '@character-unity/scraper-kit';
import type { Listing, ScrapeContext, ScrapedCard, ScrapedObject, ScraperPlugin, SourceStats } from '@character-unity/scraper-kit';

const api = 'https://api.wyvern.chat';
const app = 'https://app.wyvern.chat';
type Node = Record<string, unknown>;
const record = (value: unknown): Node => value && typeof value === 'object' && !Array.isArray(value) ? value as Node : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const idOf = (node: Node) => text(node.id) || text(node._id) || (number(node.id) !== undefined ? String(node.id) : '');
const updatedOf = (node: Node) => text(node.updated_at) || text(node.created_at) || undefined;
/** Wyvern keeps counts in `statistics_record` (or `entity_statistics`): likes, follows, views, messages. */
const statsOf = (node: Node): SourceStats => {
  const counts = record(node.statistics_record ?? node.entity_statistics);
  const stats: SourceStats = {};
  const pairs = [['stars', counts.likes], ['favorites', counts.follows], ['chats', counts.views], ['messages', counts.messages]] as const;
  for (const [key, value] of pairs) { const parsed = number(value); if (parsed !== undefined) stats[key] = parsed; }
  return stats;
};

/** The character as a CCv2 card, mapped the way the old Archive did (pre-history instructions are the system prompt). */
function cardOf(character: Node) {
  const entries = (Array.isArray(character.lorebooks) ? character.lorebooks : [])
    .flatMap((lorebook) => Array.isArray(record(lorebook).entries) ? record(lorebook).entries as unknown[] : []);
  return {
    spec: 'chara_card_v2', spec_version: '2.0',
    data: {
      name: text(character.name) || 'Unknown', description: text(character.description), personality: text(character.personality),
      scenario: text(character.scenario), first_mes: text(character.first_mes), mes_example: text(character.mes_example),
      alternate_greetings: list(character.alternate_greetings), tags: list(character.tags), creator_notes: text(character.creator_notes),
      system_prompt: text(character.pre_history_instructions), post_history_instructions: text(character.post_history_instructions),
      extensions: {
        visual_description: text(character.visual_description),
        wyvern: { id: character.id, rating: character.rating, sprite_set: character.sprite_set, commands: character.commands, scripts: character.scripts },
      },
      ...(entries.length ? { character_book: { entries } } : {}),
    },
  };
}

/** `data:image/webp;base64,...` → bytes and media type, or null when it is not a base64 image data URL. */
function decodeDataUrl(value: unknown): { bytes: Uint8Array; mediaType: string } | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(text(value));
  if (!match) return null;
  const bytes = new Uint8Array(Buffer.from(match[2]!, 'base64'));
  return bytes.byteLength ? { bytes, mediaType: match[1]!.toLowerCase() } : null;
}
const extension = (mediaType: string) => ({ 'image/jpeg': 'jpg', 'image/svg+xml': 'svg' } as Record<string, string>)[mediaType] ?? mediaType.split('/')[1]!;

/**
 * Wyvern (wyvern.chat). Listings come from the explore search (with the account's bearer token when set);
 * each card is the API's character record, from which the card JSON is built. The portrait comes through the
 * app's image proxy as a data URL and is kept in the format it was served in.
 */
export const wyvern: ScraperPlugin = {
  provider: 'wyvern',
  label: 'Wyvern',
  minIntervalMs: 1_000,
  headers() {
    return { origin: app, referer: `${app}/`,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36' };
  },
  secrets: [{ key: 'bearerToken', label: 'Bearer token', help: 'Sent with listing requests only, so the explore search shows what your account can see.' }],
  settings: [
    { key: 'pages', label: 'Pages per run', type: 'number', default: 10, min: 1, max: 200 },
    { key: 'perPage', label: 'Cards per page', type: 'number', default: 50, min: 1, max: 100 },
    { key: 'sort', label: 'Sort field', type: 'text', default: 'dateCreated', help: 'Wyvern explore sort, e.g. dateCreated.' },
    { key: 'order', label: 'Order', type: 'choice', default: 'DESC', choices: [{ value: 'DESC', label: 'Descending' }, { value: 'ASC', label: 'Ascending' }] },
    { key: 'rating', label: 'Rating', type: 'choice', default: 'explicit', choices: [{ value: 'explicit', label: 'Explicit (everything)' }, { value: 'suggestive', label: 'Suggestive' }, { value: 'none', label: 'Safe only' }] },
  ],

  async *discover(context) {
    const settings = context.settings;
    const token = context.secrets.bearerToken?.trim();
    const perPage = settings.perPage as number;
    for (let page = 1; page <= (settings.pages as number); page++) {
      context.signal.throwIfAborted();
      const params = new URLSearchParams({ page: String(page), limit: String(perPage), sort: (settings.sort as string) || 'dateCreated',
        order: settings.order as string, rating: settings.rating as string });
      const body = record(await context.http.json(`${api}/exploreSearch/characters?${params}`, token ? { headers: { authorization: `Bearer ${token}` } } : {}));
      const results = Array.isArray(body.results) ? body.results.map(record) : [];
      if (!results.length) return;
      for (const item of results) {
        const id = idOf(item);
        if (!id || /[\s/]/.test(id)) continue;
        const updatedAt = updatedOf(item);
        yield { recordId: id, stats: statsOf(item), ...(updatedAt ? { updatedAt } : {}) };
      }
    }
  },

  async fetch(context: ScrapeContext, listing: Listing): Promise<ScrapedCard | null> {
    const id = listing.recordId;
    const response = await context.http.request(`${api}/characters/${encodeURIComponent(id)}`);
    let character: Node;
    try { character = record(JSON.parse(new TextDecoder().decode(response.bytes))); }
    catch (error) { throw new Error(`Wyvern character ${id} is not JSON`, { cause: error }); }
    if (!idOf(character)) throw new Error(`Wyvern character ${id} has no id`);

    const objects: ScrapedObject[] = [
      { role: 'card', bytes: new TextEncoder().encode(JSON.stringify(cardOf(character))), mediaType: 'application/json', name: 'card.json' },
    ];
    const avatar = text(character.avatar);
    if (avatar) {
      // A missing or unreadable portrait leaves the card without one, as the old scraper did.
      try {
        const portrait = decodeDataUrl(record(await context.http.json(`${app}/api/image-proxy?url=${encodeURIComponent(avatar)}`)).image);
        if (portrait) objects.push({ role: 'portrait', ...portrait, name: `avatar.${extension(portrait.mediaType)}` });
        else context.log({ event: 'scrape-portrait-unreadable', provider: 'wyvern', recordId: id });
      } catch (error) { if (!(error instanceof ScrapeHttpError)) throw error; }
    }
    objects.push({ role: 'raw', bytes: response.bytes, mediaType: 'application/json', name: 'character.json' });

    const creator = record(character.creator);
    const createdAt = text(character.created_at), updatedAt = updatedOf(character) ?? listing.updatedAt;
    return {
      provider: 'wyvern', recordId: id, url: `${app}/characters/${encodeURIComponent(id)}`,
      // Wyvern rates cards instead of tagging them; explicit ones get the shared NSFW tag so Settings can blur or hide them.
      name: text(character.name), creator: text(creator.displayName) || text(creator.uid),
      tags: [...list(character.tags), ...(character.rating === 'explicit' && !list(character.tags).some((tag) => tag.toLowerCase() === 'nsfw') ? ['NSFW'] : [])],
      ...(createdAt ? { createdAt } : {}), ...(updatedAt ? { updatedAt } : {}),
      stats: { ...listing.stats, ...statsOf(character) },
      flags: { gallery: Array.isArray(character.gallery) && character.gallery.length > 0,
        expressions: !!character.sprite_set || (Array.isArray(character.sprite_sets) && character.sprite_sets.length > 0) },
      objects,
    };
  },
};
