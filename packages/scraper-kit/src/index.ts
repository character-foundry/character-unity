import { createHttp } from './http.js';
import type { Fetch, Http } from './http.js';

export { createHttp, ScrapeHttpError, sleep } from './http.js';
export type { Fetch, Http, HttpOptions, HttpResponse, RequestOptions } from './http.js';
export { pngSize, isPlaceholderImage } from './image.js';

/** A file the plugin fetched, kept byte for byte. Exactly one `card` object per card. */
export interface ScrapedObject {
  /** card: the container to import (JSON, PNG or CharX); portrait: the image; raw: the source's own record; asset: anything else. */
  role: 'card' | 'portrait' | 'raw' | 'asset';
  bytes: Uint8Array;
  mediaType: string;
  /** Distinguishes several objects of one role, e.g. `lorebook/123.json`. */
  name?: string;
}

/** Popularity as the source reports it; kept per card for sorting. */
export interface SourceStats { stars?: number; favorites?: number; chats?: number; messages?: number; downloads?: number; rating?: number }

/** One entry of a source's listing, before the card itself is fetched. */
export interface Listing {
  recordId: string;
  /** The source's last-change time (ISO). Listings at or before the Archive's copy are not fetched again. */
  updatedAt?: string;
  stats?: SourceStats;
  /** Plugin-private data passed back to `fetch` (e.g. the listing record). */
  hint?: unknown;
}

export interface ScrapedCard {
  provider: string;
  recordId: string;
  /** The card's page on the source. */
  url: string;
  name?: string;
  creator?: string;
  tagline?: string;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
  stats?: SourceStats;
  flags?: { gallery?: boolean; expressions?: boolean };
  objects: ScrapedObject[];
}

export type SettingValue = string | number | boolean | string[];
export interface SettingSpec {
  key: string;
  label: string;
  type: 'number' | 'boolean' | 'text' | 'list' | 'choice';
  default: SettingValue;
  help?: string;
  choices?: { value: string; label: string }[];
  min?: number;
  max?: number;
}
export interface SecretSpec { key: string; label: string; help?: string }

export interface ScrapeContext {
  http: Http;
  settings: Record<string, SettingValue>;
  secrets: Record<string, string>;
  signal: AbortSignal;
  log(event: Record<string, unknown>): void;
}

export interface ScraperPlugin {
  provider: string;
  label: string;
  /** Minimum spacing between this source's requests. */
  minIntervalMs: number;
  headers?(secrets: Record<string, string>): Record<string, string>;
  settings: SettingSpec[];
  secrets: SecretSpec[];
  /** Walks the source's listings (honouring settings such as pages, tags and filters). */
  discover(context: ScrapeContext): AsyncIterable<Listing>;
  /** Fetches one card, or null to skip it (filtered out after a closer look). */
  fetch(context: ScrapeContext, listing: Listing): Promise<ScrapedCard | null>;
}

/** What the Archive tells the run loop, and how it keeps what was fetched. */
export interface ScrapeSink {
  blocked(provider: string, recordId: string): boolean | Promise<boolean>;
  /** The source update time of the Archive's current copy, or null when the card is new. */
  known(provider: string, recordId: string): { updatedAt: string | null } | null | Promise<{ updatedAt: string | null } | null>;
  /** Refreshes popularity and last-seen time for a card whose content did not change. */
  seen(provider: string, recordId: string, stats: SourceStats | undefined): void | Promise<void>;
  put(card: ScrapedCard): Promise<'added' | 'updated' | 'unchanged'>;
}

export interface RunCounts { listed: number; added: number; updated: number; unchanged: number; skipped: number; blocked: number; errors: number }
export interface RunResult extends RunCounts { status: 'done' | 'cancelled' | 'failed'; error?: string }

/** Settings with defaults filled in and values checked against their specs. */
export function resolveSettings(plugin: Pick<ScraperPlugin, 'settings'>, values: Record<string, unknown> = {}): Record<string, SettingValue> {
  const result: Record<string, SettingValue> = {};
  for (const spec of plugin.settings) {
    const value = values[spec.key];
    let resolved: SettingValue = spec.default;
    if (spec.type === 'number' && typeof value === 'number' && Number.isFinite(value)) resolved = Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, Math.round(value)));
    else if (spec.type === 'boolean' && typeof value === 'boolean') resolved = value;
    else if (spec.type === 'text' && typeof value === 'string') resolved = value.trim().slice(0, 500);
    else if (spec.type === 'choice' && typeof value === 'string' && spec.choices?.some((choice) => choice.value === value)) resolved = value;
    else if (spec.type === 'list' && Array.isArray(value)) resolved = [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))].slice(0, 500);
    result[spec.key] = resolved;
  }
  return result;
}

const newer = (remote: string | undefined, local: string | null) => {
  if (!remote || !local) return true;
  const a = Date.parse(remote), b = Date.parse(local);
  return !Number.isFinite(a) || !Number.isFinite(b) || Math.floor(a / 1000) > Math.floor(b / 1000);
};

/**
 * Walks one source into the Archive. Listings the Archive holds at the same update time only refresh their
 * stats; blocked records are never fetched; a failing card is counted and the run goes on, until
 * `maxConsecutiveErrors` failures in a row suggest the source itself is down (or the credentials stopped working).
 */
export async function runScrape(plugin: ScraperPlugin, sink: ScrapeSink, options: {
  settings?: Record<string, unknown>; secrets?: Record<string, string>; signal?: AbortSignal; fetch?: Fetch;
  log?: (event: Record<string, unknown>) => void; onProgress?: (counts: RunCounts) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; maxConsecutiveErrors?: number;
}): Promise<RunResult> {
  const signal = options.signal ?? new AbortController().signal;
  const secrets = { ...options.secrets };
  const log = options.log ?? (() => undefined);
  const http = createHttp({ minIntervalMs: plugin.minIntervalMs, signal, headers: plugin.headers?.(secrets) ?? {},
    ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.sleep ? { sleep: options.sleep } : {}) });
  const context: ScrapeContext = { http, settings: resolveSettings(plugin, options.settings), secrets, signal, log };
  const counts: RunCounts = { listed: 0, added: 0, updated: 0, unchanged: 0, skipped: 0, blocked: 0, errors: 0 };
  const maxErrors = options.maxConsecutiveErrors ?? 10;
  let consecutive = 0, lastError: string | undefined;
  const seen = new Set<string>();
  try {
    for await (const listing of plugin.discover(context)) {
      if (signal.aborted) break;
      if (seen.has(listing.recordId)) continue;
      seen.add(listing.recordId);
      counts.listed++;
      try {
        if (await sink.blocked(plugin.provider, listing.recordId)) { counts.blocked++; continue; }
        const known = await sink.known(plugin.provider, listing.recordId);
        if (known && !newer(listing.updatedAt, known.updatedAt)) {
          await sink.seen(plugin.provider, listing.recordId, listing.stats);
          counts.unchanged++;
        } else {
          const card = await plugin.fetch(context, listing);
          if (!card) counts.skipped++;
          else {
            if (card.provider !== plugin.provider || card.recordId !== listing.recordId) throw new Error('The plugin returned a different card than it was asked for');
            counts[await sink.put(card)]++;
          }
        }
        consecutive = 0;
      } catch (error) {
        if (signal.aborted) break;
        counts.errors++; consecutive++;
        lastError = error instanceof Error ? error.message : String(error);
        log({ event: 'scrape-card-failed', provider: plugin.provider, recordId: listing.recordId, message: lastError });
        if (consecutive >= maxErrors) return { ...counts, status: 'failed', error: `Stopped after ${consecutive} failures in a row; last: ${lastError}` };
      }
      options.onProgress?.({ ...counts });
    }
  } catch (error) {
    if (!signal.aborted) return { ...counts, status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
  if (signal.aborted) return { ...counts, status: 'cancelled' };
  return { ...counts, status: 'done', ...(lastError ? { error: `Last card error: ${lastError}` } : {}) };
}
