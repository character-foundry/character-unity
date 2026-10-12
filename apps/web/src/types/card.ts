// Card view types used by the CardsHub-derived UI. Unity data is adapted into these
// shapes in lib/adapt.ts so the ported components stay close to the originals.

export type SourceFormat = 'png' | 'json' | 'charx' | 'voxta';
export type CardVisibility = 'public' | 'private' | 'nsfw_only' | 'unlisted' | 'blocked';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface CharacterBookEntry { keys?: string[]; secondary_keys?: string[]; content?: string; comment?: string; name?: string; enabled?: boolean; constant?: boolean; selective?: boolean; insertion_order?: number; priority?: number; position?: string | number; [key: string]: any }
export interface CharacterBook { name?: string; description?: string; entries: CharacterBookEntry[]; [key: string]: any }
export interface CharacterAsset { type: string; uri: string; name: string; ext: string }
export interface CharacterCardData {
  name: string; description: string; personality: string; scenario: string; first_mes: string; mes_example: string;
  creator_notes?: string; system_prompt?: string; post_history_instructions?: string; alternate_greetings?: string[];
  group_only_greetings?: string[]; tags?: string[]; creator?: string; character_version?: string;
  character_book?: CharacterBook | null; assets?: CharacterAsset[]; extensions?: Record<string, any>; [key: string]: any;
}
export interface CharacterCard { spec: string; spec_version?: string; data: CharacterCardData }
export type CharacterCardV3 = CharacterCard;
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface CardTag { id: string; name: string; slug: string; category: string | null }

export interface CardListItem {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  creator: string | null;
  creatorNotes: string | null;
  specVersion: string;
  sourceFormat: SourceFormat;
  hasAssets: boolean;
  assetsCount: number;
  imagePath: string | null;
  thumbnailPath: string | null;
  /** null until counted. */
  tokensTotal: number | null;
  upvotes: number;
  downvotes: number;
  score: number;
  favoritesCount: number;
  downloadsCount: number;
  commentsCount: number;
  forksCount: number;
  visibility: CardVisibility;
  processingStatus?: 'complete' | 'pending' | 'processing' | 'failed';
  hasAlternateGreetings: boolean;
  alternateGreetingsCount: number;
  totalGreetingsCount: number;
  hasLorebook: boolean;
  lorebookEntriesCount: number;
  hasEmbeddedImages: boolean;
  embeddedImagesCount: number;
  tags: CardTag[];
  uploader: { id: string; username: string; displayName: string | null } | null;
  /** Unix seconds. */
  createdAt: number;
  /** Unix seconds: the last time this card was touched. */
  updatedAt: number;
  isFavorited?: boolean;
  feedReason?: 'followed_user' | 'followed_tag' | 'trending';
  collectionId?: string | null;
  collectionSlug?: string | null;
  collectionName?: string | null;
  // Unity library fields
  headRevisionId: string;
  revisionCount: number;
  isFork: boolean;
}

export interface SavedAssetInfo { name: string; type: string; ext: string; path: string; thumbnailPath?: string }

export interface TokenBreakdown { description: number; personality: number; scenario: number; mesExample: number; firstMes: number; systemPrompt: number; postHistory: number; total: number }

export interface CardDetail extends CardListItem {
  tokens: TokenBreakdown;
  cardData: CharacterCard;
  savedAssets: SavedAssetInfo[] | null;
  forkedFrom: { id: string; slug: string; name: string; versionId?: string } | null;
  imageWidth: number | null;
  imageHeight: number | null;
  versionId: string;
  storageUrl: string;
  contentHash: string;
}

export type SortOption = 'newest' | 'oldest' | 'popular' | 'trending' | 'downloads' | 'favorites' | 'rating';
