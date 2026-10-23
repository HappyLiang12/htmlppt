import { expect, test } from '@playwright/test';
import { RUNTIME_SOURCE } from '../packages/runtime/dist/index.js';
import { serveHtml } from './helpers';

const localeDeck = (runtime: string, htmlAttributes = 'lang="en"') => `<!doctype html>
<html ${htmlAttributes}>
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

  test('localizes the presenter view and its last-slide placeholder', async ({
    page
  }) => {
    await page.goto(server.url);
    const popupPromise = page.waitForEvent('popup');
    await page.keyboard.press('p');
    const presenter = await popupPromise;
    await expect(presenter).toHaveTitle('Presenter view');
    await expect(presenter.locator('h1')).toHaveText('Presenter view');
    await expect(presenter.getByTestId('presenter-status')).toHaveText(
      'Connected'
    );
    await expect(presenter.getByTestId('presenter-page')).toHaveText('1 / 2');
    await expect(presenter.getByTestId('presenter-notes')).toHaveText(
      'No notes for this slide.'
    );

    await page.keyboard.press('End');
    await expect(presenter.getByTestId('presenter-page')).toHaveText('2 / 2');
    await expect(presenter.getByTestId('presenter-next-preview')).toHaveText(
      '(Last slide)'
    );
  });

  test('localizes the blocked-fullscreen notice in English', async ({
    page
  }) => {
    await page.goto(server.url);
    await page.evaluate(() => {
      Object.defineProperty(document.documentElement, 'requestFullscreen', {
        configurable: true,
        value: () => Promise.reject(new Error('denied'))
      });
    });
    await page.keyboard.press('f');
    await expect(page.getByTestId('runtime-notice')).toHaveText(
      'Fullscreen was blocked. Press F11.'
    );
  });

  test('data-ppt-locale overrides the browser language', async ({ page }) => {
    await server.close();
    server = await serveHtml(
      localeDeck(RUNTIME_SOURCE, 'lang="en" data-ppt-locale="zh-Hant"')
    );
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
