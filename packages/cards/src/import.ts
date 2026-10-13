import { parseCard } from '@character-foundry/character-foundry/loader';
import { parseURI, getMimeTypeFromExt } from '@character-foundry/character-foundry/core';
import { canonicalJson, computeCardContentIdentity, hashBytes, readCardLineage, restoreSillyTavernTransport, verifyCardLineage } from '@character-foundry/character-foundry/identity';
import type { AssetDigestBinding, CardEnvelope } from '@character-foundry/character-foundry/identity';
import { documentByteLimit } from '@character-unity/store/validation';
import { CardError, declaredAssetLimit, importByteLimit, risuModulePath } from './types.js';
import type { ImportAsset } from './types.js';

/** Container parsing, URI interpretation and identity all come from the external SDK. */
export async function prepareImport(input: Uint8Array, supplied: readonly ImportAsset[] = []) {
  if (input.byteLength > importByteLimit) throw new CardError('TOO_LARGE', `Card import exceeds ${importByteLimit / 1024 / 1024} MiB`);
  const bytes = new Uint8Array(input);
  if (supplied.length > 64 || supplied.reduce((size, asset) => size + asset.bytes.byteLength, 0) > importByteLimit) {
    throw new CardError('TOO_LARGE', 'Supplied assets exceed import limits');
  }
  const external = supplied.map((asset) => ({ ...asset, binding: { ...asset.binding }, bytes: new Uint8Array(asset.bytes) }));
  const keys = external.map((asset) => asset.binding.kind === 'portrait' ? 'portrait' : `uri:${asset.binding.uri}`);
  if (new Set(keys).size !== keys.length) throw new CardError('INVALID_INPUT', 'Duplicate source asset bindings');
  const parsed = parseCard(bytes, { maxFileSize: importByteLimit, maxAssetSize: importByteLimit, maxTotalSize: importByteLimit, extractAssets: true });
  // Foundry reads RisuAI's module.risum as an opaque blob; it is kept below and written back on CharX export.
  if (!['json', 'png', 'charx'].includes(parsed.containerFormat)) {
    throw new CardError('UNSUPPORTED_FORMAT', 'This container needs a loss-preserving import adapter before editing');
  }
  // Retain the original opaque document. The SDK identity function checks its wrapped format.
  let document = JSON.parse(canonicalJson(parsed.originalShape)) as CardEnvelope;
  if (new TextEncoder().encode(JSON.stringify(document)).byteLength > documentByteLimit) throw new CardError('TOO_LARGE', `Card document exceeds ${documentByteLimit / 1024 / 1024} MiB`);
  // Validate the basic wrapper before examining asset descriptors.
  if (!document || typeof document.data !== 'object' || !document.data || Array.isArray(document.data)) {
    throw new CardError('UNSUPPORTED_FORMAT', 'The editor currently requires wrapped CCv2 or CCv3 data');
  }
  const declared = document.data.assets ?? [];
  if (!Array.isArray(declared) || declared.length > declaredAssetLimit) throw new CardError('TOO_LARGE', `A card can use at most ${declaredAssetLimit} declared assets plus its portrait`);
  const portrait = parsed.assets.find((asset) => asset.isMain && asset.type === 'icon');
  const externalPortrait = external.find((asset) => asset.binding.kind === 'portrait');
  const resources: { path: string; bytes: Uint8Array; hash: string; mediaType: string }[] = [];
  const bindings: AssetDigestBinding[] = [];
  const used = new Set<unknown>();
  async function resolve(embedded: typeof portrait, provided: ImportAsset | undefined) {
    if (embedded && provided && await hashBytes(embedded.data) !== await hashBytes(provided.bytes)) throw new CardError('INVALID_INPUT', 'Source asset binding conflicts with embedded bytes');
    if (embedded) used.add(embedded);
    if (provided) used.add(provided);
    return embedded ? { bytes: embedded.data, mediaType: getMimeTypeFromExt(embedded.ext) } : provided;
  }
  for (const [index, raw] of declared.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.uri !== 'string') throw new CardError('INVALID_INPUT', 'Asset descriptor requires a URI');
    const uri = parseURI(raw.uri);
    const embedded = uri.scheme === 'ccdefault' ? portrait : parsed.assets.find((candidate) => candidate.path !== undefined
      && (candidate.path === uri.path || candidate.path === uri.normalizedUri));
    const provided = uri.scheme === 'ccdefault' ? externalPortrait : external.find((asset) => asset.binding.kind === 'uri' && asset.binding.uri === raw.uri);
    const asset = await resolve(embedded, provided);
    if (!asset) throw new CardError('ASSET_UNAVAILABLE', `Asset ${index + 1} has no existing bytes in this import`);
    const hash = await hashBytes(asset.bytes);
    resources.push({ path: `declared/${index}`, bytes: new Uint8Array(asset.bytes), hash, mediaType: asset.mediaType });
    bindings.push({ pointer: `/assets/${index}/uri`, hash });
  }
  let portraitHash: string | undefined;
  const resolvedPortrait = await resolve(portrait, externalPortrait);
  if (resolvedPortrait) {
    portraitHash = await hashBytes(resolvedPortrait.bytes);
    resources.push({ path: 'portrait', bytes: new Uint8Array(resolvedPortrait.bytes), hash: portraitHash, mediaType: resolvedPortrait.mediaType });
  }
  const module = parsed.metadata?.moduleRisum;
  if (module) resources.push({ path: risuModulePath, bytes: new Uint8Array(module), hash: await hashBytes(module), mediaType: 'application/octet-stream' });
  if (parsed.assets.some((asset) => !used.has(asset))) throw new CardError('UNSUPPORTED_FORMAT', 'Import contains assets that need an explicit portable binding');
  if (external.some((asset) => !used.has(asset))) throw new CardError('INVALID_INPUT', 'Supplied asset binding is not used by this card');
  const options = { assets: bindings, ...(portraitHash ? { portraitHash } : {}) };
  const transported = await restoreSillyTavernTransport(document, options);
  if (transported) document = transported.card;
  const identity = await computeCardContentIdentity(document, options);
  const lineage = readCardLineage(document);
  if (lineage && !await verifyCardLineage(document, options)) throw new CardError('INVALID_LINEAGE', 'Imported lineage does not match its content or assets');
  return { bytes, document, identity, resources, acceptedHash: await hashBytes(bytes), rootHash: lineage?.originalHash,
    mediaType: parsed.containerFormat === 'png' ? 'image/png' : parsed.containerFormat === 'charx' ? 'application/zip' : 'application/json',
    format: parsed.sourceFormat };
}
