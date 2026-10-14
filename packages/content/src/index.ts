import { canonicalJson, hashBytes } from '@character-foundry/character-foundry/identity';
import { detectLorebookFormat, parseLorebook } from '@character-foundry/character-foundry/lorebook';
import type { JsonValue, UnityStore } from '@character-unity/store';
import { StoreError } from '@character-unity/store';
import { contentByteLimit, contentJson, contentKind, contentPolicy } from '@character-unity/store/content';
import type { ContentKind, ContentPolicy, ContentPublication, ContentStore } from '@character-unity/store/content';
import { ContentError } from './errors.js';
import { parseContentJson } from './json.js';

export { contentByteLimit, contentKinds } from '@character-unity/store/content';
export type { ContentKind, ContentPolicy, ContentRecord, ContentRevision, ContentSummary, ContentPublicationSummary } from '@character-unity/store/content';
export const contentIdentityAlgorithm = 'unity-json-content-v1';
export { ContentError } from './errors.js';
export { parseContentJson } from './json.js';
export interface ContentActor { id: string }
export interface ContentPreview {
  format: string; rawOnly: boolean; entryCount: number | null; reason: string | null;
  entries: { name: string; keys: string[]; content: string }[];
}
function decode(bytes: Uint8Array) {
  let text: string, json: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const roundtrip = new TextEncoder().encode(text);
    if (roundtrip.length !== bytes.length || !roundtrip.every((value,index) => value === bytes[index])) throw new Error();
    json = parseContentJson(text);
  } catch (error) { if (error instanceof ContentError) throw error; throw new ContentError('INVALID_INPUT', 'Choose valid, losslessly decodable UTF-8 JSON'); }
  return { text, json: snapshot(json as JsonValue) };
}
function snapshot(value: JsonValue): JsonValue { return JSON.parse(contentJson(value)) as JsonValue; }
function data(value: JsonValue) { return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }
function checkKind(kind: ContentKind, value: JsonValue) {
  const object = data(value);
  if (kind === 'persona' && !object) throw new ContentError('INVALID_INPUT', 'A persona must be a JSON object');
  if (kind === 'lorebook' && (!object || !(object.entries && typeof object.entries === 'object')
    && object.type !== 'risu' && object.ripiVersion === undefined && object.format !== 'wyvern' && object.wyvern === undefined)) {
    throw new ContentError('INVALID_INPUT', 'A standalone lorebook needs entries or an explicit supported format marker');
  }
}
async function identity(kind: ContentKind, value: JsonValue) {
  return hashBytes(new TextEncoder().encode(`${contentIdentityAlgorithm}\n${kind}\n${canonicalJson(value)}`));
}
function preview(kind: ContentKind, value: JsonValue): ContentPreview {
  const plain: ContentPreview = { format: 'json', rawOnly: true, entryCount: null, reason: null, entries: [] };
  if (kind !== 'lorebook') return plain;
  const format = detectLorebookFormat(value);
  if (!['ccv3','sillytavern','agnai'].includes(format)) return { ...plain, format, reason: 'This format is kept as raw JSON. Normalized editing is unavailable; no fields were converted or discarded.' };
  try {
    const object = data(value)!, raw = object.entries;
    const originals = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : [];
    const keysField = format === 'sillytavern' ? 'key' : format === 'agnai' ? 'keywords' : 'keys';
    const contentField = format === 'agnai' ? 'entry' : 'content';
    if (!originals.every((entry) => { const fields = data(entry); return fields && typeof fields[contentField] === 'string'
      && Array.isArray(fields[keysField]) && (fields[keysField] as JsonValue[]).every((key) => typeof key === 'string'); })) throw new Error();
    const parsed = parseLorebook(new TextEncoder().encode(JSON.stringify(value)));
    const entries = parsed.book.entries;
    if (!entries.every((entry) => typeof entry.content === 'string' && Array.isArray(entry.keys) && entry.keys.every((key) => typeof key === 'string'))) throw new Error();
    return { format, rawOnly: false, entryCount: entries.length, reason: null,
      entries: entries.slice(0,20).map((entry,index) => ({ name: typeof entry.name === 'string' ? entry.name.slice(0,200) : `Entry ${index+1}`,
        keys: (entry.keys ?? []).slice(0,20).map((key) => key.slice(0,200)), content: entry.content.slice(0,1000) })) };
  } catch { return { ...plain, format, reason: 'A normalized preview could not be verified. The complete original JSON remains available without conversion.' }; }
}
function sharedView(value: ContentPublication, actorId: string | null) {
  // Do not expose private workspace/document/revision identifiers or source bytes.
  return { id: value.id, kind: value.kind, title: value.revision.title, json: value.revision.json, hash: value.revision.hash,
    sequence: value.revision.sequence, parentId: value.parentId, createdAt: value.createdAt, policyVersion: value.policyVersion,
    visibility: value.visibility, allowFork: value.allowFork, allowOriginal: value.allowOriginal, owned: value.ownerId === actorId,
    preview: preview(value.kind,value.revision.json) };
}

/** Raw originals and native immutable JSON revisions share the existing Unity
 * database. Foundry previews lorebooks but never rewrites their stored shape. */
export function createContentService(workspaces: Pick<UnityStore,'getWorkspace'>, contents: ContentStore, options: { sharing?: boolean } = {}) {
  async function authorize(actorId: string, workspaceId: string) {
    if ((await workspaces.getWorkspace(workspaceId)).ownerId !== actorId) throw new ContentError('FORBIDDEN', 'Workspace belongs to another account');
  }
  async function owned<T>(actor: ContentActor, workspaceId: string, operation: (id: string) => Promise<T>) {
    const actorId = actor.id; await authorize(actorId,workspaceId);
    const result = await operation(actorId); await authorize(actorId,workspaceId); return result;
  }
  function sharing() { if (options.sharing === false) throw new ContentError('UNAVAILABLE', 'Content sharing requires a configured SQL host'); }
  return {
    list: (actor: ContentActor, workspaceId: string, options: Parameters<ContentStore['list']>[1] = {}) => owned(actor,workspaceId,() => contents.list(workspaceId,options)),
    async import(actor: ContentActor, workspaceId: string, inputKind: string, inputBytes: Uint8Array, filename: string, signal?: AbortSignal) {
      const kind = contentKind(inputKind), bytes = new Uint8Array(inputBytes), actorId = actor.id;
      if (bytes.length > contentByteLimit) throw new ContentError('TOO_LARGE','Standalone JSON imports are limited to 1 MiB');
      signal?.throwIfAborted(); await authorize(actorId,workspaceId);
      const fileHash = await hashBytes(bytes), known = await contents.findImport(workspaceId,kind,fileHash);
      if (known) { await authorize(actorId,workspaceId); return { created: false, record: known }; }
      const source = decode(bytes); checkKind(kind,source.json);
      const object = data(source.json), name = object?.name ?? object?.title;
      const title = typeof name === 'string' && name.trim() ? name.trim().slice(0,500) : filename.replace(/\.[^.]+$/,'').slice(0,500) || 'Untitled';
      const hash = await identity(kind,source.json); signal?.throwIfAborted(); await authorize(actorId,workspaceId);
      return contents.import({ workspaceId,kind,authorId: actorId,title,json: source.json,hash,source: { hash: fileHash,text: source.text,filename } });
    },
    async open(actor: ContentActor, workspaceId: string, id: string) {
      return owned(actor,workspaceId,async () => { const record = await contents.get(workspaceId,id); return { record,preview: preview(record.document.kind,record.revision.json) }; });
    },
    async revision(actor: ContentActor, workspaceId: string, id: string, revisionId: string) {
      return owned(actor,workspaceId,async () => { const current = await contents.get(workspaceId,id), revision = await contents.revision(workspaceId,id,revisionId);
        return { record: { document: current.document,revision },preview: preview(current.document.kind,revision.json) }; });
    },
    history: (actor: ContentActor, workspaceId: string, id: string, options: Parameters<ContentStore['history']>[2] = {}) => owned(actor,workspaceId,() => contents.history(workspaceId,id,options)),
    async save(actor: ContentActor, workspaceId: string, id: string, expectedHead: string, title: string, text: string) {
      const json = snapshot(parseContentJson(text)), actorId = actor.id; await authorize(actorId,workspaceId);
      const current = await contents.get(workspaceId,id); checkKind(current.document.kind,json);
      const hash = await identity(current.document.kind,json); await authorize(actorId,workspaceId);
      if (current.document.headRevisionId !== expectedHead || (await contents.get(workspaceId,id)).document.headRevisionId !== expectedHead) {
        throw new StoreError('HEAD_CONFLICT','The selected head changed; reload before saving');
      }
      if (hash === current.revision.hash && title === current.revision.title) return current.revision;
      return contents.save({ workspaceId,documentId: id,expectedHead,authorId: actorId,title,json,hash });
    },
    fork: (actor: ContentActor, workspaceId: string, id: string, revisionId: string) => owned(actor,workspaceId,(authorId) => contents.fork(workspaceId,id,revisionId,authorId)),
    remove: (actor: ContentActor, workspaceId: string, id: string) => owned(actor,workspaceId,() => contents.remove(workspaceId,id)),
    original: (actor: ContentActor, workspaceId: string, id: string) => owned(actor,workspaceId,async () => {
      const source = await contents.original(workspaceId,id); return { bytes: new TextEncoder().encode(source.text),filename: source.filename };
    }),
    export: (actor: ContentActor, workspaceId: string, id: string, revisionId: string) => owned(actor,workspaceId,async () => {
      const current = await contents.get(workspaceId,id), revision = await contents.revision(workspaceId,id,revisionId);
      return { bytes: new TextEncoder().encode(JSON.stringify(revision.json,null,2)),filename: `${current.document.kind}.json` };
    }),
    async publish(actor: ContentActor, workspaceId: string, id: string, revisionId: string, policy: ContentPolicy) {
      sharing(); const selectedPolicy = contentPolicy(policy);
      return owned(actor,workspaceId,async (actorId) => sharedView(await contents.publish(actorId,workspaceId,id,revisionId,selectedPolicy),actorId));
    },
    async shared(actor: ContentActor | null, options: Parameters<ContentStore['publications']>[1] = {}) { sharing(); return contents.publications(actor?.id ?? null,options); },
    async publication(actor: ContentActor | null, id: string) { sharing(); const actorId = actor?.id ?? null; return sharedView(await contents.publication(actorId,id),actorId); },
    async updatePublication(actor: ContentActor, id: string, expectedVersion: number, policy: ContentPolicy) {
      sharing(); const actorId = actor.id; return sharedView(await contents.updatePublication(actorId,id,expectedVersion,policy),actorId);
    },
    async publicationOriginal(actor: ContentActor | null, id: string) {
      sharing(); const source = await contents.publicationOriginal(actor?.id ?? null,id); return { bytes: new TextEncoder().encode(source.text),filename: source.filename };
    },
    async forkPublication(actor: ContentActor, workspaceId: string, id: string, expectedVersion: number) {
      sharing(); return owned(actor,workspaceId,(actorId) => contents.forkPublication(actorId,workspaceId,id,expectedVersion));
    },
  };
}
export type ContentService = ReturnType<typeof createContentService>;
