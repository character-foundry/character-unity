import { fieldValue } from './controller.js';
import type { EditorDocument } from './controller.js';
import { fieldDefinitions } from './fields.js';

export interface EditorTokenPort {
  readonly label: string;
  readonly local?: boolean;
  count(texts: readonly string[], signal: AbortSignal): Promise<readonly number[]>;
}
export const tokenLimits = { texts: 2000, characters: 1_000_000 } as const;
export function validateTokenTexts(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length > tokenLimits.texts || value.some((text) => typeof text !== 'string')
    || value.reduce((sum, text: string) => sum + text.length, 0) > tokenLimits.characters) {
    throw new Error('Card text is too large or has an unsupported shape for token counting.');
  }
}
const record = (value: unknown): value is EditorDocument => !!value && typeof value === 'object' && !Array.isArray(value);

/** UI coverage, not a chat prompt builder. Never coerces opaque imported values. */
export function tokenProjection(document: EditorDocument) {
  const texts: string[] = [], fields: { label: string; indices: number[] }[] = [], omitted: string[] = [];
  let disabledLoreEntries = 0;
  function add(label: string, values: unknown[]) {
    const indices: number[] = [];
    for (const value of values) {
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string') { omitted.push(label); continue; }
      indices.push(texts.length); texts.push(value);
      if (texts.length > tokenLimits.texts) throw new Error('Too many text fields for token counting.');
    }
    fields.push({ label, indices });
  }
  for (const field of fieldDefinitions) {
    if ((!field.showTokens && field.id !== 'group_only_greetings') || !field.specs.includes(document.spec === 'chara_card_v3' ? 'v3' : 'v2')) continue;
    const value = fieldValue(document, field);
    if (field.type === 'array') {
      if (value !== undefined && value !== null && !Array.isArray(value)) omitted.push(field.label);
      else add(field.label, Array.isArray(value) ? value : []);
    } else add(field.label, [value]);
  }
  const book = record(document.data) ? document.data.character_book : undefined;
  if (book !== undefined && book !== null) {
    if (!record(book) || (book.entries !== undefined && !Array.isArray(book.entries))) omitted.push('Lorebook');
    else if (Array.isArray(book.entries)) {
      if (book.entries.length > tokenLimits.texts) throw new Error('Too many lorebook entries for token counting.');
      const contents: unknown[] = [];
      for (const entry of book.entries) {
        if (!record(entry)) { omitted.push('Lorebook'); continue; }
        if (entry.enabled === false) { disabledLoreEntries++; continue; }
        if (entry.enabled !== undefined && entry.enabled !== true) { omitted.push('Lorebook'); continue; }
        contents.push(entry.content);
      }
      add('Enabled lorebook entries', contents);
    }
  }
  validateTokenTexts(texts);
  return { texts, fields, omitted: [...new Set(omitted)], disabledLoreEntries };
}

export interface TokenAnalysisState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  document: EditorDocument | null;
  fields: { label: string; count: number }[];
  total: number;
  omitted: string[];
  disabledLoreEntries: number;
  error: string | null;
}
/** A separate read-only lifecycle for each mounted editor. Late results are ignored
 * even when an injected provider does not cooperate with cancellation. */
export function createTokenAnalysis(port: EditorTokenPort) {
  let state: TokenAnalysisState = { status: 'idle', document: null, fields: [], total: 0, omitted: [], disabledLoreEntries: 0, error: null };
  let active: AbortController | undefined;
  const listeners = new Set<() => void>();
  function publish(next: TokenAnalysisState) { state = next; for (const listener of listeners) listener(); }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    cancel() { active?.abort(); },
    async update(document: EditorDocument) {
      active?.abort(); const request = new AbortController(); active = request;
      publish({ status: 'loading', document, fields: [], total: 0, omitted: [], disabledLoreEntries: 0, error: null });
      try {
        const projection = tokenProjection(document);
        const counts = await port.count(projection.texts, request.signal);
        if (request.signal.aborted) return;
        if (counts.length !== projection.texts.length || counts.some((count) => !Number.isSafeInteger(count) || count < 0)) throw new Error('The tokenizer returned invalid counts.');
        const fields = projection.fields.map((field) => ({ label: field.label, count: field.indices.reduce((sum, index) => sum + counts[index]!, 0) }));
        const total = fields.reduce((sum, field) => sum + field.count, 0);
        if (!Number.isSafeInteger(total)) throw new Error('The tokenizer returned invalid counts.');
        publish({ status: 'ready', document, fields, total, omitted: projection.omitted, disabledLoreEntries: projection.disabledLoreEntries, error: null });
      } catch (error) {
        if (!request.signal.aborted) publish({ ...state, status: 'error', error: error instanceof Error ? error.message : 'Token counting failed. Try again.' });
      }
    },
  };
}
