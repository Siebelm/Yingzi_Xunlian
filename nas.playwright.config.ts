import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './server/browser',
  testMatch: '*.e2e.ts',
  workers: 1,
  timeout: 60_000,
  use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, actionTimeout: 15_000, trace: 'retain-on-failure' },
});