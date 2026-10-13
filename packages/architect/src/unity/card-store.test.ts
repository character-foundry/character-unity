import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card } from '../lib/types';
import { useCardStore } from '../store/card-store';
import { editorAssets } from './assets';
import { configureUnityHost } from './config';

const { saveDraft, deleteDraft, getDraft, tokenCounts } = vi.hoisted(() => ({
  saveDraft: vi.fn(async (_id: string, _card: Card) => { void _id; void _card; }),
  deleteDraft: vi.fn(async (_id: string) => { void _id; }),
  getDraft: vi.fn(async (_id: string) => { void _id; return null; }),
  tokenCounts: vi.fn(),
}));
vi.mock('../lib/db', () => ({ localDB: { saveDraft, deleteDraft, getDraft } }));
vi.mock('../store/token-store', () => ({ useTokenStore: { getState: () => ({ updateTokenCounts: tokenCounts }) } }));

type Json = Record<string, unknown>;
function document(description = 'Original', head = 'head-1'): Json {
  return { spec: 'chara_card_v3', spec_version: '3.0', opaque_root: { preserved: true },
    data: { name: 'Character', description, tags: [], extensions: { vendor: { kept: true },
      foundry: { local: { retained: true }, lineage: { revisionHash: head } } } } };
}
function stamped(input: Json, head: string): Json {
  const result = structuredClone(input);
  const data = result.data as Json;
  const extensions = data.extensions as Json;
  const foundry = extensions.foundry as Json;
  foundry.lineage = { revisionHash: head };
  return result;
}
function revision(id: string, input = document(), assets: { path: string; assetId: string }[] = [], sequence = 1) {
  return { id, sequence, document: input, assets, createdAt: `2026-10-13T12:00:0${sequence}.000Z` };
}
function opened(id: string, input = document()) {
  return { card: { id, createdAt: '2026-10-13T12:00:00.000Z', forkedFromRevisionId: null }, revision: revision('head-1', input) };
}
function data(card: Card | null): Json { return (card!.data as unknown as Json).data as Json; }
function lineage(card: Card | null) { return ((data(card).extensions as Json).foundry as Json).lineage; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('native editor Save lifecycle', () => {
  let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  beforeEach(() => {
    configureUnityHost({ workspaceId: 'save-tests' });
    useCardStore.getState().setCurrentCard(null);
    useCardStore.setState({ isSaving: false });
    vi.clearAllMocks();
    fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
  });
  afterEach(() => {
    useCardStore.getState().setCurrentCard(null);
    useCardStore.setState({ isSaving: false });
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  async function load(id = 'saved-card') {
    fetcher.mockResolvedValueOnce(Response.json(opened(id)));
    await useCardStore.getState().loadCard(id);
    return useCardStore.getState().currentCard!;
  }
  function posts() { return fetcher.mock.calls.filter(([, options]) => options?.method === 'POST'); }

  it.each(['updateCardData', 'updateCardFields'] as const)('preserves opaque wrapped CCv2 envelope fields through %s', (method) => {
    const wrapped = { spec: 'chara_card_v2', spec_version: '2.0', opaque_root: { keep: [null, 7] },
      data: { name: 'V2', description: 'Original', extensions: { vendor: { keep: true } } } };
    useCardStore.getState().setCurrentCard({ meta: { id: 'v2', name: 'V2', spec: 'v2', tags: [], createdAt: '', updatedAt: '' },
      data: wrapped as unknown as Card['data'] });
    if (method === 'updateCardData') useCardStore.getState().updateCardData({ description: 'Edited' });
    else useCardStore.getState().updateCardFields({ description: 'Edited' });
    expect(useCardStore.getState().currentCard?.data).toEqual({ ...wrapped, data: { ...wrapped.data, description: 'Edited' } });
    expect(posts()).toEqual([]);
  });

  it('keeps typing and portrait changes local until explicit Save, with no server autosave timer', async () => {
    vi.useFakeTimers();
    const original = await load();
    expect(getDraft).toHaveBeenCalledWith(original.meta.id);
    useCardStore.getState().updateCardFields({ description: 'Typed locally' });
    fetcher.mockResolvedValueOnce(Response.json({ assets: [] }));
    await editorAssets.setPortrait(useCardStore.getState().currentCard!, new File(['portrait'], 'portrait.png', { type: 'image/png' }));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(posts()).toEqual([]);
    expect(useCardStore.getState().autoSaveTimeout).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(saveDraft).toHaveBeenCalledWith(original.meta.id, useCardStore.getState().currentCard);
    expect(editorAssets.hasChanges(useCardStore.getState().currentCard!)).toBe(true);

    fetcher.mockImplementationOnce(async (_path, options) => {
      const input = JSON.parse((options!.body as FormData).get('input') as string) as { document: Json };
      return Response.json(revision('head-2', stamped(input.document, 'head-2'), [{ path: 'portrait', assetId: 'portrait-asset' }], 2));
    });
    await useCardStore.getState().saveCard();
    expect(posts()).toHaveLength(1);
    expect(posts()[0]![0]).toBe('/api/workspaces/save-tests/cards/saved-card/asset-revisions');
    expect(useCardStore.getState().isDirty).toBe(false);
    expect(editorAssets.hasChanges(useCardStore.getState().currentCard!)).toBe(false);
    expect(deleteDraft).toHaveBeenCalledWith(original.meta.id);
  });

  it('refreshes returned lineage and revision head so a second Save sends the accepted revision', async () => {
    await load();
    useCardStore.getState().updateCardFields({ description: 'First edit' });
    fetcher.mockImplementationOnce(async (_path, options) => {
      const input = JSON.parse(options!.body as string) as { expectedHead: string; document: Json };
      expect(input.expectedHead).toBe('head-1');
      return Response.json(revision('head-2', stamped(input.document, 'head-2'), [], 2));
    });
    await useCardStore.getState().saveCard();
    expect(lineage(useCardStore.getState().currentCard)).toEqual({ revisionHash: 'head-2' });
    expect(useCardStore.getState().isDirty).toBe(false);
    useCardStore.getState().updateCardFields({ description: 'Second edit' });
    fetcher.mockImplementationOnce(async (_path, options) => {
      const input = JSON.parse(options!.body as string) as { expectedHead: string; document: Json };
      expect(input.expectedHead).toBe('head-2');
      expect(((input.document.data as Json).extensions as Json).foundry).toMatchObject({ lineage: { revisionHash: 'head-2' } });
      return Response.json(revision('head-3', stamped(input.document, 'head-3'), [], 3));
    });
    await useCardStore.getState().saveCard();
    expect(lineage(useCardStore.getState().currentCard)).toEqual({ revisionHash: 'head-3' });
    expect(data(useCardStore.getState().currentCard).description).toBe('Second edit');
    expect(useCardStore.getState().isDirty).toBe(false);
  });

  it('saves an asset-only draft even when its prompt is unchanged', async () => {
    await load('asset-only');
    fetcher.mockResolvedValueOnce(Response.json({ assets: [] }));
    const card = useCardStore.getState().currentCard!;
    await editorAssets.add(card, new File(['attachment'], 'notes.txt', { type: 'text/plain' }));
    expect(useCardStore.getState().isDirty).toBe(false);
    expect(posts()).toEqual([]);
    fetcher.mockImplementationOnce(async (_path, options) => {
      const input = JSON.parse((options!.body as FormData).get('input') as string) as { document: Json };
      return Response.json(revision('asset-only-head-2', stamped(input.document, 'asset-only-head-2'), [{ path: 'declared/0', assetId: 'attachment' }], 2));
    });
    await useCardStore.getState().saveCard();
    expect(posts()).toHaveLength(1);
    expect(useCardStore.getState().currentCard!.meta.assetCount).toBe(1);
    expect(editorAssets.hasChanges(useCardStore.getState().currentCard!)).toBe(false);
  });

  it('does not create a duplicate card when Save is pressed again during the first request', async () => {
    await useCardStore.getState().createNewCard();
    const request = deferred<Response>();
    fetcher.mockReturnValueOnce(request.promise);
    const first = useCardStore.getState().saveCard();
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    await useCardStore.getState().saveCard();
    expect(posts()).toHaveLength(1);
    const input = JSON.parse((posts()[0]![1]!.body as FormData).get('input') as string) as { document: Json };
    const prepared = structuredClone(input.document);
    (prepared.data as Json).extensions = { foundry: { lineage: { revisionHash: 'created-head' } } };
    const saved = revision('created-head', prepared);
    request.resolve(Response.json({ cardId: 'created-once', revisionId: saved.id, revision: saved }));
    await first;
    expect(useCardStore.getState().currentCard!.meta.id).toBe('created-once');
    expect(useCardStore.getState().isDirty).toBe(false);
  });

  it.each(['saved', 'new', 'fork'] as const)('preserves and rebases text typed during a %s Save, including the assigned native id', async (kind) => {
    const original = await load('inflight-parent');
    if (kind === 'new') {
      await useCardStore.getState().createNewCard();
      // Preserve opaque/vendor data in this fixture while keeping a genuinely unsaved id.
      const fresh = structuredClone(original.data) as unknown as Json;
      delete (((fresh.data as Json).extensions as Json).foundry as Json).lineage;
      useCardStore.getState().setCurrentCard({ data: fresh as unknown as Card['data'], meta: { ...original.meta, id: '' } });
    } else if (kind === 'fork') {
      useCardStore.getState().setCurrentCard({ ...original, meta: { ...original.meta, id: '', forkOf: original.meta.id } });
    }
    useCardStore.getState().updateCardFields({ description: 'Submitted text' });
    const request = deferred<Response>();
    let submitted: Json | undefined;
    fetcher.mockImplementation(async (path, options) => {
      if (String(path).includes('/assets?')) return Response.json({ assets: [] });
      if (options?.method === 'POST') {
        const input = options.body instanceof FormData
          ? JSON.parse(options.body.get('input') as string) as { document: Json }
          : JSON.parse(options!.body as string) as { document: Json };
        submitted = input.document;
        return request.promise;
      }
      throw new Error(`Unexpected request ${String(path)}`);
    });
    const pending = useCardStore.getState().saveCard();
    await vi.waitFor(() => expect(submitted).toBeDefined());
    useCardStore.getState().updateCardFields({ description: 'Typed while saving' });
    useCardStore.getState().updateExtensions({ vendor: { kept: true, typedDuringSave: true } });
    const id = kind === 'saved' ? original.meta.id : `${kind}-created-card`;
    const saved = revision('inflight-head-2', stamped(submitted!, 'inflight-head-2'), [], 2);
    request.resolve(Response.json(kind === 'saved' ? saved : { cardId: id, revisionId: saved.id, revision: saved }));
    await pending;
    const current = useCardStore.getState().currentCard!;
    expect(current.meta.id).toBe(id);
    expect(current.meta.forkOf).toBeUndefined();
    expect(data(current).description).toBe('Typed while saving');
    expect((data(current).extensions as Json).vendor).toEqual({ kept: true, typedDuringSave: true });
    expect((current.data as unknown as Json).opaque_root).toEqual({ preserved: true });
    expect(lineage(current)).toEqual({ revisionHash: 'inflight-head-2' });
    expect(useCardStore.getState().isDirty).toBe(true);
    expect(useCardStore.getState().isSaving).toBe(false);
    expect(saveDraft).toHaveBeenLastCalledWith(id, current);
    expect(deleteDraft).not.toHaveBeenCalled();

    fetcher.mockImplementationOnce(async (path, options) => {
      expect(path).toBe(`/api/workspaces/save-tests/cards/${id}/revisions`);
      const input = JSON.parse(options!.body as string) as { expectedHead: string; document: Json };
      expect(input.expectedHead).toBe('inflight-head-2');
      expect((input.document.data as Json).description).toBe('Typed while saving');
      expect((((input.document.data as Json).extensions as Json).foundry as Json).lineage).toEqual({ revisionHash: 'inflight-head-2' });
      return Response.json(revision('inflight-head-3', stamped(input.document, 'inflight-head-3'), [], 3));
    });
    await useCardStore.getState().saveCard();
    expect(useCardStore.getState().currentCard!.meta.id).toBe(id);
    expect(useCardStore.getState().isDirty).toBe(false);
    expect(deleteDraft).toHaveBeenCalledWith(id);
  });

  it('preserves the dirty document and staged asset bytes after a failed Save, allowing retry', async () => {
    const original = await load('failed-save');
    useCardStore.getState().updateCardFields({ description: 'Keep my changes' });
    fetcher.mockResolvedValueOnce(Response.json({ assets: [] }));
    const file = new File(['attachment'], 'notes.txt', { type: 'text/plain' });
    await editorAssets.add(useCardStore.getState().currentCard!, file, { type: 'custom' });
    const pendingCard = useCardStore.getState().currentCard!;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fetcher.mockResolvedValueOnce(Response.json({ error: { message: 'Newer revision exists' } }, { status: 409 }));
    await expect(useCardStore.getState().saveCard()).rejects.toThrow('Newer revision exists');
    expect(useCardStore.getState().currentCard).toBe(pendingCard);
    expect(useCardStore.getState().isDirty).toBe(true);
    expect(useCardStore.getState().isSaving).toBe(false);
    expect(editorAssets.hasChanges(pendingCard)).toBe(true);
    expect((await editorAssets.prepare(pendingCard)).uploads).toEqual([file]);
    expect(deleteDraft).not.toHaveBeenCalled();

    fetcher.mockImplementationOnce(async (_path, options) => {
      const input = JSON.parse((options!.body as FormData).get('input') as string) as { expectedHead: string; document: Json };
      expect(input.expectedHead).toBe('head-1');
      return Response.json(revision('retry-head-2', stamped(input.document, 'retry-head-2'), [{ path: 'declared/0', assetId: 'attachment' }], 2));
    });
    await useCardStore.getState().saveCard();
    expect(useCardStore.getState().currentCard!.meta.id).toBe(original.meta.id);
    expect(useCardStore.getState().isDirty).toBe(false);
    expect(editorAssets.hasChanges(useCardStore.getState().currentCard!)).toBe(false);
  });

  it('does not replace a different card opened while a Save is in flight', async () => {
    await load('first-card');
    useCardStore.getState().updateCardFields({ description: 'Saving the first card' });
    const request = deferred<Response>();
    fetcher.mockReturnValueOnce(request.promise);
    const pending = useCardStore.getState().saveCard();
    const submitted = JSON.parse(posts()[0]![1]!.body as string) as { document: Json };
    fetcher.mockResolvedValueOnce(Response.json(opened('second-card', document('Second card'))));
    await useCardStore.getState().loadCard('second-card');
    const second = useCardStore.getState().currentCard;
    request.resolve(Response.json(revision('first-head-2', stamped(submitted.document, 'first-head-2'), [], 2)));
    await pending;
    expect(useCardStore.getState().currentCard).toBe(second);
    expect(data(second).description).toBe('Second card');
    expect(useCardStore.getState().isDirty).toBe(false);
    expect(useCardStore.getState().isSaving).toBe(false);
    expect(deleteDraft).not.toHaveBeenCalled();
  });
});
