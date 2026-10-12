import { describe, expect, it, vi } from 'vitest';
import { createEditor } from './controller.js';
import type { EditorRevision } from './controller.js';

function initial(): EditorRevision {
  return { revisionId: 'initial', document: { spec: 'chara_card_v3', spec_version: '3.0', opaqueEnvelope: [1, null], data: {
    name: 'Aster', description: 'Original', alternate_greetings: ['Hello'], tags: ['quiet'],
    character_book: { entries: [{ id: 10, unknown: true }] }, assets: [{ uri: 'ccdefault:', unknown: 'asset' }],
    extensions: { vendor: { unknown: true }, foundry: { local: { preferred: true }, lineage: { hash: 'opaque to editor' } } },
  } } };
}

describe('per-instance editor', () => {
  it('isolates two drafts, preserves opaque fields and saves only explicitly', async () => {
    const source = initial();
    const save = vi.fn(async (input: EditorRevision) => ({ ...input, revisionId: 'saved' }));
    const first = createEditor(source, { save });
    const second = createEditor(source, { save });
    source.document.opaqueEnvelope = 'caller mutation';
    first.edit('description', 'First draft');
    second.edit('name', 'Second draft');
    expect(save).not.toHaveBeenCalled();
    const expected = initial();
    (expected.document.data as Record<string, unknown>).description = 'First draft';
    expect(first.getSnapshot().document).toEqual(expected.document);
    expect(await first.save()).toBe(true);
    expect(save).toHaveBeenCalledWith(expected);
    expect(second.getSnapshot()).toMatchObject({ revisionId: 'initial', dirty: true, document: { data: { name: 'Second draft', description: 'Original' } } });
    expect(first.getSnapshot()).toMatchObject({ revisionId: 'saved', dirty: false });
    second.discard();
    expect(second.getSnapshot().document).toEqual(initial().document);
    const reopened = createEditor(first.getSnapshot(), { save });
    expect(reopened.getSnapshot().document).toEqual(expected.document);
    expect(Object.isFrozen(reopened.getSnapshot().document.data)).toBe(true);
  });

  it('retains failed drafts and prevents duplicate or overlapping save/edit operations', async () => {
    let reject!: (error: Error) => void;
    const save = vi.fn(() => new Promise<EditorRevision>((_, failure) => { reject = failure; }));
    const editor = createEditor(initial(), { save });
    editor.edit('description', 'Keep me');
    const pending = editor.save();
    expect(editor.getSnapshot().status).toBe('saving');
    expect(() => editor.edit('name', 'Race')).toThrow('Wait');
    expect(() => editor.discard()).toThrow('Wait');
    expect(await editor.save()).toBe(false);
    reject(new Error('The card has changed; reload before saving'));
    expect(await pending).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
    expect(editor.getSnapshot()).toMatchObject({ dirty: true, status: 'error', document: { data: { description: 'Keep me' } } });
  });

  it('does not invent fields on open, restricts writable paths and preserves incompatible values', async () => {
    const source = initial();
    const data = source.document.data as Record<string, never>;
    Object.assign(data, { creator: null, extensions: { depth_prompt: 'opaque', vendor: true } });
    const save = vi.fn(async (input: EditorRevision) => input);
    const editor = createEditor(source, { save });
    expect(await editor.save()).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(() => editor.edit('creator', 'replace null')).toThrow();
    expect(() => editor.edit('character_note', 'replace opaque parent')).toThrow();
    expect(() => editor.edit('assets', [])).toThrow();
    expect(() => editor.edit('__proto__.polluted', true)).toThrow();
    expect(() => editor.edit('character_note_depth', 101)).toThrow();
    editor.edit('alternate_greetings', ['Hi', 'Welcome']);
    editor.edit('creator_notes_multilingual', { en: 'A note', ja: 'こんにちは' });
    expect(editor.getSnapshot().document).toMatchObject({ data: { creator: null, extensions: { depth_prompt: 'opaque', vendor: true } } });
    expect(source.document).toEqual(initialWithOpaque());
    function initialWithOpaque() { const result = initial().document; Object.assign(result.data!, { creator: null, extensions: { depth_prompt: 'opaque', vendor: true } }); return result; }
  });

  it('preserves nested siblings and new host lineage across consecutive saves', async () => {
    const source = initial();
    const save = vi.fn(async (input: EditorRevision) => {
      const result = structuredClone(input);
      result.revisionId = `${input.revisionId}-next`;
      const data = result.document.data as { extensions: Record<string, unknown> };
      data.extensions.foundry = { lineage: { new: result.revisionId } };
      return result;
    });
    const editor = createEditor(source, { save });
    editor.edit('character_note', 'A gentle guide');
    editor.edit('character_note_depth', 4);
    expect(editor.getSnapshot().document).toMatchObject({ data: { extensions: { vendor: { unknown: true }, depth_prompt: { prompt: 'A gentle guide', depth: 4 } } } });
    await editor.save();
    editor.edit('name', 'Aster II');
    await editor.save();
    expect(save.mock.calls[1]![0]).toMatchObject({ revisionId: 'initial-next', document: { data: { extensions: { foundry: { lineage: { new: 'initial-next' } } } } } });
    expect(editor.getSnapshot().revisionId).toBe('initial-next-next');
  });
});
