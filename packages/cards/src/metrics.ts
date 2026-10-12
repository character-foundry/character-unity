import { GptTokenizer } from '@character-foundry/character-foundry/tokenizers';
import type { UnityStore } from '@character-unity/store';

// Same fields and tokenizer as the profile page and editor (gpt-tokenizer o200k_base via Foundry).
const fields = { description: 'description', personality: 'personality', scenario: 'scenario', mesExample: 'mes_example',
  firstMes: 'first_mes', systemPrompt: 'system_prompt', postHistory: 'post_history_instructions' } as const;
const tokenizerName = 'gpt-tokenizer/o200k_base';
let tokenizer: GptTokenizer | null = null;

/** Counts a revision's tokens once (revisions are immutable) and stores them for filters, sorts and tiles. */
export async function measureRevision(store: UnityStore, workspaceId: string, revisionId: string) {
  const revision = await store.getRevision(workspaceId, revisionId);
  const data = (revision.document as { data?: Record<string, unknown> }).data ?? {};
  tokenizer ??= new GptTokenizer();
  const tokens: Record<string, number> = {};
  let total = 0;
  for (const [key, field] of Object.entries(fields)) {
    const value = data[field];
    // count() approximates on failure (e.g. reserved markers in text), which is fine for filtering.
    tokens[key] = typeof value === 'string' && value ? tokenizer.count(value) : 0;
    total += tokens[key]!;
  }
  await store.putRevisionMetrics(workspaceId, revisionId, { tokenizer: tokenizerName, total, tokens });
  return total;
}

/** Measures current versions that have no counts yet; returns how many were measured. */
export async function measureMissing(store: UnityStore, limit = 100) {
  const missing = await store.revisionsMissingMetrics({ limit });
  for (const item of missing) await measureRevision(store, item.workspaceId, item.revisionId).catch(() => undefined);
  return missing.length;
}
