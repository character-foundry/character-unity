import { useEffect, useState } from 'react';
import { Outlet, useOutletContext } from 'react-router';
import { createEditorSession, type EditorSession } from '@character-unity/architect/host';
import { AppShell } from '@/components/layout';
import { libraryId, reconnectSession } from '@/lib/unity';

/** One owner across /new → first Save → /edit. It is disposed on leaving the
 * editor routes, not on the draft's first assignment of a permanent card id. */
export default function EditorSessionLayout() {
  const [session, setSession] = useState<EditorSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let owned: EditorSession | undefined;
    void libraryId().then((workspaceId) => {
      if (!active) return;
      owned = createEditorSession({ workspaceId, reconnect: reconnectSession });
      setSession(owned);
    }, (failure: unknown) => {
      if (active) setError(failure instanceof Error ? failure.message : 'The library could not be opened.');
    });
    return () => { active = false; owned?.dispose(); };
  }, []);
  if (error) return <AppShell><div role="alert">{error}</div></AppShell>;
  return session ? <Outlet context={session} /> : <AppShell><div className="p-12 text-center opacity-60">Loading editor…</div></AppShell>;
}

export function useLibraryEditorSession() { return useOutletContext<EditorSession>(); }
