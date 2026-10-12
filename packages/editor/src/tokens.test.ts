import { afterEach, expect, it, vi } from 'vitest';
import { GptTokenizer } from '@character-foundry/character-foundry/tokenizers';
import { createEditor } from './controller.js';
import type { EditorDocument } from './controller.js';
import { createTokenAnalysis, tokenProjection, validateTokenTexts } from './tokens.js';
import { createWorkerTokenizer } from './worker-tokenizer.js';

const document = (description = 'Hello world!'): EditorDocument => ({ spec: 'chara_card_v3', data: { name: 'Aster', description } });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('projects separate greetings and enabled lore text, flags opaque shapes, and never edits the draft', async () => {
  const input = document();
  input.data = { ...(input.data as EditorDocument), personality: null, scenario: { opaque: true },
    alternate_greetings: ['One', 'Two', 7], group_only_greetings: ['Group'],
    character_book: { entries: [{ content: 'Enabled', enabled: true }, { content: 'Implicit' },
      { content: 'Disabled', enabled: false }, { content: 'Unknown flag', enabled: 1 }, { content: ['unsupported'] }] },
    extensions: { visual_description: 'Portrait prompt', depth_prompt: { prompt: 'Depth note' }, unknown: { retained: true } } };
  const editor = createEditor({ revisionId: 'r1', document: input }, { save: vi.fn() });
  const before = editor.getSnapshot(), encoded = JSON.stringify(before);
  const analysis = createTokenAnalysis({ label: 'test', count: async (texts) => texts.map((text) => text.length) });
  await analysis.update(before.document);
  const result = analysis.getSnapshot();
  expect(result.status).toBe('ready');
  const counts = Object.fromEntries(result.fields.map((field) => [field.label, field.count]));
  expect(counts['Alternate Greetings']).toBe(6);
  expect(counts['Group Only Greetings']).toBe(5);
  expect(counts['Enabled lorebook entries']).toBe(15);
  expect(counts['Character Note']).toBe(10);
  expect(result.disabledLoreEntries).toBe(1);
  expect(result.omitted).toEqual(['Scenario', 'Alternate Greetings', 'Lorebook', 'Enabled lorebook entries']);
  expect(editor.getSnapshot()).toBe(before); expect(JSON.stringify(before)).toBe(encoded);
});

it('isolates instances and ignores cancelled results, including providers that ignore abort', async () => {
  const requests: { resolve: (values: number[]) => void; texts: readonly string[]; signal: AbortSignal }[] = [];
  const port = { label: 'test', count: (texts: readonly string[], signal: AbortSignal) => new Promise<number[]>((resolve) => requests.push({ resolve, texts, signal })) };
  const a = createTokenAnalysis(port), b = createTokenAnalysis(port);
  const old = a.update(document('Old')), other = b.update(document('Other')), latest = a.update(document('New'));
  expect(requests[0]!.signal.aborted).toBe(true); expect(requests[1]!.signal.aborted).toBe(false);
  requests[2]!.resolve(requests[2]!.texts.map(() => 3)); await latest;
  const current = a.getSnapshot();
  requests[0]!.resolve(requests[0]!.texts.map(() => 99)); await old; expect(a.getSnapshot()).toBe(current);
  requests[1]!.resolve(requests[1]!.texts.map(() => 7)); await other;
  expect(b.getSnapshot().total).not.toBe(current.total);
  const pending = a.update(document('Closed')); a.cancel();
  const cancelled = a.getSnapshot(); requests[3]!.resolve(requests[3]!.texts.map(() => 1)); await pending;
  expect(a.getSnapshot()).toBe(cancelled);
});

it('bounds work and clears old totals on errors without affecting saved or unsaved content', async () => {
  expect(() => validateTokenTexts(['x'.repeat(1_000_001)])).toThrow(/too large/);
  expect(() => tokenProjection({ spec: 'chara_card_v3', data: { character_book: { entries: Array.from({ length: 2001 }, () => ({ content: '' })) } } })).toThrow(/Too many/);
  const count = vi.fn(async (texts: readonly string[]) => texts.map(() => 1));
  const analysis = createTokenAnalysis({ label: 'test', count });
  await analysis.update(document()); expect(analysis.getSnapshot().status).toBe('ready');
  count.mockResolvedValueOnce([-1]); await analysis.update(document('Bad provider'));
  expect(analysis.getSnapshot()).toMatchObject({ status: 'error', total: 0, fields: [] });
  count.mockRejectedValueOnce(new Error('Provider failed')); await analysis.update(document());
  expect(analysis.getSnapshot().error).toBe('Provider failed');
  await analysis.update(document()); expect(analysis.getSnapshot().status).toBe('ready');
});

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
