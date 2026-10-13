import { runScrape } from '@character-unity/scraper-kit';
import type { Fetch, RunCounts, ScraperPlugin } from '@character-unity/scraper-kit';
import type { NativeArchive } from './store.js';

export class RunConflictError extends Error {
  constructor(public readonly runId: number) { super('This source is already running'); this.name = 'RunConflictError'; }
}

/**
 * Runs sources one run per source at a time, on demand or when an enabled source's interval has passed
 * since its last run. Single process: the Archive service is the only writer.
 */
export function createScheduler(archive: Pick<NativeArchive, 'sink' | 'source' | 'startRun' | 'progressRun' | 'finishRun' | 'lastFinishedRun'>, plugins: readonly ScraperPlugin[], options: {
  fetch?: Fetch; log?: (event: Record<string, unknown>) => void;
  /** Retry delay after a scheduling failure; successful scheduling never polls. */
  tickMs?: number; now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Drains derived work after the scrape outcome is recorded; shutdown aborts and waits for it. */
  onFinished?: (signal: AbortSignal) => Promise<void>;
} = {}) {
  const log = options.log ?? (() => undefined);
  const now = options.now ?? Date.now;
  const running = new Map<string, { runId: number; controller: AbortController; done: Promise<void> }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let begun = false, stopped = false;

  function wakeAfter(delay: number) {
    timer = setTimeout(() => {
      timer = undefined;
      try { due(); } catch (error) { retrySchedule(error); }
    }, Math.min(delay, 2_147_483_647));
    timer.unref?.();
  }

  function retrySchedule(error: unknown) {
    log({ event: 'scrape-schedule-failed', message: error instanceof Error ? error.message : String(error) });
    if (!begun || stopped) return;
    clearTimeout(timer);
    wakeAfter(options.tickMs ?? 60_000);
  }

  function nextAt(provider: string, intervalMinutes: number) {
    const last = archive.lastFinishedRun(provider);
    const lastAt = last ? Date.parse(last.finishedAt ?? last.startedAt) : NaN;
    return Number.isFinite(lastAt) ? lastAt + intervalMinutes * 60_000 : now();
  }

  function schedule(minimumDelay = 0) {
    clearTimeout(timer); timer = undefined;
    if (!begun || stopped) return;
    let next = Infinity;
    for (const source of plugins) {
      if (running.has(source.provider)) continue;
      const record = archive.source(source.provider);
      if (record.enabled) next = Math.min(next, nextAt(source.provider, record.intervalMinutes));
    }
    if (Number.isFinite(next)) wakeAfter(Math.max(minimumDelay, next - now(), 0));
  }

  function reschedule(minimumDelay = 0) {
    try { schedule(minimumDelay); } catch (error) { retrySchedule(error); }
  }

  function plugin(provider: string) {
    const found = plugins.find((item) => item.provider === provider);
    if (!found) throw new Error(`Unknown source ${provider}`);
    return found;
  }

  function launch(provider: string, trigger: 'manual' | 'schedule') {
    if (stopped) throw new Error('The Archive scheduler has stopped');
    const source = plugin(provider);
    const current = running.get(provider);
    if (current) throw new RunConflictError(current.runId);
    const record = archive.source(provider);
    const runId = archive.startRun(provider, trigger);
    const controller = new AbortController();
    let lastWrite = 0;
    const progress = (counts: RunCounts) => {
      if (now() - lastWrite < 1_000) return;
      lastWrite = now(); archive.progressRun(runId, counts);
    };
    log({ event: 'scrape-started', provider, runId, trigger });
    const done = runScrape(source, archive.sink, { settings: record.settings, secrets: record.secrets, signal: controller.signal, log,
      onProgress: progress, ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.sleep ? { sleep: options.sleep } : {}) })
      .catch((error: unknown) => ({ status: 'failed' as const, listed: 0, added: 0, updated: 0, unchanged: 0, skipped: 0, blocked: 0, errors: 1,
        error: error instanceof Error ? error.message : String(error) }))
      .then(async (result) => {
        archive.finishRun(runId, result);
        log({ event: 'scrape-finished', provider, runId, ...result });
        if (options.onFinished && !controller.signal.aborted) {
          try { await options.onFinished(controller.signal); }
          catch {
            // Hook errors can contain request credentials. Keep the durable scrape outcome and report
            // indexing separately without exposing the error or clearing its queued work.
            if (!controller.signal.aborted) log({ event: 'archive-index-failed', provider, runId,
              message: 'Search indexing did not finish; queued work is retained' });
          }
        }
      })
      .finally(() => { running.delete(provider); reschedule(); });
    running.set(provider, { runId, controller, done });
    return runId;
  }

  function due() {
    if (stopped) return;
    try {
      for (const source of plugins) {
        if (running.has(source.provider)) continue;
        const record = archive.source(source.provider);
        if (record.enabled && now() >= nextAt(source.provider, record.intervalMinutes)) launch(source.provider, 'schedule');
      }
    } finally { reschedule(); }
  }

  return {
    start(provider: string, trigger: 'manual' | 'schedule') {
      const runId = launch(provider, trigger);
      reschedule();
      return runId;
    },
    /** Starts every enabled source whose interval has passed. */
    due,
    /** Recomputes the next wake-up after source settings change; disabled sources need no timer. */
    reschedule: () => reschedule(),
    running: (provider: string) => running.get(provider)?.runId ?? null,
    cancel(runId: number) {
      for (const run of running.values()) if (run.runId === runId) { run.controller.abort(); return true; }
      return false;
    },
    begin() {
      if (begun || stopped) return;
      begun = true;
      reschedule(5_000);
    },
    /** Stops scheduling and cancels running scrapes and hooks; waits for them to settle. */
    async stop() {
      stopped = true; begun = false;
      clearTimeout(timer); timer = undefined;
      const runs = [...running.values()];
      for (const run of runs) run.controller.abort();
      await Promise.all(runs.map((run) => run.done));
    },
    /** For tests: resolves when the source's current run has finished. */
    settled: (provider: string) => running.get(provider)?.done ?? Promise.resolve(),
  };
}
export type Scheduler = ReturnType<typeof createScheduler>;
