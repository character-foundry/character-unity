import type { AssetDigestBinding, CardIdentityOptions } from '@character-foundry/character-foundry/identity';
import type { Revision, UnityStore } from '@character-unity/store';
import { CardError, risuModulePath } from './types.js';

export async function revisionIdentityOptions(store: UnityStore, revision: Revision): Promise<CardIdentityOptions> {
  const bindings: AssetDigestBinding[] = [];
  let portraitHash: string | undefined;
  for (const reference of revision.assets) {
    const asset = await store.getAsset(revision.workspaceId, reference.assetId);
    if (asset.state !== 'ready') throw new CardError('ASSET_UNAVAILABLE', 'Revision asset is unavailable');
    if (reference.path === risuModulePath) continue; // opaque RisuAI module: not card content
    if (reference.path === 'portrait') portraitHash = asset.hash;
    else if (/^declared\/(0|[1-9][0-9]*)$/.test(reference.path)) bindings.push({ pointer: `/assets/${reference.path.slice(9)}/uri`, hash: asset.hash });
    else throw new CardError('UNSUPPORTED_FORMAT', 'Revision asset needs a portable binding');
  }
  return { assets: bindings, ...(portraitHash ? { portraitHash } : {}) };
}
