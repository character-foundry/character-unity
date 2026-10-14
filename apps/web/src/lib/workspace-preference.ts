interface Scope { profile: 'local' | 'hub' | 'browser'; actor: { id: string } }
type Preferences = Pick<Storage, 'getItem' | 'setItem'>;
function browserPreferences(): Preferences | null {
  try { return window.sessionStorage; } catch { return null; }
}
const key = (scope: Scope) => `unity:selected-workspace:v1:${JSON.stringify([scope.profile, scope.actor.id])}`;

/** Optional per-tab preference, not authorization or shared mutable client state. */
export function loadWorkspacePreference(scope: Scope, available: readonly { id: string }[], storage = browserPreferences()): string | null {
  try {
    const preferred = storage?.getItem(key(scope));
    return preferred && available.some((workspace) => workspace.id === preferred) ? preferred : null;
  } catch { return null; }
}
export function saveWorkspacePreference(scope: Scope, workspaceId: string, storage = browserPreferences()): void {
  // Only an ID is stored. Disabled preferences must not prevent real library work.
  try { storage?.setItem(key(scope), workspaceId); } catch { /* Optional preference unavailable. */ }
}
