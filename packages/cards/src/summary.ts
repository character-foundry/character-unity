import type { CardSummaryItem } from '@character-unity/store';

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
  createdAt: string;
  /** Last time this card was touched: its newest saved revision. */
  updatedAt: string;
}
export interface CardSummaryList { cards: CardSummary[]; total: number }

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);

export function summarizeCard({ card, revision, sourceFormat, forkCount }: CardSummaryItem): CardSummary {
  const document = revision.document as { spec?: unknown; data?: Record<string, unknown> };
  const data = document.data ?? {};
  const book = data.character_book as { entries?: unknown } | null | undefined;
  const format = sourceFormat?.split('_')[0];
  return {
    id: card.id,
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
    createdAt: card.createdAt,
    updatedAt: revision.createdAt,
  };
}
