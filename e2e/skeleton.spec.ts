import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { execa } from 'execa';
import { serveHtml, startCliHost } from './helpers';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'packages/cli/dist/bin.js');

async function editHeadingAndExpectSaved(
  page: Page,
  directory: string,
  file: string,
  nextText: string
) {
  const host = await startCliHost(cliPath, directory, file);
  try {
    await page.goto(host.url);
    const frame = page.frameLocator('iframe[title="投影片預覽"]');
    await frame.locator('h1').dblclick();
    await frame.locator('h1').fill(nextText);
    await frame.locator('h1').press('Escape');
    await expect(page.getByTestId('save-status')).toHaveText('已儲存');

    const saved = await readFile(join(directory, file), 'utf8');
    expect(saved).toContain(nextText);
    expect(saved).not.toContain('contenteditable');
  } finally {
    await host.stop();
  }
}

test(
  'walking skeleton: create, edit, save, export, present',
  { tag: '@feature:skeleton' },
  async ({ page }) => {
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-e2e-'));
    let host: Awaited<ReturnType<typeof startCliHost>> | undefined;
    let staticServer: Awaited<ReturnType<typeof serveHtml>> | undefined;

    try {
      await execa('node', [cliPath, 'new', 'demo.html', '--slides', '2'], {
        cwd: directory
      });
      await execa('node', [cliPath, 'validate', 'demo.html'], {
        cwd: directory
      });

      host = await startCliHost(cliPath, directory, 'demo.html');
      await page.goto(host.url);
      const frame = page.frameLocator('iframe[title="投影片預覽"]');
      await expect(frame.locator('h1')).toContainText('Untitled deck');

      await frame.locator('h1').dblclick();
      await frame.locator('h1').fill('Updated deck title');
      await frame.locator('h1').press('Escape');
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      const saved = await readFile(join(directory, 'demo.html'), 'utf8');
      expect(saved).toContain('Updated deck title');
      expect(saved).not.toContain('contenteditable');

      await page.getByRole('button', { name: '下一頁' }).click();
      await expect(frame.locator('h1')).toContainText('Untitled deck — 2');
      await page.getByRole('button', { name: '上一頁' }).click();
      await expect(frame.locator('h1')).toContainText('Updated deck title');

      await execa(
        'node',
        [cliPath, 'export', 'demo.html', '--format', 'html'],
        { cwd: directory }
      );
      const exported = await readFile(
        join(directory, 'demo.export.html'),
        'utf8'
      );
      expect(exported).toContain(
        '<!-- Edited with htmlppt. Format: htmldeck/v1. -->'
      );
      expect(exported).toContain('Updated deck title');
      expect(exported).not.toContain('contenteditable');

      const flexed = exported.replace(
        /<section([^>]*data-slide-id="s2")/,
        '<section style="display:flex"$1'
      );
      expect(flexed).toContain('style="display:flex"');
      staticServer = await serveHtml(flexed);
      await page.goto(staticServer.url);
      await expect(page.locator('[data-slide-id="s1"]')).toBeVisible();
      await expect(page.locator('[data-slide-id="s2"]')).toBeHidden();
      await page.keyboard.press('ArrowRight');
      await expect(page.locator('[data-slide-id="s2"]')).toBeVisible();
      await expect(page.locator('[data-slide-id="s2"]')).toHaveCSS(
        'display',
        'flex'
      );
      expect(page.url()).toContain('#/2');

      await page.keyboard.press('ArrowLeft');
      await expect(page.locator('[data-slide-id="s1"]')).toBeVisible();
      await expect(page.locator('[data-slide-id="s2"]')).toBeHidden();
      expect(page.url()).toContain('#/1');

      await page.keyboard.press('End');
      await expect(page.locator('[data-slide-id="s2"]')).toBeVisible();
      await page.keyboard.press('Home');
      await expect(page.locator('[data-slide-id="s1"]')).toBeVisible();

      await page.keyboard.press('PageDown');
      await expect(page.locator('[data-slide-id="s2"]')).toBeVisible();
      await page.keyboard.press('PageUp');
      await expect(page.locator('[data-slide-id="s1"]')).toBeVisible();

      await page.keyboard.press('Space');
      await expect(page.locator('[data-slide-id="s2"]')).toBeVisible();

      await page.keyboard.press('ArrowRight');
      await expect(page.locator('[data-slide-id="s2"]')).toBeVisible();
      expect(page.url()).toContain('#/2');

      await page.keyboard.press('Home');
      await expect(page.locator('[data-slide-id="s1"]')).toBeVisible();
      await page.keyboard.press('ArrowLeft');
      await expect(page.locator('[data-slide-id="s1"]')).toBeVisible();
      expect(page.url()).toContain('#/1');

      await page.goto('about:blank');
      await page.goto(`${staticServer.url}#/2`);
      await expect(page.locator('[data-slide-id="s2"]')).toBeVisible();
      await expect(page.locator('[data-slide-id="s1"]')).toBeHidden();
      expect(page.url()).toContain('#/2');
    } finally {
      if (staticServer) await staticServer.close();
      await host?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  'edits a deck whose slides only have a class selector',
  { tag: '@feature:skeleton' },
  async ({ page }) => {
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-e2e-'));
    try {
      await writeFile(
        join(directory, 'class-only.html'),
        `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Class only deck</title>
<style>.slide { width: 800px; height: 600px; }</style>
</head>
<body>
<section class="slide"><h1>Class only</h1></section>
</body>
</html>
`,
        'utf8'
      );

      await editHeadingAndExpectSaved(
        page,
        directory,
        'class-only.html',
        'Class only updated'
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  'edits a deck that falls back to the body slide',
  { tag: '@feature:skeleton' },
  async ({ page }) => {
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-e2e-'));
    try {
      await writeFile(
        join(directory, 'body-only.html'),
        `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Body only deck</title>
</head>
<body>
<h1>Body only</h1>
</body>
</html>
`,
        'utf8'
      );

      await editHeadingAndExpectSaved(
        page,
        directory,
        'body-only.html',
        'Body only updated'
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  'sandboxed preview keeps slide scripts inert',
  { tag: '@feature:skeleton' },
  async ({ page }) => {
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-e2e-'));
    let host: Awaited<ReturnType<typeof startCliHost>> | undefined;
    try {
      await writeFile(
        join(directory, 'hostile.html'),
        `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Hostile deck</title>
</head>
<body>
<section data-slide-id="s1">
<h1>Isolation check</h1>
<script>window.parent.__htmlpptPwned = true;</script>
<img src="x" onerror="window.parent.__htmlpptPwned = true">
</section>
</body>
</html>
`,
        'utf8'
      );

      host = await startCliHost(cliPath, directory, 'hostile.html');
      await page.goto(host.url);
      const frame = page.frameLocator('iframe[title="投影片預覽"]');
      await expect(frame.locator('h1')).toContainText('Isolation check');
      await expect(frame.locator('img')).toHaveJSProperty('complete', true);

      await expect(
        page.locator('iframe[title="投影片預覽"]')
      ).toHaveAttribute('sandbox', 'allow-same-origin');
      expect(
        await page.evaluate(
          () =>
            (globalThis as { __htmlpptPwned?: boolean }).__htmlpptPwned ??
            false
        )
      ).toBe(false);
    } finally {
      await host?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
);
