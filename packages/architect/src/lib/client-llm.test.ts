import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchClientLLMModels, invokeClientLLM, type ClientLLMProvider } from './client-llm';

const provider: ClientLLMProvider = { id: 'local', name: 'Local', kind: 'openai-compatible', baseURL: 'http://localhost:1234/v1/', apiKey: '', defaultModel: 'local-model' };
afterEach(() => vi.unstubAllGlobals());

describe('native browser provider requests', () => {
  it('accepts a versioned API base and propagates cancellation to generation', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'Revised' } }] })));
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    const result = await invokeClientLLM({ provider, messages: [{ role: 'user', content: 'Original' }], signal: controller.signal });
    expect(result).toEqual({ success: true, content: 'Revised' });
    expect(fetcher).toHaveBeenCalledWith('http://localhost:1234/v1/chat/completions', expect.objectContaining({ signal: controller.signal }));
  });

  it('normalizes model URLs and ignores non-string model labels', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'z' }, { model: 'a' }, { id: 12 }] })));
    vi.stubGlobal('fetch', fetcher);
    expect(await fetchClientLLMModels(provider)).toEqual({ success: true, models: ['a', 'z'] });
    expect(fetcher).toHaveBeenCalledWith('http://localhost:1234/v1/models', expect.any(Object));
  });

  it('returns actionable provider errors instead of calling an old Architect proxy', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Model unavailable' } }), { status: 400 }));
    vi.stubGlobal('fetch', fetcher);
    expect(await invokeClientLLM({ provider, messages: [] })).toEqual({ success: false, error: 'Model unavailable' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
