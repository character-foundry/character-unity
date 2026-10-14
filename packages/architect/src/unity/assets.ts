import type { Card } from '../lib/types';

type Json = Record<string, unknown>;
type Source = { kind: 'existing'; path: string } | { kind: 'upload'; file: File };
export interface AssetMetadata { path: string; mediaType: string; byteLength: number }
export interface EditorAsset {
  id: string; path: string; name: string; type: string; ext?: string; tags?: string[];
  mediaType: string; byteLength: number; url: string; portrait: boolean; main: boolean;
}
export interface AssetTransport {
  head(cardId: string): string | undefined;
  list(cardId: string, revisionId: string): Promise<AssetMetadata[]>;
  url(cardId: string, revisionId: string, path: string): string;
}
interface Entry { id: string; descriptor: Json | null; source: Source; mediaType: string; byteLength: number; url: string }
export interface AssetPlan {
  document: Json;
  bindings: { path: string; source: { kind: 'existing'; path: string } | { kind: 'upload'; index: number } }[];
  uploads: File[];
  readonly version: number;
  readonly generation: number;
  readonly entries: readonly { id: string; path: string; source: Source }[];
}
const object = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback;
const sourceId = (card: Card) => card.meta.id || card.meta.forkOf || '';
const defaultPortrait = (entry: Entry) => string(entry.descriptor?.uri).startsWith('ccdefault:');
const mainIcon = (entry: Entry) => entry.descriptor?.type === 'icon' && entry.descriptor.name === 'main';
function descriptors(card: Card): Json[] {
  const document = card.data as unknown as Json;
  const data = document.data;
  if (!object(data)) throw new Error('Expected a wrapped character document');
  if (data.assets === undefined) return [];
  if (!Array.isArray(data.assets) || !data.assets.every(object)) throw new Error('Invalid character asset descriptors');
  return structuredClone(data.assets);
}
function fileType(file: File) {
  if (file.type) return file.type;
  const types: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm', txt: 'text/plain', json: 'application/json' };
  return types[file.name.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

/** One editor's unsaved bindings. Only the Save operation sends these bytes. */
export class EditorAssetService {
  private transport: AssetTransport;
  private key: string | null = null;
  private aliases = new Set<string>();
  private revision: string | undefined;
  private entries: Entry[] = [];
  private loading: Promise<void> | null = null;
  private generation = 0;
  private version = 0;
  private savedVersion = 0;
  private listeners = new Set<() => void>();
  private urls = new Set<string>();
  constructor(transport: AssetTransport) { this.transport = transport; }
  configure(transport: AssetTransport) { this.reset(); this.transport = transport; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.version;
  private emit() { this.version++; for (const listener of this.listeners) listener(); }
  private pruneUrls() {
    const used = new Set(this.entries.map((entry) => entry.url));
    for (const url of this.urls) if (!used.has(url)) { URL.revokeObjectURL(url); this.urls.delete(url); }
  }
  reset(notify = true) {
    this.generation++;
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls.clear(); this.key = null; this.aliases.clear(); this.revision = undefined; this.entries = []; this.loading = null;
    if (notify) this.emit(); this.savedVersion = this.version;
  }
  private matches(card: Card) { return this.key === sourceId(card) || this.aliases.has(sourceId(card)); }
  hasChanges(card: Card) { return this.matches(card) && this.version !== this.savedVersion; }
  private async ensure(card: Card) {
    const key = sourceId(card);
    if (this.matches(card)) { await this.loading; return; }
    this.reset(false); this.key = key;
    const generation = this.generation;
    const declared = descriptors(card);
    this.revision = key ? this.transport.head(key) : undefined;
    if (key && !this.revision) { this.key = null; throw new Error('Reload this card before editing assets'); }
    this.loading = (async () => {
      const assets = key ? await this.transport.list(key, this.revision!) : [];
      if (generation !== this.generation) throw new Error('The editor changed while assets were loading');
      const metadata = new Map(assets.map((asset) => [asset.path, asset]));
      const entries: Entry[] = [];
      const append = (path: string, descriptor: Json | null) => {
        const asset = metadata.get(path);
        if (!asset) throw new Error(`Asset ${path} is unavailable in this revision`);
        entries.push({ id: path, descriptor, source: { kind: 'existing', path }, mediaType: asset.mediaType,
          byteLength: asset.byteLength, url: this.transport.url(key, this.revision!, path) });
      };
      if (metadata.has('portrait')) append('portrait', null);
      declared.forEach((descriptor, index) => append(`declared/${index}`, descriptor));
      this.entries = entries;
    })();
    try { await this.loading; }
    catch (error) { if (generation === this.generation) this.key = null; throw error; }
    finally { if (generation === this.generation) this.loading = null; }
  }
  private selected(card: Card, id: string) {
    if (!this.matches(card) || this.loading) throw new Error('Load this card’s assets first');
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) throw new Error('This asset is no longer in the draft');
    return entry;
  }
  async list(card: Card): Promise<EditorAsset[]> {
    await this.ensure(card);
    let index = 0;
    return this.entries.map((entry) => {
      const portrait = entry.descriptor === null;
      const name = string(entry.descriptor?.name, portrait ? 'Portrait' : 'Untitled asset');
      const type = string(entry.descriptor?.type, portrait ? 'icon' : 'custom');
      return { id: entry.id, path: portrait ? 'portrait' : `declared/${index++}`, name, type,
        ext: string(entry.descriptor?.ext, entry.mediaType.split('/')[1]),
        tags: Array.isArray(entry.descriptor?.tags) ? entry.descriptor.tags.filter((tag): tag is string => typeof tag === 'string') : [],
        mediaType: entry.mediaType, byteLength: entry.byteLength, url: entry.url, portrait,
        main: portrait || name === 'main' };
    });
  }
  /** Exact draft descriptors resolve to owned/stored sources, never arbitrary
   * authored URLs. Reading this map neither downloads bytes nor changes a draft. */
  async imageSources(card: Card): Promise<Record<string, string>> {
    await this.ensure(card);
    const sources: Record<string, string> = Object.create(null);
    const ambiguous = new Set<string>();
    const raster = (entry: Entry) => /^image\/(png|jpeg|gif|webp|avif|bmp)$/i.test(entry.mediaType);
    const portrait = this.entries.find((entry) => entry.descriptor === null && raster(entry));
    if (portrait) sources['ccdefault:'] = portrait.url;
    for (const entry of this.entries) {
      const uri = string(entry.descriptor?.uri);
      if (!uri || !raster(entry) || (uri === 'ccdefault:' && portrait) || ambiguous.has(uri)) continue;
      if (Object.hasOwn(sources, uri) && sources[uri] !== entry.url) { delete sources[uri]; ambiguous.add(uri); }
      else sources[uri] = entry.url;
    }
    return sources;
  }
  private uploaded(file: File, descriptor: Json | null): Entry {
    const mediaType = fileType(file);
    const normalized = file.type === mediaType ? file : new File([file], file.name, { type: mediaType });
    const url = URL.createObjectURL(normalized); this.urls.add(url);
    return { id: crypto.randomUUID(), descriptor, source: { kind: 'upload', file: normalized }, mediaType, byteLength: file.size, url };
  }
  async add(card: Card, file: File, options: { name?: string; type?: string; main?: boolean; tags?: string[] } = {}) {
    await this.ensure(card);
    if (this.entries.filter((entry) => entry.descriptor).length >= 8191) throw new Error('A card can contain at most 8191 declared assets');
    const extension = file.name.includes('.') ? file.name.split('.').at(-1)! : '';
    const entry = this.uploaded(file, { name: options.name?.trim() || file.name.replace(/\.[^.]+$/, ''), type: options.type || 'custom',
      ext: extension, uri: `embedded://unity/${crypto.randomUUID()}${extension ? `.${extension}` : ''}`,
      ...(options.tags?.length ? { tags: [...options.tags] } : {}) });
    this.entries.push(entry);
    if (options.main && entry.descriptor?.type === 'icon') await this.setPortrait(card, entry.id);
    else if (options.main && entry.descriptor?.type === 'background') this.setMainBackground(card, entry.id);
    else this.emit();
    return entry.id;
  }
  update(card: Card, id: string, updates: { name?: string; type?: string; tags?: string[] }) {
    const entry = this.selected(card, id);
    if (!entry.descriptor) throw new Error('Use the portrait control to replace the portrait');
    if (updates.name !== undefined && !updates.name.trim()) throw new Error('An asset name cannot be empty');
    entry.descriptor = { ...entry.descriptor, ...updates, ...(updates.tags ? { tags: [...updates.tags] } : {}) }; this.emit();
  }
  remove(card: Card, id: string) {
    const entry = this.selected(card, id);
    this.entries = this.entries.filter((item) => item !== entry && (entry.descriptor !== null || (!defaultPortrait(item) && !mainIcon(item))));
    this.pruneUrls(); this.emit();
  }
  async setPortrait(card: Card, source: File | string | null, signal?: AbortSignal) {
    signal?.throwIfAborted();
    await this.ensure(card);
    signal?.throwIfAborted();
    const previous = this.entries.find((entry) => entry.descriptor === null);
    if (source === null) { if (previous) this.remove(card, previous.id); return; }
    if (typeof source !== 'string' && !fileType(source).startsWith('image/')) throw new Error('The portrait must be an image');
    const selected = typeof source === 'string' ? this.selected(card, source) : this.uploaded(source, null);
    if (!selected.mediaType.startsWith('image/')) throw new Error('The portrait must be an image');
    const portrait: Entry = { ...selected, id: previous?.id ?? crypto.randomUUID(), descriptor: null };
    this.entries = [portrait, ...this.entries.filter((entry) => entry !== previous)];
    const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
    const ext = extensions[portrait.mediaType] ?? portrait.mediaType.split('/')[1];
    let hasMain = false;
    for (const entry of this.entries) if (defaultPortrait(entry) || mainIcon(entry)) {
      hasMain ||= mainIcon(entry);
      entry.source = portrait.source; entry.url = portrait.url; entry.mediaType = portrait.mediaType; entry.byteLength = portrait.byteLength;
      entry.descriptor = { ...entry.descriptor, uri: 'ccdefault:', ext };
    }
    // CharX carries its container portrait through the declared main icon.
    if ((card.data as unknown as Json).spec === 'chara_card_v3' && !hasMain) {
      this.entries.push({ ...portrait, id: crypto.randomUUID(), descriptor: { type: 'icon', name: 'main', ext, uri: 'ccdefault:' } });
    }
    this.pruneUrls(); this.emit();
  }
  setMainBackground(card: Card, id: string) {
    const chosen = this.selected(card, id);
    if (chosen.descriptor?.type !== 'background') throw new Error('Choose a background asset');
    for (const entry of this.entries) if (entry.descriptor?.type === 'background') {
      if (entry === chosen) entry.descriptor = { ...entry.descriptor, name: 'main' };
      else if (entry.descriptor.name === 'main') entry.descriptor = { ...entry.descriptor, name: 'background' };
    }
    this.emit();
  }
  async prepare(card: Card): Promise<AssetPlan> {
    await this.ensure(card);
    const document = structuredClone(card.data) as unknown as Json;
    const data = document.data as Json;
    const declared = this.entries.filter((entry) => entry.descriptor !== null);
    if (declared.length || Object.hasOwn(data, 'assets')) data.assets = declared.map((entry) => structuredClone(entry.descriptor));
    const uploads: File[] = [], indexes = new Map<File, number>();
    let index = 0;
    const entries = this.entries.map((entry) => ({ id: entry.id, path: entry.descriptor === null ? 'portrait' : `declared/${index++}`, source: entry.source }));
    const bindings = entries.map(({ path, source }) => {
      if (source.kind === 'existing') return { path, source: { ...source } };
      let uploadIndex = indexes.get(source.file);
      if (uploadIndex === undefined) { uploadIndex = uploads.length; indexes.set(source.file, uploadIndex); uploads.push(source.file); }
      return { path, source: { kind: 'upload' as const, index: uploadIndex } };
    });
    return { document, bindings, uploads, version: this.version, generation: this.generation, entries };
  }
  /** Successful Save rebases surviving draft bindings without discarding in-flight edits. */
  accept(card: Card, plan: AssetPlan, revisionId: string) {
    if (plan.generation !== this.generation) return;
    if (this.key !== null && this.key !== sourceId(card)) this.aliases.add(this.key);
    this.key = sourceId(card); this.revision = revisionId;
    const submittedEntries = new Map(plan.entries.map((entry) => [entry.id, entry]));
    for (const entry of this.entries) {
      const submitted = submittedEntries.get(entry.id);
      if (!submitted || entry.source !== submitted.source) continue;
      entry.source = { kind: 'existing', path: submitted.path };
      entry.url = this.transport.url(card.meta.id, revisionId, submitted.path);
    }
    this.pruneUrls();
    this.savedVersion = plan.version;
    // Updating URLs is observable but does not turn a clean draft dirty.
    const clean = this.version === this.savedVersion;
    this.emit(); if (clean) this.savedVersion = this.version;
  }
}

export function assetPlanForm(plan: AssetPlan, expectedHead?: string): FormData {
  const form = new FormData();
  form.set('input', JSON.stringify({ ...(expectedHead ? { expectedHead } : {}), document: plan.document, bindings: plan.bindings }));
  plan.uploads.forEach((file, index) => form.set(`file:${index}`, file));
  return form;
}
