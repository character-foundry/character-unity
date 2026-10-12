import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import Link from 'next/link';
import { ArchitectEditorHost } from '@character-unity/architect/host';
import { AppShell } from '@/components/layout';
import { libraryId, reconnectSession } from '@/lib/unity';

export default function EditPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { libraryId().then(setWorkspaceId, (failure: Error) => setError(failure.message)); }, []);

  return (
    <AppShell>
      <div className="mb-3">
        <Link href={`/card/${id}`} className="text-sm text-starlight/60 hover:text-nebula">← Back to profile</Link>
      </div>
      {error && <div className="bg-red-500/20 border border-red-500/40 rounded-lg px-4 py-3 text-red-200/90" role="alert">{error}</div>}
      {workspaceId && (
        <ArchitectEditorHost config={{ workspaceId, reconnect: reconnectSession }} cardId={id} onExit={() => navigate(`/card/${id}`)} />
      )}
    </AppShell>
  );
}
