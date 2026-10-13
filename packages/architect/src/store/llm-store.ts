/** Browser-owned provider preferences. Card persistence remains in Unity. */
import { create } from 'zustand';
import type { LLMSettings, ProviderConfig } from '../lib/types';
import {
  loadClientLLMProviders, saveClientLLMProviders, loadActiveProvider, saveActiveProvider,
  testClientLLMConnection, fetchClientLLMModels, type ClientLLMProvider,
} from '../lib/client-llm';

export function clientProvider(provider: ProviderConfig): ClientLLMProvider {
  return {
    id: provider.id, name: provider.name || provider.label || 'Untitled provider',
    kind: provider.kind === 'anthropic' ? 'anthropic' : provider.clientKind === 'openrouter' ? 'openrouter' : 'openai-compatible',
    baseURL: provider.baseURL, apiKey: provider.apiKey, defaultModel: provider.defaultModel,
    temperature: provider.temperature, maxTokens: provider.maxTokens,
  };
}

interface LLMStore {
  settings: LLMSettings;
  isLoading: boolean;
  error: string | null;
  modelCache: Record<string, string[]>;
  loadSettings(): Promise<void>;
  saveSettings(settings: Partial<LLMSettings>): Promise<void>;
  addProvider(provider: ProviderConfig): Promise<void>;
  updateProvider(id: string, updates: Partial<ProviderConfig>): Promise<void>;
  removeProvider(id: string): Promise<void>;
  setActiveProvider(id: string): Promise<void>;
  testConnection(id: string): Promise<{ success: boolean; error?: string }>;
  fetchModelsForProvider(id: string): Promise<{ success: boolean; models?: string[]; error?: string }>;
  getCachedModels(id: string): string[];
}

export const useLLMStore = create<LLMStore>((set, get) => ({
  settings: { providers: [] }, isLoading: false, error: null, modelCache: {},
  loadSettings: async () => {
    const providers: ProviderConfig[] = loadClientLLMProviders().map((provider) => ({
      ...provider, name: provider.name,
      kind: provider.kind === 'openrouter' ? 'openai-compatible' : provider.kind,
      clientKind: provider.kind,
    }));
    set({ settings: { providers, activeProviderId: loadActiveProvider() || undefined }, error: null });
  },
  saveSettings: async (updates) => {
    const settings = { ...get().settings, ...updates };
    try {
      saveClientLLMProviders(settings.providers.map(clientProvider));
      saveActiveProvider(settings.activeProviderId ?? null);
      set({ settings, error: null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Unable to save provider preferences' });
      throw error;
    }
  },
  addProvider: async (provider) => get().saveSettings({ providers: [...get().settings.providers, provider] }),
  updateProvider: async (id, updates) => get().saveSettings({
    providers: get().settings.providers.map((provider) => provider.id === id ? { ...provider, ...updates } : provider),
  }),
  removeProvider: async (id) => get().saveSettings({
    providers: get().settings.providers.filter((provider) => provider.id !== id),
    activeProviderId: get().settings.activeProviderId === id ? undefined : get().settings.activeProviderId,
  }),
  setActiveProvider: async (id) => get().saveSettings({ activeProviderId: id }),
  testConnection: async (id) => {
    const provider = get().settings.providers.find((item) => item.id === id);
    return provider ? testClientLLMConnection(clientProvider(provider)) : { success: false, error: 'Provider not found' };
  },
  fetchModelsForProvider: async (id) => {
    const provider = get().settings.providers.find((item) => item.id === id);
    if (!provider) return { success: false, error: 'Provider not found' };
    const result = await fetchClientLLMModels(clientProvider(provider));
    if (result.success && result.models) {
      set((state) => ({ modelCache: { ...state.modelCache, [id]: result.models! } }));
    }
    return result;
  },
  getCachedModels: (id) => get().modelCache[id] || [],
}));
