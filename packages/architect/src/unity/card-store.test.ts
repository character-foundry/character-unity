import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card } from '../lib/types';
import { createCardStore } from '../store/card-store';
import { createTokenStore } from '../store/token-store';
import { UnityApiClient } from '../lib/api';
import type { DraftRecovery } from './recovery';
import type { EditorAssetService } from './assets';

const saveDraft = vi.fn(async (_id: string, _card: Card, _head?: string) => { void _id; void _card; void _head; });
const deleteDraft = vi.fn(async (_id: string) => { void _id; });
const tokenCounts = vi.fn(async (_card: Card | null) => { void _card; });

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
  let cards: ReturnType<typeof createCardStore>;
  let editorAssets: EditorAssetService;
  let api: UnityApiClient;
  let controller: AbortController;
  beforeEach(() => {
    vi.clearAllMocks();
    controller = new AbortController();
    api = new UnityApiClient({ workspaceId: 'save-tests' }, { signal: controller.signal });
    editorAssets = api.assets;
    const isDisposed = () => controller.signal.aborted;
    const tokens = createTokenStore({ api, isDisposed, signal: controller.signal });
    vi.spyOn(tokens.getState(), 'updateTokenCounts').mockImplementation(tokenCounts);
    const recovery: DraftRecovery = { load: async () => null, save: saveDraft, remove: deleteDraft, flush: async () => undefined };
    cards = createCardStore({ api, assets: editorAssets, tokens, recovery, isDisposed, signal: controller.signal });
    fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
  });
  afterEach(() => {
    controller.abort(); cards.getState().cancelPending(); api.dispose();
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  async function load(id = 'saved-card') {
    fetcher.mockResolvedValueOnce(Response.json(opened(id)));
    await cards.getState().loadCard(id);
    return cards.getState().currentCard!;
  }
  function posts() { return fetcher.mock.calls.filter(([, options]) => options?.method === 'POST'); }

  function another(workspaceId: string) {
    const client = new UnityApiClient({ workspaceId });
    const signal = new AbortController().signal;
    const tokens = createTokenStore({ api: client, signal, isDisposed: () => false });
    vi.spyOn(tokens.getState(), 'updateTokenCounts').mockImplementation(tokenCounts);
    const recovery: DraftRecovery = { load: async () => null, save: saveDraft, remove: deleteDraft, flush: async () => undefined };
    const store = createCardStore({ api: client, assets: client.assets, tokens, recovery, signal, isDisposed: () => false });
    return { client, store };
  }

  it.each(['updateCardData', 'updateCardFields'] as const)('preserves opaque wrapped CCv2 envelope fields through %s', (method) => {
    const wrapped = { spec: 'chara_card_v2', spec_version: '2.0', opaque_root: { keep: [null, 7] },
      data: { name: 'V2', description: 'Original', extensions: { vendor: { keep: true } } } };
    cards.getState().setCurrentCard({ meta: { id: 'v2', name: 'V2', spec: 'v2', tags: [], createdAt: '', updatedAt: '' },
      data: wrapped as unknown as Card['data'] });
    if (method === 'updateCardData') cards.getState().updateCardData({ description: 'Edited' });
    else cards.getState().updateCardFields({ description: 'Edited' });
    expect(cards.getState().currentCard?.data).toEqual({ ...wrapped, data: { ...wrapped.data, description: 'Edited' } });
    expect(posts()).toEqual([]);
  });

  it('keeps typing and portrait changes local until explicit Save, with no server autosave timer', async () => {
    vi.useFakeTimers();
    const original = await load();
    cards.getState().updateCardFields({ description: 'Typed locally' });
    fetcher.mockResolvedValueOnce(Response.json({ assets: [] }));
    await editorAssets.setPortrait(cards.getState().currentCard!, new File(['portrait'], 'portrait.png', { type: 'image/png' }));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(posts()).toEqual([]);
    expect(cards.getState().autoSaveTimeout).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(saveDraft).toHaveBeenCalledWith(original.meta.id, cards.getState().currentCard, 'head-1');
    expect(editorAssets.hasChanges(cards.getState().currentCard!)).toBe(true);

    fetcher.mockImplementationOnce(async (_path, options) => {
      const input = JSON.parse((options!.body as FormData).get('input') as string) as { document: Json };
      return Response.json(revision('head-2', stamped(input.document, 'head-2'), [{ path: 'portrait', assetId: 'portrait-asset' }], 2));
    });
    await cards.getState().saveCard();
    expect(posts()).toHaveLength(1);
    expect(posts()[0]![0]).toBe('/api/workspaces/save-tests/cards/saved-card/asset-revisions');
    expect(cards.getState().isDirty).toBe(false);
    expect(editorAssets.hasChanges(cards.getState().currentCard!)).toBe(false);
    expect(deleteDraft).toHaveBeenCalledWith(original.meta.id);
  });

  it('refreshes returned lineage and revision head so a second Save sends the accepted revision', async () => {
    await load();
    cards.getState().updateCardFields({ description: 'First edit' });
    fetcher.mockImplementationOnce(async (_path, options) => {
      const input = JSON.parse(options!.body as string) as { expectedHead: string; document: Json };
      expect(input.expectedHead).toBe('head-1');
      return Response.json(revision('head-2', stamped(input.document, 'head-2'), [], 2));
    });
    await cards.getState().saveCard();
    expect(lineage(cards.getState().currentCard)).toEqual({ revisionHash: 'head-2' });
    expect(cards.getState().isDirty).toBe(false);
    cards.getState().updateCardFields({ description: 'Second edit' });
    fetcher.mockImplementationOnce(async (_path, options) => {
      const input = JSON.parse(options!.body as string) as { expectedHead: string; document: Json };
      expect(input.expectedHead).toBe('head-2');
      expect(((input.document.data as Json).extensions as Json).foundry).toMatchObject({ lineage: { revisionHash: 'head-2' } });
      return Response.json(revision('head-3', stamped(input.document, 'head-3'), [], 3));
    });
    await cards.getState().saveCard();
    expect(lineage(cards.getState().currentCard)).toEqual({ revisionHash: 'head-3' });
    expect(data(cards.getState().currentCard).description).toBe('Second edit');
    expect(cards.getState().isDirty).toBe(false);
  });

  it('saves an asset-only draft even when its prompt is unchanged', async () => {
    await load('asset-only');
    fetcher.mockResolvedValueOnce(Response.json({ assets: [] }));
    const card = cards.getState().currentCard!;
    await editorAssets.add(card, new File(['attachment'], 'notes.txt', { type: 'text/plain' }));
    expect(cards.getState().isDirty).toBe(false);
    expect(posts()).toEqual([]);
    fetcher.mockImplementationOnce(async (_path, options) => {
      const input = JSON.parse((options!.body as FormData).get('input') as string) as { document: Json };
      return Response.json(revision('asset-only-head-2', stamped(input.document, 'asset-only-head-2'), [{ path: 'declared/0', assetId: 'attachment' }], 2));
    });
    await cards.getState().saveCard();
    expect(posts()).toHaveLength(1);
    expect(cards.getState().currentCard!.meta.assetCount).toBe(1);
    expect(editorAssets.hasChanges(cards.getState().currentCard!)).toBe(false);
  });

  it('does not create a duplicate card when Save is pressed again during the first request', async () => {
    await cards.getState().createNewCard();
    const request = deferred<Response>();
    fetcher.mockReturnValueOnce(request.promise);
    const first = cards.getState().saveCard();
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    await cards.getState().saveCard();
    expect(posts()).toHaveLength(1);
    const input = JSON.parse((posts()[0]![1]!.body as FormData).get('input') as string) as { document: Json };
    const prepared = structuredClone(input.document);
    (prepared.data as Json).extensions = { foundry: { lineage: { revisionHash: 'created-head' } } };
    const saved = revision('created-head', prepared);
    request.resolve(Response.json({ cardId: 'created-once', revisionId: saved.id, revision: saved }));
    await first;
    expect(cards.getState().currentCard!.meta.id).toBe('created-once');
    expect(cards.getState().isDirty).toBe(false);
  });

  it.each(['saved', 'new', 'fork'] as const)('preserves and rebases text typed during a %s Save, including the assigned native id', async (kind) => {
    const original = await load('inflight-parent');
    if (kind === 'new') {
      await cards.getState().createNewCard();
      // Preserve opaque/vendor data in this fixture while keeping a genuinely unsaved id.
      const fresh = structuredClone(original.data) as unknown as Json;
      delete (((fresh.data as Json).extensions as Json).foundry as Json).lineage;
      cards.getState().setCurrentCard({ data: fresh as unknown as Card['data'], meta: { ...original.meta, id: '' } });
    } else if (kind === 'fork') {
      cards.getState().setCurrentCard({ ...original, meta: { ...original.meta, id: '', forkOf: original.meta.id } });
    }
    cards.getState().updateCardFields({ description: 'Submitted text' });
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
    const pending = cards.getState().saveCard();
    await vi.waitFor(() => expect(submitted).toBeDefined());
    cards.getState().updateCardFields({ description: 'Typed while saving' });
    cards.getState().updateExtensions({ vendor: { kept: true, typedDuringSave: true } });
    const id = kind === 'saved' ? original.meta.id : `${kind}-created-card`;
    const saved = revision('inflight-head-2', stamped(submitted!, 'inflight-head-2'), [], 2);
    request.resolve(Response.json(kind === 'saved' ? saved : { cardId: id, revisionId: saved.id, revision: saved }));
    await pending;
    const current = cards.getState().currentCard!;
    expect(current.meta.id).toBe(id);
    expect(current.meta.forkOf).toBeUndefined();
    expect(data(current).description).toBe('Typed while saving');
    expect((data(current).extensions as Json).vendor).toEqual({ kept: true, typedDuringSave: true });
    expect((current.data as unknown as Json).opaque_root).toEqual({ preserved: true });
    expect(lineage(current)).toEqual({ revisionHash: 'inflight-head-2' });
    expect(cards.getState().isDirty).toBe(true);
    expect(cards.getState().isSaving).toBe(false);
    expect(saveDraft).toHaveBeenLastCalledWith(id, current, 'inflight-head-2');
    expect(deleteDraft).not.toHaveBeenCalled();

    fetcher.mockImplementationOnce(async (path, options) => {
      expect(path).toBe(`/api/workspaces/save-tests/cards/${id}/revisions`);
      const input = JSON.parse(options!.body as string) as { expectedHead: string; document: Json };
      expect(input.expectedHead).toBe('inflight-head-2');
      expect((input.document.data as Json).description).toBe('Typed while saving');
      expect((((input.document.data as Json).extensions as Json).foundry as Json).lineage).toEqual({ revisionHash: 'inflight-head-2' });
      return Response.json(revision('inflight-head-3', stamped(input.document, 'inflight-head-3'), [], 3));
    });
    await cards.getState().saveCard();
    expect(cards.getState().currentCard!.meta.id).toBe(id);
    expect(cards.getState().isDirty).toBe(false);
    expect(deleteDraft).toHaveBeenCalledWith(id);
  });

  it('preserves the dirty document and staged asset bytes after a failed Save, allowing retry', async () => {
    const original = await load('failed-save');
    cards.getState().updateCardFields({ description: 'Keep my changes' });
    fetcher.mockResolvedValueOnce(Response.json({ assets: [] }));
    const file = new File(['attachment'], 'notes.txt', { type: 'text/plain' });
    await editorAssets.add(cards.getState().currentCard!, file, { type: 'custom' });
    const pendingCard = cards.getState().currentCard!;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fetcher.mockResolvedValueOnce(Response.json({ error: { message: 'Newer revision exists' } }, { status: 409 }));
    await expect(cards.getState().saveCard()).rejects.toThrow('Newer revision exists');
    expect(cards.getState().currentCard).toBe(pendingCard);
    expect(cards.getState().isDirty).toBe(true);
    expect(cards.getState().isSaving).toBe(false);
    expect(editorAssets.hasChanges(pendingCard)).toBe(true);
    expect((await editorAssets.prepare(pendingCard)).uploads).toEqual([file]);
    expect(deleteDraft).not.toHaveBeenCalled();

    fetcher.mockImplementationOnce(async (_path, options) => {
      const input = JSON.parse((options!.body as FormData).get('input') as string) as { expectedHead: string; document: Json };
      expect(input.expectedHead).toBe('head-1');
      return Response.json(revision('retry-head-2', stamped(input.document, 'retry-head-2'), [{ path: 'declared/0', assetId: 'attachment' }], 2));
    });
    await cards.getState().saveCard();
    expect(cards.getState().currentCard!.meta.id).toBe(original.meta.id);
    expect(cards.getState().isDirty).toBe(false);
    expect(editorAssets.hasChanges(cards.getState().currentCard!)).toBe(false);
  });

  it('does not replace a different card opened while a Save is in flight', async () => {
    await load('first-card');
    cards.getState().updateCardFields({ description: 'Saving the first card' });
    const request = deferred<Response>();
    fetcher.mockReturnValueOnce(request.promise);
    const pending = cards.getState().saveCard();
    const submitted = JSON.parse(posts()[0]![1]!.body as string) as { document: Json };
    fetcher.mockResolvedValueOnce(Response.json(opened('second-card', document('Second card'))));
    await cards.getState().loadCard('second-card');
    const second = cards.getState().currentCard;
    request.resolve(Response.json(revision('first-head-2', stamped(submitted.document, 'first-head-2'), [], 2)));
    await pending;
    expect(cards.getState().currentCard).toBe(second);
    expect(data(second).description).toBe('Second card');
    expect(cards.getState().isDirty).toBe(false);
    expect(cards.getState().isSaving).toBe(false);
    expect(deleteDraft).not.toHaveBeenCalled();
  });

  it('accepts only the latest load of the same card when responses arrive in reverse order', async () => {
    const old = deferred<Response>();
    fetcher.mockReturnValueOnce(old.promise).mockResolvedValueOnce(Response.json({ ...opened('same-card', document('Newest')),
      revision: revision('newest-head', document('Newest')) }));
    const pending = cards.getState().loadCard('same-card');
    const firstSignal = fetcher.mock.calls[0]![1]!.signal;
    await cards.getState().loadCard('same-card');
    expect(firstSignal?.aborted).toBe(true);
    old.resolve(Response.json(opened('same-card', document('Outdated')))); await pending;
    expect(data(cards.getState().currentCard).description).toBe('Newest');
    expect(api.headRevision('same-card')).toBe('newest-head');
  });

  it('keeps same-id cards, asset bindings and expected heads independent across workspaces', async () => {
    const other = another('another-workspace');
    fetcher.mockResolvedValueOnce(Response.json(opened('shared-id', document('First workspace'))))
      .mockResolvedValueOnce(Response.json({ ...opened('shared-id', document('Other workspace')),
        revision: revision('other-head', document('Other workspace')) }));
    await cards.getState().loadCard('shared-id');
    await other.store.getState().loadCard('shared-id');
    cards.getState().updateCardFields({ description: 'Edited first workspace' });
    fetcher.mockResolvedValueOnce(Response.json({ assets: [] }));
    await editorAssets.add(cards.getState().currentCard!, new File(['first-only'], 'private.txt', { type: 'text/plain' }));
    expect(other.client.assets.hasChanges(other.store.getState().currentCard!)).toBe(false);
    fetcher.mockImplementationOnce(async (path, options) => {
      expect(path).toBe('/api/workspaces/save-tests/cards/shared-id/asset-revisions');
      expect(JSON.parse((options!.body as FormData).get('input') as string).expectedHead).toBe('head-1');
      return Response.json(revision('first-head-2', document('Edited first workspace'), [{ path: 'declared/0', assetId: 'first-asset' }]));
    });
    await cards.getState().saveCard();
    expect(other.client.headRevision('shared-id')).toBe('other-head');
    expect(data(other.store.getState().currentCard).description).toBe('Other workspace');
    expect(other.store.getState().isDirty).toBe(false);
    other.store.getState().setCurrentCard(null);
    expect(cards.getState().currentCard?.meta.id).toBe('shared-id');
    other.client.dispose();
  });

  it('does not let an older Save completion clear a newer selection’s saving state', async () => {
    await load('old-save');
    cards.getState().updateCardFields({ description: 'Old request' });
    const old = deferred<Response>(); fetcher.mockReturnValueOnce(old.promise);
    const first = cards.getState().saveCard();
    fetcher.mockResolvedValueOnce(Response.json(opened('new-save')));
    await cards.getState().loadCard('new-save');
    cards.getState().updateCardFields({ description: 'Current request' });
    const current = deferred<Response>(); fetcher.mockReturnValueOnce(current.promise);
    const second = cards.getState().saveCard();
    old.resolve(Response.json(revision('ignored-head'))); await first;
    expect(cards.getState().isSaving).toBe(true);
    expect(cards.getState().currentCard?.meta.id).toBe('new-save');
    current.resolve(Response.json(revision('accepted-head', document('Current request')))); await second;
    expect(cards.getState().isSaving).toBe(false);
    expect(api.headRevision('new-save')).toBe('accepted-head');
  });

  it('keeps a second editor’s stale expected head instead of silently overwriting a concurrent save', async () => {
    const other = another('save-tests');
    fetcher.mockImplementation(async () => Response.json(opened('concurrent-card')));
    await cards.getState().loadCard('concurrent-card');
    await other.store.getState().loadCard('concurrent-card');
    cards.getState().updateCardFields({ description: 'First editor accepted' });
    fetcher.mockImplementationOnce(async (_path, options) => {
      const input = JSON.parse(options!.body as string) as { document: Json };
      return Response.json(revision('concurrent-head-2', stamped(input.document, 'concurrent-head-2')));
    });
    await cards.getState().saveCard();
    other.store.getState().updateCardFields({ description: 'Second editor retained' });
    const retained = other.store.getState().currentCard;
    fetcher.mockImplementationOnce(async (_path, options) => {
      expect(JSON.parse(options!.body as string).expectedHead).toBe('head-1');
      return Response.json({ error: { message: 'A newer revision exists' } }, { status: 409 });
    });
    await expect(other.store.getState().saveCard()).rejects.toThrow('A newer revision exists');
    expect(other.store.getState().currentCard).toBe(retained);
    expect(other.store.getState().isDirty).toBe(true);
    expect(other.client.headRevision('concurrent-card')).toBe('head-1');
    expect(api.headRevision('concurrent-card')).toBe('concurrent-head-2');
    other.client.dispose();
  });

  it('ignores loads and mutations after session disposal', async () => {
    const response = deferred<Response>(); fetcher.mockReturnValueOnce(response.promise);
    const pending = cards.getState().loadCard('closed-card');
    controller.abort(); cards.getState().cancelPending();
    response.resolve(Response.json(opened('closed-card'))); await pending;
    await cards.getState().createNewCard();
    cards.getState().updateCardFields({ description: 'Ignored mutation' });
    expect(cards.getState().currentCard).toBeNull();
    expect(saveDraft).not.toHaveBeenCalled();
    expect(api.headRevision('closed-card')).toBeUndefined();
  });

  it('does not accept a saved result or delete recovery after session disposal', async () => {
    await load('closed-save');
    cards.getState().updateCardFields({ description: 'Keep recovered work' });
    const retained = cards.getState().currentCard;
    const response = deferred<Response>(); fetcher.mockReturnValueOnce(response.promise);
    const pending = cards.getState().saveCard();
    controller.abort(); cards.getState().cancelPending();
    response.resolve(Response.json(revision('too-late-head'))); await pending;
    expect(cards.getState().currentCard).toBe(retained);
    expect(cards.getState().isSaving).toBe(false);
    expect(deleteDraft).not.toHaveBeenCalled();
    expect(api.headRevision('closed-save')).toBe('head-1');
  });

  it('preserves the wrapped document and opaque fields through spec conversion', async () => {
    await load('convert');
    cards.getState().convertSpec('v2');
    expect(cards.getState().currentCard?.data).toMatchObject({ spec: 'chara_card_v2', spec_version: '2.0',
      opaque_root: { preserved: true }, data: { name: 'Character', description: 'Original' } });
    cards.getState().convertSpec('v3');
    expect(cards.getState().currentCard?.data).toEqual(document());
    expect(cards.getState().isDirty).toBe(true);
    expect(posts()).toEqual([]);
  });
});
