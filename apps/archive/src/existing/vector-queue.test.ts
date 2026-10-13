import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DocumentEmbedder } from '../embeddings.js';
import { createVectorQueueDrainer } from './vector-queue.js';

let db: Database.Database;
const embedder: DocumentEmbedder = { space: { model: 'model', dimensions: 2, sourceDimensions: 2, queryInstruction: '' }, embed: async () => [[1, 0]] };
const indexed = { cardId: '1', textHash: 'a'.repeat(64), model: 'model', dimensions: 2 };
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE cards(id INTEGER PRIMARY KEY,description TEXT);
    CREATE TABLE vector_index_queue(id INTEGER PRIMARY KEY,cardId TEXT UNIQUE,action TEXT,queuedAt TEXT);
    CREATE TABLE card_embedding_meta(cardId TEXT,embedder_name TEXT,model_name TEXT,dims INTEGER,section TEXT,chunk_index INTEGER,text_sha256 TEXT,updated_at TEXT,PRIMARY KEY(cardId,embedder_name,section,chunk_index));
    INSERT INTO cards VALUES (1,'first'),(2,'second');
    INSERT INTO vector_index_queue VALUES (1,'1','upsert','same-second'),(2,'2','delete','same-second');
    INSERT INTO card_embedding_meta VALUES ('1','existing','model',2,'card',0,'old','before');`);
});
afterEach(() => db.close());
const count = () => (db.prepare('SELECT count(*) AS n FROM vector_index_queue').get() as { n: number }).n;

function activeQueues() {
  db.exec(`DELETE FROM vector_index_queue;
    CREATE TABLE vector_generations(id INTEGER PRIMARY KEY,name TEXT UNIQUE,model_name TEXT,embedder_name TEXT,dimensions INTEGER,cards_index TEXT,status TEXT,active INTEGER);
    CREATE TABLE vector_work_items(id INTEGER PRIMARY KEY,generation_id INTEGER,card_id TEXT,action TEXT,status TEXT DEFAULT 'queued',attempts INTEGER DEFAULT 0,
      revision INTEGER DEFAULT 0,leased_revision INTEGER,next_attempt_at TEXT DEFAULT CURRENT_TIMESTAMP,lease_owner TEXT,lease_expires_at TEXT,
      meili_task_uids TEXT,last_error TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,completed_at TEXT,
      UNIQUE(generation_id,card_id));
    INSERT INTO vector_generations VALUES (1,'active','model','active-embedder',2,'card_vectors_active','active',1),(2,'building','model','other-embedder',2,'card_vectors_building','building',0);
    INSERT INTO vector_work_items(id,generation_id,card_id,action) VALUES (1,1,'1','upsert'),(2,1,'2','delete'),(3,2,'1','upsert');
    INSERT INTO card_embedding_meta VALUES ('2','active-embedder','model',2,'card',0,'delete-me','before'),('2','other-embedder','model',2,'card',0,'keep-me','before');`);
}

const work = () => db.prepare('SELECT id,generation_id,card_id,action,status,revision,leased_revision,lease_owner,lease_expires_at FROM vector_work_items ORDER BY id').all();

it('keeps work queued with no provider and acknowledges successful writes with model metadata', async () => {
  expect(await createVectorQueueDrainer(db)()).toEqual({ processed: 0, pending: 2, configured: false });
  const deleted: string[] = [];
  const flush = createVectorQueueDrainer(db, { indexVectorDocuments: async () => [indexed], deleteVectorDocuments: async (ids) => { deleted.push(...ids); } }, embedder);
  expect(await flush()).toEqual({ processed: 2, pending: 0, configured: true });
  expect(deleted).toEqual(['2']);
  expect(db.prepare('SELECT text_sha256 FROM card_embedding_meta WHERE cardId = 1').get()).toEqual({ text_sha256: indexed.textHash });
});

it('preserves failed and cancelled work for restart/retry', async () => {
  const failure = createVectorQueueDrainer(db, { indexVectorDocuments: async () => { throw new Error('provider failed'); }, deleteVectorDocuments: async () => undefined }, embedder);
  await expect(failure()).rejects.toThrow('provider failed'); expect(count()).toBe(2);
  await expect(failure(100, AbortSignal.abort())).rejects.toThrow(); expect(count()).toBe(2);
  expect(db.prepare('SELECT text_sha256 FROM card_embedding_meta WHERE cardId = 1').get()).toEqual({ text_sha256: 'old' });
});

it('does not erase newer work that reused the queue ID and timestamp while embeddings ran', async () => {
  const flush = createVectorQueueDrainer(db, { indexVectorDocuments: async () => {
    db.prepare('UPDATE cards SET description = ? WHERE id = 1').run('new content');
    return [indexed];
  }, deleteVectorDocuments: async () => undefined }, embedder);
  expect(await flush()).toEqual({ processed: 1, pending: 1, configured: true });
  expect(db.prepare('SELECT cardId FROM vector_index_queue').all()).toEqual([{ cardId: '1' }]);
  expect(db.prepare('SELECT text_sha256 FROM card_embedding_meta WHERE cardId = 1').get()).toEqual({ text_sha256: 'old' });
});

it('rejects missing write acknowledgments instead of clearing a queue', async () => {
  const flush = createVectorQueueDrainer(db, { indexVectorDocuments: async () => [], deleteVectorDocuments: async () => undefined }, embedder);
  await expect(flush()).rejects.toMatchObject({ code: 'INTEGRITY' }); expect(count()).toBe(2);
});

it('reports active-generation pending work without a provider and leaves all work unchanged', async () => {
  activeQueues();
  const before = work();
  expect(await createVectorQueueDrainer(db)()).toEqual({ processed: 0, pending: 2, configured: false });
  expect(work()).toEqual(before);
});

it('indexes and completes active generation work with its embedder identity while preserving unrelated work and metadata', async () => {
  activeQueues();
  const unrelated = work()[2];
  const index = vi.fn(async () => [indexed]);
  const deleted: string[] = [];
  const flush = createVectorQueueDrainer(db, { indexVectorDocuments: index, deleteVectorDocuments: async (ids) => { deleted.push(...ids); } }, embedder);
  expect(await flush()).toEqual({ processed: 2, pending: 0, configured: true });
  expect(index).toHaveBeenCalledTimes(1);
  expect(deleted).toEqual(['2']);
  expect(work()).toMatchObject([{ id: 1, status: 'completed', lease_owner: null }, { id: 2, status: 'completed', lease_owner: null }, unrelated]);
  expect(db.prepare('SELECT embedder_name,text_sha256 FROM card_embedding_meta WHERE cardId = 1 ORDER BY embedder_name').all())
    .toEqual([{ embedder_name: 'active-embedder', text_sha256: indexed.textHash }, { embedder_name: 'existing', text_sha256: 'old' }]);
  expect(db.prepare('SELECT embedder_name,text_sha256 FROM card_embedding_meta WHERE cardId = 2').all())
    .toEqual([{ embedder_name: 'other-embedder', text_sha256: 'keep-me' }]);
});

it('recovers expired leases and submissions without stealing valid leases or running future retries', async () => {
  activeQueues();
  db.exec(`UPDATE vector_work_items SET status='leased',lease_owner='live-worker',lease_expires_at=datetime('now','+1 hour') WHERE id=1;
    UPDATE vector_work_items SET status='submitted',leased_revision=revision,lease_owner='old-worker',lease_expires_at=datetime('now','-1 minute') WHERE id=2;
    INSERT INTO vector_work_items(id,generation_id,card_id,action,status,leased_revision,lease_owner,lease_expires_at)
      VALUES (4,1,'3','delete','leased',0,'old-worker',datetime('now','-1 minute'));
    INSERT INTO vector_work_items(id,generation_id,card_id,action,status,next_attempt_at)
      VALUES (5,1,'4','upsert','retry',datetime('now','+1 hour'));
    INSERT INTO vector_work_items(id,generation_id,card_id,action,status,lease_owner,lease_expires_at)
      VALUES (6,1,'5','delete','submitted','live-worker',datetime('now','+1 hour'));`);
  const index = vi.fn(async () => [indexed]);
  const before = work();
  expect(await createVectorQueueDrainer(db)()).toEqual({ processed: 0, pending: 3, configured: false });
  const deleted: string[] = [];
  const flush = createVectorQueueDrainer(db, { indexVectorDocuments: index, deleteVectorDocuments: async (ids) => { deleted.push(...ids); } }, embedder);
  expect(await flush()).toEqual({ processed: 2, pending: 1, configured: true });
  expect(deleted).toEqual(['2', '3']);
  expect(index).not.toHaveBeenCalled();
  const after = work();
  for (const position of [0, 2, 4, 5]) expect(after[position]).toEqual(before[position]);
  expect(after[1]).toMatchObject({ status: 'completed' });
  expect(after[3]).toMatchObject({ status: 'completed' });
});

it('does not complete a newer active work revision or overwrite its embedding metadata', async () => {
  activeQueues();
  const flush = createVectorQueueDrainer(db, { indexVectorDocuments: async () => {
    db.exec(`UPDATE cards SET description='new revision' WHERE id=1;
      UPDATE vector_work_items SET status='queued',revision=revision+1,next_attempt_at=CURRENT_TIMESTAMP WHERE id=1;`);
    return [indexed];
  }, deleteVectorDocuments: async () => undefined }, embedder);
  expect(await flush()).toEqual({ processed: 1, pending: 1, configured: true });
  expect(work()[0]).toMatchObject({ id: 1, status: 'queued', revision: 1 });
  expect(db.prepare("SELECT * FROM card_embedding_meta WHERE cardId=1 AND embedder_name='active-embedder'").get()).toBeUndefined();
});

it.each(['source', 'action'])('keeps active work retryable when its %s changes without a revision bump', async (changed) => {
  activeQueues();
  const flush = createVectorQueueDrainer(db, { indexVectorDocuments: async () => {
    if (changed === 'source') db.exec("UPDATE cards SET description='changed' WHERE id=1");
    else db.exec("UPDATE vector_work_items SET action='delete' WHERE id=1");
    return [indexed];
  }, deleteVectorDocuments: async () => undefined }, embedder);
  expect(await flush()).toEqual({ processed: 1, pending: 1, configured: true });
  expect(work()[0]).toMatchObject({ status: 'retry', lease_owner: null });
  expect(db.prepare("SELECT * FROM card_embedding_meta WHERE cardId=1 AND embedder_name='active-embedder'").get()).toBeUndefined();
});

it('releases only owned active leases after provider failure and allows a later explicit retry', async () => {
  activeQueues();
  const fail = vi.fn(async () => { throw new Error('provider failed'); });
  const index = vi.fn(async () => [indexed]);
  const failure = createVectorQueueDrainer(db, { indexVectorDocuments: fail, deleteVectorDocuments: async () => undefined }, embedder);
  await expect(failure()).rejects.toThrow('provider failed');
  expect(work()).toMatchObject([{ status: 'retry', lease_owner: null }, { status: 'retry', lease_owner: null }, { status: 'queued', lease_owner: null }]);
  expect(await createVectorQueueDrainer(db)()).toMatchObject({ pending: 2 });
  expect(await createVectorQueueDrainer(db, { indexVectorDocuments: index, deleteVectorDocuments: async () => undefined }, embedder)())
    .toEqual({ processed: 2, pending: 0, configured: true });
});

it('rejects an incompatible active generation instead of falling back to matching old metadata', async () => {
  activeQueues(); db.exec("UPDATE vector_generations SET model_name='other-model' WHERE id=1");
  const before = work(), index = vi.fn(async () => [indexed]);
  const flush = createVectorQueueDrainer(db, { indexVectorDocuments: index, deleteVectorDocuments: async () => undefined }, embedder);
  await expect(flush()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  expect(index).not.toHaveBeenCalled(); expect(work()).toEqual(before);
});

it('does not acknowledge work after its generation changes during indexing', async () => {
  activeQueues();
  const flush = createVectorQueueDrainer(db, { indexVectorDocuments: async () => {
    db.exec("UPDATE vector_generations SET active=0,status='retired' WHERE id=1; UPDATE vector_generations SET active=1,status='active' WHERE id=2");
    return [indexed];
  }, deleteVectorDocuments: async () => undefined }, embedder);
  expect(await flush()).toEqual({ processed: 0, pending: 1, configured: true });
  expect(work()).toMatchObject([{ status: 'retry', lease_owner: null }, { status: 'retry', lease_owner: null }, { status: 'queued', lease_owner: null }]);
  expect(db.prepare("SELECT * FROM card_embedding_meta WHERE cardId=1 AND embedder_name='active-embedder'").get()).toBeUndefined();
});
