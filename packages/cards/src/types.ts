export class CardError extends Error {
  constructor(public readonly code: 'INVALID_INPUT' | 'FORBIDDEN' | 'TOO_LARGE' | 'UNSUPPORTED_FORMAT' | 'ASSET_UNAVAILABLE' | 'INVALID_LINEAGE' | 'EXPORT_LOSS', message: string) {
    super(message);
    this.name = 'CardError';
  }
}
/** Supplied by the host's authentication boundary, never copied from request JSON. */
export interface Actor { id: string; uri: string }
/** Largest card file the library takes: RisuAI CharX packages run to hundreds of MB with all their assets. */
export const importByteLimit = 512 * 1024 * 1024;
/** Upload bodies a hosted (account/Workers) API accepts; local hosts take importByteLimit. */
export const hostedUploadByteLimit = 32 * 1024 * 1024;
/** Declared assets a card may carry (plus its portrait); large RisuAI packages declare hundreds. */
export const declaredAssetLimit = 8191;
/** Revision file path of a RisuAI module (module.risum): kept byte for byte, outside content identity, written back to CharX. */
export const risuModulePath = 'module.risum';
export type ExportFormat = 'json' | 'png' | 'charx' | 'sillytavern-json' | 'sillytavern-png';
export interface HistoryOptions { limit?: number; afterSequence?: number; throughSequence?: number }
export interface RevisionSummary { id: string; sequence: number; authorId: string; createdAt: string }
export interface HistoryPage {
  revisions: RevisionSummary[];
  headRevisionId: string;
  throughSequence: number;
  nextAfter: number | null;
}
export interface AssetBinding {
  path: string;
  source: { kind: 'existing'; path: string } | { kind: 'upload'; index: number };
}
export interface AssetUpload { bytes: Uint8Array; mediaType: string }
/** Host-verified existing bytes. URI bindings must match the source's exact URI. */
export interface ImportAsset {
  binding: { kind: 'portrait' } | { kind: 'uri'; uri: string };
  bytes: Uint8Array;
  mediaType: string;
}
