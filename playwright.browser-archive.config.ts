import { defineConfig } from '@playwright/test';

/** Only this rehearsal explicitly connects the browser host to an owned Archive. */
export default defineConfig({
  testDir: './e2e/native-browser-archive', fullyParallel: false, workers: 1, retries: 0,
  timeout: 60_000, expect: { timeout: 10_000 },
  outputDir: 'runtime/native-browser-archive-e2e-results',
  reporter: [['list'], ['html', { outputFolder: 'runtime/native-browser-archive-e2e-report', open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:19435', browserName: 'chromium', viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure', screenshot: 'only-on-failure', actionTimeout: 15_000 },
  webServer: { command: 'node scripts/e2e-native-browser-archive-server.mjs', url: 'http://127.0.0.1:19435', reuseExistingServer: false,
    timeout: 60_000, gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 } },
});
