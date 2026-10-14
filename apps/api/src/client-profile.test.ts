import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createAccountApi } from '@character-unity/api/sessions';
import { createLocalApi } from './local.js';
import { openLocalServices } from './services.js';

it('discloses only the explicit local/account client profile without authentication or storage configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'unity-client-profile-'));
  const origin = 'http://127.0.0.1:19312';
  const services = await openLocalServices({ databasePath: ':memory:', blobDirectory: directory });
  try {
    const local = createLocalApi(services, { origin: () => origin });
    const account = createAccountApi({ origin, accounts: services.accounts, store: services.store, forSession: services.forSession });
    for (const [app, profile, browserLLM] of [[local, 'local', true], [account, 'hub', false]] as const) {
      const response = await app.request(`${origin}/api/client`);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(await response.json()).toEqual({ profile, capabilities: { browserLLM } });
      expect((await app.request(`${origin}/api/client`, { headers: { origin: 'https://attacker.test' } })).status).toBe(403);
    }
  } finally { services.close(); await rm(directory, { recursive: true, force: true }); }
});

it.each(['status', 'tags', 'object'] as const)('composes native Archive %s against the authenticated account and revokes it after a remote read', async (operation) => {
  const directory = await mkdtemp(join(tmpdir(), 'unity-client-archive-'));
  let afterRead = async () => {};
  const services = await openLocalServices({ databasePath: ':memory:', blobDirectory: directory,
    nativeArchive: { origin: 'http://127.0.0.1:19431', fetch: async () => { await afterRead(); return Response.json({ archiveId: 'fixture', cards: 0 }); } } });
  try {
    const account = await services.accounts.create('Alice'), authenticated = await services.accounts.login(account.key);
    if (!authenticated) throw new Error('Fixture sign-in failed');
    const scoped = services.forSession(authenticated.proof);
    const actor = { id: account.account.id, uri: account.account.uri };
    const workspace = await scoped.cards.createWorkspace(actor, 'Library');
    expect(scoped.nativeArchive).toBeDefined();
    expect(await scoped.nativeArchive!.status(actor, workspace.id)).toEqual({ archiveId: 'fixture', cards: 0 });
    await expect(scoped.nativeArchive!.admin.sources(actor, workspace.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const origin = 'http://127.0.0.1:19312';
    const api = createAccountApi({ origin, accounts: services.accounts, store: services.store, forSession: services.forSession });
    const adminResponse = await api.request(`${origin}/api/workspaces/${workspace.id}/archive/v2/sources`, {
      headers: { origin, cookie: `unity_hub_session=${authenticated.token}`, 'x-unity-actor': actor.id },
    });
    expect(adminResponse.status).toBe(403);
    const objectResponse = await api.request(`${origin}/api/workspaces/${workspace.id}/archive/v2/objects/${'a'.repeat(64)}`, {
      headers: { origin, cookie: `unity_hub_session=${authenticated.token}`, 'x-unity-actor': actor.id },
    });
    expect(objectResponse.status).toBe(200);
    expect(objectResponse.headers.get('cache-control')).toBe('no-store');
    afterRead = async () => { await services.accounts.logout(authenticated.token); };
    const pending = operation === 'object' ? scoped.nativeArchive!.object(actor, workspace.id, 'a'.repeat(64)) : scoped.nativeArchive![operation](actor, workspace.id);
    await expect(pending).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  } finally { services.close(); await rm(directory, { recursive: true, force: true }); }
});
