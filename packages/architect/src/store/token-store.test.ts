import { describe, expect, it, vi } from 'vitest';
import { createTokenStore } from './token-store';
import type { Card, TokenizeRequest, TokenizeResponse } from '../lib/types';

function card(name: string): Card {
  return { meta: { id: name, name, spec: 'v3', tags: [], createdAt: '', updatedAt: '' },
    data: { spec: 'chara_card_v3', spec_version: '3.0', data: { name, description: name } } as Card['data'] };
}
type Result = { data?: TokenizeResponse; error?: string };
function deferred() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((done) => { resolve = done; });
  return { promise, resolve };
}
function counted(total: number): Result { return { data: { model: 'gpt-4', fields: { name: total, description: 0 }, total } }; }
function setup() {
  const controller = new AbortController();
  const tokenize = vi.fn<(request: TokenizeRequest) => Promise<Result>>();
  const store = createTokenStore({ api: { tokenize }, signal: controller.signal, isDisposed: () => controller.signal.aborted });
  return { store, tokenize, controller };
}

describe('editor-owned token counts', () => {
  it('keeps counts and model selection independent between editor instances', async () => {
    const first = setup(), second = setup();
    first.tokenize.mockResolvedValue(counted(3));
    second.tokenize.mockResolvedValue(counted(8));
    await Promise.all([first.store.getState().updateTokenCounts(card('first')), second.store.getState().updateTokenCounts(card('second'))]);
    first.store.getState().setTokenizerModel('other-model');
    expect(first.store.getState().tokenCounts.total).toBe(0);
    expect(first.store.getState().status).toBe('idle');
    expect(second.store.getState().tokenCounts.total).toBe(8);
    expect(second.store.getState().tokenizerModel).toBe('gpt-4');
  });

  it('ignores older token completions after a newer draft is counted', async () => {
    const { store, tokenize } = setup();
    const old = deferred();
    tokenize.mockReturnValueOnce(old.promise).mockResolvedValueOnce(counted(9));
    const pending = store.getState().updateTokenCounts(card('old'));
    await store.getState().updateTokenCounts(card('new'));
    old.resolve(counted(1)); await pending;
    expect(store.getState().tokenCounts.total).toBe(9);
  });

  it('invalidates old results when the tokenizer changes or the card closes', async () => {
    const { store, tokenize } = setup();
    const old = deferred(); tokenize.mockReturnValueOnce(old.promise);
    const pending = store.getState().updateTokenCounts(card('old'));
    store.getState().setTokenizerModel('new-model');
    await store.getState().updateTokenCounts(null);
    old.resolve(counted(20)); await pending;
    expect(store.getState().tokenCounts).toEqual({ total: 0 });
  });

  it('never accepts a count after session disposal', async () => {
    const { store, tokenize, controller } = setup();
    const response = deferred(); tokenize.mockReturnValueOnce(response.promise);
    const pending = store.getState().updateTokenCounts(card('closed'));
    controller.abort(); response.resolve(counted(15)); await pending;
    expect(store.getState().tokenCounts).toEqual({ total: 0 });
    await store.getState().updateTokenCounts(card('ignored'));
    expect(tokenize).toHaveBeenCalledTimes(1);
  });

  it('counts greetings and enabled lore entries separately while reporting opaque values without coercion', async () => {
    const { store, tokenize } = setup();
    const input = card('Aster');
    (input.data as unknown as { data: Record<string, unknown> }).data = { name: 'Aster', description: { opaque: true }, first_mes: 'Hello',
      alternate_greetings: ['Hi', 'Welcome'], group_only_greetings: ['Together'], character_book: { entries: [
        { content: 'First lore', enabled: true }, { content: 'Second lore' }, { content: 'Disabled', enabled: false },
        { content: { opaque: true } }, { content: 'Unknown flag', enabled: 'sometimes' },
      ] } };
    tokenize.mockResolvedValue({ data: { model: 'gpt-4', fields: { name: 2, first_mes: 1, alternate_greeting_0: 1,
      alternate_greeting_1: 2, group_only_greeting_0: 3, lorebook_entry_0: 4, lorebook_entry_1: 5 }, total: 18 } });
    await store.getState().updateTokenCounts(input);
    expect(tokenize.mock.calls[0]![0].payload).toEqual({ name: 'Aster', first_mes: 'Hello', alternate_greeting_0: 'Hi',
      alternate_greeting_1: 'Welcome', group_only_greeting_0: 'Together', lorebook_entry_0: 'First lore', lorebook_entry_1: 'Second lore' });
    expect(store.getState()).toMatchObject({ status: 'ready', omitted: ['Description', 'Enabled lorebook entries'], disabledLoreEntries: 1,
      tokenCounts: { alternate_greetings: 3, group_only_greetings: 3, lorebook: 9, total: 18 } });
    expect((input.data as unknown as { data: { description: unknown } }).data.description).toEqual({ opaque: true });
  });
});
