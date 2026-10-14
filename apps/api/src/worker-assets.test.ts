import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterEach, expect, it } from 'vitest';

const fixtures: { root: string; worker: Miniflare }[] = [];
afterEach(async () => {
  for (const { root, worker } of fixtures.splice(0)) { await worker.dispose(); await rm(root, { recursive: true, force: true }); }
});
for (const profile of ['hub', 'browser']) it(`${profile} static routing serves native SPA deep links and never shadows API paths with assets`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'unity-worker-assets-')), assets = join(root, 'assets');
  await mkdir(join(assets, 'api'), { recursive: true });
  await writeFile(join(assets, 'index.html'), '<!doctype html><title>Native Unity shell</title>');
  await writeFile(join(assets, 'api/client'), 'THIS STATIC FILE MUST NEVER SHADOW THE API');
  const bundled = await build({ entryPoints: [fileURLToPath(new URL(profile === 'hub' ? './worker.ts' : './worker-browser.ts', import.meta.url))],
    bundle: true, platform: 'browser', conditions: ['workerd', 'browser'], target: 'es2022', format: 'esm', external: ['node:*'], write: false });
  const worker = new Miniflare(convertV4MiniflareOptions({ port: 0, modules: true, script: bundled.outputFiles[0]!.text,
    compatibilityDate: '2026-10-13', compatibilityFlags: profile === 'hub' ? ['nodejs_compat'] : [],
    assets: { directory: assets, binding: 'ASSETS', run_worker_first: ['/api', '/api/*'],
      routerConfig: { has_user_worker: true }, assetConfig: { not_found_handling: 'single-page-application' } },
    bindings: profile === 'hub' ? { UNITY_PUBLIC_ORIGIN: 'https://worker.unity.invalid' } : {},
  }));
  fixtures.push({ root, worker });
  for (const path of ['/', '/card/kept-in-browser', '/edit/deep-link', '/sharing']) {
    const response = await worker.dispatchFetch(`https://worker.unity.invalid${path}`, { headers: { accept: 'text/html' } });
    expect(response.status).toBe(200); expect(await response.text()).toContain('Native Unity shell');
  }
  for (const path of ['/api', '/api/client', '/api/unknown', '/api/workspaces', '/api/session']) {
    for (const accept of ['text/html', 'application/json']) {
      const response = await worker.dispatchFetch(`https://worker.unity.invalid${path}`, { headers: { accept } });
      expect(response.status, `${path} (${accept}): ${await response.clone().text()}`).toBe(profile === 'browser' || path === '/api' ? 404 : 503);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).not.toContain('STATIC FILE');
    }
  }
});
