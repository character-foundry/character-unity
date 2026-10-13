/** Native library view models. Original documents remain opaque and are never rewritten for display. */
export type SourceFormat = 'png' | 'json' | 'charx' | 'voxta';

export interface CharacterBookEntry {
  keys: string[]; secondary_keys: string[]; content: string; comment: string; name: string;
  enabled?: boolean; constant?: boolean; selective?: boolean; insertion_order?: number;
}
export interface CharacterBook {
  name: string; description: string; entries: CharacterBookEntry[];
  scan_depth?: number; token_budget?: number; recursive_scanning?: boolean;
}
export interface CharacterAsset { type: string; uri: string; name: string; ext: string }
export interface CharacterCardData {
  name: string; description: string; personality: string; scenario: string; first_mes: string; mes_example: string;
  creator_notes: string; system_prompt: string; post_history_instructions: string; alternate_greetings: string[];
  group_only_greetings: string[]; tags: string[]; creator: string; character_version: string;
  character_book: CharacterBook | null; assets: CharacterAsset[]; extensions: Record<string, unknown>;
}
export interface CharacterCard { spec: string; spec_version: string; data: CharacterCardData }
export interface CardTag { id: string; name: string; slug: string; category: string | null }

export interface CardListItem {
  id: string; slug: string; name: string; description: string | null; creator: string;
  creatorNotes: string | null; specVersion: string; sourceFormat: SourceFormat | null;
  hasAssets: boolean; assetsCount: number; imagePath: string | null; thumbnailPath: string | null;
  /** null means not counted, not zero. */
  tokensTotal: number | null;
  /** null means family metadata has not been loaded. */
  forksCount: number | null;
  hasAlternateGreetings: boolean; alternateGreetingsCount: number; totalGreetingsCount: number;
  hasLorebook: boolean; lorebookEntriesCount: number; hasEmbeddedImages: boolean; embeddedImagesCount: number;
  tags: CardTag[]; createdAt: number; updatedAt: number; isFavorited: boolean;
  headRevisionId: string; revisionCount: number; isFork: boolean;
  reference?: { archiveId: string; cardId: string; versionId: string };
  archiveSource?: { archiveId: string; cardId: string; versionId: string };
}

export interface SavedAssetInfo {
  /** Exact immutable revision binding, not an original descriptor URI. */
  binding: string; name: string; type: string; ext: string; path: string;
  mediaType: string | null; byteLength: number | null;
}
export interface TokenBreakdown {
  description: number; personality: number; scenario: number; mesExample: number; firstMes: number;
  systemPrompt: number; postHistory: number; total: number;
}
export interface CardDetail extends CardListItem {
  tokens: TokenBreakdown | null;
  cardData: CharacterCard;
  rawDocument: unknown;
  savedAssets: SavedAssetInfo[];
  originalFilename: string | null;
}
