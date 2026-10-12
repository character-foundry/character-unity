// Entry point for unity hosts. Configure first, then load Architect: several Architect
// modules read the deployment configuration when they are first imported.
import { lazy, Suspense } from 'react';
import { configureUnityHost, type UnityHostConfig } from './config';

export type { UnityHostConfig } from './config';

let editor: ReturnType<typeof lazy<typeof import('./editor-entry').ArchitectEditor>> | null = null;

/** Configure once per page (the editor uses Architect's global stores). */
export function architectEditor(config: UnityHostConfig) {
  configureUnityHost(config);
  editor ??= lazy(async () => {
    const entry = await import('./editor-entry');
    await entry.prepareArchitect();
    return { default: entry.ArchitectEditor };
  });
  return editor;
}

/**
 * An empty `cardId` opens an unsaved draft: blank, or a copy of `forkOf`. Nothing is stored until Save, which
 * reports the new id via `onCreated`.
 */
export function ArchitectEditorHost({ config, cardId, forkOf, onExit, onCreated }: {
  config: UnityHostConfig; cardId: string; forkOf?: string; onExit?: () => void; onCreated?: (cardId: string) => void;
}) {
  const Editor = architectEditor(config);
  return (
    <Suspense fallback={<div className="p-12 text-center opacity-60">Loading editor…</div>}>
      <Editor cardId={cardId} forkOf={forkOf} onExit={onExit} onCreated={onCreated} />
    </Suspense>
  );
}
