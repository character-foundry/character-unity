/** Read-only native Archive contracts. Source identities are never merged by content. */
export interface ArchiveIdentityQuery { fileHash?: string; contentHash?: string; name?: string }
export interface ArchiveIdentityMatch {
  cardId: string; versionId: string; fileHash: string; contentHash: string | null;
  provider: string; recordId: string; url: string; matchedBy: 'bytes' | 'content';
}
export interface ArchiveIdentityResult { archiveId: string; matches: ArchiveIdentityMatch[]; complete: boolean; unresolved: number }

export interface LibraryIndexProjection {
  name: string; creator: string; tags: string[]; description: string; personality: string; scenario: string;
  first_mes: string; mes_example: string; system_prompt: string; post_history_instructions: string; alternate_greetings: string[];
  tokens: number; createdAt: string; updatedAt: string; spec: 'v2' | 'v3'; lorebookEntries?: number; hasPortrait?: boolean;
  flags?: { gallery: boolean; expressions: boolean; embeddedImages: boolean; systemPrompt: boolean; exampleDialogues: boolean };
}
export interface LibraryIndexMutation {
  workspaceId: string; cardId: string; revisionId: string; operation: 'upsert' | 'delete'; eventSequence: number; projection?: LibraryIndexProjection;
}
export interface LibraryIndexReceipt { eventSequence: number; applied: boolean; semantic: boolean }

export function validateIdentityQuery(query: ArchiveIdentityQuery): ArchiveIdentityQuery {
  if ((!query.fileHash && !query.contentHash) || [query.fileHash, query.contentHash].some((value) => value !== undefined && !/^[a-f0-9]{64}$/.test(value))
    || (query.name !== undefined && (typeof query.name !== 'string' || query.name.length > 500 || [...query.name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)))) {
    throw new Error('Identity lookup needs a valid file or content SHA-256 digest');
  }
  return { ...query };
}
