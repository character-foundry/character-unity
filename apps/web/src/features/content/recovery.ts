export interface ContentDraft { version: 1; key: string; expectedHead: string; title: string; text: string; id: string }
interface DraftStorage { getItem(key: string): string | null; setItem(key: string,value: string): void; removeItem(key: string): void }
export function readContentDraft(storage: DraftStorage,key: string): ContentDraft | null {
  const raw = storage.getItem(key); if (raw === null) return null;
  let value: Partial<ContentDraft>;
  try { value = JSON.parse(raw) as Partial<ContentDraft>; } catch { throw new Error('Recovery draft is unreadable; it has not been erased.'); }
  if (!value || value.version !== 1 || value.key !== key || typeof value.id !== 'string' || typeof value.expectedHead !== 'string'
    || typeof value.title !== 'string' || typeof value.text !== 'string' || new TextEncoder().encode(value.text).byteLength > 2_097_152) {
    throw new Error('Recovery draft is not recognized; it has not been erased.');
  }
  return value as ContentDraft;
}
export function writeContentDraft(storage: DraftStorage,value: ContentDraft) {
  if (new TextEncoder().encode(value.text).byteLength > 2_097_152) throw new Error('Recovery draft exceeds 2 MiB; download your text before leaving.');
  storage.setItem(value.key,JSON.stringify(value));
}
export function clearContentDraft(storage: DraftStorage,key: string,id: string) {
  if (readContentDraft(storage,key)?.id === id) storage.removeItem(key);
}
