import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnityApiClient } from '../lib/api';
import { importCharacterFile, importCharacterUrl } from './import';

const document = {
  spec: 'chara_card_v3', spec_version: '3.0',
  opaque_root: { untouched: ['value', 17] },
  data: { name: 'Original', tags: [], extensions: { vendor: { unknown: true } },
    assets: [{ type: 'emotion', name: 'smile', uri: 'embeded://assets/smile.png', ext: 'png' }] },
};
const opened = {
  card: { id: 'native-card', headRevisionId: 'native-revision', forkedFromRevisionId: null, createdAt: '2026-10-13T12:00:00.000Z' },
  revision: { id: 'native-revision', sequence: 1, document, createdAt: '2026-10-13T12:00:00.000Z',
    assets: [{ path: 'declared/0', assetId: 'native-asset' }, { path: 'module.risum', assetId: 'native-module' }] },
};

describe('native character imports', () => {
  let api: UnityApiClient;
  beforeEach(() => { api = new UnityApiClient({ workspaceId: 'import-tests' }); });
  afterEach(() => { api.dispose(); vi.unstubAllGlobals(); });

  it.each(['png', 'json', 'charx'])('sends the original %s file and opens its native id without browser reconstruction', async (extension) => {
    const bytes = new Uint8Array([0, 255, 10, 27, 37]);
    const file = new File([bytes], `original.${extension}`, { type: 'application/octet-stream' });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ card: { id: 'native-card' } }, { status: 201 }))
      .mockResolvedValueOnce(Response.json(opened));
    vi.stubGlobal('fetch', fetcher);

    const card = await importCharacterFile(api, file);

    expect(fetcher).toHaveBeenCalledTimes(2);
    const [path, request] = fetcher.mock.calls[0]!;
    expect(path).toBe('/api/workspaces/import-tests/imports');
    expect(request?.method).toBe('POST');
    expect(new Headers(request?.headers).get('x-file-name')).toBe(`original.${extension}`);
    expect(request?.body).toBe(file);
    expect(new Uint8Array(await (request?.body as File).arrayBuffer())).toEqual(bytes);
    expect(fetcher.mock.calls[1]![0]).toBe('/api/workspaces/import-tests/cards/native-card');
    expect(card.meta.id).toBe('native-card');
    expect(card.data).toEqual(document);
    expect(card.meta.assetCount).toBe(1);
  });

  it('reports Foundry rejection without attempting to open a card', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(
      { error: { code: 'ASSET_UNAVAILABLE', message: 'Asset 1 has no existing bytes in this import' } }, { status: 400 },
    ));
    vi.stubGlobal('fetch', fetcher);
    await expect(importCharacterFile(api, new File(['{}'], 'incomplete.json'))).rejects.toThrow('Asset 1 has no existing bytes');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reports an unreadable imported card instead of returning a fabricated local card', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ card: { id: 'native-card' } }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ error: { message: 'Card is unavailable' } }, { status: 404 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(importCharacterFile(api, new File(['{}'], 'original.json'))).rejects.toThrow('Card is unavailable');
  });

  it('does not start an import that was already canceled', async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    controller.abort();
    await expect(importCharacterFile(api, new File(['{}'], 'original.json'), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('propagates cancellation to upload and open requests', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ card: { id: 'native-card' } }, { status: 201 }))
      .mockImplementationOnce(async (_path, options) => {
        expect(options?.signal?.aborted).toBe(false);
        controller.abort();
        throw controller.signal.reason;
      });
    vi.stubGlobal('fetch', fetcher);
    await expect(importCharacterFile(api, new File(['{}'], 'original.json'), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });

  it('downloads a direct URL as bytes and uses the same import endpoint', async () => {
    const bytes = new Uint8Array([0, 1, 254, 255]);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'application/zip' } }))
      .mockResolvedValueOnce(Response.json({ card: { id: 'native-card' } }, { status: 201 }))
      .mockResolvedValueOnce(Response.json(opened));
    vi.stubGlobal('fetch', fetcher);
    const card = await importCharacterUrl(api, 'https://example.com/Original%20Card.charx');
    expect(fetcher.mock.calls[0]![1]?.credentials).toBe('omit');
    const uploaded = fetcher.mock.calls[1]![1]?.body as File;
    expect(uploaded.name).toBe('Original Card.charx');
    expect(new Uint8Array(await uploaded.arrayBuffer())).toEqual(bytes);
    expect(card.meta.id).toBe('native-card');
  });

  it.each(['file:///tmp/card.json', 'https://user:secret@example.com/card.json', 'data:application/json,{}'])('rejects non-public file URL syntax: %s', async (url) => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    await expect(importCharacterUrl(api, url)).rejects.toThrow('HTTP or HTTPS card file URL');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
