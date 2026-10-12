import { describe, expect, it } from 'vitest';
import { createApi } from './index.js';

describe('portable shared API boundary', () => {
  it('reports unavailable storage independently of process health', async () => {
    expect((await createApi().request('/api/ready')).status).toBe(503);
    const failed = createApi({ store: { readiness: async () => { throw new Error('private database path'); } } });
    const response = await failed.request('/api/ready');
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private database path');
  });
  it('reports the connected schema only after a store check', async () => {
    const app = createApi({ store: { readiness: async () => ({ schemaVersion: 1 }) } });
    expect(await (await app.request('/api/ready')).json()).toEqual({ status: 'ready', storage: { schemaVersion: 1 } });
  });
  it('serves through the standard Fetch interface', async () => {
    const response = await createApi().fetch(new Request('http://unity.test/api/health'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ service: 'unity-api', status: 'ok', stage: 'scaffold' });
  });
  it.each(['/api/cards', '/api/federation/inbox', '/v1/archive/cards'])('does not expose unimplemented mutations at %s', async (path) => {
    const response = await createApi().request(path, { method: 'POST' });
    expect(response.status).toBe(404);
  });
});
