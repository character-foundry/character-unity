import type { TokenPort } from './contract.js';
import { validateTokenTexts } from './contract.js';

/** Optional browser host adapter. The vocabulary loads only on first use; every
 * request owns a worker which is terminated on completion, timeout or abort. */
export function createWorkerTokenizer(): TokenPort {
  return {
    label: 'o200k_base',
    local: true,
    async count(texts, signal) {
      signal.throwIfAborted(); validateTokenTexts(texts);
      const worker = new Worker(new URL('./tokenizer.worker.ts', import.meta.url), { type: 'module' });
      try {
        return await new Promise<number[]>((resolve, reject) => {
          const aborted = () => finish(signal.reason ?? new Error('Token counting cancelled.'));
          const timeout = setTimeout(() => finish(new Error('Token counting timed out. Try again.')), 15_000);
          function finish(error?: unknown, counts?: number[]) {
            clearTimeout(timeout); signal.removeEventListener('abort', aborted);
            if (error) reject(error); else resolve(counts!);
          }
          signal.addEventListener('abort', aborted, { once: true });
          worker.onerror = (event) => { event.preventDefault(); finish(new Error('The tokenizer could not load. Try again.')); };
          worker.onmessageerror = () => finish(new Error('The tokenizer returned an unreadable result.'));
          worker.onmessage = (event: MessageEvent<unknown>) => {
            const value = event.data as { counts?: number[]; error?: string } | null;
            if (value && Array.isArray(value.counts) && value.counts.length === texts.length
              && value.counts.every((count) => Number.isSafeInteger(count) && count >= 0)) finish(undefined, value.counts);
            else finish(new Error('This text could not be tokenized. Reserved token markers or unsupported input may be present.'));
          };
          try { worker.postMessage([...texts]); } catch { finish(new Error('The tokenizer could not start. Try again.')); }
        });
      } finally { worker.terminate(); }
    },
  };
}
