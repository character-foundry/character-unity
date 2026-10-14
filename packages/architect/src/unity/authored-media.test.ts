import { afterEach, describe, expect, it, vi } from 'vitest';
import { authoredImageSources, createAuthoredImageResolver, inlineRaster, unavailableImage } from './authored-media';

afterEach(() => vi.restoreAllMocks());

describe('authored editor image boundary', () => {
  it('never fetches unbound remote, API, protocol-relative, SVG, or arbitrary blob URIs', async () => {
    const resource = vi.fn(async () => new Blob(['image'], { type: 'image/png' }));
    const resolver = createAuthoredImageResolver({}, resource, new AbortController().signal);
    for (const source of ['https://remote.invalid/track.png', '/api/private/image', '//remote.invalid/track.png', 'blob:unowned', 'javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=', 'toString', '__proto__']) {
      expect(await resolver.resolve(source)).toBeNull();
    }
    expect(resource).not.toHaveBeenCalled(); resolver.dispose();
  });

  it('resolves only exact stored bindings through captured transport, shares reads and revokes owned URLs', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:protected');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const path = '/api/workspaces/owned/cards/card/asset?revisionId=sealed&path=declared%2F0';
    const bindings = { 'https://old.invalid/stored.png': path, 'embedded://same.png': path, 'embedded://staged.png': 'blob:staged' };
    const resource = vi.fn(async () => new Blob(['image'], { type: 'image/png' }));
    const resolver = createAuthoredImageResolver(bindings, resource, new AbortController().signal);
    expect(await resolver.resolve('https://old.invalid/stored.png')).toBe('blob:protected');
    expect(await resolver.resolve('embedded://same.png')).toBe('blob:protected');
    expect(await resolver.resolve('embedded://staged.png')).toBe('blob:staged');
    expect(resource).toHaveBeenCalledTimes(1); expect(resource).toHaveBeenCalledWith(path, expect.any(AbortSignal));
    expect(bindings['https://old.invalid/stored.png']).toBe(path); expect(create).toHaveBeenCalledTimes(1);
    resolver.dispose(); expect(revoke).toHaveBeenCalledWith('blob:protected'); expect(revoke).not.toHaveBeenCalledWith('blob:staged');
  });

  it('accepts inline raster data without transport but rejects non-raster stored responses', async () => {
    const resource = vi.fn(async () => new Blob(['<svg/>'], { type: 'image/svg+xml' }));
    const resolver = createAuthoredImageResolver({ stored: '/api/stored' }, resource, new AbortController().signal);
    expect(inlineRaster(unavailableImage)).toBe(true);
    expect(await resolver.resolve(unavailableImage)).toBe(unavailableImage);
    expect(resource).not.toHaveBeenCalled(); expect(await resolver.resolve('stored')).toBeNull(); resolver.dispose();
  });

  it('cancels delayed reads before publishing blob URLs', async () => {
    let complete!: (value: Blob) => void;
    const create = vi.spyOn(URL, 'createObjectURL');
    const resolver = createAuthoredImageResolver({ stored: '/api/stored' }, () => new Promise<Blob>((resolve) => { complete = resolve; }), new AbortController().signal);
    const pending = resolver.resolve('stored'); resolver.dispose(); complete(new Blob(['image'], { type: 'image/png' }));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); expect(create).not.toHaveBeenCalled();
  });

  it('collects markdown inline, block and reference-image identifiers without rewriting authored text', () => {
    const markdown = '![inline](embedded://one.png)\n\n![block](https://old.invalid/two.png)\n\n![ref][portrait]\n\n[portrait]: ccdefault:';
    expect(authoredImageSources(markdown)).toEqual(['ccdefault:', 'embedded://one.png', 'https://old.invalid/two.png']);
    expect(markdown).toContain('https://old.invalid/two.png');
  });
});
