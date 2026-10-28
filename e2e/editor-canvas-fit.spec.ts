import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { startCliHost } from './helpers';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'packages/cli/dist/bin.js');
const FRAME_SELECTOR = 'iframe[title="投影片預覽"]';

const CSS_ONLY = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>CSS only deck</title>
<style>
  html, body { margin: 0; padding: 0; background: #0b0d12; }
  .slide { display: none; width: 1200px; height: 900px; background: #f7f5ef; color: #17181c; font: 48px/1.2 sans-serif; }
  .slide.active { display: block; }
  h1 { position: absolute; left: 80px; top: 80px; margin: 0; font-weight: 400; }
</style></head>
<body>
<main data-ppt-deck>
  <section class="slide active" data-slide-id="s1"><h1 data-ppt-el="title">Four three</h1></section>
  <section class="slide" data-slide-id="s2"><h1>Second</h1></section>
</main>
</body></html>`;

const DECLARED = CSS_ONLY.replace(
  '<style>',
  '<style>'
)
  .replace(
    '<section class="slide active" data-slide-id="s1">',
    '<section class="slide active" data-slide-id="s1" data-width="1600" data-height="900">'
  )
  .replace(
    '<section class="slide" data-slide-id="s2">',
    '<section class="slide" data-slide-id="s2" data-width="1600" data-height="900">'
  )
  .replace('width: 1200px; height: 900px;', 'width: 1600px; height: 900px;');

// Default body margins put the slide root below the frame origin, so the crop
// and the selection overlay no longer share an origin.
const MARGINED = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Offset slide root</title>
<style>.slide { display: none; width: 800px; height: 600px; background: #f7f5ef; } .slide.active { display: block; }</style>
</head><body>
<main data-ppt-deck>
  <section class="slide active" data-slide-id="s1"><h1>Offset heading</h1></section>
</main>
</body></html>`;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

async function openDeck(page: Page, html: string) {
  const directory = await mkdtemp(join(tmpdir(), 'htmlppt-canvas-fit-'));
  const file = 'canvas.html';
  await writeFile(join(directory, file), html, 'utf8');
  const host = await startCliHost(cliPath, directory, file);
  await page.goto(host.url);
  await expect(page.getByTestId('save-status')).toHaveText('已同步');
  return {
    path: join(directory, file),
    frame: page.frameLocator(FRAME_SELECTOR),
    async close() {
      await host.stop();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

async function frameOf(page: Page, selector: string) {
  const handle = await page.locator(selector).first().elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error(`No frame for ${selector}`);
  return frame;
}

async function slideRect(page: Page, selector: string): Promise<Box> {
  const frame = await frameOf(page, selector);
  return frame.evaluate(() => {
    const root = document.querySelector('[data-ppt-preview-slide]');
    if (!root) throw new Error('No preview slide');
    const box = root.getBoundingClientRect();
    return {
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height
    };
  });
}

function screenRect(iframe: Box, slide: Box, scale: number): Box {
  return {
    left: iframe.left + slide.left * scale,
    top: iframe.top + slide.top * scale,
    width: slide.width * scale,
    height: slide.height * scale
  };
}

function deviation(a: Box, b: Box): number {
  return Math.max(
    Math.abs(a.left - b.left),
    Math.abs(a.top - b.top),
    Math.abs(a.width - b.width),
    Math.abs(a.height - b.height)
  );
}

function fromBoundingBox(box: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Box {
  return { left: box.x, top: box.y, width: box.width, height: box.height };
}

async function boxOf(page: Page, selector: string): Promise<Box> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`No box for ${selector}`);
  return fromBoundingBox(box);
}

async function boxOfLocator(locator: ReturnType<Page['locator']>): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('No box for locator');
  return fromBoundingBox(box);
}

test.describe('editor canvas fit @feature:editor-canvas-fit', () => {
  test.describe('canvas', () => {
    test('crops the canvas to a CSS-only slide box', async ({ page }) => {
      const deck = await openDeck(page, CSS_ONLY);
      try {
        await page.getByTestId('thumbnail').nth(1).getByRole('button').click();
        await expect(deck.frame.locator('h1')).toHaveText('Second');

        const stageSelector = '[data-testid="canvas-stage"]';
        const iframe = await boxOf(page, FRAME_SELECTOR);
        const stage = await boxOf(page, stageSelector);
        const slide = await slideRect(page, FRAME_SELECTOR);
        const scale = iframe.width / 1600;

        await expect
          .poll(() => Math.round((stage.width / stage.height) * 100))
          .toBe(133);
        await expect
          .poll(async () => deviation(await boxOf(page, stageSelector), screenRect(iframe, slide, scale)))
          .toBeLessThanOrEqual(1);

        const save = page.waitForResponse(
          (response) =>
            response.request().method() === 'PUT' &&
            new URL(response.url()).pathname === '/api/deck'
        );
        const heading = deck.frame.getByRole('heading', { name: 'Second' });
        await heading.click();
        await expect(page.getByTestId('text-toolbar')).toHaveAttribute(
          'data-mode',
          'selection'
        );
        await heading.dblclick();
        const editable = deck.frame.locator('h1[contenteditable="true"]');
        await expect(editable).toBeVisible();
        await page.keyboard.press('End');
        await page.keyboard.type(' edited');
        await page.keyboard.press('Escape');
        expect((await save).ok()).toBeTruthy();
        await expect
          .poll(() => readFile(deck.path, 'utf8'))
          .toContain('Second edited');
        const html = await readFile(deck.path, 'utf8');
        expect(html).not.toContain('data-ppt-preview-slide');
        expect(html).not.toContain('data-ppt-frame-slide');
        const savedSlides = await page.evaluate((saved) => {
          const doc = new DOMParser().parseFromString(saved, 'text/html');
          return Array.from(
            doc.querySelectorAll('section[data-slide-id]')
          ).map((element) => ({
            id: element.getAttribute('data-slide-id'),
            className: element.className,
            style: element.getAttribute('style')
          }));
        }, html);
        expect(savedSlides).toEqual([
          { id: 's1', className: 'slide active', style: null },
          { id: 's2', className: 'slide', style: null }
        ]);
      } finally {
        await deck.close();
      }
    });

    test('keeps a declared slide box unchanged', async ({ page }) => {
      const deck = await openDeck(page, DECLARED);
      try {
        await expect(deck.frame.locator('h1')).toHaveText('Four three');
        const stageSelector = '[data-testid="canvas-stage"]';
        const iframe = await boxOf(page, FRAME_SELECTOR);
        const stage = await boxOf(page, stageSelector);
        const slide = await slideRect(page, FRAME_SELECTOR);
        const scale = iframe.width / 1600;

        await expect
          .poll(() => Math.round((stage.width / stage.height) * 100))
          .toBe(178);
        await expect
          .poll(async () => deviation(await boxOf(page, stageSelector), screenRect(iframe, slide, scale)))
          .toBeLessThanOrEqual(1);
        expect(Math.round(slide.width)).toBe(1600);
        expect(Math.round(slide.height)).toBe(900);
      } finally {
        await deck.close();
      }
    });

    test('aligns the overlay when the slide root is offset', async ({ page }) => {
      const deck = await openDeck(page, MARGINED);
      try {
        const heading = deck.frame.getByRole('heading', {
          name: 'Offset heading'
        });
        await heading.click();
        const headingBox = await heading.boundingBox();
        const rotate = await page.getByTestId('rotate-handle').boundingBox();
        const handle = await page.getByTestId('handle-n').boundingBox();
        if (!headingBox || !rotate || !handle) {
          throw new Error('Overlay handles are missing.');
        }
        // The north handle sits on the element's top edge; a crop-origin
        // mistake lands it halfway down the element and eats the next click.
        // The 2 px allowance is the selection outline's own border.
        expect(
          Math.abs(handle.x + handle.width / 2 - (headingBox.x + headingBox.width / 2))
        ).toBeLessThanOrEqual(2);
        expect(Math.abs(handle.y + handle.height / 2 - headingBox.y)).toBeLessThanOrEqual(2);
        expect(rotate.y + rotate.height).toBeLessThanOrEqual(handle.y);

        await heading.dblclick();
        const editable = deck.frame.locator('h1[contenteditable="true"]');
        await expect(editable).toBeVisible();
        await page.keyboard.press('End');
        await page.keyboard.type(' edited');
        const save = page.waitForResponse(
          (response) =>
            response.request().method() === 'PUT' &&
            new URL(response.url()).pathname === '/api/deck'
        );
        await page.keyboard.press('Escape');
        expect((await save).ok()).toBeTruthy();
        await expect
          .poll(() => readFile(deck.path, 'utf8'))
          .toContain('Offset heading edited');
        const html = await readFile(deck.path, 'utf8');
        expect(html).not.toContain('data-ppt-preview-slide');
        expect(html).not.toContain('data-ppt-frame-slide');
      } finally {
        await deck.close();
      }
    });
  });

  test.describe('miniatures', () => {
    test('crops the rail and sorter miniature to the measured box', async ({ page }) => {
      const deck = await openDeck(page, CSS_ONLY);
      try {
        const railMiniature = page
          .getByTestId('thumbnail')
          .first()
          .locator('[data-testid="slide-miniature"]');
        await expect(railMiniature).toBeVisible();
        const railIframe = await boxOfLocator(railMiniature.locator('iframe'));
        const railSlide = await slideRect(page, '[data-testid="thumbnail"] iframe');
        const railScale = 152 / railSlide.width;
        await expect
          .poll(async () =>
            deviation(
              await boxOfLocator(railMiniature),
              screenRect(railIframe, railSlide, railScale)
            )
          )
          .toBeLessThanOrEqual(1);

        await page.getByTestId('view-sorter').click();
        const sorterSlide = page.getByTestId('sorter-slide').first();
        const sorterMiniature = sorterSlide.locator('[data-testid="slide-miniature"]');
        await expect(sorterMiniature).toBeVisible();
        const sorterIframe = await boxOfLocator(sorterMiniature.locator('iframe'));
        const sorterInner = await slideRect(
          page,
          '[data-testid="sorter-slide"] iframe'
        );
        const sorterScale = 320 / sorterInner.width;
        await expect
          .poll(async () =>
            deviation(
              await boxOfLocator(sorterMiniature),
              screenRect(sorterIframe, sorterInner, sorterScale)
            )
          )
          .toBeLessThanOrEqual(1);
      } finally {
        await deck.close();
      }
    });
  });
});
