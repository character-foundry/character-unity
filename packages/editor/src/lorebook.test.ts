import { expect, test, vi } from 'vitest';
import { createEditor } from './controller.js';
import type { EditorDocument, EditorRevision } from './controller.js';

function source(): EditorRevision {
  return { revisionId: 'baseline', document: { spec: 'chara_card_v3', spec_version: '3.0', envelope: [null, 'keep'], data: {
    name: 'Aster', character_book: { name: 'Stars', opaqueBook: { keep: true }, extensions: { vendor: [1, null] }, entries: [
      { id: 9, name: 'First', content: 'One', keys: ['sky, moon', ''], insertion_order: 10, enabled: true, comment: null, extensions: { vendor: { preserve: true } } },
      { id: 9, name: 'Second', content: 'Two', keys: [], insertion_order: 40, enabled: true, opaque: ['other'] },
      { name: 'Without ID', content: 'Three', insertion_order: 3, enabled: false },
    ] }, assets: [{ uri: 'embedded://portrait.png', future: true }], extensions: { foundry: { lineage: { untouched: true } } },
  } } };
}
function book(editor: ReturnType<typeof createEditor>) {
  return (editor.getSnapshot().document.data as EditorDocument).character_book as EditorDocument & { entries: EditorDocument[] };
}
const persist = async (value: EditorRevision) => ({ ...value, revisionId: 'saved' });

test('lorebook edits target array positions with duplicate/missing IDs and preserve all other data', async () => {
  const input = source(), save = vi.fn(persist), editor = createEditor(input, { save });
  expect(await editor.save()).toBe(true); expect(save).not.toHaveBeenCalled();
  editor.editLorebook({ type: 'entry-field', index: 1, field: 'content', value: 'Only second' });
  editor.editLorebook({ type: 'entry-field', index: 0, field: 'extensions.weight', value: 0 });
  editor.editLorebook({ type: 'entry-field', index: 0, field: 'secondary_keys', value: ['a,b', '', 'a,b'] });
  editor.editLorebook({ type: 'book-field', field: 'token_budget', value: 0 });
  const expected = source();
  const expectedBook = (expected.document.data as EditorDocument).character_book as ReturnType<typeof book>;
  expectedBook.token_budget = 0;
  expectedBook.entries[1]!.content = 'Only second';
  (expectedBook.entries[0]!.extensions as EditorDocument).weight = 0;
  expectedBook.entries[0]!.secondary_keys = ['a,b', '', 'a,b'];
  expect(editor.getSnapshot().document).toEqual(expected.document);
  expect(input).toEqual(source());
  expect(await editor.save()).toBe(true); expect(save).toHaveBeenCalledWith(expected);
  expect(Object.isFrozen(book(editor).entries[0]!.extensions)).toBe(true);
});

test('copy allocates an unused ID, reorder keeps insertion order, and removal deletes only the chosen entry', () => {
  const editor = createEditor(source(), { save: persist });
  const original = structuredClone(book(editor));
  editor.editLorebook({ type: 'copy', index: 0 });
  const copied = structuredClone(book(editor).entries[3]!);
  expect(copied).toEqual({ ...original.entries[0], id: 0, name: 'First (copy)', insertion_order: 41 });
  editor.editLorebook({ type: 'entry-field', index: 3, field: 'keys', value: ['new'] });
  editor.editLorebook({ type: 'entry-field', index: 3, field: 'extensions.weight', value: 3 });
  expect(book(editor).entries[0]).toEqual(original.entries[0]);
  editor.editLorebook({ type: 'move', index: 3, offset: -1 });
  expect(book(editor).entries.map((entry) => entry.insertion_order)).toEqual([10, 40, 41, 3]);
  editor.editLorebook({ type: 'remove', index: 0 });
  expect(book(editor).entries[0]).toEqual(original.entries[1]);
  expect(book(editor).entries[2]).toEqual(original.entries[2]);
  editor.editLorebook({ type: 'add' });
  expect(book(editor).entries[3]).toMatchObject({ id: 1, insertion_order: 42, content: '', enabled: true });
  editor.discard(); expect(editor.getSnapshot().document).toEqual(source().document);
});

test('book initialization is explicit, preserves null until requested, and never replaces existing books', () => {
  for (const absent of [undefined, null]) {
    const input = source(), data = input.document.data as EditorDocument;
    if (absent === undefined) delete data.character_book; else data.character_book = absent;
    const editor = createEditor(input, { save: persist });
    expect(editor.getSnapshot().document).toEqual(input.document);
    editor.editLorebook({ type: 'initialize' });
    expect(book(editor)).toMatchObject({ name: 'Aster Lorebook', entries: [], scan_depth: 100, token_budget: 500 });
    expect(() => editor.editLorebook({ type: 'initialize' })).toThrow('cannot be replaced');
    editor.discard(); expect(editor.getSnapshot().document).toEqual(input.document);
  }
  const editor = createEditor(source(), { save: persist });
  expect(() => editor.editLorebook({ type: 'initialize' })).toThrow('cannot be replaced');
  expect(editor.getSnapshot().dirty).toBe(false);
});

test('incompatible book/field shapes and unapproved paths cannot be silently overwritten', () => {
  const input = source(), data = input.document.data as EditorDocument;
  for (const invalid of ['opaque book', [], { entries: { future: true } }]) {
    const editor = createEditor({ ...input, document: { ...input.document, data: { ...data, character_book: invalid } } }, { save: persist });
    expect(() => editor.editLorebook({ type: 'add' })).toThrow('unsupported');
    editor.edit('name', 'Still editable');
    expect((editor.getSnapshot().document.data as EditorDocument).character_book).toEqual(invalid);
  }
  const initialBook = data.character_book as ReturnType<typeof book>;
  initialBook.entries[1]!.extensions = 'opaque parent';
  initialBook.entries[1]!.position = 0;
  initialBook.scan_depth = '80';
  const editor = createEditor(input, { save: persist });
  for (const field of ['extensions.weight', '__proto__.polluted', 'id', 'position', 'assets']) {
    expect(() => editor.editLorebook({ type: 'entry-field', index: 1, field, value: 1 })).toThrow('cannot accept');
  }
  expect(() => editor.editLorebook({ type: 'book-field', field: 'scan_depth', value: 80 })).toThrow('cannot accept');
  for (const index of [-1, 3, 0.5, NaN]) expect(() => editor.editLorebook({ type: 'remove', index })).toThrow('existing');
  expect(() => editor.editLorebook({ type: 'move', index: 0, offset: -1 })).toThrow('existing');
  expect(editor.getSnapshot().document).toEqual(input.document);
});

test('validates numbers and explicit null/absence without replacing meaningful zero values', () => {
  const editor = createEditor(source(), { save: persist });
  for (const value of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => editor.editLorebook({ type: 'book-field', field: 'scan_depth', value })).toThrow('cannot accept');
  }
  for (const value of [-1, 101]) expect(() => editor.editLorebook({ type: 'entry-field', index: 0, field: 'probability', value })).toThrow('cannot accept');
  editor.editLorebook({ type: 'entry-field', index: 0, field: 'probability', value: 0.5 });
  editor.editLorebook({ type: 'entry-field', index: 0, field: 'priority', value: -5 });
  editor.editLorebook({ type: 'entry-field', index: 0, field: 'comment', value: 'Explicit comment' });
  editor.editLorebook({ type: 'entry-field', index: 0, field: 'selective', value: null });
  editor.editLorebook({ type: 'book-field', field: 'scan_depth', value: 0 });
  expect(book(editor).scan_depth).toBe(0);
  expect(book(editor).entries[0]).toMatchObject({ probability: 0.5, priority: -5, comment: 'Explicit comment', selective: null });
  editor.editLorebook({ type: 'book-field', field: 'scan_depth', value: undefined });
  expect(Object.hasOwn(book(editor), 'scan_depth')).toBe(false);
  expect(() => editor.editLorebook({ type: 'entry-field', index: 0, field: 'content', value: undefined })).toThrow('cannot accept');
  const v2 = source(); v2.document.spec = 'chara_card_v2';
  expect(() => createEditor(v2, { save: persist }).editLorebook({ type: 'entry-field', index: 0, field: 'automation_id', value: 'v3' })).toThrow('cannot accept');
});

test('independent lorebooks retain drafts on failed saves and lock all mutations during save', async () => {
  let reject!: (error: Error) => void;
  const first = createEditor(source(), { save: () => new Promise((_, fail) => { reject = fail; }) });
  const second = createEditor(source(), { save: persist });
  first.editLorebook({ type: 'entry-field', index: 0, field: 'content', value: 'Keep draft' });
  second.editLorebook({ type: 'remove', index: 0 });
  const pending = first.save();
  for (const edit of [{ type: 'add' }, { type: 'remove', index: 0 }, { type: 'book-field', field: 'name', value: 'Race' }] as const) {
    expect(() => first.editLorebook(edit)).toThrow('Wait');
  }
  reject(new Error('Session expired'));
  expect(await pending).toBe(false);
  expect(first.getSnapshot()).toMatchObject({ revisionId: 'baseline', dirty: true, status: 'error' });
  expect(book(first).entries[0]!.content).toBe('Keep draft');
  expect(book(second).entries).toHaveLength(2);
  await second.save(); expect(book(first).entries).toHaveLength(3);
});
