import type { ChatConnection } from './index.js';

export type ChatAppErrorCode = 'UNREACHABLE' | 'UNAUTHORIZED' | 'REJECTED' | 'NOT_FOUND' | 'UNEXPECTED';
export class ChatAppError extends Error {
  constructor(public readonly code: ChatAppErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ChatAppError';
  }
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
/** Shared request helper: bounded time, no redirects, and app errors mapped to stable codes. */
export async function call(fetcher: Fetch, app: string, url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 30_000, ...rest } = init;
  let response: Response;
  try {
    response = await fetcher(url, { redirect: 'manual', ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new ChatAppError('UNREACHABLE', `${app} did not answer at ${new URL(url).origin}`, { cause: error });
  }
  if (response.status === 401 || response.status === 403) throw new ChatAppError('UNAUTHORIZED', `${app} refused the credentials (HTTP ${response.status})`);
  if (response.status === 404) throw new ChatAppError('NOT_FOUND', `${app} has no such character or route`);
  if (response.status >= 300 && response.status < 400) throw new ChatAppError('UNAUTHORIZED', `${app} redirected the request; check the URL and login`);
  if (!response.ok) throw new ChatAppError('REJECTED', `${app} answered HTTP ${response.status}`);
  return response;
}

export function basicAuth(credentials: ChatConnection['credentials']): Record<string, string> {
  if (!credentials.username || credentials.password === undefined) return {};
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(`${credentials.username}:${credentials.password}`)));
  return { authorization: `Basic ${encoded}` };
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const fingerprintFields = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator', 'creator_notes',
  'system_prompt', 'post_history_instructions', 'tags', 'alternate_greetings'] as const;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
/**
 * The authored text of a copy as the app stores it. Only fields every app round-trips are included, so
 * the app's own bookkeeping (ids, timestamps, its extension keys) never reads as an edit.
 */
export async function cardFingerprint(fields: Record<string, unknown>): Promise<string> {
  const picked = Object.fromEntries(fingerprintFields.map((key) => {
    const value = fields[key];
    return [key, Array.isArray(value) ? value.map((item) => (typeof item === 'string' ? item : '')) : typeof value === 'string' ? value : ''];
  }));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(picked)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function bearer(token: string | undefined): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}
