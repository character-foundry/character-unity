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

export function ArchitectEditorHost({ config, cardId, onExit }: { config: UnityHostConfig; cardId: string; onExit?: () => void }) {
  const Editor = architectEditor(config);
  return (
    <Suspense fallback={<div className="p-12 text-center opacity-60">Loading editor…</div>}>
      <Editor cardId={cardId} onExit={onExit} />
    </Suspense>
  );
}
