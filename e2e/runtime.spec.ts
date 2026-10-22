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
        await page.locator('body').click({ position: { x: 10, y: 10 } });
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
