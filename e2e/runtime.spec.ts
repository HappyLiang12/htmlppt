import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { execa } from 'execa';
import { serveHtml } from './helpers';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'packages/cli/dist/bin.js');

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
      } finally {
        await context.close();
        await server.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('prints every slide and restores screen state', { tag: '@feature:runtime' }, async ({ page }) => {
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-runtime-'));
    try {
      await execa('node', [cliPath, 'new', 'deck.html', '--slides', '2'], { cwd: directory });
      const html = await readFile(join(directory, 'deck.html'), 'utf8');
      const server = await serveHtml(html);
      try {
        await page.goto(server.url);
        await expect(page.locator('[data-slide-id="s2"]')).toBeHidden();
        await page.emulateMedia({ media: 'print' });
        await expect(page.locator('[data-slide-id="s2"]')).toBeVisible();
        await page.emulateMedia({ media: 'screen' });
        await expect(page.locator('[data-slide-id="s2"]')).toBeHidden();
        await page.keyboard.press('ArrowRight');
        await expect(page.locator('[data-slide-id="s2"]')).toBeVisible();
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
        await page.locator('#probe').focus();
        await page.keyboard.press('ArrowRight');
        expect(page.url()).toContain('#/1');
        await page.locator('body').click({ position: { x: 10, y: 10 } });
        await page.keyboard.press('ArrowRight');
        await expect(page.locator('[data-slide-id="s2"]')).toBeVisible();
        expect(page.url()).toContain('#/2');
      } finally {
        await server.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
