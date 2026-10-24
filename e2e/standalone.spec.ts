import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { startStaticEditor } from './helpers';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const editorDir = join(repoRoot, 'packages/editor/dist');

const DECK = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Standalone deck</title>
<style>
  .slide { width: 960px; height: 540px; background: #ffffff; position: relative; }
</style>
</head>
<body>
<main data-ppt-deck>
<section class="slide" data-slide-id="s1" data-width="960" data-height="540">
  <h1 data-ppt-el="title" style="position:absolute;left:80px;top:120px">Standalone edit</h1>
</section>
</main>
</body>
</html>
`;

async function openDeck(page: Page, directory: string): Promise<void> {
  await page.getByTestId('standalone-file').setInputFiles(join(directory, 'standalone.html'));
  await expect(page.getByTestId('save-status')).toHaveText('已開啟');
  await expect(
    page.frameLocator('iframe[title="投影片預覽"]').locator('[data-ppt-el="title"]')
  ).toHaveText('Standalone edit');
}

test.describe('standalone editor fallback', () => {
  test(
    'opens an uploaded deck, saves through download, and disables PDF/PNG',
    { tag: '@feature:standalone' },
    async ({ page }) => {
      test.setTimeout(120_000);
      const directory = await mkdtemp(join(tmpdir(), 'htmlppt-standalone-'));
      const editor = await startStaticEditor(editorDir);
      try {
        await writeFile(join(directory, 'standalone.html'), DECK, 'utf8');
        await page.goto(editor.url);
        await expect(page.getByTestId('standalone-drop')).toBeVisible();
        await expect(page.locator('code')).toHaveText(
          'htmlppt open deck.html'
        );
        await openDeck(page, directory);
        await expect(page.getByTestId('toolbar')).toBeVisible();

        const frame = page.frameLocator('iframe[title="投影片預覽"]');
        await frame.locator('[data-ppt-el="title"]').click();
        await page.keyboard.press('ArrowRight');
        await expect(frame.locator('[data-ppt-el="title"]')).toHaveCSS(
          'left',
          '81px'
        );
        await expect(page.getByTestId('save-status')).toHaveText('已暫存', {
          timeout: 15_000
        });

        // Explicit save downloads the deck; the upload-only browser has no
        // writable file handle. Autosave has already kept a crash draft.
        await page.getByTestId('export-open').focus();
        const saved = page.waitForEvent('download');
        await page.keyboard.press('ControlOrMeta+s');
        const download = await saved;
        expect(download.suggestedFilename()).toBe('standalone.html');
        const savedPath = await download.path();
        expect(savedPath).toBeTruthy();
        const savedHtml = await readFile(savedPath as string, 'utf8');
        expect(savedHtml).toContain('left: 81px');
        expect(savedHtml).toContain('data-ppt-deck');

        await page.getByTestId('export-open').click();
        await expect(page.getByTestId('export-pdf')).toBeDisabled();
        await expect(page.getByTestId('export-png')).toBeDisabled();
        const exported = page.waitForEvent('download');
        await page.getByTestId('export-html').click();
        const exportDownload = await exported;
        expect(exportDownload.suggestedFilename()).toBe(
          'standalone.export.html'
        );
        const exportHtml = await readFile(
          (await exportDownload.path()) as string,
          'utf8'
        );
        expect(exportHtml).toContain(
          '<!-- Edited with htmlppt. Format: htmldeck/v1. -->'
        );
        expect(exportHtml).toContain('left: 81px');
      } finally {
        await editor.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  test(
    'offers a crash-recovery draft after a reload and clears it after restore',
    { tag: '@feature:recovery' },
    async ({ page }) => {
      test.setTimeout(120_000);
      const directory = await mkdtemp(join(tmpdir(), 'htmlppt-recovery-'));
      const editor = await startStaticEditor(editorDir);
      try {
        await writeFile(join(directory, 'standalone.html'), DECK, 'utf8');
        await page.goto(editor.url);
        await openDeck(page, directory);

        const frame = page.frameLocator('iframe[title="投影片預覽"]');
        await frame.locator('[data-ppt-el="title"]').click();
        await page.keyboard.press('ArrowRight');
        await expect(frame.locator('[data-ppt-el="title"]')).toHaveCSS(
          'left',
          '81px'
        );
        await expect(page.getByTestId('save-status')).toHaveText('已暫存', {
          timeout: 15_000
        });

        await page.reload();
        const draft = page.getByTestId('recovery-draft');
        await expect(draft).toHaveCount(1);
        await expect(draft).toContainText('standalone.html');
        await page.getByTestId('recovery-restore').click();
        await expect(
          page.frameLocator('iframe[title="投影片預覽"]').locator('[data-ppt-el="title"]')
        ).toHaveCSS('left', '81px');
        await expect(page.getByTestId('save-status')).toHaveText('已暫存', {
          timeout: 15_000
        });

        // An explicit download is the only durable save in upload mode, so it
        // is what clears the crash draft.
        await page.getByTestId('export-open').focus();
        const saved = page.waitForEvent('download');
        await page.keyboard.press('ControlOrMeta+s');
        await saved;
        await page.reload();
        await expect(page.getByTestId('standalone-drop')).toBeVisible();
        await expect(page.getByTestId('recovery-draft')).toHaveCount(0);
      } finally {
        await editor.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
});
