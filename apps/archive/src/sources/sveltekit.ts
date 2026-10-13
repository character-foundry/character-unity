/**
 * Reads a SvelteKit `__data.json` answer: newline-separated JSON, the first line `{type:'data', nodes}` and then
 * `{type:'chunk', id, data}` lines that settle streamed promises. Each node's `data` is a devalue table: an array
 * whose entry 0 is the value, with objects and arrays pointing at other entries by index. This only parses JSON
 * and follows indices; nothing is evaluated.
 */
const holes: Record<number, unknown> = { [-1]: undefined, [-2]: undefined, [-3]: Number.NaN, [-4]: Number.POSITIVE_INFINITY, [-5]: Number.NEGATIVE_INFINITY, [-6]: -0 };
const blocked = new Set(['__proto__', 'constructor', 'prototype']);

/** A streamed value the page has not inlined; `settle` swaps it for its chunk. */
export interface Pending { $promise: number }
const isPending = (value: unknown): value is Pending => !!value && typeof value === 'object' && typeof (value as Pending).$promise === 'number';

export function unflatten(table: unknown): unknown {
  if (typeof table === 'number') return holes[table];
  if (!Array.isArray(table)) throw new Error('Expected a devalue table');
  const done = new Map<number, unknown>();
  const read = (index: unknown): unknown => {
    if (typeof index !== 'number' || !Number.isInteger(index)) throw new Error('Invalid devalue reference');
    if (index < 0) return holes[index];
    if (index >= table.length) throw new Error('Devalue reference out of range');
    if (done.has(index)) return done.get(index);
    const raw: unknown = table[index];
    if (Array.isArray(raw)) {
      if (typeof raw[0] === 'string') {
        const [kind, ...rest] = raw as [string, ...unknown[]];
        let value: unknown = null;
        if (kind === 'Promise') value = { $promise: Number(rest[0]) };
        else if (kind === 'Date' || kind === 'BigInt') value = String(rest[0]);
        else if (kind === 'Set') { const items: unknown[] = []; done.set(index, items); for (const item of rest) items.push(read(item)); return items; }
        else if (kind === 'Map') { const pairs: unknown[] = []; done.set(index, pairs); for (let at = 0; at < rest.length; at += 2) pairs.push([read(rest[at]), read(rest[at + 1])]); return pairs; }
        else if (kind === 'null') {
          const object: Record<string, unknown> = {}; done.set(index, object);
          for (let at = 0; at < rest.length; at += 2) if (typeof rest[at] === 'string' && !blocked.has(rest[at] as string)) object[rest[at] as string] = read(rest[at + 1]);
          return object;
        }
        done.set(index, value);
        return value;
      }
      const items: unknown[] = []; done.set(index, items);
      for (const item of raw) items.push(read(item));
      return items;
    }
    if (raw && typeof raw === 'object') {
      const object: Record<string, unknown> = {}; done.set(index, object);
      for (const [key, item] of Object.entries(raw)) if (!blocked.has(key)) object[key] = read(item);
      return object;
    }
    done.set(index, raw);
    return raw;
  };
  return read(0);
}

/** The page's data nodes (null where a layout sent none) with streamed promises settled from their chunks. */
export function readSvelteKitData(body: string): unknown[] {
  const lines = body.split('\n').filter((line) => line.trim());
  const first = JSON.parse(lines[0] ?? 'null') as { type?: unknown; nodes?: unknown } | null;
  if (!first || first.type !== 'data' || !Array.isArray(first.nodes)) throw new Error('Not a SvelteKit data answer');
  const chunks = new Map<number, unknown>();
  for (const line of lines.slice(1)) {
    const chunk = JSON.parse(line) as { type?: unknown; id?: unknown; data?: unknown };
    if (chunk.type === 'chunk' && typeof chunk.id === 'number') chunks.set(chunk.id, chunk.data === undefined ? null : unflatten(chunk.data));
  }
  const settle = (value: unknown, depth = 0): unknown => {
    if (depth > 64) return null;
    if (isPending(value)) return chunks.has(value.$promise) ? settle(chunks.get(value.$promise), depth + 1) : null;
    if (Array.isArray(value)) return value.map((item) => settle(item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, settle(item, depth + 1)]));
    return value;
  };
  return first.nodes.map((node) => {
    const value = node as { type?: unknown; data?: unknown } | null;
    return value?.type === 'data' ? settle(unflatten(value.data)) : null;
  });
}

/** Encodes a value as a devalue table (tests use it to play a SvelteKit server). */
export function flatten(value: unknown): unknown[] {
  const table: unknown[] = [];
  const add = (item: unknown): number => {
    if (item === undefined) return -1;
    const index = table.length;
    table.push(null);
    if (Array.isArray(item)) table[index] = item.map(add);
    else if (item && typeof item === 'object' && typeof (item as Pending).$promise === 'number') table[index] = ['Promise', (item as Pending).$promise];
    else if (item && typeof item === 'object') table[index] = Object.fromEntries(Object.entries(item).map(([key, child]) => [key, add(child)]));
    else table[index] = item;
    return index;
  };
  add(value);
  return table;
}
