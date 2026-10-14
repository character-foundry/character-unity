import { expect, it } from 'vitest';
import { loadWorkspacePreference, saveWorkspacePreference } from './workspace-preference';

const alice = { profile: 'hub' as const, actor: { id: 'alice' } };
const browser = { profile: 'browser' as const, actor: { id: 'alice' } };
function memory() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
it('remembers only a workspace ID for this tab, actor and profile', () => {
  const storage = memory(), available = [{ id: 'first' }, { id: 'selected' }];
  saveWorkspacePreference(alice, 'selected', storage);
  expect(loadWorkspacePreference(alice, available, storage)).toBe('selected');
  expect(loadWorkspacePreference({ ...alice, actor: { id: 'bob' } }, available, storage)).toBeNull();
  expect(loadWorkspacePreference(browser, available, storage)).toBeNull();
  expect([...storage.values.values()]).toEqual(['selected']);
});
it('never restores an unavailable or forged workspace and tolerates disabled preferences', () => {
  const storage = memory();
  saveWorkspacePreference(alice, 'foreign-workspace', storage);
  expect(loadWorkspacePreference(alice, [{ id: 'allowed' }], storage)).toBeNull();
  const disabled = { getItem: () => { throw new Error('Blocked'); }, setItem: () => { throw new Error('Blocked'); } };
  expect(loadWorkspacePreference(alice, [{ id: 'allowed' }], disabled)).toBeNull();
  expect(() => saveWorkspacePreference(alice, 'allowed', disabled)).not.toThrow();
});
