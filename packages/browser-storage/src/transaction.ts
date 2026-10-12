/** Only IDB requests may be yielded. Resume synchronously inside success events,
 * while the transaction is active; no network, timers or hashing inside a write. */
export function* request<T>(value: IDBRequest<T>): Generator<IDBRequest, T, unknown> {
  return (yield value) as T;
}

export function transaction<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode,
  operation: (tx: IDBTransaction) => Generator<IDBRequest, T, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode, { durability: 'strict' });
    let result: T;
    let failure: unknown;
    let finished = false;
    tx.oncomplete = () => finished ? resolve(result) : reject(new Error('Storage transaction completed before its operation'));
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('Storage transaction was aborted'));
    const steps = operation(tx);
    function next(value?: unknown) {
      try {
        const step = steps.next(value);
        if (step.done) { result = step.value; finished = true; }
        else step.value.onsuccess = () => next(step.value.result);
      } catch (error) {
        failure = error;
        tx.abort();
      }
    }
    next();
  });
}
