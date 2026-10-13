import type { ArchiveCardSummary } from './native/store.js';
import type { ArchiveQuery } from './native/query.js';
import type { LibrarySearchCard } from './library-index.js';

type Candidate = { card: ArchiveCardSummary | LibrarySearchCard; row?: Record<string, unknown>; order: number };
const fields = { updated: 'lastModified', added: 'firstDownloadedAt', newest: 'createdAt', oldest: 'createdAt', name: 'name', name_desc: 'name',
  tokens_desc: 'tokenCount', tokens_asc: 'tokenCount', stars: 'starCount', favorites: 'n_favorites', chats: 'nChats', greetings: 'hasAlternateGreetings', lorebook: 'hasLorebook' };
const asciiFold = (value: string) => value.replace(/[A-Z]/g, (char) => char.toLowerCase());
function ownValue(card: ArchiveCardSummary, sort: keyof typeof fields): string | number | null {
  switch (sort) {
    case 'updated': return card.remoteUpdatedAt;
    case 'added': return card.firstSeenAt;
    case 'newest': case 'oldest': return card.remoteCreatedAt;
    case 'name': case 'name_desc': return card.name;
    case 'tokens_desc': case 'tokens_asc': return card.tokens;
    case 'stars': return card.stats.stars ?? null;
    case 'favorites': return card.stats.favorites ?? null;
    case 'chats': return card.stats.chats ?? null;
    case 'greetings': return +!!card.altGreetings;
    case 'lorebook': return +!!card.lorebookEntries;
  }
}
/** Only [offset - ownedCount, offset + limit) of Archive metadata is needed to
 * merge a sorted owned stream. The Archive corpus itself is never enumerated,
 * and callers resolve portraits only after this final page has been chosen. */
export function mergeSearchPage(query: ArchiveQuery, archive: { card: ArchiveCardSummary; row: Record<string, unknown> }[], owned: LibrarySearchCard[],
  archiveScores: Map<string, number> | undefined, ownedScores: Map<string, number> | undefined, offset: number, limit: number) {
  const candidates: Candidate[] = [...archive.map((item, order) => ({ ...item, order })), ...owned.map((card, order) => ({ card, order }))];
  const ranked = !!query.mode && ['semantic', 'hybrid'].includes(query.mode) && !query.sort;
  const indexedBrowse = !query.q?.trim() && (query.mode === 'browse' || !!query.filter);
  const sort = query.sort && query.sort !== 'downloads' ? query.sort : 'updated';
  const ascending = ['name', 'tokens_asc', 'oldest'].includes(sort);
  const words = (query.q ?? '').trim().toLowerCase().replace(/\s+/g, ' '), tokens = words.split(' ');
  const priority = (card: ArchiveCardSummary) => {
    const name = card.name.trim().toLowerCase();
    return name === words ? 0 : name.includes(words) ? 1 : tokens.length > 1 && tokens.every((token) => name.includes(token)) ? 2 : 3;
  };
  function compare(a: Candidate, b: Candidate): number {
    if (ranked) {
      // Preserve each source's stable tie order (including existing hybrid
      // title boosts); compare equivalent cosine/RRF scores across sources.
      if (!!a.row === !!b.row) return a.order - b.order;
      if (query.mode === 'hybrid') { const boost = priority(a.card) - priority(b.card); if (boost) return boost; }
      const score = (b.row ? archiveScores : ownedScores)?.get(b.card.id) ?? 0;
      const other = (a.row ? archiveScores : ownedScores)?.get(a.card.id) ?? 0;
      if (score !== other) return score - other;
    } else {
      const value = (candidate: Candidate) => {
        const field = indexedBrowse && sort === 'added' ? 'createdAt' : fields[sort];
        let raw = candidate.row ? candidate.row[field] : ownValue(candidate.card, sort);
        // Existing Lance projects null strings/numbers to empty/zero and uses
        // binary name ordering; native metadata SQL uses NOCASE and real nulls.
        if (indexedBrowse) {
          if (['updated', 'added', 'newest', 'oldest', 'name', 'name_desc'].includes(sort)) raw = String(raw ?? '');
          else raw = Number(raw ?? 0);
        }
        return raw === undefined || raw === null ? null : typeof raw === 'number' ? raw
          : !indexedBrowse && (sort === 'name' || sort === 'name_desc') ? asciiFold(String(raw)) : String(raw);
      };
      const x = value(a), y = value(b);
      // SQLite's ASC puts nulls first; DESC puts them last. Use actual legacy
      // sort keys rather than normalized display dates or JavaScript locales.
      const difference = x === y ? 0 : x === null ? -1 : y === null ? 1 : x < y ? -1 : 1;
      if (difference) return ascending ? difference : -difference;
      if (a.row && b.row) return a.order - b.order;
    }
    if (!!a.row !== !!b.row) return a.row ? 1 : -1;
    return a.card.id < b.card.id ? 1 : a.card.id > b.card.id ? -1 : 0;
  }
  return candidates.sort(compare).slice(offset, offset + limit).map((candidate) => candidate.card);
}
