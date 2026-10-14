import { ArchiveError } from '@character-unity/archive-client/contract';
import type { SearchFilterField } from '@character-unity/archive-client';
import { StoreError } from '@character-unity/store';
import { fold, normalizeTagGroupFilters } from '@character-unity/store/library-query';

export interface TagGroupFilter {
  tags?: readonly string[] | undefined;
  tagMode?: 'all' | 'any' | undefined;
  exclude?: readonly string[] | undefined;
  tagGroups?: readonly (readonly string[])[] | undefined;
  excludeTagGroups?: readonly (readonly string[])[] | undefined;
}

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
function literals(values: readonly string[] | undefined): string[] {
  if (values !== undefined && (!Array.isArray(values) || values.some((value) => typeof value !== 'string'))) {
    throw new ArchiveError('INVALID_INPUT', 'Tag filters require lists of strings');
  }
  return [...new Set((values ?? []).map((value) => fold(value.trim())).filter(Boolean))];
}

/** Balanced expressions keep the supported thousand-member filter shallow in
 * Lance's parser, independently of the caller-owned typed filter grammar. */
function combine(values: readonly string[], operator: 'AND' | 'OR'): string {
  if (!values.length) return '';
  if (values.length === 1) return values[0]!;
  const middle = Math.floor(values.length / 2);
  return `(${combine(values.slice(0, middle), operator)} ${operator} ${combine(values.slice(middle), operator)})`;
}

/** Trusted generated SQL only: column names come from the physical supported
 * schema and every member is an escaped literal. Do not reparse this through
 * compileSearchFilter: its smaller budget belongs to user-authored expressions. */
export function compileTagGroupFilter(query: TagGroupFilter, fields: readonly SearchFilterField[]): string {
  let groups: ReturnType<typeof normalizeTagGroupFilters>;
  try { groups = normalizeTagGroupFilters(query); }
  catch (error) {
    if (error instanceof StoreError) throw new ArchiveError('INVALID_INPUT', error.message);
    throw error;
  }
  const include = literals(query.tags), exclude = literals(query.exclude);
  if (!include.length && !exclude.length && !groups.tagGroups.length && !groups.excludeTagGroups.length) return '';
  const column = ['topics', 'tags'].find((name) => fields.some((field) => field.name === name && field.type === 'strings'));
  if (!column) throw new ArchiveError('UNAVAILABLE', 'This search index has no supported tag-membership list field');
  const member = (value: string) => `coalesce(array_contains(${column}, ${quote(value)}), false)`;
  const included = [...include.map(member), ...groups.tagGroups.map((group) => combine(group.map(member), 'OR'))];
  const excluded = [...exclude, ...groups.excludeTagGroups.flat()].map(member);
  return combine([combine(included, query.tagMode === 'any' ? 'OR' : 'AND'),
    excluded.length ? `NOT (${combine(excluded, 'OR')})` : ''].filter(Boolean), 'AND');
}
