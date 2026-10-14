import { expect, test } from '@playwright/test';

test('browser Meta-tags save offline in the retained workspace and survive reload without host requests', async ({ page, context }, info) => {
  const api: string[] = [], errors: string[] = [];
  page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/api/')) api.push(request.url()); });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/meta-tags');
  await page.getByRole('button', { name: 'Create Meta-tag', exact: true }).click();
  await page.getByLabel('Meta-tag name', { exact: true }).fill('Browser Fantasy Guild');
  await page.getByRole('combobox', { name: 'Member tags', exact: true }).fill('elves');
  await page.getByRole('combobox', { name: 'Member tags', exact: true }).press('Enter');
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Save Meta-tags', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Meta-tags saved');
  await page.getByLabel('Meta-tag name', { exact: true }).fill('Browser Fantasy Guild renamed offline');
  await page.getByRole('button', { name: 'Save Meta-tags', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save Meta-tags', exact: true })).toBeDisabled();
  await context.setOffline(false); await page.reload();
  await expect(page.getByLabel('Meta-tag name', { exact: true })).toHaveValue('Browser Fantasy Guild renamed offline');
  await expect(page.getByRole('button', { name: 'Remove elves', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath('browser-meta-tags-offline-persist-mobile.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(api).toEqual([]); expect(errors).toEqual([]);
});
