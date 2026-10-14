import { describe, expect, it } from 'vitest';
import { clearContentDraft, readContentDraft, writeContentDraft } from './recovery';

describe('actor/workspace-owned standalone content recovery', () => {
  it('retains invalid in-progress JSON only under its captured owner and never clears another owner’s draft', () => {
    const values = new Map<string,string>(), storage = { getItem: (key: string) => values.get(key) ?? null,setItem: (key: string,value: string) => { values.set(key,value); },removeItem: (key: string) => { values.delete(key); } };
    const draft = { version: 1 as const,key: 'alice:workspace:document',expectedHead: 'revision-1',title: 'Draft',text: '{unfinished',id: 'draft-1' };
    writeContentDraft(storage,draft);
    expect(readContentDraft(storage,draft.key)).toEqual(draft);
    expect(readContentDraft(storage,'bob:workspace:document')).toBeNull();
    clearContentDraft(storage,'bob:workspace:document',draft.id);
    expect(readContentDraft(storage,draft.key)).toEqual(draft);
    writeContentDraft(storage,{ ...draft,id: 'newer-draft' });
    clearContentDraft(storage,draft.key,draft.id);
    expect(readContentDraft(storage,draft.key)?.id).toBe('newer-draft');
  });
  it('does not silently erase unreadable recovery or pretend quota failures succeeded', () => {
    const storage = { getItem: () => '{broken',setItem() { throw new Error('Quota exceeded'); },removeItem() { throw new Error('Must not erase'); } };
    expect(() => readContentDraft(storage,'owner')).toThrow('Recovery');
    expect(() => writeContentDraft(storage,{ version: 1,key: 'owner',expectedHead: 'r',title: 'Draft',text: '{}',id: 'draft' })).toThrow('Quota exceeded');
  });
});
