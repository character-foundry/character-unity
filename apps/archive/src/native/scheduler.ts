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
export function createScheduler(archive: NativeArchive, plugins: readonly ScraperPlugin[], options: {
  fetch?: Fetch; log?: (event: Record<string, unknown>) => void; tickMs?: number; now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
} = {}) {
  const log = options.log ?? (() => undefined);
  const now = options.now ?? Date.now;
  const running = new Map<string, { runId: number; controller: AbortController; done: Promise<void> }>();
  let timer: ReturnType<typeof setInterval> | undefined;

  function plugin(provider: string) {
    const found = plugins.find((item) => item.provider === provider);
    if (!found) throw new Error(`Unknown source ${provider}`);
    return found;
  }

  function start(provider: string, trigger: 'manual' | 'schedule') {
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
      .then((result) => {
        archive.finishRun(runId, result);
        log({ event: 'scrape-finished', provider, runId, ...result });
      })
      .finally(() => running.delete(provider));
    running.set(provider, { runId, controller, done });
    return runId;
  }

  function due() {
    for (const source of plugins) {
      const record = archive.source(source.provider);
      if (!record.enabled || running.has(source.provider)) continue;
      const last = archive.lastFinishedRun(source.provider);
      const lastAt = last ? Date.parse(last.finishedAt ?? last.startedAt) : -Infinity;
      if (now() - lastAt >= record.intervalMinutes * 60_000) start(source.provider, 'schedule');
    }
  }

  return {
    start,
    /** Starts every enabled source whose interval has passed. */
    due,
    running: (provider: string) => running.get(provider)?.runId ?? null,
    cancel(runId: number) {
      for (const run of running.values()) if (run.runId === runId) { run.controller.abort(); return true; }
      return false;
    },
    begin() {
      timer = setInterval(() => { try { due(); } catch (error) { log({ event: 'scrape-schedule-failed', message: error instanceof Error ? error.message : String(error) }); } }, options.tickMs ?? 60_000);
      timer.unref?.();
      setTimeout(() => { try { due(); } catch { /* reported on the next tick */ } }, 5_000).unref?.();
    },
    /** Stops scheduling and cancels running scrapes; resolves when they have recorded their outcome. */
    async stop() {
      clearInterval(timer);
      for (const run of running.values()) run.controller.abort();
      await Promise.all([...running.values()].map((run) => run.done));
    },
    /** For tests: resolves when the source's current run has finished. */
    settled: (provider: string) => running.get(provider)?.done ?? Promise.resolve(),
  };
}
export type Scheduler = ReturnType<typeof createScheduler>;
