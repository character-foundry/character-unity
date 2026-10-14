import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEditorSession } from '../../unity/session';
import type { EditorSession } from '../../unity/session-types';
import { createLocalTools } from './tools';
import { extractCardData } from '../../lib/card-utils';

const sessions: EditorSession[] = [];
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  const preferences = new Map<string, string>([['ca-llm-providers', JSON.stringify([{ id: 'fixture', name: 'Fixture', kind: 'openai-compatible',
    baseURL: 'http://127.0.0.1:1234/v1', apiKey: '', defaultModel: 'fixture-model' }])]]);
  vi.stubGlobal('localStorage', { getItem: (key: string) => preferences.get(key) ?? null, setItem: (key: string, value: string) => { preferences.set(key, value); } });
  fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { for (const session of sessions.splice(0)) session.dispose(); vi.unstubAllGlobals(); });
async function editor(enabled = true) {
  const session = createEditorSession({ workspaceId: 'tools-workspace', browserLLM: enabled }, { recovery: {
    load: async () => null, save: async () => {}, remove: async () => {}, flush: async () => {},
  } });
  sessions.push(session); await session.open({ cardId: '' });
  session.cards.getState().updateCardFields({ description: 'Original facts', name: 'Aster' });
  return session;
}

it('reviews an optimizer proposal before changing only its selected draft field, without saving', async () => {
  const session = await editor();
  fetcher.mockResolvedValue(Response.json({ choices: [{ message: { content: 'Clearer original facts' } }] }));
  const proposal = await createLocalTools(session).propose({ kind: 'optimize', field: 'description', guidance: 'Tighten the prose' });
  expect(extractCardData(session.cards.getState().currentCard!).description).toBe('Original facts');
  expect(proposal.values).toEqual(['Clearer original facts']);
  proposal.apply(proposal.values[0]!);
  expect(extractCardData(session.cards.getState().currentCard!).description).toBe('Clearer original facts');
  expect(extractCardData(session.cards.getState().currentCard!).name).toBe('Aster');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(String(fetcher.mock.calls[0]![0])).toBe('http://127.0.0.1:1234/v1/chat/completions');
});

it('rejects opaque fields before reading provider settings or sending them for generation', async () => {
  const session = await editor();
  session.cards.getState().updateCardData({ personality: false } as unknown as Partial<import('../../lib/types').CCv2Data>);
  await expect(createLocalTools(session).propose({ kind: 'optimize', field: 'personality' })).rejects.toThrow('cannot edit');
  expect(fetcher).not.toHaveBeenCalled();
  expect(extractCardData(session.cards.getState().currentCard!).personality).toBe(false);
});

it('rechecks the raw field shape at Apply instead of accepting a String-coerced match', async () => {
  const session = await editor();
  session.cards.getState().updateCardFields({ personality: 'false' });
  fetcher.mockResolvedValue(Response.json({ choices: [{ message: { content: 'Proposed personality' } }] }));
  const proposal = await createLocalTools(session).propose({ kind: 'optimize', field: 'personality' });
  session.cards.getState().updateCardData({ personality: false } as unknown as Partial<import('../../lib/types').CCv2Data>);
  expect(() => proposal.apply(proposal.values[0]!)).toThrow('cannot edit');
  expect(extractCardData(session.cards.getState().currentCard!).personality).toBe(false);
});

it('rejects stale proposal applications after edits, selection changes and account disposal', async () => {
  const session = await editor();
  fetcher.mockImplementation(async () => Response.json({ choices: [{ message: { content: 'Proposed facts' } }] }));
  const tools = createLocalTools(session);
  const first = await tools.propose({ kind: 'optimize' });
  session.cards.getState().updateCardFields({ description: 'Typed while reviewing' });
  expect(() => first.apply(first.values[0]!)).toThrow('field changed');
  const second = await tools.propose({ kind: 'optimize' });
  await session.open({ cardId: '' });
  expect(() => second.apply(second.values[0]!)).toThrow();
  const third = await tools.propose({ kind: 'optimize' });
  session.dispose();
  expect(() => third.apply(third.values[0]!)).toThrow();
});

it('does not read browser credentials or call a provider on a hub profile', async () => {
  const session = await editor(false);
  const preferences = vi.fn(); vi.stubGlobal('localStorage', { getItem: preferences });
  await expect(createLocalTools(session).propose({ kind: 'names' })).rejects.toThrow('local installation');
  expect(preferences).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});

it('requires a configured provider and validates name proposals before explicit application', async () => {
  const session = await editor(); const tools = createLocalTools(session);
  vi.stubGlobal('localStorage', { getItem: () => null });
  await expect(tools.propose({ kind: 'names' })).rejects.toThrow('Configure a browser AI provider');
  expect(fetcher).not.toHaveBeenCalled();
});

it('generates names without a missing legacy dataset and rejects arbitrary replacements', async () => {
  const session = await editor();
  fetcher.mockImplementation(async () => Response.json({ choices: [{ message: { content: '["Birch", "Cedar", "Birch"]' } }] }));
  const proposal = await createLocalTools(session).propose({ kind: 'names', guidance: 'Woodland' });
  expect(proposal.values).toEqual(['Birch', 'Cedar']);
  expect(() => proposal.apply('Unreviewed')).toThrow('reviewed proposal');
  proposal.apply('Cedar');
  expect(extractCardData(session.cards.getState().currentCard!).name).toBe('Cedar');
});

it('retrieves bounded exact-version context through the captured workspace Archive read contract without copying or indexing', async () => {
  const session = await editor(); const requests: string[] = [];
  fetcher.mockImplementation(async (input, init) => {
    const path = String(input); requests.push(path); expect(init?.method ?? 'GET').toBe('GET');
    if (path.includes('/archive/v2/cards?')) return Response.json({ cards: [{ id: 'archive-card', versionId: 'version-7', name: 'Archived Aster' },
      { id: 'unity-row', versionId: 'revision-9', name: 'Owned fork', libraryOwned: true, libraryCardId: 'owned-card' }], complete: false });
    return Response.json({ id: path.includes('archive-card') ? 'archive-card' : 'revision-9', versionId: 'version-7',
      document: { data: { name: path.includes('archive-card') ? 'Archived Aster' : 'Owned fork', description: 'Read-only retrieved facts' } } });
  });
  const result = await createLocalTools(session).retrieve('map keeper', 'hybrid');
  expect(result.complete).toBe(false);
  expect(result.snippets).toMatchObject([{ id: 'archive-card', versionId: 'version-7', excerpt: expect.stringContaining('Read-only retrieved facts') },
    { id: 'unity-row', versionId: 'revision-9' }]);
  expect(requests).toEqual(['/api/workspaces/tools-workspace/archive/v2/cards?q=map+keeper&mode=hybrid&limit=5',
    '/api/workspaces/tools-workspace/archive/v2/cards/archive-card?version=version-7', '/api/workspaces/tools-workspace/cards/owned-card/revisions/revision-9']);
  expect(session.api.headRevision('owned-card')).toBeUndefined();
  expect(extractCardData(session.cards.getState().currentCard!).description).toBe('Original facts');
});

it('holds a generated portrait outside the asset draft until review, then stages exact bytes without saving', async () => {
  const session = await editor();
  const bytes = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64'));
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1, height: 1, close() {} })));
  fetcher.mockImplementation(async (input) => {
    if (String(input).endsWith('/prompt')) return Response.json({ prompt_id: 'owned-job' });
    if (String(input).includes('/history/')) return Response.json({ 'owned-job': { status: { completed: true }, outputs: { '1': { images: [{ filename: 'portrait.png', subfolder: '', type: 'output' }] } } } });
    return new Response(bytes);
  });
  const result = await createLocalTools(session).workflow({ baseUrl: 'http://127.0.0.1:8188', workflow: JSON.stringify({ '1': { class_type: 'SaveImage', inputs: {} } }) });
  const proposal = await result.readImage(0);
  const card = session.cards.getState().currentCard!;
  expect(session.assets.hasChanges(card)).toBe(false);
  await proposal.apply();
  expect(session.assets.hasChanges(card)).toBe(true);
  const plan = await session.assets.prepare(card);
  expect(plan.uploads).toHaveLength(1);
  expect(new Uint8Array(await plan.uploads[0]!.arrayBuffer())).toEqual(bytes);
  expect(fetcher.mock.calls.every(([path]) => String(path).startsWith('http://127.0.0.1:8188/'))).toBe(true);
});

it('discards late model responses after a selection change even when its fetch adapter ignores cancellation', async () => {
  const session = await editor();
  let resolve!: (response: Response) => void, entered!: () => void;
  const started = new Promise<void>((done) => { entered = done; });
  fetcher.mockImplementation(() => { entered(); return new Promise<Response>((done) => { resolve = done; }); });
  const pending = createLocalTools(session).propose({ kind: 'names' }); await started;
  await session.open({ cardId: '' });
  resolve(Response.json({ choices: [{ message: { content: '["Stale name"]' } }] }));
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(extractCardData(session.cards.getState().currentCard!).name).toBe('New Character');
});
