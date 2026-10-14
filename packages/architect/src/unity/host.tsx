import { lazy, Suspense, useEffect, useMemo, useRef } from 'react';
import type { UnityHostConfig } from './config';
import { EditorSessionProvider } from './context';
import { createEditorSession } from './session';
import type { EditorSession } from './session-types';

export { createEditorSession } from './session';
export type { EditorSession } from './session-types';
export type { UnityHostConfig } from './config';

const Editor = lazy(async () => {
  const entry = await import('./editor-entry');
  await entry.prepareArchitect();
  return { default: entry.ArchitectEditor };
});

/** Supplied sessions are caller-owned. Otherwise the host owns its lifetime,
 * including React's development setup/cleanup replay. */
export function ArchitectEditorHost({ config, session: supplied, cardId, forkOf, onExit, onCreated }: {
  config: UnityHostConfig; session?: EditorSession; cardId: string; forkOf?: string;
  onExit?: () => void; onCreated?: (cardId: string) => void;
}) {
  const session = useMemo(() => supplied ?? createEditorSession(config), [supplied, config.workspaceId, config.actorId, config.fetch, config.reconnect, config.signal, config.browserLLM, config.connection]);
  const leases = useRef(new Map<EditorSession, number>());
  useEffect(() => {
    if (supplied) return;
    const owners = leases.current;
    owners.set(session, (owners.get(session) ?? 0) + 1);
    return () => {
      const generation = (owners.get(session) ?? 0) + 1;
      owners.set(session, generation);
      queueMicrotask(() => {
        if (owners.get(session) === generation) { session.dispose(); owners.delete(session); }
      });
    };
  }, [session, supplied]);
  if (session.workspaceId !== config.workspaceId) throw new Error('The editor session belongs to a different workspace');
  return (
    <EditorSessionProvider value={session}>
      <Suspense fallback={<div className="p-12 text-center opacity-60">Loading editor…</div>}>
        <Editor cardId={cardId} forkOf={forkOf} onExit={onExit} onCreated={onCreated} />
      </Suspense>
    </EditorSessionProvider>
  );
}
