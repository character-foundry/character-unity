import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Card, CCv2Data, CCv3Data, CardMeta } from '../lib/types';
import type { CharacterBook, CCv2Wrapped } from '@character-foundry/character-foundry/schemas';
import type { UnityApiClient } from '../lib/api';
import { extractCardData } from '../lib/card-utils';
import type { TokenStore } from './token-store';
import type { EditorAssetService } from '../unity/assets';
import type { DraftRecovery } from '../unity/recovery';
import { useEditorSession } from '../unity/context';
import { importCharacterFile, importCharacterUrl } from '../unity/import';
import { isV3Card, isV2Card, isWrappedV2, getInnerData, type CardFields } from '../lib/card-type-guards';
import type { CardExtensions } from '../lib/extension-types';

export { extractCardData };

export interface CardStore {
  currentCard: Card | null;
  isDirty: boolean;
  isSaving: boolean;
  isRestoring: boolean;
  selectionVersion: number;
  autoSaveTimeout: ReturnType<typeof setTimeout> | null;
  setCurrentCard(card: Card | null): void;
  updateCardData(updates: Partial<CCv2Data | CCv3Data>): void;
  updateCardMeta(updates: Partial<CardMeta>): void;
  saveCard(): Promise<void>;
  debouncedAutoSave(): void;
  cancelPending(): void;
  loadCard(id: string): Promise<void>;
  createNewCard(): Promise<void>;
  createNewLorebook(): Promise<void>;
  importCard(file: File): Promise<string | null>;
  importVoxtaPackage(file: File): Promise<string | null>;
  importCardFromURL(url: string): Promise<string | null>;
  exportCard(format: 'json' | 'png' | 'charx' | 'voxta'): Promise<void>;
  convertSpec(mode: 'v2' | 'v3'): void;
  updateCardFields(fields: Partial<CardFields>): void;
  updateExtensions(extensions: Partial<CardExtensions>): void;
  updateCharacterBook(book: Partial<CharacterBook>): void;
  setExtension<K extends keyof CardExtensions>(key: K, value: CardExtensions[K]): void;
}

export interface CardStoreDependencies {
  api: UnityApiClient;
  assets: EditorAssetService;
  tokens: StoreApi<TokenStore>;
  recovery: DraftRecovery;
  isDisposed(): boolean;
  signal: AbortSignal;
}

function blankCard(lorebook = false): Card {
  const now = new Date().toISOString();
  const name = lorebook ? 'New Lorebook' : 'New Character';
  const tags = lorebook ? ['LORE'] : [];
  return {
    meta: { id: '', name, spec: lorebook ? 'lorebook' : 'v3', tags, createdAt: now, updatedAt: now },
    data: { spec: 'chara_card_v3', spec_version: '3.0', data: {
      name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '', creator: '',
      character_version: '1.0', tags, system_prompt: '', post_history_instructions: '', alternate_greetings: [], group_only_greetings: [],
      ...(lorebook ? { character_book: { name, description: '', scan_depth: 100, token_budget: 500,
        recursive_scanning: false, extensions: {}, entries: [] } } : {}),
    } } as CCv3Data,
  };
}

/** State and asynchronous work belong to one editor, not to the mounted page. */
export function createCardStore({ api, assets, tokens, recovery, isDisposed, signal }: CardStoreDependencies): StoreApi<CardStore> {
  let loading: AbortController | null = null;
  let saving: AbortController | null = null;
  const inactive = () => signal.aborted || isDisposed();
  return createStore<CardStore>((set, get) => {
    const updateTokens = (card: Card | null) => { void tokens.getState().updateTokenCounts(card); };
    const recover = (card: Card) => {
      if (card.meta.id && !inactive()) void recovery.save(card.meta.id, card, api.headRevision(card.meta.id)).catch(console.warn);
    };
    const mutate = (card: Card) => {
      if (inactive()) return;
      set({ currentCard: card, isDirty: true });
      recover(card); updateTokens(card);
    };
    const beginSelection = () => {
      loading?.abort(); saving?.abort();
      api.select();
      const timeout = get().autoSaveTimeout;
      if (timeout) clearTimeout(timeout);
      const selection = get().selectionVersion + 1;
      set({ selectionVersion: selection, isSaving: false, isRestoring: false, autoSaveTimeout: null });
      return selection;
    };
    const selected = (selection: number) => !inactive() && get().selectionVersion === selection;
    const importCard = async (source: File | string): Promise<string | null> => {
      if (inactive()) return null;
      const selection = beginSelection();
      const controller = new AbortController(); loading = controller;
      const options = { signal: AbortSignal.any([signal, controller.signal]) };
      try {
        const card = typeof source === 'string' ? await importCharacterUrl(api, source, options) : await importCharacterFile(api, source, options);
        if (!selected(selection)) return null;
        get().setCurrentCard(card);
        return card.meta.id;
      } catch (error) {
        if (!selected(selection) || controller.signal.aborted) return null;
        throw error;
      } finally { if (loading === controller) loading = null; }
    };
    return {
      currentCard: null, isDirty: false, isSaving: false, isRestoring: false, selectionVersion: 0, autoSaveTimeout: null,
      setCurrentCard(card) {
        if (inactive()) return;
        beginSelection(); assets.reset();
        set({ currentCard: card, isDirty: false });
        updateTokens(card);
      },
      updateCardData(updates) {
        const current = get().currentCard;
        if (!current) return;
        const document = current.data as unknown as Record<string, unknown>;
        const wrapped = typeof document.data === 'object' && document.data !== null && 'spec' in document;
        const changes = updates as unknown as Record<string, unknown>;
        const data = wrapped ? { ...document, ...('data' in changes ? changes : {}),
          data: { ...(document.data as Record<string, unknown>), ...((changes.data as Record<string, unknown> | undefined) ?? changes) } } : { ...document, ...changes };
        mutate({ ...current, data: data as unknown as Card['data'] });
      },
      updateCardMeta(updates) {
        const current = get().currentCard;
        if (current) mutate({ ...current, meta: { ...current.meta, ...updates } });
      },
      // Explicit Save is the only operation that writes an immutable server revision.
      debouncedAutoSave() {
        const timeout = get().autoSaveTimeout;
        if (timeout) clearTimeout(timeout);
        if (!inactive()) set({ autoSaveTimeout: null });
      },
      cancelPending() { beginSelection(); loading = null; saving = null; },
      async saveCard() {
        const { currentCard, isDirty, isSaving, isRestoring, selectionVersion } = get();
        if (inactive() || !currentCard || isSaving || isRestoring || (currentCard.meta.id && !isDirty && !assets.hasChanges(currentCard))) return;
        const controller = new AbortController(); saving = controller;
        const options = { signal: AbortSignal.any([signal, controller.signal]) };
        set({ isSaving: true });
        try {
          const result = currentCard.meta.id ? await api.updateCard(currentCard.meta.id, currentCard, options) : await api.createCard(currentCard, options);
          if (!selected(selectionVersion) || controller.signal.aborted) return;
          if (result.error || !result.data) throw new Error(result.error ?? 'Save returned no card');
          const saved = result.data, latest = get().currentCard;
          if (!latest || latest.meta.id !== currentCard.meta.id || latest.meta.forkOf !== currentCard.meta.forkOf) return;
          const changedDuringSave = latest !== currentCard;
          let merged = saved;
          if (changedDuringSave) {
            const data = structuredClone(latest.data) as unknown as Record<string, unknown>;
            const inner = data.data as Record<string, unknown>;
            const savedInner = (saved.data as unknown as { data: Record<string, unknown> }).data;
            if (Object.hasOwn(savedInner, 'assets')) inner.assets = structuredClone(savedInner.assets);
            else delete inner.assets;
            const extensions = { ...(inner.extensions as Record<string, unknown> | undefined) };
            const savedExtensions = savedInner.extensions as Record<string, unknown> | undefined;
            const foundry = { ...(extensions.foundry as Record<string, unknown> | undefined) };
            const savedFoundry = savedExtensions?.foundry as Record<string, unknown> | undefined;
            if (savedFoundry?.lineage !== undefined) foundry.lineage = savedFoundry.lineage;
            else delete foundry.lineage;
            extensions.foundry = foundry; inner.extensions = extensions;
            merged = { data: data as unknown as Card['data'], meta: { ...latest.meta, id: saved.meta.id, forkOf: undefined,
              archiveReference: saved.meta.archiveReference, favorite: saved.meta.favorite,
              updatedAt: saved.meta.updatedAt, createdAt: saved.meta.createdAt } };
          }
          const dirty = changedDuringSave || assets.hasChanges(merged);
          set({ currentCard: merged, isDirty: dirty }); updateTokens(merged);
          if (dirty) await recovery.save(saved.meta.id, merged, api.headRevision(saved.meta.id)).catch(console.warn);
          if (currentCard.meta.id && (!dirty || currentCard.meta.id !== saved.meta.id)) await recovery.remove(currentCard.meta.id).catch(console.warn);
        } catch (error) {
          if (selected(selectionVersion) && !controller.signal.aborted) throw error;
        } finally {
          if (saving === controller) {
            saving = null;
            if (selected(selectionVersion)) set({ isSaving: false });
          }
        }
      },
      async loadCard(id) {
        if (inactive()) return;
        const selection = beginSelection();
        const controller = new AbortController(); loading = controller;
        try {
          const result = await api.getCard(id, { signal: AbortSignal.any([signal, controller.signal]) });
          if (!selected(selection) || controller.signal.aborted) return;
          if (result.error || !result.data) throw new Error(result.error ?? 'The card could not be opened');
          get().setCurrentCard(result.data);
        } finally { if (loading === controller) loading = null; }
      },
      async createNewCard() { get().setCurrentCard(blankCard()); if (!inactive()) set({ isDirty: true }); },
      async createNewLorebook() { get().setCurrentCard(blankCard(true)); if (!inactive()) set({ isDirty: true }); },
      importCard,
      importVoxtaPackage: importCard,
      importCardFromURL: importCard,
      async exportCard(format) {
        const { currentCard, selectionVersion } = get();
        if (inactive() || !currentCard?.meta.id) return;
        await get().saveCard();
        if (!selected(selectionVersion)) return;
        const saved = get().currentCard;
        if (!saved?.meta.id) return;
        const { data, error } = await api.exportCard(saved.meta.id, format, { signal });
        if (!selected(selectionVersion)) return;
        if (error) throw new Error(error);
        if (!data) throw new Error('Export returned no file');
        const url = URL.createObjectURL(data);
        try {
          const anchor = document.createElement('a'); anchor.href = url;
          anchor.download = `${saved.meta.name}.${format === 'voxta' ? 'voxpkg' : format}`;
          anchor.click();
        } finally { URL.revokeObjectURL(url); }
      },
      updateCardFields(fields) {
        const current = get().currentCard;
        if (!current) return;
        let data: CCv2Data | CCv3Data;
        if (isV3Card(current)) data = { ...current.data, data: { ...current.data.data, ...fields } };
        else if (isV2Card(current) && isWrappedV2(current.data)) {
          const wrapped = current.data as CCv2Wrapped;
          data = { ...wrapped, data: { ...wrapped.data, ...fields } } as unknown as CCv2Data;
        } else data = { ...current.data, ...fields } as CCv2Data;
        mutate({ ...current, data });
      },
      updateExtensions(extensions) {
        const current = get().currentCard;
        if (current) get().updateCardFields({ extensions: { ...(getInnerData(current).extensions || {}), ...extensions } });
      },
      updateCharacterBook(book) {
        const current = get().currentCard;
        if (current) get().updateCardFields({ character_book: { ...(getInnerData(current).character_book || { entries: [] }), ...book } as CharacterBook });
      },
      setExtension(key, value) {
        const current = get().currentCard;
        if (current) get().updateCardFields({ extensions: { ...(getInnerData(current).extensions || {}), [key]: value } });
      },
      convertSpec(mode) {
        const current = get().currentCard;
        if (!current || current.meta.spec === mode) return;
        const document = current.data as unknown as Record<string, unknown>;
        const wrapped = typeof document.data === 'object' && document.data !== null && 'spec' in document;
        // Preserve opaque root/inner fields when changing the schema envelope.
        const data = { ...(wrapped ? document : {}), spec: mode === 'v3' ? 'chara_card_v3' : 'chara_card_v2',
          spec_version: mode === 'v3' ? '3.0' : '2.0', data: structuredClone(wrapped ? document.data : document) };
        mutate({ ...current, meta: { ...current.meta, spec: mode }, data: data as unknown as Card['data'] });
      },
    };
  });
}

export function useCardStore(): CardStore;
export function useCardStore<T>(selector: (state: CardStore) => T): T;
export function useCardStore<T>(selector?: (state: CardStore) => T): T | CardStore {
  return useStore(useEditorSession().cards, (state): T | CardStore => selector ? selector(state) : state);
}
