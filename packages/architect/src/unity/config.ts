// Unity host configuration for the ported Architect editor. The host calls
// configureUnityHost() before mounting any Architect component.

export interface UnityHostConfig {
  /** Workspace that holds the library cards this editor edits. */
  workspaceId: string;
  /** Reconnect the host session; called once when a request returns 401. */
  reconnect?: () => Promise<void>;
}

let current: UnityHostConfig | null = null;

export function configureUnityHost(config: UnityHostConfig) { current = { ...config }; }
export function unityHost(): UnityHostConfig | null { return current; }
export function isUnityHost() { return current !== null; }

/** Server revisions are immutable, so typing autosaves to the IndexedDB draft and
 * commits a unity revision after this much idle time (Architect used 2s). */
export const unityAutoSaveDelayMs = 30_000;

/** Portals render inside the scoped root so Architect's styles still apply. */
export function portalRoot(): HTMLElement {
  return document.querySelector<HTMLElement>('.architect-root') ?? document.body;
}

let imageUrl: (cardId: string) => string = () => '';
/** Set by the API facade, which knows each card's head revision. */
export function setCardImageUrl(resolve: (cardId: string) => string) { imageUrl = resolve; }
export function cardImageUrl(cardId: string) { return imageUrl(cardId); }
