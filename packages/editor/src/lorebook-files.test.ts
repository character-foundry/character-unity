import { expect, test, vi } from 'vitest';
import { createEditor } from './controller.js';
import type { EditorDocument, EditorRevision } from './controller.js';
import { readLorebookFile, writeLorebookFile } from './lorebook-files.js';

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function source(): EditorRevision {
  return { revisionId: 'original', document: { spec: 'chara_card_v3', spec_version: '3.0', opaque: [1, null],
    data: { name: 'Aster', character_book: { name: 'Old lore', entries: [] }, extensions: { vendor: true },
      assets: [{ type: 'icon', uri: 'embedded://portrait.png' }] } } };
}
function book() {
  return { name: 'Places', scan_depth: 0, token_budget: 100, recursive_scanning: false,
    future: { keep: [1, null] }, extensions: { vendor: true }, entries: [
      { keys: ['sky, moon', ''], content: 'One', id: 9, position: 'after_char', extensions: { vendor: { zero: 0 } } },
      { keys: [], content: 'Two', id: 9, enabled: false, insertion_order: -3, opaque: [null, false] },
      { keys: ['forest'], content: 'Three', probability: 0, role: 'assistant' },
    ] };
}
const save = async (input: EditorRevision) => ({ ...input, revisionId: 'saved' });

test('native standalone transfer preserves the original JSON shape, not normalized SDK output', () => {
  const input = book();
  expect(readLorebookFile(bytes(input))).toEqual(input);
  expect(JSON.parse(writeLorebookFile(readLorebookFile(bytes(input))))).toEqual(input);
  expect(readLorebookFile(bytes({ name: 'Empty', entries: [], future: null }))).toEqual({ name: 'Empty', entries: [], future: null });
  const prototype = readLorebookFile(new TextEncoder().encode('{"entries":[],"__proto__":{"polluted":true}}'));
  expect(Object.hasOwn(prototype, '__proto__')).toBe(true);
  expect(JSON.parse(writeLorebookFile(prototype))).toEqual(JSON.parse('{"entries":[],"__proto__":{"polluted":true}}'));
  expect(Object.hasOwn({}, 'polluted')).toBe(false);
});

test('rejects unsupported formats, invalid input and bounded-resource failures before changing a draft', () => {
  const editor = createEditor(source(), { save });
  const input = editor.getSnapshot();
  for (const value of [null, [], {}, { entries: [null] }, { entries: [{ keys: ['sky'], content: 7 }] },
    { entries: [book().entries[0], { keys: ['sky', 2], content: 'bad keys' }] },
    { entries: { '1': { uid: 1, key: ['sky'], content: 'World info' } } },
    { kind: 'memory', entries: [{ keywords: ['sky'], entry: 'Agnai' }] }, { kind: 'memory', entries: [] },
    { type: 'risu', entries: [] }, { format: 'wyvern', entries: [] },
    { spec: 'chara_card_v3', entries: [], data: {} },
    { ...book(), unsafe: Number.MAX_SAFE_INTEGER + 1 },
    { entries: Array.from({ length: 1001 }, () => ({ keys: [], content: '' })) },
    { entries: [], nested: Array.from({ length: 20_001 }, () => 0) },
    { entries: [], nested: Array.from({ length: 65 }).reduce<unknown>((value) => [value], '') },
  ]) expect(() => editor.prepareLorebookImport(bytes(value))).toThrow();
  for (const input of [new Uint8Array(), new Uint8Array(262_145), new Uint8Array([0xc3, 0x28]),
    new TextEncoder().encode('{"entries":[], "n":1e999}'), new TextEncoder().encode('{bad JSON')]) {
    expect(() => editor.prepareLorebookImport(input)).toThrow();
  }
  expect(editor.getSnapshot()).toBe(input);
  editor.edit('description', 'x'.repeat(262_100));
  expect(() => editor.prepareLorebookImport(bytes(book()))).toThrow('card exceed');
});

test('review and draft download do not save; attach changes only the owned draft and discard restores it', async () => {
  const persist = vi.fn(save), initial = source(), editor = createEditor(initial, { save: persist });
  editor.edit('description', 'Keep this unsaved description');
  const before = editor.getSnapshot(), input = bytes(book());
  const review = editor.prepareLorebookImport(input);
  expect(review).toEqual({ name: 'Places', entries: 3, replacesExisting: true });
  expect(Object.isFrozen(review)).toBe(true);
  expect(editor.getSnapshot()).toBe(before);
  input.fill(0);
  editor.attachLorebook(review);
  expect(editor.getSnapshot().document).toEqual({ ...initial.document, data: {
    ...(initial.document.data as EditorDocument), description: 'Keep this unsaved description', character_book: book(),
  } });
  expect(JSON.parse(editor.downloadLorebook())).toEqual(book());
  expect(persist).not.toHaveBeenCalled();
  expect(() => editor.attachLorebook(review)).toThrow('draft changed');
  editor.discard(); expect(editor.getSnapshot().document).toEqual(initial.document);
  const next = editor.prepareLorebookImport(bytes(book())); editor.attachLorebook(next);
  expect(await editor.save()).toBe(true);
  expect(persist).toHaveBeenCalledOnce();
  expect(initial).toEqual(source());
});

test('reviews are instance-bound, single-use and invalidated by edit, discard or save transitions', async () => {
  const first = createEditor(source(), { save }), second = createEditor(source(), { save });
  const cross = first.prepareLorebookImport(bytes(book()));
  expect(() => second.attachLorebook(cross)).toThrow('draft changed');
  expect(() => first.attachLorebook({ ...cross })).toThrow('draft changed');
  first.edit('description', 'changed');
  expect(() => first.attachLorebook(cross)).toThrow('draft changed');
  const discarded = first.prepareLorebookImport(bytes(book())); first.discard();
  expect(() => first.attachLorebook(discarded)).toThrow('draft changed');
  first.edit('name', 'Saved name'); const reviewed = first.prepareLorebookImport(bytes(book()));
  await first.save(); expect(() => first.attachLorebook(reviewed)).toThrow('draft changed');
  expect(second.getSnapshot().dirty).toBe(false);
});

test('absent, null and opaque existing books can be explicitly replaced and failed saves keep the result', async () => {
  for (const previous of [undefined, null, 'opaque book', { entries: { future: true } }]) {
    const initial = source(), data = initial.document.data as EditorDocument;
    if (previous === undefined) delete data.character_book; else data.character_book = previous;
    let reject!: (failure: Error) => void;
    const editor = createEditor(initial, { save: () => new Promise((_, fail) => { reject = fail; }) });
    const review = editor.prepareLorebookImport(bytes(book()));
    expect(review.replacesExisting).toBe(previous !== undefined && previous !== null);
    editor.attachLorebook(review);
    const pendingReview = editor.prepareLorebookImport(bytes({ entries: [] }));
    const saving = editor.save();
    expect(() => editor.attachLorebook(pendingReview)).toThrow('Wait');
    expect(() => editor.prepareLorebookImport(bytes(book()))).toThrow('Wait');
    reject(new Error('Session expired')); expect(await saving).toBe(false);
    expect(JSON.parse(editor.downloadLorebook())).toEqual(book());
    expect(() => editor.attachLorebook(pendingReview)).toThrow('draft changed');
    editor.discard(); expect(editor.getSnapshot().document).toEqual(initial.document);
  }
});
