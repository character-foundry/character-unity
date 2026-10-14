import { canonicalJson, sanitizeCardForPublish } from '@character-foundry/character-foundry/identity';
import type { CardIdentityOptions } from '@character-foundry/character-foundry/identity';
import type { RemoteEditSnapshot } from '@character-unity/chat-apps';
import type { CardDocument } from '@character-unity/store';
import { StoreError } from '@character-unity/store';
import { CardError } from './types.js';

const textFields = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator', 'creator_notes',
  'system_prompt', 'post_history_instructions', 'character_version'] as const;
const listFields = ['tags', 'alternate_greetings', 'group_only_greetings'] as const;
const supported = new Set<string>([...textFields, ...listFields]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const same = (one: unknown, two: unknown) => canonicalJson(one ?? null) === canonicalJson(two ?? null);
export interface ChatEditPin {
  cardId: string; remoteId: string; baseRevisionId: string; expectedHead: string; remoteHash: string;
  targetUrl: string; targetKind: string;
  targetConfiguration: number;
}
export interface ChatEditReview extends ChatEditPin {
  changes: { field: string; before: string | string[]; after: string | string[] }[];
  preserved: string[];
}

/** This is an explicit text-only merge, not recovery of an SDK transport. All
 * non-text source bytes remain bound to the fork; unhandled remote edits refuse. */
export function prepareChatEdit(base: CardDocument, current: CardDocument, snapshot: RemoteEditSnapshot, kind: string, identity: CardIdentityOptions) {
  const document = JSON.parse(canonicalJson(current)) as CardDocument;
  const baseFields = sanitizeCardForPublish(base).card.data;
  const fields = sanitizeCardForPublish({ spec: base.spec, spec_version: base.spec_version, data: snapshot.fields }).card.data;
  const unsupported = (field: string): never => { throw new CardError('UNSUPPORTED_FORMAT', `Remote ${field} changes cannot be imported losslessly by text sync. Export the complete card and review it manually.`); };
  const extensions = (input: unknown) => {
    const value = object(input) ? JSON.parse(canonicalJson(input)) as Record<string, unknown> : {};
    for (const key of Object.keys(value)) {
      if (kind === 'lumiverse' && ['_lumiverse_source_filename', '_lumiverse_library_scope', '_lumiverse_install_source', '_lumiverse_install_slug', '_lumiverse_chub_slug', '_lumiverse_chub_expressions_checked'].includes(key)
        || kind === 'marinara' && key === 'importMetadata') delete value[key];
    }
    return value;
  };
  if (kind === 'lumiverse' && object(fields.extensions)) {
    // Lumiverse's parseCardJson explicitly moves these card fields into
    // extensions. Only undo that known mapping when it cannot replace an
    // independently authored extension of the same name.
    // https://github.com/prolix-oc/Lumiverse/blob/main/src/services/character-card.service.ts
    for (const key of ['character_book', 'character_version']) {
      if (Object.hasOwn(baseFields, key) && !Object.hasOwn(object(baseFields.extensions) ? baseFields.extensions : {}, key)
        && Object.hasOwn(fields.extensions, key)) {
        fields[key] = fields.extensions[key]!;
        delete fields.extensions[key];
      }
    }
  }
  for (const [key, value] of Object.entries(fields)) {
    if (supported.has(key)) continue;
    if (key === 'extensions') {
      if (!same(extensions(value), extensions(baseFields.extensions))) unsupported('extensions or lineage');
    } else if (key === 'assets' && Array.isArray(value) && Array.isArray(baseFields.assets)) {
      // The send profile relocates aliases of the verified portrait to
      // ccdefault:. This never authorizes a new URI or different asset bytes.
      const baseAssets = baseFields.assets;
      const descriptors = value.map((descriptor, index) => {
        const original = baseAssets[index];
        if (object(descriptor) && object(original) && descriptor.uri === 'ccdefault:' && identity.portraitHash
          && identity.assets?.some((binding) => binding.pointer === `/assets/${index}/uri` && binding.hash === identity.portraitHash)) {
          return { ...descriptor, uri: original.uri };
        }
        return descriptor;
      });
      if (!same(descriptors, baseFields.assets)) unsupported(key);
    } else if (!same(value, baseFields[key])) unsupported(key);
  }
  if (snapshot.envelope) {
    for (const key of Object.keys(baseFields)) if (!supported.has(key) && !Object.hasOwn(fields, key)) unsupported(`missing ${key}`);
    for (const [key, value] of Object.entries(snapshot.envelope)) {
      if (key === 'data') continue;
      if (Object.hasOwn(base, key)) { if (!same(base[key], value)) unsupported(`envelope ${key}`); }
      else if (key === 'create_date') {
        if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) unsupported(key);
      } else if (key === 'fav') { if (value !== false) unsupported(key); }
      else if (key === 'talkativeness') { if (!same(value, object(fields.extensions) ? fields.extensions.talkativeness : undefined)) unsupported(key); }
      else if (!supported.has(key) || !same(value, fields[key])) unsupported(`envelope ${key}`);
    }
  }
  const currentFields = document.data;
  if (!object(currentFields)) throw new CardError('INVALID_INPUT', 'Expected a wrapped source document');
  const changes: ChatEditReview['changes'] = [];
  for (const field of supported) {
    // Field-based apps omit unsupported fields: omission never means deletion.
    if (!Object.hasOwn(fields, field)) {
      if (snapshot.envelope && Object.hasOwn(baseFields, field)) unsupported(`missing ${field}`);
      continue;
    }
    const after = fields[field], fallback = listFields.includes(field as typeof listFields[number]) ? [] : '';
    const before = currentFields[field] ?? fallback, original = baseFields[field] ?? fallback;
    if (typeof fallback === 'string' ? typeof after !== 'string' : !Array.isArray(after) || after.some((item) => typeof item !== 'string')) {
      throw new CardError('INVALID_INPUT', `Remote ${field} has an invalid value`);
    }
    if (same(after, original)) continue;
    if (!same(before, original) && !same(before, after)) throw new StoreError('HEAD_CONFLICT', `Both the library and chat app changed ${field}; merge that field manually before importing.`);
    if (!same(before, after)) { currentFields[field] = after!; changes.push({ field, before: before as string | string[], after: after as string | string[] }); }
  }
  return { document, changes, preserved: ['Original portrait and asset bytes', 'Lorebook and opaque source fields', 'Verified source lineage; remote lineage is never adopted'] };
}
