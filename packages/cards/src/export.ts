import { base64Encode, fromString } from '@character-foundry/character-foundry/core';
import { embedIntoPNG, injectTextChunk, isPNG } from '@character-foundry/character-foundry/png';
import { writeCharX } from '@character-foundry/character-foundry/charx';
import type { CharxWriteAsset } from '@character-foundry/character-foundry/charx';
import type { CCv3Data } from '@character-foundry/character-foundry/schemas';
import { canonicalJson, computeCardContentIdentity, hashBytes, readCardLineage, prepareSillyTavernTransport, sanitizeCardForPublish } from '@character-foundry/character-foundry/identity';
import type { AssetService } from '@character-unity/assets';
import type { CardDocument, Revision, UnityStore } from '@character-unity/store';
import { StoreError } from '@character-unity/store';
import { prepareImport } from './import.js';
import { revisionIdentityOptions } from './revision-assets.js';
import { CardError, importByteLimit } from './types.js';
import type { ExportFormat } from './types.js';

/** Export is a read of one pinned revision. Only SDK primitives write containers. */
export async function exportRevision(store: UnityStore, assets: AssetService, revision: Revision, format: ExportFormat, signal?: AbortSignal) {
  if (!['json', 'png', 'charx', 'sillytavern-json', 'sillytavern-png'].includes(format)) throw new CardError('INVALID_INPUT', 'Choose JSON, PNG, CharX or a SillyTavern profile');
  const deadline = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
  deadline.throwIfAborted();
  const options = await revisionIdentityOptions(store, revision);
  const document = sanitizeCardForPublish(revision.document).card;
  if (canonicalJson(await computeCardContentIdentity(document, options)) !== canonicalJson(revision.identity)) throw new CardError('INVALID_LINEAGE', 'Stored content identity failed verification');
  const data = document.data as CardDocument;
  const declared = (data.assets ?? []) as CardDocument[];
  const resources = new Map<string, Uint8Array>();
  let total = 0;
  for (const reference of revision.assets) {
    deadline.throwIfAborted();
    const object = await assets.download(revision.workspaceId, reference.assetId);
    if (total + object.byteLength > importByteLimit) { await object.body.cancel(); throw new CardError('TOO_LARGE', 'Export assets exceed 32 MiB'); }
    const reader = object.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    deadline.addEventListener('abort', cancel, { once: true });
    try {
      deadline.throwIfAborted();
      while (true) {
        const next = await reader.read(); deadline.throwIfAborted();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > object.byteLength) throw new StoreError('INTEGRITY', 'Export asset length changed');
        chunks.push(new Uint8Array(next.value));
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      if (size !== object.byteLength || await hashBytes(bytes) !== object.hash) throw new StoreError('INTEGRITY', 'Export asset bytes failed verification');
      resources.set(reference.path, bytes); total += size;
    } finally { deadline.removeEventListener('abort', cancel); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
  let bytes: Uint8Array;
  let transport: Record<string, unknown> | undefined;
  if (format === 'json' || format === 'sillytavern-json') {
    if (resources.size) throw new CardError('EXPORT_LOSS', 'JSON cannot carry this revision’s asset bytes. Choose a container format.');
    if (format === 'sillytavern-json') transport = (await prepareSillyTavernTransport(document, options)).card as unknown as Record<string, unknown>;
    bytes = fromString(canonicalJson(transport ?? document));
  } else if (format === 'png' || format === 'sillytavern-png') {
    const portrait = resources.get('portrait');
    if (!portrait || !isPNG(portrait)) throw new CardError('EXPORT_LOSS', 'PNG requires an existing PNG portrait. Adding or converting a portrait needs an explicit edit.');
    if (format === 'sillytavern-png' && options.assets?.some((binding) => binding.hash !== options.portraitHash)) {
      throw new CardError('EXPORT_LOSS', 'SillyTavern PNG supports only a portrait and aliases of its exact bytes. Separate attachments are not preserved by that application.');
    }
    for (const [index, descriptor] of declared.entries()) {
      if (!resources.has(`declared/${index}`)) throw new CardError('ASSET_UNAVAILABLE', 'A declared export asset is unavailable');
      // URI relocation is identity-neutral only when bound to the same verified bytes.
      descriptor.uri = format === 'sillytavern-png' ? 'ccdefault:' : `pngchunk:${index}`;
    }
    if (format === 'sillytavern-png') transport = (await prepareSillyTavernTransport(document, options)).card as unknown as Record<string, unknown>;
    const transported = transport ?? document;
    bytes = embedIntoPNG(portrait, transported as unknown as CCv3Data, { key: document.spec === 'chara_card_v3' ? 'ccv3' : 'chara' });
    if (format === 'png') for (const [index] of declared.entries()) bytes = injectTextChunk(bytes, `chara-ext-asset_:${index}`, base64Encode(resources.get(`declared/${index}`)!));
  } else {
    if (document.spec !== 'chara_card_v3') throw new CardError('EXPORT_LOSS', 'CharX requires CCv3. Format conversion needs an explicit edit.');
    const inputs: CharxWriteAsset[] = declared.map((descriptor, index) => {
      const bytes = resources.get(`declared/${index}`);
      if (!bytes) throw new CardError('ASSET_UNAVAILABLE', 'A declared export asset is unavailable');
      if (typeof descriptor.name !== 'string' || typeof descriptor.type !== 'string' || typeof descriptor.ext !== 'string') throw new CardError('EXPORT_LOSS', 'CharX needs complete asset descriptors');
      return { name: descriptor.name, type: descriptor.type, ext: descriptor.ext, data: bytes };
    });
    // Preserve authored descriptor metadata; the SDK allocates distinct safe paths.
    // Re-import still verifies all output bytes, portrait identity and lineage.
    bytes = writeCharX(document as unknown as CCv3Data, inputs, { preserveDescriptors: true }).buffer;
  }
  deadline.throwIfAborted();
  if (bytes.byteLength > importByteLimit) throw new CardError('TOO_LARGE', 'Generated export exceeds 32 MiB');
  let restored: Awaited<ReturnType<typeof prepareImport>>;
  try { restored = await prepareImport(bytes); }
  catch { throw new CardError('EXPORT_LOSS', 'This format cannot preserve the revision’s content, assets and lineage. No export was produced.'); }
  if (canonicalJson(restored.identity) !== canonicalJson(revision.identity)
    || canonicalJson(readCardLineage(restored.document)) !== canonicalJson(readCardLineage(document))) {
    throw new CardError('EXPORT_LOSS', 'This format changes content or lineage. No export was produced.');
  }
  deadline.throwIfAborted();
  return { bytes, mediaType: restored.mediaType, filename: `character.${format.startsWith('sillytavern-') ? format.slice(12) : format}`, revisionId: revision.id, hash: await hashBytes(bytes),
    /** The card as embedded by a SillyTavern profile, for apps that take fields instead of files. */
    ...(transport ? { transport } : {}) };
}
