import type { EditorDocument, JsonValue } from './controller.js';

// Draft controls ported from Architect's LorebookEditor at ceb138e769470f104851f34869c1fb058c50d11b.
// These operate on positions in the owned draft, not imported IDs: wild books can
// contain duplicate/missing IDs. Format parsing/validation remains in Foundry.
export interface LoreField {
  path: string; label: string;
  kind: 'text' | 'textarea' | 'number' | 'boolean' | 'keys' | 'choice';
  min?: number; max?: number; fractional?: boolean; nullable?: boolean;
  choices?: readonly string[]; v3?: boolean; required?: boolean;
}
export const bookFields: readonly LoreField[] = [
  { path: 'name', label: 'Lorebook name', kind: 'text' },
  { path: 'description', label: 'Lorebook description', kind: 'textarea' },
  { path: 'scan_depth', label: 'Scan depth', kind: 'number', min: 0 },
  { path: 'token_budget', label: 'Token budget', kind: 'number', min: 0 },
  { path: 'recursive_scanning', label: 'Recursive scanning', kind: 'boolean' },
];
export const entryFields: readonly LoreField[] = [
  { path: 'name', label: 'Entry name', kind: 'text' },
  { path: 'keys', label: 'Primary keys', kind: 'keys' },
  { path: 'secondary_keys', label: 'Secondary keys', kind: 'keys', nullable: true },
  { path: 'content', label: 'Entry content', kind: 'textarea', required: true },
  { path: 'comment', label: 'Entry comment', kind: 'text', nullable: true },
  { path: 'enabled', label: 'Enabled', kind: 'boolean', required: true },
  { path: 'selective', label: 'Selective', kind: 'boolean', nullable: true },
  { path: 'constant', label: 'Constant', kind: 'boolean', nullable: true },
  { path: 'case_sensitive', label: 'Case sensitive', kind: 'boolean', nullable: true },
  { path: 'insertion_order', label: 'Insertion order', kind: 'number', required: true },
  { path: 'priority', label: 'Priority', kind: 'number', nullable: true },
  { path: 'position', label: 'Position', kind: 'choice', choices: ['', 'before_char', 'after_char', 'in_chat'], nullable: true },
  { path: 'depth', label: 'Depth', kind: 'number', min: 0 },
  { path: 'probability', label: 'Probability (%)', kind: 'number', min: 0, max: 100, fractional: true },
  { path: 'extensions.weight', label: 'Weight / group weight', kind: 'number' },
  { path: 'extensions.displayIndex', label: 'Display index', kind: 'number' },
  { path: 'extensions.useProbability', label: 'Use probability', kind: 'boolean' },
  { path: 'extensions.excludeRecursion', label: 'Exclude recursion', kind: 'boolean' },
  { path: 'extensions.addMemo', label: 'Add memo', kind: 'boolean' },
  { path: 'extensions.characterFilter', label: 'Character filter', kind: 'text', nullable: true },
  { path: 'automation_id', label: 'Automation ID', kind: 'text', v3: true },
  { path: 'role', label: 'Role', kind: 'choice', choices: ['system', 'user', 'assistant'], nullable: true, v3: true },
  { path: 'group', label: 'Group', kind: 'text', v3: true },
  { path: 'scan_frequency', label: 'Scan frequency', kind: 'number', min: 0, v3: true },
  { path: 'use_regex', label: 'Use regular expressions', kind: 'boolean', v3: true },
  { path: 'selective_logic', label: 'Selective logic', kind: 'choice', choices: ['AND', 'NOT'], v3: true },
];
export function loreObject(value: unknown): value is EditorDocument {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function loreValue(target: EditorDocument, field: LoreField): JsonValue | undefined {
  let value: JsonValue | undefined = target;
  for (const part of field.path.split('.')) {
    if (!loreObject(value) || !Object.hasOwn(value, part)) return undefined;
    value = value[part];
  }
  return value;
}
function accepts(field: LoreField, value: JsonValue): boolean {
  if (value === null) return field.nullable === true;
  switch (field.kind) {
    case 'text': case 'textarea': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'keys': return Array.isArray(value) && value.every((item) => typeof item === 'string');
    case 'choice': return typeof value === 'string' && field.choices!.includes(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value)
      && (field.fractional ? Math.abs(value) <= Number.MAX_SAFE_INTEGER : Number.isSafeInteger(value))
      && value >= (field.min ?? Number.MIN_SAFE_INTEGER) && value <= (field.max ?? Number.MAX_SAFE_INTEGER);
  }
}
export function editableLoreField(target: EditorDocument, field: LoreField): boolean {
  let parent: JsonValue | undefined = target;
  for (const part of field.path.split('.').slice(0, -1)) {
    if (!loreObject(parent)) return false;
    parent = Object.hasOwn(parent, part) ? parent[part] : undefined;
    if (parent === undefined) return true;
  }
  if (!loreObject(parent)) return false;
  const value = loreValue(target, field);
  return value === undefined || accepts(field, value);
}
export function characterBook(document: EditorDocument): JsonValue | undefined {
  const data = document.data;
  return loreObject(data) && Object.hasOwn(data, 'character_book') ? data.character_book : undefined;
}
export function editableBook(value: JsonValue | undefined): value is EditorDocument {
  return loreObject(value) && (value.entries === undefined || Array.isArray(value.entries));
}
export function entryLabel(entry: JsonValue, index: number): string {
  return loreObject(entry) && typeof entry.name === 'string' && entry.name ? entry.name : `Entry ${index + 1}`;
}
export type LorebookEdit =
  | { type: 'initialize' }
  | { type: 'book-field'; field: string; value: JsonValue | undefined }
  | { type: 'entry-field'; index: number; field: string; value: JsonValue | undefined }
  | { type: 'add' }
  | { type: 'copy' | 'remove'; index: number }
  | { type: 'move'; index: number; offset: -1 | 1 };

export function editLorebook(source: EditorDocument, edit: LorebookEdit): EditorDocument {
  const document = structuredClone(source);
  const data = document.data as EditorDocument;
  const book = characterBook(document);
  if (edit.type === 'initialize') {
    if (book !== undefined && book !== null) throw new Error('An existing lorebook cannot be replaced');
    data.character_book = { name: `${typeof data.name === 'string' ? data.name : 'Character'} Lorebook`, description: '',
      scan_depth: 100, token_budget: 500, recursive_scanning: false, extensions: {}, entries: [] };
    return document;
  }
  if (!editableBook(book)) throw new Error('This lorebook has an unsupported shape and will be preserved');
  const entries = (book.entries ?? []) as JsonValue[];
  function at(index: number) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= entries.length) throw new Error('Select an existing lorebook entry');
    return entries[index]!;
  }
  function setField(target: EditorDocument, fields: readonly LoreField[], path: string, value: JsonValue | undefined) {
    const field = fields.find((candidate) => candidate.path === path);
    if (!field || (field.v3 && document.spec !== 'chara_card_v3') || !editableLoreField(target, field)
      || (value === undefined ? field.required : !accepts(field, value))) throw new Error('This lorebook field cannot accept that value');
    const parts = field.path.split('.');
    for (const part of parts.slice(0, -1)) {
      if (!Object.hasOwn(target, part)) {
        if (value === undefined) return;
        target[part] = {};
      }
      target = target[part] as EditorDocument;
    }
    if (value === undefined) delete target[parts.at(-1)!];
    else target[parts.at(-1)!] = structuredClone(value);
  }
  switch (edit.type) {
    case 'book-field': setField(book, bookFields, edit.field, edit.value); break;
    case 'entry-field': {
      const entry = at(edit.index);
      if (!loreObject(entry)) throw new Error('This entry has an unsupported shape and will be preserved');
      setField(entry, entryFields, edit.field, edit.value); break;
    }
    case 'add': case 'copy': {
      const ids = new Set(entries.filter(loreObject).map((entry) => String(entry.id)));
      let id = 0; while (ids.has(String(id))) id++;
      const order = entries.reduce<number>((max, entry) => loreObject(entry) && typeof entry.insertion_order === 'number'
        && Number.isSafeInteger(entry.insertion_order) ? Math.max(max, entry.insertion_order) : max, -1);
      const insertion_order = order < Number.MAX_SAFE_INTEGER ? order + 1 : entries.length;
      let entry: EditorDocument = { id, keys: [], content: '', enabled: true, insertion_order, extensions: {} };
      if (edit.type === 'copy') {
        const original = at(edit.index);
        if (!loreObject(original)) throw new Error('This entry cannot be copied');
        entry = { ...structuredClone(original), id, insertion_order };
        if (original.name === undefined || typeof original.name === 'string') entry.name = `${entryLabel(original, edit.index)} (copy)`;
      }
      book.entries = [...entries, entry]; break;
    }
    case 'remove': at(edit.index); book.entries = entries.filter((_, index) => index !== edit.index); break;
    case 'move': {
      at(edit.index);
      if (edit.offset !== -1 && edit.offset !== 1) throw new Error('Invalid lorebook move');
      const destination = edit.index + edit.offset;
      at(destination);
      [entries[edit.index], entries[destination]] = [entries[destination]!, entries[edit.index]!];
      book.entries = entries; break;
    }
  }
  return document;
}
