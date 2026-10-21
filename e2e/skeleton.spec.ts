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

      const savedAfterFirstEdit = await readFile(
        join(directory, 'demo.html'),
        'utf8'
      );
      expect(savedAfterFirstEdit).toContain('Updated deck title');
      expect(savedAfterFirstEdit).not.toContain('contenteditable');

      // The status already reads 已儲存 from the first save, so wait for the
      // second PUT itself before asserting the file contents.
      const secondSave = page.waitForResponse(
        (response) =>
          response.request().method() === 'PUT' &&
          new URL(response.url()).pathname === '/api/deck'
      );
      await frame.locator('h1').dblclick();
      await frame.locator('h1').fill('Final deck title');
      await frame.locator('h1').press('Escape');
      expect((await secondSave).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      const savedAfterSecondEdit = await readFile(
        join(directory, 'demo.html'),
        'utf8'
      );
      expect(savedAfterSecondEdit).toContain('Final deck title');
      expect(savedAfterSecondEdit).not.toContain('Updated deck title');
      expect(savedAfterSecondEdit).not.toContain('contenteditable');

      await page.getByRole('button', { name: '下一頁' }).click();
      await expect(frame.locator('h1')).toContainText('Untitled deck — 2');
      await page.getByRole('button', { name: '上一頁' }).click();
      await expect(frame.locator('h1')).toContainText('Final deck title');

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
      expect(exported).toContain('Final deck title');
      expect(exported).not.toContain('Updated deck title');
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
  'exported deck without a runtime navigates with the injected runtime',
  { tag: '@feature:skeleton' },
  async ({ page }) => {
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-e2e-'));
    let staticServer: Awaited<ReturnType<typeof serveHtml>> | undefined;
    try {
      await writeFile(
        join(directory, 'runtime-less.html'),
        `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Runtime-less deck</title>
<style>.slide { position: relative; overflow: hidden; }</style>
</head>
<body>
<main data-ppt-deck>
<section class="slide" data-slide-id="s1" style="width:1600px;height:900px"><h1>Runtime-less one</h1></section>
<section class="slide" data-slide-id="s2" style="width:1600px;height:900px"><h1>Runtime-less two</h1></section>
</main>
</body>
</html>
`,
        'utf8'
      );

      await execa('node', [cliPath, 'validate', 'runtime-less.html'], {
        cwd: directory
      });
      await execa(
        'node',
        [cliPath, 'export', 'runtime-less.html', '--format', 'html'],
        { cwd: directory }
      );

      const exported = await readFile(
        join(directory, 'runtime-less.export.html'),
        'utf8'
      );
      expect(exported.match(/data-ppt-runtime="1"/g)).toHaveLength(1);

      staticServer = await serveHtml(exported);
      await page.goto(staticServer.url);
      await expect(page.locator('[data-slide-id="s1"]')).toBeVisible();
      await expect(page.locator('[data-slide-id="s2"]')).toBeHidden();

      await page.keyboard.press('ArrowRight');
      await expect(page.locator('[data-slide-id="s2"]')).toBeVisible();
      await expect(page.locator('[data-slide-id="s1"]')).toBeHidden();
      expect(page.url()).toContain('#/2');

      await page.keyboard.press('ArrowLeft');
      await expect(page.locator('[data-slide-id="s1"]')).toBeVisible();
      await expect(page.locator('[data-slide-id="s2"]')).toBeHidden();
      expect(page.url()).toContain('#/1');
    } finally {
      if (staticServer) await staticServer.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  'editor reports an external writer and reloads its content',
  { tag: '@feature:skeleton' },
  async ({ page }) => {
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-e2e-'));
    let host: Awaited<ReturnType<typeof startCliHost>> | undefined;
    try {
      const initial = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Contested deck</title>
<style>.slide { width: 1600px; height: 900px; }</style>
</head>
<body>
<main data-ppt-deck>
<section class="slide" data-slide-id="s1"><h1>Original heading</h1></section>
<section class="slide" data-slide-id="s2"><h1>Second slide</h1></section>
</main>
</body>
</html>
`;
      const external = initial.replace(
        'Original heading',
        'External writer wins'
      );
      await writeFile(join(directory, 'contested.html'), initial, 'utf8');

      host = await startCliHost(cliPath, directory, 'contested.html');
      await page.goto(host.url);
      const frame = page.frameLocator('iframe[title="投影片預覽"]');
      await expect(frame.locator('h1')).toContainText('Original heading');

      await writeFile(join(directory, 'contested.html'), external, 'utf8');

      await frame.locator('h1').dblclick();
      await frame.locator('h1').fill('Editor tries to save');
      await frame.locator('h1').press('Escape');
      await expect(page.getByTestId('save-status')).toHaveText('儲存失敗');

      const onDisk = await readFile(join(directory, 'contested.html'), 'utf8');
      expect(onDisk).toContain('External writer wins');
      expect(onDisk).not.toContain('Editor tries to save');

      await page.reload();
      await expect(frame.locator('h1')).toContainText('External writer wins');
      await expect(page.getByTestId('save-status')).toHaveText('已載入');
    } finally {
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

test(
  'queues burst commits so both edits reach the file',
  { tag: '@feature:skeleton' },
  async ({ page }) => {
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-e2e-'));
    let host: Awaited<ReturnType<typeof startCliHost>> | undefined;
    try {
      await execa('node', [cliPath, 'new', 'burst.html', '--slides', '2'], {
        cwd: directory
      });
      host = await startCliHost(cliPath, directory, 'burst.html');
      await page.goto(host.url);
      const frame = page.frameLocator('iframe[title="投影片預覽"]');
      await expect(frame.locator('h1')).toContainText('Untitled deck');

      const putStatuses: number[] = [];
      page.on('response', (response) => {
        if (
          response.request().method() === 'PUT' &&
          new URL(response.url()).pathname === '/api/deck'
        ) {
          putStatuses.push(response.status());
        }
      });

      // Dispatch the same events the app's own handlers listen for: two
      // complete edit-and-blur cycles in one task, before the first save can
      // resolve.
      await frame.locator('body').evaluate((body) => {
        const scope = body as unknown as {
          querySelector(selector: string): {
            dispatchEvent(event: unknown): boolean;
            textContent: string | null;
          } | null;
          ownerDocument: {
            defaultView: {
              MouseEvent: new (type: string, init: object) => unknown;
              FocusEvent: new (type: string, init: object) => unknown;
            } | null;
          };
        };
        const view = scope.ownerDocument.defaultView;
        if (!view) throw new Error('Preview has no window.');
        const edit = (selector: string, text: string) => {
          const target = scope.querySelector(selector);
          if (!target) throw new Error(`Missing ${selector}`);
          target.dispatchEvent(
            new view.MouseEvent('dblclick', {
              bubbles: true,
              cancelable: true
            })
          );
          target.textContent = text;
          target.dispatchEvent(
            new view.FocusEvent('focusout', { bubbles: true })
          );
        };
        edit('h1', 'Burst first edit');
        edit('.kicker', 'Burst second edit');
      });

      await expect.poll(() => putStatuses.length).toBe(2);
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
      // Let any late duplicate commit arrive before pinning the burst count.
      await page.waitForTimeout(300);
      expect(putStatuses).toEqual([200, 200]);

      const saved = await readFile(join(directory, 'burst.html'), 'utf8');
      expect(saved).toContain('Burst first edit');
      expect(saved).toContain('Burst second edit');
      expect(saved).not.toContain('contenteditable');
      expect(saved).not.toContain('data-ppt-editing');
      expect(saved).not.toContain('data-ppt-frame-slide');
      const headingTag = /<h1[^>]*>/.exec(saved)?.[0] ?? '';
      expect(headingTag).not.toBe('');
      expect(headingTag).not.toContain('contenteditable');
    } finally {
      await host?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

const AUTHORED_EDITABLE_DECK = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Authored editable deck</title>
<style>.slide { width: 800px; height: 600px; }</style>
</head>
<body>
<main data-ppt-deck>
<section class="slide" data-slide-id="s1">
<div id="authored" contenteditable="true">Authored region</div>
<div id="locked" contenteditable="false">Locked region</div>
<h1>Editable heading</h1>
</section>
<section class="slide" data-slide-id="s2"><h1>Second slide</h1></section>
</main>
</body>
</html>
`;

test(
  'commits the edited element and keeps authored contenteditable',
  { tag: '@feature:skeleton' },
  async ({ page }) => {
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-e2e-'));
    let host: Awaited<ReturnType<typeof startCliHost>> | undefined;
    try {
      await writeFile(
        join(directory, 'authored.html'),
        AUTHORED_EDITABLE_DECK,
        'utf8'
      );
      host = await startCliHost(cliPath, directory, 'authored.html');
      await page.goto(host.url);
      const frame = page.frameLocator('iframe[title="投影片預覽"]');
      await expect(frame.locator('h1')).toContainText('Editable heading');

      await frame.locator('h1').dblclick();
      await frame.locator('h1').fill('Edited heading');
      await frame.locator('h1').press('Escape');
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      const saved = await readFile(join(directory, 'authored.html'), 'utf8');
      expect(saved).toContain('Edited heading');
      expect(saved).toMatch(/<div id="authored"[^>]*contenteditable="true"/);
      expect(saved).toMatch(/<div id="locked"[^>]*contenteditable="false"/);
      expect(saved).not.toContain('data-ppt-editing');
      await expect(frame.locator('h1')).not.toHaveAttribute(
        'contenteditable',
        'true'
      );
    } finally {
      await host?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  'focusing an authored editable does not trigger a save',
  { tag: '@feature:skeleton' },
  async ({ page }) => {
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-e2e-'));
    let host: Awaited<ReturnType<typeof startCliHost>> | undefined;
    try {
      await writeFile(
        join(directory, 'authored.html'),
        AUTHORED_EDITABLE_DECK,
        'utf8'
      );
      host = await startCliHost(cliPath, directory, 'authored.html');
      await page.goto(host.url);
      const frame = page.frameLocator('iframe[title="投影片預覽"]');
      await expect(frame.locator('h1')).toContainText('Editable heading');

      const puts: string[] = [];
      page.on('request', (request) => {
        if (
          request.method() === 'PUT' &&
          new URL(request.url()).pathname === '/api/deck'
        ) {
          puts.push(request.url());
        }
      });

      await frame.locator('#authored').click();
      await page.getByRole('button', { name: '下一頁' }).click();
      await expect(frame.locator('h1')).toContainText('Second slide');
      await page.waitForTimeout(500);

      expect(puts).toEqual([]);
      await expect(page.getByTestId('save-status')).toHaveText('已載入');
      const saved = await readFile(join(directory, 'authored.html'), 'utf8');
      expect(saved).toMatch(/<div id="authored"[^>]*contenteditable="true"/);
      expect(saved).toMatch(/<div id="locked"[^>]*contenteditable="false"/);
    } finally {
      await host?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  'preview preserves body and ancestor scoped CSS',
  { tag: '@feature:skeleton' },
  async ({ page }) => {
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-e2e-'));
    let host: Awaited<ReturnType<typeof startCliHost>> | undefined;
    let staticServer: Awaited<ReturnType<typeof serveHtml>> | undefined;
    try {
      const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Themed deck</title>
<style>
.slide { width: 800px; height: 600px; }
body.theme-midnight .slide { background: rgb(12, 34, 56); }
main[data-ppt-deck] > .slide h1 { color: rgb(250, 204, 21); }
</style>
</head>
<body class="theme-midnight" data-theme="midnight">
<main data-ppt-deck>
<section class="slide" data-slide-id="s1"><h1>Themed heading</h1></section>
<section class="slide" data-slide-id="s2"><h1>Second slide</h1></section>
</main>
</body>
</html>
`;
      await writeFile(join(directory, 'themed.html'), html, 'utf8');
      staticServer = await serveHtml(html);
      await page.goto(staticServer.url);
      const readStyles = (body: unknown) => {
        const scope = body as {
          querySelector(selector: string): unknown;
          ownerDocument: {
            defaultView: {
              getComputedStyle(element: unknown): {
                backgroundColor: string;
                color: string;
              };
            } | null;
          };
        };
        const view = scope.ownerDocument.defaultView;
        const slide = scope.querySelector('[data-slide-id="s1"]');
        const heading = scope.querySelector('[data-slide-id="s1"] h1');
        if (!view || !slide || !heading) throw new Error('Slide is missing');
        return {
          background: view.getComputedStyle(slide).backgroundColor,
          color: view.getComputedStyle(heading).color
        };
      };
      const authored = await page.locator('body').evaluate(readStyles);
      expect(authored).toEqual({
        background: 'rgb(12, 34, 56)',
        color: 'rgb(250, 204, 21)'
      });

      host = await startCliHost(cliPath, directory, 'themed.html');
      await page.goto(host.url);
      const frame = page.frameLocator('iframe[title="投影片預覽"]');
      await expect(frame.locator('h1')).toContainText('Themed heading');
      const preview = await frame.locator('body').evaluate(readStyles);

      expect(preview).toEqual(authored);
    } finally {
      await staticServer?.close();
      await host?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  'preview keeps the body fallback background',
  { tag: '@feature:skeleton' },
  async ({ page }) => {
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-e2e-'));
    let host: Awaited<ReturnType<typeof startCliHost>> | undefined;
    let staticServer: Awaited<ReturnType<typeof serveHtml>> | undefined;
    try {
      const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Body fallback deck</title>
<style>
body {
  margin: 0;
  background: linear-gradient(45deg, rgb(17, 24, 39), rgb(49, 46, 129));
  color: rgb(248, 250, 252);
}
</style>
</head>
<body>
<h1>Body fallback</h1>
<p>Light text on a dark canvas</p>
</body>
</html>
`;
      await writeFile(join(directory, 'fallback.html'), html, 'utf8');
      staticServer = await serveHtml(html);
      await page.goto(staticServer.url);
      const readStyles = (body: unknown) => {
        const scope = body as {
          ownerDocument: {
            defaultView: {
              getComputedStyle(element: unknown): {
                backgroundImage: string;
                color: string;
              };
            } | null;
          };
        };
        const view = scope.ownerDocument.defaultView;
        if (!view) throw new Error('Preview has no window.');
        const style = view.getComputedStyle(body);
        return {
          backgroundImage: style.backgroundImage,
          color: style.color
        };
      };
      const authored = await page.locator('body').evaluate(readStyles);
      expect(authored.backgroundImage).not.toBe('none');
      expect(authored.color).toBe('rgb(248, 250, 252)');

      host = await startCliHost(cliPath, directory, 'fallback.html');
      await page.goto(host.url);
      const frame = page.frameLocator('iframe[title="投影片預覽"]');
      await expect(frame.locator('h1')).toContainText('Body fallback');
      const preview = await frame.locator('body').evaluate(readStyles);

      expect(preview).toEqual(authored);
    } finally {
      await staticServer?.close();
      await host?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
);
