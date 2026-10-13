import { defaultPresets } from './default-presets';
import { presetEditorSchema } from './schemas/settings/presets';
import type { UserPreset } from './types';

const key = 'ca-llm-presets';

function stored(): UserPreset[] {
  const input: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
  if (!Array.isArray(input)) throw new Error('Stored presets must be a list');
  return input.map((item: unknown) => {
    const data = presetEditorSchema.parse(item);
    const metadata = item as Record<string, unknown>;
    if (typeof metadata.id !== 'string') throw new Error('Stored preset has no ID');
    return { ...data, id: metadata.id, isBuiltIn: metadata.isBuiltIn === true,
      isHidden: metadata.isHidden === true, createdAt: String(metadata.createdAt ?? ''), updatedAt: String(metadata.updatedAt ?? '') };
  });
}

export function loadPresets(): UserPreset[] {
  const items = stored();
  return [
    ...defaultPresets.map((preset) => ({ ...preset, isHidden: items.find((item) => item.id === preset.id)?.isHidden ?? false })),
    ...items.filter((item) => !defaultPresets.some((preset) => preset.id === item.id)),
  ];
}

export function savePreset(input: Partial<UserPreset>): UserPreset {
  if (defaultPresets.some((preset) => preset.id === input.id)) throw new Error('Copy a built-in preset before editing it');
  const data = presetEditorSchema.parse(input);
  const items = stored();
  const previous = items.find((item) => item.id === input.id);
  const now = new Date().toISOString();
  const saved: UserPreset = { ...data, id: input.id || crypto.randomUUID(), isBuiltIn: false,
    isHidden: previous?.isHidden ?? false, createdAt: previous?.createdAt || now, updatedAt: now };
  localStorage.setItem(key, JSON.stringify([...items.filter((item) => item.id !== saved.id), saved]));
  return saved;
}

export function removePreset(id: string): void {
  if (defaultPresets.some((preset) => preset.id === id)) throw new Error('Built-in presets cannot be removed');
  localStorage.setItem(key, JSON.stringify(stored().filter((item) => item.id !== id)));
}

export function setPresetHidden(id: string, hidden: boolean): void {
  const preset = loadPresets().find((item) => item.id === id);
  if (!preset) throw new Error('Preset not found');
  localStorage.setItem(key, JSON.stringify([...stored().filter((item) => item.id !== id), { ...preset, isHidden: hidden }]));
}

export function importPresets(input: unknown): number {
  if (!Array.isArray(input)) throw new Error('Invalid preset file format');
  // Validate the whole file before replacing anything in browser storage.
  const candidates = input.filter((item) => item && typeof item === 'object' && item.isBuiltIn !== true)
    .map((item) => ({ ...presetEditorSchema.parse(item), id: typeof item.id === 'string' && item.id ? item.id : crypto.randomUUID() }));
  const items = stored(), ids = new Set([...defaultPresets, ...items].map((item) => item.id));
  const now = new Date().toISOString();
  let count = 0;
  for (const preset of candidates) {
    if (ids.has(preset.id)) continue;
    items.push({ ...preset, isBuiltIn: false, createdAt: now, updatedAt: now });
    ids.add(preset.id); count += 1;
  }
  localStorage.setItem(key, JSON.stringify(items));
  return count;
}
