import type { Statement } from './driver.js';
import type { ChatImportReceiptInput } from './types.js';
import * as validate from './validation.js';

/** Part of the same atomic batch as the newly authored fork and first revision. */
export function chatImportStatements(input: ChatImportReceiptInput | undefined, workspaceId: string, authorId: string,
  sourceCardId: string | undefined, expectedHead: string, cardId: string, revisionId: string): Statement[] {
  if (!input) return [];
  const receiptHash = validate.hash(input.receiptHash);
  validate.text(input.targetId, 'chat target'); validate.text(input.remoteId, 'remote copy ID', 500); validate.text(input.baseRevisionId, 'tracked base revision');
  if (!Number.isSafeInteger(input.targetConfiguration) || input.targetConfiguration < 1) validate.invalid('Expected the reviewed target configuration');
  if (validate.text(input.sourceCardId, 'chat source card') !== sourceCardId || validate.text(input.expectedHead, 'chat source head') !== expectedHead) {
    validate.invalid('Chat receipt must match the fork source and expected head');
  }
  return [{ sql: `INSERT INTO unity_chat_import_receipts(workspace_id,receipt_hash,author_id,source_card_id,source_revision_id,card_id,revision_id,
      target_id,target_configuration,remote_id,base_revision_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, params: [workspaceId, receiptHash, authorId, sourceCardId!, expectedHead, cardId, revisionId,
    input.targetId, input.targetConfiguration, input.remoteId, input.baseRevisionId] }];
}
