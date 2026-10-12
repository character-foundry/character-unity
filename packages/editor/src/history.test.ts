import { expect, test, vi } from 'vitest';
import { compareDocuments } from './history.js';
import { createEditor } from './controller.js';

test('comparison ignores object key order while preserving missing/null, opaque data and array order', () => {
  const before = { data: { name: 'Aster', empty: {}, tags: ['first', 'second'], absentAfter: null, nested: { z: 3, a: 1 } } };
  const after = { data: { nested: { a: 1, z: 3 }, name: 'Aster', empty: [], tags: ['second', 'first'], presentAfter: null } };
  expect(compareDocuments(before, after)).toEqual({ truncated: false, changes: [
    { path: ['data', 'absentAfter'], before: null, after: undefined },
    { path: ['data', 'empty'], before: {}, after: [] },
    { path: ['data', 'presentAfter'], before: undefined, after: null },
    { path: ['data', 'tags', '0'], before: 'first', after: 'second' },
    { path: ['data', 'tags', '1'], before: 'second', after: 'first' },
  ] });
  expect(compareDocuments(before, structuredClone(before))).toEqual({ changes: [], truncated: false });
  const unusual = JSON.parse('{"__proto__":{"keep":true},"a/b~c":"before"}');
  const changed = JSON.parse('{"__proto__":{"keep":false},"a/b~c":"after"}');
  expect(compareDocuments(unusual, changed).changes.map((value) => value.path)).toEqual([['__proto__', 'keep'], ['a/b~c']]);
});

test('comparison pagination reports overflow explicitly and every difference remains reachable', () => {
  const before = { values: Array.from({ length: 125 }, (_, i) => i) };
  const after = { values: Array.from({ length: 125 }, (_, i) => -i - 1) };
  const pages = [0, 50, 100].map((offset) => compareDocuments(before, after, 50, offset));
  expect(pages.map((page) => page.changes.length)).toEqual([50, 50, 25]);
  expect(pages.map((page) => page.truncated)).toEqual([true, true, false]);
  expect(new Set(pages.flatMap((page) => page.changes.map((change) => change.path.join('/')))).size).toBe(125);
  expect(compareDocuments({ values: [1] }, { values: [1, 2] }).changes).toEqual([{ path: ['values', '1'], before: undefined, after: 2 }]);
});

test('host history reads and comparison cannot rewrite draft, expected head or save lineage', async () => {
  const initial = { revisionId: 'base', document: { spec: 'chara_card_v3', data: { name: 'Aster', description: 'Original' } } };
  const save = vi.fn(async (value) => value);
  const history = { list: vi.fn(async () => ({ revisions: [], headRevisionId: 'newer', throughSequence: 2, nextAfter: null })),
    read: vi.fn(async () => ({ ...initial, revisionId: 'older' })) };
  const editor = createEditor(initial, { save, history });
  editor.edit('description', 'Keep this draft');
  const snapshot = editor.getSnapshot();
  const controller = new AbortController();
  await editor.history!.list({}, controller.signal);
  const old = await editor.history!.read('older', controller.signal);
  compareDocuments(old.document, snapshot.document);
  expect(editor.getSnapshot()).toBe(snapshot); expect(save).not.toHaveBeenCalled();
  await editor.save(); expect(save).toHaveBeenCalledWith({ revisionId: 'base', document: snapshot.document });
});
