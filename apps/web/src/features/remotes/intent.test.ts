import { describe, expect, it } from 'vitest';
import { clearPreparation, createPreparation, loadPreparation, preparationKey, retainPreparation, type ReturnPreparation } from './intent';

const preparation: ReturnPreparation = {
  version: 1, actorId: 'actor', workspaceId: 'workspace', connectionId: 'remote',
  cardId: 'saved-card', revisionId: 'saved-revision', requestId: 'a'.repeat(43), title: 'Example', sequence: 2,
};
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe('durable remote return preparation', () => {
  it('restores the exact saved revision and operation ID only for the same actor and workspace', () => {
    const saved = storage();
    retainPreparation(saved, preparation);
    expect(loadPreparation(saved, 'actor', 'workspace')).toEqual(preparation);
    expect(loadPreparation(saved, 'other-actor', 'workspace')).toBeNull();
    expect(loadPreparation(saved, 'actor', 'other-workspace')).toBeNull();
    expect(preparationKey('a:b', 'c')).not.toBe(preparationKey('a', 'b:c'));
  });

  it('holds malformed or cross-account persisted intent instead of treating it as a fresh preparation', () => {
    const saved = storage();
    saved.setItem(preparationKey('actor', 'workspace'), JSON.stringify({ ...preparation, actorId: 'other-actor' }));
    expect(() => loadPreparation(saved, 'actor', 'workspace')).toThrow('Saved return preparation is unreadable');
    saved.setItem(preparationKey('actor', 'workspace'), '{broken');
    expect(() => loadPreparation(saved, 'actor', 'workspace')).toThrow('Saved return preparation is unreadable');
  });

  it('does not replace an unconfirmed operation and clears only the preparation acknowledged by the caller', () => {
    const saved = storage();
    retainPreparation(saved, preparation);
    expect(() => retainPreparation(saved, { ...preparation, requestId: 'b'.repeat(43) })).toThrow('Recover or dismiss');
    clearPreparation(saved, 'actor', 'workspace', 'b'.repeat(43));
    expect(loadPreparation(saved, 'actor', 'workspace')).toEqual(preparation);
    clearPreparation(saved, 'actor', 'workspace', preparation.requestId);
    expect(loadPreparation(saved, 'actor', 'workspace')).toBeNull();
  });

  it('snapshots a saved owned revision and refuses a read-only Archive reference', () => {
    const card = { id: 'card', headRevisionId: 'saved-head', name: 'Character', revisionCount: 3 };
    const intent = createPreparation({ actorId: 'actor', workspaceId: 'workspace' }, 'remote', card);
    card.headRevisionId = 'later-head';
    expect(intent).toMatchObject({ actorId: 'actor', workspaceId: 'workspace', revisionId: 'saved-head', sequence: 3 });
    expect(intent.requestId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(() => createPreparation({ actorId: 'actor', workspaceId: 'workspace' }, 'remote', { ...card,
      reference: { archiveId: 'archive', cardId: 'original', versionId: 'version' } })).toThrow('read-only');
  });
});
