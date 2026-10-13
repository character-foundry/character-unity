import type { RefObject } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { UnityApiClient } from '../lib/api';
import type { CardStore } from '../store/card-store';
import type { UIStore } from '../store/ui-store';
import type { TokenStore } from '../store/token-store';
import type { LLMStore } from '../store/llm-store';
import type { PersistenceAdapter } from '../adapters/persistence/types';
import type { EditorAssetService } from './assets';
import type { DraftRecovery } from './recovery';

export interface EditorSelection { cardId: string; forkOf?: string }
export interface EditorSession {
  readonly id: string;
  readonly workspaceId: string;
  readonly api: UnityApiClient;
  readonly assets: EditorAssetService;
  readonly cards: StoreApi<CardStore>;
  readonly ui: StoreApi<UIStore>;
  readonly tokens: StoreApi<TokenStore>;
  readonly llm: StoreApi<LLMStore>;
  readonly recovery: DraftRecovery;
  readonly persistence: PersistenceAdapter;
  readonly root: RefObject<HTMLDivElement | null>;
  readonly signal: AbortSignal;
  readonly wizard: { messages: unknown[]; hasShownGreeting: boolean };
  selection(): number;
  liveSignal(): AbortSignal;
  open(selection: EditorSelection): Promise<void>;
  save(): Promise<void>;
  discard(): Promise<void>;
  dispose(): void;
}
