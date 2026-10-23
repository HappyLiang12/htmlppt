import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { execa } from 'execa';
import { startCliHost } from './helpers';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'packages/cli/dist/bin.js');

async function createDeck(directory: string): Promise<void> {
  await execa('node', [cliPath, 'new', 'deck.html', '--slides', '2'], {
    cwd: directory
  });
}

test.describe('language switching', () => {
  test.use({ locale: 'zh-TW' });

  test('switches language, updates html lang, and persists', async ({
    page
  }) => {
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-i18n-'));
    await createDeck(directory);
    const host = await startCliHost(cliPath, directory, 'deck.html');
    try {
      await page.goto(host.url);
      await expect(page.getByTestId('locale-select')).toBeVisible();
      await expect(page.getByTestId('locale-select')).toHaveAttribute(
        'aria-label',
        '語言'
      );
      await expect(
        page.getByTestId('locale-select').locator('option')
      ).toHaveText(['English', '繁體中文', '简体中文']);
      await expect(page.getByTestId('shortcuts-open')).toHaveText('快速鍵');
      await page.getByTestId('locale-select').selectOption('en');
      await expect(page.getByTestId('locale-select')).toHaveAttribute(
        'aria-label',
        'Language'
      );
      await expect(
        page.getByTestId('locale-select').locator('option')
      ).toHaveText(['English', '繁體中文', '简体中文']);
      await expect(page.getByTestId('shortcuts-open')).toHaveText('Shortcuts');
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await page.reload();
      await expect(page.getByTestId('shortcuts-open')).toHaveText('Shortcuts');
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expect(page.getByTestId('locale-select')).toHaveValue('en');
    } finally {
      await host.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test.describe('browser language detection', () => {
  test.use({ locale: 'zh-CN' });

  test('uses Simplified Chinese on first visit', async ({ page }) => {
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-i18n-cn-'));
    await createDeck(directory);
    const host = await startCliHost(cliPath, directory, 'deck.html');
    try {
      await page.goto(host.url);
      await expect(page.getByTestId('shortcuts-open')).toHaveText('快捷键');
      await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');
      await expect(page.getByTestId('locale-select')).toHaveValue('zh-Hans');
      await expect(page.getByTestId('locale-select')).toHaveAttribute(
        'aria-label',
        '语言'
      );
      await expect(
        page.getByTestId('locale-select').locator('option')
      ).toHaveText(['English', '繁體中文', '简体中文']);
    } finally {
      await host.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
