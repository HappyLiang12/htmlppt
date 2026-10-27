import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { startCliHost } from './helpers';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'packages/cli/dist/bin.js');

const DECK = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>CSS-only 4x3</title>
<style>
  html, body { margin: 0; padding: 0; }
  .slide { display: none; width: 1200px; height: 900px; background: #f7f5ef; color: #17181c; font: 48px/1.2 sans-serif; }
  .slide.active { display: block; }
  .slide h1 { margin: 0; padding: 40px; }
</style></head>
<body>
<main data-ppt-deck>
  <section class="slide active" data-slide-id="s1"><h1>Four three</h1></section>
  <section class="slide" data-slide-id="s2"><h1>Second</h1></section>
</main>
</body></html>`;

async function openDeck(page: Page) {
  const directory = await mkdtemp(join(tmpdir(), 'htmlppt-play-fit-'));
  const file = 'fit.html';
  await writeFile(join(directory, file), DECK, 'utf8');
  const host = await startCliHost(cliPath, directory, file);
  await page.goto(host.url);
  await page.getByTestId('thumbnail').first().waitFor();
  return {
    directory,
    host,
    async close() {
      await host.stop();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

test.describe('play fit @feature:play-fit', () => {
  test('measures a CSS-only slide and switches between Fit and Fill', async ({ page }) => {
    const deck = await openDeck(page);
    try {
      await page.keyboard.press('F5');
      const view = page.getByTestId('play-view');
      const slide = page.getByTestId('play-slide');
      await expect(view).toBeVisible();
      await expect(page.getByTestId('play-fit')).toHaveAttribute(
        'aria-pressed',
        'true'
      );

      await expect
        .poll(async () => {
          const box = await slide.boundingBox();
          return box ? Math.round((box.width / box.height) * 100) : 0;
        })
        .toBe(133);

      const viewport = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight
      }));
      const fitBox = await slide.boundingBox();
      if (!fitBox) throw new Error('No fit box.');
      expect(fitBox.height).toBeCloseTo(viewport.height, 0);

      await page.getByTestId('play-fill').click();
      await expect(page.getByTestId('play-fill')).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      const fillBox = await slide.boundingBox();
      if (!fillBox) throw new Error('No fill box.');
      expect(fillBox.width).toBeGreaterThanOrEqual(viewport.width - 1);
      expect(fillBox.height).toBeGreaterThanOrEqual(viewport.height - 1);

      await page.keyboard.press('Escape');
      await expect(page.getByTestId('play-view')).toHaveCount(0);
      await page.keyboard.press('F5');
      await expect(page.getByTestId('play-fill')).toHaveAttribute(
        'aria-pressed',
        'true'
      );

      await page.getByTestId('play-fit').click();
      await page.keyboard.press('Escape');
      await page.keyboard.press('F5');
      await expect(page.getByTestId('play-fit')).toHaveAttribute(
        'aria-pressed',
        'true'
      );
    } finally {
      await deck.close();
    }
  });

  test('refits on resize and fullscreen change', async ({ page }) => {
    const deck = await openDeck(page);
    try {
      await page.keyboard.press('F5');
      // Leave fullscreen first so the resize below is a plain viewport change.
      await expect
        .poll(() => page.evaluate('document.fullscreenElement !== null'))
        .toBe(true);
      await page.keyboard.press('f');
      await expect
        .poll(() => page.evaluate('document.fullscreenElement === null'))
        .toBe(true);
      const slide = page.getByTestId('play-slide');
      await expect
        .poll(async () => (await slide.boundingBox())?.width ?? 0)
        .toBeGreaterThan(0);

      await page.setViewportSize({ width: 1000, height: 800 });
      await expect
        .poll(async () => {
          const box = await slide.boundingBox();
          return box ? Math.round(box.width) : 0;
        })
        .toBe(1000);

      await page.keyboard.press('f');
      await expect
        .poll(() => page.evaluate('document.fullscreenElement !== null'))
        .toBe(true);
      const box = await slide.boundingBox();
      if (!box) throw new Error('No fullscreen box.');
      expect(box.width / box.height).toBeCloseTo(4 / 3, 2);
      await page.keyboard.press('f');
      await expect
        .poll(() => page.evaluate('document.fullscreenElement === null'))
        .toBe(true);
    } finally {
      await deck.close();
    }
  });
});
