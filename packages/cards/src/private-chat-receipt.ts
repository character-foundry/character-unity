import { canonicalJson } from '@character-foundry/character-foundry/identity';
import type { CardDocument, ChatImportReceiptInput } from '@character-unity/store';
import { CardError } from './types.js';

const brand = Symbol('reviewed-chat-import');
export interface ChatImportAuthorization { readonly [brand]: true }
const receipts = new WeakMap<ChatImportAuthorization, CardDocument>();
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function local(document: CardDocument | undefined): Record<string, unknown> | null {
  const data = document?.data;
  if (!object(data) || !object(data.extensions) || !object(data.extensions.foundry) || !object(data.extensions.foundry.local)) return null;
  return data.extensions.foundry.local;
}
/** Internal capability, never reconstructed from request JSON or a card file. */
export function authorizeChatImport(input: CardDocument): ChatImportAuthorization {
  const authorization = Object.freeze({ [brand]: true as const });
  receipts.set(authorization, JSON.parse(canonicalJson(input)) as CardDocument);
  return authorization;
}
export function chatImportCommit(authorization: ChatImportAuthorization | undefined): ChatImportReceiptInput | undefined {
  if (!authorization) return undefined;
  const receipt = receipts.get(authorization);
  if (!receipt || typeof receipt.receiptHash !== 'string' || typeof receipt.cardId !== 'string' || typeof receipt.expectedHead !== 'string'
    || typeof receipt.targetId !== 'string' || typeof receipt.remoteId !== 'string' || typeof receipt.baseRevisionId !== 'string' || typeof receipt.targetConfiguration !== 'number') {
    throw new CardError('FORBIDDEN', 'Chat import requires a reviewed internal capability');
  }
  return { receiptHash: receipt.receiptHash, sourceCardId: receipt.cardId, expectedHead: receipt.expectedHead,
    targetId: receipt.targetId, remoteId: receipt.remoteId, baseRevisionId: receipt.baseRevisionId, targetConfiguration: receipt.targetConfiguration };
}
/** Mutates an already-owned document. Only stored provenance may survive an
 * ordinary edit; a new fork never inherits its parent's dedupe receipt. */
export function setChatImportReceipt(document: CardDocument, stored?: CardDocument, authorization?: ChatImportAuthorization) {
  const previous = local(stored)?.unityChatImport;
  const receipt = authorization ? receipts.get(authorization) : previous;
  if (authorization && !receipt) throw new CardError('FORBIDDEN', 'Chat import receipt requires a reviewed internal capability');
  const incoming = local(document); if (incoming) delete incoming.unityChatImport;
  if (receipt !== undefined) {
    const data = document.data as Record<string, unknown>;
    const extensions = (data.extensions ??= {}) as Record<string, unknown>;
    const foundry = (extensions.foundry ??= {}) as Record<string, unknown>;
    const target = (foundry.local ??= {}) as Record<string, unknown>;
    target.unityChatImport = JSON.parse(canonicalJson(receipt));
  }
  return document;
}
