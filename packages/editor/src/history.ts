import type { EditorDocument, EditorRevision, JsonValue } from './controller.js';

/** Optional host-owned read port. No storage, auth, or history mutation in the editor. */
export interface EditorHistoryPort {
  list(options: { afterSequence?: number; throughSequence?: number }, signal: AbortSignal): Promise<{
    revisions: { id: string; sequence: number; authorId: string; createdAt: string }[];
    headRevisionId: string; throughSequence: number; nextAfter: number | null;
  }>;
  read(revisionId: string, signal: AbortSignal): Promise<EditorRevision>;
}
export interface DocumentChange { path: string[]; before: JsonValue | undefined; after: JsonValue | undefined }

/** Structural display comparison, not identity calculation. Missing and null differ;
 * arrays compare by position, object key order is ignored, unknown fields remain visible. */
export function compareDocuments(before: EditorDocument, after: EditorDocument, limit = 200, offset = 0) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid comparison limit');
  const changes: DocumentChange[] = [];
  const pending: { before: JsonValue | undefined; after: JsonValue | undefined; path: string[] }[] = [{ before, after, path: [] }];
  let truncated = false;
  let skipped = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (item.before === item.after) continue;
    const left = item.before, right = item.after;
    if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object' && Array.isArray(left) === Array.isArray(right)) {
      if (Array.isArray(left) && Array.isArray(right)) {
        // Empty/nonempty containers still yield presence differences at their indices.
        for (let index = Math.max(left.length, right.length) - 1; index >= 0; index--) pending.push({ before: left[index], after: right[index], path: [...item.path, String(index)] });
      } else {
        const a = left as EditorDocument, b = right as EditorDocument;
        for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().reverse()) {
          pending.push({ before: Object.hasOwn(a, key) ? a[key] : undefined, after: Object.hasOwn(b, key) ? b[key] : undefined, path: [...item.path, key] });
        }
      }
    } else {
      if (skipped++ < offset) continue;
      if (changes.length === limit) { truncated = true; break; }
      changes.push(item);
    }
  }
  return { changes, truncated };
}
