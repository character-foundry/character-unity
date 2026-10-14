import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useEditorSession } from './context';

const raster = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);
const activeConnection = Object.freeze({ status: 'active' as const });
const localSnapshot = () => activeConnection;
const noSubscription = () => () => {};
export const unavailableImage = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
export const inlineRaster = (source: string) => /^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,[A-Za-z0-9+/=\s]+$/i.test(source);

/** Authored URLs are identifiers, never fetch destinations. Only exact sealed or
 * staged asset bindings may be resolved, through this editor's owned transport. */
export function createAuthoredImageResolver(sources: Readonly<Record<string, string>>, resource: (path: string, signal: AbortSignal) => Promise<Blob>, signal: AbortSignal) {
  const lifetime = new AbortController();
  const pending = new Map<string, Promise<string | null>>(), owned = new Set<string>();
  const combined = AbortSignal.any([signal, lifetime.signal]);
  return {
    resolve(source: string): Promise<string | null> {
      combined.throwIfAborted();
      if (inlineRaster(source)) return Promise.resolve(source);
      const path = Object.hasOwn(sources, source) ? sources[source] : undefined;
      if (!path) return Promise.resolve(null);
      if (path.startsWith('blob:')) return Promise.resolve(path);
      if (!path.startsWith('/api/')) return Promise.resolve(null);
      let result = pending.get(path);
      if (!result) {
        result = resource(path, combined).then((blob) => {
          combined.throwIfAborted();
          if (!raster.has(blob.type.toLowerCase())) return null;
          const url = URL.createObjectURL(blob); owned.add(url); return url;
        });
        pending.set(path, result);
      }
      return result;
    },
    dispose() { lifetime.abort(); for (const url of owned) URL.revokeObjectURL(url); owned.clear(); },
  };
}

/** Sanitization is deliberately display-only. No CSS, resource attributes or
 * unresolved img src reaches the live DOM, and the original document is intact. */
function authoredTemplate(html: string) {
  const template = document.createElement('template');
  template.innerHTML = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'u', 'a', 'img', 'ul', 'ol', 'li', 'code', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div', 'span', 'hr', 'b', 'i', 's', 'sub', 'sup', 'details', 'summary'],
    // src is still inert here and is always replaced before insertion. Retain
    // embedded:/ccdefault: identifiers so exact stored bindings can resolve.
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'width', 'height'], ADD_URI_SAFE_ATTR: ['src'], ALLOW_DATA_ATTR: false,
  });
  return template;
}

export function authoredImageSources(text: string, html = false): string[] {
  const sources = new Set<string>();
  const readHtml = (value: string) => authoredTemplate(value).content.querySelectorAll('img').forEach((image) => {
    const source = image.getAttribute('src'); if (source) sources.add(source);
  });
  if (html) readHtml(text);
  else marked.walkTokens(marked.lexer(text), (token) => {
    if ((token.type === 'image' || token.type === 'imageSize') && 'href' in token && typeof token.href === 'string') sources.add(token.href);
    if (token.type === 'html') readHtml(token.text);
  });
  return [...sources].sort();
}

export function sanitizeAuthoredHtml(html: string, urls: Readonly<Record<string, string>>, errors: Readonly<Record<string, string>> = {}): string {
  const template = authoredTemplate(html);
  template.content.querySelectorAll('img').forEach((image) => {
    const source = image.getAttribute('src') ?? '';
    const url = inlineRaster(source) ? source : Object.hasOwn(urls, source) ? urls[source] : undefined;
    if (url && (url.startsWith('blob:') || inlineRaster(url))) { image.src = url; image.loading = 'lazy'; }
    else {
      const placeholder = document.createElement('span');
      placeholder.textContent = `[Image ${errors[source] ? 'unavailable' : 'not stored'}: ${image.alt || 'embedded image'}]`;
      image.replaceWith(placeholder);
    }
  });
  template.content.querySelectorAll('a').forEach((link) => {
    if (/^https?:\/\//i.test(link.getAttribute('href') ?? '')) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
  });
  return template.innerHTML;
}

export function useAuthoredImageUrls(text: string, html = false): { key: string; urls: Record<string, string>; errors: Record<string, string>; missing: string[] } {
  const session = useEditorSession();
  // Reconnection can replace an active snapshot with another active snapshot.
  // Observe its identity, not just status, so captured reads are renewed too.
  const connectionState = useSyncExternalStore(session.connection?.subscribe ?? noSubscription,
    session.connection?.snapshot ?? localSnapshot);
  const status = connectionState.status;
  const currentCard = session.cards.getState().currentCard;
  const selection = session.selection();
  const assetsVersion = useSyncExternalStore(session.assets.subscribe, session.assets.getSnapshot);
  const sourceKey = JSON.stringify(authoredImageSources(text, html));
  const key = `${selection}:${assetsVersion}:${sourceKey}`;
  const [state, setState] = useState<{ key: string; connectionState: typeof connectionState; urls: Record<string, string>; errors: Record<string, string> }>({ key: '', connectionState, urls: {}, errors: {} });
  useEffect(() => {
    if (!currentCard || status !== 'active') return;
    let active = true;
    const controller = new AbortController();
    let resolver: ReturnType<typeof createAuthoredImageResolver> | undefined;
    void (async () => {
      const sources = sourceKey === '[]' ? {} : await session.assets.imageSources(currentCard);
      if (!active || controller.signal.aborted) return;
      resolver = createAuthoredImageResolver(sources, (path, signal) => session.api.resource(path, signal), AbortSignal.any([session.liveSignal(), controller.signal]));
      const urls: Record<string, string> = Object.create(null), errors: Record<string, string> = Object.create(null);
      await Promise.all((JSON.parse(sourceKey) as string[]).map(async (source) => {
        try { const url = await resolver!.resolve(source); if (url) urls[source] = url; }
        catch (failure) { if (!controller.signal.aborted) errors[source] = failure instanceof Error ? failure.message : 'Stored image unavailable'; }
      }));
      if (active && !controller.signal.aborted) setState({ key, connectionState, urls, errors });
    })().catch((failure: unknown) => {
      if (active && !controller.signal.aborted) setState({ key, connectionState, urls: {}, errors: Object.fromEntries((JSON.parse(sourceKey) as string[]).map((source) => [source, failure instanceof Error ? failure.message : 'Stored images unavailable'])) });
    });
    return () => { active = false; controller.abort(); resolver?.dispose(); };
  }, [session, selection, assetsVersion, sourceKey, connectionState]);
  const loaded = status === 'active' && state.key === key && state.connectionState === connectionState;
  return loaded ? { ...state, missing: (JSON.parse(sourceKey) as string[]).filter((source) => !Object.hasOwn(state.urls, source)) }
    : { key, urls: {}, errors: {}, missing: [] };
}

export function AuthoredHtml({ html, className }: { html: string; className?: string }) {
  const { urls, errors } = useAuthoredImageUrls(html, true);
  const rendered = useMemo(() => sanitizeAuthoredHtml(html, urls, errors), [html, urls, errors]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: rendered }} />;
}
