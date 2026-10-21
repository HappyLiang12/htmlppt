import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { execa } from 'execa';
import { serveHtml, startCliHost } from './helpers';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'packages/cli/dist/bin.js');

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

      staticServer = await serveHtml(exported);
      await page.goto(staticServer.url);
      await expect(page.locator('[data-slide-id="s1"]')).toBeVisible();
      await expect(page.locator('[data-slide-id="s2"]')).toBeHidden();
      await page.keyboard.press('ArrowRight');
      await expect(page.locator('[data-slide-id="s2"]')).toBeVisible();
      expect(page.url()).toContain('#/2');
    } finally {
      if (staticServer) await staticServer.close();
      await host?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
);
