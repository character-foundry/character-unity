import { expect } from 'vitest';
import type { ArchiveReferenceSummary, RevisionInput, UnityStore } from '../../src/index.js';

const input: RevisionInput = { authorId: 'alice', document: { spec: 'chara_card_v3', data: { name: 'Local' } },
  identity: { algorithm: 'archive-contract-fixture', hash: 'a'.repeat(64) } };
const pin = { archiveId: 'fixture-archive', cardId: '123', versionId: 'version-one' };
const summary: ArchiveReferenceSummary = { name: 'Archive', creator: 'Maker', description: 'Keeps old maps', tags: ['Fantasy'],
  source: 'chub', format: 'chara_card_v3', changedAt: '2026-10-10T00:00:00.000Z', portrait: true,
  tokensTotal: 500, flags: ['greetings', 'lorebook', 'gallery', 'expressions', 'systemPrompt', 'exampleDialogues', 'embeddedImages'],
  greetingCount: 8, lorebookEntryCount: 30, assetCount: 12, versionCount: 3, spec: 'chara_card_v3' };
const refInput = (workspaceId: string) => ({ workspaceId, pin: { ...pin }, summary: structuredClone(summary),
  fileHash: 'b'.repeat(64), identity: { ...input.identity }, favorite: true });
const idOf = (item: Awaited<ReturnType<UnityStore['listLibrarySummaries']>>['items'][number]) => 'reference' in item ? item.reference.id : item.card.id;

export async function archiveMembershipCases(store: UnityStore, workspaceId: string) {
  const draft = refInput(workspaceId), pending = store.addArchiveReference(draft);
  draft.pin.versionId = 'mutated'; draft.summary.name = 'mutated'; draft.summary.tags.push('mutated');
  const first = await pending;
  expect(first).toMatchObject({ pin, summary, favorite: true });
  const repeated = await Promise.all(Array.from({ length: 3 }, () => store.addArchiveReference(refInput(workspaceId))));
  expect(repeated.every((ref) => ref.id === first.id && ref.pin.versionId === pin.versionId)).toBe(true);
  expect(await store.listCards(workspaceId)).toEqual([]);
  expect(await store.listArchiveReferences(workspaceId)).toHaveLength(1);
  const distinct = await store.addArchiveReference({ ...refInput(workspaceId), pin: { ...pin, cardId: '456' } });
  expect(distinct.id).not.toBe(first.id);
  expect(await store.listArchiveReferences(workspaceId)).toHaveLength(2);
  expect(await store.archiveLinks(workspaceId, ['123', '456'])).toEqual({ '123': first.id, '456': distinct.id });
  await store.setArchiveReferenceFavorite(workspaceId, first.id, false);
  expect((await store.getArchiveReference(workspaceId, first.id)).favorite).toBe(false);
  expect(await store.listArchiveReferences(workspaceId)).toHaveLength(2);
  const other = await store.createWorkspace({ ownerId: 'bob', name: 'Other' });
  await expect(store.getArchiveReference(other.id, first.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(store.removeArchiveReference(other.id, first.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await store.removeArchiveReference(workspaceId, first.id);
  expect(await store.listArchiveReferences(workspaceId)).toEqual([distinct]);
  expect(await store.listCards(workspaceId)).toEqual([]);
  const next = await store.addArchiveReference({ ...refInput(workspaceId), pin: { ...pin, versionId: 'new-latest' },
    fileHash: 'd'.repeat(64), identity: { ...input.identity, hash: 'e'.repeat(64) } });
  expect(next.id).not.toBe(first.id); expect(next.pin.versionId).toBe('new-latest');
  const previousVersion = await store.addArchiveReference(refInput(workspaceId));
  expect(previousVersion.id).not.toBe(next.id);
  expect(await store.findArchiveReference(workspaceId, next.pin)).toEqual(next);
  expect(await store.findArchiveReference(workspaceId, previousVersion.pin)).toEqual(previousVersion);
  expect(await store.findArchiveReference(workspaceId, { ...pin, versionId: 'unreferenced' })).toBeNull();
  expect(await store.archiveMemberships(workspaceId, pin.archiveId, [{ cardId: pin.cardId, versionId: next.pin.versionId }])).toEqual({ [pin.cardId]: next });
  expect(await store.findImportMatch(workspaceId, { fileHash: next.fileHash! })).toEqual({ kind: 'reference', referenceId: next.id, match: 'file' });
}

export async function archiveForkCases(store: UnityStore, workspaceId: string) {
  const reference = await store.addArchiveReference(refInput(workspaceId));
  const assetInput = { workspaceId, pin, path: 'portrait', hash: 'c'.repeat(64), byteLength: 12, mediaType: 'image/png' };
  const assets = await Promise.all([store.registerArchiveAsset(assetInput), store.registerArchiveAsset(assetInput)]);
  expect(assets[0]).toEqual(assets[1]); expect(assets[0]!.state).toBe('ready');
  expect(await store.getArchiveAsset(workspaceId, assets[0]!.id)).toMatchObject({ pin, path: 'portrait' });
  await expect(store.registerArchiveAsset({ ...assetInput, hash: 'd'.repeat(64) })).rejects.toMatchObject({ code: 'INTEGRITY' });
  const original = await store.registerArchiveAsset({ ...assetInput, path: 'original', hash: 'b'.repeat(64), mediaType: 'application/json' });
  const fork = await store.createArchiveFork({ ...input, workspaceId, pin, referenceId: reference.id, originalHash: 'b'.repeat(64),
    source: { assetId: original.id, provenance: { kind: 'archive', filename: 'original.json', format: 'chara_card_v3', versionId: pin.versionId } },
    assets: [{ path: 'portrait', assetId: assets[0]!.id }] });
  expect(fork.revision).toMatchObject({ sequence: 1, parentRevisionId: null });
  expect(await store.getArchiveForkSource(workspaceId, fork.card.id)).toMatchObject({ pin, referenceId: reference.id, sourceProvider: 'chub' });
  expect(await store.getSource(workspaceId, fork.card.id)).toMatchObject({ assetId: original.id, provenance: { filename: 'original.json', versionId: pin.versionId } });
  await store.removeArchiveReference(workspaceId, reference.id);
  expect(await store.findImportMatch(workspaceId, { fileHash: original.hash })).toBeNull();
  expect(await store.getArchiveForkSource(workspaceId, fork.card.id)).toMatchObject({ pin });
  const saved = await store.saveRevision({ ...input, workspaceId, cardId: fork.card.id, expectedHead: fork.revision.id,
    assets: fork.revision.assets });
  expect((await store.getRevision(workspaceId, fork.revision.id)).assets).toEqual(saved.assets);
  const newer = await store.registerArchiveAsset({ ...assetInput, pin: { ...pin, versionId: 'version-two' } });
  expect(newer.id).not.toBe(assets[0]!.id);
  const foreign = await store.createWorkspace({ ownerId: 'bob', name: 'Foreign' });
  await expect(store.createArchiveFork({ ...input, workspaceId: foreign.id, pin, assets: fork.revision.assets })).rejects.toMatchObject({ code: 'ASSET_NOT_READY' });
  expect(await store.getArchiveAsset(foreign.id, assets[0]!.id)).toBeNull();
}

export async function importIdentityCases(store: UnityStore, workspaceId: string) {
  const results = await Promise.all(['b', 'c', 'd'].map((hash) => store.createImportedCard({ ...input, workspaceId, fileHash: hash.repeat(64) })));
  expect(results.filter((result) => result.created)).toHaveLength(1);
  const created = results.find((result) => result.created)!; if (!created.created) throw new Error('Missing import winner');
  expect(await store.listCards(workspaceId)).toHaveLength(1);
  expect(await store.findImportMatch(workspaceId, { fileHash: 'b'.repeat(64), identity: input.identity })).toMatchObject({ kind: 'card', cardId: created.card.id });
  const changed = { ...input, identity: { ...input.identity, hash: 'e'.repeat(64) } };
  await store.saveRevision({ ...changed, workspaceId, cardId: created.card.id, expectedHead: created.revision.id });
  expect(await store.findImportMatch(workspaceId, { identity: input.identity })).toBeNull();
  const again = await store.createImportedCard({ ...input, workspaceId, fileHash: 'f'.repeat(64) }); expect(again.created).toBe(true);
  const lineageHash = '1'.repeat(64), otherLineage = '2'.repeat(64);
  const lineaged = { ...input, document: { ...input.document, data: { name: 'Fork', extensions: { foundry: { lineage: { revisionHash: lineageHash } } } } } };
  const fork = await store.createImportedCard({ ...lineaged, workspaceId, fileHash: '3'.repeat(64), lineageHash, originalHash: 'b'.repeat(64) });
  expect(fork.created).toBe(true);
  const otherFork = await store.createImportedCard({ ...lineaged, document: { ...input.document, data: { name: 'Fork', extensions: { foundry: { lineage: { revisionHash: otherLineage } } } } },
    workspaceId, fileHash: '4'.repeat(64), lineageHash: otherLineage, originalHash: 'b'.repeat(64) });
  expect(otherFork.created).toBe(true);
  expect(await store.findImportMatch(workspaceId, { identity: input.identity, lineageHash })).toMatchObject({ kind: 'card', match: 'content' });
  const module = await store.stageAsset({ workspaceId, hash: '5'.repeat(64), byteLength: 1, mediaType: 'application/octet-stream' });
  await store.completeAsset({ workspaceId, assetId: module.id, measuredHash: module.hash, measuredByteLength: module.byteLength });
  const moduleCard = await store.createImportedCard({ ...input, workspaceId, fileHash: '6'.repeat(64), moduleHash: module.hash,
    assets: [{ path: 'module.risum', assetId: module.id }] });
  expect(moduleCard.created).toBe(true);
  expect(await store.findImportMatch(workspaceId, { identity: input.identity, moduleHash: module.hash })).toMatchObject({ kind: 'card', match: 'content' });
  expect(await store.findImportMatch(workspaceId, { identity: input.identity, moduleHash: '7'.repeat(64) })).toBeNull();
  const other = await store.createWorkspace({ ownerId: 'bob', name: 'Other' });
  expect(await store.findImportMatch(other.id, { fileHash: 'b'.repeat(64), identity: input.identity })).toBeNull();
  const ref = await store.addArchiveReference(refInput(workspaceId));
  expect(await store.findImportMatch(workspaceId, { fileHash: ref.fileHash!, identity: changed.identity })).toMatchObject({ match: 'file' });
  const onlyRefWorkspace = await store.createWorkspace({ ownerId: 'alice', name: 'Only Archive' });
  const onlyRef = await store.addArchiveReference(refInput(onlyRefWorkspace.id));
  expect(await store.createImportedCard({ ...input, workspaceId: onlyRefWorkspace.id, fileHash: '8'.repeat(64) })).toEqual({ created: false,
    existing: { kind: 'reference', referenceId: onlyRef.id, match: 'content' } });
}

export async function libraryReferenceCases(store: UnityStore, workspaceId: string) {
  const local = await store.createCard({ ...input, workspaceId, document: { spec: 'chara_card_v3', data: { name: 'Bravo', creator: 'Maker', tags: ['fantasy'] } } });
  const first = await store.addArchiveReference({ ...refInput(workspaceId), summary: { ...summary, name: 'Alpha' } });
  const second = await store.addArchiveReference({ ...refInput(workspaceId), pin: { ...pin, cardId: '456' },
    summary: { ...summary, name: 'Charlie', tags: ['Space'], tokensTotal: null }, favorite: false });
  expect((await store.listLibrarySummaries(workspaceId, { sort: 'name', limit: 1, offset: 1 })).items.map(idOf)).toEqual([local.card.id]);
  expect((await store.listLibrarySummaries(workspaceId, { sort: 'name', limit: 1, offset: 2 })).items.map(idOf)).toEqual([second.id]);
  expect((await store.listLibrarySummaries(workspaceId)).total).toBe(3);
  expect((await store.listLibrarySummaries(workspaceId, { q: 'creator:maker tag:fantasy', sort: 'name' })).items.map(idOf)).toEqual([first.id, local.card.id]);
  expect((await store.listLibrarySummaries(workspaceId, { favorite: 'fav' })).items.map(idOf)).toEqual([first.id]);
  expect((await store.listLibrarySummaries(workspaceId, { source: 'chub', minTokens: 300 })).items.map(idOf)).toEqual([first.id]);
  expect((await store.listLibrarySummaries(workspaceId, { has: ['lorebook', 'greetings', 'gallery', 'expressions', 'embeddedImages', 'systemPrompt', 'exampleDialogues', 'portrait'] })).total).toBe(2);
  expect((await store.listLibrarySummaries(workspaceId, { has: ['chat'] })).total).toBe(0);
  await store.followCreator(workspaceId, ' MAKER ', true);
  expect((await store.listLibrarySummaries(workspaceId, { has: ['followed'] })).total).toBe(3);
  expect((await store.listLibrarySummaries(workspaceId, { sort: 'greetings' })).items.map(idOf).slice(0, 2)).toEqual(expect.arrayContaining([first.id, second.id]));
  expect(await store.listCardTags(workspaceId)).toEqual([{ tag: 'fantasy', count: 2 }, { tag: 'Space', count: 1 }]);
  const fork = await store.createArchiveFork({ ...input, workspaceId, pin: first.pin, referenceId: first.id });
  expect((await store.listLibrarySummaries(workspaceId, { fork: 'only' })).items.map(idOf)).toEqual([fork.card.id]);
  expect((await store.listLibrarySummaries(workspaceId, { ids: [fork.card.id] })).items).toMatchObject([{ archiveSource: pin }]);
  expect((await store.listLibrarySummaries(workspaceId, { fork: 'none' })).total).toBe(3);
  expect((await store.listLibrarySummaries(workspaceId, { forkOf: first.id })).items.map(idOf)).toEqual([fork.card.id]);
  expect((await store.listLibrarySummaries(workspaceId, { ids: [first.id] })).items).toMatchObject([{ reference: { id: first.id }, forkCount: 1 }]);
  await store.removeArchiveReference(workspaceId, first.id);
  expect((await store.listLibrarySummaries(workspaceId, { source: 'chub' })).total).toBe(2);
  // Archive flags do not carry greeting/lorebook metadata. Explicit counts are
  // authoritative, including zero; totals drive sorting, alternates drive filtering.
  const countInputs = [
    { cardId: 'counted', greetingCount: 4, alternateGreetingCount: 2, lorebookEntryCount: 3, flags: [] },
    { cardId: 'first-only', greetingCount: 1, alternateGreetingCount: 0, lorebookEntryCount: 0, flags: [] },
    { cardId: 'group-only', greetingCount: 5, alternateGreetingCount: 0, lorebookEntryCount: 0, flags: [] },
    { cardId: 'stale-flags', greetingCount: 0, alternateGreetingCount: 0, lorebookEntryCount: 0, flags: ['greetings', 'lorebook', 'chat'] },
    { cardId: 'legacy-alternate-count', greetingCount: 2, lorebookEntryCount: 1, flags: [] },
  ];
  const counted = await Promise.all(countInputs.map(({ cardId, ...counts }) => store.addArchiveReference({ ...refInput(workspaceId),
    pin: { ...pin, cardId }, summary: { ...summary, ...counts } })));
  const countIds = counted.map((reference) => reference.id);
  expect((await store.listLibrarySummaries(workspaceId, { ids: countIds, has: ['greetings'] })).items.map(idOf).sort())
    .toEqual([counted[0]!.id, counted[4]!.id].sort());
  expect((await store.listLibrarySummaries(workspaceId, { ids: countIds, has: ['lorebook'] })).items.map(idOf).sort())
    .toEqual([counted[0]!.id, counted[4]!.id].sort());
  expect((await store.listLibrarySummaries(workspaceId, { ids: countIds, sort: 'greetings' })).items.map(idOf))
    .toEqual([counted[2]!.id, counted[0]!.id, counted[4]!.id, counted[1]!.id, counted[3]!.id]);
  const mixed = await store.createCard({ ...input, workspaceId, document: { spec: 'chara_card_v3', data: {
    name: 'Three greetings', first_mes: 'Hello', alternate_greetings: ['Hi'], group_only_greetings: ['Together'] } } });
  expect((await store.listLibrarySummaries(workspaceId, { ids: [...countIds, mixed.card.id], sort: 'greetings' })).items.map(idOf))
    .toEqual([counted[2]!.id, counted[0]!.id, mixed.card.id, counted[4]!.id, counted[1]!.id, counted[3]!.id]);
  expect((await store.listLibrarySummaries(workspaceId, { ids: countIds, has: ['chat'] })).total).toBe(0);
  await expect(store.addArchiveReference({ ...refInput(workspaceId), pin: { ...pin, cardId: 'invalid-count' },
    summary: { ...summary, alternateGreetingCount: -1 } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
}

export async function sharedAssetCases(store: UnityStore, workspaceId: string) {
  const input = { workspaceId, hash: '9'.repeat(64), byteLength: 5, mediaType: 'image/png' };
  const assets = await Promise.all(Array.from({ length: 3 }, () => store.stageSharedAsset(input)));
  expect(new Set(assets.map((asset) => asset.id)).size).toBe(1);
  expect(new Set(assets.map((asset) => asset.storageKey)).size).toBe(1);
  await store.completeAsset({ workspaceId, assetId: assets[0]!.id, measuredHash: input.hash, measuredByteLength: input.byteLength });
  expect(await store.stageSharedAsset(input)).toMatchObject({ id: assets[0]!.id, state: 'ready' });
  expect((await store.stageAsset(input)).id).not.toBe(assets[0]!.id);
  const other = await store.createWorkspace({ ownerId: 'bob', name: 'Other assets' });
  expect((await store.stageSharedAsset({ ...input, workspaceId: other.id })).id).not.toBe(assets[0]!.id);
}
export async function searchOutboxCases(store: UnityStore, workspaceId: string) {
  const reference = await store.addArchiveReference(refInput(workspaceId));
  await store.setArchiveReferenceFavorite(workspaceId, reference.id, false);
  expect(await store.listSearchJobs()).toEqual([]);
  const otherWorkspace = await store.createWorkspace({ ownerId: 'bob', name: 'Other search' });
  const card = await store.createCard({ ...input, workspaceId });
  let jobs = await store.listSearchJobs({ limit: 1 });
  expect(jobs).toEqual([{ workspaceId, cardId: card.card.id, revisionId: card.revision.id, operation: 'upsert', eventSequence: 1, error: null }]);
  expect(await store.listSearchJobs({ workspaceId: otherWorkspace.id })).toEqual([]);
  expect(await store.listSearchJobs({ workspaceId })).toEqual(jobs);
  expect(await store.ackSearchJob(workspaceId, card.card.id, 1)).toBe(true);
  expect(await store.listSearchJobs()).toEqual([]);
  const revision = await store.saveRevision({ ...input, workspaceId, cardId: card.card.id, expectedHead: card.revision.id });
  expect(await store.ackSearchJob(workspaceId, card.card.id, 1)).toBe(false);
  expect(await store.failSearchJob(workspaceId, card.card.id, 1, 'late failure')).toBe(false);
  expect(await store.failSearchJob(workspaceId, card.card.id, 2, 'Lance temporarily unavailable')).toBe(true);
  jobs = await store.listSearchJobs();
  expect(jobs).toEqual([{ workspaceId, cardId: card.card.id, revisionId: revision.id, operation: 'upsert', eventSequence: 2, error: 'Lance temporarily unavailable' }]);
  expect(await store.listSearchJobs({ includeFailed: false })).toEqual([]);
  const healthy = await store.createCard({ ...input, workspaceId: otherWorkspace.id });
  expect(await store.listSearchJobs({ includeFailed: false, limit: 1 })).toMatchObject([{ cardId: healthy.card.id }]);
  await store.ackSearchJob(otherWorkspace.id, healthy.card.id, 1);
  const newest = await store.saveRevision({ ...input, workspaceId, cardId: card.card.id, expectedHead: revision.id });
  expect(await store.ackSearchJob(workspaceId, card.card.id, 2)).toBe(false);
  expect(await store.listSearchJobs()).toEqual([{ workspaceId, cardId: card.card.id, revisionId: newest.id, operation: 'upsert', eventSequence: 3, error: null }]);
  await store.deleteCard(workspaceId, card.card.id);
  expect(await store.listSearchJobs()).toEqual([{ workspaceId, cardId: card.card.id, revisionId: newest.id, operation: 'delete', eventSequence: 4, error: null }]);
  expect(await store.ackSearchJob(workspaceId, card.card.id, 3)).toBe(false);
  expect(await store.ackSearchJob(workspaceId, card.card.id, 4)).toBe(true);
  expect(await store.listSearchJobs()).toEqual([]);
}
