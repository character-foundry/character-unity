import { createSillyTavern } from './sillytavern.js';
import { createLumiverse } from './lumiverse.js';
import { createMarinara } from './marinara.js';
import { ChatAppError } from './http.js';
import type { Fetch } from './http.js';
export { ChatAppError, cardFingerprint } from './http.js';
export type { ChatAppErrorCode, Fetch } from './http.js';

/**
 * Server-side connections to chat applications. Each adapter speaks one app's HTTP API;
 * the card service decides what to send and how copies map back to library revisions.
 */
export type ChatKind = 'sillytavern' | 'lumiverse' | 'marinara';
export interface ChatConnection {
  kind: ChatKind;
  baseUrl: string;
  credentials: { username?: string; password?: string; apiKey?: string };
}
/**
 * One character as the app lists it. `extensions` is the card's `data.extensions` when the app keeps it.
 * Apps that rebuild cards on export report a `fingerprint` of the copy as stored, for edit detection.
 */
export interface RemoteCopy { remoteId: string; name: string; extensions: Record<string, unknown> | null; fingerprint?: string }
/** Exact response bytes plus the app's card fields. Full exports also expose their envelope. */
export interface RemoteEditSnapshot { bytes: Uint8Array; fields: Record<string, unknown>; envelope?: Record<string, unknown> }
/** The exported file plus the same card as JSON (`card`), for apps that update fields instead of files. */
export interface UploadFile { bytes: Uint8Array; type: 'png' | 'json'; fileName: string; card: Record<string, unknown>; portrait: Uint8Array | null }
export interface ChatApp {
  readonly kind: ChatKind;
  /** Proves the connection and credentials work. */
  check(): Promise<{ characters: number }>;
  list(): Promise<RemoteCopy[]>;
  /** The card exactly as the app would export it, for identity checks. */
  read(remoteId: string): Promise<unknown>;
  /** A bounded, byte-pinned snapshot used only by the explicit inbound edit review. */
  readForImport(remoteId: string): Promise<RemoteEditSnapshot>;
  /** `replace` overwrites an existing copy in place; otherwise `preferredName` seeds a new one. */
  upload(file: UploadFile, target: { replace?: string; preferredName: string }): Promise<{ remoteId: string; fingerprint?: string }>;
}

export const chatAppNames: Record<ChatKind, string> = { sillytavern: 'SillyTavern', lumiverse: 'Lumiverse', marinara: 'Marinara Engine' };

export function createChatApp(connection: ChatConnection, fetcher: Fetch = fetch): ChatApp {
  switch (connection.kind) {
    case 'sillytavern': return createSillyTavern(connection, fetcher);
    case 'lumiverse': return createLumiverse(connection, fetcher);
    case 'marinara': return createMarinara(connection, fetcher);
    default: throw new ChatAppError('UNEXPECTED', `${chatAppNames[connection.kind as ChatKind] ?? 'This app'} is not supported yet`);
  }
}
