import type { LibraryFilter, LibrarySort } from './library-query.js';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type CardDocument = { [key: string]: JsonValue };

/** Calculated by Foundry/the trusted import layer, never inferred by this database. */
export interface ContentIdentity { algorithm: string; hash: string }
export interface RevisionAsset { path: string; assetId: string }
export interface CardSourceInput { assetId: string; provenance: CardDocument }
export interface CardSource extends CardSourceInput { cardId: string; workspaceId: string }
export interface RevisionInput {
  authorId: string;
  document: CardDocument;
  identity: ContentIdentity;
  assets?: readonly RevisionAsset[];
}
export interface Workspace { id: string; ownerId: string; name: string; createdAt: string }
export interface Card {
  id: string;
  workspaceId: string;
  headRevisionId: string;
  originalHash: string | null;
  forkedFromRevisionId: string | null;
  createdAt: string;
}
export interface Revision {
  id: string;
  sequence: number;
  cardId: string;
  workspaceId: string;
  parentRevisionId: string | null;
  authorId: string;
  identity: ContentIdentity;
  document: CardDocument;
  createdAt: string;
  assets: RevisionAsset[];
}
export interface CardSummaryQuery extends LibraryFilter { tag?: string; offset?: number; limit?: number; sort?: LibrarySort;
  /** Only cards forked from any revision of this card. */ forkOf?: string;
  /** Only these cards (at most 100). */ ids?: readonly string[] }
export interface CardSummaryItem { card: Card; revision: Revision; sourceFormat: string | null; forkCount: number;
  favorite: boolean; tokensTotal: number | null; /** chub, ct, risuai, wyvern or file */ source: string;
  archiveSource?: ArchivePin; inChat?: boolean }
export interface CardSummaryPage { items: CardSummaryItem[]; total: number }
export interface Asset {
  id: string;
  workspaceId: string;
  hash: string;
  byteLength: number;
  mediaType: string;
  storageKey: string;
  state: 'staged' | 'ready';
}
/** Exact external ancestor. Source identity is independent of content identity. */
export interface ArchivePin { archiveId: string; cardId: string; versionId: string }
/** Small library projection, not a second stored copy of the original document. */
export interface ArchiveReferenceSummary {
  name: string; creator: string; description: string; tags: string[];
  source: string; format: string; changedAt: string; portrait: boolean;
  tokensTotal: number | null; flags: string[];
  /** Total greetings drive sorting; alternate-only counts drive the existing has:greetings filter. */
  greetingCount?: number; alternateGreetingCount?: number; lorebookEntryCount?: number; assetCount?: number; versionCount?: number; spec?: string;
}
export interface ArchiveReference {
  id: string; workspaceId: string; pin: ArchivePin; summary: ArchiveReferenceSummary;
  fileHash: string | null; identity: ContentIdentity | null; moduleHash: string | null; lineageHash: string | null;
  favorite: boolean; createdAt: string;
}
export interface ArchiveReferenceInput {
  workspaceId: string; pin: ArchivePin; summary: ArchiveReferenceSummary;
  fileHash?: string; identity?: ContentIdentity; moduleHash?: string | null; lineageHash?: string | null; favorite?: boolean;
}
/** Metadata-only asset: its bytes remain in the exact Archive version. */
export interface ArchiveAsset { assetId: string; workspaceId: string; pin: ArchivePin; path: string }
export interface ArchiveForkSource { cardId: string; workspaceId: string; pin: ArchivePin; referenceId: string | null; sourceProvider: string }
export interface ImportIdentity { fileHash?: string; identity?: ContentIdentity; moduleHash?: string | null; lineageHash?: string | null }
export type ImportMatch =
  | { kind: 'card'; cardId: string; revisionId: string; match: 'file' | 'content' }
  | { kind: 'reference'; referenceId: string; match: 'file' | 'content' };
export type ImportCardResult = { created: true; card: Card; revision: Revision }
  | { created: false; existing: ImportMatch };
export type LibrarySummaryItem = CardSummaryItem | { reference: ArchiveReference; forkCount: number; inChat: boolean };
export interface LibrarySummaryPage { items: LibrarySummaryItem[]; total: number }
export interface PublicationForkGuard { publicationId: string; policyVersion: number; actorId: string }
export type StoreErrorCode = 'NOT_FOUND' | 'HEAD_CONFLICT' | 'OPERATION_CONFLICT' | 'ACCESS_CHANGED' | 'UNAUTHENTICATED' | 'INVALID_INPUT' | 'ASSET_NOT_READY' | 'INTEGRITY' | 'SCHEMA_MISMATCH';
export class StoreError extends Error {
  constructor(public readonly code: StoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StoreError';
  }
}
