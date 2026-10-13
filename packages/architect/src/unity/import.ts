import { api } from '../lib/api';
import type { Card } from '../lib/types';

export interface ImportOptions {
  signal?: AbortSignal;
}

/** Submit the original container. Foundry parses and preserves it on the server. */
export async function importCharacterFile(file: File, options: ImportOptions = {}): Promise<Card> {
  options.signal?.throwIfAborted();
  const result = await api.importFile(file, options);
  options.signal?.throwIfAborted();
  if (result.error) throw new Error(result.error);
  if (!result.data?.meta.id) throw new Error('The imported card could not be opened');
  return result.data;
}

/** Direct file URLs use the same loss-preserving path as uploads. Site pages belong to Archive. */
export async function importCharacterUrl(url: string, options: ImportOptions = {}): Promise<Card> {
  const source = new URL(url);
  if (!['https:', 'http:'].includes(source.protocol) || source.username || source.password) {
    throw new Error('Use an HTTP or HTTPS card file URL');
  }
  options.signal?.throwIfAborted();
  const response = await fetch(source, { credentials: 'omit', redirect: 'follow', ...options });
  if (!response.ok) throw new Error(`Card download failed (${response.status})`);
  const blob = await response.blob();
  options.signal?.throwIfAborted();
  const filename = decodeURIComponent(source.pathname.split('/').pop() || 'character');
  return importCharacterFile(new File([blob], filename, { type: blob.type }), options);
}
