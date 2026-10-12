import type { CardSummary, OpenedCard } from './unity';
import { portraitUrl } from './unity';
import type { CardDetail, CardListItem, CardTag, CharacterCard, TokenBreakdown } from '@/types/card';

const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const tagsOf = (values: readonly string[]): CardTag[] => values.map((name) => ({ id: name.toLowerCase(), name, slug: name.toLowerCase(), category: null }));

/** Unity library summary → CardsHub tile/modal shape. Social counters stay zero unless a hub supplies them. */
export function toListItem(workspace: string, summary: CardSummary): CardListItem {
  const image = summary.hasPortrait ? portraitUrl(workspace, summary.id, summary.headRevisionId) : null;
  return {
    id: summary.id, slug: summary.id, name: summary.name, description: null,
    creator: summary.creator || null, creatorNotes: summary.creatorNotes || null,
    specVersion: summary.spec, sourceFormat: summary.sourceFormat ?? 'json',
    hasAssets: summary.assetsCount > 0, assetsCount: summary.assetsCount,
    imagePath: image, thumbnailPath: image, tokensTotal: null,
    upvotes: 0, downvotes: 0, score: 0, favoritesCount: 0, downloadsCount: 0, commentsCount: 0, forksCount: summary.forkCount,
    visibility: 'private',
    hasAlternateGreetings: summary.greetingsCount > 1, alternateGreetingsCount: Math.max(0, summary.greetingsCount - 1),
    totalGreetingsCount: summary.greetingsCount,
    hasLorebook: summary.lorebookEntriesCount > 0, lorebookEntriesCount: summary.lorebookEntriesCount,
    hasEmbeddedImages: false, embeddedImagesCount: 0,
    tags: tagsOf(summary.tags), uploader: null,
    createdAt: seconds(summary.createdAt), updatedAt: seconds(summary.updatedAt),
    headRevisionId: summary.headRevisionId, revisionCount: summary.revisionCount, isFork: summary.forkedFromRevisionId !== null,
  };
}

export const emptyTokens: TokenBreakdown = { description: 0, personality: 0, scenario: 0, mesExample: 0, firstMes: 0, systemPrompt: 0, postHistory: 0, total: 0 };

export function toDetail(workspace: string, opened: OpenedCard, tokens: TokenBreakdown | null): CardDetail {
  const cardData = opened.revision.document as unknown as CharacterCard;
  const data = cardData.data ?? ({} as CharacterCard['data']);
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const alternates = Array.isArray(data.alternate_greetings) ? data.alternate_greetings.length : 0;
  const entries = Array.isArray(data.character_book?.entries) ? data.character_book!.entries.length : 0;
  const portrait = opened.revision.assets.some((asset) => asset.path === 'portrait') ? portraitUrl(workspace, opened.card.id, opened.revision.id) : null;
  const assets = opened.revision.assets.filter((asset) => asset.path !== 'portrait').length;
  const format = opened.source?.provenance.format?.split('_')[0];
  return {
    id: opened.card.id, slug: opened.card.id, name: text(data.name) || 'Untitled', description: text(data.description) || null,
    creator: text(data.creator) || null, creatorNotes: text(data.creator_notes) || null,
    specVersion: cardData.spec === 'chara_card_v3' ? 'v3' : 'v2',
    sourceFormat: format === 'png' || format === 'json' || format === 'charx' || format === 'voxta' ? format : 'json',
    hasAssets: assets > 0, assetsCount: assets, imagePath: portrait, thumbnailPath: portrait,
    tokensTotal: tokens?.total ?? null,
    upvotes: 0, downvotes: 0, score: 0, favoritesCount: 0, downloadsCount: 0, commentsCount: 0, forksCount: 0,
    visibility: 'private',
    hasAlternateGreetings: alternates > 0, alternateGreetingsCount: alternates,
    totalGreetingsCount: (text(data.first_mes).trim() ? 1 : 0) + alternates,
    hasLorebook: entries > 0, lorebookEntriesCount: entries, hasEmbeddedImages: false, embeddedImagesCount: 0,
    tags: tagsOf(Array.isArray(data.tags) ? data.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '') : []),
    uploader: null, createdAt: seconds(opened.card.createdAt), updatedAt: seconds(opened.revision.createdAt),
    headRevisionId: opened.revision.id, revisionCount: opened.revision.sequence, isFork: opened.card.forkedFromRevisionId !== null,
    tokens: tokens ?? emptyTokens, cardData, savedAssets: null, forkedFrom: null,
    imageWidth: null, imageHeight: null, versionId: opened.revision.id, storageUrl: '', contentHash: '',
  };
}
