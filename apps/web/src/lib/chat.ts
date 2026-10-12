import { useEffect, useState, useSyncExternalStore } from 'react';
import { call, libraryId, UnityError } from './unity';

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

const base = async () => `/api/workspaces/${await libraryId()}/chat`;
const jsonInit = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const chatApi = {
  async targets() { return (await call<{ targets: ChatTarget[] }>(`${await base()}/targets`)).targets; },
  async add(input: { kind: ChatKind; name?: string; baseUrl: string; credentials: ChatCredentials }) {
    return call<ChatTarget>(`${await base()}/targets`, jsonInit('POST', input));
  },
  async update(id: string, input: { name?: string; baseUrl?: string; credentials?: ChatCredentials }) {
    return call<ChatTarget>(`${await base()}/targets/${id}`, jsonInit('PATCH', input));
  },
  async remove(id: string) { await call<void>(`${await base()}/targets/${id}`, { method: 'DELETE' }); },
  async check(id: string) { return call<{ characters: number }>(`${await base()}/targets/${id}/check`, { method: 'POST' }); },
  async scan(id: string) { return call<{ found: number }>(`${await base()}/targets/${id}/scan`, { method: 'POST' }); },
  async send(targetId: string, cardId: string, overwriteEdited = false) {
    return call<ChatPlacement>(`${await base()}/targets/${targetId}/sends`, jsonInit('POST', { cardId, ...(overwriteEdited ? { overwriteEdited } : {}) }));
  },
  async forget(targetId: string, remoteId: string) {
    await call<void>(`${await base()}/targets/${targetId}/placements?${new URLSearchParams({ remoteId })}`, { method: 'DELETE' });
  },
  async placements(cardIds?: readonly string[]) {
    const params = new URLSearchParams(); for (const id of cardIds ?? []) params.append('cardId', id);
    return (await call<{ placements: ChatPlacement[] }>(`${await base()}/placements?${params}`)).placements;
  },
};

// Every send, scan or settings change bumps one version so all views refetch.
let version = 0;
const listeners = new Set<() => void>();
export function chatChanged() { version += 1; targets = null; for (const listener of listeners) listener(); }
function useChatVersion() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => version);
}

let targets: Promise<ChatTarget[] | 'unavailable'> | null = null;
function loadTargets() {
  // A host without chat routes (hub profile) answers 503; hide chat features there.
  targets ??= chatApi.targets().catch((error: unknown) => (error instanceof UnityError && error.status === 503 ? 'unavailable' as const : []));
  return targets;
}
/** Connected chat apps, or null while loading / when this host has no chat support. */
export function useChatTargets() {
  const current = useChatVersion();
  const [value, setValue] = useState<{ version: number; targets: ChatTarget[] | null; available: boolean }>({ version: -1, targets: null, available: true });
  useEffect(() => {
    let active = true;
    void loadTargets().then((result) => { if (active) setValue({ version: current, targets: result === 'unavailable' ? [] : result, available: result !== 'unavailable' }); });
    return () => { active = false; };
  }, [current]);
  return { targets: value.targets, available: value.available };
}

/** Placements for the given cards, grouped by card; refetched whenever chat state changes. */
export function usePlacements(cardIds: readonly string[]) {
  const current = useChatVersion();
  const key = cardIds.join(',');
  const [value, setValue] = useState<Map<string, ChatPlacement[]>>(new Map());
  useEffect(() => {
    if (!key) { setValue(new Map()); return; }
    let active = true;
    // The API takes at most 100 card IDs per request.
    const ids = key.split(','), chunks = Array.from({ length: Math.ceil(ids.length / 100) }, (_, index) => ids.slice(index * 100, index * 100 + 100));
    Promise.all(chunks.map((chunk) => chatApi.placements(chunk))).then((pages) => pages.flat()).then((rows) => {
      if (!active) return;
      const grouped = new Map<string, ChatPlacement[]>();
      for (const row of rows) grouped.set(row.cardId, [...(grouped.get(row.cardId) ?? []), row]);
      setValue(grouped);
    }).catch(() => { if (active) setValue(new Map()); });
    return () => { active = false; };
  }, [key, current]);
  return value;
}

/** Sends a card, asking before it replaces edits made inside the chat app. */
export async function sendCard(target: ChatTarget, cardId: string): Promise<ChatPlacement | null> {
  try {
    return await chatApi.send(target.id, cardId);
  } catch (error) {
    if (!(error instanceof UnityError && error.code === 'ACCESS_CHANGED')) throw error;
    if (!window.confirm(`${error.message}\n\nReplace the copy in ${target.name}?`)) return null;
    return chatApi.send(target.id, cardId, true);
  } finally {
    chatChanged();
  }
}
