import type { StoreDriver } from './driver.js';
import { StoreError } from './types.js';
import { text } from './validation.js';
import { libraryOrderProjectionSql, librarySourceSql } from './library-query.js';

export interface StatisticsCount { label: string; count: number }
export interface ContentStatistics { total: number; cards: number; knownCards: number }
/** Library membership is not corpus size. Storage totals count retained, non-retired
 * workspace asset records; inherited bytes remain in Archive and are never copied. */
export interface WorkspaceStatistics {
  membership: { total: number; owned: number; archiveReferences: number; forks: number; favorites: number; inChat: number };
  content: { ownedRevisions: number; greetings: ContentStatistics; lorebookEntries: ContentStatistics; tokens: { total: number; knownCards: number } };
  storage: { localAssets: number; localBytes: number; inheritedAssets: number; inheritedBytes: number; stagedAssets: number; stagedBytes: number };
  chat: { copies: number; matched: number; edited: number };
  tags: StatisticsCount[]; creators: StatisticsCount[]; formats: StatisticsCount[]; sources: StatisticsCount[];
}
export interface StatisticsReader { read(workspaceId: string): Promise<WorkspaceStatistics> }
export const statisticsBreakdownLimit = 12;

const counts = (table: 'tags' | 'creators' | 'formats' | 'sources') => `(SELECT json_group_array(json_object('label',label,'count',amount))
  FROM (SELECT label,count(*) AS amount FROM ${table} GROUP BY label ORDER BY amount DESC,label LIMIT ${statisticsBreakdownLimit}))`;
const coverage = (field: 'greetings' | 'lorebook') => `json_object('total',coalesce(sum(${field}),0),
  'cards',coalesce(sum(${field} > 0),0),'knownCards',count(${field}))`;
/** One statement gives every panel the same SQLite/D1 read snapshot. Materialized
 * heads/summaries are reused by all aggregates; original files are never opened. */
const statisticsSql = `WITH selected_workspace AS (SELECT id FROM unity_workspaces WHERE id = ?),
  library AS MATERIALIZED (
    SELECT c.id,'owned' AS kind,r.document_json AS document,'$.data.tags' AS tags_path,
      lower(trim(CASE WHEN json_type(r.document_json,'$.data.creator') = 'text'
        THEN json_extract(r.document_json,'$.data.creator') ELSE '' END)) AS creator,
      lower(coalesce(nullif(trim(json_extract(s.provenance_json,'$.format')),''),'unknown')) AS format,
      lower(coalesce(af.source_provider,${librarySourceSql})) AS source,
      (c.forked_from_revision_id IS NOT NULL OR af.card_id IS NOT NULL) AS fork,
      (v.card_id IS NOT NULL) AS favorite,${libraryOrderProjectionSql.greetings} AS greetings,
      ${libraryOrderProjectionSql.lorebook} AS lorebook,m.tokens_total AS tokens
    FROM unity_cards c JOIN unity_revisions r ON r.id = c.head_revision_id
      LEFT JOIN unity_card_sources s ON s.card_id = c.id
      LEFT JOIN unity_archive_fork_sources af ON af.card_id = c.id
      LEFT JOIN unity_card_favorites v ON v.card_id = c.id
      LEFT JOIN unity_revision_metrics m ON m.revision_id = r.id
    WHERE c.workspace_id IN (SELECT id FROM selected_workspace)
      AND NOT EXISTS (SELECT 1 FROM unity_card_deletions d WHERE d.card_id = c.id)
    UNION ALL
    SELECT c.id,'reference',c.summary_json,'$.tags',lower(trim(json_extract(c.summary_json,'$.creator'))),
      lower(json_extract(c.summary_json,'$.format')),lower(json_extract(c.summary_json,'$.source')),
      0,c.favorite,json_extract(c.summary_json,'$.greetingCount'),json_extract(c.summary_json,'$.lorebookEntryCount'),
      json_extract(c.summary_json,'$.tokensTotal')
    FROM unity_archive_references c WHERE c.workspace_id IN (SELECT id FROM selected_workspace)
  ), tags AS (
    SELECT DISTINCT l.id,lower(trim(t.value)) AS label FROM library l,
      json_each(CASE WHEN json_type(l.document,l.tags_path) = 'array' THEN json_extract(l.document,l.tags_path) ELSE '[]' END) t
    WHERE t.type = 'text' AND trim(t.value) <> ''
  ), creators AS (SELECT creator AS label FROM library WHERE creator <> ''),
  formats AS (SELECT format AS label FROM library), sources AS (SELECT source AS label FROM library),
  storage AS MATERIALIZED (
    SELECT a.state,a.byte_length,(aa.asset_id IS NOT NULL) AS inherited FROM unity_assets a
      LEFT JOIN unity_archive_assets aa ON aa.asset_id = a.id
    WHERE a.workspace_id IN (SELECT id FROM selected_workspace)
      AND NOT EXISTS (SELECT 1 FROM unity_asset_retirements ar WHERE ar.asset_id = a.id)
  ), copies AS MATERIALIZED (
    SELECT p.card_id AS card_id,p.remote_state AS state FROM unity_chat_placements p
      JOIN unity_chat_targets t ON t.id = p.target_id AND t.workspace_id = p.workspace_id
      JOIN library l ON l.id = p.card_id AND l.kind = 'owned'
    WHERE p.workspace_id IN (SELECT id FROM selected_workspace) AND p.remote_state <> 'missing'
    UNION ALL
    SELECT p.reference_id,p.remote_state FROM unity_archive_chat_placements p
      JOIN unity_chat_targets t ON t.id = p.target_id AND t.workspace_id = p.workspace_id
      JOIN unity_archive_references a ON a.id = p.reference_id AND a.archive_version_id = p.revision_id
      JOIN library l ON l.id = p.reference_id AND l.kind = 'reference'
    WHERE p.workspace_id IN (SELECT id FROM selected_workspace) AND p.remote_state <> 'missing'
  )
  SELECT json_object(
    'membership',(SELECT json_object('total',count(*),'owned',coalesce(sum(kind = 'owned'),0),
      'archiveReferences',coalesce(sum(kind = 'reference'),0),'forks',coalesce(sum(fork),0),
      'favorites',coalesce(sum(favorite),0),'inChat',(SELECT count(DISTINCT card_id) FROM copies)) FROM library),
    'content',(SELECT json_object('ownedRevisions',(SELECT count(*) FROM unity_revisions r
        JOIN library l ON l.id = r.card_id AND l.kind = 'owned'),
      'greetings',${coverage('greetings')},'lorebookEntries',${coverage('lorebook')},
      'tokens',json_object('total',coalesce(sum(tokens),0),'knownCards',count(tokens))) FROM library),
    'storage',(SELECT json_object('localAssets',coalesce(sum(state = 'ready' AND NOT inherited),0),
      'localBytes',coalesce(sum(CASE WHEN state = 'ready' AND NOT inherited THEN byte_length ELSE 0 END),0),
      'inheritedAssets',coalesce(sum(inherited),0),'inheritedBytes',coalesce(sum(CASE WHEN inherited THEN byte_length ELSE 0 END),0),
      'stagedAssets',coalesce(sum(state = 'staged'),0),'stagedBytes',coalesce(sum(CASE WHEN state = 'staged' THEN byte_length ELSE 0 END),0)) FROM storage),
    'chat',(SELECT json_object('copies',count(*),'matched',coalesce(sum(state = 'matched'),0),'edited',coalesce(sum(state = 'edited'),0)) FROM copies),
    'tags',${counts('tags')},'creators',${counts('creators')},'formats',${counts('formats')},'sources',${counts('sources')}
  ) AS statistics FROM selected_workspace`;

/** Read-only adapter. No document loading, token backfill or Archive access occurs. */
export function createStatisticsStore(driver: StoreDriver): StatisticsReader {
  return {
    async read(workspaceId) {
      const [row] = await driver.query<{ statistics: string }>({ sql: statisticsSql, params: [text(workspaceId, 'workspaceId')] });
      if (!row) throw new StoreError('NOT_FOUND', 'Workspace not found');
      return JSON.parse(row.statistics) as WorkspaceStatistics;
    },
  };
}
