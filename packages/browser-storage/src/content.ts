import { StoreError } from '@character-unity/store';
import { contentByteLimit, contentJson, contentKind } from '@character-unity/store/content';
import type { ContentDocument, ContentImport, ContentOriginal, ContentRecord, ContentRevision, ContentStore, ContentSummary, ContentWrite } from '@character-unity/store/content';
import * as validate from '@character-unity/store/validation';
import { request, transaction } from './transaction.js';

interface DocumentRow extends ContentDocument { deletedAt: string | null }
interface SourceRow extends ContentOriginal { workspaceId: string }
interface Claim { workspaceId: string; kind: string; identityKind: 'file' | 'content'; hash: string; documentId: string; revisionId: string }
const names = ['workspaces','contentSources','contentDocuments','contentRevisions','contentClaims'];
const range = (workspaceId: string) => IDBKeyRange.bound([workspaceId],[workspaceId,[]]);
export function addContentStores(db: IDBDatabase) {
  db.createObjectStore('contentSources',{ keyPath: 'id' }).createIndex('identity',['workspaceId','hash'],{ unique: true });
  db.createObjectStore('contentDocuments',{ keyPath: 'id' }).createIndex('workspace',['workspaceId','id']);
  db.createObjectStore('contentRevisions',{ keyPath: 'id' }).createIndex('history',['workspaceId','documentId','sequence'],{ unique: true });
  db.createObjectStore('contentPublications',{ keyPath: 'id' }).createIndex('owner',['ownerId','id']);
  db.createObjectStore('contentClaims',{ keyPath: ['workspaceId','kind','identityKind','hash'] }).createIndex('document','documentId');
}
function* read<T>(tx: IDBTransaction, table: string, id: IDBValidKey): Generator<IDBRequest,T | undefined,unknown> {
  return yield* request<T | undefined>(tx.objectStore(table).get(id));
}
function* workspace(tx: IDBTransaction, id: string) {
  if (!(yield* read(tx,'workspaces',validate.text(id,'workspaceId')))) throw new StoreError('NOT_FOUND','Workspace not found');
}
function* document(tx: IDBTransaction, workspaceId: string, id: string) {
  const value = yield* read<DocumentRow>(tx,'contentDocuments',validate.text(id,'contentId'));
  if (!value || value.workspaceId !== workspaceId || value.deletedAt !== null) throw new StoreError('NOT_FOUND','Content not found in this workspace');
  return value;
}
function* revision(tx: IDBTransaction, workspaceId: string, documentId: string, id: string) {
  const value = yield* read<ContentRevision>(tx,'contentRevisions',validate.text(id,'revisionId'));
  if (!value || value.workspaceId !== workspaceId || value.documentId !== documentId) throw new StoreError('NOT_FOUND','Content revision not found in this workspace');
  return value;
}
function* record(tx: IDBTransaction, workspaceId: string, id: string): Generator<IDBRequest,ContentRecord,unknown> {
  const row = yield* document(tx,workspaceId,id), { deletedAt,...value } = row; void deletedAt;
  return { document: value,revision: yield* revision(tx,workspaceId,id,value.headRevisionId) };
}
function snapshot(input: ContentWrite) {
  return { authorId: validate.text(input.authorId,'authorId'),title: validate.text(input.title,'title',500),
    json: JSON.parse(contentJson(input.json)) as ContentRevision['json'],hash: validate.hash(input.hash) };
}
function* matched(tx: IDBTransaction, workspaceId: string, kind: string, fileHash: string, hash?: string): Generator<IDBRequest,ContentRecord | null,unknown> {
  for (const [identityKind,digest] of [['file',fileHash],...(hash ? [['content',hash]] : [])]) {
    const claim = yield* read<Claim>(tx,'contentClaims',[workspaceId,kind!,identityKind!,digest!]);
    if (claim) return yield* record(tx,workspaceId,claim.documentId);
  }
  if (hash) {
    const rows = yield* request<DocumentRow[]>(tx.objectStore('contentDocuments').index('workspace').getAll(range(workspaceId)));
    for (const row of rows) if (row.deletedAt === null && row.kind === kind) {
      const current = yield* revision(tx,workspaceId,row.id,row.headRevisionId);
      if (current.hash === hash) return yield* record(tx,workspaceId,row.id);
    }
  }
  return null;
}
function* clearClaims(tx: IDBTransaction, id: string, onlyContent: boolean) {
  const claims = yield* request<Claim[]>(tx.objectStore('contentClaims').index('document').getAll(id));
  for (const claim of claims) if (!onlyContent || claim.identityKind === 'content') {
    yield* request(tx.objectStore('contentClaims').delete([claim.workspaceId,claim.kind,claim.identityKind,claim.hash]));
  }
}
const unavailable = async (): Promise<never> => { throw new StoreError('INVALID_INPUT','Sharing standalone content requires a SQL host'); };
/** Additive IndexedDB adapter. Existing card/asset data and database name stay put. */
export function createBrowserContentStore(db: IDBDatabase): ContentStore {
  return {
    get: (workspaceId,id) => transaction(db,names,'readonly',(tx) => record(tx,workspaceId,id)),
    revision: (workspaceId,documentId,id) => transaction(db,names,'readonly',(tx) => revision(tx,workspaceId,documentId,id)),
    original: (workspaceId,id) => transaction(db,names,'readonly',function* (tx) {
      const value = yield* document(tx,workspaceId,id), source = yield* read<SourceRow>(tx,'contentSources',value.sourceId);
      if (!source || source.workspaceId !== workspaceId) throw new StoreError('NOT_FOUND','Content original not found');
      const { workspaceId: owner,...original } = source; void owner; return original;
    }),
    findImport(workspaceId,kind,fileHash) {
      return transaction(db,names,'readonly',(tx) => matched(tx,validate.text(workspaceId,'workspaceId'),contentKind(kind),validate.hash(fileHash)));
    },
    import(input: ContentImport) {
      const value = snapshot(input), kind = contentKind(input.kind), workspaceId = validate.text(input.workspaceId,'workspaceId');
      const source = { ...input.source,hash: validate.hash(input.source.hash),filename: validate.text(input.source.filename,'filename',512) };
      if (typeof source.text !== 'string' || new TextEncoder().encode(source.text).byteLength > contentByteLimit) throw new StoreError('INVALID_INPUT','Original exceeds 1 MiB');
      return transaction(db,names,'readwrite',function* (tx) {
        yield* workspace(tx,workspaceId);
        const known = yield* matched(tx,workspaceId,kind,source.hash,value.hash);
        if (known) return { created: false,record: known };
        let original = yield* request<SourceRow | undefined>(tx.objectStore('contentSources').index('identity').get([workspaceId,source.hash]));
        if (!original) { original = { ...source,id: crypto.randomUUID(),workspaceId }; yield* request(tx.objectStore('contentSources').add(original)); }
        const createdAt = new Date().toISOString(), row: DocumentRow = { id: crypto.randomUUID(),workspaceId,kind,sourceId: original.id,
          headRevisionId: crypto.randomUUID(),forkedFromRevisionId: null,sourcePublicationId: null,createdAt,deletedAt: null };
        const head: ContentRevision = { ...value,id: row.headRevisionId,documentId: row.id,workspaceId,parentRevisionId: null,sequence: 1,createdAt };
        yield* request(tx.objectStore('contentDocuments').add(row)); yield* request(tx.objectStore('contentRevisions').add(head));
        for (const identityKind of ['file','content'] as const) yield* request(tx.objectStore('contentClaims').add({ workspaceId,kind,identityKind,
          hash: identityKind === 'file' ? source.hash : value.hash,documentId: row.id,revisionId: head.id }));
        return { created: true,record: yield* record(tx,workspaceId,row.id) };
      });
    },
    list(workspaceId,options = {}) {
      const limit = validate.limit(options.limit ?? 20), after = options.afterId === undefined ? '' : validate.text(options.afterId,'afterId');
      const kind = options.kind === undefined ? undefined : contentKind(options.kind), q = (options.q ?? '').trim();
      if (q.length > 500) throw new StoreError('INVALID_INPUT','Search exceeds 500 characters');
      return transaction(db,names,'readonly',function* (tx) {
        yield* workspace(tx,workspaceId);
        const rows = yield* request<DocumentRow[]>(tx.objectStore('contentDocuments').index('workspace').getAll(range(workspaceId))), summaries: ContentSummary[] = [];
        for (const row of rows) if (row.deletedAt === null && (!kind || row.kind === kind)) {
          const head = yield* revision(tx,workspaceId,row.id,row.headRevisionId);
          const fold = (value: string) => value.replace(/[A-Z]/g,(char) => char.toLowerCase());
          if (q && !fold(head.title).includes(fold(q))) continue;
          summaries.push({ id: row.id,kind: row.kind,title: head.title,headRevisionId: head.id,revisionCount: head.sequence,
            forkedFromRevisionId: row.forkedFromRevisionId,createdAt: row.createdAt });
        }
        const page = summaries.filter((row) => row.id > after).sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), items = page.slice(0,limit);
        return { items,total: summaries.length,nextAfter: page.length > limit ? items.at(-1)!.id : null };
      });
    },
    save(input) {
      const value = snapshot(input), { workspaceId,documentId,expectedHead } = input;
      return transaction(db,names,'readwrite',function* (tx) {
        const row = yield* document(tx,workspaceId,documentId);
        if (row.headRevisionId !== expectedHead) throw new StoreError('HEAD_CONFLICT','This content has a newer revision; reload before saving');
        const previous = yield* revision(tx,workspaceId,documentId,expectedHead), id = crypto.randomUUID();
        const next: ContentRevision = { ...value,id,documentId,workspaceId,parentRevisionId: previous.id,sequence: previous.sequence+1,createdAt: new Date().toISOString() };
        yield* request(tx.objectStore('contentRevisions').add(next)); yield* request(tx.objectStore('contentDocuments').put({ ...row,headRevisionId: id }));
        yield* clearClaims(tx,documentId,true); return next;
      });
    },
    fork(workspaceId,documentId,revisionId,authorId) {
      const author = validate.text(authorId,'authorId');
      return transaction(db,names,'readwrite',function* (tx) {
        const source = yield* document(tx,workspaceId,documentId), previous = yield* revision(tx,workspaceId,documentId,revisionId);
        const createdAt = new Date().toISOString(), next: DocumentRow = { ...source,id: crypto.randomUUID(),headRevisionId: crypto.randomUUID(),
          forkedFromRevisionId: revisionId,createdAt,deletedAt: null };
        yield* request(tx.objectStore('contentDocuments').add(next));
        yield* request(tx.objectStore('contentRevisions').add({ ...previous,id: next.headRevisionId,documentId: next.id,authorId: author,parentRevisionId: previous.id,sequence: 1,createdAt }));
        return yield* record(tx,workspaceId,next.id);
      });
    },
    history(workspaceId,documentId,options = {}) {
      const after = validate.count(options.afterSequence ?? 0,'afterSequence'), limit = validate.limit(options.limit ?? 20);
      return transaction(db,names,'readonly',function* (tx) {
        yield* document(tx,workspaceId,documentId);
        const rows = yield* request<ContentRevision[]>(tx.objectStore('contentRevisions').index('history')
          .getAll(IDBKeyRange.bound([workspaceId,documentId,after],[workspaceId,documentId,[]],true),limit+1));
        const revisions = rows.slice(0,limit).map(({ json,...row }) => { void json; return row; });
        return { revisions,nextAfter: rows.length > limit ? revisions.at(-1)!.sequence : null };
      });
    },
    remove(workspaceId,documentId) {
      return transaction(db,names,'readwrite',function* (tx) {
        const row = yield* document(tx,workspaceId,documentId);
        yield* request(tx.objectStore('contentDocuments').put({ ...row,deletedAt: new Date().toISOString() })); yield* clearClaims(tx,documentId,false);
      });
    },
    publication: unavailable,publications: unavailable,publish: unavailable,updatePublication: unavailable,publicationOriginal: unavailable,forkPublication: unavailable,
  };
}
