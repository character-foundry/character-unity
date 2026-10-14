import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useSession } from './session-provider';
import { createLibraryClient } from './unity';
import type { LibraryClient } from './unity';
import type { SessionConnection } from './session';

export interface WorkspaceChoice { id: string; name: string }
interface LibraryState {
  client: LibraryClient; workspaces: readonly WorkspaceChoice[];
  selectWorkspace(id: string): void; createWorkspace(name: string): Promise<void>;
}
const Context = createContext<LibraryState | null>(null);
const initialWorkspaces = new WeakMap<SessionConnection, Promise<{ workspaces: WorkspaceChoice[]; selected: string }>>();
function openLibrary(connection: SessionConnection) {
  let pending = initialWorkspaces.get(connection);
  if (!pending) {
    pending = (async () => {
      const { workspaces } = await connection.request<{ workspaces: WorkspaceChoice[] }>('/api/workspaces');
      connection.signal.throwIfAborted();
      let selected = workspaces.find((workspace) => workspace.name === 'Library') ?? workspaces[0];
      if (!selected) {
        selected = await connection.request<WorkspaceChoice>('/api/workspaces', { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Library' }) });
        workspaces.push(selected);
      }
      return { workspaces, selected: selected.id };
    })();
    initialWorkspaces.set(connection, pending);
    void pending.catch(() => initialWorkspaces.delete(connection));
  }
  return pending;
}

/** Workspace ownership is explicit and stable for each mounted route/editor. */
export function LibraryClientProvider({ children }: { children: ReactNode }) {
  const { connection } = useSession();
  const [state, setState] = useState<{ owner: string; workspaces: WorkspaceChoice[]; selected: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!connection) return;
    const controller = new AbortController();
    setError(null);
    void (async () => {
      const opened = await openLibrary(connection);
      if (!controller.signal.aborted) setState({ owner: connection.scopeKey, ...opened });
    })().catch((failure: unknown) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'The library could not be opened.'); });
    return () => controller.abort();
  }, [connection, attempt]);
  const client = useMemo(() => connection && state?.owner === connection.scopeKey
    ? createLibraryClient(connection, state.selected) : null, [connection, state?.owner, state?.selected]);
  if (!client || !state || !connection) return <div className="grid min-h-screen place-items-center bg-canvas p-6 text-ink">
    {error ? <div role="alert" className="space-y-3 text-center"><p>{error}</p><button type="button" onClick={() => setAttempt((value) => value + 1)} className="btn-primary px-4 py-2">Retry library</button></div>
      : <p role="status">Opening your library…</p>}
  </div>;
  const selectWorkspace = (id: string) => {
    if (!state.workspaces.some((workspace) => workspace.id === id)) throw new Error('Workspace does not belong to this connection');
    setState({ ...state, selected: id });
  };
  const createWorkspace = async (name: string) => {
    const owner = connection.scopeKey;
    const workspace = await connection.request<WorkspaceChoice>('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    setState((current) => current?.owner === owner ? { ...current, workspaces: [...current.workspaces, workspace], selected: workspace.id } : current);
  };
  return <Context.Provider value={{ client, workspaces: state.workspaces, selectWorkspace, createWorkspace }}>{children}</Context.Provider>;
}
export function useLibraryState() {
  const state = useContext(Context);
  if (!state) throw new Error('Native library requires its explicit account/workspace provider');
  return state;
}
export function useLibraryClient() { return useLibraryState().client; }
