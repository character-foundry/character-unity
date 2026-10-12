import { createArchiveIndex } from './read-source.js';
import { createHash } from 'node:crypto';
import {
  ArchiveError, identifier, input, limits, parseCard,
} from '@character-unity/archive-client/contract';
import type { ArchiveCard, AssetBinding, OriginalObject } from '@character-unity/archive-client';

export interface FixtureCard {
  id: string;
  title: string;
  tags: string[];
  source: ArchiveCard['source'];
  original: { bytes: Uint8Array; mediaType: string };
  assets: { id: string; mediaType: string; bytes?: Uint8Array; binding?: AssetBinding }[];
}
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Owns copies of synthetic bytes. No filesystem/database/network/job capabilities. */
export function createFixtureArchive(archiveId: string, fixtures: readonly FixtureCard[]) {
  input(() => identifier(archiveId));
  if (fixtures.length > 1000) throw new ArchiveError('INVALID_INPUT', 'Fixture corpus exceeds 1000 cards');
  const originals = new Map<string, { bytes: Uint8Array; object: OriginalObject }>();
  const assets = new Map<string, { bytes: Uint8Array; object: OriginalObject }>();
  let totalBytes = 0;
  function capture(value: { bytes: Uint8Array; mediaType: string }, target: typeof originals): OriginalObject {
    totalBytes += value.bytes.byteLength;
    if (totalBytes > limits.objectBytes) throw new ArchiveError('INVALID_INPUT', 'Fixture corpus exceeds 32 MiB');
    const bytes = new Uint8Array(value.bytes);
    const object: OriginalObject = { algorithm: 'sha256', hash: digest(bytes), byteLength: bytes.length, mediaType: value.mediaType };
    const existing = target.get(object.hash);
    if (existing && existing.object.mediaType !== object.mediaType) throw new ArchiveError('INVALID_INPUT', 'Duplicate bytes must have one media type');
    target.set(object.hash, { bytes, object });
    return object;
  }
  const cards = fixtures.map((fixture) => input(() => parseCard({
    id: fixture.id, title: fixture.title, tags: fixture.tags, source: fixture.source,
    original: capture(fixture.original, originals),
    assets: fixture.assets.map((asset) => asset.bytes === undefined
      ? { id: asset.id, availability: 'unavailable', ...(asset.binding ? { binding: asset.binding } : {}) }
      : { id: asset.id, availability: 'available', object: capture({ bytes: asset.bytes, mediaType: asset.mediaType }, assets), ...(asset.binding ? { binding: asset.binding } : {}) }),
  }))).sort((a, b) => compare(a.id, b.id));
  return createArchiveIndex(archiveId, cards, 'fixture', (kind, objectHash, envelope) => {
    const value = (kind === 'originals' ? originals : assets).get(objectHash);
    if (!value) throw new ArchiveError('NOT_FOUND', 'Existing Archive object not found');
    return { ...envelope, bytes: new Uint8Array(value.bytes), object: { ...value.object } };
  });
}

export type FixtureArchive = ReturnType<typeof createFixtureArchive>;

/** Explicit demo mode; never discovers or reads legacy Archive paths. */
export function createDemoArchive() {
  const encoder = new TextEncoder();
  return createFixtureArchive('unity-demo', ['aster', 'birch', 'cinder'].map((id) => ({
    id, title: `${id[0]?.toUpperCase()}${id.slice(1)}`, tags: ['demo'],
    source: { provider: 'fixture', recordId: id, url: null },
    original: { mediaType: 'application/json', bytes: encoder.encode(JSON.stringify({
      spec: 'chara_card_v3', spec_version: '3.0', data: {
        name: id, description: 'Synthetic Unity development fixture.', personality: '', scenario: '',
        first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: ['demo'], creator: 'Character Unity', character_version: '1', extensions: {},
      },
    })) }, assets: [{ id: 'portrait', mediaType: 'image/png' }],
  })));
}
