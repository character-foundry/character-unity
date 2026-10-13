import { describe, expect, it } from 'vitest';
import { displayDocument, toDetail, toListItem } from './adapt';
import type { CardSummary, OpenedCard, RevisionAssets } from './unity';

const opened = (document: OpenedCard['revision']['document']): OpenedCard => ({
  card: { id: 'card/one', headRevisionId: 'head', originalHash: 'original', forkedFromRevisionId: null, createdAt: '2026-10-01T00:00:00.000Z' },
  revision: { id: 'saved revision', sequence: 3, document, createdAt: '2026-10-02T00:00:00.000Z', assets: [
    { path: 'portrait', assetId: 'portrait' }, { path: 'declared/0', assetId: 'image' }, { path: 'module.risum', assetId: 'module' },
  ] },
  source: { provenance: { kind: 'file', format: 'ccv3', filename: 'accepted.png' }, mediaType: 'image/png' },
  favorite: true,
});
const document = {
  spec: 'chara_card_v3', spec_version: '3.0',
  data: { name: 'Native card', description: 'Description', first_mes: 'Hello', alternate_greetings: ['Hi'], group_only_greetings: ['Group hello'],
    tags: ['Nature', 'nature', '', 'Other'], creator: 'Creator',
    assets: [{ name: 'Background', type: 'background', ext: 'html', uri: 'https://untrusted.invalid/stale.png' }],
    extensions: { future: { untouched: [1, 2, 3] } }, future_field: { opaque: true },
    character_book: { entries: [{ name: 'Forest', keys: ['tree'], content: 'Green' }] } },
};

describe('native viewer projection', () => {
  it('uses exact revision URLs for portrait and stored assets, never descriptors', () => {
    const metadata: RevisionAssets = { revisionId: 'saved revision', assets: [
      { path: 'declared/0', hash: 'image', byteLength: 17, mediaType: 'image/png' },
      { path: 'module.risum', hash: 'module', byteLength: 11, mediaType: 'application/octet-stream' },
    ] };
    const detail = toDetail('workspace/one', opened(document), null, metadata);
    expect(detail.imagePath).toContain('workspace%2Fone/cards/card%2Fone/asset?');
    expect(detail.imagePath).toContain('revisionId=saved+revision');
    expect(detail.savedAssets).toHaveLength(2);
    expect(detail.savedAssets[0]).toMatchObject({ binding: 'declared/0', name: 'Background', mediaType: 'image/png', byteLength: 17 });
    expect(detail.savedAssets[0]!.path).toContain('path=declared%2F0');
    expect(detail.savedAssets[0]!.path).not.toContain('untrusted');
    expect(detail.savedAssets[1]!.path).toContain('path=module.risum');
  });

  it('retains opaque original data, actual accepted format and native favorite without invented stats', () => {
    const before = structuredClone(document), detail = toDetail('workspace', opened(document), null);
    expect(detail.rawDocument).toBe(document);
    expect(document).toEqual(before);
    expect(detail.cardData.data.extensions).toEqual(document.data.extensions);
    expect(detail).toMatchObject({ sourceFormat: 'png', originalFilename: 'accepted.png', isFavorited: true, totalGreetingsCount: 3,
      tokens: null, tokensTotal: null, forksCount: null, assetsCount: 2 });
    expect(detail).not.toHaveProperty('score');
    expect(detail).not.toHaveProperty('downloadsCount');
    expect(detail.tags.map((tag) => tag.id)).toEqual(['nature', 'other']);
  });

  it('preserves a pinned Archive reference through viewer projection without treating it as an owned revision', () => {
    const source = opened(document);
    source.reference = { archiveId: 'archive', cardId: 'source', versionId: 'exact-version' };
    source.revision.id = 'exact-version';
    const detail = toDetail('workspace', source, null);
    expect(detail.reference).toEqual(source.reference);
    expect(detail.imagePath).toContain('revisionId=exact-version');
    expect(detail.isFork).toBe(false);
    expect(detail.rawDocument).toBe(document);
    delete source.reference;
    source.source = null;
    source.archiveSource = { archiveId: 'archive', cardId: 'source', versionId: 'exact-version' };
    const fork = toDetail('workspace', source, null);
    expect(fork.reference).toBeUndefined();
    expect(fork.archiveSource).toEqual(source.archiveSource);
    expect(fork.isFork).toBe(true);
    expect(fork.originalFilename).toBe('archived-original.bin');
  });

  it('does not reuse metadata from a different revision or call unknown accepted bytes JSON', () => {
    const current = opened(document);
    current.source = { provenance: { format: 'ccv3' } };
    const detail = toDetail('workspace', current, null, { revisionId: 'old', assets: [{ path: 'declared/0', hash: 'stale', byteLength: 17, mediaType: 'image/png' }] });
    expect(detail.sourceFormat).toBeNull();
    expect(detail.originalFilename).toBe('original.bin');
    expect(detail.savedAssets[0]!.mediaType).toBeNull();
    current.source = { provenance: { kind: 'new', format: 'json' }, mediaType: 'application/json' };
    expect(toDetail('workspace', current, null)).toMatchObject({ sourceFormat: null, originalFilename: null });
  });

  it('narrows malformed fields and nested lorebook shapes without mutating their opaque document', () => {
    const malformed = { spec: 3, data: { name: { invalid: true }, description: [], first_mes: null, alternate_greetings: ['Hi', {}, null],
      tags: [4, 'Fine'], assets: [null, {}, { name: 7, uri: {} }], extensions: [1, 2],
      character_book: { name: {}, scan_depth: {}, token_budget: Infinity, recursive_scanning: 'yes',
        entries: [null, [], 4, { name: {}, content: {}, keys: [4, 'key'], enabled: 'yes' }] } } };
    const before = structuredClone(malformed), view = displayDocument(malformed);
    expect(view.data).toMatchObject({ name: '', description: '', first_mes: '', alternate_greetings: ['Hi'], tags: ['Fine'], extensions: {} });
    expect(view.data.character_book).toMatchObject({ name: '', entries: [{ name: '', content: '', keys: ['key'], enabled: undefined }] });
    expect(view.data.character_book?.scan_depth).toBeUndefined();
    expect(view.data.character_book?.token_budget).toBeUndefined();
    expect(displayDocument(null).data.character_book).toBeNull();
    expect(malformed).toEqual(before);
  });

  it('keeps accurate summary metadata and unknown container format without social placeholders', () => {
    const summary: CardSummary = { id: 'one', headRevisionId: 'head', name: 'Summary', creator: ' Creator ', creatorNotes: '', spec: 'v3', sourceFormat: null,
      hasPortrait: false, assetsCount: 1, greetingsCount: 2, lorebookEntriesCount: 3, tags: [], tokensTotal: null, favorite: false, source: 'file',
      revisionCount: 2, forkCount: 4, forkedFromRevisionId: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' };
    expect(toListItem('workspace', summary)).toMatchObject({ creator: 'Creator', sourceFormat: null, tokensTotal: null, forksCount: 4, assetsCount: 1 });
    expect(toListItem('workspace', summary)).not.toHaveProperty('favoritesCount');
  });
});
