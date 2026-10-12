import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { ArchitectEditorHost } from '@character-unity/architect/host';
import { AppShell } from '@/components/layout';
import { libraryId, reconnectSession } from '@/lib/unity';
import { libraryChanged } from '@/lib/library-search';

/** New card: an editor draft held in memory. Nothing reaches the library until Save. */
export default function NewCardPage() {
  const navigate = useNavigate();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { libraryId().then(setWorkspaceId, (failure: Error) => setError(failure.message)); }, []);

  return (
    <AppShell>
      {error && <div className="bg-red-500/20 border border-red-500/40 rounded-lg px-4 py-3 text-red-200/90" role="alert">{error}</div>}
      {workspaceId && (
        <ArchitectEditorHost config={{ workspaceId, reconnect: reconnectSession }} cardId=""
          onExit={() => navigate(-1)}
          onCreated={(id) => { libraryChanged(); navigate(`/card/${id}/edit`, { replace: true }); }} />
      )}
    </AppShell>
  );
}
