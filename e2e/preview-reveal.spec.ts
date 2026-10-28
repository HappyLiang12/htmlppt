import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { startCliHost } from './helpers';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'packages/cli/dist/bin.js');
const FRAME_SELECTOR = 'iframe[title="投影片預覽"]';
const PLAY_FRAME_SELECTOR = 'iframe[data-testid="play-frame"]';

const DECK = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>State hidden deck</title>
<style>
  html, body { margin: 0; padding: 0; background: #101014; }
  .slide { display: none; width: 1600px; height: 900px; align-items: center; justify-content: center; color: #fff; font: 64px/1.2 system-ui, sans-serif; }
  .slide.active { display: flex; }
</style>
<script>
  document.documentElement.dataset.scriptRan = 'yes';
  let index = 0;
  const slides = Array.from(document.querySelectorAll('.slide'));
  addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowRight') return;
    slides[index].classList.remove('active');
    index = (index + 1) % slides.length;
    slides[index].classList.add('active');
  });
</script>
</head>
<body>
<main data-ppt-deck>
  <section class="slide active" data-slide-id="s1" data-width="1600" data-height="900"><h1>One</h1></section>
  <section class="slide" data-slide-id="s2" data-width="1600" data-height="900"><h1>Two</h1></section>
  <section class="slide" data-slide-id="s3" data-width="1600" data-height="900" hidden><h1>Three</h1></section>
  <section class="slide" data-slide-id="s4" data-width="1600" data-height="900" style="display:none"><h1>Four</h1></section>
</main>
</body></html>`;

async function openDeck(page: Page) {
  const directory = await mkdtemp(join(tmpdir(), 'htmlppt-reveal-'));
  const file = 'state.html';
  await writeFile(join(directory, file), DECK, 'utf8');
  const host = await startCliHost(cliPath, directory, file);
  await page.goto(host.url);
  await expect(page.getByTestId('thumbnail')).toHaveCount(4);
  return {
    directory,
    file,
    host,
    path: join(directory, file),
    async close() {
      await host.stop();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

function waitForDeckSave(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === '/api/deck'
  );
}

test.describe('preview reveal @feature:preview-reveal', () => {
  test('renders class-, hidden-, and inline-hidden slides in canvas, thumbnail, and play', async ({ page }) => {
    const deck = await openDeck(page);
    try {
      const thumbnailTwo = page.getByTestId('thumbnail').nth(1);
      await expect(
        thumbnailTwo
          .locator('iframe')
          .contentFrame()
          .getByRole('heading', { name: 'Two' })
      ).toBeVisible();

      const frame = page.frameLocator(FRAME_SELECTOR);
      await page.getByTestId('thumbnail').nth(1).click();
      await expect(frame.getByRole('heading', { name: 'Two' })).toBeVisible();
      await expect(page.locator('[data-testid="object-row"]')).toHaveCount(1);

      await page.getByTestId('thumbnail').nth(2).click();
      await expect(frame.getByRole('heading', { name: 'Three' })).toBeVisible();
      await page.getByTestId('thumbnail').nth(3).click();
      await expect(frame.getByRole('heading', { name: 'Four' })).toBeVisible();

      await expect(frame.locator('head script')).toHaveCount(1);
      const editorScript = await frame
        .locator('html')
        .evaluate(
          (element) => (element as HTMLElement).dataset.scriptRan ?? null
        );
      expect(editorScript).toBeNull();

      await page.keyboard.press('F5');
      const play = page.frameLocator(PLAY_FRAME_SELECTOR);
      await page.keyboard.press('ArrowRight');
      await expect(play.getByRole('heading', { name: 'Two' })).toBeVisible();
      await page.keyboard.press('ArrowRight');
      await expect(play.getByRole('heading', { name: 'Three' })).toBeVisible();
      await page.keyboard.press('ArrowRight');
      await expect(play.getByRole('heading', { name: 'Four' })).toBeVisible();

      await expect(play.locator('head script')).toHaveCount(1);
      const playScript = await play
        .locator('html')
        .evaluate(
          (element) => (element as HTMLElement).dataset.scriptRan ?? null
        );
      expect(playScript).toBeNull();
      await page.keyboard.press('Escape');
    } finally {
      await deck.close();
    }
  });

  test('does not persist reveal state when a revealed slide is edited', async ({ page }) => {
    const deck = await openDeck(page);
    try {
      const frame = page.frameLocator(FRAME_SELECTOR);
      await page.getByTestId('thumbnail').nth(1).click();
      await frame.getByRole('heading', { name: 'Two' }).dblclick();
      const editable = frame.locator('h1[contenteditable="true"]');
      await expect(editable).toBeVisible();
      await page.keyboard.press('End');
      await page.keyboard.type(' edited');
      const save = waitForDeckSave(page);
      await frame.locator('body').click({ position: { x: 5, y: 5 } });
      expect((await save).ok()).toBeTruthy();

      await expect
        .poll(() => readFile(deck.path, 'utf8'))
        .toContain('Two edited');

      const saved = await readFile(deck.path, 'utf8');
      const savedSlides = await page.evaluate((html) => {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        return Array.from(
          doc.querySelectorAll('section[data-slide-id]')
        ).map((element) => ({
          id: element.getAttribute('data-slide-id'),
          className: element.className,
          marker: element.hasAttribute('data-ppt-preview-slide'),
          style: element.getAttribute('style')
        }));
      }, saved);
      expect(savedSlides.find((slide) => slide.id === 's2')).toEqual({
        id: 's2',
        className: 'slide',
        marker: false,
        style: null
      });
      expect(savedSlides.find((slide) => slide.id === 's1')?.className).toBe(
        'slide active'
      );
    } finally {
      await deck.close();
    }
  });
});
