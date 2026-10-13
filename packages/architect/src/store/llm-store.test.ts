import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLLMStore, clientProvider } from './llm-store';
import type { ProviderConfig } from '../lib/types';

const provider: ProviderConfig = { id: 'test', name: 'Local model', kind: 'openai-compatible', baseURL: 'http://localhost:1234', apiKey: '', defaultModel: 'local-model' };
beforeEach(() => {
  const items = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); },
    removeItem: (key: string) => { items.delete(key); },
  });
  useLLMStore.setState({ settings: { providers: [] }, modelCache: {}, error: null });
});
afterEach(() => vi.unstubAllGlobals());

describe('browser-owned provider preferences', () => {
  it('saves, renames, reloads and clears active provider without legacy endpoints', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await useLLMStore.getState().addProvider(provider);
    await useLLMStore.getState().setActiveProvider(provider.id);
    await useLLMStore.getState().updateProvider(provider.id, { name: 'Renamed' });
    await useLLMStore.getState().loadSettings();
    expect(useLLMStore.getState().settings.providers[0]?.name).toBe('Renamed');
    expect(useLLMStore.getState().settings.activeProviderId).toBe(provider.id);
    await useLLMStore.getState().removeProvider(provider.id);
    await useLLMStore.getState().loadSettings();
    expect(useLLMStore.getState().settings.providers).toEqual([]);
    expect(useLLMStore.getState().settings.activeProviderId).toBeUndefined();
    expect(localStorage.getItem('ca-llm-active-provider')).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('honors changed provider kinds and names instead of stale browser metadata', () => {
    expect(clientProvider({ ...provider, name: 'Current', label: 'Old', kind: 'anthropic', clientKind: 'openrouter' })).toMatchObject({ name: 'Current', kind: 'anthropic' });
    expect(clientProvider({ ...provider, clientKind: 'anthropic' }).kind).toBe('openai-compatible');
  });
});
