import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { UnityApiClient } from '../lib/api';
import { useEditorSession } from '../unity/context';
import type { Card } from '../lib/types';
import { projectTokenText } from '../unity/token-projection';

interface TokenCounts { [field: string]: number; total: number }
export interface TokenStore {
  tokenCounts: TokenCounts;
  tokenizerModel: string;
  enabled: boolean;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  omitted: string[];
  disabledLoreEntries: number;
  fields: { key: string; label: string; count: number }[];
  enable(): void;
  schedule(card: Card | null): void;
  updateTokenCounts(card: Card | null): Promise<void>;
  setTokenizerModel(model: string): void;
}

export function createTokenStore({ api, isDisposed, signal }: {
  api: Pick<UnityApiClient, 'tokenize'>; isDisposed(): boolean; signal: AbortSignal;
}): StoreApi<TokenStore> {
  let generation = 0;
  let pending: AbortController | undefined;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  signal.addEventListener('abort', () => { clearTimeout(scheduled); pending?.abort(); }, { once: true });
  const inactive = () => signal.aborted || isDisposed();
  return createStore<TokenStore>((set, get) => ({
    tokenCounts: { total: 0 }, tokenizerModel: 'gpt-4', enabled: false,
    status: 'idle', error: null, omitted: [], disabledLoreEntries: 0, fields: [],
    enable() { if (!inactive()) set({ enabled: true }); },
    schedule(card) {
      if (inactive() || !get().enabled) return;
      clearTimeout(scheduled); generation++; pending?.abort();
      set({ tokenCounts: { total: 0 }, fields: [], status: card ? 'loading' : 'idle', error: null });
      if (card) scheduled = setTimeout(() => { void get().updateTokenCounts(card); }, 250);
    },
    async updateTokenCounts(card) {
      clearTimeout(scheduled); const request = ++generation; pending?.abort();
      if (inactive()) return;
      const controller = new AbortController(); pending = controller;
      const live = AbortSignal.any([signal, controller.signal]);
      const current = () => !inactive() && !live.aborted && generation === request;
      const { tokenizerModel } = get();
      set({ tokenCounts: { total: 0 }, fields: [], error: null, omitted: [], disabledLoreEntries: 0, status: card ? 'loading' : 'idle' });
      if (!card) return;
      try {
        const projection = projectTokenText(card);
        const { data, error } = await api.tokenize({ model: tokenizerModel, payload: projection.payload }, { signal: live });
        if (!current() || get().tokenizerModel !== tokenizerModel) return;
        if (error || !data) throw new Error(error ?? 'The tokenizer returned no result');
        const counts = Object.values(data.fields);
        if (Object.keys(projection.payload).some((key) => !Number.isSafeInteger(data.fields[key]) || data.fields[key]! < 0)
          || Object.keys(data.fields).some((key) => !Object.hasOwn(projection.payload, key))
          || counts.some((count) => !Number.isSafeInteger(count) || count < 0) || !Number.isSafeInteger(data.total) || data.total < 0
          || counts.reduce((total, count) => total + count, 0) !== data.total) {
          throw new Error('The tokenizer returned invalid counts');
        }
        const fields = projection.fields.map(({ key, label, parts }) => ({ key, label, count: parts.reduce((total, part) => total + data.fields[part]!, 0) }));
        const tokenCounts = { ...data.fields, ...Object.fromEntries(fields.map((field) => [field.key, field.count])), total: data.total };
        set({ tokenCounts, fields, status: 'ready', error: null, omitted: projection.omitted, disabledLoreEntries: projection.disabledLoreEntries });
      } catch (failure) {
        if (current()) set({ status: 'error', error: failure instanceof Error ? failure.message : 'Token counting failed', tokenCounts: { total: 0 }, fields: [] });
      }
    },
    setTokenizerModel(model) {
      if (inactive()) return;
      clearTimeout(scheduled); generation++; pending?.abort();
      set({ tokenizerModel: model, tokenCounts: { total: 0 }, fields: [], status: 'idle', error: null });
    },
  }));
}

export function useTokenStore(): TokenStore;
export function useTokenStore<T>(selector: (state: TokenStore) => T): T;
export function useTokenStore<T>(selector?: (state: TokenStore) => T): T | TokenStore {
  return useStore(useEditorSession().tokens, (state): T | TokenStore => selector ? selector(state) : state);
}
