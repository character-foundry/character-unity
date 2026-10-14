import { defineConfig } from '@playwright/test';

/** Native shell with real operator accounts, plus configured HTTPS peer hosts. */
export default defineConfig({
  testDir: './e2e/unity-editor',
  testMatch: 'sharing.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  outputDir: 'runtime/native-account-e2e-results',
  reporter: [['list'], ['html', { outputFolder: 'runtime/native-account-e2e-report', open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:19432', browserName: 'chromium', viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure', screenshot: 'only-on-failure', actionTimeout: 15_000 },
  webServer: [
    { command: 'node scripts/e2e-native-hub-server.mjs', url: 'http://127.0.0.1:19432/api/ready', reuseExistingServer: false,
      timeout: 60_000, gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 } },
    { command: 'node scripts/e2e-remote-server.mjs apps/web/dist', url: 'http://127.0.0.1:19314/api/ready', reuseExistingServer: false,
      timeout: 60_000, gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 } },
  ],
});
