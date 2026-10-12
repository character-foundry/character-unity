import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', fullyParallel: false, workers: 1, retries: 0,
  timeout: 30_000, expect: { timeout: 5_000 },
  outputDir: 'runtime/e2e-results', reporter: [['list'], ['html', { outputFolder: 'runtime/e2e-report', open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:19310', browserName: 'chromium', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: [
    { command: 'node scripts/e2e-remote-server.mjs', url: 'http://127.0.0.1:19314/api/ready', reuseExistingServer: false, timeout: 45_000, gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 } },
    { command: 'node scripts/e2e-hub-server.mjs', url: 'http://127.0.0.1:19312/api/ready', reuseExistingServer: false, timeout: 20_000, gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 } },
    { command: 'node scripts/e2e-archive-server.mjs', url: 'http://127.0.0.1:19313/api/archive/v1/status', reuseExistingServer: false, timeout: 20_000, gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 } },
    { command: 'node scripts/e2e-server.mjs', url: 'http://127.0.0.1:19310/api/ready', reuseExistingServer: false, timeout: 20_000, gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 } },
    { command: 'node scripts/static-browser-server.mjs', url: 'http://127.0.0.1:19311', reuseExistingServer: false, timeout: 10_000, gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 } }],
});
