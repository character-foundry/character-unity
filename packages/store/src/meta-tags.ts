import type { StoreDriver } from './driver.js';
import { StoreError } from './types.js';
import { text } from './validation.js';

export interface MetaTag { id: string; name: string; members: string[] }
export interface MetaTagCatalog { version: number; groups: MetaTag[] }
export interface MetaTagWrite { expectedVersion: number; groups: MetaTag[] }
export interface MetaTagSelection { metaTags?: readonly string[]; excludeMetaTags?: readonly string[] }
export interface ResolvedMetaTagFilters { tagGroups: string[][]; excludeTagGroups: string[][]; catalogVersion: number }
/** Save transport bound covers the entire validated catalog, including JSON escapes. */
export const metaTagCatalogByteLimit = 1024 * 1024;
export interface MetaTagStore {
  readMetaTags(workspaceId: string): Promise<MetaTagCatalog>;
  writeMetaTags(workspaceId: string, input: MetaTagWrite): Promise<MetaTagCatalog>;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const fold = (value: string) => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
function invalid(message: string): never { throw new StoreError('INVALID_INPUT', message); }
function fields(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid('Unexpected meta-tag fields');
}
function version(value: unknown, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) invalid('Expected a nonnegative safe meta-tag catalog version');
  return value;
}
function label(value: unknown, name: string) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 128
    || [...value].some((letter) => letter.charCodeAt(0) < 32 || letter.charCodeAt(0) === 127)) invalid(`${name} must be nonempty text of at most 128 characters`);
  return value.trim();
}
function id(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) invalid('Meta-tag IDs must be safe plaintext identifiers of at most 128 characters');
  return value;
}
/** Trim and snapshot every caller-owned value before any asynchronous work. */
function groups(input: unknown): MetaTag[] {
  if (!Array.isArray(input) || input.length > 100) invalid('A catalog may contain at most 100 meta-tag groups');
  const ids = new Set<string>(), names = new Set<string>(); let total = 0;
  return Array.from(input, (entry) => {
    if (!object(entry)) invalid('Expected a meta-tag group');
    fields(entry, ['id', 'name', 'members']);
    const groupId = id(entry.id), name = label(entry.name, 'Meta-tag name');
    if (ids.has(groupId) || names.has(fold(name))) invalid('Meta-tag IDs and case-insensitive names must be unique');
    ids.add(groupId); names.add(fold(name));
    if (!Array.isArray(entry.members) || !entry.members.length || entry.members.length > 100) invalid('Each meta-tag group requires 1–100 members');
    total += entry.members.length;
    if (total > 1000) invalid('A catalog may contain at most 1000 members');
    const seen = new Set<string>(), members: string[] = [];
    for (const input of entry.members) {
      const member = label(input, 'Meta-tag member'), key = fold(member);
      if (!seen.has(key)) { seen.add(key); members.push(member); }
    }
    return { id: groupId, name, members };
  });
}
export function validateMetaTagWrite(input: unknown): MetaTagWrite {
  if (!object(input)) invalid('Expected a meta-tag catalog replacement');
  fields(input, ['expectedVersion', 'groups']);
  return { expectedVersion: version(input.expectedVersion, Number.MAX_SAFE_INTEGER - 1), groups: groups(input.groups) };
}
export function validateMetaTagCatalog(input: unknown): MetaTagCatalog {
  if (!object(input)) invalid('Expected a meta-tag catalog');
  fields(input, ['version', 'groups']);
  return { version: version(input.version), groups: groups(input.groups) };
}
/** IDs select explicit groups only: no fuzzy matching or reverse alias expansion. */
export function resolveMetaTagFilters(catalogInput: MetaTagCatalog, selection: MetaTagSelection): ResolvedMetaTagFilters {
  const catalog = validateMetaTagCatalog(catalogInput);
  if (!object(selection)) invalid('Expected selected meta-tag IDs');
  fields(selection, ['metaTags', 'excludeMetaTags']);
  const selectedIds = (value: unknown) => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) invalid('Expected a list of selected meta-tag IDs');
    return value.map(id);
  };
  const selected = [selectedIds(selection.metaTags), selectedIds(selection.excludeMetaTags)];
  if (selected.reduce((count, values) => count + values.length, 0) > 20) invalid('Select at most 20 meta-tag groups');
  const available = new Map(catalog.groups.map((group) => [group.id, group])); let terms = 0;
  const resolve = (values: readonly string[]) => {
    const seenIds = new Set<string>(), result: string[][] = [];
    for (const selectedId of values) {
      const group = available.get(selectedId);
      if (!group) invalid('A selected meta-tag group is no longer in this workspace catalog');
      if (seenIds.has(selectedId)) continue;
      seenIds.add(selectedId);
      const seenTerms = new Set<string>(), resolved: string[] = [];
      for (const tag of [group.name, ...group.members]) if (!seenTerms.has(fold(tag))) { seenTerms.add(fold(tag)); resolved.push(tag); }
      terms += resolved.length;
      if (terms > 1000) invalid('Selected meta-tag groups expand to more than 1000 tag terms');
      result.push(resolved);
    }
    return result;
  };
  return { tagGroups: resolve(selected[0]!), excludeTagGroups: resolve(selected[1]!), catalogVersion: catalog.version };
}

/** Trusted metadata adapter. Reading an unused catalog never inserts a row. */
export function createMetaTagOperations(driver: StoreDriver): MetaTagStore {
  return {
    async readMetaTags(workspaceId) {
      workspaceId = text(workspaceId, 'workspaceId');
      const [row] = await driver.query<{ version: number | null; groups: string | null }>({ sql: `SELECT c.version,c.groups_json AS groups
        FROM unity_workspaces w LEFT JOIN unity_meta_tag_catalogs c ON c.workspace_id = w.id WHERE w.id = ?`, params: [workspaceId] });
      if (!row) throw new StoreError('NOT_FOUND', 'Workspace not found');
      if (row.version === null) return { version: 0, groups: [] };
      try { return validateMetaTagCatalog({ version: row.version, groups: JSON.parse(row.groups!) }); }
      catch (cause) { throw new StoreError('INTEGRITY', 'Stored meta-tag catalog is invalid', { cause }); }
    },
    async writeMetaTags(workspaceId, input) {
      workspaceId = text(workspaceId, 'workspaceId');
      const snapshot = validateMetaTagWrite(input), catalog = { version: snapshot.expectedVersion + 1, groups: snapshot.groups };
      const [changed] = await driver.batch([{ sql: `INSERT INTO unity_meta_tag_catalogs(workspace_id,version,groups_json)
        SELECT w.id,?,? FROM unity_workspaces w WHERE w.id = ? AND (? = 0 OR EXISTS
          (SELECT 1 FROM unity_meta_tag_catalogs existing WHERE existing.workspace_id = w.id AND existing.version = ?))
        ON CONFLICT(workspace_id) DO UPDATE SET version = excluded.version,groups_json = excluded.groups_json
          WHERE unity_meta_tag_catalogs.version = ?`,
      params: [catalog.version, JSON.stringify(catalog.groups), workspaceId, snapshot.expectedVersion, snapshot.expectedVersion, snapshot.expectedVersion] }]);
      if (changed !== 1) {
        const [workspace] = await driver.query({ sql: 'SELECT id FROM unity_workspaces WHERE id = ?', params: [workspaceId] });
        if (!workspace) throw new StoreError('NOT_FOUND', 'Workspace not found');
        throw new StoreError('HEAD_CONFLICT', 'The meta-tag catalog changed; reload before saving');
      }
      return catalog;
    },
  };
}
