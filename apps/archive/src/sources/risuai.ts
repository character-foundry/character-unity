import { ScrapeHttpError } from '@character-unity/scraper-kit';
import type { Listing, ScrapeContext, ScrapedCard, ScrapedObject, ScraperPlugin, SourceStats } from '@character-unity/scraper-kit';

const base = 'https://realm.risuai.net';
const images = 'https://sv.risuai.xyz/resource';
type Node = Record<string, unknown>;
const record = (value: unknown): Node => value && typeof value === 'object' && !Array.isArray(value) ? value as Node : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';

/**
 * Realm exposes no reliable change time (its `date` is often the download date), so a card the Archive
 * already holds is not fetched again unless "Refetch known cards" is on. Listings carry this fixed time and
 * cards are stored with their page date (or this same time), so the run loop counts known cards as unchanged.
 */
export const unchangedSentinel = '1970-01-01T00:00:00.000Z';

// ---- Safe literal reader ---------------------------------------------------------------------------

/**
 * Reads one JavaScript literal (the shape SvelteKit inlines as `data: [...]`) without executing anything.
 * Objects (quoted or bare keys), arrays, strings (single, double, backtick without `${}`), numbers,
 * true/false/null/undefined are read; anything else (identifiers, calls, `new Date(…)`, functions,
 * template expressions) becomes null and is skipped up to the next `,` `}` or `]` at its own depth.
 */
export function readLiteral(source: string, start = 0): { value: unknown; end: number } {
  let index = start;
  const fail = (message: string): never => { throw new Error(`${message} at ${index}`); };
  const space = () => {
    for (;;) {
      while (index < source.length && /\s/.test(source[index]!)) index++;
      if (source.startsWith('//', index)) { const end = source.indexOf('\n', index); index = end < 0 ? source.length : end + 1; continue; }
      if (source.startsWith('/*', index)) { const end = source.indexOf('*/', index + 2); index = end < 0 ? source.length : end + 2; continue; }
      return;
    }
  };
  const string = (): string | null => {
    const quote = source[index]!;
    let out = '', dynamic = false;
    index++;
    while (index < source.length && source[index] !== quote) {
      const char = source[index]!;
      if (char === '\\') {
        const next = source[index + 1] ?? '';
        const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
        if (next === 'u' && source[index + 2] === '{') {
          const end = source.indexOf('}', index);
          out += String.fromCodePoint(parseInt(source.slice(index + 3, end), 16) || 0xfffd); index = end + 1; continue;
        }
        if (next === 'u') { out += String.fromCharCode(parseInt(source.slice(index + 2, index + 6), 16) || 0xfffd); index += 6; continue; }
        if (next === 'x') { out += String.fromCharCode(parseInt(source.slice(index + 2, index + 4), 16) || 0xfffd); index += 4; continue; }
        if (next === '\n') { index += 2; continue; }
        out += simple[next] ?? next; index += 2; continue;
      }
      if (quote === '`' && char === '$' && source[index + 1] === '{') dynamic = true;
      out += char; index++;
    }
    if (index >= source.length) fail('Unterminated string');
    index++;
    return dynamic ? null : out;
  };
  /** Skips an expression we will not interpret, balancing brackets and strings. */
  const skip = () => {
    let depth = 0;
    while (index < source.length) {
      const char = source[index]!;
      if (char === '"' || char === "'" || char === '`') { string(); continue; }
      if ('([{'.includes(char)) depth++;
      else if (')]}'.includes(char)) { if (depth === 0) return; depth--; }
      else if (char === ',' && depth === 0) return;
      index++;
    }
  };
  const value = (): unknown => {
    space();
    const char = source[index];
    if (char === undefined) return fail('Unexpected end');
    if (char === '{') {
      index++;
      const object: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (;;) {
        space();
        if (source[index] === '}') { index++; return { ...object }; }
        let key: string | null;
        const head = source[index]!;
        if (head === '"' || head === "'" || head === '`') key = string();
        else {
          const match = /^[A-Za-z0-9_$.-]+/.exec(source.slice(index, index + 256));
          if (!match) { skip(); key = null; }
          else { key = match[0]; index += key.length; }
        }
        space();
        if (source[index] !== ':') {
          // Shorthand, spread or method: not data. Skip it, and stop on anything that is not an object any more.
          skip();
          if (source[index] === ',') { index++; continue; }
          if (source[index] === '}') continue;
          fail('Unexpected character in object');
        }
        index++;
        const item = value();
        // Never let scraped keys reach the prototype.
        if (key !== null && key !== '__proto__' && key !== 'constructor' && key !== 'prototype') object[key] = item;
        space();
        if (source[index] === ',') index++;
        else if (source[index] !== '}') fail('Expected , or }');
      }
    }
    if (char === '[') {
      index++;
      const array: unknown[] = [];
      for (;;) {
        space();
        if (source[index] === ']') { index++; return array; }
        if (source[index] === ',') { array.push(null); index++; continue; } // hole
        array.push(value());
        space();
        if (source[index] === ',') index++;
        else if (source[index] !== ']') fail('Expected , or ]');
      }
    }
    if (char === '"' || char === "'" || char === '`') return string();
    const number = /^-?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(source.slice(index, index + 64));
    if (number && !/[A-Za-z_$(]/.test(source[index + number[0].length] ?? '')) { index += number[0].length; return Number(number[0]); }
    for (const [word, result] of [['true', true], ['false', false], ['null', null], ['undefined', null], ['void 0', null]] as const) {
      if (source.startsWith(word, index) && !/[A-Za-z0-9_$(.]/.test(source[index + word.length] ?? '')) { index += word.length; return result; }
    }
    skip();
    return null;
  };
  const result = value();
  return { value: result, end: index };
}

/** The card record a Realm character page inlines (`data: [ … ]`, second entry), read without evaluating it. */
export function parseRealmPage(html: string): Node | null {
  for (let at = html.indexOf('data:'); at !== -1; at = html.indexOf('data:', at + 5)) {
    const open = html.indexOf('[', at);
    if (open === -1 || html.slice(at + 5, open).trim()) continue;
    let parsed: unknown;
    try { parsed = readLiteral(html, open).value; } catch { continue; }
    if (!Array.isArray(parsed) || !parsed[1]) continue;
    let card = record(parsed[1]);
    if (card.id === undefined && card.data) card = record(card.data);
    if (card.id === undefined && card.card) card = record(card.card);
    if (typeof card.id === 'string' || typeof card.id === 'number') return card;
  }
  return null;
}

/** "1.2k" → 1200, "3m" → 3000000. */
export function parseCount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const match = /^\s*([\d.]+)\s*([km]?)\s*$/i.exec(text(value));
  if (!match) return undefined;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return undefined;
  return Math.round(number * (match[2]!.toLowerCase() === 'k' ? 1_000 : match[2]!.toLowerCase() === 'm' ? 1_000_000 : 1));
}

/** Realm dates are roughly unix ms / 100000; only plausible years are trusted. */
export function parseRealmDate(value: unknown): string | undefined {
  const number = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(number)) return undefined;
  const date = new Date(number * 100_000);
  const year = date.getUTCFullYear();
  return year >= 2020 && year <= 2030 ? date.toISOString() : undefined;
}

export function imageType(bytes: Uint8Array): string | null {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  return null;
}

/** Each download format, the file name it is stored under, and a check that the answer really is that format. */
const formats = [
  { path: 'charx-v3', name: 'card.charx', mediaType: 'application/zip', valid: isCharx },
  { path: 'png-v3', name: 'card.png', mediaType: 'image/png', valid: (bytes: Uint8Array) => imageType(bytes) === 'image/png' },
  { path: 'json-v3', name: 'card.json', mediaType: 'application/json', valid: isJsonObject },
  { path: 'json-v2', name: 'card.json', mediaType: 'application/json', valid: isJsonObject },
] as const;
/** A CharX zip, or the JPEG-wrapped CharX Realm also serves (a JPEG preview with the zip appended). */
function isCharx(bytes: Uint8Array) {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return true;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  for (let index = 2; index < bytes.length - 3; index++) {
    if (bytes[index] === 0x50 && bytes[index + 1] === 0x4b && bytes[index + 2] === 3 && bytes[index + 3] === 4) return true;
  }
  return false;
}
function isJsonObject(bytes: Uint8Array) {
  try { const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown; return !!value && typeof value === 'object' && !Array.isArray(value); } catch { return false; }
}

/**
 * RisuAI Realm (realm.risuai.net). Listings are the site's browse pages; the card page's inlined data gives
 * name, author, tags, downloads and flags. The card itself is downloaded as CharX, else PNG, else JSON
 * (v3, then v2), kept exactly as served, with the thumbnail as its portrait.
 */
export const risuai: ScraperPlugin = {
  provider: 'risuai',
  label: 'RisuAI',
  minIntervalMs: 1_000,
  headers() {
    return { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' };
  },
  secrets: [],
  settings: [
    { key: 'sort', label: 'Order', type: 'choice', default: 'latest', choices: [{ value: 'latest', label: 'Newest' }, { value: 'recommended', label: 'Recommended' }, { value: 'download', label: 'Most downloaded' }] },
    { key: 'pages', label: 'Pages per run', type: 'number', default: 5, min: 1, max: 100 },
    { key: 'forceUpdate', label: 'Refetch known cards', type: 'boolean', default: false, help: 'Realm has no reliable update time; turn on to check cards the Archive already has.' },
  ],

  async *discover(context) {
    const pages = context.settings.pages as number;
    for (let page = 1; page <= pages; page++) {
      context.signal.throwIfAborted();
      const html = await context.http.text(`${base}/?${new URLSearchParams({ sort: context.settings.sort as string, page: String(page) })}`);
      const ids = new Set<string>();
      for (const match of html.matchAll(/href\s*=\s*["']\/character\/([A-Za-z0-9_-]{1,200})["'?#/]/g)) ids.add(match[1]!);
      if (!ids.size) return;
      for (const recordId of ids) yield { recordId, ...(context.settings.forceUpdate ? {} : { updatedAt: unchangedSentinel }) };
    }
  },

  async fetch(context: ScrapeContext, listing: Listing): Promise<ScrapedCard | null> {
    const id = listing.recordId, http = context.http;
    const node = parseRealmPage(await http.text(`${base}/character/${encodeURIComponent(id)}`));
    if (!node) throw new Error(`The RisuAI page for ${id} has no card data`);

    let card: ScrapedObject | null = null;
    const failures: string[] = [];
    for (const format of formats) {
      try {
        // CharX packages carry every asset and can be large; give them the old scraper's two minutes.
        const charx = format.path === 'charx-v3';
        const bytes = (await http.request(`${base}/api/v1/download/${format.path}/${encodeURIComponent(id)}?non_commercial=true`,
          { timeoutMs: charx ? 120_000 : 30_000, ...(charx ? { maxBytes: 256 * 1024 * 1024 } : {}) })).bytes;
        if (format.valid(bytes)) { card = { role: 'card', bytes, mediaType: format.mediaType, name: format.name }; break; }
        failures.push(`${format.path}: not a ${format.name.split('.')[1]} file`);
      } catch (error) {
        if (!(error instanceof ScrapeHttpError)) throw error;
        failures.push(`${format.path}: ${error.status >= 300 ? `HTTP ${error.status}` : error.status ? error.message : 'no answer'}`);
      }
    }
    if (!card) throw new Error(`RisuAI card ${id} could not be downloaded in any format (${failures.join('; ')})`);

    const objects: ScrapedObject[] = [card];
    const img = text(node.img);
    if (img && /^[A-Za-z0-9._-]{1,200}$/.test(img)) {
      try {
        const bytes = (await http.request(`${images}/${img}`)).bytes;
        const type = imageType(bytes);
        if (type) objects.push({ role: 'portrait', bytes, mediaType: type, name: `portrait.${type.split('/')[1]}` });
      } catch (error) { if (!(error instanceof ScrapeHttpError)) throw error; }
    }
    objects.push({ role: 'raw', bytes: new TextEncoder().encode(JSON.stringify(node)), mediaType: 'application/json', name: 'record.json' });

    const stats: SourceStats = {};
    const downloads = parseCount(node.download);
    if (downloads !== undefined) stats.downloads = downloads;
    const date = parseRealmDate(node.date);
    const tags = Array.isArray(node.tags) ? node.tags.filter((tag): tag is string => typeof tag === 'string') : [];
    return {
      provider: 'risuai', recordId: id, url: `${base}/character/${encodeURIComponent(id)}`,
      name: text(node.name), creator: text(node.authorname), tagline: text(node.desc).slice(0, 200), tags,
      ...(date ? { createdAt: date } : {}), updatedAt: date ?? unchangedSentinel,
      stats, flags: { ...(node.hasAsset === true ? { gallery: true } : {}), ...(node.hasEmotion === true ? { expressions: true } : {}) },
      objects,
    };
  },
};
