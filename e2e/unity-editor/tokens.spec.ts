import { expect, importCard, save, screenshot, test } from './fixtures.js';

test('native Tokens lazily loads strict browser counting, recovers failures and excludes disabled or opaque lore', async ({ page, diagnostics }, info) => {
  const workers: string[] = [], tokenize: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/assets/tokenizer.worker-')) workers.push(request.url());
    if (/\/api\/.*token/.test(request.url())) tokenize.push(request.url());
  });
  const imported = await importCard(page, 'Native token parity', 'json');
  const document = structuredClone(imported.revision.document);
  const data = document.data as Record<string, unknown>;
  data.description = 'Hello world!'; data.alternate_greetings = ['😀 café', 'お誕生日おめでとう']; data.group_only_greetings = ['Hello world!'];
  data.character_book = { entries: [{ keys: ['one'], content: 'Hello world!', enabled: true },
    { keys: ['two'], content: '😀 café' }, { keys: ['three'], content: 'Never counted', enabled: false }] };
  expect((await page.request.post(`${imported.path}/revisions`, { headers: { origin: new URL(page.url()).origin }, data: { expectedHead: imported.revision.id, document } })).ok()).toBe(true);
  await page.reload();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Native token parity');
  expect(workers).toEqual([]);
  diagnostics.expectedConsole.push('Failed to load resource');
  await page.route('**/assets/tokenizer.worker-*.js', (route) => route.abort());
  await page.getByRole('button', { name: 'Tokens', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Draft text token counts', exact: true });
  await expect(panel.getByRole('alert')).toContainText('could not load');
  await page.unroute('**/assets/tokenizer.worker-*.js');
  await panel.getByRole('button', { name: 'Retry token count', exact: true }).click();
  const row = (label: string) => panel.getByRole('row').filter({ has: page.getByRole('rowheader', { name: label, exact: true }) }).getByRole('cell');
  await expect(row('Description')).toHaveText('3');
  await expect(row('Alternate Greetings')).toHaveText('10');
  await expect(row('Group Only Greetings')).toHaveText('3');
  await expect(row('Enabled lorebook entries')).toHaveText('5');
  await expect(panel).toContainText('1 disabled lorebook entry excluded');
  await screenshot(page, info, 'native-strict-token-counts');
  await page.locator('.architect-root .editor-tabs').getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Character', exact: true }).click();
  await page.getByLabel('Description', { exact: true }).fill('<|endoftext|>');
  await page.getByRole('button', { name: 'Tokens', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Reserved token markers');
  await expect(panel.getByRole('table')).toHaveCount(0);
  await page.locator('.architect-root .editor-tabs').getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Character', exact: true }).click();
  await page.getByLabel('Description', { exact: true }).fill('😀 café');
  await save(page);
  await page.getByRole('button', { name: 'Tokens', exact: true }).click();
  await expect(row('Description')).toHaveText('2');
  expect(await (await page.request.get(`${imported.path}/original`)).body()).toEqual(imported.bytes);
  expect(tokenize).toEqual([]); expect(workers.length).toBeGreaterThanOrEqual(3);
});
