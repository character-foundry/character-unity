import { afterEach, describe, expect, it } from 'vitest';
import { createEditorSession } from './session';
import type { EditorSession } from './session-types';
import type { Card } from '../lib/types';

const sessions: EditorSession[] = [];
function open(name = 'Lorebook') {
  const session = createEditorSession({ workspaceId: name, actorId: 'browser', browserLLM: false }, { recovery: {
    load: async () => null, save: async () => undefined, remove: async () => undefined, flush: async () => undefined,
  } });
  sessions.push(session);
  const document = { spec: 'chara_card_v3', spec_version: '3.0', opaque: { keep: true }, data: { name, extensions: { vendor: [1, null] },
    character_book: { name: 'Book', scan_depth: 0, token_budget: 0, opaqueBook: [false], entries: [
      { id: 8, name: 'First', keys: ['sky, moon'], content: 'First content', insertion_order: -3, position: 7, extensions: { opaque: true } },
      { id: 8, name: 'Second', keys: ['woods'], content: 'Second content', insertion_order: 0, enabled: false, probability: 0 },
      { name: 'Missing ID', keys: [], content: 'Third content', opaque: ['keep'] },
    ] } } };
  session.cards.getState().setCurrentCard({ meta: { id: '', name, spec: 'v3', tags: [], createdAt: '', updatedAt: '' }, data: document as unknown as Card['data'] });
  return session;
}
function book(session: EditorSession) {
  return (session.cards.getState().currentCard!.data as unknown as { data: { character_book: Record<string, unknown> & { entries: Record<string, unknown>[] } } }).data.character_book;
}
afterEach(() => { sessions.splice(0).forEach((session) => session.dispose()); });

describe('native session-owned lorebooks', () => {
  it('edits, moves and deletes by position rather than duplicate or missing imported IDs', () => {
    const session = open(), other = open('Other');
    session.cards.getState().editLorebook({ type: 'entry-field', index: 1, field: 'content', value: 'Only the second entry changes' });
    expect(book(session).entries.map((entry) => entry.content)).toEqual(['First content', 'Only the second entry changes', 'Third content']);
    session.cards.getState().editLorebook({ type: 'move', index: 1, offset: -1 });
    expect(book(session).entries.map((entry) => entry.insertion_order)).toEqual([0, -3, undefined]);
    session.cards.getState().editLorebook({ type: 'remove', index: 1 });
    expect(book(session).entries.map((entry) => entry.name)).toEqual(['Second', 'Missing ID']);
    expect(book(other).entries.map((entry) => entry.content)).toEqual(['First content', 'Second content', 'Third content']);
    expect(session.cards.getState().currentCard!.data).toMatchObject({ opaque: { keep: true }, data: { extensions: { vendor: [1, null] }, character_book: { opaqueBook: [false] } } });
  });
  it('reviews native file replacement without applying it, rejects stale or other-session reviews and downloads exact draft data', () => {
    const session = open(), other = open('Other');
    const replacement = { name: 'Imported', scan_depth: 0, extensions: { vendor: [1, null] }, entries: [
      { id: 2, keys: ['a, b'], content: 'First', opaque: { keep: true } },
      { id: 2, keys: [], content: 'Second', enabled: false, probability: 0 },
    ] };
    const bytes = new TextEncoder().encode(JSON.stringify(replacement));
    const stale = session.cards.getState().prepareLorebookImport(bytes);
    expect(stale).toEqual({ name: 'Imported', entries: 2, replacesExisting: true });
    expect(book(session).name).toBe('Book');
    session.cards.getState().editLorebook({ type: 'entry-field', index: 0, field: 'content', value: 'Intervening edit' });
    expect(() => session.cards.getState().attachLorebook(stale)).toThrow('draft changed');
    const reviewed = session.cards.getState().prepareLorebookImport(bytes);
    expect(() => other.cards.getState().attachLorebook(reviewed)).toThrow('draft changed');
    session.cards.getState().attachLorebook(reviewed);
    expect(book(session)).toEqual(replacement);
    expect(JSON.parse(session.cards.getState().downloadLorebook())).toEqual(replacement);
    expect(session.cards.getState().currentCard!.data).toMatchObject({ opaque: { keep: true }, data: { extensions: { vendor: [1, null] } } });
    expect(() => session.cards.getState().attachLorebook(reviewed)).toThrow('draft changed');
  });
  it('copies opaque entry data independently, allocates unused IDs and keeps list order separate from insertion order', () => {
    const session = open();
    session.cards.getState().editLorebook({ type: 'copy', index: 0 });
    expect(book(session).entries[3]).toEqual({ ...book(session).entries[0], id: 0, name: 'First (copy)', insertion_order: 1 });
    session.cards.getState().editLorebook({ type: 'entry-field', index: 3, field: 'extensions.weight', value: 0 });
    expect(book(session).entries[0]!.extensions).toEqual({ opaque: true });
    expect(book(session).entries[3]!.extensions).toEqual({ opaque: true, weight: 0 });
    session.cards.getState().editLorebook({ type: 'move', index: 3, offset: -1 });
    expect(book(session).entries.map((entry) => entry.insertion_order)).toEqual([-3, 0, 1, undefined]);
    session.cards.getState().editLorebook({ type: 'add' });
    expect(book(session).entries[4]).toMatchObject({ id: 1, insertion_order: 2, content: '', enabled: true });
  });
  it('initializes only absent or null books and refuses opaque shapes or unapproved field paths', () => {
    for (const previous of [undefined, null, 'opaque book', [], { entries: { future: true } }]) {
      const session = open();
      const card = structuredClone(session.cards.getState().currentCard!);
      const data = (card.data as unknown as { data: Record<string, unknown> }).data;
      if (previous === undefined) delete data.character_book; else data.character_book = previous;
      session.cards.getState().setCurrentCard(card);
      if (previous === undefined || previous === null) {
        session.cards.getState().editLorebook({ type: 'initialize' });
        expect(book(session)).toMatchObject({ name: 'Lorebook Lorebook', entries: [], scan_depth: 100, token_budget: 500 });
        expect(() => session.cards.getState().editLorebook({ type: 'initialize' })).toThrow('cannot be replaced');
      } else {
        expect(() => session.cards.getState().editLorebook({ type: 'add' })).toThrow('unsupported');
        expect(session.cards.getState().currentCard).toBe(card);
      }
    }
    const session = open(), before = session.cards.getState().currentCard;
    for (const field of ['id', '__proto__.polluted', 'assets', 'position']) {
      expect(() => session.cards.getState().editLorebook({ type: 'entry-field', index: 0, field, value: 1 })).toThrow('cannot accept');
    }
    for (const index of [-1, 3, 0.5, NaN]) expect(() => session.cards.getState().editLorebook({ type: 'remove', index })).toThrow('existing');
    expect(session.cards.getState().currentCard).toBe(before);
    expect(Object.hasOwn({}, 'polluted')).toBe(false);
  });
  it('preserves zero, negative, fractional and nullable values while rejecting invalid numeric edits', () => {
    const session = open();
    for (const value of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => session.cards.getState().editLorebook({ type: 'book-field', field: 'scan_depth', value })).toThrow('cannot accept');
    }
    for (const value of [-1, 101]) expect(() => session.cards.getState().editLorebook({ type: 'entry-field', index: 0, field: 'probability', value })).toThrow('cannot accept');
    session.cards.getState().editLorebook({ type: 'entry-field', index: 0, field: 'probability', value: 0.5 });
    session.cards.getState().editLorebook({ type: 'entry-field', index: 0, field: 'priority', value: -5 });
    session.cards.getState().editLorebook({ type: 'entry-field', index: 0, field: 'selective', value: null });
    session.cards.getState().editLorebook({ type: 'book-field', field: 'scan_depth', value: 0 });
    expect(book(session).scan_depth).toBe(0);
    expect(book(session).entries[0]).toMatchObject({ priority: -5, probability: 0.5, selective: null });
    session.cards.getState().editLorebook({ type: 'book-field', field: 'scan_depth', value: undefined });
    expect(Object.hasOwn(book(session), 'scan_depth')).toBe(false);
    expect(() => session.cards.getState().editLorebook({ type: 'entry-field', index: 0, field: 'content', value: undefined })).toThrow('cannot accept');
  });
  it('rejects unsupported lorebook formats and bounded-resource failures without changing its draft', () => {
    const session = open(), before = session.cards.getState().currentCard;
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    for (const value of [null, [], {}, { entries: [null] }, { entries: [{ keys: ['sky'], content: 7 }] },
      { entries: [{ keys: ['sky', 2], content: 'bad keys' }] }, { entries: { '1': { uid: 1, key: ['sky'], content: 'World info' } } },
      { kind: 'memory', entries: [] }, { type: 'risu', entries: [] }, { format: 'wyvern', entries: [] }, { spec: 'chara_card_v3', entries: [], data: {} },
      { entries: [], unsafe: Number.MAX_SAFE_INTEGER + 1 }, { entries: Array.from({ length: 1001 }, () => ({ keys: [], content: '' })) },
      { entries: [], nested: Array.from({ length: 20_001 }, () => 0) }, { entries: [], nested: Array.from({ length: 65 }).reduce<unknown>((value) => [value], '') },
    ]) expect(() => session.cards.getState().prepareLorebookImport(bytes(value))).toThrow();
    for (const value of [new Uint8Array(), new Uint8Array(262_145), new Uint8Array([0xc3, 0x28]), new TextEncoder().encode('{bad JSON')]) {
      expect(() => session.cards.getState().prepareLorebookImport(value)).toThrow();
    }
    expect(session.cards.getState().currentCard).toBe(before);
    const object = JSON.parse('{"entries":[],"__proto__":{"polluted":true}}');
    session.cards.getState().attachLorebook(session.cards.getState().prepareLorebookImport(bytes(object)));
    expect(JSON.parse(session.cards.getState().downloadLorebook())).toEqual(object);
    expect(Object.hasOwn({}, 'polluted')).toBe(false);
  });
});
