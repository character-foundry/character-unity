import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEditorSession } from './session';
import type { EditorSession } from './session-types';
import type { DraftRecovery } from './recovery';
import type { Card } from '../lib/types';

type Json = Record<string, unknown>;
function document(description = 'Original'): Json {
  return { spec: 'chara_card_v3', spec_version: '3.0', opaque: { retain: true }, data: {
    name: 'Character', description, tags: [], extensions: { vendor: { preserve: true }, foundry: { lineage: { revisionHash: 'head-1' } } },
  } };
}
function opened(id: string, head = 'head-1', description = 'Original') {
  return { card: { id, createdAt: '', headRevisionId: head },
    revision: { id: head, sequence: 1, document: document(description), assets: [], createdAt: '' } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const sessions: EditorSession[] = [];
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
function make(workspaceId = 'session-tests') {
  const recovery: DraftRecovery = { load: vi.fn(async () => null), save: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined), flush: vi.fn(async () => undefined) };
  const session = createEditorSession({ workspaceId }, { recovery });
  sessions.push(session);
  return { session, recovery };
}
function description(card: Card | null) { return (card?.data as unknown as { data: { description: string } })?.data.description; }
beforeEach(() => { fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher); });
afterEach(() => { for (const session of sessions.splice(0)) session.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('editor session lifecycle', () => {
  it('closes every editor operation when its captured account connection is disposed', async () => {
    const owner = new AbortController();
    const recovery: DraftRecovery = { load: async () => null, save: async () => {}, remove: async () => {}, flush: async () => {} };
    const session = createEditorSession({ workspaceId: 'account-workspace', actorId: 'alice', signal: owner.signal, browserLLM: false }, { recovery });
    sessions.push(session);
    expect(session.capabilities.browserLLM).toBe(false);
    expect(session.llm.getState().settings.providers).toEqual([]);
    owner.abort();
    expect(session.signal.aborted).toBe(true);
    await expect(session.open({ cardId: 'private-card' })).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('owns separate drafts, controls, assets and live cancellation for concurrent workspaces', async () => {
    const first = make('first-workspace').session, second = make('second-workspace').session;
    fetcher.mockResolvedValueOnce(Response.json(opened('same-id'))).mockResolvedValueOnce(Response.json(opened('same-id', 'other-head')));
    await first.open({ cardId: 'same-id' }); await second.open({ cardId: 'same-id' });
    const firstSignal = first.liveSignal(), secondSignal = second.liveSignal();
    first.cards.getState().updateCardFields({ description: 'Private draft' });
    first.ui.getState().setActiveTab('assets');
    first.wizard.messages = ['private conversation'];
    first.dispose();
    expect(firstSignal.aborted).toBe(true);
    expect(secondSignal.aborted).toBe(false);
    expect(second.ui.getState().activeTab).toBe('edit');
    expect(second.wizard.messages).toEqual([]);
    expect(description(second.cards.getState().currentCard)).toBe('Original');
    expect(second.api.headRevision('same-id')).toBe('other-head');
  });

  it('does not let an earlier same-parent fork continuation overwrite a newer fork open', async () => {
    const { session } = make();
    fetcher.mockResolvedValueOnce(Response.json(opened('parent', 'old-parent-head', 'Already open')));
    await session.open({ cardId: 'parent' });
    const old = deferred<Response>(), latest = deferred<Response>();
    fetcher.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const first = session.open({ cardId: '', forkOf: 'parent' });
    const second = session.open({ cardId: '', forkOf: 'parent' });
    old.resolve(Response.json(opened('parent', 'outdated-head', 'Outdated'))); await first;
    latest.resolve(Response.json(opened('parent', 'new-parent-head', 'Newest'))); await second;
    expect(session.cards.getState().currentCard?.meta).toMatchObject({ id: '', forkOf: 'parent' });
    expect(description(session.cards.getState().currentCard)).toBe('Newest');
    expect(session.api.headRevision('parent')).toBe('new-parent-head');
  });

  it('cancels an in-flight fork when returning to its already-open saved card', async () => {
    const { session } = make();
    fetcher.mockResolvedValueOnce(Response.json(opened('parent')));
    await session.open({ cardId: 'parent' });
    const original = session.cards.getState().currentCard;
    const pending = deferred<Response>(); fetcher.mockReturnValueOnce(pending.promise);
    const fork = session.open({ cardId: '', forkOf: 'parent' });
    await session.open({ cardId: 'parent' });
    expect(fetcher.mock.calls[1]![1]?.signal?.aborted).toBe(true);
    pending.resolve(Response.json(opened('parent', 'late-head'))); await fork;
    expect(session.cards.getState().currentCard).toBe(original);
    expect(session.cards.getState().currentCard?.meta.id).toBe('parent');
  });

  it('keeps a newly selected card when an old discard is waiting on recovery removal', async () => {
    const { session, recovery } = make();
    fetcher.mockResolvedValueOnce(Response.json(opened('first'))).mockResolvedValueOnce(Response.json(opened('second')));
    await session.open({ cardId: 'first' });
    const remove = deferred<void>(); vi.mocked(recovery.remove).mockReturnValueOnce(remove.promise);
    const pending = session.discard();
    await session.open({ cardId: 'second' });
    remove.resolve(); await pending;
    expect(session.cards.getState().currentCard?.meta.id).toBe('second');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('preserves the same session, selection and in-flight edits through first-Save route promotion', async () => {
    const { session } = make();
    await session.open({ cardId: '' });
    session.cards.getState().updateCardFields({ description: 'Submitted' });
    session.ui.getState().setActiveTab('assets');
    session.wizard.messages = ['same conversation'];
    await session.assets.add(session.cards.getState().currentCard!, new File(['submitted bytes'], 'first.txt', { type: 'text/plain' }));
    const response = deferred<Response>();
    let submitted: Json | undefined;
    fetcher.mockImplementationOnce(async (_path, options) => {
      submitted = JSON.parse((options!.body as FormData).get('input') as string).document as Json;
      return response.promise;
    });
    const selection = session.selection();
    const saving = session.save();
    await vi.waitFor(() => expect(submitted).toBeDefined());
    session.cards.getState().updateCardFields({ description: 'Typed during first Save' });
    await session.assets.add(session.cards.getState().currentCard!, new File(['pending bytes'], 'second.txt', { type: 'text/plain' }));
    response.resolve(Response.json({ cardId: 'created-card', revisionId: 'created-head', revision: {
      id: 'created-head', sequence: 1, document: submitted, createdAt: '', assets: [{ path: 'declared/0', assetId: 'first-asset' }],
    } }));
    await saving;
    const current = session.cards.getState().currentCard;
    await session.open({ cardId: 'created-card' });
    expect(session.cards.getState().currentCard).toBe(current);
    expect(session.selection()).toBe(selection);
    expect(description(current)).toBe('Typed during first Save');
    expect(session.cards.getState().isDirty).toBe(true);
    expect(session.ui.getState().activeTab).toBe('assets');
    expect(session.wizard.messages).toEqual(['same conversation']);
    expect((await session.assets.prepare(current!)).uploads.map((file) => file.name)).toEqual(['second.txt']);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('aborts pending fork work on idempotent disposal and never repopulates the session', async () => {
    const { session } = make();
    const response = deferred<Response>(); fetcher.mockReturnValueOnce(response.promise);
    const pending = session.open({ cardId: '', forkOf: 'parent' });
    const live = session.liveSignal();
    session.dispose(); session.dispose();
    response.resolve(Response.json(opened('parent'))); await pending;
    expect(live.aborted).toBe(true);
    expect(session.cards.getState().currentCard).toBeNull();
    expect(session.api.headRevision('parent')).toBeUndefined();
    await expect(session.open({ cardId: 'another' })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
