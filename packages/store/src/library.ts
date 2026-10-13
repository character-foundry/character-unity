import type { StoreDriver } from './driver.js';
import type { ArchiveReference, Card, CardSummaryQuery, LibrarySummaryPage, Revision } from './types.js';
import { StoreError } from './types.js';
import { archiveReferenceFilterSql, archiveReferenceInChatSql, libraryFilterSql, libraryInChatSql, libraryOrderProjectionSql, librarySourceSql, libraryTokensSql } from './library-query.js';
import * as validate from './validation.js';

const notDeleted = 'NOT EXISTS (SELECT 1 FROM unity_card_deletions d WHERE d.card_id = c.id)';
const source = `coalesce(af.source_provider,${librarySourceSql})`;
const localForkCount = `(SELECT count(*) FROM unity_cards f JOIN unity_revisions fr ON fr.id = f.forked_from_revision_id
  WHERE fr.card_id = c.id AND f.workspace_id = c.workspace_id
  AND NOT EXISTS (SELECT 1 FROM unity_card_deletions d WHERE d.card_id = f.id))`;
const referenceForkCount = `(SELECT count(*) FROM unity_archive_fork_sources f WHERE f.workspace_id = c.workspace_id
  AND f.archive_id = c.archive_id AND f.archive_card_id = c.archive_card_id
  AND f.archive_version_id = c.archive_version_id
  AND NOT EXISTS (SELECT 1 FROM unity_card_deletions d WHERE d.card_id = f.card_id))`;
const sortSql = {
  edited: 'revisionCreatedAt DESC,id', added: 'cardCreatedAt DESC,id', oldest: 'cardCreatedAt ASC,id',
  name: 'name ASC,id', name_desc: 'name DESC,id', tokens_desc: 'coalesce(tokensTotal,-1) DESC,revisionCreatedAt DESC,id',
  tokens_asc: 'tokensTotal IS NULL,tokensTotal ASC,revisionCreatedAt DESC,id',
  revisions: 'sequence DESC,revisionCreatedAt DESC,id', forks: 'forkCount DESC,revisionCreatedAt DESC,id',
  greetings: 'greetingCount DESC,revisionCreatedAt DESC,id', lorebook: 'lorebookCount DESC,revisionCreatedAt DESC,id',
};
interface SummaryRow extends Card {
  kind: 'card' | 'reference'; sourceFormat: string | null; source: string; tokensTotal: number | null;
  favorite: number; forkCount: number; inChat: number;
  sourceArchiveId: string | null; sourceArchiveCardId: string | null; sourceArchiveVersionId: string | null;
}
/** Select one globally ordered page before loading any original document. */
export function createLibraryOperations(driver: StoreDriver, readers: {
  revision(workspaceId: string, revisionId: string): Promise<Revision>;
  reference(workspaceId: string, id: string): Promise<ArchiveReference>;
}) {
  return {
    async listLibrarySummaries(workspaceId: string, query: CardSummaryQuery = {}): Promise<LibrarySummaryPage> {
      validate.text(workspaceId, 'workspaceId');
      const limit = validate.limit(query.limit ?? 48), offset = validate.count(query.offset ?? 0, 'offset');
      if (query.ids?.length === 0) return { items: [], total: 0 };
      if (query.ids && query.ids.length > 100) throw new StoreError('INVALID_INPUT', 'At most 100 card IDs');
      const filterInput = { ...query, tags: [...(query.tags ?? []), ...(query.tag?.trim() ? [query.tag] : [])] };
      const localFilter = libraryFilterSql(filterInput, { externalForks: true, sourceExpression: source });
      const referenceFilter = archiveReferenceFilterSql(filterInput);
      const localWhere = ['c.workspace_id = ?', 'c.head_revision_id IS NOT NULL', notDeleted, ...localFilter.where];
      const referenceWhere = ['c.workspace_id = ?', ...referenceFilter.where];
      const localParams: (string | number)[] = [workspaceId, ...localFilter.params], referenceParams: (string | number)[] = [workspaceId, ...referenceFilter.params];
      if (query.forkOf) {
        localWhere.push(`(c.forked_from_revision_id IN (SELECT id FROM unity_revisions WHERE workspace_id = c.workspace_id AND card_id = ?)
          OR EXISTS (SELECT 1 FROM unity_archive_fork_sources af WHERE af.card_id = c.id AND af.reference_id = ?))`);
        const forkOf = validate.text(query.forkOf, 'forkOf'); localParams.push(forkOf, forkOf); referenceWhere.push('0');
      }
      if (query.ids) {
        const ids = query.ids.map((id) => validate.text(id, 'cardId')), clause = `c.id IN (${ids.map(() => '?').join(',')})`;
        localWhere.push(clause); referenceWhere.push(clause); localParams.push(...ids); referenceParams.push(...ids);
      }
      const locals = `SELECT 'card' AS kind,c.id,c.workspace_id AS workspaceId,c.head_revision_id AS headRevisionId,
        c.original_hash AS originalHash,c.forked_from_revision_id AS forkedFromRevisionId,c.created_at AS createdAt,
        c.created_at AS cardCreatedAt,r.created_at AS revisionCreatedAt,${libraryOrderProjectionSql.name} AS name,
        r.sequence,${libraryOrderProjectionSql.greetings} AS greetingCount,${libraryOrderProjectionSql.lorebook} AS lorebookCount,
        json_extract(s.provenance_json,'$.format') AS sourceFormat,${source} AS source,${libraryTokensSql} AS tokensTotal,
        EXISTS (SELECT 1 FROM unity_card_favorites v WHERE v.card_id = c.id) AS favorite,${localForkCount} AS forkCount,
        af.archive_id AS sourceArchiveId,af.archive_card_id AS sourceArchiveCardId,af.archive_version_id AS sourceArchiveVersionId,
        ${libraryInChatSql} AS inChat
        FROM unity_cards c JOIN unity_revisions r ON r.id = c.head_revision_id LEFT JOIN unity_card_sources s ON s.card_id = c.id
        LEFT JOIN unity_archive_fork_sources af ON af.card_id = c.id
        WHERE ${localWhere.join(' AND ')}`;
      const references = `SELECT 'reference' AS kind,c.id,c.workspace_id AS workspaceId,c.archive_version_id AS headRevisionId,
        c.file_hash AS originalHash,NULL AS forkedFromRevisionId,c.created_at AS createdAt,c.created_at AS cardCreatedAt,
        coalesce(nullif(json_extract(c.summary_json,'$.changedAt'),''),c.created_at) AS revisionCreatedAt,
        lower(json_extract(c.summary_json,'$.name')) AS name,coalesce(json_extract(c.summary_json,'$.versionCount'),1) AS sequence,
        coalesce(json_extract(c.summary_json,'$.greetingCount'),0) AS greetingCount,
        coalesce(json_extract(c.summary_json,'$.lorebookEntryCount'),0) AS lorebookCount,
        json_extract(c.summary_json,'$.format') AS sourceFormat,lower(json_extract(c.summary_json,'$.source')) AS source,
        json_extract(c.summary_json,'$.tokensTotal') AS tokensTotal,c.favorite,${referenceForkCount} AS forkCount,
        NULL AS sourceArchiveId,NULL AS sourceArchiveCardId,NULL AS sourceArchiveVersionId,${archiveReferenceInChatSql} AS inChat
        FROM unity_archive_references c WHERE ${referenceWhere.join(' AND ')}`;
      const union = `${locals} UNION ALL ${references}`, params = [...localParams, ...referenceParams];
      const [count] = await driver.query<{ total: number }>({ sql: `SELECT count(*) AS total FROM (${union})`, params });
      const rows = await driver.query<SummaryRow>({ sql: `SELECT * FROM (${union}) ORDER BY ${sortSql[query.sort ?? 'edited'] ?? sortSql.edited} LIMIT ? OFFSET ?`,
        params: [...params, limit, offset] });
      const items = await Promise.all(rows.map(async (row) => {
        if (row.kind === 'reference') return { reference: await readers.reference(workspaceId, row.id), forkCount: Number(row.forkCount), inChat: Boolean(row.inChat) };
        const card: Card = { id: row.id, workspaceId: row.workspaceId, headRevisionId: row.headRevisionId, originalHash: row.originalHash,
          forkedFromRevisionId: row.forkedFromRevisionId, createdAt: row.createdAt };
        return { card, revision: await readers.revision(workspaceId, row.headRevisionId), sourceFormat: row.sourceFormat,
          ...(row.sourceArchiveId !== null && row.sourceArchiveCardId !== null && row.sourceArchiveVersionId !== null
            ? { archiveSource: { archiveId: row.sourceArchiveId, cardId: row.sourceArchiveCardId, versionId: row.sourceArchiveVersionId } } : {}),
          source: row.source, tokensTotal: row.tokensTotal === null ? null : Number(row.tokensTotal), favorite: Boolean(row.favorite), forkCount: Number(row.forkCount), inChat: Boolean(row.inChat) };
      }));
      return { items, total: Number(count?.total ?? 0) };
    },
  };
}
