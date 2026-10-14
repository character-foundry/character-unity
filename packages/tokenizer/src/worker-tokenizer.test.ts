import { afterEach, expect, it, vi } from 'vitest';
import { GptTokenizer } from '@character-foundry/character-foundry/tokenizers';
import { createWorkerTokenizer, tokenLimits, validateTokenTexts } from './index.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('pins the public Foundry encode primitive to observed o200k_base vectors, with no approximate fallback', () => {
  const tokenizer = new GptTokenizer();
  expect(tokenizer.encode('')).toEqual([]);
  expect(tokenizer.encode('Hello world!')).toEqual([13225, 2375, 0]);
  expect(tokenizer.encode('お誕生日おめでとう')).toEqual([8930, 9697, 243, 128225, 8930, 17693, 4344, 48669]);
  expect(tokenizer.encode('😀 café')).toEqual([84083, 30469]);
  expect(() => tokenizer.encode('<|endoftext|>')).toThrow();
});

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: { preventDefault(): void }) => void;
  onmessageerror?: () => void;
  postMessage = vi.fn(); terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
}

it('terminates owned workers on success, failure, timeout and cancellation', async () => {
  FakeWorker.instances = []; vi.stubGlobal('Worker', FakeWorker); vi.useFakeTimers();
  const port = createWorkerTokenizer();
  expect(port).toMatchObject({ label: 'o200k_base', local: true });
  const done = port.count(['Hello'], new AbortController().signal);
  const first = FakeWorker.instances.at(-1)!; first.onmessage!({ data: { counts: [1] } });
  await expect(done).resolves.toEqual([1]); expect(first.terminate).toHaveBeenCalledOnce();
  const aborted = new AbortController(); const cancelled = port.count(['Cancel'], aborted.signal);
  const pending = expect(cancelled).rejects.toThrow(); aborted.abort(); await pending;
  expect(FakeWorker.instances.at(-1)!.terminate).toHaveBeenCalledOnce();
  const timeout = expect(port.count(['Timeout'], new AbortController().signal)).rejects.toThrow(/timed out/);
  await vi.advanceTimersByTimeAsync(15_000); await timeout;
  expect(FakeWorker.instances.at(-1)!.terminate).toHaveBeenCalledOnce();
  const bad = expect(port.count(['Bad'], new AbortController().signal)).rejects.toThrow(/could not be tokenized/);
  FakeWorker.instances.at(-1)!.onmessage!({ data: { counts: [] } }); await bad;
  expect(FakeWorker.instances.at(-1)!.terminate).toHaveBeenCalledOnce();
  const count = FakeWorker.instances.length;
  await expect(port.count(['Never start'], aborted.signal)).rejects.toThrow(); expect(FakeWorker.instances.length).toBe(count);
});

it('rejects malformed or oversized text before constructing a worker, with inclusive portable bounds', async () => {
  FakeWorker.instances = []; vi.stubGlobal('Worker', FakeWorker);
  expect(tokenLimits).toEqual({ texts: 2000, characters: 1_000_000 });
  expect(() => validateTokenTexts(Array.from({ length: 2000 }, () => ''))).not.toThrow();
  expect(() => validateTokenTexts(['x'.repeat(1_000_000)])).not.toThrow();
  for (const input of [null, {}, 'text', [3], Array.from({ length: 2001 }, () => ''), ['x'.repeat(1_000_001)]]) {
    expect(() => validateTokenTexts(input)).toThrow(/too large or has an unsupported shape/);
  }
  await expect(createWorkerTokenizer().count(['x'.repeat(1_000_001)], new AbortController().signal)).rejects.toThrow(/too large/);
  expect(FakeWorker.instances).toHaveLength(0);
});

it('keeps simultaneous requests independent and preserves count ordering', async () => {
  FakeWorker.instances = []; vi.stubGlobal('Worker', FakeWorker);
  const port = createWorkerTokenizer(), abort = new AbortController();
  const firstTexts = ['One', 'Two'];
  const first = port.count(firstTexts, new AbortController().signal);
  const second = port.count(['Other'], abort.signal);
  const [a, b] = FakeWorker.instances;
  expect(a!.postMessage).toHaveBeenCalledWith(firstTexts);
  expect(a!.postMessage.mock.calls[0]![0]).not.toBe(firstTexts);
  const cancelled = expect(second).rejects.toThrow(); abort.abort(); await cancelled;
  expect(b!.terminate).toHaveBeenCalledOnce(); expect(a!.terminate).not.toHaveBeenCalled();
  a!.onmessage!({ data: { counts: [8, 2] } });
  await expect(first).resolves.toEqual([8, 2]);
  expect(a!.terminate).toHaveBeenCalledOnce();
});

it('returns generic load, message and invalid-count failures and always terminates', async () => {
  FakeWorker.instances = []; vi.stubGlobal('Worker', FakeWorker);
  const port = createWorkerTokenizer();
  const unloaded = expect(port.count(['Text'], new AbortController().signal)).rejects.toThrow('The tokenizer could not load. Try again.');
  const preventDefault = vi.fn(); FakeWorker.instances.at(-1)!.onerror!({ preventDefault }); await unloaded;
  expect(preventDefault).toHaveBeenCalledOnce(); expect(FakeWorker.instances.at(-1)!.terminate).toHaveBeenCalledOnce();
  const unreadable = expect(port.count(['Text'], new AbortController().signal)).rejects.toThrow('The tokenizer returned an unreadable result.');
  FakeWorker.instances.at(-1)!.onmessageerror!(); await unreadable;
  expect(FakeWorker.instances.at(-1)!.terminate).toHaveBeenCalledOnce();
  for (const counts of [[], [-1], [1.5], [NaN], [Number.MAX_SAFE_INTEGER + 1]]) {
    const invalid = expect(port.count(['Text'], new AbortController().signal)).rejects.toThrow(/could not be tokenized/);
    FakeWorker.instances.at(-1)!.onmessage!({ data: { counts } }); await invalid;
    expect(FakeWorker.instances.at(-1)!.terminate).toHaveBeenCalledOnce();
  }
});

it('uses the actual worker public primitive without leaking source text or partial counts on failure', async () => {
  const postMessage = vi.fn(), scope: { postMessage: typeof postMessage; onmessage?: (event: { data: unknown }) => void } = { postMessage };
  vi.stubGlobal('self', scope);
  await import('./tokenizer.worker.js');
  scope.onmessage!({ data: ['Hello world!', '😀 café', ''] });
  expect(postMessage).toHaveBeenLastCalledWith({ counts: [3, 2, 0] });
  scope.onmessage!({ data: ['safe', 'private <|endoftext|> card text'] });
  const generic = { error: 'This text could not be tokenized. Reserved token markers or unsupported input may be present.' };
  expect(postMessage).toHaveBeenLastCalledWith(generic);
  scope.onmessage!({ data: [42] });
  expect(postMessage).toHaveBeenLastCalledWith(generic);
});
