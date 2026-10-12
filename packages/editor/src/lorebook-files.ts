import { parseLorebook, serializeLorebook } from '@character-foundry/character-foundry/lorebook';
import type { EditorDocument, JsonValue } from './controller.js';
import { loreObject } from './lorebook.js';

export const lorebookFileLimit = 262_144;
export interface LorebookImportReview {
  name: string | null;
  entries: number;
  replacesExisting: boolean;
}

// Application resource limits, not a format converter. Foundry owns parsing.
function bounded(value: JsonValue) {
  const pending = [{ value, depth: 0 }]; let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > 20_000 || item.depth > 64) throw new Error('Lorebook exceeds the supported nesting or item limit.');
    if (typeof item.value === 'number' && (!Number.isFinite(item.value)
      || (Number.isInteger(item.value) && !Number.isSafeInteger(item.value)))) {
      throw new Error('Lorebook contains a number that cannot be preserved safely.');
    }
    if (item.value && typeof item.value === 'object') {
      for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
    }
  }
}

export function readLorebookFile(bytes: Uint8Array): EditorDocument {
  if (!bytes.length || bytes.byteLength > lorebookFileLimit) throw new Error('Choose a lorebook JSON file between 1 byte and 256 KiB.');
  let parsed: ReturnType<typeof parseLorebook>;
  try {
    // The SDK's decoder permits replacement characters; reject malformed UTF-8.
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = parseLorebook(bytes);
  } catch { throw new Error('Cannot read this lorebook. Choose valid UTF-8 character-book JSON.'); }
  const book = parsed.originalShape;
  const emptyNative = parsed.originalFormat === 'unknown' && loreObject(book)
    && Array.isArray(book.entries) && book.entries.length === 0
    && book.kind !== 'memory' && book.type !== 'risu' && book.format !== 'wyvern'
    && !Object.hasOwn(book, 'spec');
  if ((parsed.originalFormat !== 'ccv3' && !emptyNative) || !loreObject(book)
    || !Array.isArray(book.entries) || Object.hasOwn(book, 'spec')
    || !book.entries.every((entry) => loreObject(entry) && typeof entry.content === 'string'
      && Array.isArray(entry.keys) && entry.keys.every((key) => typeof key === 'string'))) {
    throw new Error('Import supports native character-book JSON with an entries array of keys and content. Other lorebook formats need conversion first.');
  }
  if (book.entries.length > 1000) throw new Error('Import supports at most 1,000 lorebook entries.');
  bounded(book);
  // Do not use parsed.book: normalization in the pinned SDK drops book settings,
  // entry extensions, opaque fields and some IDs. originalShape retains them.
  return structuredClone(book);
}

/** Serialize the current native shape through the SDK, without normalization. */
export function writeLorebookFile(book: JsonValue | undefined): string {
  if (!loreObject(book)) throw new Error('This draft has no lorebook object to download.');
  bounded(book);
  // The serializer's native branch returns the supplied object unchanged. Keep
  // opaque/legacy values even when they do not satisfy the SDK's narrower type.
  const json = serializeLorebook(book as unknown as Parameters<typeof serializeLorebook>[0], 'ccv3', undefined, false);
  if (new TextEncoder().encode(json).byteLength > lorebookFileLimit) throw new Error('Lorebook download exceeds 256 KiB.');
  return json;
}
