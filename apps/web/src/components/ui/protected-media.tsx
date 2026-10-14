import { useEffect, useState, useSyncExternalStore, type ImgHTMLAttributes, type AudioHTMLAttributes, type VideoHTMLAttributes, type ReactNode } from 'react';
import { useLibraryClient } from '@/lib/library-client';
import { acquireProtectedResource, publicResource } from '@/lib/protected-resource';

/** Per-visible-owner resource lifetime; no cookie-only API src/href requests. */
export function useProtectedSources(sources: readonly string[]): { urls: Record<string, string>; errors: Record<string, string> } {
  const client = useLibraryClient();
  const status = useSyncExternalStore(client.connection.subscribe, () => client.connection.snapshot().status);
  const key = JSON.stringify([...new Set(sources)].sort());
  const [state, setState] = useState<{ key: string; owner: string; urls: Record<string, string>; errors: Record<string, string> }>({ key: '', owner: '', urls: {}, errors: {} });
  useEffect(() => {
    let active = true;
    const held: ReturnType<typeof acquireProtectedResource>[] = [];
    const urls: Record<string, string> = {}, errors: Record<string, string> = {};
    const update = () => { if (active) setState({ key, owner: client.scopeKey, urls: { ...urls }, errors: { ...errors } }); };
    for (const source of JSON.parse(key) as string[]) {
      if (publicResource(source)) { urls[source] = source; continue; }
      if (!source.startsWith('/api/')) { errors[source] = 'Only stored media can be displayed'; continue; }
      if (status !== 'active') { errors[source] = 'Reconnect to load stored media'; continue; }
      const resource = acquireProtectedResource(client, source); held.push(resource);
      void resource.promise.then((url) => { urls[source] = url; update(); }, (failure: unknown) => {
        errors[source] = failure instanceof Error ? failure.message : 'Stored media is unavailable'; update();
      });
    }
    update();
    return () => { active = false; held.forEach((resource) => resource.release()); };
  }, [client, key, status]);
  return state.key === key && state.owner === client.scopeKey ? state : { urls: {}, errors: {} };
}
function useProtectedUrl(source: string | undefined, enabled = true) {
  const { urls, errors } = useProtectedSources(source && enabled ? [source] : []);
  return { url: source ? urls[source] : undefined, error: source ? errors[source] : undefined };
}
export function ProtectedImage({ src, alt, loading, ...props }: ImgHTMLAttributes<HTMLImageElement>) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [visible, setVisible] = useState(loading !== 'lazy');
  useEffect(() => {
    if (visible || !node) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '200px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, visible]);
  const { url, error } = useProtectedUrl(src, visible);
  return url ? <img {...props} ref={setNode} src={url} loading={loading} alt={alt} /> : <span ref={setNode} className={props.className} role={error && alt ? 'status' : undefined} aria-label={alt || undefined}>
    {error && alt ? <span className="block p-2 text-xs text-text-muted">Image unavailable: {error}</span> : null}
  </span>;
}
export function ProtectedAudio({ src, ...props }: AudioHTMLAttributes<HTMLAudioElement>) {
  const [requested, setRequested] = useState(false);
  const { url, error } = useProtectedUrl(src, requested);
  if (!requested) return <button type="button" onClick={() => setRequested(true)} className="btn-secondary rounded-lg px-3 py-2 text-sm">Load audio preview</button>;
  return error ? <p role="status">Audio unavailable: {error}</p> : url ? <audio {...props} src={url} /> : <span role="status">Loading audio…</span>;
}
export function ProtectedVideo({ src, ...props }: VideoHTMLAttributes<HTMLVideoElement>) {
  const [requested, setRequested] = useState(false);
  const { url, error } = useProtectedUrl(src, requested);
  if (!requested) return <button type="button" onClick={() => setRequested(true)} className="btn-secondary rounded-lg px-3 py-2 text-sm">Load video preview</button>;
  return error ? <p role="status">Video unavailable: {error}</p> : url ? <video {...props} src={url} /> : <span role="status">Loading video…</span>;
}
export function ProtectedDownload({ src, filename, children, className }: { src: string; filename: string; children: ReactNode; className?: string }) {
  const client = useLibraryClient();
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  return <><button type="button" disabled={busy} className={className} onClick={() => {
    setBusy(true); setError(null);
    void client.downloadFile(src, filename).catch((failure: unknown) => {
      if (!client.connection.signal.aborted) setError(failure instanceof Error ? failure.message : 'Download failed');
    }).finally(() => { if (!client.connection.signal.aborted) setBusy(false); });
  }}>{busy ? 'Downloading…' : children}</button>{error && <span role="alert" className="block text-xs text-red-300">{error}</span>}</>;
}
