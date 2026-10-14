import { StoreError, type ArchiveAsset, type ArchiveForkSource, type ArchiveReference, type Asset, type Card, type CardSource, type Revision, type Workspace } from '@character-unity/store';
import { fold, librarySource } from '@character-unity/store/library-query';
import { text } from '@character-unity/store/validation';
import { statisticsBreakdownLimit, type ContentStatistics, type StatisticsCount, type StatisticsReader, type WorkspaceStatistics } from '@character-unity/store/statistics';
import { request, transaction } from './transaction.js';
import { retirementKey } from './maintenance.js';

const trim = (value: string) => value.replace(/^ +| +$/g, '');
const label = (value: unknown) => typeof value === 'string' ? fold(trim(value)) : '';
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const length = (value: unknown) => Array.isArray(value) ? value.length : 0;
const names = ['workspaces', 'cards', 'revisions', 'sources', 'deletions', 'favorites', 'metrics', 'archiveReferences', 'archiveForks', 'assets', 'archiveAssets', 'meta'];
function breakdown(values: readonly string[]): StatisticsCount[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)).slice(0, statisticsBreakdownLimit);
}
function coverage(values: readonly (number | undefined)[]): ContentStatistics {
  const known = values.filter((value): value is number => value !== undefined);
  return { total: known.reduce((sum, value) => sum + value, 0), cards: known.filter((value) => value > 0).length, knownCards: known.length };
}

/** One read-only snapshot of this small browser-owned library. No original or
 * Archive bytes are loaded; reference coverage uses its retained summary only. */
export function createBrowserStatisticsReader(db: IDBDatabase): StatisticsReader {
  return { async read(workspaceId) {
    text(workspaceId, 'workspaceId');
    return transaction(db, names, 'readonly', function* (tx) {
      const workspace = yield* request<Workspace | undefined>(tx.objectStore('workspaces').get(workspaceId));
      if (!workspace) throw new StoreError('NOT_FOUND', 'Workspace not found');
      const range = IDBKeyRange.bound([workspaceId], [workspaceId, []]);
      const deleted = new Set((yield* request<{ cardId: string }[]>(tx.objectStore('deletions').getAll())).map((row) => row.cardId));
      const cards = (yield* request<Card[]>(tx.objectStore('cards').index('workspace').getAll(range))).filter((card) => card.headRevisionId && !deleted.has(card.id));
      const ids = new Set(cards.map((card) => card.id));
      const revisions = (yield* request<Revision[]>(tx.objectStore('revisions').getAll())).filter((revision) => revision.workspaceId === workspaceId && ids.has(revision.cardId));
      const heads = new Map(revisions.map((revision) => [revision.id, revision]));
      const references = yield* request<ArchiveReference[]>(tx.objectStore('archiveReferences').index('workspace').getAll(range));
      const forks = new Map((yield* request<ArchiveForkSource[]>(tx.objectStore('archiveForks').getAll())).map((row) => [row.cardId, row]));
      const favorites = new Set((yield* request<{ cardId: string }[]>(tx.objectStore('favorites').getAll())).map((row) => row.cardId));
      const sources = new Map((yield* request<CardSource[]>(tx.objectStore('sources').getAll())).map((row) => [row.cardId, row]));
      const metrics = new Map((yield* request<{ revisionId: string; total: number }[]>(tx.objectStore('metrics').getAll())).map((row) => [row.revisionId, row.total]));
      const inherited = new Set((yield* request<ArchiveAsset[]>(tx.objectStore('archiveAssets').getAll())).map((row) => row.assetId));
      const metadata = new Set((yield* request<{ key: string }[]>(tx.objectStore('meta').getAll())).map((row) => row.key));
      const assets = (yield* request<Asset[]>(tx.objectStore('assets').getAll())).filter((asset) => asset.workspaceId === workspaceId && !metadata.has(retirementKey(asset.storageKey)));
      const membership: WorkspaceStatistics['membership'] = { total: cards.length + references.length, owned: cards.length,
        archiveReferences: references.length, forks: cards.filter((card) => card.forkedFromRevisionId || forks.has(card.id)).length,
        favorites: cards.filter((card) => favorites.has(card.id)).length + references.filter((reference) => reference.favorite).length, inChat: 0 };
      const tags: string[] = [], creators: string[] = [], formats: string[] = [], providers: string[] = [];
      const greetings: (number | undefined)[] = [], lorebook: (number | undefined)[] = [], tokens: number[] = [];
      function row(input: { tags: unknown; creator: unknown; format: string; source: string; greetings: number | undefined; lorebook: number | undefined; tokens: number | null | undefined }) {
        tags.push(...new Set((Array.isArray(input.tags) ? input.tags : []).map(label).filter(Boolean)));
        const creator = label(input.creator); if (creator) creators.push(creator);
        formats.push(input.format); providers.push(input.source); greetings.push(input.greetings); lorebook.push(input.lorebook);
        if (input.tokens !== undefined && input.tokens !== null) tokens.push(input.tokens);
      }
      for (const card of cards) {
        const head = heads.get(card.headRevisionId); if (!head) throw new StoreError('INTEGRITY', 'The library head is missing');
        const data = object(head.document.data), source = sources.get(card.id);
        row({ tags: data.tags, creator: data.creator, format: label(source?.provenance.format) || 'unknown',
          source: label(forks.get(card.id)?.sourceProvider ?? librarySource(source?.provenance, head.document)),
          greetings: (typeof data.first_mes === 'string' && data.first_mes.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '') ? 1 : 0)
            + length(data.alternate_greetings) + length(data.group_only_greetings),
          lorebook: length(object(data.character_book).entries), tokens: metrics.get(head.id) });
      }
      for (const { summary } of references) row({ tags: summary.tags, creator: summary.creator, format: label(summary.format), source: label(summary.source),
        greetings: summary.greetingCount, lorebook: summary.lorebookEntryCount, tokens: summary.tokensTotal });
      const storage: WorkspaceStatistics['storage'] = { localAssets: 0, localBytes: 0, inheritedAssets: 0, inheritedBytes: 0, stagedAssets: 0, stagedBytes: 0 };
      for (const asset of assets) {
        if (inherited.has(asset.id)) { storage.inheritedAssets++; storage.inheritedBytes += asset.byteLength; }
        else if (asset.state === 'ready') { storage.localAssets++; storage.localBytes += asset.byteLength; }
        if (asset.state === 'staged') { storage.stagedAssets++; storage.stagedBytes += asset.byteLength; }
      }
      return { membership, content: { ownedRevisions: revisions.length, greetings: coverage(greetings), lorebookEntries: coverage(lorebook),
        tokens: { total: tokens.reduce((sum, count) => sum + count, 0), knownCards: tokens.length } }, storage,
        chat: { copies: 0, matched: 0, edited: 0 }, tags: breakdown(tags), creators: breakdown(creators), formats: breakdown(formats), sources: breakdown(providers) };
    });
  } };
}
