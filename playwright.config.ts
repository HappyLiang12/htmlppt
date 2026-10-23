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
    // The editor copy is still migrated incrementally. Pin a Traditional
    // Chinese browser locale so existing Chinese E2E assertions keep their
    // first-visit experience; locale tests override this per describe block.
    locale: 'zh-TW',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  }
});
