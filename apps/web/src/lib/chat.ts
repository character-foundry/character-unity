import { useEffect, useState, useSyncExternalStore } from 'react';
import type { LibraryClient } from './unity';
import { UnityError } from './unity';
import { useLibraryClient } from './library-client';

export type ChatKind = 'sillytavern' | 'lumiverse' | 'marinara';
export type PlacementStatus = 'current' | 'behind' | 'edited' | 'missing';
export interface ChatTarget {
  id: string; kind: ChatKind; name: string; baseUrl: string;
  createdAt: string; scannedAt: string | null; scanError: string | null;
}
export interface ChatPlacement {
  targetId: string; targetName: string; kind: ChatKind; remoteId: string; remoteName: string;
  cardId: string; revisionId: string | null; revisionSequence: number | null; headSequence: number;
  status: PlacementStatus; sentAt: string | null; seenAt: string | null;
}
export interface ChatCredentials { username?: string; password?: string; apiKey?: string }

export const chatKinds: { kind: ChatKind; label: string; short: string; defaultUrl: string; auth: 'basic' | 'login'; ready: boolean }[] = [
  { kind: 'sillytavern', label: 'SillyTavern', short: 'ST', defaultUrl: 'http://127.0.0.1:8000', auth: 'basic', ready: true },
  { kind: 'lumiverse', label: 'Lumiverse', short: 'LV', defaultUrl: 'http://127.0.0.1:7861', auth: 'login', ready: true },
  { kind: 'marinara', label: 'Marinara Engine', short: 'ME', defaultUrl: 'http://127.0.0.1:7860', auth: 'basic', ready: true },
];
export const kindInfo = (kind: ChatKind) => chatKinds.find((item) => item.kind === kind)!;

export const statusInfo: Record<PlacementStatus, { label: string; tone: string; hint: string }> = {
  current: { label: 'Current', tone: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40', hint: 'The copy matches the latest saved revision.' },
  behind: { label: 'Behind', tone: 'bg-amber-500/20 text-amber-300 border-amber-500/40', hint: 'The library has newer saves than this copy.' },
  edited: { label: 'Edited there', tone: 'bg-sky-500/20 text-sky-300 border-sky-500/40', hint: 'The copy was changed inside the chat app.' },
  missing: { label: 'Gone', tone: 'bg-starlight/10 text-starlight/50 border-starlight/20', hint: 'The copy was not found at the last scan.' },
};

type ChatLibrary = Pick<LibraryClient, 'workspaceId' | 'connection'>;
const jsonInit = (method: string, body: unknown, signal?: AbortSignal): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });

/** One account/workspace owns this cache, its invalidation and every pending request. */
export function createChatClient(library: ChatLibrary) {
  const base = `/api/workspaces/${encodeURIComponent(library.workspaceId)}/chat`;
  const call = <T>(path: string, init?: RequestInit) => library.connection.request<T>(path, init);
  const targetPath = (id: string) => `${base}/targets/${encodeURIComponent(id)}`;
  let version = 0, cachedTargets: ChatTarget[] | null = null;
  let pendingTargets: { promise: Promise<ChatTarget[]>; controller: AbortController; users: Set<symbol> } | null = null;
  const listeners = new Set<() => void>();
  function changed() {
    version += 1; cachedTargets = null; pendingTargets?.controller.abort(); pendingTargets = null;
    for (const listener of listeners) listener();
  }
  async function mutation<T>(path: string, init: RequestInit): Promise<T> {
    try { return await call<T>(path, init); } finally { changed(); }
  }
  async function targets(signal?: AbortSignal): Promise<ChatTarget[]> {
    signal?.throwIfAborted();
    if (cachedTargets) return cachedTargets;
    if (!pendingTargets) {
      const controller = new AbortController(), generation = version;
      const promise = call<{ targets: ChatTarget[] }>(`${base}/targets`, { signal: controller.signal }).then((value) => {
        if (generation === version && !controller.signal.aborted) cachedTargets = value.targets;
        return value.targets;
      });
      const next = { promise, controller, users: new Set<symbol>() }; pendingTargets = next;
      void promise.finally(() => { if (pendingTargets === next) pendingTargets = null; }).catch(() => undefined);
    }
    const pending = pendingTargets, user = Symbol('chat-target-reader'); pending.users.add(user);
    return new Promise((resolve, reject) => {
      const release = () => { signal?.removeEventListener('abort', abort); pending.users.delete(user); };
      const abort = () => {
        release(); reject(signal?.reason ?? new Error('Chat request canceled.'));
        if (!pending.users.size) { pending.controller.abort(); if (pendingTargets === pending) pendingTargets = null; }
      };
      signal?.addEventListener('abort', abort, { once: true });
      pending.promise.then((value) => { release(); if (!signal?.aborted) resolve(value); }, (error: unknown) => { release(); reject(error); });
    });
  }
  const api = {
    available: library.connection.profile === 'local', targets, changed,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => version,
    add: (input: { kind: ChatKind; name?: string; baseUrl: string; credentials: ChatCredentials }, signal?: AbortSignal) => mutation<ChatTarget>(`${base}/targets`, jsonInit('POST', input, signal)),
    update: (id: string, input: { name?: string; baseUrl?: string; credentials?: ChatCredentials }, signal?: AbortSignal) => mutation<ChatTarget>(targetPath(id), jsonInit('PATCH', input, signal)),
    remove: (id: string, signal?: AbortSignal) => mutation<void>(targetPath(id), { method: 'DELETE', signal }),
    check: (id: string, signal?: AbortSignal) => mutation<{ characters: number }>(`${targetPath(id)}/check`, { method: 'POST', signal }),
    scan: (id: string, signal?: AbortSignal) => mutation<{ found: number }>(`${targetPath(id)}/scan`, { method: 'POST', signal }),
    send: (targetId: string, cardId: string, overwriteEdited = false, signal?: AbortSignal) => mutation<ChatPlacement>(`${targetPath(targetId)}/sends`, jsonInit('POST', { cardId, ...(overwriteEdited ? { overwriteEdited } : {}) }, signal)),
    forget: (targetId: string, remoteId: string, signal?: AbortSignal) => mutation<void>(`${targetPath(targetId)}/placements?${new URLSearchParams({ remoteId })}`, { method: 'DELETE', signal }),
    async placements(cardIds?: readonly string[], signal?: AbortSignal) {
      const params = new URLSearchParams(); for (const id of cardIds ?? []) params.append('cardId', id);
      return (await call<{ placements: ChatPlacement[] }>(`${base}/placements?${params}`, { signal })).placements;
    },
    async sendCard(target: ChatTarget, cardId: string, signal?: AbortSignal): Promise<ChatPlacement | null> {
      try { return await api.send(target.id, cardId, false, signal); }
      catch (error) {
        if (!(error instanceof UnityError && error.code === 'ACCESS_CHANGED')) throw error;
        signal?.throwIfAborted();
        if (!window.confirm(`${error.message}\n\nReplace the copy in ${target.name}?`)) return null;
        return api.send(target.id, cardId, true, signal);
      }
    },
  };
  return Object.freeze(api);
}
export type ChatClient = ReturnType<typeof createChatClient>;
const clients = new WeakMap<LibraryClient, ChatClient>();
export function useChatApi() {
  const library = useLibraryClient();
  let client = clients.get(library);
  if (!client) { client = createChatClient(library); clients.set(library, client); }
  return client;
}
function useChatVersion(client: ChatClient) { return useSyncExternalStore(client.subscribe, client.snapshot); }

/** Failures remain visible; account failures are never disguised as an empty connection list. */
export function useChatTargets() {
  const api = useChatApi(), version = useChatVersion(api);
  const [value, setValue] = useState<{ owner: ChatClient; targets: ChatTarget[] | null; error: string | null } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    if (!api.available) return () => controller.abort();
    setValue((old) => old?.owner === api ? { ...old, error: null } : { owner: api, targets: null, error: null });
    void api.targets(controller.signal).then((targets) => { if (!controller.signal.aborted) setValue({ owner: api, targets, error: null }); })
      .catch((failure: unknown) => { if (!controller.signal.aborted) setValue({ owner: api, targets: null, error: failure instanceof Error ? failure.message : 'Chat connections could not be loaded.' }); });
    return () => controller.abort();
  }, [api, version]);
  return { targets: value?.owner === api ? value.targets : null, error: value?.owner === api ? value.error : null, available: api.available, retry: api.changed };
}

/** Card IDs and reads belong to the captured library, including cancellation and error state. */
export function usePlacementState(cardIds: readonly string[]) {
  const api = useChatApi(), version = useChatVersion(api), key = JSON.stringify(cardIds);
  const [value, setValue] = useState<{ owner: ChatClient; key: string; placements: Map<string, ChatPlacement[]>; error: string | null } | null>(null);
  useEffect(() => {
    const controller = new AbortController(), ids = JSON.parse(key) as string[];
    const empty = () => ({ owner: api, key, placements: new Map<string, ChatPlacement[]>(), error: null });
    setValue(empty());
    if (!ids.length || !api.available) return () => controller.abort();
    const chunks = Array.from({ length: Math.ceil(ids.length / 100) }, (_, index) => ids.slice(index * 100, index * 100 + 100));
    void Promise.all(chunks.map((chunk) => api.placements(chunk, controller.signal))).then((pages) => {
      if (controller.signal.aborted) return;
      const grouped = new Map<string, ChatPlacement[]>();
      for (const row of pages.flat()) grouped.set(row.cardId, [...grouped.get(row.cardId) ?? [], row]);
      setValue({ owner: api, key, placements: grouped, error: null });
    }).catch((failure: unknown) => { if (!controller.signal.aborted) setValue({ ...empty(), error: failure instanceof Error ? failure.message : 'Chat placements could not be loaded.' }); });
    return () => controller.abort();
  }, [api, key, version]);
  return value?.owner === api && value.key === key ? value : { placements: new Map<string, ChatPlacement[]>(), error: null };
}
export function usePlacements(cardIds: readonly string[]) { return usePlacementState(cardIds).placements; }
