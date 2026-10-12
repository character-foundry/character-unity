import { hashBytes } from '@character-foundry/character-foundry/identity';
import { StoreError } from '@character-unity/store';
import type { AssetService } from '@character-unity/assets';
import { CardError } from './types.js';

export async function saveRemoteBytes(assets: AssetService, workspaceId: string, bytes: Uint8Array, mediaType: string, signal: AbortSignal) {
    const staged = await assets.stage({ workspaceId, hash: await hashBytes(bytes), byteLength: bytes.length, mediaType });
    return assets.upload(workspaceId, staged.id, new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), signal);
  }
export async function readRemoteBytes(assets: AssetService, workspaceId: string, assetId: string, maximum: number, signal: AbortSignal) {
    signal.throwIfAborted();
    const value = await assets.download(workspaceId, assetId);
    if (value.byteLength > maximum) { await value.body.cancel(); throw new CardError('TOO_LARGE', 'Stored remote card exceeds its bundle limit'); }
    const stream = value.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    const abort = () => { void stream.cancel().catch(() => undefined); }; signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      while (true) {
        const next = await stream.read(); signal.throwIfAborted(); if (next.done) break;
        length += next.value.length;
        if (length > value.byteLength) throw new StoreError('INTEGRITY', 'Stored remote asset length changed');
        chunks.push(new Uint8Array(next.value));
      }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      if (length !== value.byteLength || await hashBytes(bytes) !== value.hash) throw new StoreError('INTEGRITY', 'Stored remote asset failed verification');
      signal.throwIfAborted(); return bytes;
    } finally { signal.removeEventListener('abort', abort); await stream.cancel().catch(() => undefined); stream.releaseLock(); }
  }
