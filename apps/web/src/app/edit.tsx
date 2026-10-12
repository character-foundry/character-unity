import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router';
import Link from 'next/link';
import { CardEditor, createEditor } from '@character-unity/editor';
import type { EditorAssetPlan, EditorController, EditorRevision } from '@character-unity/editor';
import { createWorkerTokenizer } from '@character-unity/editor/worker-tokenizer';
import { AppShell } from '@/components/layout';
import { editorApi, openCard, type OpenedCard } from '@/lib/unity';

/* eslint-disable @typescript-eslint/no-explicit-any */
// Placeholder host for the scaffold editor. Architect's real editor replaces this mount.
function useEditor(opened: OpenedCard | null): EditorController | null {
  return useMemo(() => {
    if (!opened) return null;
    const id = opened.card.id;
    async function save(input: EditorRevision, plan?: EditorAssetPlan) {
      const revision = plan
        ? await editorApi.saveAssets(id, input.revisionId, input.document, plan as any)
        : await editorApi.save(id, input.revisionId, input.document);
      return { revisionId: revision.id, document: revision.document };
    }
    return createEditor({ revisionId: opened.revision.id, document: opened.revision.document }, {
      tokens: createWorkerTokenizer(),
      history: {
        list: (options, signal) => editorApi.history(id, options as any, signal) as any,
        async read(revisionId, signal) { const revision = await editorApi.revision(id, revisionId, signal); return { revisionId: revision.id, document: revision.document }; },
      },
      save,
      assets: {
        list: (revisionId, signal) => editorApi.assetList(id, revisionId, signal) as any,
        read: (revisionId, path, signal) => editorApi.asset(id, revisionId, path, signal),
        save,
      },
    });
  }, [opened]);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export default function EditPage() {
  const { id = '' } = useParams();
  const [opened, setOpened] = useState<OpenedCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setOpened(null); setError(null);
    openCard(id).then(setOpened, (failure: Error) => setError(failure.message));
  }, [id]);
  const editor = useEditor(opened);
  useEffect(() => {
    if (!editor) return;
    const warn = (event: BeforeUnloadEvent) => { if (editor.getSnapshot().dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [editor]);
  const name = (opened?.revision.document as { data?: { name?: unknown } } | undefined)?.data?.name;

  return (
    <AppShell>
      <div className="max-w-6xl mx-auto">
        <div className="mb-4 flex items-center justify-between gap-4">
          <div>
            <Link href={`/card/${id}`} className="text-sm text-starlight/60 hover:text-nebula">← Back to profile</Link>
            <h1 className="text-2xl font-bold gradient-text mt-1">{typeof name === 'string' && name ? name : 'Editor'}</h1>
          </div>
          <span className="text-xs px-2 py-1 rounded bg-solar/20 text-solar" title="Architect's editor will replace this">Scaffold editor</span>
        </div>
        {error && <div className="bg-red-500/20 border border-red-500/40 rounded-lg px-4 py-3 text-red-200/90" role="alert">{error}</div>}
        {!error && !editor && <div className="glass rounded-xl p-12 text-center text-starlight/50 animate-pulse">Loading…</div>}
        {editor && <div className="unity-editor-host"><CardEditor editor={editor} /></div>}
      </div>
    </AppShell>
  );
}
