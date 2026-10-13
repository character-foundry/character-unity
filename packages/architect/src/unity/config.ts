/** Immutable connection settings owned by one editor session. */
export interface UnityHostConfig {
  /** Workspace that holds the library cards this editor edits. */
  workspaceId: string;
  /** Reconnect the host session; called once when a request returns 401. */
  reconnect?: (signal?: AbortSignal) => Promise<void>;
}
