import { describe, expect, it } from 'vitest';
import { exportExtension, tileExportFormats } from './export-formats';

describe('native tile export options', () => {
  it('only offers image-carried exports when the exact revision has a portrait', () => {
    expect(tileExportFormats(false).map((option) => option.value)).toEqual(['charx', 'json', 'sillytavern-json']);
    expect(tileExportFormats(true).map((option) => option.value)).toEqual(['png', 'charx', 'json', 'sillytavern-png', 'sillytavern-json']);
  });
  it('names the exported file by its actual container, not a compatibility label', () => {
    for (const option of tileExportFormats(true)) {
      expect(exportExtension(option.value)).toBe(option.value.endsWith('png') ? 'png' : option.value === 'charx' ? 'charx' : 'json');
    }
  });
});
