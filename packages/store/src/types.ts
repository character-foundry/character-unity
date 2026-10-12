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
  favorite: boolean; tokensTotal: number | null; /** chub, ct, risuai, wyvern or file */ source: string }
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
export interface PublicationForkGuard { publicationId: string; policyVersion: number; actorId: string }
export type StoreErrorCode = 'NOT_FOUND' | 'HEAD_CONFLICT' | 'OPERATION_CONFLICT' | 'ACCESS_CHANGED' | 'UNAUTHENTICATED' | 'INVALID_INPUT' | 'ASSET_NOT_READY' | 'INTEGRITY' | 'SCHEMA_MISMATCH';
export class StoreError extends Error {
  constructor(public readonly code: StoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StoreError';
  }
}
