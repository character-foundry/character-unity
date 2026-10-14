import { describe, expect, it, vi } from 'vitest';
import type { Card } from '../lib/types';
import { assetPlanForm, EditorAssetService } from './assets';
import type { AssetMetadata, AssetTransport } from './assets';

function card(id = 'card', assets: Record<string, unknown>[] = []): Card {
  return { meta: { id, name: 'Character', spec: 'v3', tags: [], createdAt: 'created', updatedAt: 'updated' },
    data: { spec: 'chara_card_v3', spec_version: '3.0', opaque: { preserve: true }, data: {
      name: 'Character', description: 'Original', assets, extensions: { vendor: [null, 42] },
    } } as unknown as Card['data'] };
}
function fixture(metadata: AssetMetadata[] = []) {
  const transport: AssetTransport = { head: () => 'head-1', list: vi.fn(async () => metadata),
    url: (id, revision, path) => `/asset/${id}/${revision}/${path}` };
  return { transport, service: new EditorAssetService(transport) };
}

describe('native editor asset draft', () => {
  it('maps authored image URIs only to exact current stored bindings without fetching bytes or ambiguous aliases', async () => {
    const original = card('card', [
      { type: 'icon', name: 'main', uri: 'ccdefault:' },
      { type: 'emotion', name: 'stored', uri: 'https://old.invalid/stored.png' },
      { type: 'emotion', name: 'ambiguous one', uri: 'embedded://duplicate.png' },
      { type: 'emotion', name: 'ambiguous two', uri: 'embedded://duplicate.png' },
      { type: 'custom', name: 'not image', uri: 'embedded://notes.txt' },
    ]);
    const { service, transport } = fixture([{ path: 'portrait', mediaType: 'image/png', byteLength: 2 },
      ...Array.from({ length: 4 }, (_, index) => ({ path: `declared/${index}`, mediaType: 'image/png', byteLength: 2 })),
      { path: 'declared/4', mediaType: 'text/plain', byteLength: 1 }]);
    const sources = await service.imageSources(original);
    expect(sources['ccdefault:']).toBe('/asset/card/head-1/portrait');
    expect(sources['https://old.invalid/stored.png']).toBe('/asset/card/head-1/declared/1');
    expect(Object.hasOwn(sources, 'embedded://duplicate.png')).toBe(false);
    expect(Object.hasOwn(sources, 'embedded://notes.txt')).toBe(false);
    expect(transport.list).toHaveBeenCalledTimes(1);
    expect(service.hasChanges(original)).toBe(false);
    service.reset();
  });
  it('lists hundreds of declared assets with one metadata request, without fetching their bytes or treating module.risum as editable', async () => {
    const declared = Array.from({ length: 401 }, (_, index) => ({ type: 'emotion', name: `expression-${index}`, uri: `embedded://expression-${index}.png`, ext: 'png', license: { keep: index } }));
    const metadata = declared.map((_, index) => ({ path: `declared/${index}`, mediaType: 'image/png', byteLength: index + 1 }));
    const { service, transport } = fixture([...metadata, { path: 'module.risum', mediaType: 'application/octet-stream', byteLength: 1000 }]);
    const original = card('card', declared);
    const rows = await service.list(original);
    expect(rows).toHaveLength(401);
    expect(rows[400]?.url).toBe('/asset/card/head-1/declared/400');
    await service.list(original);
    expect(transport.list).toHaveBeenCalledTimes(1);
    const plan = await service.prepare(original);
    expect(plan.bindings).toHaveLength(401);
    expect(plan.uploads).toEqual([]);
    expect(plan.document).toEqual(original.data);
    expect(service.hasChanges(original)).toBe(false);
    service.reset();
  });

  it('keeps unknown document and descriptor fields while removing, renaming and retyping assets and reuses original bytes', async () => {
    const original = card('card', [
      { type: 'emotion', name: 'discard', ext: 'png', uri: 'embedded://discard.png' },
      { type: 'custom', name: 'notes', ext: 'txt', uri: 'embedded://notes.txt', license: { exact: true }, vendor: [null, 2] },
    ]);
    const { service } = fixture([
      { path: 'declared/0', mediaType: 'image/png', byteLength: 12 },
      { path: 'declared/1', mediaType: 'text/plain', byteLength: 40 },
    ]);
    await service.list(original);
    service.remove(original, 'declared/0');
    service.update(original, 'declared/1', { name: 'Attribution', type: 'custom' });
    const plan = await service.prepare(original);
    expect(plan.bindings).toEqual([{ path: 'declared/0', source: { kind: 'existing', path: 'declared/1' } }]);
    expect(plan.uploads).toEqual([]);
    expect(plan.document.opaque).toEqual({ preserve: true });
    expect((plan.document.data as Record<string, unknown>).assets).toEqual([
      { type: 'custom', name: 'Attribution', ext: 'txt', uri: 'embedded://notes.txt', license: { exact: true }, vendor: [null, 2] },
    ]);
    expect(service.hasChanges(original)).toBe(true);
    expect((original.data as unknown as Record<string, Record<string, unknown>>).data.assets).toHaveLength(2);
    service.reset();
  });

  it('stages portrait replacement and updates ccdefault aliases with one shared upload', async () => {
    const original = card('card', [{ type: 'icon', name: 'main', ext: 'png', uri: 'ccdefault:', vendor: 'retained' }]);
    const { service } = fixture([{ path: 'portrait', mediaType: 'image/png', byteLength: 12 }, { path: 'declared/0', mediaType: 'image/png', byteLength: 12 }]);
    const file = new File(['replacement'], 'portrait.png', { type: 'image/png' });
    await service.setPortrait(original, file);
    const plan = await service.prepare(original);
    expect(plan.uploads).toEqual([file]);
    expect(plan.bindings).toEqual([
      { path: 'portrait', source: { kind: 'upload', index: 0 } },
      { path: 'declared/0', source: { kind: 'upload', index: 0 } },
    ]);
    const portrait = (await service.list(original)).find((entry) => entry.portrait)!;
    service.remove(original, portrait.id);
    expect((await service.prepare(original)).bindings).toEqual([]);
    service.reset();
  });

  it('holds new card bytes in memory, assigns a portrait by reference, and serializes a single explicit Save request', async () => {
    const original = card('');
    const { service, transport } = fixture();
    const file = new File(['image'], 'portrait.png', { type: 'image/png' });
    await service.add(original, file, { type: 'icon', name: 'main', main: true });
    expect(transport.list).not.toHaveBeenCalled();
    const plan = await service.prepare(original);
    expect(plan.uploads).toHaveLength(1);
    expect(plan.bindings.map((binding) => binding.source)).toEqual([{ kind: 'upload', index: 0 }, { kind: 'upload', index: 0 }]);
    const form = assetPlanForm(plan);
    expect([...form.keys()]).toEqual(['input', 'file:0']);
    expect(JSON.parse(form.get('input') as string)).not.toHaveProperty('expectedHead');
    expect(await (form.get('file:0') as File).text()).toBe('image');
    service.reset();
  });

  it('rebinds imported CharX main icons when replacing the portrait with another image format', async () => {
    const original = card('card', [{ type: 'icon', name: 'main', ext: 'png', uri: 'embeded://assets/icon/main.png', license: { retain: true } }]);
    const { service } = fixture([{ path: 'portrait', mediaType: 'image/png', byteLength: 12 }, { path: 'declared/0', mediaType: 'image/png', byteLength: 12 }]);
    const file = new File(['gif'], 'replacement.gif', { type: 'image/gif' });
    await service.setPortrait(original, file);
    const plan = await service.prepare(original);
    expect(plan.uploads).toEqual([file]);
    expect(plan.bindings).toEqual([
      { path: 'portrait', source: { kind: 'upload', index: 0 } },
      { path: 'declared/0', source: { kind: 'upload', index: 0 } },
    ]);
    expect((plan.document.data as Record<string, unknown>).assets).toEqual([
      { type: 'icon', name: 'main', ext: 'gif', uri: 'ccdefault:', license: { retain: true } },
    ]);
    service.reset();
  });

  it('rebases a successful Save without losing changes made during the request', async () => {
    const original = card('card', [{ type: 'custom', name: 'original', ext: 'txt', uri: 'embedded://original.txt' }]);
    const { service } = fixture([{ path: 'declared/0', mediaType: 'text/plain', byteLength: 1 }]);
    await service.list(original);
    service.update(original, 'declared/0', { name: 'submitted' });
    const plan = await service.prepare(original);
    service.update(original, 'declared/0', { name: 'typed while saving' });
    service.accept(original, plan, 'head-2');
    expect(service.hasChanges(original)).toBe(true);
    const next = await service.prepare(original);
    expect((next.document.data as Record<string, unknown>).assets).toMatchObject([{ name: 'typed while saving' }]);
    expect(next.bindings).toEqual([{ path: 'declared/0', source: { kind: 'existing', path: 'declared/0' } }]);
    expect((await service.list(original))[0]?.url).toBe('/asset/card/head-2/declared/0');
    service.accept(original, next, 'head-3');
    expect(service.hasChanges(original)).toBe(false);
    service.reset();
  });

  it('ignores a completed request after the user switches cards and prevents subscription reentry during initialization', async () => {
    const { service, transport } = fixture();
    const original = card('first');
    await service.add(original, new File(['one'], 'one.txt', { type: 'text/plain' }));
    const submitted = await service.prepare(original);
    service.reset();
    const next = card('second');
    await service.add(next, new File(['two'], 'two.txt', { type: 'text/plain' }));
    service.accept(original, submitted, 'irrelevant-head');
    expect((await service.list(next)).map((entry) => entry.name)).toEqual(['two']);
    expect(service.hasChanges(next)).toBe(true);
    service.reset();
    const listener = vi.fn(() => { void service.list(next); });
    const unsubscribe = service.subscribe(listener);
    await service.list(next);
    expect(listener).not.toHaveBeenCalled();
    expect(transport.list).toHaveBeenCalledTimes(3);
    unsubscribe(); service.reset();
  });

  it('surfaces missing asset metadata and permits a retry without fabricating an empty list', async () => {
    const { service, transport } = fixture();
    const original = card('card', [{ name: 'missing', uri: 'embedded://missing.txt' }]);
    await expect(service.list(original)).rejects.toThrow('Asset declared/0 is unavailable');
    vi.mocked(transport.list).mockResolvedValue([{ path: 'declared/0', mediaType: 'text/plain', byteLength: 1 }]);
    expect(await service.list(original)).toHaveLength(1);
    service.reset();
  });
});
