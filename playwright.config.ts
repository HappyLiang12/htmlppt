import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['junit', { outputFile: 'test-results/junit.xml' }]
  ],
  use: {
    viewport: { width: 1440, height: 900 },
    // The existing E2E assertions were written against Traditional Chinese.
    // Pin a zh-TW browser locale so their first visit keeps those labels;
    // locale-specific tests override this per describe block.
    locale: 'zh-TW',
    // Existing visual assertions were captured against the dark editor
    // palette. Theme tests override this per describe block.
    colorScheme: 'dark',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  }
});
