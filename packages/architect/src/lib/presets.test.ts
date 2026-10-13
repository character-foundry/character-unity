import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPresets, savePreset, removePreset, setPresetHidden, importPresets } from './presets';

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('native browser editor presets', () => {
  it('persists custom edits without replacing built-in defaults', () => {
    const defaults = loadPresets();
    const saved = savePreset({ name: 'Custom', instruction: 'Shorten the text', category: 'rewrite' });
    const changed = savePreset({ ...saved, instruction: 'Expand the text' });
    expect(changed.id).toBe(saved.id);
    expect(changed.createdAt).toBe(saved.createdAt);
    expect(loadPresets()).toHaveLength(defaults.length + 1);
    expect(loadPresets().find((item) => item.id === saved.id)?.instruction).toBe('Expand the text');
    removePreset(saved.id);
    expect(loadPresets()).toEqual(defaults);
  });

  it('persists visibility for both built-in and custom presets', () => {
    const builtin = loadPresets()[0]!;
    const custom = savePreset({ name: 'Custom', instruction: 'Rewrite', category: 'custom' });
    setPresetHidden(builtin.id, true); setPresetHidden(custom.id, true);
    expect(loadPresets().find((item) => item.id === builtin.id)?.isHidden).toBe(true);
    expect(loadPresets().find((item) => item.id === custom.id)?.isHidden).toBe(true);
    setPresetHidden(builtin.id, false);
    expect(loadPresets().filter((item) => item.id === builtin.id)).toHaveLength(1);
    expect(() => savePreset(builtin)).toThrow('Copy a built-in preset');
    expect(() => removePreset(builtin.id)).toThrow('Built-in presets');
  });

  it('validates imports before writes and deduplicates within a file and against storage', () => {
    const input = { id: 'imported', name: 'Import', instruction: 'Rewrite', category: 'custom' };
    const before = localStorage.getItem('ca-llm-presets');
    expect(() => importPresets([input, { name: 'Broken' }])).toThrow();
    expect(localStorage.getItem('ca-llm-presets')).toBe(before);
    expect(importPresets([input, input])).toBe(1);
    expect(importPresets([input])).toBe(0);
    expect(loadPresets().filter((item) => item.id === 'imported')).toHaveLength(1);
  });
});
