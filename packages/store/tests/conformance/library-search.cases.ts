import { expect } from 'vitest';
import type { CardDocument, CardSummaryQuery, LibrarySort, RevisionInput, UnityStore } from '../../src/index.js';

// Shared by the SQL conformance suite (SQLite, D1) and the IndexedDB store so every driver means the same thing.
const identity = { algorithm: 'test-fixture-v1', hash: 'a'.repeat(64) };
const card = (data: CardDocument['data']): CardDocument => ({ spec: 'chara_card_v3', data });

export async function librarySearchCases(store: UnityStore, workspaceId: string) {
  const input = (document: CardDocument): RevisionInput & { workspaceId: string } => ({ authorId: 'alice', workspaceId, document, identity });
  const ember = await store.createCard(input(card({ name: 'Ember Knight', creator: 'Ash', description: 'A vampire knight in a modern city.',
    tags: ['Fantasy', 'NSFW', 'female'], first_mes: 'Hello.', alternate_greetings: ['Hi.', 'Hey.'], character_book: { entries: [{}, {}, {}] } })));
  const wolf = await store.createCard(input(card({ name: 'Wolfgang', creator: 'Birch', description: 'A werewolf detective.',
    tags: ['fantasy', 'male'], first_mes: '  ', personality: 'gruff "old" soul' })));
  const zed = await store.createCard(input(card({ name: 'zed_unit', creator: 'Ash', scenario: 'Space station.', tags: ['SciFi', 'robot'], first_mes: 'Beep.' })));
  const fork = await store.forkCard({ ...input(card({ name: 'Ember Knight (fork)', creator: 'Me', tags: ['fantasy', 'female'] })),
    sourceWorkspaceId: workspaceId, sourceRevisionId: ember.revision.id });
  const ids = async (query: CardSummaryQuery) => (await store.listCardSummaries(workspaceId, query)).items.map((item) => item.card.id).sort();
  const sorted = (...values: string[]) => [...values].sort();

  // Plain words are all required and search every text field, case-insensitively.
  expect(await ids({ q: 'KNIGHT vampire' })).toEqual([ember.card.id]);
  expect(await ids({ q: 'station' })).toEqual([zed.card.id]);
  expect(await ids({ q: 'robot' })).toEqual([zed.card.id]);
  expect(await ids({ q: '"old" soul' })).toEqual([wolf.card.id]);
  expect(await ids({ q: '"modern city"' })).toEqual([ember.card.id]);
  expect(await ids({ q: '"city modern"' })).toEqual([]);
  // Boolean operators, negation and grouping.
  expect(await ids({ q: 'vampire OR werewolf' })).toEqual(sorted(ember.card.id, wolf.card.id));
  expect(await ids({ q: '(vampire OR werewolf) detective' })).toEqual([wolf.card.id]);
  expect(await ids({ q: 'ember -fork' })).toEqual([ember.card.id]);
  expect(await ids({ q: 'ember NOT fork' })).toEqual([ember.card.id]);
  expect(await ids({ q: '-(ember OR wolf)' })).toEqual([zed.card.id]);
  // Field filters; tag: is exact.
  expect(await ids({ q: 'creator:ash' })).toEqual(sorted(ember.card.id, zed.card.id));
  expect(await ids({ q: 'author:ash name:zed' })).toEqual([zed.card.id]);
  expect(await ids({ q: 'tag:nsfw' })).toEqual([ember.card.id]);
  expect(await ids({ q: 'tag:nsf' })).toEqual([]);
  expect(await ids({ q: 'description:"werewolf detective"' })).toEqual([wolf.card.id]);
  // Literal characters are never patterns; malformed input is tolerated.
  expect(await ids({ q: '_' })).toEqual([zed.card.id]);
  expect(await ids({ q: '%' })).toEqual([]);
  expect(await ids({ q: '((ember' })).toEqual(sorted(ember.card.id, fork.card.id));
  expect(await ids({ q: 'OR ) AND' })).toHaveLength(4);
  await expect(store.listCardSummaries(workspaceId, { q: Array.from({ length: 33 }, (_, index) => `w${index}`).join(' ') })).rejects.toMatchObject({ code: 'INVALID_INPUT' });

  // Include all / any, exclude, and the legacy single tag.
  expect(await ids({ tags: ['FANTASY', 'female'] })).toEqual(sorted(ember.card.id, fork.card.id));
  expect(await ids({ tags: ['male', 'robot'], tagMode: 'any' })).toEqual(sorted(wolf.card.id, zed.card.id));
  expect(await ids({ tags: ['fantasy'], excludeTags: ['nsfw'] })).toEqual(sorted(wolf.card.id, fork.card.id));
  expect(await ids({ excludeTags: ['NSFW', 'robot'] })).toEqual(sorted(wolf.card.id, fork.card.id));
  expect(await ids({ tag: 'scifi' })).toEqual([zed.card.id]);
  // Content flags and forks.
  expect(await ids({ has: ['lorebook'] })).toEqual([ember.card.id]);
  expect(await ids({ has: ['greetings'] })).toEqual([ember.card.id]);
  expect(await ids({ fork: 'only' })).toEqual([fork.card.id]);
  expect(await ids({ fork: 'none', q: 'ember' })).toEqual([ember.card.id]);

  // Sorts.
  const order = async (sort: LibrarySort) => (await store.listCardSummaries(workspaceId, { sort })).items.map((item) => item.card.id);
  expect(await order('name')).toEqual([ember.card.id, fork.card.id, wolf.card.id, zed.card.id]);
  expect(await order('name_desc')).toEqual([zed.card.id, wolf.card.id, fork.card.id, ember.card.id]);
  expect((await order('greetings'))[0]).toBe(ember.card.id);
  // Whitespace-only first messages do not count; ties fall back to recency, which may share a millisecond here.
  expect((await order('greetings')).slice(0, 2)).toEqual([ember.card.id, zed.card.id]);
  expect((await order('lorebook'))[0]).toBe(ember.card.id);
  expect((await order('forks'))[0]).toBe(ember.card.id);
  const page = await store.listCardSummaries(workspaceId, { sort: 'name', q: 'creator:ash OR creator:birch', limit: 1, offset: 1 });
  expect(page.total).toBe(3);
  expect(page.items.map((item) => item.card.id)).toEqual([wolf.card.id]);

  // Tag counts are case-insensitive and count cards, not occurrences.
  const tags = await store.listCardTags(workspaceId);
  expect(tags[0]).toEqual({ tag: 'fantasy', count: 3 });
  expect(tags.find((entry) => entry.tag.toLowerCase() === 'female')).toEqual({ tag: 'female', count: 2 });
  expect(tags.map((entry) => entry.tag.toLowerCase()).sort()).toEqual(['fantasy', 'female', 'male', 'nsfw', 'robot', 'scifi']);
  expect(await store.listCardTags(workspaceId, { limit: 2 })).toHaveLength(2);
}
