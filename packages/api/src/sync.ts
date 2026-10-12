import { bytes as requestBytes } from './body.js';
import { CardError } from '@character-unity/cards/contract';
import { Hono } from 'hono';
import { verifySyncHttp, SyncHttpError, SyncReadError, SYNC_READ_VERSION, SYNC_READ_MAX_JSON_BYTES, SYNC_READ_PAGE_SIZE,
  SYNC_FORK_MAX_BYTES, decodeSyncCommand, parseSyncCommandReceipt, syncCommandCapabilities, SyncCommandError, SYNC_COMMAND_VERSION, SYNC_COMMAND_MAX_BYTES,
  syncReadCapabilities, parseSyncReadSelection, syncResourceId } from '@character-foundry/character-foundry/sync';
import { publicationToSyncRead } from '@character-unity/cards/hub';
import type { HubService } from '@character-unity/cards/hub';
import { StoreError } from '@character-unity/store';
import type { SyncStore } from '@character-unity/store/sync';

/** Signed machine API. It never falls back to browser cookies or an unsigned local session. */
export function createSyncApi(options: { origin: string; hub: HubService; sync: SyncStore; writes?: boolean; admit?: () => Promise<boolean> }) {
  const origin = new URL(options.origin);
  if (origin.origin !== options.origin || origin.protocol !== 'https:') throw new Error('Signed sync requires an exact HTTPS public origin');
  const app = new Hono();
  let windowStart = Date.now(), attempts = 0;
  const admit = options.admit ?? (async () => {
    const now = Date.now(); if (now - windowStart >= 60_000) { windowStart = now; attempts = 0; }
    return ++attempts <= 120;
  });
  function json(value: unknown) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    if (bytes.length > SYNC_READ_MAX_JSON_BYTES) throw new SyncReadError('TOO_LARGE', 'Sync response exceeds its byte limit');
    return new Response(bytes, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  }
  app.all('*', async (c) => {
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    let commandRoute = false;
    try {
      const incoming = new URL(c.req.url);
      if (incoming.host !== origin.host || !['http:', 'https:'].includes(incoming.protocol)
        || c.req.header('cookie') || c.req.header('authorization') || c.req.header('origin')) {
        throw new SyncReadError('FORBIDDEN', 'Signed sync does not accept browser or ambient credentials');
      }
      const path = incoming.pathname.slice('/api/sync/v1'.length);
      const submitted = /^\/commands\/submit-fork\/([^/]+)$/.exec(path);
      const scope = path === '/commands/publish' ? 'publish' : path === '/commands/fork' || submitted ? 'fork' : 'pull';
      commandRoute = scope !== 'pull';
      if ((path.startsWith('/commands/') || path === '/command-capabilities') && !options.writes) throw new SyncReadError('NOT_FOUND', 'Commands are not enabled');
      if (!await admit()) return Response.json({ version: commandRoute ? SYNC_COMMAND_VERSION : SYNC_READ_VERSION, error: { code: 'RATE_LIMITED', message: 'Sync admission limit reached' } }, { status: 429, headers: { ...headers, 'retry-after': '60' } });
      const method = commandRoute ? 'POST' : 'GET';
      if (c.req.method !== method || (!commandRoute && c.req.raw.body !== null)) throw new SyncReadError('INVALID_REQUEST', 'Unexpected sync method or body');
      const body = commandRoute ? await requestBytes(c, submitted ? SYNC_FORK_MAX_BYTES : SYNC_COMMAND_MAX_BYTES) : new Uint8Array();
      // Node may sit behind its configured TLS proxy. Forwarded headers never select the signed URI.
      const url = `${origin.origin}${incoming.pathname}${incoming.search}`;
      const verified = await verifySyncHttp({ method, url, headers: new Headers(c.req.raw.headers), body }, {
        resolveKey: (actor, keyId) => options.sync.resolveKey(actor, keyId, scope), consumeNonce: (claim) => options.sync.consumeNonce(claim, scope),
      });
      if (verified.contentType !== (submitted ? 'application/octet-stream' : 'application/json')) throw new SyncReadError('INVALID_REQUEST', 'Expected application/json request media type');
      const peer = await options.sync.authorize(verified, scope);
      const actor = { id: peer.accountId, uri: peer.accountUri };
      const params = incoming.searchParams;
      let result: unknown;
      if (commandRoute) {
        if (params.size) throw new SyncCommandError('INVALID_REQUEST', 'Commands do not accept query parameters');
        if (submitted) {
          const id = syncResourceId(submitted[1]);
          const forked = await options.hub.submitFork(actor, id, peer.workspaceId, verified.body, { claim: verified });
          result = parseSyncCommandReceipt({ version: SYNC_COMMAND_VERSION, operation: 'forks.submit', requestId: verified.requestId,
            cardId: forked.card.id, revisionId: forked.revision.id });
        } else {
          const command = decodeSyncCommand(verified.body);
          if (command.operation !== `publications.${scope}`) throw new SyncCommandError('INVALID_REQUEST', 'Command does not match its route');
          const context = { claim: verified };
          if (command.operation === 'publications.publish') {
            const publications = await options.hub.publish(actor, peer.workspaceId, command.revisionIds, { ...command.policy, allowOriginal: false }, context);
            result = parseSyncCommandReceipt({ version: SYNC_COMMAND_VERSION, operation: command.operation, requestId: verified.requestId, publications });
          } else {
            const forked = await options.hub.fork(actor, command.publicationId, peer.workspaceId, context);
            result = parseSyncCommandReceipt({ version: SYNC_COMMAND_VERSION, operation: command.operation, requestId: verified.requestId,
              cardId: forked.card.id, revisionId: forked.revision.id });
          }
        }
      } else if (path === '/command-capabilities') {
        if (params.size) throw new SyncReadError('INVALID_REQUEST', 'Capabilities do not accept query parameters');
        result = syncCommandCapabilities();
      } else if (path === '/capabilities') {
        if (params.size) throw new SyncReadError('INVALID_REQUEST', 'Capabilities do not accept query parameters');
        result = syncReadCapabilities();
      } else if (path === '/publications') {
        const selection = parseSyncReadSelection(params); const limit = selection.limit ?? SYNC_READ_PAGE_SIZE;
        const values = await options.hub.list(actor, { limit, ...(selection.after ? { afterId: selection.after } : {}), ...(selection.parent ? { parentId: selection.parent } : {}) });
        const publications = values.map(publicationToSyncRead);
        result = { version: SYNC_READ_VERSION, publications, nextAfter: publications.length === limit ? publications.at(-1)!.id : null };
      } else {
        const match = /^\/publications\/([^/]+)(\/asset)?$/.exec(path);
        if (!match) throw new SyncReadError('NOT_FOUND', 'Sync route not found');
        const id = syncResourceId(match[1]);
        const value = await options.hub.get(actor, id);
        if (!match[2]) {
          if (params.size) throw new SyncReadError('INVALID_REQUEST', 'Publication detail does not accept query parameters');
          result = { version: SYNC_READ_VERSION, publication: publicationToSyncRead(value) };
        } else {
          if (params.size !== 2 || params.getAll('path').length !== 1 || params.getAll('policyVersion').length !== 1
            || !params.get('path') || !/^[1-9][0-9]{0,15}$/.test(params.get('policyVersion') ?? '') || !Number.isSafeInteger(Number(params.get('policyVersion')))) {
            throw new SyncReadError('INVALID_REQUEST', 'Asset reads require path and policyVersion');
          }
          const expectedVersion = Number(params.get('policyVersion'));
          if (value.policyVersion !== expectedVersion) throw new SyncReadError('CHANGED', 'Publication policy changed');
          const snapshot = publicationToSyncRead(value); const asset = snapshot.assets.find((item) => item.path === params.get('path'));
          if (!asset) throw new SyncReadError('NOT_FOUND', 'Publication asset not found');
          const bytes = await options.hub.asset(actor, id, asset.path);
          try {
            await options.sync.authorize(verified, scope);
            if ((await options.hub.get(actor, id)).policyVersion !== expectedVersion) throw new SyncReadError('CHANGED', 'Publication policy changed');
            if (bytes.hash !== asset.hash || bytes.byteLength !== asset.byteLength || bytes.mediaType !== asset.mediaType) throw new StoreError('INTEGRITY', 'Publication asset metadata changed');
            return new Response(bytes.body, { headers: { ...headers, 'content-type': asset.mediaType, 'content-length': String(asset.byteLength),
              'content-disposition': 'attachment', 'content-security-policy': "default-src 'none'; sandbox" } });
          } catch (error) { await bytes.body.cancel(); throw error; }
        }
      }
      await options.sync.authorize(verified, scope);
      return json(result);
    } catch (error) {
      const code = error instanceof SyncHttpError ? (error.code === 'TOO_LARGE' ? 'TOO_LARGE' : 'UNAUTHENTICATED')
        : error instanceof SyncReadError || error instanceof SyncCommandError ? error.code
          : error instanceof CardError ? error.code === 'FORBIDDEN' || error.code === 'TOO_LARGE' ? error.code : 'INVALID_REQUEST'
            : error instanceof StoreError && ['NOT_FOUND', 'UNAUTHENTICATED', 'ACCESS_CHANGED', 'OPERATION_CONFLICT', 'INVALID_INPUT'].includes(error.code)
              ? error.code === 'ACCESS_CHANGED' ? 'CHANGED' : error.code === 'INVALID_INPUT' ? 'INVALID_REQUEST' : error.code : 'UNAVAILABLE';
      const statuses: Record<string, number> = { INVALID_REQUEST: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CHANGED: commandRoute ? 412 : 409, OPERATION_CONFLICT: 409, TOO_LARGE: 413, RATE_LIMITED: 429 };
      return Response.json({ version: commandRoute ? SYNC_COMMAND_VERSION : SYNC_READ_VERSION, error: { code: code === 'INVALID_RESPONSE' ? 'UNAVAILABLE' : code, message: 'Sync request could not be completed' } }, { status: statuses[code] ?? 503, headers });
    }
  });
  return app;
}

/** Compatibility composition for hosts that intentionally expose reads only. */
export function createSyncReadApi(options: Omit<Parameters<typeof createSyncApi>[0], 'writes'>) {
  return createSyncApi({ ...options, writes: false });
}
