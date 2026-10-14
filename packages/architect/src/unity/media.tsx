import { useEffect, useState, useSyncExternalStore, type AnchorHTMLAttributes, type AudioHTMLAttributes, type ImgHTMLAttributes, type VideoHTMLAttributes } from 'react';
import { useEditorSession } from './context';
const noSubscription = () => () => {};
export function useEditorConnectionStatus(): 'active' | 'locked' | 'disposed' {
  const session = useEditorSession();
  return useSyncExternalStore(session.connection?.subscribe ?? noSubscription, () => session.connection?.snapshot().status ?? 'active');
}

/** Browser elements cannot attach the expected-account header. Resolve protected
 * media through the editor's captured connection and own the resulting blob URL. */
function useResourceUrl(source: string | undefined, enabled = true): { url?: string; error?: string } {
  const session = useEditorSession();
  const status = useEditorConnectionStatus();
  const [loaded, setLoaded] = useState<{ source: string; url?: string; error?: string } | null>(null);
  useEffect(() => {
    if (!enabled || !source?.startsWith('/api/') || status !== 'active') return;
    const controller = new AbortController();
    setLoaded(null);
    let url: string | undefined;
    void session.api.resource(source, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob); setLoaded({ source, url });
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setLoaded({ source, error: failure instanceof Error ? failure.message : 'Media is unavailable' });
    });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [session, source, status, enabled]);
  return !enabled ? {} : source?.startsWith('/api/') ? status !== 'active' ? {} : loaded?.source === source ? loaded : {} : { url: source };
}
export function EditorImage({ src, loading, ...props }: ImgHTMLAttributes<HTMLImageElement>) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [visible, setVisible] = useState(loading !== 'lazy');
  useEffect(() => {
    if (visible || !node) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '200px' });
    observer.observe(node); return () => observer.disconnect();
  }, [visible, node]);
  const resource = useResourceUrl(src, visible);
  if (!visible) return <span ref={setNode} className={props.className} style={{ ...props.style, display: 'inline-block' }} />;
  return resource.error ? <span role="img" aria-label={props.alt ?? 'Image unavailable'} title={resource.error} className={props.className}>Image unavailable</span>
    : <img {...props} src={resource.url} loading={loading} />;
}
export function EditorVideo({ src, ...props }: Omit<VideoHTMLAttributes<HTMLVideoElement>, 'children'>) {
  const [requested, setRequested] = useState<string>();
  const enabled = !src?.startsWith('/api/') || requested === src;
  const resource = useResourceUrl(src, enabled);
  if (!enabled) return <button type="button" className="btn-secondary" onClick={() => setRequested(src)}>Load video preview</button>;
  return resource.error ? <p role="alert">{resource.error}</p> : <video {...props} src={resource.url}>Video preview is unavailable.</video>;
}
export function EditorAudio({ src, ...props }: Omit<AudioHTMLAttributes<HTMLAudioElement>, 'children'>) {
  const [requested, setRequested] = useState<string>();
  const enabled = !src?.startsWith('/api/') || requested === src;
  const resource = useResourceUrl(src, enabled);
  if (!enabled) return <button type="button" className="btn-secondary" onClick={() => setRequested(src)}>Load audio preview</button>;
  return resource.error ? <p role="alert">{resource.error}</p> : <audio {...props} src={resource.url}>Audio preview is unavailable.</audio>;
}
export function EditorDownload({ href, download, children, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const session = useEditorSession();
  const [error, setError] = useState<string | null>(null);
  return <><a {...props} href={href?.startsWith('/api/') ? '#' : href} download={download} onClick={(event) => {
    onClick?.(event);
    if (!href?.startsWith('/api/') || event.defaultPrevented) return;
    event.preventDefault(); setError(null);
    void session.api.resource(href).then((blob) => {
      session.signal.throwIfAborted();
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = typeof download === 'string' ? download : 'asset'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }).catch((failure: unknown) => { if (!session.signal.aborted) setError(failure instanceof Error ? failure.message : 'Download failed'); });
  }}>{children}</a>{error && <span role="alert">{error}</span>}</>;
}
