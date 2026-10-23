import { expect, test } from '@playwright/test';
import { RUNTIME_SOURCE } from '../packages/runtime/dist/index.js';
import { serveHtml } from './helpers';

const localeDeck = (runtime: string) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Locale deck</title>
  <style>
    html, body { margin: 0; }
    .slide { width: 1600px; height: 900px; position: relative; }
  </style>
</head>
<body>
  <main data-ppt-deck>
    <section class="slide" data-slide-id="s1" data-width="1600" data-height="900">
      <h1>One</h1>
    </section>
    <section class="slide" data-slide-id="s2" data-width="1600" data-height="900">
      <h1>Two</h1>
    </section>
  </main>
  <script data-ppt-runtime="1">${runtime}</script>
</body>
</html>`;

let server: Awaited<ReturnType<typeof serveHtml>>;

test.beforeEach(async () => {
  server = await serveHtml(localeDeck(RUNTIME_SOURCE));
});

test.afterEach(async () => {
  await server.close();
});

test.describe('runtime locale', () => {
  test.use({ locale: 'en-US' });

  test('localizes control labels and the page indicator in English', async ({
    page
  }) => {
    await page.goto(server.url);
    await expect(page.getByTestId('runtime-controls')).toHaveAttribute(
      'aria-label',
      'Slide navigation'
    );
    await expect(page.getByTestId('runtime-prev')).toHaveAttribute(
      'aria-label',
      'Previous slide'
    );
    await expect(page.getByTestId('runtime-prev')).toHaveText(
      'Previous slide'
    );
    await expect(page.getByTestId('runtime-next')).toHaveAttribute(
      'aria-label',
      'Next slide'
    );
    await expect(page.getByTestId('runtime-next')).toHaveText('Next slide');
    await expect(page.getByTestId('runtime-page')).toHaveText('1 / 2');
  });

  test('data-ppt-locale overrides the browser language', async ({ page }) => {
    await page.addInitScript(() => {
      // Init scripts run before the parser creates <html>, so stamp the
      // override as soon as the document element exists.
      const apply = () => {
        if (!document.documentElement) return false;
        document.documentElement.setAttribute('data-ppt-locale', 'zh-Hant');
        return true;
      };
      if (apply()) return;
      const observer = new MutationObserver(() => {
        if (apply()) observer.disconnect();
      });
      observer.observe(document, { childList: true, subtree: true });
    });
    await page.goto(server.url);
    await expect(page.getByTestId('runtime-prev')).toHaveAttribute(
      'aria-label',
      '上一頁'
    );
    await expect(page.getByTestId('runtime-next')).toHaveAttribute(
      'aria-label',
      '下一頁'
    );
    await expect(page.getByTestId('runtime-page')).toHaveText('第 1 / 2 頁');
  });
});

test.describe('simplified Chinese runtime', () => {
  test.use({ locale: 'zh-CN' });

  test('uses Simplified Chinese labels and page text', async ({ page }) => {
    await page.goto(server.url);
    await expect(page.getByTestId('runtime-prev')).toHaveAttribute(
      'aria-label',
      '上一页'
    );
    await expect(page.getByTestId('runtime-next')).toHaveAttribute(
      'aria-label',
      '下一页'
    );
    await expect(page.getByTestId('runtime-page')).toHaveText('第 1 / 2 页');
  });
});

test.describe('unsupported runtime language', () => {
  test.use({ locale: 'fr-FR' });

  test('falls back to English', async ({ page }) => {
    await page.goto(server.url);
    await expect(page.getByTestId('runtime-next')).toHaveAttribute(
      'aria-label',
      'Next slide'
    );
    await expect(page.getByTestId('runtime-page')).toHaveText('1 / 2');
  });
});
