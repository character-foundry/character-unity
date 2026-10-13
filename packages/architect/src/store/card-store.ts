import { create } from 'zustand';
import type { Card, CCv2Data, CCv3Data, CardMeta } from '../lib/types';
import type { CharacterBook, CCv2Wrapped } from '@character-foundry/character-foundry/schemas';
import { api } from '../lib/api';
import { localDB } from '../lib/db';
import { extractCardData } from '../lib/card-utils';
import { useTokenStore } from './token-store';
import { editorAssets } from '../unity/assets';
import { importCharacterFile, importCharacterUrl } from '../unity/import';
import { isV3Card, isV2Card, isWrappedV2, getInnerData, type CardFields } from '../lib/card-type-guards';
import type { CardExtensions } from '../lib/extension-types';

export { extractCardData };
let selectionVersion = 0;
export const editorSelection = () => selectionVersion;

interface CardStore {
  // Current card
  currentCard: Card | null;
  isDirty: boolean;
  isSaving: boolean;
  isRestoring: boolean;
  autoSaveTimeout: ReturnType<typeof setTimeout> | null;

  // Actions
  setCurrentCard: (card: Card | null) => void;
  updateCardData: (updates: Partial<CCv2Data | CCv3Data>) => void;
  updateCardMeta: (updates: Partial<CardMeta>) => void;
  saveCard: () => Promise<void>;
  debouncedAutoSave: () => void;
  loadCard: (id: string) => Promise<void>;
  createNewCard: () => Promise<void>;
  createNewLorebook: () => Promise<void>;
  importCard: (file: File) => Promise<string | null>;
  importVoxtaPackage: (file: File) => Promise<string | null>;
  importCardFromURL: (url: string) => Promise<string | null>;
  exportCard: (format: 'json' | 'png' | 'charx' | 'voxta') => Promise<void>;

  // Data mutations
  convertSpec: (mode: 'v2' | 'v3') => void;

  // Type-safe update helpers (use these instead of updateCardData with 'as any')
  updateCardFields: (fields: Partial<CardFields>) => void;
  updateExtensions: (extensions: Partial<CardExtensions>) => void;
  updateCharacterBook: (book: Partial<CharacterBook>) => void;
  setExtension: <K extends keyof CardExtensions>(key: K, value: CardExtensions[K]) => void;
}

export const useCardStore = create<CardStore>((set, get) => ({
  // Initial state
  currentCard: null,
  isDirty: false,
  isSaving: false,
  isRestoring: false,
  autoSaveTimeout: null,

  // Set current card
  setCurrentCard: (card) => {
    selectionVersion++;
    const timeout = get().autoSaveTimeout;
    if (timeout) clearTimeout(timeout);
    editorAssets.reset();
    set({ currentCard: card, isDirty: false, autoSaveTimeout: null });
    if (card) {
      useTokenStore.getState().updateTokenCounts(card);
    }
  },

  // Update card data
  updateCardData: (updates) => {
    const { currentCard } = get();
    if (!currentCard) return;

    // Deep merge to preserve spec/spec_version and nested data for both V2 and V3
    // V2 can be wrapped { spec, spec_version, data } or unwrapped (legacy)
    // V3 is always wrapped { spec, spec_version, data }
    let newData: Card['data'];

    if (currentCard.meta.spec === 'v3') {
      const v3Data = currentCard.data as CCv3Data;
      const updatesAsV3 = updates as Partial<CCv3Data>;

      newData = {
        ...v3Data,
        ...updatesAsV3,
        // Deep merge the nested data object
        data: {
          ...v3Data.data,
          ...(updatesAsV3.data || {}),
        },
      } as CCv3Data;
    } else {
      // V2 - handle both wrapped and unwrapped formats
      const v2Data = currentCard.data as unknown as Record<string, unknown>;
      const isWrapped = v2Data.spec === 'chara_card_v2' && 'data' in v2Data;

      if (isWrapped) {
        // Wrapped V2: preserve wrapper structure
        const updatesAsV2 = updates as unknown as Record<string, unknown>;
        newData = {
          ...v2Data,
          data: {
            ...(v2Data.data as Record<string, unknown>),
            ...((updatesAsV2.data as Record<string, unknown> | undefined) ?? updatesAsV2),
          },
        } as unknown as CCv2Data;
      } else {
        // Unwrapped/legacy V2
        newData = { ...v2Data, ...updates } as CCv2Data;
      }
    }

    const newCard = { ...currentCard, data: newData };

    set({ currentCard: newCard, isDirty: true });

    // Autosave to IndexedDB
    if (currentCard.meta.id) {
      localDB.saveDraft(currentCard.meta.id, newCard).catch(console.error);
    }

    // Update token counts
    useTokenStore.getState().updateTokenCounts(newCard);

    // Auto-save to server (debounced)
    if (currentCard.meta.id) {
      get().debouncedAutoSave();
    }
  },

  // Update card metadata
  updateCardMeta: (updates) => {
    const { currentCard } = get();
    if (!currentCard) return;

    const newMeta = { ...currentCard.meta, ...updates };
    const newCard = { ...currentCard, meta: newMeta };

    set({ currentCard: newCard, isDirty: true });

    // Autosave to IndexedDB
    if (currentCard.meta.id) {
      localDB.saveDraft(currentCard.meta.id, newCard).catch(console.error);
    }

    // Auto-save to server (debounced)
    if (currentCard.meta.id) {
      get().debouncedAutoSave();
    }
  },

  // Debounced auto-save
  debouncedAutoSave: () => {
    const { autoSaveTimeout } = get();
    if (autoSaveTimeout) {
      clearTimeout(autoSaveTimeout);
    }

    // Recovery drafts are local only. Immutable library revisions are written
    // by explicit Save, never by a timer or merely opening the editor.
    set({ autoSaveTimeout: null });
  },

  // Save card to API or IndexedDB
  saveCard: async () => {
    const { currentCard, isDirty, isSaving } = get();
    // Export/send callers flush pending edits, but a saved card should not be
    // rewritten: even identical server updates advance its last-edited date.
    if (!currentCard || isSaving || get().isRestoring || (currentCard.meta.id && !isDirty && !editorAssets.hasChanges(currentCard))) {
      return;
    }

    set({ isSaving: true });
    const savingSelection = selectionVersion;

    try {
      const result = currentCard.meta.id ? await api.updateCard(currentCard.meta.id, currentCard) : await api.createCard(currentCard);
      if (result.error || !result.data) throw new Error(result.error ?? 'Save returned no card');
      const saved = result.data;
      const latest = get().currentCard;
      // Never replace another card opened while the request was in flight.
      if (selectionVersion !== savingSelection || !latest || (latest.meta.id !== currentCard.meta.id || latest.meta.forkOf !== currentCard.meta.forkOf)) return;
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
          updatedAt: saved.meta.updatedAt, createdAt: saved.meta.createdAt } };
      }
      const dirty = changedDuringSave || editorAssets.hasChanges(merged);
      set({ currentCard: merged, isDirty: dirty });
      useTokenStore.getState().updateTokenCounts(merged);
      if (dirty) await localDB.saveDraft(saved.meta.id, merged).catch(console.warn);
      else if (currentCard.meta.id) await localDB.deleteDraft(currentCard.meta.id).catch(console.warn);
    } catch (err) {
      console.error('[saveCard] FAILED to save card:', err);
      throw err; // Re-throw so caller knows it failed
    } finally {
      set({ isSaving: false });
    }
  },

  // Load card from API or IndexedDB
  loadCard: async (id) => {
    const loadingSelection = selectionVersion;
    const { data, error } = await api.getCard(id);
    if (loadingSelection !== selectionVersion) return;
    if (error) {
      throw new Error(error);
    }

    if (data) {
      get().setCurrentCard(data);

      // Check for draft in IndexedDB
      const draft = await localDB.getDraft(id);
      if (draft && draft.lastSaved > data.meta.updatedAt) {
        console.log('Found newer draft in IndexedDB');
      }
    }
  },

  // Create new card
  createNewCard: async () => {
    const newCard: Card = {
      meta: {
        id: '',
        name: 'New Character',
        spec: 'v3',
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      data: {
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: {
          name: 'New Character',
          description: '',
          personality: '',
          scenario: '',
          first_mes: '',
          mes_example: '',
          creator: '',
          character_version: '1.0',
          tags: [],
          system_prompt: '',
          post_history_instructions: '',
          alternate_greetings: [],
          group_only_greetings: [],
        },
      } as CCv3Data,
    };

    get().setCurrentCard(newCard);
    set({ isDirty: true });
  },

  // Create new standalone lorebook
  createNewLorebook: async () => {
    const newCard: Card = {
      meta: {
        id: '',
        name: 'New Lorebook',
        spec: 'lorebook',
        tags: ['LORE'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      data: {
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: {
          name: 'New Lorebook',
          description: '',
          personality: '',
          scenario: '',
          first_mes: '',
          mes_example: '',
          creator: '',
          character_version: '1.0',
          tags: ['LORE'],
          system_prompt: '',
          post_history_instructions: '',
          alternate_greetings: [],
          group_only_greetings: [],
          character_book: {
            name: 'New Lorebook',
            description: '',
            scan_depth: 100,
            token_budget: 500,
            recursive_scanning: false,
            extensions: {},
            entries: [],
          },
        },
      } as CCv3Data,
    };

    get().setCurrentCard(newCard);
    set({ isDirty: true });
  },

  // Import card
  importCard: async (file) => {
    const card = await importCharacterFile(file);
    get().setCurrentCard(card);
    return card.meta.id;
  },

  // Container support is owned by Foundry's server adapter, including explicit errors.
  importVoxtaPackage: async (file) => get().importCard(file),

  importCardFromURL: async (url) => {
    const card = await importCharacterUrl(url);
    get().setCurrentCard(card);
    return card.meta.id;
  },

  // Export card
  exportCard: async (format) => {
    const { currentCard } = get();
    if (!currentCard || !currentCard.meta.id) return;

    // Save before exporting to ensure DB has latest data
    if (currentCard.meta.spec === 'collection') {
      // For collections: save member cards, not the collection container itself
      // The collection card is just metadata - members need to be saved/validated
      const collectionData = currentCard.data as { members?: Array<{ cardId: string }> };
      if (collectionData.members && collectionData.members.length > 0) {
        // Member cards should already be saved individually when edited
        // Just ensure they exist - actual save happens in their own edit sessions
      }
    } else {
      // Regular character card: save before export
      try {
        await get().saveCard();
      } catch (err) {
        alert(`Failed to save card before export: ${err}`);
        return;
      }
    }

    // Server mode: use API
    const { data, error } = await api.exportCard(currentCard.meta.id, format);
    if (error) {
      return;
    }

    if (data) {
      // Download file
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url;

      let ext: string = format;
      if (format === 'voxta') {
          ext = 'voxpkg';
      }

      a.download = `${currentCard.meta.name}.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
    }
  },

  // Type-safe update for normalized card fields
  // Handles v2/v3 wrapping automatically
  updateCardFields: (fields) => {
    const { currentCard } = get();
    if (!currentCard) return;

    let newData: CCv2Data | CCv3Data;

    if (isV3Card(currentCard)) {
      // V3: Always wrapped, update data.data
      const v3Data = currentCard.data;
      newData = {
        ...v3Data,
        data: {
          ...v3Data.data,
          ...fields,
        },
      };
    } else if (isV2Card(currentCard)) {
      if (isWrappedV2(currentCard.data)) {
        // Wrapped V2: update data.data
        const wrapped = currentCard.data as CCv2Wrapped;
        newData = {
          ...wrapped,
          spec: 'chara_card_v2',
          spec_version: '2.0',
          data: {
            ...wrapped.data,
            ...fields,
          },
        } as unknown as CCv2Data;
      } else {
        // Unwrapped V2: update directly
        newData = {
          ...currentCard.data,
          ...fields,
        } as CCv2Data;
      }
    } else {
      // Unknown format, try direct update
      newData = { ...currentCard.data, ...fields } as CCv2Data;
    }

    const newCard = { ...currentCard, data: newData };
    set({ currentCard: newCard, isDirty: true });

    // Autosave and token update
    if (currentCard.meta.id) {
      localDB.saveDraft(currentCard.meta.id, newCard).catch(console.error);
      get().debouncedAutoSave();
    }
    useTokenStore.getState().updateTokenCounts(newCard);
  },

  // Type-safe update for extensions only
  updateExtensions: (extensions) => {
    const { currentCard } = get();
    if (!currentCard) return;

    const inner = getInnerData(currentCard);
    const currentExtensions = (inner.extensions || {}) as CardExtensions;
    const mergedExtensions = { ...currentExtensions, ...extensions };

    get().updateCardFields({ extensions: mergedExtensions });
  },

  // Type-safe update for character book
  updateCharacterBook: (book) => {
    const { currentCard } = get();
    if (!currentCard) return;

    const inner = getInnerData(currentCard);
    const currentBook = inner.character_book || { entries: [] };
    const mergedBook = { ...currentBook, ...book } as CharacterBook;

    get().updateCardFields({ character_book: mergedBook });
  },

  // Set a specific extension namespace
  setExtension: (key, value) => {
    const { currentCard } = get();
    if (!currentCard) return;

    const inner = getInnerData(currentCard);
    const currentExtensions = (inner.extensions || {}) as CardExtensions;

    get().updateCardFields({
      extensions: {
        ...currentExtensions,
        [key]: value,
      },
    });
  },

  convertSpec: (mode) => {
    const { currentCard } = get();
    if (!currentCard) return;

    // Update the card's spec mode
    const updatedCard = {
      ...currentCard,
      meta: {
        ...currentCard.meta,
        spec: mode,
      },
    };

    // Convert data format if needed
    if (mode === 'v3' && currentCard.meta.spec === 'v2') {
      // Convert v2 to v3 format
      const v2Data = currentCard.data as CCv2Data;
      updatedCard.data = {
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: {
          ...v2Data,
          creator: v2Data.creator || '',
          character_version: v2Data.character_version || '1.0',
          tags: v2Data.tags || [],
        },
      } as CCv3Data;
    } else if (mode === 'v2' && currentCard.meta.spec === 'v3') {
      // Convert v3 to v2 format
      const v3Data = currentCard.data as CCv3Data;
      updatedCard.data = {
        ...v3Data.data,
      } as CCv2Data;
    }

    set({ currentCard: updatedCard, isDirty: true });
  },
}));
