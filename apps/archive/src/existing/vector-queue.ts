import type Database from 'better-sqlite3';
import { ArchiveError } from '@character-unity/archive-client/contract';
import type { DocumentEmbedder } from '../embeddings.js';
import type { ExistingSearch } from './search.js';

type QueueRow = { id: number; cardId: string; action: 'upsert' | 'delete'; queuedAt: string };
type WorkRow = { id: number; cardId: string; action: 'upsert' | 'delete'; revision: number; leasedRevision: number; leaseOwner: string; status: string };
type Generation = { id: number; embedder_name: string; model_name: string; dimensions: number; cards_index: string; status: string; active: number };
type SearchWriter = Pick<ExistingSearch, 'indexVectorDocuments' | 'deleteVectorDocuments'>;
const workColumns = 'id,card_id AS cardId,action,revision,leased_revision AS leasedRevision,lease_owner AS leaseOwner,status';
const eligibleWork = `(status IN ('queued','retry') OR (status IN ('leased','submitted') AND julianday(lease_expires_at) <= julianday('now')))`;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Explicit work only. A failed or superseded batch stays in the existing queues. */
export function createVectorQueueDrainer(db: Database.Database, search?: SearchWriter, embedder?: DocumentEmbedder) {
  const table = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name);
  function activeGeneration() {
    if (!table('vector_generations')) return undefined;
    const rows = db.prepare('SELECT id,embedder_name,model_name,dimensions,cards_index,status,active FROM vector_generations WHERE active = 1 LIMIT 2').all() as Generation[];
    if (rows.length > 1) throw new ArchiveError('INTEGRITY', 'Existing Archive has ambiguous active vector generations');
    return rows[0];
  }
  function pending() {
    let count = table('vector_index_queue') ? (db.prepare('SELECT count(*) AS n FROM vector_index_queue').get() as { n: number }).n : 0;
    const generation = activeGeneration();
    if (generation && table('vector_work_items')) count += (db.prepare(`SELECT count(*) AS n FROM vector_work_items WHERE generation_id = ? AND ${eligibleWork}`).get(generation.id) as { n: number }).n;
    return count;
  }
  const lookup = () => db.prepare('SELECT * FROM cards WHERE id = ?');
  async function write(rows: readonly Pick<QueueRow, 'cardId' | 'action'>[], signal?: AbortSignal) {
    const documents = new Map<string, Record<string, unknown> | undefined>();
    const source = lookup();
    for (const row of rows) {
      if (!/^[1-9][0-9]*$/.test(row.cardId) || !['upsert', 'delete'].includes(row.action)) throw new ArchiveError('INTEGRITY', 'Invalid existing vector queue record');
      documents.set(row.cardId, source.get(row.cardId) as Record<string, unknown> | undefined);
    }
    const upserts = rows.filter((row) => row.action === 'upsert' && documents.get(row.cardId)).map((row) => documents.get(row.cardId)!);
    const deletes = rows.filter((row) => row.action === 'delete' || !documents.get(row.cardId)).map((row) => row.cardId);
    const indexed = upserts.length ? await search!.indexVectorDocuments(upserts, embedder!, signal) : [];
    signal?.throwIfAborted();
    if (deletes.length) await search!.deleteVectorDocuments(deletes);
    signal?.throwIfAborted();
    const metadata = new Map(indexed.map((item) => [item.cardId, item]));
    for (const document of upserts) if (!metadata.has(String(document.id))) throw new ArchiveError('INTEGRITY', 'Vector indexing did not acknowledge every requested card');
    return { documents, metadata };
  }
  function saveMetadata(cardId: string, name: string, metadata: Awaited<ReturnType<typeof write>>['metadata']) {
    const item = metadata.get(cardId);
    if (item) db.prepare(`INSERT INTO card_embedding_meta(cardId,embedder_name,model_name,dims,section,chunk_index,text_sha256,updated_at)
      VALUES (?,?,?,?,'card',0,?,CURRENT_TIMESTAMP) ON CONFLICT(cardId,embedder_name,section,chunk_index)
      DO UPDATE SET model_name=excluded.model_name,dims=excluded.dims,text_sha256=excluded.text_sha256,updated_at=excluded.updated_at`)
      .run(item.cardId, name, item.model, item.dimensions, item.textHash);
    else db.prepare('DELETE FROM card_embedding_meta WHERE cardId = ? AND embedder_name = ?').run(cardId, name);
  }
  let running: Promise<unknown> = Promise.resolve();
  return function flush(limit = 100, signal?: AbortSignal): Promise<{ processed: number; pending: number; configured: boolean }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 512) throw new ArchiveError('INVALID_INPUT', 'Vector queue batches contain 1–512 records');
    const operation = running.then(async () => {
      signal?.throwIfAborted();
      if (!search || !embedder || (!table('vector_index_queue') && !table('vector_work_items'))) return { processed: 0, pending: pending(), configured: false };
      if (!table('card_embedding_meta')) throw new ArchiveError('UNAVAILABLE', 'Existing Archive embedding metadata is missing');
      const generation = activeGeneration();
      let embedderName: string;
      if (generation) {
        if (generation.status !== 'active' || generation.model_name !== embedder.space.model || generation.dimensions !== embedder.space.dimensions
          || !generation.embedder_name?.trim() || !generation.cards_index?.trim()) throw new ArchiveError('UNAVAILABLE', 'Configured provider does not match the active existing vector generation');
        embedderName = generation.embedder_name;
      } else {
        const names = db.prepare('SELECT DISTINCT embedder_name AS name FROM card_embedding_meta WHERE model_name = ? AND dims = ? LIMIT 2').all(embedder.space.model, embedder.space.dimensions) as { name: string }[];
        if (names.length !== 1 || !names[0]!.name) throw new ArchiveError('UNAVAILABLE', 'Existing Archive embedder identity is missing or ambiguous');
        embedderName = names[0]!.name;
      }
      let processed = 0;
      const rows = table('vector_index_queue') ? db.prepare('SELECT id,CAST(cardId AS TEXT) AS cardId,action,queuedAt FROM vector_index_queue ORDER BY id LIMIT ?').all(limit) as QueueRow[] : [];
      if (rows.length) {
        const { documents, metadata } = await write(rows, signal);
        // Upserts can reuse both ID and second-resolution queuedAt. Check the
        // source snapshot as well before acknowledging the old queue entry.
        db.transaction(() => {
          const queued = db.prepare('SELECT id,CAST(cardId AS TEXT) AS cardId,action,queuedAt FROM vector_index_queue WHERE id = ?');
          for (const row of rows) {
            if (!same(queued.get(row.id), row) || !same(lookup().get(row.cardId), documents.get(row.cardId)) || !same(activeGeneration(), generation)) continue;
            saveMetadata(row.cardId, embedderName, metadata);
            db.prepare('DELETE FROM vector_index_queue WHERE id = ?').run(row.id); processed++;
          }
        })();
      }
      if (generation && table('vector_work_items') && rows.length < limit && same(activeGeneration(), generation)) {
        const owner = `unity-${crypto.randomUUID()}`;
        const work = db.transaction(() => {
          const selected = db.prepare(`SELECT id FROM vector_work_items WHERE generation_id = ? AND ${eligibleWork}
            AND julianday(next_attempt_at) <= julianday('now') ORDER BY id LIMIT ?`).all(generation.id, limit - rows.length) as { id: number }[];
          const claim = db.prepare(`UPDATE vector_work_items SET status='leased',attempts=attempts+1,leased_revision=revision,
            lease_owner=?,lease_expires_at=datetime('now','+5 minutes'),updated_at=CURRENT_TIMESTAMP WHERE id=?`);
          for (const row of selected) claim.run(owner, row.id);
          return db.prepare(`SELECT ${workColumns} FROM vector_work_items WHERE generation_id=? AND lease_owner=? AND status='leased' ORDER BY id`).all(generation.id, owner) as WorkRow[];
        })();
        if (work.length) {
          // Finish or release before the legacy five-minute lease expires.
          const deadline = AbortSignal.any([AbortSignal.timeout(240_000), ...(signal ? [signal] : [])]);
          try {
            const { documents, metadata } = await write(work, deadline);
            deadline.throwIfAborted();
            db.transaction(() => {
              const current = db.prepare(`SELECT ${workColumns} FROM vector_work_items WHERE id=? AND generation_id=?`);
              for (const row of work) {
                if (!same(current.get(row.id, generation.id), row) || row.revision !== row.leasedRevision
                  || !same(lookup().get(row.cardId), documents.get(row.cardId)) || !same(activeGeneration(), generation)) continue;
                saveMetadata(row.cardId, embedderName, metadata);
                db.prepare(`UPDATE vector_work_items SET status='completed',completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,
                  lease_owner=NULL,lease_expires_at=NULL,leased_revision=NULL,meili_task_uids=NULL,last_error=NULL WHERE id=?`).run(row.id);
                processed++;
              }
            })();
          } finally {
            // A trigger or another worker may already own a newer revision.
            db.prepare(`UPDATE vector_work_items SET status='retry',next_attempt_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,
              lease_owner=NULL,lease_expires_at=NULL,leased_revision=NULL,meili_task_uids=NULL
              WHERE generation_id=? AND lease_owner=? AND status='leased' AND revision=leased_revision`).run(generation.id, owner);
          }
        }
      }
      return { processed, pending: pending(), configured: true };
    });
    running = operation.catch(() => undefined);
    return operation;
  };
}
