import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEditorSession } from '../../unity/session';
import type { EditorSession } from '../../unity/session-types';
import type { Card } from '../../lib/types';

const sessions: EditorSession[] = [];
function editor(workspaceId = 'workspace') {
  const session = createEditorSession({ workspaceId }, { recovery: {
    load: async () => null, save: async () => {}, remove: async () => {}, flush: async () => {},
  } });
  const card: Card = {
    meta: { id: '', name: 'Draft', spec: 'v3', tags: [], createdAt: 'created', updatedAt: 'updated' },
    data: { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Draft', assets: [] } } as unknown as Card['data'],
  };
  session.cards.setState({ currentCard: card });
  sessions.push(session);
  return session;
}
const input = (data: File | string) => ({ cardId: '', name: 'notes', type: 'custom' as const, ext: 'txt', mimetype: 'text/plain', data });

describe('owned editor persistence', () => {
  afterEach(() => { for (const session of sessions.splice(0)) session.dispose(); vi.unstubAllGlobals(); });

  it('keeps assets and dirty state separate even when both draft ids are empty', async () => {
    const first = editor('first'), second = editor('second');
    await first.persistence.saveAsset(input(new File(['notes'], 'notes.txt', { type: 'text/plain' })));
    expect((await first.persistence.listAssets('')).map((asset) => asset.name)).toEqual(['notes']);
    expect(await second.persistence.listAssets('')).toEqual([]);
    expect(first.cards.getState().isDirty).toBe(true);
    expect(second.cards.getState().isDirty).toBe(false);
  });

  it('rejects a delayed data conversion after another blank draft is selected', async () => {
    const session = editor();
    let release!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })));
    const saving = session.persistence.saveAsset(input('data:text/plain,notes'));
    session.cards.setState({ selectionVersion: session.selection() + 1,
      currentCard: structuredClone(session.cards.getState().currentCard), isDirty: false });
    release(new Response('notes', { headers: { 'content-type': 'text/plain' } }));
    await expect(saving).rejects.toThrow('selection changed');
    expect(await session.persistence.listAssets('')).toEqual([]);
    expect(session.cards.getState().isDirty).toBe(false);
  });

  it('rejects staging after the owner is disposed', async () => {
    const session = editor();
    session.dispose();
    await expect(session.persistence.saveAsset(input(new File(['notes'], 'notes.txt')))).rejects.toThrow();
    expect(session.cards.getState().isDirty).toBe(false);
  });

  it('reports native read failures instead of presenting an empty library or history', async () => {
    const session = editor();
    vi.spyOn(session.api, 'listCards').mockResolvedValue({ error: 'Library offline' });
    vi.spyOn(session.api, 'listVersions').mockResolvedValue({ error: 'History offline' });
    await expect(session.persistence.listCards()).rejects.toThrow('Library offline');
    await expect(session.persistence.listVersions('card')).rejects.toThrow('History offline');
  });
});
