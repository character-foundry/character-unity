import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnityApiClient } from './api';
import type { Card } from './types';
import type { EditorAssetService } from '../unity/assets';

const document = { spec: 'chara_card_v3', spec_version: '3.0', opaque: { retain: true }, data: {
  name: 'Character', description: 'Original', extensions: { vendor: [null, 42] },
  assets: [{ type: 'custom', name: 'notes', ext: 'txt', uri: 'embedded://notes.txt', license: { exact: true } }],
} };
const revision = (id = 'head-1', sequence = 1, content = document) => ({ id, sequence, document: content, createdAt: '2026-10-13T12:00:00.000Z', assets: [{ path: 'declared/0', assetId: 'stored-notes' }, { path: 'module.risum', assetId: 'opaque-module' }] });
function opened(id: string, value = revision()) {
  return { card: { id, headRevisionId: value.id, createdAt: value.createdAt, forkedFromRevisionId: null }, revision: value };
}
const metadata = { assets: [{ path: 'declared/0', mediaType: 'text/plain', byteLength: 5 }, { path: 'module.risum', mediaType: 'application/octet-stream', byteLength: 17 }] };

describe('native editor Save API', () => {
  let api: UnityApiClient;
  let editorAssets: EditorAssetService;
  beforeEach(() => { api = new UnityApiClient({ workspaceId: 'asset-tests' }); editorAssets = api.assets; });
  afterEach(() => { api.dispose(); vi.unstubAllGlobals(); });

  it('keeps an asset draft and original expected head after a failed Save, then commits document and asset changes in one request', async () => {
    let head = 'head-1';
    const writes: FormData[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      if (init?.method === 'POST') {
        expect(String(input).endsWith('/asset-revisions')).toBe(true);
        const form = init.body as FormData; writes.push(form);
        if (writes.length === 1) return Response.json({ error: { code: 'HEAD_CONFLICT', message: 'The card has changed; reload before saving' } }, { status: 409 });
        const value = JSON.parse(form.get('input') as string);
        expect(value.expectedHead).toBe('head-1');
        head = 'head-2';
        return Response.json(revision(head, 2, value.document));
      }
      return Response.json(String(input).includes('/assets?') ? metadata : opened('existing'));
    });
    vi.stubGlobal('fetch', fetcher);
    const result = await api.getCard('existing');
    const card = result.data!;
    await editorAssets.list(card);
    editorAssets.update(card, 'declared/0', { name: 'Renamed notes' });
    const draft = { ...card, data: { ...document, data: { ...document.data, description: 'Edited prompt' } } as unknown as Card['data'] };
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await api.updateCard('existing', draft)).error).toContain('changed');
    expect(head).toBe('head-1');
    expect(editorAssets.hasChanges(draft)).toBe(true);
    expect((await editorAssets.list(draft))[0]?.name).toBe('Renamed notes');
    const saved = await api.updateCard('existing', draft);
    expect(saved.error).toBeUndefined();
    expect(head).toBe('head-2');
    expect(editorAssets.hasChanges(saved.data!)).toBe(false);
    const request = JSON.parse(writes[1]!.get('input') as string);
    expect(request.document.opaque).toEqual({ retain: true });
    expect(request.document.data.description).toBe('Edited prompt');
    expect(request.document.data.assets).toMatchObject([{ name: 'Renamed notes', license: { exact: true } }]);
    expect(request.bindings).toEqual([{ path: 'declared/0', source: { kind: 'existing', path: 'declared/0' } }]);
    expect([...writes[1]!.keys()]).toEqual(['input']);
  });

  it('creates a new card and its uploaded assets with one request only on Save', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      expect(input).toBe('/api/workspaces/asset-tests/cards');
      expect(init?.method).toBe('POST');
      const form = init?.body as FormData;
      const value = JSON.parse(form.get('input') as string);
      expect(value.expectedHead).toBeUndefined();
      expect(value.bindings).toEqual([{ path: 'declared/0', source: { kind: 'upload', index: 0 } }]);
      expect(await (form.get('file:0') as File).text()).toBe('exact new bytes');
      return Response.json({ cardId: 'created', revisionId: 'created-head', revision: revision('created-head', 1, value.document) });
    });
    vi.stubGlobal('fetch', fetcher);
    const draft: Card = { meta: { id: '', name: 'New', spec: 'v3', tags: [], createdAt: 'created', updatedAt: 'updated' },
      data: { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'New' } } as unknown as Card['data'] };
    await editorAssets.add(draft, new File(['exact new bytes'], 'notes.txt', { type: 'text/plain' }), { type: 'custom' });
    expect(fetcher).not.toHaveBeenCalled();
    const saved = await api.createCard(draft);
    expect(saved.data?.meta.id).toBe('created');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(editorAssets.hasChanges(saved.data!)).toBe(false);
  });

  it('saves a fork and inherited asset references atomically, without downloading their bytes', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(opened('fork-source')))
      .mockResolvedValueOnce(Response.json(metadata))
      .mockImplementationOnce(async (input, init) => {
        expect(input).toBe('/api/workspaces/asset-tests/cards/fork-source/fork-assets');
        const form = init?.body as FormData;
        const value = JSON.parse(form.get('input') as string);
        expect(value.expectedHead).toBe('head-1');
        expect(value.bindings).toEqual([{ path: 'declared/0', source: { kind: 'existing', path: 'declared/0' } }]);
        expect([...form.keys()]).toEqual(['input']);
        return Response.json({ cardId: 'saved-fork', revisionId: 'fork-head', revision: revision('fork-head', 1, value.document) });
      });
    vi.stubGlobal('fetch', fetcher);
    const original = (await api.getCard('fork-source')).data!;
    const draft = { ...original, meta: { ...original.meta, id: '', forkOf: 'fork-source' } };
    const saved = await api.createCard(draft);
    expect(saved.data?.meta.id).toBe('saved-fork');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('does not let a library summary refresh silently advance an open editor’s expected head', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(opened('pinned')))
      .mockResolvedValueOnce(Response.json({ total: 1, cards: [{ id: 'pinned', headRevisionId: 'someone-elses-head', name: 'Character', creator: '', tags: [], spec: 'v3', hasPortrait: false, favorite: false, createdAt: 'created', updatedAt: 'updated' }] }))
      .mockImplementationOnce(async (_input, init) => {
        expect(JSON.parse(init?.body as string).expectedHead).toBe('head-1');
        return Response.json({ error: { message: 'Conflict' } }, { status: 409 });
      });
    vi.stubGlobal('fetch', fetcher);
    const original = (await api.getCard('pinned')).data!;
    await api.listCards();
    expect((await api.updateCard('pinned', original)).error).toBe('Conflict');
  });

  it('paginates revision summaries without downloading every document, and fetches only a selected version', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ throughSequence: 21, headRevisionId: 'revision-21', nextAfter: 20,
        revisions: Array.from({ length: 20 }, (_, index) => ({ id: `revision-${index + 1}`, sequence: index + 1, createdAt: 'created' })) }))
      .mockResolvedValueOnce(Response.json({ throughSequence: 21, headRevisionId: 'revision-21', nextAfter: null,
        revisions: [{ id: 'revision-21', sequence: 21, createdAt: 'created' }] }))
      .mockResolvedValueOnce(Response.json(revision('revision-5', 5)));
    vi.stubGlobal('fetch', fetcher);
    const versions = await api.listVersions('history');
    expect(versions.data).toHaveLength(21);
    expect(versions.data?.[0]).toMatchObject({ id: 'revision-21', message: 'Current' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]![0])).toContain('throughSequence=21');
    const selected = await api.getVersion('history', 'revision-5');
    expect(selected.data?.data).toEqual(document);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('imports Unicode and percent signs in filenames through an explicitly encoded header', async () => {
    const file = new File(['original bytes'], '日本語 100%.charx');
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(async (_input, init) => {
        const headers = new Headers(init?.headers);
        expect(headers.get('x-file-name-encoding')).toBe('uri');
        expect(decodeURIComponent(headers.get('x-file-name')!)).toBe(file.name);
        expect(init?.body).toBe(file);
        return Response.json({ card: { id: 'unicode' } });
      })
      .mockResolvedValueOnce(Response.json(opened('unicode')));
    vi.stubGlobal('fetch', fetcher);
    expect((await api.importFile(file)).data?.meta.id).toBe('unicode');
  });

  it('does not erase another card’s staged assets when an earlier Restore completes', async () => {
    let complete!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { complete = resolve; });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (path) => {
      if (String(path).endsWith('/restores')) return pending;
      if (String(path).includes('/assets?')) return Response.json(metadata);
      return Response.json(opened(String(path).endsWith('/other') ? 'other' : 'restoring'));
    }));
    await api.getCard('restoring');
    const restore = api.restoreVersion('restoring', 'old-revision');
    editorAssets.reset();
    const other = (await api.getCard('other')).data!;
    await editorAssets.add(other, new File(['keep these bytes'], 'late.txt', { type: 'text/plain' }));
    complete(Response.json(revision('restored-head', 2)));
    expect((await restore).error).toBeUndefined();
    expect(editorAssets.hasChanges(other)).toBe(true);
    const plan = await editorAssets.prepare(other);
    expect(plan.uploads).toHaveLength(1);
    expect(await plan.uploads[0]!.text()).toBe('keep these bytes');
  });

  it('pins identical card ids to independent immutable workspace clients', async () => {
    const config = { workspaceId: 'second-workspace' };
    const second = new UnityApiClient(config);
    config.workspaceId = 'changed-after-construction';
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(opened('same-id', revision('first-head'))))
      .mockResolvedValueOnce(Response.json(opened('same-id', revision('second-head'))));
    vi.stubGlobal('fetch', fetcher);
    await api.getCard('same-id'); await second.getCard('same-id');
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      '/api/workspaces/asset-tests/cards/same-id', '/api/workspaces/second-workspace/cards/same-id',
    ]);
    expect(api.headRevision('same-id')).toBe('first-head');
    expect(second.headRevision('same-id')).toBe('second-head');
    api.dispose();
    expect(second.headRevision('same-id')).toBe('second-head');
    second.dispose();
  });

  it('does not repin a draft to an older response from the same card id', async () => {
    let resolve!: (response: Response) => void;
    const old = new Promise<Response>((done) => { resolve = done; });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockReturnValueOnce(old)
      .mockResolvedValueOnce(Response.json(opened('same-id', revision('new-head')))));
    const pending = api.getCard('same-id');
    expect((await api.getCard('same-id')).data?.meta.id).toBe('same-id');
    resolve(Response.json(opened('same-id', revision('old-head'))));
    expect((await pending).error).toContain('superseded');
    expect(api.headRevision('same-id')).toBe('new-head');
  });

  it('rejects late reads after disposal and does not leave remembered card heads', async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
    vi.stubGlobal('fetch', fetcher);
    const pending = api.getCard('disposed');
    api.dispose();
    expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    resolve(Response.json(opened('disposed')));
    expect((await pending).error).toBeTruthy();
    expect(api.headRevision('disposed')).toBeUndefined();
    expect((await api.getCard('another')).error).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not advance the saved draft head when reading newer same-id auxiliary data', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(opened('same-id', revision('pinned-head'))))
      .mockResolvedValueOnce(Response.json(opened('same-id', revision('newer-auxiliary-head'))))
      .mockImplementationOnce(async (_path, options) => {
        expect(JSON.parse(options!.body as string).expectedHead).toBe('pinned-head');
        return Response.json({ error: { message: 'Expected stale-head conflict' } }, { status: 409 });
      });
    vi.stubGlobal('fetch', fetcher);
    const draft = (await api.getCard('same-id')).data!;
    expect((await api.getCard('same-id', { pinHead: false })).data?.meta.id).toBe('same-id');
    expect(api.headRevision('same-id')).toBe('pinned-head');
    expect((await api.updateCard('same-id', draft)).error).toBe('Expected stale-head conflict');
  });

  it('keeps primary and auxiliary same-id read generations independent', async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((done) => { resolve = done; });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockReturnValueOnce(pending)
      .mockResolvedValueOnce(Response.json(opened('same-id', revision('auxiliary-head')))));
    const primary = api.getCard('same-id');
    expect((await api.getCard('same-id', { pinHead: false })).data?.meta.id).toBe('same-id');
    resolve(Response.json(opened('same-id', revision('primary-head'))));
    expect((await primary).error).toBeUndefined();
    expect(api.headRevision('same-id')).toBe('primary-head');
  });
});
