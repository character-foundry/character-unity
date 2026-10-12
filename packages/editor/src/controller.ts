import { editAssets, initialAssetPlan } from './assets.js';
import type { AssetEdit, EditorAssetPlan, EditorAssetPort, EditorAssetSnapshot } from './assets.js';
import { fieldDefinitions } from './fields.js';
import type { FieldDefinition } from './fields.js';
import { characterBook, editLorebook } from './lorebook.js';
import type { LorebookEdit } from './lorebook.js';
import { lorebookFileLimit, readLorebookFile, writeLorebookFile } from './lorebook-files.js';
import type { LorebookImportReview } from './lorebook-files.js';
import type { EditorHistoryPort } from './history.js';
import type { EditorTokenPort } from './tokens.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type EditorDocument = { [key: string]: JsonValue };
export interface EditorRevision { revisionId: string; document: EditorDocument }
export interface EditorPorts {
  save(input: EditorRevision): Promise<EditorRevision>;
  history?: EditorHistoryPort;
  assets?: EditorAssetPort;
  tokens?: EditorTokenPort;
}
export interface EditorState extends EditorRevision {
  assetPlan: EditorAssetPlan | null;
  dirty: boolean;
  status: 'idle' | 'saving' | 'saved' | 'error';
  error: string | null;
}

function object(value: unknown): value is EditorDocument {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function own(revision: EditorRevision): EditorRevision {
  const copy = structuredClone(revision);
  if (!object(copy.document.data) || !['chara_card_v2', 'chara_card_v3'].includes(String(copy.document.spec))) {
    throw new Error('The editor requires a wrapped CCv2 or CCv3 document');
  }
  return freeze(copy);
}
export function fieldValue(document: EditorDocument, field: FieldDefinition): JsonValue | undefined {
  let current: JsonValue | undefined = document.data;
  for (const part of field.path.split('.')) {
    if (!object(current) || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}
export function fieldAccepts(field: FieldDefinition, value: unknown): boolean {
  if (field.type === 'readonly') return false;
  if (field.type === 'number') return typeof value === 'number' && Number.isFinite(value)
    && (field.min === undefined || value >= field.min) && (field.max === undefined || value <= field.max);
  if (field.type === 'array' || field.type === 'tags') return Array.isArray(value) && value.every((item) => typeof item === 'string');
  if (field.type === 'map') return object(value) && Object.values(value).every((item) => typeof item === 'string');
  return typeof value === 'string' && (field.maxLength === undefined || value.length <= field.maxLength);
}
export function editableField(document: EditorDocument, field: FieldDefinition): boolean {
  if (!field.specs.includes(document.spec === 'chara_card_v3' ? 'v3' : 'v2')) return false;
  if (field.type === 'readonly') return false;
  let current: JsonValue | undefined = document.data;
  for (const part of field.path.split('.').slice(0, -1)) {
    if (current === undefined) break;
    if (!object(current)) return false;
    current = Object.hasOwn(current, part) ? current[part] : undefined;
  }
  if (current !== undefined && !object(current)) return false;
  const value = fieldValue(document, field);
  return value === undefined || fieldAccepts(field, value);
}

/** Every controller owns its draft, listeners and save lifecycle. No singleton or I/O. */
export function createEditor(initial: EditorRevision, ports: EditorPorts) {
  let baseline = own(initial);
  let state: EditorState = freeze({ ...baseline, assetPlan: null, dirty: false, status: 'idle', error: null });
  const listeners = new Set<() => void>();
  const lorebookReviews = new WeakMap<LorebookImportReview, { state: EditorState; book: EditorDocument }>();
  function publish(next: EditorState) {
    state = freeze(next);
    for (const listener of listeners) listener();
  }
  function draft(document: EditorDocument) {
    publish({ ...state, document, dirty: state.assetPlan !== null || JSON.stringify(document) !== JSON.stringify(baseline.document), status: 'idle', error: null });
  }
  return {
    history: ports.history,
    assets: ports.assets,
    tokens: ports.tokens,
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    edit(fieldId: string, value: JsonValue) {
      if (state.status === 'saving') throw new Error('Wait for the save to finish');
      const field = fieldDefinitions.find((candidate) => candidate.id === fieldId);
      if (!field || !editableField(state.document, field) || !fieldAccepts(field, value)) throw new Error('This field cannot accept that value');
      const document = structuredClone(state.document);
      let target = document.data as EditorDocument;
      const parts = field.path.split('.');
      for (const part of parts.slice(0, -1)) {
        if (!Object.hasOwn(target, part)) target[part] = {};
        target = target[part] as EditorDocument;
      }
      target[parts.at(-1)!] = structuredClone(value);
      draft(document);
    },
    editLorebook(edit: LorebookEdit) {
      if (state.status === 'saving') throw new Error('Wait for the save to finish');
      draft(editLorebook(state.document, edit));
    },
    prepareLorebookImport(bytes: Uint8Array): LorebookImportReview {
      if (state.status === 'saving') throw new Error('Wait for the save to finish');
      const book = readLorebookFile(bytes);
      const document = { ...state.document, data: { ...(state.document.data as EditorDocument), character_book: book } };
      if (new TextEncoder().encode(JSON.stringify(document)).byteLength > lorebookFileLimit) {
        throw new Error('This lorebook would make the card exceed 256 KiB.');
      }
      const review = freeze({ name: typeof book.name === 'string' ? book.name : null,
        entries: (book.entries as JsonValue[]).length,
        replacesExisting: characterBook(state.document) !== undefined && characterBook(state.document) !== null });
      lorebookReviews.set(review, { state, book });
      return review;
    },
    attachLorebook(review: LorebookImportReview) {
      if (state.status === 'saving') throw new Error('Wait for the save to finish');
      const prepared = lorebookReviews.get(review);
      if (!prepared || prepared.state !== state) throw new Error('The draft changed. Choose the lorebook file again to review it.');
      lorebookReviews.delete(review);
      const document = structuredClone(state.document);
      (document.data as EditorDocument).character_book = structuredClone(prepared.book);
      draft(document);
    },
    downloadLorebook() { return writeLorebookFile(characterBook(state.document)); },
    editAssets(snapshot: EditorAssetSnapshot, edit: AssetEdit) {
      if (state.status === 'saving') throw new Error('Wait for the save to finish');
      if (!ports.assets) throw new Error('Asset editing is unavailable in this host');
      if (snapshot.revisionId !== state.revisionId) throw new Error('Reload the asset list before editing.');
      const next = editAssets(state.document, state.assetPlan ?? initialAssetPlan(snapshot), snapshot, edit);
      const unchanged = next.plan.files.length === 0 && next.plan.bindings.length === snapshot.assets.length
        && next.plan.bindings.every((binding) => binding.source.kind === 'existing' && binding.source.path === binding.path);
      const plan = unchanged && JSON.stringify((next.document.data as EditorDocument).assets) === JSON.stringify((baseline.document.data as EditorDocument).assets) ? null : next.plan;
      publish({ ...state, document: next.document, assetPlan: plan,
        dirty: plan !== null || JSON.stringify(next.document) !== JSON.stringify(baseline.document), status: 'idle', error: null });
    },
    discard() {
      if (state.status === 'saving') throw new Error('Wait for the save to finish');
      publish({ ...baseline, assetPlan: null, dirty: false, status: 'idle', error: null });
    },
    async save(): Promise<boolean> {
      if (state.status === 'saving') return false;
      if (!state.dirty) return true;
      publish({ ...state, status: 'saving', error: null });
      try {
        // Hosts receive an owned copy. Lineage, hashes and conflict policy belong there.
        const input = structuredClone({ document: state.document, revisionId: state.revisionId });
        baseline = own(await (state.assetPlan ? ports.assets!.save(input, structuredClone(state.assetPlan)) : ports.save(input)));
        publish({ ...baseline, assetPlan: null, dirty: false, status: 'saved', error: null });
        return true;
      } catch (error) {
        publish({ ...state, status: 'error', error: error instanceof Error ? error.message : 'Save failed. Your draft is still open.' });
        return false;
      }
    },
  };
}
export type EditorController = ReturnType<typeof createEditor>;
