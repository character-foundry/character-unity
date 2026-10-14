import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCardStore } from '../store/card-store';
import { createTokenStore } from '../store/token-store';
import { UnityApiClient } from '../lib/api';
import type { DraftRecovery } from './recovery';
import type { Card } from '../lib/types';

const tokenCounts = vi.fn(async (_card: Card | null) => { void _card; });
const saveRecovery = vi.fn(async () => undefined);

const existing: Card = {
  meta: { id: 'existing-card', name: 'My work', spec: 'v3', tags: [], createdAt: '', updatedAt: '' },
  data: { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'My work' } } as Card['data'],
};

describe('editor import state', () => {
  let cards: ReturnType<typeof createCardStore>;
  let controller: AbortController;
  let api: UnityApiClient;
  beforeEach(() => {
    controller = new AbortController();
    api = new UnityApiClient({ workspaceId: 'store-import-tests' }, { signal: controller.signal });
    const isDisposed = () => controller.signal.aborted;
    const tokens = createTokenStore({ api, isDisposed, signal: controller.signal });
    vi.spyOn(tokens.getState(), 'updateTokenCounts').mockImplementation(tokenCounts);
    const recovery: DraftRecovery = { load: async () => null, save: saveRecovery, remove: async () => undefined, flush: async () => undefined };
    cards = createCardStore({ api, assets: api.assets, tokens, recovery, signal: controller.signal, isDisposed });
    cards.setState({ currentCard: existing, isDirty: true });
    vi.clearAllMocks();
  });
  afterEach(() => {
    controller.abort(); cards.getState().cancelPending(); api.dispose();
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  it('preserves unsaved work when Foundry rejects an import and creates no local records', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(
      { error: { message: 'Unsupported card container' } }, { status: 400 },
    ));
    vi.stubGlobal('fetch', fetcher);

    await expect(cards.getState().importCard(new File(['bad'], 'bad.charx'))).rejects.toThrow('Unsupported card container');

    expect(cards.getState().currentCard).toBe(existing);
    expect(cards.getState().isDirty).toBe(true);
    expect(tokenCounts).not.toHaveBeenCalled();
    expect(saveRecovery).not.toHaveBeenCalled();
  });

  it('activates only the opened native card without eagerly loading its tokenizer', async () => {
    const document = { spec: 'chara_card_v3', spec_version: '3.0', opaque_root: { preserved: true }, data: { name: 'Imported', tags: [] } };
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ card: { id: 'native-card' } }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ card: { id: 'native-card', createdAt: '', forkedFromRevisionId: null },
        revision: { id: 'native-head', document, assets: [], createdAt: '' } })));

    expect(await cards.getState().importCard(new File(['original'], 'original.json'))).toBe('native-card');

    expect(cards.getState().currentCard?.data).toEqual(document);
    expect(cards.getState().isDirty).toBe(false);
    expect(tokenCounts).not.toHaveBeenCalled();
    expect(saveRecovery).not.toHaveBeenCalled();
  });

  it('keeps already staged bytes when an attempted import fails', async () => {
    api.pinRevision(existing.meta.id, 'existing-head');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ assets: [] }))
      .mockResolvedValueOnce(Response.json({ error: { message: 'Rejected import' } }, { status: 400 })));
    const attachment = new File(['unsaved attachment'], 'notes.txt', { type: 'text/plain' });
    await api.assets.add(existing, attachment);
    await expect(cards.getState().importCard(new File(['invalid'], 'invalid.charx'))).rejects.toThrow('Rejected import');
    expect(cards.getState().currentCard).toBe(existing);
    expect((await api.assets.prepare(existing)).uploads).toEqual([attachment]);
    expect(api.assets.hasChanges(existing)).toBe(true);
  });

  it('does not activate a late import after another draft has been selected', async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
    vi.stubGlobal('fetch', fetcher);
    const pending = cards.getState().importCard(new File(['original'], 'original.json'));
    await cards.getState().createNewCard();
    cards.getState().updateCardFields({ name: 'Keep the selected draft' });
    const selected = cards.getState().currentCard;
    resolve(Response.json({ card: { id: 'late-import' } }, { status: 201 }));
    expect(await pending).toBeNull();
    expect(cards.getState().currentCard).toBe(selected);
    expect(cards.getState().isDirty).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
