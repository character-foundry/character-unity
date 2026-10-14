import { DataType } from 'apache-arrow';
import type { Schema } from 'apache-arrow';
import { ArchiveError } from '@character-unity/archive-client/contract';
import type { SearchFilterField } from '@character-unity/archive-client';
import { fold } from '@character-unity/store/library-query';

// Legacy Archive b99dcd1: backend/services/search/lance-filter.js. Only fields
// present with supported physical types in the pinned copy are exposed.
const names = new Set(('id source sourceId sourcePath name author tagline description platform_summary tags topics type language visibility favorited '
  + 'hasAlternateGreetings hasLorebook hasEmbeddedLorebook hasLinkedLorebook hasExampleDialogues hasSystemPrompt hasGallery hasEmbeddedImages hasExpressions '
  + 'tokenCount rating ratingCount starCount n_favorites favorites nChats nMessages tokenDescriptionCount tokenPersonalityCount tokenScenarioCount '
  + 'tokenMesExampleCount tokenFirstMessageCount tokenSystemPromptCount tokenPostHistoryCount created createdAt added updated lastModified fullPath '
  + 'scoreComposite scoreVelocity engagementScore engagementVelocity').split(' '));
const aliases: Record<string, string> = { platformSummary: 'platform_summary', token_count: 'tokenCount' };
function invalid(message: string): never { throw new ArchiveError('INVALID_INPUT', message); }

export function searchFilterFields(schema: Schema): SearchFilterField[] {
  return schema.fields.flatMap((field): SearchFilterField[] => {
    if (!names.has(field.name)) return [];
    const type = DataType.isUtf8(field.type) ? 'string' : DataType.isBool(field.type) ? 'boolean'
      : DataType.isInt(field.type) || DataType.isFloat(field.type) ? 'number'
        : DataType.isList(field.type) && DataType.isUtf8(field.type.valueType) ? 'strings' : null;
    return type ? [{ name: field.name, type }] : [];
  }).sort((a, b) => a.name < b.name ? -1 : 1);
}

type Token = { kind: 'word' | 'literal' | 'symbol'; value: string };
export interface SearchFilterOptions { listCase?: 'unicode' | 'ascii' }
export interface SearchFilterPlan { sql: string; listFields: readonly string[] }
/** The parsed list fields let callers validate their projection policy without
 * guessing from raw filter text. Scalar fields retain legacy LOWER semantics. */
export function compileSearchFilterPlan(raw: string, fields: readonly SearchFilterField[], options: SearchFilterOptions = {}): SearchFilterPlan {
  if (typeof raw !== 'string' || raw.length > 4096 || [...raw].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) invalid('Filter must be at most 4096 characters without controls');
  const tokens: Token[] = [];
  let index = 0;
  while (index < raw.length) {
    const char = raw[index]!;
    if (/\s/.test(char)) { index++; continue; }
    if (char === '"' || char === "'") {
      index++; let value = '', closed = false;
      while (index < raw.length) {
        const next = raw[index++]!;
        if (next === '\\') { if (index === raw.length) invalid('Incomplete filter escape'); value += raw[index++]!; }
        else if (next === char) { closed = true; break; }
        else value += next;
      }
      if (!closed) invalid('Unclosed filter value');
      tokens.push({ kind: 'literal', value });
    } else {
      const symbol = /^(>=|<=|!=|[=<>:()[\],])/.exec(raw.slice(index));
      const value = symbol?.[0] ?? /^[^\s()=<>!,[\]:"'\\]+/.exec(raw.slice(index))?.[0];
      if (!value) invalid('Unsupported filter character');
      tokens.push({ kind: symbol ? 'symbol' : 'word', value }); index += value.length;
    }
    if (tokens.length > 256) invalid('Filter exceeds 256 tokens');
  }
  if (!tokens.length) return { sql: '', listFields: [] };
  const available = new Map(fields.filter((field) => names.has(field.name)).map((field) => [field.name, field.type]));
  const listFields = new Set<string>();
  let cursor = 0, depth = 0;
  function accept(value: string) {
    const token = tokens[cursor];
    if (token && token.kind !== 'literal' && token.value.toUpperCase() === value) { cursor++; return true; }
    return false;
  }
  function require(value: string) { if (!accept(value)) invalid(`Expected ${value} in filter`); }
  function literal(type: SearchFilterField['type']): string {
    const token = tokens[cursor++];
    if (!token || token.kind === 'symbol' || (token.kind === 'word' && /^(AND|OR|NOT|IN|EXISTS|TO)$/i.test(token.value))) invalid('Expected a filter value');
    if (type === 'string' || type === 'strings') {
      const value = type === 'strings' && options.listCase === 'ascii' ? fold(token.value) : token.value.toLowerCase();
      return `'${value.replaceAll("'", "''")}'`;
    }
    if (type === 'boolean') {
      if (token.kind !== 'word' || !/^(true|false)$/i.test(token.value)) invalid('Boolean filters require true or false');
      return token.value.toLowerCase();
    }
    const value = Number(token.value);
    if (token.kind !== 'word' || !/^-?\d+(?:\.\d+)?$/.test(token.value) || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) invalid('Numeric filters require a finite decimal within the safe number range');
    return String(value);
  }
  function comparison(): string {
    const token = tokens[cursor++];
    if (!token || token.kind !== 'word') invalid('Expected a filter field');
    const name = Object.hasOwn(aliases, token.value) ? aliases[token.value]! : token.value, type = available.get(name);
    if (!type) invalid(`Unsupported filter field in this copy: ${name}`);
    const column = name, field = type === 'string' ? `LOWER(${column})` : column;
    const negated = accept('NOT');
    if (accept('EXISTS')) return negated ? `${column} IS NULL` : `${column} IS NOT NULL`;
    if (type === 'strings') listFields.add(name);
    if (accept('IN')) {
      require('['); const values = [literal(type)];
      while (accept(',')) { if (values.length >= 64) invalid('Filter lists exceed 64 values'); values.push(literal(type)); }
      require(']');
      const sql = type === 'strings' ? `(${values.map((value) => `array_contains(${column}, ${value})`).join(' OR ')})` : `${field} IN (${values.join(', ')})`;
      return negated ? `NOT (${sql})` : sql;
    }
    if (negated) invalid('Expected IN or EXISTS after field NOT');
    const operator = tokens[cursor];
    if (operator?.kind === 'symbol' && [':', '=', '!=', '>', '<', '>=', '<='].includes(operator.value)) {
      cursor++; const op = operator.value === ':' ? '=' : operator.value, value = literal(type);
      if ((type === 'strings' || type === 'boolean') && !['=', '!='].includes(op)) invalid('This field supports only equality or membership');
      if (type === 'strings') return `${op === '!=' ? 'NOT ' : ''}array_contains(${column}, ${value})`;
      return `${field} ${op} ${value}`;
    }
    if (type === 'strings' || type === 'boolean') invalid('Ranges require string or numeric fields');
    const min = literal(type); require('TO'); const max = literal(type);
    return `(${field} >= ${min}) AND (${field} <= ${max})`;
  }
  function unary(): string {
    if (++depth > 32) invalid('Filter exceeds 32 nesting levels');
    let sql: string;
    if (accept('NOT')) sql = `NOT (${unary()})`;
    else if (accept('(')) { sql = or(); require(')'); }
    else sql = comparison();
    depth--; return sql;
  }
  function and(): string { let sql = unary(); while (accept('AND')) sql = `(${sql}) AND (${unary()})`; return sql; }
  function or(): string { let sql = and(); while (accept('OR')) sql = `(${sql}) OR (${and()})`; return sql; }
  const result = or();
  if (cursor !== tokens.length) invalid('Unexpected trailing filter input');
  return { sql: result, listFields: [...listFields].sort() };
}

/** Bounded legacy filter grammar; never passes caller SQL through to Lance.
 * Legacy Archive indexes Unicode-fold list values; owned exact arrays opt in
 * to ASCII folding explicitly, without changing scalar string comparisons. */
export function compileSearchFilter(raw: string, fields: readonly SearchFilterField[], options: SearchFilterOptions = {}): string {
  return compileSearchFilterPlan(raw, fields, options).sql;
}
