import { createHash } from 'node:crypto';
import type { ArchiveQuery } from './query.js';

/** A paging receipt, not a pinned historical database. Any changed inputs or
 * generation require a fresh first page instead of mixing two result sets. */
export function searchSnapshot(query: ArchiveQuery, generation: string, ranking?: unknown): string {
  return createHash('sha256').update(JSON.stringify({ generation,
    query: { q: query.q ?? '', mode: query.mode ?? '', filter: query.filter ?? '', tags: query.tags ?? [], tagMode: query.tagMode ?? 'all',
      exclude: query.exclude ?? [], has: query.has ?? [], provider: query.provider ?? '', minTokens: query.minTokens ?? 0,
      creators: query.creators ?? [], sort: query.sort ?? '', libraryWorkspaceId: query.libraryWorkspaceId ?? '' }, ranking,
  })).digest('hex');
}
