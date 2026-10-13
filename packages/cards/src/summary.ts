import type { ArchivePin, ArchiveReference, CardSummaryItem } from '@character-unity/store';

/** What a library tile, quick-view modal and filters need without opening the full document. */
export interface CardSummary {
  id: string;
  headRevisionId: string;
  name: string;
  creator: string;
  tags: string[];
  spec: 'v2' | 'v3';
  sourceFormat: 'png' | 'json' | 'charx' | 'voxta' | null;
  creatorNotes: string;
  greetingsCount: number;
  lorebookEntriesCount: number;
  assetsCount: number;
  hasPortrait: boolean;
  revisionCount: number;
  forkedFromRevisionId: string | null;
  forkCount: number;
  favorite: boolean;
  /** Token count of the current version; null until measured. */
  tokensTotal: number | null;
  /** chub, ct, risuai, wyvern or file */
  source: string;
  createdAt: string;
  /** Last time this card was touched: its newest saved revision. */
  updatedAt: string;
  /** Exact Archive version linked into this library; no owned document or assets. */
  reference?: ArchivePin;
  /** Owned fork retaining an exact external Archive ancestor. */
  archiveSource?: ArchivePin;
}
export interface CardSummaryList { cards: CardSummary[]; total: number }

export function summarizeReference(reference: ArchiveReference, forkCount: number): CardSummary {
  const value = reference.summary;
  return { id: reference.id, headRevisionId: reference.pin.versionId, reference: reference.pin,
    name: value.name, creator: value.creator, tags: value.tags, spec: value.spec === 'v2' ? 'v2' : 'v3',
    sourceFormat: value.format === 'png' || value.format === 'charx' || value.format === 'json' ? value.format : null,
    creatorNotes: '', greetingsCount: value.greetingCount ?? 0, lorebookEntriesCount: value.lorebookEntryCount ?? 0,
    assetsCount: value.assetCount ?? 0, hasPortrait: value.portrait, revisionCount: 1, forkedFromRevisionId: null,
    forkCount, favorite: reference.favorite, tokensTotal: value.tokensTotal, source: value.source,
    createdAt: reference.createdAt, updatedAt: value.changedAt };
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);

export function summarizeCard({ card, revision, sourceFormat, forkCount, favorite, tokensTotal, source, archiveSource }: CardSummaryItem): CardSummary {
  const document = revision.document as { spec?: unknown; data?: Record<string, unknown> };
  const data = document.data ?? {};
  const book = data.character_book as { entries?: unknown } | null | undefined;
  const format = sourceFormat?.split('_')[0];
  return {
    id: card.id,
    ...(archiveSource ? { archiveSource } : {}),
    headRevisionId: revision.id,
    name: text(data.name) || 'Untitled',
    creator: text(data.creator),
    tags: Array.isArray(data.tags) ? data.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '') : [],
    spec: document.spec === 'chara_card_v3' ? 'v3' : 'v2',
    sourceFormat: format === 'png' || format === 'json' || format === 'charx' || format === 'voxta' ? format : null,
    creatorNotes: text(data.creator_notes).slice(0, 2000),
    greetingsCount: (text(data.first_mes).trim() ? 1 : 0) + count(data.alternate_greetings) + count(data.group_only_greetings),
    lorebookEntriesCount: count(book?.entries),
    assetsCount: revision.assets.filter((asset) => asset.path !== 'portrait').length,
    hasPortrait: revision.assets.some((asset) => asset.path === 'portrait'),
    revisionCount: revision.sequence,
    forkedFromRevisionId: card.forkedFromRevisionId,
    forkCount,
    favorite,
    tokensTotal,
    source,
    createdAt: card.createdAt,
    updatedAt: revision.createdAt,
  };
}
