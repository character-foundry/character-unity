import { ArchiveError } from '@character-unity/archive-client/contract';

type Expression = { type: 'term'; value: string } | { type: 'not'; child: Expression }
  | { type: 'and' | 'or'; left: Expression; right: Expression };
function invalid(message: string): never { throw new ArchiveError('INVALID_INPUT', message); }

/** Legacy precedence: NOT, then explicit/implicit AND, then OR. Plain text stays
 * one native FTS query. Quoted operators are text, never Boolean syntax. */
export function parseSearchExpression(text: string): Expression {
  if (text.length > 2048) invalid('Search text exceeds 2048 characters');
  const tokens: { value: string; kind: 'term' | 'AND' | 'OR' | 'NOT' | '(' | ')' }[] = [];
  let index = 0;
  while (index < text.length) {
    if (/\s/.test(text[index]!)) { index++; continue; }
    const start = index, first = text[index]!;
    if (first === '(' || first === ')') { tokens.push({ kind: first, value: first }); index++; }
    else if (first === '"') {
      index++; let closed = false;
      while (index < text.length) {
        const value = text[index++]!;
        if (value === '\\') { if (index >= text.length) invalid('Incomplete quoted search escape'); index++; }
        else if (value === '"') { closed = true; break; }
      }
      if (!closed || index - start === 2) invalid('Search phrases must be nonempty and closed');
      if (index < text.length && !/[\s()]/.test(text[index]!)) invalid('Separate quoted phrases from other terms');
      tokens.push({ kind: 'term', value: text.slice(start, index) });
    } else {
      while (index < text.length && !/[\s()]/.test(text[index]!)) {
        if (text[index] === '"') invalid('Start quoted phrases at a term boundary');
        index++;
      }
      const value = text.slice(start, index), upper = value.toUpperCase();
      tokens.push({ value, kind: upper === 'AND' || upper === 'OR' || upper === 'NOT' ? upper : 'term' });
    }
    if (tokens.length > 128) invalid('Search has too many terms or operators');
  }
  if (!tokens.length) invalid('Enter search text');
  if (tokens.every((token) => token.kind === 'term')) return { type: 'term', value: text.trim() };
  let cursor = 0, depth = 0;
  function unary(): Expression {
    if (++depth > 32) invalid('Search is nested too deeply');
    const token = tokens[cursor++];
    let result: Expression;
    if (token?.kind === 'NOT') result = { type: 'not', child: unary() };
    else if (token?.kind === '(') {
      result = or();
      if (tokens[cursor++]?.kind !== ')') invalid('Search is missing a closing parenthesis');
    } else if (token?.kind === 'term') result = { type: 'term', value: token.value };
    else invalid('Search expected a term');
    depth--; return result;
  }
  function and(): Expression {
    let result = unary();
    while (tokens[cursor] && !['OR', ')'].includes(tokens[cursor]!.kind)) {
      if (tokens[cursor]!.kind === 'AND') cursor++;
      result = { type: 'and', left: result, right: unary() };
    }
    return result;
  }
  function or(): Expression {
    let result = and();
    while (tokens[cursor]?.kind === 'OR') { cursor++; result = { type: 'or', left: result, right: and() }; }
    return result;
  }
  const result = or();
  if (cursor !== tokens.length) invalid('Unexpected trailing search token');
  return result;
}

export async function evaluateSearch(expression: Expression, universe: readonly string[], searchTerm: (text: string) => Promise<Map<string, number>>) {
  const cache = new Map<string, Map<string, number>>();
  async function evaluate(node: Expression): Promise<Map<string, number>> {
    if (node.type === 'term') {
      if (!cache.has(node.value)) cache.set(node.value, await searchTerm(node.value));
      return new Map(cache.get(node.value)!);
    }
    if (node.type === 'not') {
      const excluded = await evaluate(node.child);
      return new Map(universe.filter((id) => !excluded.has(id)).map((id) => [id, 0]));
    }
    // Bound native query concurrency. Each distinct term executes at most once.
    const left = await evaluate(node.left), right = await evaluate(node.right);
    if (node.type === 'and') return new Map([...left].filter(([id]) => right.has(id)).map(([id, score]) => [id, score + right.get(id)!]));
    for (const [id, score] of right) left.set(id, (left.get(id) ?? 0) + score);
    return left;
  }
  return evaluate(expression);
}
