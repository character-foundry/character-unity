import { useNavigate, useParams } from 'react-router';
import { ArchitectEditorHost } from '@character-unity/architect/host';
import { AppShell } from '@/components/layout';
import { useLibraryEditorSession } from './editor-session';
import { libraryChanged } from '@/lib/library-search';

/** New card or fork (`/card/:id/fork`): an editor draft held in memory. Nothing reaches the library until Save. */
export default function NewCardPage() {
  const navigate = useNavigate();
  const forkOf = useParams().id;
  const session = useLibraryEditorSession();

  return (
    <AppShell>
        <ArchitectEditorHost config={{ workspaceId: session.workspaceId }} session={session} cardId="" forkOf={forkOf}
          onExit={() => navigate(-1)}
          onCreated={(id) => { libraryChanged(); navigate(`/card/${id}/edit`, { replace: true }); }} />
    </AppShell>
  );
}
