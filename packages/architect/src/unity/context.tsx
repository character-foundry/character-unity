import { createContext, useContext } from 'react';
import type { EditorSession } from './session-types';

const EditorContext = createContext<EditorSession | null>(null);
export const EditorSessionProvider = EditorContext.Provider;

/** An editor must have an explicit owner. There is no mutable global fallback. */
export function useEditorSession(): EditorSession {
  const session = useContext(EditorContext);
  if (!session) throw new Error('Mount the editor inside its EditorSessionProvider');
  return session;
}
