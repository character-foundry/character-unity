import { StoreError } from './types.js';

/**
 * Library search shared by every store driver. A query is parsed once into a small tree, then compiled to
 * SQL (SQLite/D1) or evaluated in JS (IndexedDB) with the same meaning. Text matching is a case-insensitive
 * substring test with ASCII-only folding, which is what SQLite's lower() does.
 *
 * Syntax: words (all must match), "quoted phrases", OR, NOT / -word, parentheses, and field filters
 * name: creator: (author:) description: (desc:) tag: (tags:, exact tag). Plain words search name, creator,
 * description, creator notes, personality, scenario, first message and tags.
 */
export type QueryField = 'text' | 'name' | 'creator' | 'description' | 'tag';
export type QueryNode =
  | { kind: 'term'; field: QueryField; value: string }
  | { kind: 'and' | 'or'; nodes: QueryNode[] }
  | { kind: 'not'; node: QueryNode };

export const librarySorts = ['edited', 'added', 'oldest', 'name', 'name_desc', 'revisions', 'forks', 'greetings', 'lorebook'] as const;
export type LibrarySort = typeof librarySorts[number];
export const libraryFlags = ['lorebook', 'greetings', 'assets', 'portrait'] as const;
export type LibraryFlag = typeof libraryFlags[number];
export function isLibrarySort(value: string): value is LibrarySort { return (librarySorts as readonly string[]).includes(value); }
export function isLibraryFlag(value: string): value is LibraryFlag { return (libraryFlags as readonly string[]).includes(value); }

const fields: Record<string, QueryField> = { name: 'name', creator: 'creator', author: 'creator', description: 'description', desc: 'description', tag: 'tag', tags: 'tag' };
const maxTerms = 32;

export function fold(value: string): string { return value.replace(/[A-Z]/g, (char) => char.toLowerCase()); }

type Token = { type: 'open' | 'close' | 'or' | 'and' | 'not' } | { type: 'term'; field: QueryField; value: string; negated: boolean };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const readValue = (): string => {
    if (input[index] === '"') {
      const end = input.indexOf('"', index + 1);
      const value = input.slice(index + 1, end === -1 ? input.length : end);
      index = end === -1 ? input.length : end + 1;
      return value;
    }
    const start = index;
    // `field:"a phrase"` stops before the quote so the phrase is read as the value.
    while (index < input.length && !/[\s()]/.test(input[index]!) && !(input[index] === '"' && input[index - 1] === ':')) index++;
    return input.slice(start, index);
  };
  while (index < input.length) {
    const char = input[index]!;
    if (/\s/.test(char)) { index++; continue; }
    if (char === '(') { tokens.push({ type: 'open' }); index++; continue; }
    if (char === ')') { tokens.push({ type: 'close' }); index++; continue; }
    let negated = false;
    if (char === '-' && index + 1 < input.length && !/[\s)]/.test(input[index + 1]!)) {
      negated = true; index++;
      if (input[index] === '(') { tokens.push({ type: 'not' }); continue; }
    }
    const quoted = input[index] === '"';
    const raw = readValue();
    if (!quoted && !negated) {
      if (raw === 'OR' || raw === '|') { tokens.push({ type: 'or' }); continue; }
      if (raw === 'AND' || raw === '&') { tokens.push({ type: 'and' }); continue; }
      if (raw === 'NOT') { tokens.push({ type: 'not' }); continue; }
    }
    let field: QueryField = 'text', value = raw;
    const colon = quoted ? -1 : raw.indexOf(':');
    if (colon > 0 && fields[raw.slice(0, colon).toLowerCase()]) {
      field = fields[raw.slice(0, colon).toLowerCase()]!;
      value = raw.slice(colon + 1);
      if (value === '' && input[index] === '"') value = readValue();
    }
    if (value.trim()) tokens.push({ type: 'term', field, value: value.trim(), negated });
  }
  return tokens;
}

/** Parses a search box query. Unbalanced parentheses and dangling operators are tolerated, not errors. */
export function parseLibraryQuery(input: string): QueryNode | null {
  const tokens = tokenize(input);
  if (tokens.filter((token) => token.type === 'term').length > maxTerms) throw new StoreError('INVALID_INPUT', `A search can have at most ${maxTerms} terms`);
  let position = 0;
  const peek = () => tokens[position];
  function primary(): QueryNode | null {
    const token = tokens[position++];
    if (!token) return null;
    if (token.type === 'term') {
      const term: QueryNode = { kind: 'term', field: token.field, value: token.value };
      return token.negated ? { kind: 'not', node: term } : term;
    }
    if (token.type === 'not') { const node = primary(); return node ? { kind: 'not', node } : null; }
    if (token.type === 'open') {
      const node = or();
      if (peek()?.type === 'close') position++;
      return node;
    }
    return null; // stray operator or close: skip it
  }
  function and(): QueryNode | null {
    const nodes: QueryNode[] = [];
    while (position < tokens.length) {
      const next = peek()!;
      if (next.type === 'or' || next.type === 'close') break;
      if (next.type === 'and') { position++; continue; }
      const node = primary();
      if (node) nodes.push(node);
    }
    return nodes.length === 0 ? null : nodes.length === 1 ? nodes[0]! : { kind: 'and', nodes };
  }
  function or(): QueryNode | null {
    const nodes: QueryNode[] = [];
    for (;;) {
      const node = and();
      if (node) nodes.push(node);
      if (peek()?.type !== 'or') break;
      position++;
    }
    return nodes.length === 0 ? null : nodes.length === 1 ? nodes[0]! : { kind: 'or', nodes };
  }
  let root: QueryNode | null = null;
  while (position < tokens.length) {
    const node = or();
    if (node) root = root ? { kind: 'and', nodes: [root, node] } : node;
    if (position < tokens.length) position++; // stray close paren at the top level
  }
  return root;
}

// ---- SQL ----------------------------------------------------------------------------------------------

const doc = 'r.document_json';
const str = (path: string) => `lower(CASE WHEN json_type(${doc}, '${path}') = 'text' THEN json_extract(${doc}, '${path}') ELSE '' END)`;
const textPaths = ['$.data.name', '$.data.creator', '$.data.description', '$.data.creator_notes', '$.data.personality', '$.data.scenario', '$.data.first_mes'];
const tagValues = `(SELECT group_concat(lower(t.value), char(10)) FROM json_each(${doc}, '$.data.tags') t WHERE t.type = 'text')`;
const searchText = `(${[...textPaths.map(str), `coalesce(${tagValues}, '')`].join(` || char(10) || `)})`;
const hasTag = (placeholders: string) => `EXISTS (SELECT 1 FROM json_each(${doc}, '$.data.tags') t WHERE t.type = 'text' AND lower(t.value) IN (${placeholders}))`;
const arrayLength = (path: string) => `coalesce(CASE WHEN json_type(${doc}, '${path}') = 'array' THEN json_array_length(${doc}, '${path}') END, 0)`;
const blank = ` ' ' || char(9) || char(10) || char(13)`;
const greetings = `((CASE WHEN trim(${str('$.data.first_mes')},${blank}) <> '' THEN 1 ELSE 0 END) + ${arrayLength('$.data.alternate_greetings')} + ${arrayLength('$.data.group_only_greetings')})`;

function termSql(node: Extract<QueryNode, { kind: 'term' }>, params: string[]): string {
  const value = fold(node.value);
  params.push(value);
  switch (node.field) {
    case 'tag': return hasTag('?');
    case 'name': return `instr(${str('$.data.name')}, ?) > 0`;
    case 'creator': return `instr(${str('$.data.creator')}, ?) > 0`;
    case 'description': return `instr(${str('$.data.description')}, ?) > 0`;
    default: return `instr(${searchText}, ?) > 0`;
  }
}
function nodeSql(node: QueryNode, params: string[]): string {
  if (node.kind === 'term') return termSql(node, params);
  if (node.kind === 'not') return `NOT (${nodeSql(node.node, params)})`;
  return `(${node.nodes.map((child) => nodeSql(child, params)).join(node.kind === 'and' ? ' AND ' : ' OR ')})`;
}

export interface LibraryFilter {
  q?: string | undefined;
  /** Exact tags, case-insensitive. `tagMode` decides whether a card needs all or any of them. */
  tags?: readonly string[] | undefined;
  tagMode?: 'all' | 'any' | undefined;
  excludeTags?: readonly string[] | undefined;
  has?: readonly LibraryFlag[] | undefined;
  fork?: 'only' | 'none' | undefined;
}

function cleanTags(tags: readonly string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((tag) => fold(tag.trim())).filter(Boolean))];
}

/** WHERE fragments over `c` (unity_cards) joined to `r` (its head revision). */
export function libraryFilterSql(filter: LibraryFilter): { where: string[]; params: string[] } {
  const where: string[] = [], params: string[] = [];
  const query = parseLibraryQuery(filter.q ?? '');
  if (query) where.push(nodeSql(query, params));
  const include = cleanTags(filter.tags);
  if (include.length) {
    if (filter.tagMode === 'any') { where.push(hasTag(include.map(() => '?').join(', '))); params.push(...include); }
    else for (const tag of include) { where.push(hasTag('?')); params.push(tag); }
  }
  const exclude = cleanTags(filter.excludeTags);
  if (exclude.length) { where.push(`NOT ${hasTag(exclude.map(() => '?').join(', '))}`); params.push(...exclude); }
  for (const flag of new Set(filter.has ?? [])) {
    if (flag === 'lorebook') where.push(`${arrayLength('$.data.character_book.entries')} > 0`);
    else if (flag === 'greetings') where.push(`${arrayLength('$.data.alternate_greetings')} > 0`);
    else if (flag === 'portrait') where.push(`EXISTS (SELECT 1 FROM unity_revision_assets a WHERE a.revision_id = r.id AND a.path = 'portrait')`);
    else where.push(`EXISTS (SELECT 1 FROM unity_revision_assets a WHERE a.revision_id = r.id AND a.path <> 'portrait')`);
  }
  if (filter.fork === 'only') where.push('c.forked_from_revision_id IS NOT NULL');
  else if (filter.fork === 'none') where.push('c.forked_from_revision_id IS NULL');
  return { where, params };
}

/** ORDER BY for the summaries query; `forkCount` is a select alias. Allowlisted, never interpolated input. */
export const librarySortSql: Record<LibrarySort, string> = {
  edited: 'r.created_at DESC, c.id',
  added: 'c.created_at DESC, c.id',
  oldest: 'c.created_at ASC, c.id',
  name: `${str('$.data.name')} ASC, c.id`,
  name_desc: `${str('$.data.name')} DESC, c.id`,
  revisions: 'r.sequence DESC, r.created_at DESC, c.id',
  forks: 'forkCount DESC, r.created_at DESC, c.id',
  greetings: `${greetings} DESC, r.created_at DESC, c.id`,
  lorebook: `${arrayLength('$.data.character_book.entries')} DESC, r.created_at DESC, c.id`,
};

// ---- JS (IndexedDB) ----------------------------------------------------------------------------------

export interface LibraryRow {
  cardId: string;
  cardCreatedAt: string;
  forkedFromRevisionId: string | null;
  revisionCreatedAt: string;
  sequence: number;
  document: unknown;
  assetPaths: readonly string[];
  forkCount: number;
}

function data(document: unknown): Record<string, unknown> {
  const value = (document as { data?: unknown } | null)?.data;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const text = (value: unknown) => (typeof value === 'string' ? fold(value) : '');
const length = (value: unknown) => (Array.isArray(value) ? value.length : 0);
const tagsOf = (fields: Record<string, unknown>) => (Array.isArray(fields.tags) ? fields.tags.filter((tag): tag is string => typeof tag === 'string').map(fold) : []);
const trimBlank = (value: string) => value.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '');

function evaluate(node: QueryNode, fields: Record<string, unknown>, all: string): boolean {
  if (node.kind === 'not') return !evaluate(node.node, fields, all);
  if (node.kind !== 'term') return node.kind === 'and' ? node.nodes.every((child) => evaluate(child, fields, all)) : node.nodes.some((child) => evaluate(child, fields, all));
  const value = fold(node.value);
  switch (node.field) {
    case 'tag': return tagsOf(fields).includes(value);
    case 'name': return text(fields.name).includes(value);
    case 'creator': return text(fields.creator).includes(value);
    case 'description': return text(fields.description).includes(value);
    default: return all.includes(value);
  }
}

/** The JS twin of `libraryFilterSql`. */
export function libraryMatcher(filter: LibraryFilter): (row: LibraryRow) => boolean {
  const query = parseLibraryQuery(filter.q ?? '');
  const include = cleanTags(filter.tags), exclude = cleanTags(filter.excludeTags), flags = new Set(filter.has ?? []);
  return (row) => {
    const fields = data(row.document);
    const tags = tagsOf(fields);
    if (query) {
      const all = [...['name', 'creator', 'description', 'creator_notes', 'personality', 'scenario', 'first_mes'].map((key) => text(fields[key])), tags.join('\n')].join('\n');
      if (!evaluate(query, fields, all)) return false;
    }
    if (include.length && !(filter.tagMode === 'any' ? include.some((tag) => tags.includes(tag)) : include.every((tag) => tags.includes(tag)))) return false;
    if (exclude.some((tag) => tags.includes(tag))) return false;
    const book = fields.character_book as { entries?: unknown } | null | undefined;
    if (flags.has('lorebook') && !(length(book?.entries) > 0)) return false;
    if (flags.has('greetings') && !(length(fields.alternate_greetings) > 0)) return false;
    if (flags.has('portrait') && !row.assetPaths.includes('portrait')) return false;
    if (flags.has('assets') && !row.assetPaths.some((path) => path !== 'portrait')) return false;
    if (filter.fork === 'only' && row.forkedFromRevisionId === null) return false;
    if (filter.fork === 'none' && row.forkedFromRevisionId !== null) return false;
    return true;
  };
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** The JS twin of `librarySortSql`. */
export function libraryComparator(sort: LibrarySort): (a: LibraryRow, b: LibraryRow) => number {
  const edited = (a: LibraryRow, b: LibraryRow) => compare(b.revisionCreatedAt, a.revisionCreatedAt);
  const id = (a: LibraryRow, b: LibraryRow) => compare(a.cardId, b.cardId);
  const name = (row: LibraryRow) => text(data(row.document).name);
  const greetingCount = (row: LibraryRow) => {
    const fields = data(row.document);
    return (trimBlank(text(fields.first_mes)) ? 1 : 0) + length(fields.alternate_greetings) + length(fields.group_only_greetings);
  };
  const entries = (row: LibraryRow) => length((data(row.document).character_book as { entries?: unknown } | null | undefined)?.entries);
  const numeric = (value: (row: LibraryRow) => number) => (a: LibraryRow, b: LibraryRow) => value(b) - value(a) || edited(a, b) || id(a, b);
  switch (sort) {
    case 'added': return (a, b) => compare(b.cardCreatedAt, a.cardCreatedAt) || id(a, b);
    case 'oldest': return (a, b) => compare(a.cardCreatedAt, b.cardCreatedAt) || id(a, b);
    case 'name': return (a, b) => compare(name(a), name(b)) || id(a, b);
    case 'name_desc': return (a, b) => compare(name(b), name(a)) || id(a, b);
    case 'revisions': return numeric((row) => row.sequence);
    case 'forks': return numeric((row) => row.forkCount);
    case 'greetings': return numeric(greetingCount);
    case 'lorebook': return numeric(entries);
    default: return (a, b) => edited(a, b) || id(a, b);
  }
}
