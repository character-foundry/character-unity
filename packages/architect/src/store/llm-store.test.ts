import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLLMStore, clientProvider } from './llm-store';
import type { ProviderConfig } from '../lib/types';

const provider: ProviderConfig = { id: 'test', name: 'Local model', kind: 'openai-compatible', baseURL: 'http://localhost:1234', apiKey: '', defaultModel: 'local-model' };
let controller: AbortController;
let useLLMStore: ReturnType<typeof createLLMStore>;
beforeEach(() => {
  const items = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); },
    removeItem: (key: string) => { items.delete(key); },
  });
  controller = new AbortController();
  useLLMStore = createLLMStore({ signal: controller.signal, isDisposed: () => controller.signal.aborted });
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

  it('keeps model requests and caches independent for concurrent editors', async () => {
    const other = createLLMStore({ signal: controller.signal, isDisposed: () => false });
    await useLLMStore.getState().addProvider(provider);
    await other.getState().loadSettings();
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ id: 'only-first-editor' }] })));
    await useLLMStore.getState().fetchModelsForProvider(provider.id);
    expect(useLLMStore.getState().getCachedModels(provider.id)).toEqual(['only-first-editor']);
    expect(other.getState().getCachedModels(provider.id)).toEqual([]);
  });

  it('ignores stale model responses after a provider is replaced under the same id', async () => {
    await useLLMStore.getState().addProvider(provider);
    let resolve!: (response: Response) => void;
    const response = new Promise<Response>((done) => { resolve = done; });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockReturnValueOnce(response)
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'new-model' }] })));
    const old = useLLMStore.getState().fetchModelsForProvider(provider.id);
    await useLLMStore.getState().updateProvider(provider.id, { baseURL: 'http://localhost:5678' });
    await useLLMStore.getState().fetchModelsForProvider(provider.id);
    resolve(Response.json({ data: [{ id: 'stale-model' }] }));
    expect((await old).success).toBe(false);
    expect(useLLMStore.getState().getCachedModels(provider.id)).toEqual(['new-model']);
  });

  it('does not cache provider responses after the editor is disposed', async () => {
    await useLLMStore.getState().addProvider(provider);
    let resolve!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation((_url, options) => {
      expect(options?.signal).toBe(controller.signal);
      return new Promise<Response>((done) => { resolve = done; });
    }));
    const pending = useLLMStore.getState().fetchModelsForProvider(provider.id);
    controller.abort();
    resolve(Response.json({ data: [{ id: 'too-late' }] }));
    expect((await pending).success).toBe(false);
    expect(useLLMStore.getState().modelCache).toEqual({});
  });
});
