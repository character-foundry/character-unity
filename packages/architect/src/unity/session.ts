import { UnityApiClient } from '../lib/api';
import { createCardStore } from '../store/card-store';
import { createUIStore } from '../store/ui-store';
import { createTokenStore } from '../store/token-store';
import { createLLMStore } from '../store/llm-store';
import { ServerPersistenceAdapter } from '../adapters/persistence/server-adapter';
import type { UnityHostConfig } from './config';
import { createDraftRecovery, type DraftRecovery } from './recovery';
import type { EditorSession } from './session-types';

/** Explicit ownership boundary: no mutable current workspace, draft, or client
 * exists outside this object. Shared browser preferences contain no card state. */
export function createEditorSession(config: UnityHostConfig, options: { recovery?: DraftRecovery } = {}): EditorSession {
  config = Object.freeze({ ...config });
  config.signal?.throwIfAborted();
  const id = crypto.randomUUID();
  const lifetime = new AbortController();
  let disposed = false;
  let openVersion = 0;
  let opening = false;
  let selected = new AbortController();
  const isDisposed = () => disposed;
  const api = new UnityApiClient(config, { signal: lifetime.signal });
  const assets = api.assets;
  const recovery = options.recovery ?? createDraftRecovery(JSON.stringify([config.actorId ?? 'local', config.workspaceId]), id,
    config.connection?.profile === 'local' ? { legacyLocalWorkspace: config.workspaceId } : {});
  const ui = createUIStore();
  const tokens = createTokenStore({ api, isDisposed, signal: lifetime.signal });
  const capabilities = Object.freeze({ browserLLM: config.browserLLM === true });
  const llm = createLLMStore({ isDisposed, signal: lifetime.signal, enabled: capabilities.browserLLM });
  const cards = createCardStore({ api, assets, tokens, recovery, isDisposed, signal: lifetime.signal });
  const wizard: EditorSession['wizard'] = { messages: [], hasShownGreeting: false };
  const unsubscribe = cards.subscribe((state, previous) => {
    if (state.selectionVersion === previous.selectionVersion) return;
    selected.abort(); selected = new AbortController();
    wizard.messages = []; wizard.hasShownGreeting = false;
    ui.getState().setActiveTab('edit');
  });
  const session: EditorSession = {
    id, workspaceId: api.workspaceId, capabilities, connection: config.connection, api, assets, cards, ui, tokens, llm, recovery,
    persistence: new ServerPersistenceAdapter(api, assets, cards, lifetime.signal),
    root: { current: null }, signal: lifetime.signal, wizard,
    selection: () => cards.getState().selectionVersion,
    liveSignal: () => AbortSignal.any([lifetime.signal, selected.signal]),
    async open({ cardId, forkOf }) {
      lifetime.signal.throwIfAborted();
      const generation = ++openVersion;
      const current = cards.getState().currentCard;
      // First Save promotes the same draft into a saved card. Route promotion
      // must not reload over text/assets entered while that Save was pending.
      if (cardId && current?.meta.id === cardId) {
        if (opening) cards.getState().cancelPending();
        opening = false;
        return;
      }
      opening = true;
      try {
        if (cardId) await cards.getState().loadCard(cardId);
        else if (forkOf) {
          await cards.getState().loadCard(forkOf);
          if (disposed || generation !== openVersion) return;
          const original = cards.getState().currentCard;
          if (!original || original.meta.id !== forkOf) throw new Error('The card to fork could not be opened.');
          cards.getState().setCurrentCard({ ...original, meta: { ...original.meta, id: '', forkOf } });
        } else await cards.getState().createNewCard();
      } finally { if (generation === openVersion) opening = false; }
    },
    save: () => cards.getState().saveCard(),
    async discard() {
      const current = cards.getState().currentCard;
      if (!current || disposed) return;
      const selection = cards.getState().selectionVersion;
      if (current.meta.id) {
        await recovery.remove(current.meta.id);
        if (!disposed && cards.getState().selectionVersion === selection) await cards.getState().loadCard(current.meta.id);
      } else cards.getState().setCurrentCard(null);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      config.signal?.removeEventListener('abort', close);
      openVersion++;
      lifetime.abort(); selected.abort();
      cards.getState().cancelPending();
      unsubscribe(); api.dispose();
      wizard.messages = []; wizard.hasShownGreeting = false;
    },
  };
  const close = () => session.dispose();
  config.signal?.addEventListener('abort', close, { once: true });
  return session;
}
