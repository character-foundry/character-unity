import type { ArchiveQuery, ArchiveSort } from '../native/query.js';
import { NativeArchiveError } from '../native/store.js';

export const existingSort: Record<ArchiveSort, string> = {
  updated: 'c.lastModified DESC', added: 'c.firstDownloadedAt DESC', newest: 'c.createdAt DESC', oldest: 'c.createdAt ASC',
  name: 'c.name COLLATE NOCASE ASC', name_desc: 'c.name COLLATE NOCASE DESC', tokens_desc: 'c.tokenCount DESC', tokens_asc: 'c.tokenCount ASC',
  stars: 'c.starCount DESC', favorites: 'c.n_favorites DESC', chats: 'c.nChats DESC', downloads: 'c.id DESC',
  greetings: 'c.hasAlternateGreetings DESC', lorebook: 'c.hasLorebook DESC',
};

export function existingFilter(query: ArchiveQuery, bookkeeping: boolean, ids?: readonly string[]) {
  const where: string[] = [], params: (string | number)[] = [];
  if (bookkeeping) where.push("NOT EXISTS (SELECT 1 FROM unity_archive_blocked b WHERE b.card_id = c.id OR (b.provider = coalesce(c.source,'chub') AND (b.record_id = coalesce(nullif(c.sourceId,''),CAST(c.id AS TEXT)) OR (b.source_path IS NOT NULL AND b.source_path = lower(trim(c.sourcePath,'/'))))))");
  if (ids) {
    if (!ids.length) where.push('0');
    else { where.push(`c.id IN (${ids.map(() => '?').join(',')})`); params.push(...ids); }
  }
  if (query.provider) { where.push("coalesce(c.source,'chub') = ?"); params.push(query.provider); }
  if (query.minTokens) { where.push('c.tokenCount >= ?'); params.push(query.minTokens); }
  const tags = [...new Set((query.tags ?? []).map((value) => value.trim().toLowerCase()))];
  if (query.tagMode === 'any' && tags.length) {
    where.push(`EXISTS (SELECT 1 FROM card_tags t WHERE t.cardId = c.id AND t.normalizedTag IN (${tags.map(() => '?').join(',')}))`); params.push(...tags);
  } else for (const tag of tags) { where.push('EXISTS (SELECT 1 FROM card_tags t WHERE t.cardId = c.id AND t.normalizedTag = ?)'); params.push(tag); }
  const exclude = [...new Set((query.exclude ?? []).map((value) => value.trim().toLowerCase()))];
  if (exclude.length) { where.push(`NOT EXISTS (SELECT 1 FROM card_tags t WHERE t.cardId = c.id AND t.normalizedTag IN (${exclude.map(() => '?').join(',')}))`); params.push(...exclude); }
  const columns = { greetings: 'hasAlternateGreetings', lorebook: 'hasLorebook', gallery: 'hasGallery', embeddedImages: 'hasEmbeddedImages',
    expressions: 'hasExpressions', systemPrompt: 'hasSystemPrompt', exampleDialogues: 'hasExampleDialogues' };
  for (const flag of new Set(query.has ?? [])) {
    if (flag === 'followed') {
      const creators = [...new Set((query.creators ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean))];
      if (!creators.length) where.push('0');
      else { where.push(`lower(trim(c.author)) IN (${creators.map(() => '?').join(',')})`); params.push(...creators); }
    } else if (flag === 'portrait') {
      throw new NativeArchiveError('INVALID_INPUT', 'The existing Archive metadata cannot filter portrait presence; browse its portraits on the requested page instead');
    } else where.push(`c.${columns[flag]} = 1`);
  }
  return { clause: where.length ? where.join(' AND ') : '1', params };
}
