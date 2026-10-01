import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8765',
    channel: process.env.E2E_BROWSER_CHANNEL,
    storageState: process.env.E2E_STORAGE_STATE,
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 1000 },
  },
});
