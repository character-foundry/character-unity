import type { CardSummary, OpenedCard, RevisionAssets } from './unity';
import { assetUrl, portraitUrl } from './unity';
import type { CardDetail, CardListItem, CardTag, CharacterBook, CharacterCard, SourceFormat, TokenBreakdown } from '../types/card';

const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const text = (value: unknown) => typeof value === 'string' ? value : '';
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const boolean = (value: unknown) => typeof value === 'boolean' ? value : undefined;
const tagsOf = (values: readonly string[]): CardTag[] => [...new Map(values.filter((value) => value.trim()).map((name) => [name.toLowerCase(), name])).values()]
  .map((name) => ({ id: name.toLowerCase(), name, slug: name.toLowerCase(), category: null }));

/** Known fields are narrowed for rendering, while the untouched document is retained separately. */
export function displayDocument(document: unknown): CharacterCard {
  const root = record(document), data = record(root.data), book = record(data.character_book);
  const characterBook: CharacterBook | null = data.character_book !== null && typeof data.character_book === 'object' && !Array.isArray(data.character_book)
    ? {
      name: text(book.name), description: text(book.description), scan_depth: finite(book.scan_depth), token_budget: finite(book.token_budget), recursive_scanning: boolean(book.recursive_scanning),
      entries: (Array.isArray(book.entries) ? book.entries : []).filter((entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry)).map((entry) => {
        const value = record(entry);
        return { keys: strings(value.keys), secondary_keys: strings(value.secondary_keys), content: text(value.content), name: text(value.name), comment: text(value.comment),
          enabled: boolean(value.enabled), constant: boolean(value.constant), selective: boolean(value.selective), insertion_order: finite(value.insertion_order) };
      }),
    } : null;
  return { spec: text(root.spec), spec_version: text(root.spec_version), data: {
    name: text(data.name), description: text(data.description), personality: text(data.personality), scenario: text(data.scenario), first_mes: text(data.first_mes), mes_example: text(data.mes_example),
    creator_notes: text(data.creator_notes), system_prompt: text(data.system_prompt), post_history_instructions: text(data.post_history_instructions),
    alternate_greetings: strings(data.alternate_greetings), group_only_greetings: strings(data.group_only_greetings), tags: strings(data.tags), creator: text(data.creator), character_version: text(data.character_version),
    character_book: characterBook, extensions: record(data.extensions),
    assets: (Array.isArray(data.assets) ? data.assets : []).map((asset) => {
      const value = record(asset);
      return { type: text(value.type), uri: text(value.uri), name: text(value.name), ext: text(value.ext) };
    }),
  } };
}

export function toListItem(workspace: string, summary: CardSummary): CardListItem {
  const image = summary.hasPortrait ? portraitUrl(workspace, summary.id, summary.headRevisionId) : null;
  return {
    id: summary.id, slug: summary.id, name: summary.name, description: null,
    creator: summary.creator.trim() || 'Anonymous', creatorNotes: summary.creatorNotes || null,
    specVersion: summary.spec, sourceFormat: summary.sourceFormat,
    hasAssets: summary.assetsCount > 0, assetsCount: summary.assetsCount,
    imagePath: image, thumbnailPath: image, tokensTotal: summary.tokensTotal, isFavorited: summary.favorite, forksCount: summary.forkCount,
    hasAlternateGreetings: summary.greetingsCount > 1, alternateGreetingsCount: Math.max(0, summary.greetingsCount - 1), totalGreetingsCount: summary.greetingsCount,
    hasLorebook: summary.lorebookEntriesCount > 0, lorebookEntriesCount: summary.lorebookEntriesCount,
    hasEmbeddedImages: false, embeddedImagesCount: 0,
    tags: tagsOf(summary.tags), createdAt: seconds(summary.createdAt), updatedAt: seconds(summary.updatedAt),
    headRevisionId: summary.headRevisionId, revisionCount: summary.revisionCount, isFork: summary.forkedFromRevisionId !== null || Boolean(summary.archiveSource),
    ...(summary.reference ? { reference: summary.reference } : {}),
    ...(summary.archiveSource ? { archiveSource: summary.archiveSource } : {}),
  };
}

function sourceFormat(format: unknown, mediaType?: string): SourceFormat | null {
  if (mediaType === 'image/png') return 'png';
  if (mediaType === 'application/json') return 'json';
  if (mediaType === 'application/zip') return 'charx';
  const container = text(format).toLowerCase().split('_')[0];
  return container === 'png' || container === 'json' || container === 'charx' || container === 'voxta' ? container : null;
}

export function toDetail(workspace: string, opened: OpenedCard, tokens: TokenBreakdown | null, metadata: RevisionAssets | null = null): CardDetail {
  const cardData = displayDocument(opened.revision.document), data = cardData.data;
  const portrait = opened.revision.assets.some((asset) => asset.path === 'portrait') ? portraitUrl(workspace, opened.card.id, opened.revision.id) : null;
  // Metadata from a different revision must never attach to this view.
  const known = new Map(metadata?.revisionId === opened.revision.id ? metadata.assets.map((asset) => [asset.path, asset]) : []);
  const savedAssets = opened.revision.assets.filter((asset) => asset.path !== 'portrait').map((asset) => {
    const match = /^declared\/(0|[1-9]\d*)$/.exec(asset.path);
    const descriptor = match ? data.assets[Number(match[1])] : undefined, info = known.get(asset.path);
    return { binding: asset.path, name: descriptor?.name || asset.path, type: descriptor?.type || 'file', ext: descriptor?.ext || '',
      path: assetUrl(workspace, opened.card.id, opened.revision.id, asset.path), mediaType: info?.mediaType ?? null, byteLength: info?.byteLength ?? null };
  });
  const alternates = data.alternate_greetings.length, entries = data.character_book?.entries.length ?? 0;
  return {
    id: opened.card.id, slug: opened.card.id, name: data.name || 'Untitled', description: data.description || null,
    creator: data.creator.trim() || 'Anonymous', creatorNotes: data.creator_notes || null,
    specVersion: cardData.spec === 'chara_card_v3' ? 'v3' : cardData.spec === 'chara_card_v2' ? 'v2' : 'unknown',
    sourceFormat: opened.source?.provenance.kind === 'new' ? null : sourceFormat(opened.source?.provenance.format, opened.source?.mediaType), hasAssets: savedAssets.length > 0, assetsCount: savedAssets.length, imagePath: portrait, thumbnailPath: portrait,
    tokensTotal: tokens?.total ?? null, forksCount: null, isFavorited: opened.favorite,
    hasAlternateGreetings: alternates > 0, alternateGreetingsCount: alternates,
    totalGreetingsCount: (data.first_mes.trim() ? 1 : 0) + alternates + data.group_only_greetings.length,
    hasLorebook: entries > 0, lorebookEntriesCount: entries, hasEmbeddedImages: false, embeddedImagesCount: 0,
    tags: tagsOf(data.tags), createdAt: seconds(opened.card.createdAt), updatedAt: seconds(opened.revision.createdAt),
    headRevisionId: opened.revision.id, revisionCount: opened.revision.sequence, isFork: opened.card.forkedFromRevisionId !== null || Boolean(opened.archiveSource),
    tokens, cardData, rawDocument: opened.revision.document, savedAssets,
    ...(opened.reference ? { reference: opened.reference } : {}),
    ...(opened.archiveSource ? { archiveSource: opened.archiveSource } : {}),
    originalFilename: opened.source && opened.source.provenance.kind !== 'new' ? text(opened.source.provenance.filename) || `original.${sourceFormat(opened.source.provenance.format, opened.source.mediaType) ?? 'bin'}`
      : opened.archiveSource ? 'archived-original.bin' : null,
  };
}
