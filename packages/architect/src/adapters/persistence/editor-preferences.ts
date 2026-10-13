import type { Snippet, Template } from '../../lib/types';
import { defaultSnippets, defaultTemplates } from '../../lib/default-templates';

type PreferenceItem = { id: string; createdAt: string; updatedAt: string; isDefault?: boolean };
type ItemInput<T extends PreferenceItem> = Omit<T, 'id' | 'createdAt' | 'updatedAt'>;

/** Browser preferences keep their established keys; character data always uses Unity. */
class PreferenceCollection<T extends PreferenceItem> {
  constructor(private readonly key: string, private readonly defaults: readonly T[]) {}
  async list(): Promise<T[]> {
    const raw = localStorage.getItem(this.key);
    if (!raw) return structuredClone(this.defaults) as T[];
    const stored: unknown = JSON.parse(raw);
    if (!Array.isArray(stored)) throw new Error(`Invalid stored preferences: ${this.key}`);
    const custom = stored.filter((item): item is T => !!item && typeof item === 'object'
      && typeof item.id === 'string' && !item.isDefault);
    const overrides = new Set(custom.map((item) => item.id));
    return [...structuredClone(this.defaults).filter((item) => !overrides.has(item.id)), ...custom];
  }
  private write(items: readonly T[]) { localStorage.setItem(this.key, JSON.stringify(items)); }
  async create(input: ItemInput<T>): Promise<T> {
    const now = new Date().toISOString();
    const item = { ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now } as T;
    this.write([...(await this.list()), item]); return item;
  }
  async update(id: string, updates: Partial<ItemInput<T>>): Promise<T> {
    const items = await this.list();
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) throw new Error('Preference item not found');
    // Editing a shipped default creates a durable local override at the same id.
    const updated = { ...items[index], ...updates, isDefault: false, updatedAt: new Date().toISOString() } as T;
    items[index] = updated; this.write(items); return updated;
  }
  async delete(id: string) { this.write((await this.list()).filter((item) => item.id !== id)); }
  async reset(): Promise<T[]> { this.write([]); return structuredClone(this.defaults) as T[]; }
}

export class EditorPreferences {
  private readonly templates = new PreferenceCollection<Template>('ca-templates', defaultTemplates);
  private readonly snippets = new PreferenceCollection<Snippet>('ca-snippets', defaultSnippets);
  listTemplates() { return this.templates.list(); }
  createTemplate(input: ItemInput<Template>) { return this.templates.create(input); }
  updateTemplate(id: string, updates: Partial<ItemInput<Template>>) { return this.templates.update(id, updates); }
  deleteTemplate(id: string) { return this.templates.delete(id); }
  resetTemplates() { return this.templates.reset(); }
  listSnippets() { return this.snippets.list(); }
  createSnippet(input: ItemInput<Snippet>) { return this.snippets.create(input); }
  updateSnippet(id: string, updates: Partial<ItemInput<Snippet>>) { return this.snippets.update(id, updates); }
  deleteSnippet(id: string) { return this.snippets.delete(id); }
  resetSnippets() { return this.snippets.reset(); }
  async getSetting<T>(key: string): Promise<T | null> {
    const stored = localStorage.getItem(`ca-settings-${key}`);
    return stored === null ? null : JSON.parse(stored) as T;
  }
  async saveSetting<T>(key: string, value: T) { localStorage.setItem(`ca-settings-${key}`, JSON.stringify(value)); }
}
