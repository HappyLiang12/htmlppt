import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { execa } from 'execa';
import { RUNTIME_SOURCE } from '../packages/runtime/dist/index.js';
import { serveHtml } from './helpers';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'packages/cli/dist/bin.js');

const authoredDisplayDeck = (runtime: string) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Authored display</title>
  <style>
    .slide { width: 800px; height: 450px; }
    [data-ppt-deck]:not([data-ppt-ready]) > [data-slide-id] ~ [data-slide-id] { display: none; }
  </style>
</head>
<body>
  <main data-ppt-deck>
    <section class="slide" data-slide-id="s1"><h1>One</h1></section>
    <section class="slide" data-slide-id="s2" style="display: flex"><h1>Two</h1></section>
    <section class="slide" data-slide-id="s3" style="display: none"><h1>Three</h1></section>
  </main>
  <script data-ppt-runtime="1">${runtime}</script>
</body>
</html>`;

interface SizedSlide {
  id: string;
  width: number;
  height: number;
}

const sizedDeck = (runtime: string, slides: SizedSlide[]) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Sized deck</title>
  <style>
    body { margin: 0; background: #101014; }
    .slide { background: #fff; }
  </style>
</head>
<body>
  <main data-ppt-deck>
    ${slides
      .map(
        (slide) =>
          `<section class="slide" data-slide-id="${slide.id}" data-width="${slide.width}" data-height="${slide.height}" style="width: ${slide.width}px; height: ${slide.height}px"><h1>${slide.id}</h1></section>`
      )
      .join('\n    ')}
  </main>
  <script data-ppt-runtime="1">${runtime}</script>
</body>
</html>`;

const readDisplay = (element: unknown) => {
  const scope = element as {
    ownerDocument: {
      defaultView: {
        getComputedStyle(node: unknown): { display: string };
      } | null;
    };
  };
  const view = scope.ownerDocument.defaultView;
  if (!view) throw new Error('Slide has no window.');
  return view.getComputedStyle(element).display;
};

test.describe('presentation runtime', () => {
  test('shows only the first slide without JavaScript', { tag: '@feature:runtime' }, async ({ browser }) => {
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-runtime-'));
    try {
      await execa('node', [cliPath, 'new', 'deck.html', '--slides', '2'], { cwd: directory });
      const html = await readFile(join(directory, 'deck.html'), 'utf8');
      const server = await serveHtml(html);
      const context = await browser.newContext({ javaScriptEnabled: false });
      const page = await context.newPage();
      try {
        await page.goto(server.url);
        await expect(page.locator('[data-slide-id="s1"]')).toBeVisible();
        await expect(page.locator('[data-slide-id="s2"]')).toBeHidden();
        await expect(page.locator('[data-slide-id]:visible')).toHaveCount(1);
      } finally {
        await context.close();
        await server.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('prints every slide while preserving stylesheet display', { tag: '@feature:runtime' }, async ({ page }) => {
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-runtime-'));
    try {
      await execa('node', [cliPath, 'new', 'deck.html', '--slides', '2'], { cwd: directory });
      const file = join(directory, 'deck.html');
      const html = (await readFile(file, 'utf8')).replace(
        '.slide {',
        '.slide { display: flex;'
      );
      const server = await serveHtml(html);
      try {
        await page.goto(server.url);
        await expect(page.locator('[data-slide-id="s2"]')).toBeHidden();

        await page.keyboard.press('ArrowRight');
        await expect(page.locator('[data-slide-id="s2"]')).toBeVisible();
        expect(
          await page.locator('[data-slide-id="s2"]').evaluate(readDisplay)
        ).toBe('flex');

        await page.emulateMedia({ media: 'print' });
        await page.evaluate("window.dispatchEvent(new Event('beforeprint'))");
        await expect(page.locator('[data-slide-id="s1"]')).toBeVisible();
        await expect(page.locator('[data-slide-id="s2"]')).toBeVisible();
        expect(
          await page.locator('[data-slide-id="s2"]').evaluate(readDisplay)
        ).toBe('flex');

        await page.evaluate("window.dispatchEvent(new Event('afterprint'))");
        await page.emulateMedia({ media: 'screen' });
        await expect(page.locator('[data-slide-id="s1"]')).toBeHidden();
        await expect(page.locator('[data-slide-id="s2"]')).toBeVisible();
        await expect(page.locator('[data-slide-id]:visible')).toHaveCount(1);
        expect(
          await page.locator('[data-slide-id="s2"]').evaluate(readDisplay)
        ).toBe('flex');
      } finally {
        await server.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('print restores authored inline display', { tag: '@feature:runtime' }, async ({ page }) => {
    const server = await serveHtml(authoredDisplayDeck(RUNTIME_SOURCE));
    try {
      await page.goto(server.url);
      await expect(page.locator('[data-ppt-deck][data-ppt-ready="1"]')).toHaveCount(1);
      await expect(page.locator('[data-slide-id="s1"]')).toBeVisible();
      await expect(page.locator('[data-slide-id="s2"]')).toBeHidden();
      await expect(page.locator('[data-slide-id="s3"]')).toBeHidden();

      await page.emulateMedia({ media: 'print' });
      await page.evaluate("window.dispatchEvent(new Event('beforeprint'))");
      await expect(page.locator('[data-slide-id="s1"]')).toBeVisible();
      await expect(page.locator('[data-slide-id="s2"]')).toBeVisible();
      expect(
        await page.locator('[data-slide-id="s2"]').evaluate(readDisplay)
      ).toBe('flex');
      await expect(page.locator('[data-slide-id="s3"]')).toBeHidden();

      await page.evaluate("window.dispatchEvent(new Event('afterprint'))");
      await page.emulateMedia({ media: 'screen' });
      await expect(page.locator('[data-slide-id="s1"]')).toBeVisible();
      await expect(page.locator('[data-slide-id="s2"]')).toBeHidden();
      await expect(page.locator('[data-slide-id="s3"]')).toBeHidden();
      await expect(page.locator('[data-slide-id]:visible')).toHaveCount(1);
    } finally {
      await server.close();
    }
  });

  test('restores the active slide after navigating during print', { tag: '@feature:runtime' }, async ({ page }) => {
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-runtime-'));
    try {
      await execa('node', [cliPath, 'new', 'deck.html', '--slides', '2'], { cwd: directory });
      const file = join(directory, 'deck.html');
      const html = (await readFile(file, 'utf8')).replace(
        '.slide {',
        '.slide { display: flex;'
      );
      const server = await serveHtml(html);
      try {
        await page.goto(server.url);
        await page.keyboard.press('ArrowRight');
        await expect(page.locator('[data-slide-id="s2"]')).toBeVisible();

        await page.emulateMedia({ media: 'print' });
        await page.evaluate("window.dispatchEvent(new Event('beforeprint'))");
        await expect(page.locator('[data-slide-id="s1"]')).toBeVisible();

        await page.keyboard.press('Home');
        expect(page.url()).toContain('#/1');

        await page.evaluate("window.dispatchEvent(new Event('afterprint'))");
        await page.emulateMedia({ media: 'screen' });
        await expect(page.locator('[data-slide-id="s1"]')).toBeVisible();
        await expect(page.locator('[data-slide-id="s2"]')).toBeHidden();
        await expect(page.locator('[data-slide-id]:visible')).toHaveCount(1);
        expect(
          await page.locator('[data-slide-id="s1"]').evaluate(readDisplay)
        ).toBe('flex');
      } finally {
        await server.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('ignores navigation keys while typing', { tag: '@feature:runtime' }, async ({ page }) => {
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-runtime-'));
    try {
      await execa('node', [cliPath, 'new', 'deck.html', '--slides', '2'], { cwd: directory });
      const file = join(directory, 'deck.html');
      const html = await readFile(file, 'utf8');
      const withInput = html.replace('<h1', '<input id="probe" aria-label="Probe"><h1');
      expect(withInput).toContain('id="probe"');
      const server = await serveHtml(withInput);
      try {
        await page.goto(server.url);
        await expect(page.locator('style[data-ppt-runtime-style="1"]')).toHaveCount(1);
        await page.locator('#probe').focus();
        await page.keyboard.press('ArrowRight');
        expect(page.url()).toContain('#/1');
        // Clicking the deck now advances, so blur explicitly before testing
        // the modifier chord.
        await page.evaluate("document.getElementById('probe').blur()");
        await page.keyboard.press('Shift+ArrowRight');
        expect(page.url()).toContain('#/1');
        await page.keyboard.press('ArrowRight');
        await expect(page.locator('[data-slide-id="s2"]')).toBeVisible();
        expect(page.url()).toContain('#/2');

        await page.evaluate(`(() => {
          const source = document.querySelector('script[data-ppt-runtime="1"]').textContent;
          if (!source) throw new Error('Runtime source missing.');
          const copy = document.createElement('script');
          copy.textContent = source;
          document.body.appendChild(copy);
        })()`);
        await expect(page.locator('style[data-ppt-runtime-style="1"]')).toHaveCount(1);
      } finally {
        await server.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('fits a 16:9 slide into a 4:3 viewport with letterboxing', { tag: '@feature:runtime' }, async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    const server = await serveHtml(
      sizedDeck(RUNTIME_SOURCE, [{ id: 's1', width: 1600, height: 900 }])
    );
    try {
      await page.goto(server.url);
      const box = await page.locator('[data-slide-id="s1"]').boundingBox();
      expect(box).not.toBeNull();
      expect(box?.width).toBeCloseTo(1024, 0);
      expect(box?.height).toBeCloseTo(576, 0);
      expect(box?.x).toBeCloseTo(0, 0);
      expect(box?.y).toBeCloseTo(96, 0);
    } finally {
      await server.close();
    }
  });

  test('fits a slide whose size only comes from CSS', { tag: '@feature:runtime' }, async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    const html = sizedDeck(RUNTIME_SOURCE, [
      { id: 's1', width: 1600, height: 900 }
    ]).replace(' data-width="1600" data-height="900"', '');
    expect(html).toContain('<section class="slide" data-slide-id="s1" style=');
    const server = await serveHtml(html);
    try {
      await page.goto(server.url);
      const box = await page.locator('[data-slide-id="s1"]').boundingBox();
      expect(box?.width).toBeCloseTo(1024, 0);
      expect(box?.height).toBeCloseTo(576, 0);
      expect(box?.y).toBeCloseTo(96, 0);
    } finally {
      await server.close();
    }
  });

  test('fits a 4:3 slide into a 16:9 viewport with pillarboxing', { tag: '@feature:runtime' }, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const server = await serveHtml(
      sizedDeck(RUNTIME_SOURCE, [{ id: 's1', width: 800, height: 600 }])
    );
    try {
      await page.goto(server.url);
      const box = await page.locator('[data-slide-id="s1"]').boundingBox();
      expect(box).not.toBeNull();
      expect(box?.width).toBeCloseTo(960, 0);
      expect(box?.height).toBeCloseTo(720, 0);
      expect(box?.x).toBeCloseTo(160, 0);
      expect(box?.y).toBeCloseTo(0, 0);
    } finally {
      await server.close();
    }
  });

  test('refits the active slide when the viewport resizes', { tag: '@feature:runtime' }, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const server = await serveHtml(
      sizedDeck(RUNTIME_SOURCE, [{ id: 's1', width: 1600, height: 900 }])
    );
    try {
      await page.goto(server.url);
      const wide = await page.locator('[data-slide-id="s1"]').boundingBox();
      expect(wide?.width).toBeCloseTo(1280, 0);
      expect(wide?.height).toBeCloseTo(720, 0);

      await page.setViewportSize({ width: 800, height: 600 });
      // setViewportSize resolves before the renderer dispatches its resize event.
      await expect
        .poll(async () => {
          const box = await page.locator('[data-slide-id="s1"]').boundingBox();
          return box === null
            ? null
            : [Math.round(box.width), Math.round(box.height), Math.round(box.y)];
        })
        .toEqual([800, 450, 75]);
    } finally {
      await server.close();
    }
  });

  test('uses each slide aspect ratio while navigating', { tag: '@feature:runtime' }, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const server = await serveHtml(
      sizedDeck(RUNTIME_SOURCE, [
        { id: 's1', width: 1600, height: 900 },
        { id: 's2', width: 800, height: 600 }
      ])
    );
    try {
      await page.goto(server.url);
      await expect(page.locator('[data-slide-id="s1"]')).toBeVisible();
      await page.keyboard.press('ArrowRight');
      await expect(page.locator('[data-slide-id="s2"]')).toBeVisible();
      const box = await page.locator('[data-slide-id="s2"]').boundingBox();
      expect(box?.width).toBeCloseTo(960, 0);
      expect(box?.height).toBeCloseTo(720, 0);
      expect(box?.x).toBeCloseTo(160, 0);
      expect(box?.y).toBeCloseTo(0, 0);
    } finally {
      await server.close();
    }
  });

  test('offers pagination controls that advance exactly one slide', { tag: '@feature:runtime' }, async ({ page }) => {
    const server = await serveHtml(
      sizedDeck(RUNTIME_SOURCE, [
        { id: 's1', width: 1600, height: 900 },
        { id: 's2', width: 1600, height: 900 },
        { id: 's3', width: 1600, height: 900 }
      ])
    );
    try {
      await page.goto(server.url);
      const controls = page.locator('[data-testid="runtime-controls"]');
      const previous = page.locator('[data-testid="runtime-prev"]');
      const next = page.locator('[data-testid="runtime-next"]');
      const indicator = page.locator('[data-testid="runtime-page"]');
      await expect(controls).toBeVisible();
      await expect(indicator).toHaveText('第 1 / 3 頁');
      await expect(previous).toBeDisabled();
      await expect(next).toBeEnabled();

      await next.click();
      await expect(page.locator('[data-slide-id="s2"]')).toBeVisible();
      await expect(indicator).toHaveText('第 2 / 3 頁');
      expect(page.url()).toContain('#/2');
      await expect(previous).toBeEnabled();

      await previous.click();
      await expect(page.locator('[data-slide-id="s1"]')).toBeVisible();
      await expect(indicator).toHaveText('第 1 / 3 頁');
      expect(page.url()).toContain('#/1');
    } finally {
      await server.close();
    }
  });

  test('hides pagination controls for a single slide deck', { tag: '@feature:runtime' }, async ({ page }) => {
    const server = await serveHtml(
      sizedDeck(RUNTIME_SOURCE, [{ id: 's1', width: 1600, height: 900 }])
    );
    try {
      await page.goto(server.url);
      await expect(page.locator('[data-testid="runtime-controls"]')).toBeHidden();
    } finally {
      await server.close();
    }
  });

  test('removes fit transforms and controls while printing', { tag: '@feature:runtime' }, async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    const server = await serveHtml(
      sizedDeck(RUNTIME_SOURCE, [
        { id: 's1', width: 1600, height: 900 },
        { id: 's2', width: 1600, height: 900 }
      ])
    );
    try {
      await page.goto(server.url);
      await page.emulateMedia({ media: 'print' });
      await page.evaluate("window.dispatchEvent(new Event('beforeprint'))");
      await expect(page.locator('[data-slide-id="s1"]')).toBeVisible();
      await expect(page.locator('[data-slide-id="s2"]')).toBeVisible();
      await expect(page.locator('[data-testid="runtime-controls"]')).toBeHidden();
      const printBox = await page.locator('[data-slide-id="s1"]').boundingBox();
      expect(printBox?.width).toBeCloseTo(1600, 0);
      expect(printBox?.height).toBeCloseTo(900, 0);

      await page.evaluate("window.dispatchEvent(new Event('afterprint'))");
      await page.emulateMedia({ media: 'screen' });
      await expect(page.locator('[data-testid="runtime-controls"]')).toBeVisible();
      const screenBox = await page.locator('[data-slide-id="s1"]').boundingBox();
      expect(screenBox?.width).toBeCloseTo(1024, 0);
      expect(screenBox?.height).toBeCloseTo(576, 0);
    } finally {
      await server.close();
    }
  });

  test('ignores navigation when the body is editable', { tag: '@feature:runtime' }, async ({ page }) => {
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-runtime-'));
    try {
      await execa('node', [cliPath, 'new', 'deck.html', '--slides', '2'], { cwd: directory });
      const html = await readFile(join(directory, 'deck.html'), 'utf8');
      const withEditableBody = html.replace('<body>', '<body contenteditable="true">');
      expect(withEditableBody).toContain('<body contenteditable="true">');
      const server = await serveHtml(withEditableBody);
      try {
        await page.goto(server.url);
        await page.locator('[data-slide-id="s1"]').click({ position: { x: 10, y: 10 } });
        await page.keyboard.press('ArrowRight');
        expect(page.url()).toContain('#/1');
        await expect(page.locator('[data-slide-id="s2"]')).toBeHidden();
      } finally {
        await server.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
