import { defineConfig } from '@playwright/test';

/** The production native UI over its retained in-place IndexedDB adapter. */
export default defineConfig({
  testDir: './e2e/native-browser', fullyParallel: false, workers: 1, retries: 0,
  timeout: 60_000, expect: { timeout: 10_000 },
  outputDir: 'runtime/native-browser-e2e-results',
  reporter: [['list'], ['html', { outputFolder: 'runtime/native-browser-e2e-report', open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:19434', browserName: 'chromium', viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure', screenshot: 'only-on-failure', actionTimeout: 15_000 },
  webServer: { command: 'node scripts/e2e-native-browser-server.mjs', url: 'http://127.0.0.1:19434', reuseExistingServer: false,
    timeout: 10_000, gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 } },
});
