import { describe, expect, it, vi } from 'vitest';
import { createEditor } from './controller.js';
import type { EditorRevision, EditorDocument } from './controller.js';
import type { EditorAssetPort, EditorAssetSnapshot } from './assets.js';

function initial(): EditorRevision {
  return { revisionId: 'r1', document: { spec: 'chara_card_v3', spec_version: '3.0', envelope: { keep: true }, data: {
    name: 'Assets', description: 'Original', assets: [
      { type: 'icon', name: 'main', ext: 'png', uri: 'embedded://main.png', opaque: { license: 'keep' } },
      { type: 'icon', name: 'alias', ext: 'png', uri: '  ccdefault:  ', vendor: [null, 1] },
      { type: 'custom', name: 'note', ext: 'txt', uri: 'embedded://notes.txt', metadata: true },
    ], extensions: { unknown: ['keep'] },
  } } };
}
const snapshot: EditorAssetSnapshot = { revisionId: 'r1', assets: [
  { path: 'portrait', hash: 'portrait', byteLength: 3, mediaType: 'image/png' },
  { path: 'declared/0', hash: 'portrait', byteLength: 3, mediaType: 'image/png' },
  { path: 'declared/1', hash: 'portrait', byteLength: 3, mediaType: 'image/png' },
  { path: 'declared/2', hash: 'note', byteLength: 4, mediaType: 'text/plain' },
] };
const file = (text = 'new portrait') => new File([text], 'portrait.png', { type: 'image/png' });
function ports(save = vi.fn(async (input: EditorRevision) => ({ ...input, revisionId: 'r2' }))) {
  const assets: EditorAssetPort = { list: vi.fn(async () => structuredClone(snapshot)), read: vi.fn(async () => new Blob()), save };
  return { save: vi.fn(async (input: EditorRevision) => input), assets };
}
function items(document: EditorDocument) { return (document.data as EditorDocument).assets as EditorDocument[]; }

describe('per-instance asset drafts', () => {
  it('replaces portrait aliases together, owns uploads and preserves opaque metadata across independent drafts', async () => {
    const host = ports(), first = createEditor(initial(), host), second = createEditor(initial(), host);
    first.editAssets(snapshot, { kind: 'portrait', file: file() });
    expect(first.getSnapshot()).toMatchObject({ dirty: true, revisionId: 'r1' });
    const plan = first.getSnapshot().assetPlan!;
    expect(plan.files).toHaveLength(1); expect(await plan.files[0]!.text()).toBe('new portrait');
    for (const path of ['portrait', 'declared/0', 'declared/1']) expect(plan.bindings.find((binding) => binding.path === path)?.source).toEqual({ kind: 'upload', index: 0 });
    expect(items(first.getSnapshot().document)).toEqual(items(initial().document));
    expect(second.getSnapshot()).toMatchObject({ assetPlan: null, dirty: false, document: initial().document });
    expect(host.assets.save).not.toHaveBeenCalled();
    first.edit('description', 'Prompt edited too');
    await first.save();
    expect(host.save).not.toHaveBeenCalled(); expect(host.assets.save).toHaveBeenCalledOnce();
    expect(first.getSnapshot()).toMatchObject({ revisionId: 'r2', assetPlan: null, dirty: false, document: { data: { description: 'Prompt edited too' } } });
    expect(() => first.editAssets(snapshot, { kind: 'portrait', file: file() })).toThrow('Reload');
    second.editAssets(snapshot, { kind: 'portrait', file: file('other') }); second.discard();
    expect(second.getSnapshot()).toMatchObject({ assetPlan: null, dirty: false, document: initial().document });
  });

  it('retains pending bytes after failure and prevents edits, discard and duplicate saves while saving', async () => {
    let reject!: (reason: Error) => void;
    const host = ports(vi.fn(() => new Promise<EditorRevision>((_, fail) => { reject = fail; })));
    const editor = createEditor(initial(), host);
    editor.editAssets(snapshot, { kind: 'replace', index: 2, file: new File(['exact attachment'], 'new.txt', { type: 'text/plain' }) });
    const pending = editor.save();
    expect(() => editor.editAssets(snapshot, { kind: 'remove', index: 2 })).toThrow('Wait');
    expect(() => editor.edit('name', 'Race')).toThrow('Wait'); expect(() => editor.discard()).toThrow('Wait');
    expect(await editor.save()).toBe(false);
    reject(new Error('Session expired')); expect(await pending).toBe(false);
    expect(editor.getSnapshot()).toMatchObject({ dirty: true, status: 'error' });
    expect(await editor.getSnapshot().assetPlan!.files[0]!.text()).toBe('exact attachment');
    editor.discard(); expect(editor.getSnapshot()).toMatchObject({ assetPlan: null, dirty: false });
  });

  it('reindexes retained bindings on reorder/removal and saves descriptor-only edits through the asset port', async () => {
    const host = ports(), editor = createEditor(initial(), host);
    editor.editAssets(snapshot, { kind: 'metadata', index: 2, field: 'name', value: 'Renamed note' });
    expect(editor.getSnapshot().assetPlan).not.toBeNull();
    await editor.save(); expect(host.save).not.toHaveBeenCalled(); expect(host.assets.save).toHaveBeenCalledOnce();
    const fresh = { ...snapshot, revisionId: 'r2' };
    editor.editAssets(fresh, { kind: 'move', index: 2, delta: -1 });
    expect(editor.getSnapshot().assetPlan!.bindings.find((binding) => binding.path === 'declared/1')?.source).toEqual({ kind: 'existing', path: 'declared/2' });
    expect(items(editor.getSnapshot().document)[1]).toMatchObject({ name: 'Renamed note', metadata: true });
    editor.editAssets(fresh, { kind: 'remove-portrait' });
    expect(items(editor.getSnapshot().document)).toEqual([{ type: 'custom', name: 'Renamed note', ext: 'txt', uri: 'embedded://notes.txt', metadata: true }]);
    expect(editor.getSnapshot().assetPlan!.bindings).toEqual([{ path: 'declared/0', source: { kind: 'existing', path: 'declared/2' } }]);
    editor.discard(); expect(items(editor.getSnapshot().document)[2]!.name).toBe('Renamed note');
  });

  it('compacts replaced or removed pending uploads and handles CCv2 implicit portraits without format conversion', async () => {
    const host = ports(), editor = createEditor(initial(), host);
    editor.editAssets(snapshot, { kind: 'portrait', file: file('first') });
    editor.editAssets(snapshot, { kind: 'add', file: new File(['note'], 'extra.txt', { type: 'text/plain' }) });
    editor.editAssets(snapshot, { kind: 'portrait', file: file('second') });
    expect(editor.getSnapshot().assetPlan!.files).toHaveLength(2);
    editor.editAssets(snapshot, { kind: 'remove', index: 3 });
    expect(editor.getSnapshot().assetPlan!.files).toHaveLength(1); expect(await editor.getSnapshot().assetPlan!.files[0]!.text()).toBe('second');
    const source = initial(); source.document.spec = 'chara_card_v2'; source.document.spec_version = '2.0'; delete (source.document.data as EditorDocument).assets;
    const v2 = createEditor(source, host), empty = { revisionId: 'r1', assets: [] };
    v2.editAssets(empty, { kind: 'portrait', file: file() });
    expect(v2.getSnapshot().document).toEqual(source.document);
    expect(v2.getSnapshot().assetPlan!.bindings).toEqual([{ path: 'portrait', source: { kind: 'upload', index: 0 } }]);
    expect(() => v2.editAssets(empty, { kind: 'add', file: file() })).toThrow('CCv3');
    v2.editAssets(empty, { kind: 'remove-portrait' }); expect(v2.getSnapshot()).toMatchObject({ dirty: false, assetPlan: null });
  });

  it('rejects unsupported portraits and stale or incompatible descriptor state without changing the draft', () => {
    const host = ports(), editor = createEditor(initial(), host), before = editor.getSnapshot();
    expect(() => editor.editAssets(snapshot, { kind: 'portrait', file: new File(['<svg/>'], 'image.svg', { type: 'image/svg+xml' }) })).toThrow('PNG');
    expect(() => editor.editAssets(snapshot, { kind: 'move', index: 0, delta: -1 })).toThrow('further');
    expect(() => editor.editAssets(snapshot, { kind: 'remove', index: 999 })).toThrow('no longer');
    expect(editor.getSnapshot()).toBe(before);
    const incompatible = initial(); (incompatible.document.data as EditorDocument).assets = { opaque: true };
    const preserved = createEditor(incompatible, host);
    expect(() => preserved.editAssets(snapshot, { kind: 'portrait', file: file() })).toThrow('cannot be edited');
    expect(preserved.getSnapshot().document).toEqual(incompatible.document);
  });
});
