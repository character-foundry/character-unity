import { useEffect, useState } from 'react';
import { Outlet, useOutletContext } from 'react-router';
import { createEditorSession, type EditorSession } from '@character-unity/architect/host';
import { AppShell } from '@/components/layout';
import { useLibraryClient } from '@/lib/library-client';

/** One owner across /new → first Save → /edit. It is disposed on leaving the
 * editor routes, not on the draft's first assignment of a permanent card id. */
export default function EditorSessionLayout() {
  const client = useLibraryClient();
  const [session, setSession] = useState<EditorSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let owned: EditorSession | undefined;
    void Promise.resolve().then(() => {
      if (!active) return;
      owned = createEditorSession({ workspaceId: client.workspaceId, reconnect: client.connection.reconnect,
        fetch: client.connection.fetch, actorId: client.connection.actor.id,
        connection: client.connection,
        browserLLM: client.connection.capabilities.browserLLM, signal: client.connection.signal });
      setSession(owned);
    }, (failure: unknown) => {
      if (active) setError(failure instanceof Error ? failure.message : 'The library could not be opened.');
    });
    return () => { active = false; owned?.dispose(); };
  }, [client]);
  if (error) return <AppShell><div role="alert">{error}</div></AppShell>;
  return session ? <Outlet context={session} /> : <AppShell><div className="p-12 text-center opacity-60">Loading editor…</div></AppShell>;
}

export function useLibraryEditorSession() { return useOutletContext<EditorSession>(); }
