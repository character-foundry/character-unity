/** Immutable connection settings owned by one editor session. */
export interface UnityHostConfig {
  /** Workspace that holds the library cards this editor edits. */
  workspaceId: string;
  /** Authenticated owner; included in the browser recovery namespace. */
  actorId?: string;
  /** Observable state of the same immutable transport; never a current-session lookup. */
  connection?: {
    readonly profile: 'local' | 'hub';
    subscribe(listener: () => void): () => void;
    snapshot(): { status: 'active' | 'locked' | 'disposed' };
  };
  /** Captured immutable host connection. Account hosts must inject this. */
  fetch?: (path: string, init?: RequestInit) => Promise<Response>;
  /** Disposing the host connection closes this editor's lifetime. */
  signal?: AbortSignal;
  /** Browser credentials and direct model requests are local-install only. */
  browserLLM?: boolean;
  /** Reconnect the host session; called once when a request returns 401. */
  reconnect?: (signal?: AbortSignal) => Promise<void>;
}
