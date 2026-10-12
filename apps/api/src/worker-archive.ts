import { createArchiveClient } from '@character-unity/archive-client';

/** Operator configuration only. Construct inside the request; never inherit
 * incoming credentials, caller URLs or mutable state from another session. */
export function workerArchive(value: string | undefined, publicOrigin: string) {
  if (value === undefined || value === '') return undefined;
  const url = new URL(value), host = new URL(publicOrigin);
  const loopback = (url: URL) => ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (value !== url.origin || url.username || url.password || value.length > 2048
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url) && host.protocol === 'http:' && loopback(host)))) {
    throw new Error('Archive configuration requires an exact HTTPS origin, or loopback HTTP for a local HTTP Worker');
  }
  return createArchiveClient(url.origin);
}
