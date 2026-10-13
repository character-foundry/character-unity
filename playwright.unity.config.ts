import { defineConfig } from '@playwright/test';

/** The real Unity shell and Architect editor; the original config covers the older hosts. */
export default defineConfig({
  testDir: './e2e/unity-editor',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: 'runtime/unity-e2e-results',
  reporter: [['list'], ['html', { outputFolder: 'runtime/unity-e2e-report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:19430',
    browserName: 'chromium',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
  },
  webServer: {
    command: 'node scripts/e2e-unity-server.mjs',
    url: 'http://127.0.0.1:19430/api/ready',
    reuseExistingServer: false,
    timeout: 60_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
  },
});
