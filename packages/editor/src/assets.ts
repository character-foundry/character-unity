import type { EditorDocument, EditorRevision } from './controller.js';

export interface EditorAssetBinding { path: string; source: { kind: 'existing'; path: string } | { kind: 'upload'; index: number } }
export interface EditorAssetSnapshot {
  revisionId: string;
  assets: { path: string; hash: string; byteLength: number; mediaType: string }[];
}
export interface EditorAssetPlan { bindings: EditorAssetBinding[]; files: Blob[] }
export interface EditorAssetPort {
  list(revisionId: string, signal: AbortSignal): Promise<EditorAssetSnapshot>;
  read(revisionId: string, path: string, signal: AbortSignal): Promise<Blob>;
  save(input: EditorRevision, plan: EditorAssetPlan): Promise<EditorRevision>;
}
export type AssetEdit = { kind: 'portrait' | 'add'; file: File } | { kind: 'replace'; index: number; file: File }
  | { kind: 'remove'; index: number } | { kind: 'remove-portrait' }
  | { kind: 'move'; index: number; delta: -1 | 1 } | { kind: 'metadata'; index: number; field: 'name' | 'type'; value: string };
export const rasterTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];
export function descriptors(document: EditorDocument): EditorDocument[] | null {
  const value = (document.data as EditorDocument).assets;
  if (value === undefined) return [];
  return Array.isArray(value) && value.every((item) => item && typeof item === 'object' && !Array.isArray(item) && typeof item.uri === 'string') ? value as EditorDocument[] : null;
}
export function initialAssetPlan(snapshot: EditorAssetSnapshot): EditorAssetPlan {
  return { bindings: snapshot.assets.map(({ path }) => ({ path, source: { kind: 'existing', path } })), files: [] };
}
/** Draft-only asset operations. Byte persistence, format rules and identity belong to the host/SDK. */
export function editAssets(input: EditorDocument, current: EditorAssetPlan, snapshot: EditorAssetSnapshot, edit: AssetEdit) {
  const document = structuredClone(input), plan = structuredClone(current);
  const found = descriptors(document);
  if (!found) throw new Error('These asset descriptors cannot be edited by this form.');
  const items = found;
  const data = document.data as EditorDocument;
  let portrait = plan.bindings.find((binding) => binding.path === 'portrait')?.source;
  const sources = items.map((_, index) => {
    const binding = plan.bindings.find((binding) => binding.path === `declared/${index}`);
    if (!binding) throw new Error('Reload the asset list before editing.');
    return binding.source;
  });
  const equal = (a: EditorAssetBinding['source'], b: EditorAssetBinding['source']) => a.kind === 'upload' && b.kind === 'upload'
    ? a.index === b.index : a.kind === 'existing' && b.kind === 'existing'
      && snapshot.assets.find((asset) => asset.path === a.path)?.hash === snapshot.assets.find((asset) => asset.path === b.path)?.hash;
  const primary = items.findIndex((item) => item.type === 'icon');
  const linked = items.map((item, index) => String(item.uri).trim().startsWith('ccdefault:') || (index === primary && !!portrait && equal(sources[index]!, portrait)));
  const extension = (file: File) => file.name.includes('.') ? file.name.split('.').at(-1)!.toLowerCase() : 'bin';
  function attach(file: File): EditorAssetBinding['source'] {
    if (!(file instanceof Blob) || file.size > 32 * 1024 * 1024) throw new Error('Choose assets totaling at most 32 MiB.');
    plan.files.push(file); return { kind: 'upload', index: plan.files.length - 1 };
  }
  function setPortrait(file: File) {
    if (!rasterTypes.includes(file.type)) throw new Error('Choose a PNG, JPEG, WebP, GIF or AVIF portrait.');
    portrait = attach(file);
    for (const [index, alias] of linked.entries()) if (alias) { sources[index] = portrait; items[index]!.ext = extension(file); }
    if (document.spec === 'chara_card_v3' && (primary < 0 || !linked[primary])) {
      items.unshift({ type: 'icon', name: 'main', ext: extension(file), uri: 'ccdefault:' }); sources.unshift(portrait);
    }
  }
  if ('index' in edit && (!Number.isSafeInteger(edit.index) || edit.index < 0 || edit.index >= items.length)) throw new Error('Asset is no longer in this draft.');
  switch (edit.kind) {
    case 'portrait': setPortrait(edit.file); break;
    case 'remove-portrait':
      portrait = undefined;
      for (let index = items.length - 1; index >= 0; index--) if (linked[index]) { items.splice(index, 1); sources.splice(index, 1); }
      break;
    case 'add':
      if (document.spec !== 'chara_card_v3') throw new Error('Adding declared attachments requires CCv3.');
      items.push({ type: 'custom', name: edit.file.name.replace(/\.[^.]*$/, '') || 'attachment', ext: extension(edit.file), uri: `embedded://assets/${crypto.randomUUID()}` });
      sources.push(attach(edit.file)); break;
    case 'replace':
      if (linked[edit.index]) setPortrait(edit.file);
      else { sources[edit.index] = attach(edit.file); items[edit.index]!.ext = extension(edit.file); }
      break;
    case 'remove': items.splice(edit.index, 1); sources.splice(edit.index, 1); break;
    case 'move': {
      const target = edit.index + edit.delta;
      if (target < 0 || target >= items.length) throw new Error('Cannot move this asset further.');
      [items[target], items[edit.index]] = [items[edit.index]!, items[target]!];
      [sources[target], sources[edit.index]] = [sources[edit.index]!, sources[target]!]; break;
    }
    case 'metadata':
      if (typeof edit.value !== 'string' || edit.value.length > 1024) throw new Error('Asset metadata must contain at most 1,024 characters.');
      items[edit.index]![edit.field] = edit.value; break;
  }
  if (items.length > 63) throw new Error('A card can have at most 63 declared assets.');
  if (items.length || Object.hasOwn(data, 'assets')) data.assets = items;
  plan.bindings = sources.map((source, index) => ({ path: `declared/${index}`, source }));
  if (portrait) plan.bindings.push({ path: 'portrait', source: portrait });
  const files: Blob[] = [], remapped = new Map<number, number>();
  for (const binding of plan.bindings) if (binding.source.kind === 'upload') {
    const previous = binding.source.index;
    if (!remapped.has(previous)) { remapped.set(previous, files.length); files.push(plan.files[previous]!); }
    binding.source = { kind: 'upload', index: remapped.get(previous)! };
  }
  plan.files = files;
  if (files.reduce((sum, file) => sum + file.size, 0) > 32 * 1024 * 1024) throw new Error('Choose assets totaling at most 32 MiB.');
  return { document, plan };
}
