import { Hono } from 'hono';
import type { UnityStore } from '@character-unity/store';
import { StoreError } from '@character-unity/store';
import { CardError } from '@character-unity/cards/contract';
import type { CardService } from '@character-unity/cards';
import type { ArchiveImportService } from '@character-unity/cards/archive';
import { ArchiveError } from '@character-unity/archive-client/contract';
import { cardRoutes } from './cards.js';
import type { Authenticate } from './cards.js';
import { hubRoutes } from './hub.js';
import type { HubService } from '@character-unity/cards/hub';
import type { RemoteConnectionsService } from '@character-unity/cards/connections';
import { remoteRoutes } from './remotes.js';
import { chatRoutes } from './chat.js';
import type { ChatService } from '@character-unity/cards/chat';
import { ChatAppError } from '@character-unity/cards/chat';
import { SyncCommandError, SyncReadError } from '@character-foundry/character-foundry/sync';
import type { NativeArchiveService } from '@character-unity/cards/native-archive';
import { NativeArchiveUnavailable } from '@character-unity/cards/native-archive';
import { nativeArchiveRoutes } from './archive-native.js';

/** Shared Architect/hub API. Hosts supply storage, card operations and authentication. */
export function createApi(options: { store?: Pick<UnityStore, 'readiness'>; cards?: CardService; archive?: ArchiveImportService; nativeArchive?: NativeArchiveService; hub?: HubService; remotes?: RemoteConnectionsService; chat?: ChatService; authenticate?: Authenticate } = {}) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof SyncCommandError || error instanceof SyncReadError) {
      // A peer's credentials or policy error must not sign the user out of this host.
      const status = ['CHANGED', 'OPERATION_CONFLICT'].includes(error.code) ? 409 : error.code === 'TOO_LARGE' ? 413 : 502;
      return c.json({ error: { code: `REMOTE_${error.code}`, message: `The remote hub reported ${error.code.toLowerCase().replaceAll('_', ' ')}. Refresh the job before retrying a return.` } }, status);
    }
    if (error instanceof ChatAppError) {
      const status = error.code === 'NOT_FOUND' ? 404 : 502;
      return c.json({ error: { code: `CHAT_${error.code}`, message: error.message } }, status);
    }
    if (error instanceof NativeArchiveUnavailable) {
      // The Archive's own answer (404 for an unknown card, 409 for a running source, 400 for a bad setting) passes through.
      const status = [400, 404, 409].includes(error.status) ? error.status as 400 | 404 | 409 : 503;
      return c.json({ error: { code: error.code, message: error.message } }, status);
    }
    if (error instanceof ArchiveError) {
      const status = error.code === 'SNAPSHOT_CHANGED' ? 409 : error.code === 'NOT_FOUND' ? 404 : error.code === 'TOO_LARGE' ? 413 : error.code === 'INVALID_INPUT' ? 400 : 503;
      return c.json({ error: { code: error.code, message: error.message } }, status);
    }
    if (error instanceof CardError || error instanceof StoreError) {
      const status = error.code === 'UNAUTHENTICATED' ? 401 : error.code === 'FORBIDDEN' ? 403 : error.code === 'NOT_FOUND' ? 404 : ['HEAD_CONFLICT', 'ACCESS_CHANGED', 'OPERATION_CONFLICT'].includes(error.code) ? 409 : error.code === 'TOO_LARGE' ? 413 : 400;
      return c.json({ error: { code: error.code, message: error.message } }, status);
    }
    // Foundry format/identity validation failures are input errors, not internal path disclosures.
    if (['IdentityError', 'ParseError', 'SizeLimitError', 'ValidationError', 'FormatNotSupportedError'].includes(error.name)) {
      return c.json({ error: { code: 'INVALID_INPUT', message: 'The card could not be processed without data loss' } }, 400);
    }
    return c.json({ error: { code: 'UNAVAILABLE', message: 'Card service unavailable' } }, 503);
  });
  if (options.chat) app.route('/api/workspaces', chatRoutes(options));
  if (options.nativeArchive) app.route('/api/workspaces', nativeArchiveRoutes(options));
  app.route('/api/workspaces', cardRoutes(options));
  app.route('/api/hub', hubRoutes(options));
  app.route('/api/remotes', remoteRoutes(options));
  app.get('/api/health', (c) => c.json({ service: 'unity-api', status: 'ok', stage: 'scaffold' }));
  app.get('/api/ready', async (c) => {
    if (!options.store) return c.json({ status: 'unavailable', storage: 'not-configured' }, 503);
    try {
      const storage = await options.store.readiness();
      return c.json({ status: 'ready', storage }, 200);
    } catch {
      return c.json({ status: 'unavailable', storage: 'unavailable' }, 503);
    }
  });
  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404));
  return app;
}
