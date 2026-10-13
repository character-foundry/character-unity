import { Link, useNavigate, useParams } from 'react-router';
import { ArchitectEditorHost } from '@character-unity/architect/host';
import { AppShell } from '@/components/layout';
import { useLibraryEditorSession } from './editor-session';
import { libraryChanged } from '@/lib/library-search';

export default function EditPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const session = useLibraryEditorSession();

  return (
    <AppShell>
      <div className="mb-3">
        <Link to={`/card/${id}`} className="text-sm text-starlight/60 hover:text-nebula">← Back to profile</Link>
      </div>
      <ArchitectEditorHost config={{ workspaceId: session.workspaceId }} session={session} cardId={id} onExit={() => navigate(`/card/${id}`)}
        onCreated={(created) => { libraryChanged(); navigate(`/card/${encodeURIComponent(created)}/edit`, { replace: true }); }} />
    </AppShell>
  );
}
