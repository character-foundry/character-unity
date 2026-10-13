import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureUnityHost } from './config';
import { useCardStore } from '../store/card-store';
import type { Card } from '../lib/types';

const { tokenCounts, saveLocalCard, saveLocalImage, saveLocalAsset } = vi.hoisted(() => ({
  tokenCounts: vi.fn(), saveLocalCard: vi.fn(), saveLocalImage: vi.fn(), saveLocalAsset: vi.fn(),
}));
vi.mock('../store/token-store', () => ({ useTokenStore: { getState: () => ({ updateTokenCounts: tokenCounts }) } }));
vi.mock('../lib/db', () => ({ localDB: { saveCard: saveLocalCard, saveImage: saveLocalImage, saveAsset: saveLocalAsset } }));

const existing: Card = {
  meta: { id: 'existing-card', name: 'My work', spec: 'v3', tags: [], createdAt: '', updatedAt: '' },
  data: { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'My work' } } as Card['data'],
};

describe('editor import state', () => {
  beforeEach(() => {
    configureUnityHost({ workspaceId: 'store-import-tests' });
    useCardStore.setState({ currentCard: existing, isDirty: true, isSaving: false, autoSaveTimeout: null });
    vi.clearAllMocks();
  });
  afterEach(() => {
    useCardStore.setState({ currentCard: null, isDirty: false });
    vi.unstubAllGlobals();
  });

  it('preserves unsaved work when Foundry rejects an import and creates no local records', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(
      { error: { message: 'Unsupported card container' } }, { status: 400 },
    ));
    vi.stubGlobal('fetch', fetcher);

    await expect(useCardStore.getState().importCard(new File(['bad'], 'bad.charx'))).rejects.toThrow('Unsupported card container');

    expect(useCardStore.getState().currentCard).toBe(existing);
    expect(useCardStore.getState().isDirty).toBe(true);
    expect(tokenCounts).not.toHaveBeenCalled();
    expect(saveLocalCard).not.toHaveBeenCalled();
    expect(saveLocalImage).not.toHaveBeenCalled();
    expect(saveLocalAsset).not.toHaveBeenCalled();
  });

  it('activates only the opened native card after a successful import', async () => {
    const document = { spec: 'chara_card_v3', spec_version: '3.0', opaque_root: { preserved: true }, data: { name: 'Imported', tags: [] } };
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ card: { id: 'native-card' } }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ card: { id: 'native-card', createdAt: '', forkedFromRevisionId: null },
        revision: { id: 'native-head', document, assets: [], createdAt: '' } })));

    expect(await useCardStore.getState().importCard(new File(['original'], 'original.json'))).toBe('native-card');

    expect(useCardStore.getState().currentCard?.data).toEqual(document);
    expect(useCardStore.getState().isDirty).toBe(false);
    expect(tokenCounts).toHaveBeenCalledWith(useCardStore.getState().currentCard);
    expect(saveLocalCard).not.toHaveBeenCalled();
    expect(saveLocalImage).not.toHaveBeenCalled();
    expect(saveLocalAsset).not.toHaveBeenCalled();
  });
});
