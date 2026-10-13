import { prepareArchiveImport } from '@character-unity/cards/import';
import { parseCard } from '@character-foundry/character-foundry/loader';
import type { ArchiveObjectRef } from './native/store.js';

/** The library and Archive share one loss-preserving identity/binding policy. */
export async function archiveContentHash(bytes: Uint8Array, document: unknown, refs: readonly ArchiveObjectRef[], read: (hash: string) => Promise<{ bytes: Uint8Array; mediaType: string }>) {
  const container = refs.find((ref) => ref.role === 'card');
  const source = (document ?? parseCard(bytes, { maxFileSize: 512 * 1024 * 1024, maxTotalSize: 512 * 1024 * 1024, extractAssets: false }).originalShape) as { data?: { name?: unknown } } | null;
  const name = source?.data?.name === undefined ? '' : typeof source.data.name === 'string' ? source.data.name : null;
  try { return { hash: (await prepareArchiveImport(refs, async (object) => object === container ? bytes : (await read(object.sha256)).bytes)).identity.hash, reason: null, name }; }
  catch (error) {
    if (error instanceof Error && (error.name === 'CardError' || error.name === 'IdentityError')) return { hash: null, reason: error.message.slice(0, 500), name };
    throw error;
  }
}
