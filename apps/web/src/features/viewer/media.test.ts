import { describe, expect, it } from 'vitest';
import { safeImageSource } from './media';

describe('native viewer inline images', () => {
  it('resolves descriptor URIs only through exact stored revision bindings', () => {
    const stored = '/api/workspaces/library/cards/card/asset?revisionId=head&path=declared%2F0';
    expect(safeImageSource('https://old.invalid/image.png', { 'https://old.invalid/image.png': stored })).toBe(stored);
    expect(safeImageSource('https://old.invalid/other.png', {})).toBeNull();
    expect(safeImageSource('/unscoped-image.png', {})).toBeNull();
    expect(safeImageSource('ccdefault:', { 'ccdefault:': stored })).toBe(stored);
  });
  it('accepts inline raster data but not scripts, SVG, HTML, objects or inherited keys', () => {
    expect(safeImageSource('data:image/png;base64,aGVsbG8=', {})).toBe('data:image/png;base64,aGVsbG8=');
    for (const value of ['javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,PHNjcmlwdD4=', 'blob:unknown', 'toString', '__proto__']) {
      expect(safeImageSource(value, {})).toBeNull();
    }
  });
});
