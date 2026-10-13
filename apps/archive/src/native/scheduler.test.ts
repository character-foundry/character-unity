import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScrapeContext, ScraperPlugin } from '@character-unity/scraper-kit';
import type { RunRecord, SourceRecord } from './store.js';
import { createScheduler, RunConflictError } from './scheduler.js';

const minute = 60_000;
const counts = { listed: 0, added: 0, updated: 0, unchanged: 0, skipped: 0, blocked: 0, errors: 0 };

function fixture(providers = ['demo'], options: Parameters<typeof createScheduler>[2] = {}) {
  let nextRun = 0;
  const sources = new Map<string, SourceRecord>(providers.map((provider) => [provider,
    { provider, enabled: false, intervalMinutes: 60, settings: {}, secrets: {}, updatedAt: null }]));
  const runs = new Map<number, RunRecord>();
  const finished = new Map<string, RunRecord>();
  const held = new Set<string>();
  const plugins: ScraperPlugin[] = providers.map((provider) => ({
    provider, label: provider, minIntervalMs: 0, settings: [], secrets: [],
    async *discover(context: ScrapeContext) {
      if (held.has(provider) && !context.signal.aborted) await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      yield* [];
    },
    fetch: vi.fn(async () => null),
  }));
  const archive = {
    sink: { blocked: vi.fn(() => false), known: vi.fn(() => null), seen: vi.fn(), put: vi.fn(async () => 'added' as const) },
    source: vi.fn((provider: string) => sources.get(provider)!),
    lastFinishedRun: vi.fn((provider: string) => finished.get(provider) ?? null),
    startRun: vi.fn((provider: string, trigger: string) => {
      const id = ++nextRun;
      runs.set(id, { id, provider, trigger, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, error: null, ...counts });
      return id;
    }),
    progressRun: vi.fn(),
    finishRun: vi.fn((id: number, result: Parameters<Parameters<typeof createScheduler>[0]['finishRun']>[1]) => {
      const run = { ...runs.get(id)!, ...result, error: result.error ?? null, finishedAt: new Date().toISOString() };
      runs.set(id, run); finished.set(run.provider, run);
    }),
  };
  const log = vi.fn();
  const scheduler = createScheduler(archive, plugins, { ...options, log });
  return {
    archive, scheduler, runs, log, held,
    settings(provider: string, input: Partial<SourceRecord>) { sources.set(provider, { ...sources.get(provider)!, ...input }); },
    lastFinished(provider: string, at: number) {
      const timestamp = new Date(at).toISOString();
      finished.set(provider, { id: 0, provider, trigger: 'schedule', status: 'done', startedAt: timestamp, finishedAt: timestamp, error: null, ...counts });
    },
  };
}

describe('Archive scheduler wake-ups', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-13T12:00:00Z')); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('leaves no timer and performs no recurring database reads with all sources disabled', async () => {
    const onFinished = vi.fn(async () => undefined);
    const { archive, scheduler } = fixture(['chub', 'ct', 'risuai', 'wyvern'], { onFinished });
    scheduler.begin();
    expect(archive.source).toHaveBeenCalledTimes(4);
    expect(archive.lastFinishedRun).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(24 * 60 * minute);
    expect(archive.source).toHaveBeenCalledTimes(4);
    expect(archive.startRun).not.toHaveBeenCalled();
    expect(onFinished).not.toHaveBeenCalled();
    await scheduler.stop();
  });

  it('wakes exactly for the earliest enabled source and recomputes after completion', async () => {
    const { archive, scheduler, settings, lastFinished } = fixture(['early', 'later', 'disabled']);
    settings('early', { enabled: true }); settings('later', { enabled: true });
    lastFinished('early', Date.now() - 55 * minute); lastFinished('later', Date.now() - 10 * minute);
    scheduler.begin();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5 * minute - 1);
    expect(archive.startRun).not.toHaveBeenCalled();
    expect(archive.source).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(archive.startRun.mock.calls).toEqual([['early', 'schedule']]);
    expect(scheduler.running('early')).toBeNull();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(45 * minute - 1);
    expect(archive.startRun).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(archive.startRun.mock.calls).toEqual([['early', 'schedule'], ['later', 'schedule']]);
    await vi.advanceTimersByTimeAsync(15 * minute);
    expect(archive.startRun.mock.calls).toEqual([['early', 'schedule'], ['later', 'schedule'], ['early', 'schedule']]);
    await scheduler.stop();
  });

  it('keeps the startup grace for already-due sources and begin is idempotent', async () => {
    const { archive, scheduler, settings } = fixture();
    settings('demo', { enabled: true });
    scheduler.begin(); scheduler.begin();
    expect(vi.getTimerCount()).toBe(1);
    expect(archive.source).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(archive.startRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(archive.startRun).toHaveBeenCalledExactlyOnceWith('demo', 'schedule');
    await scheduler.stop();
  });

  it('responds to source enabling and disabling through reschedule without polling', async () => {
    const { archive, scheduler, settings } = fixture();
    scheduler.begin();
    settings('demo', { enabled: true }); scheduler.reschedule();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(archive.startRun).toHaveBeenCalledExactlyOnceWith('demo', 'schedule');
    settings('demo', { enabled: false }); scheduler.reschedule();
    expect(vi.getTimerCount()).toBe(0);
    const reads = archive.source.mock.calls.length;
    await vi.advanceTimersByTimeAsync(24 * 60 * minute);
    expect(archive.source).toHaveBeenCalledTimes(reads);
    expect(archive.startRun).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });

  it('moves the existing timer when the configured interval is shortened or lengthened', async () => {
    const { archive, scheduler, settings, lastFinished } = fixture();
    settings('demo', { enabled: true }); lastFinished('demo', Date.now()); scheduler.begin();
    settings('demo', { intervalMinutes: 15 }); scheduler.reschedule();
    await vi.advanceTimersByTimeAsync(15 * minute);
    expect(archive.startRun).toHaveBeenCalledTimes(1);
    settings('demo', { intervalMinutes: 120 }); scheduler.reschedule();
    await vi.advanceTimersByTimeAsync(120 * minute - 1);
    expect(archive.startRun).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(archive.startRun).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it('retains manual start, conflict, cancellation and settled before begin', async () => {
    const { archive, scheduler, held, runs } = fixture();
    held.add('demo');
    const id = scheduler.start('demo', 'manual');
    expect(scheduler.running('demo')).toBe(id);
    expect(() => scheduler.start('demo', 'manual')).toThrow(RunConflictError);
    expect(vi.getTimerCount()).toBe(0);
    expect(scheduler.cancel(id)).toBe(true);
    await scheduler.settled('demo');
    expect(runs.get(id)?.status).toBe('cancelled');
    expect(scheduler.running('demo')).toBeNull();
    expect(scheduler.cancel(id)).toBe(false);
    expect(archive.startRun).toHaveBeenCalledExactlyOnceWith('demo', 'manual');
    await scheduler.stop();
  });

  it('stops the pending startup timer and rejects new starts permanently', async () => {
    const { archive, scheduler, settings } = fixture();
    settings('demo', { enabled: true }); scheduler.begin();
    await scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
    const reads = archive.source.mock.calls.length;
    scheduler.begin(); scheduler.due(); scheduler.reschedule();
    expect(() => scheduler.start('demo', 'manual')).toThrow('scheduler has stopped');
    await vi.advanceTimersByTimeAsync(24 * 60 * minute);
    expect(archive.source).toHaveBeenCalledTimes(reads);
    expect(archive.startRun).not.toHaveBeenCalled();
  });

  it('stops a future due timer without waking or reading the database again', async () => {
    const { archive, scheduler, settings, lastFinished } = fixture();
    settings('demo', { enabled: true }); lastFinished('demo', Date.now()); scheduler.begin();
    await scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
    const reads = archive.source.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60 * minute);
    expect(archive.source).toHaveBeenCalledTimes(reads);
    expect(archive.startRun).not.toHaveBeenCalled();
  });

  it('aborts running work, waits for its outcome, and does not re-arm on completion', async () => {
    const { archive, scheduler, settings, held, runs } = fixture(['demo', 'other']);
    for (const provider of ['demo', 'other']) { settings(provider, { enabled: true }); held.add(provider); }
    scheduler.begin();
    await vi.advanceTimersByTimeAsync(5_000);
    const ids = [scheduler.running('demo')!, scheduler.running('other')!];
    expect(ids.every((id) => id > 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await scheduler.stop();
    for (const id of ids) expect(runs.get(id)?.status).toBe('cancelled');
    expect(archive.finishRun).toHaveBeenCalledTimes(2);
    expect(scheduler.running('demo')).toBeNull();
    expect(scheduler.running('other')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * minute);
    expect(archive.startRun).toHaveBeenCalledTimes(2);
  });

  it('logs a scheduling read failure and retries instead of losing the schedule', async () => {
    const { archive, scheduler, settings, log } = fixture();
    settings('demo', { enabled: true });
    archive.source.mockImplementationOnce(() => { throw new Error('database busy'); });
    scheduler.begin();
    expect(log).toHaveBeenCalledWith({ event: 'scrape-schedule-failed', message: 'database busy' });
    await vi.advanceTimersByTimeAsync(minute);
    expect(archive.startRun).toHaveBeenCalledExactlyOnceWith('demo', 'schedule');
    await scheduler.stop();
  });

  it('keeps a source running through its completion hook and aborts and waits for that hook on stop', async () => {
    let release: () => void = () => undefined;
    const onFinished = vi.fn(async (signal: AbortSignal) => { signal.throwIfAborted(); await new Promise<void>((resolve) => { release = resolve; }); });
    const { archive, scheduler, runs, log } = fixture(['demo'], { onFinished });
    const id = scheduler.start('demo', 'manual');
    await vi.advanceTimersByTimeAsync(0);
    expect(archive.finishRun).toHaveBeenCalledTimes(1);
    expect(runs.get(id)?.status).toBe('done');
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(scheduler.running('demo')).toBe(id);
    expect(() => scheduler.start('demo', 'manual')).toThrow(RunConflictError);
    const signal = onFinished.mock.calls[0]![0];
    let stopped = false;
    const stopping = scheduler.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(signal.aborted).toBe(true);
    expect(stopped).toBe(false);
    expect(scheduler.running('demo')).toBe(id);
    release(); await stopping;
    expect(scheduler.running('demo')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(log.mock.calls.some(([event]) => event.event === 'archive-index-failed')).toBe(false);
  });

  it('reports hook failure separately without leaking error details or breaking the next scheduled run', async () => {
    const onFinished = vi.fn(async () => { throw new Error('failed https://host.test?token=private-secret'); });
    const { archive, scheduler, settings, runs, log } = fixture(['demo'], { onFinished });
    settings('demo', { enabled: true }); scheduler.begin();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runs.get(1)?.status).toBe('done');
    expect(scheduler.running('demo')).toBeNull();
    expect(log).toHaveBeenCalledWith({ event: 'archive-index-failed', provider: 'demo', runId: 1,
      message: 'Search indexing did not finish; queued work is retained' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-secret');
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60 * minute);
    expect(archive.startRun).toHaveBeenCalledTimes(2);
    expect(onFinished).toHaveBeenCalledTimes(2);
    expect(runs.get(2)?.status).toBe('done');
    await scheduler.stop();
  });
});
