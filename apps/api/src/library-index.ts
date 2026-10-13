import { GptTokenizer } from '@character-foundry/character-foundry/tokenizers';
import type { LibraryIndexMutation, LibraryIndexProjection, LibraryIndexReceipt } from '@character-unity/archive-client';
import type { LibraryIndexService, LibraryIndexStatus } from '@character-unity/api';
import type { NativeArchiveOptions } from '@character-unity/cards/native-reader';
import { createNativeArchiveReader } from '@character-unity/cards/native-reader';
import { CardError } from '@character-unity/cards';
import type { Card, Revision, UnityStore } from '@character-unity/store';
import { StoreError } from '@character-unity/store';

const textFields = ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions'] as const;
function projection(card: Card, revision: Revision, tokenizer: GptTokenizer): LibraryIndexProjection {
  const data = (revision.document.data ?? {}) as Record<string, unknown>;
  let remaining = 450_000;
  function text(value: unknown, max = 64_000) {
    if (typeof value !== 'string') return '';
    const bytes = new TextEncoder().encode(value.replace(/\p{Cc}/gu, ' ')), limit = Math.min(bytes.length, remaining, max);
    let end = limit;
    while (end && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    const result = new TextDecoder().decode(bytes.subarray(0, end)); remaining -= end; return result;
  }
  const name = text(data.name, 500), creator = text(data.creator, 200);
  const tags = Array.isArray(data.tags) ? data.tags.filter((value): value is string => typeof value === 'string').slice(0, 200).map((value) => text(value, 120)) : [];
  const fields = Object.fromEntries(textFields.map((field) => [field, text(data[field])])) as Record<typeof textFields[number], string>;
  const alternate = Array.isArray(data.alternate_greetings) ? data.alternate_greetings.filter((value): value is string => typeof value === 'string').slice(0, 16).map((value) => text(value, 8192)) : [];
  const assets = Array.isArray(data.assets) ? data.assets as { type?: unknown }[] : [];
  const extensions = data.extensions as Record<string, unknown> | null;
  const expressionMap = extensions?.expressions ?? (extensions?.chub as { expressions?: unknown } | undefined)?.expressions;
  const book = data.character_book as { entries?: unknown } | null;
  return { name, creator, tags,
    ...fields, alternate_greetings: alternate, tokens: textFields.reduce((sum, field) => sum + (typeof data[field] === 'string' ? tokenizer.count(data[field]) : 0), 0),
    createdAt: card.createdAt, updatedAt: revision.createdAt, spec: revision.document.spec === 'chara_card_v3' ? 'v3' : 'v2', lorebookEntries: Array.isArray(book?.entries) ? book.entries.length : 0,
    hasPortrait: revision.assets.some((asset) => asset.path === 'portrait'),
    flags: { gallery: assets.some((asset) => typeof asset.type === 'string' && !['icon', 'emotion', 'expression'].includes(asset.type)),
      expressions: assets.some((asset) => ['emotion', 'expression'].includes(String(asset.type))) || !!(expressionMap && typeof expressionMap === 'object' && Object.keys(expressionMap).length),
      embeddedImages: /!\[|<img\b/i.test([...Object.values(fields), ...alternate].join('\n')), systemPrompt: !!fields.system_prompt.trim(), exampleDialogues: !!fields.mes_example.trim() } };
}

/** Durable, bounded, event-driven delivery; never a corpus scan or idle polling loop. */
export function createLibraryIndexDispatcher(store: UnityStore, options?: NativeArchiveOptions) {
  const reader = options ? createNativeArchiveReader(options) : undefined;
  const enabled = !!(options?.libraryIndex && options.adminToken && reader);
  const reason = enabled ? null : !reader ? 'The Archive is not connected' : !options?.libraryIndex ? 'Library indexing is not enabled on this host' : 'The Archive admin token is not configured';
  const cancellation = new AbortController(), tokenizer = new GptTokenizer();
  let stopped = false, running: Promise<void> | null = null, scheduled = false, wakeAgain = false;
  let activeWorkspace: string | null = null;
  let semantic: boolean | null = null, lastError: string | null = null;
  async function batch(workspaceId?: string, retryFailed = false) {
    const jobs = await store.listSearchJobs({ limit: 16, includeFailed: retryFailed, ...(workspaceId ? { workspaceId } : {}) });
    for (const job of jobs) {
      if (stopped) return false;
      if (job.error && !retryFailed) continue;
      activeWorkspace = job.workspaceId;
      try {
        let input: LibraryIndexMutation = { workspaceId: job.workspaceId, cardId: job.cardId, revisionId: job.revisionId, operation: job.operation, eventSequence: job.eventSequence };
        if (job.operation === 'upsert') {
          const card = await store.getCard(job.workspaceId, job.cardId), revision = await store.getRevision(job.workspaceId, job.revisionId);
          if (card.headRevisionId !== job.revisionId) continue; // a newer atomic outbox event owns the head
          if (revision.cardId !== job.cardId) throw new StoreError('INTEGRITY', 'Search revision belongs to another card');
          input = { workspaceId: job.workspaceId, cardId: job.cardId, revisionId: job.revisionId, operation: job.operation, eventSequence: job.eventSequence,
            projection: projection(card, revision, tokenizer) };
        }
        const receipt = await reader!.json<LibraryIndexReceipt>('/api/archive/admin/v1/library-index', { method: 'POST', signal: cancellation.signal,
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }, true);
        if (stopped) return false;
        if (receipt.eventSequence !== job.eventSequence || typeof receipt.applied !== 'boolean' || typeof receipt.semantic !== 'boolean') throw new Error('Archive returned an invalid library index receipt');
        if (job.operation === 'upsert' && !receipt.semantic) throw new Error('The Archive did not index saved-card embeddings; configure its matching document provider and retry');
        if (await store.ackSearchJob(job.workspaceId, job.cardId, job.eventSequence)) { semantic = receipt.semantic; lastError = null; }
      } catch (error) {
        if (stopped) return false;
        const message = error instanceof Error ? error.message.slice(0, 2000) : 'Library search indexing failed';
        lastError = message;
        await store.failSearchJob(job.workspaceId, job.cardId, job.eventSequence, message);
        return false; // preserve failed work; do not hammer an unavailable provider with the rest of the batch
      } finally { activeWorkspace = null; }
    }
    return jobs.length === 16;
  }
  function start(workspaceId?: string, retryFailed = false, drainClean = false) {
    if (!enabled || stopped) return Promise.resolve();
    if (running) return running;
    const operation = (async () => {
      while (await batch(workspaceId, retryFailed) && drainClean && !stopped);
    })().catch((error) => { if (!stopped) lastError = error instanceof Error ? error.message : 'Library search indexing failed'; });
    running = operation.finally(() => { running = null; if (wakeAgain && !stopped) { wakeAgain = false; wake(); } });
    return running;
  }
  function wake() {
    if (!enabled || stopped) return;
    if (running) { wakeAgain = true; return; }
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; if (!stopped) void start(undefined, false, true); });
  }
  async function status(workspaceId: string): Promise<LibraryIndexStatus> {
    const jobs = await store.listSearchJobs({ workspaceId, limit: 100 });
    return { enabled, running: activeWorkspace === workspaceId, pending: jobs.length, failed: jobs.filter((job) => !!job.error).length, bounded: jobs.length === 100,
      reason, lastError: jobs.find((job) => job.error)?.error ?? null, semantic };
  }
  async function settle() { while (scheduled || running) { await Promise.resolve(); await running; } }
  const writeMethods = new Set<keyof UnityStore>(['createCard', 'createImportedCard', 'createArchiveFork', 'saveRevision', 'forkCard', 'deleteCard']);
  function wrap(scoped: UnityStore): UnityStore {
    return new Proxy(scoped, { get(target, property, receiver) {
      const method: unknown = Reflect.get(target, property, receiver);
      if (!writeMethods.has(property as keyof UnityStore) || typeof method !== 'function') return method;
      return (...args: unknown[]) => Promise.resolve(Reflect.apply(method, target, args)).then((value) => { wake(); return value; });
    } });
  }
  function service(scoped: UnityStore): LibraryIndexService {
    async function authorize(actor: { id: string }, workspaceId: string) {
      if ((await scoped.getWorkspace(workspaceId)).ownerId !== actor.id) throw new CardError('FORBIDDEN', 'Workspace belongs to another account');
    }
    return { async status(actor, workspaceId) { await authorize(actor, workspaceId); return status(workspaceId); },
      async retry(actor, workspaceId) { await authorize(actor, workspaceId); await settle(); await authorize(actor, workspaceId); await start(workspaceId, true, true); await authorize(actor, workspaceId); return status(workspaceId); } };
  }
  if (enabled) queueMicrotask(() => { if (!stopped) void start(undefined, true); });
  return { wrap, service, wake, settle,
    stop() { stopped = true; cancellation.abort(); }, get lastError() { return lastError; } };
}
export type LibraryIndexDispatcher = ReturnType<typeof createLibraryIndexDispatcher>;
