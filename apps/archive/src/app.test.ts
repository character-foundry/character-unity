import { expect, it } from 'vitest';
import { createArchiveApp } from './app.js';

it('starts independently of workspace storage and reports scaffold status', async () => {
  const response = await createArchiveApp().request('/api/health');
  expect(await response.json()).toEqual({ service: 'unity-archive', status: 'ok', stage: 'scaffold' });
});
it.each([
  ['POST', '/api/federation/inbox'],
  ['GET', '/api/sync/chub'],
  ['POST', '/api/config'],
])('does not inherit legacy %s %s routes', async (method, path) => {
  const response = await createArchiveApp().request(path, { method });
  expect(response.status).toBe(404);
});
