import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { startCliHost } from './helpers';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'packages/cli/dist/bin.js');

const DECK = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Export UI deck</title>
<style>
  .slide { width: 320px; height: 180px; background: #ffffff; position: relative; }
</style>
</head>
<body>
<main data-ppt-deck>
<section class="slide" data-slide-id="s1" data-width="320" data-height="180">
  <h1 data-ppt-el="title" style="position:absolute;left:24px;top:48px">Export UI</h1>
</section>
</main>
</body>
</html>
`;

async function exportViaMenu(
  page: Page,
  format: 'HTML' | 'PDF' | 'PNG'
) {
  const response = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === '/api/export' &&
      candidate.request().method() === 'POST'
  );
  await page.getByTestId('export-open').click();
  await page.getByTestId(`export-${format.toLowerCase()}`).click();
  return response;
}

test(
  'the toolbar exports HTML, PDF, and PNG through the host',
  { tag: '@feature:export-pdf-png' },
  async ({ page }) => {
    test.setTimeout(120_000);
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-export-ui-'));
    let host: Awaited<ReturnType<typeof startCliHost>> | undefined;
    try {
      await writeFile(join(directory, 'fixture.html'), DECK, 'utf8');
      host = await startCliHost(cliPath, directory, 'fixture.html');
      await page.goto(host.url);
      await expect(page.getByTestId('save-status')).toHaveText('已同步');
      await expect(page.getByTestId('export-open')).toBeEnabled();
      const htmlResponse = await exportViaMenu(page, 'HTML');
      expect(htmlResponse.status()).toBe(200);
      let exportedHtml = '';
      await expect
        .poll(async () => {
          try {
            exportedHtml = await readFile(
              join(directory, 'fixture.export.html'),
              'utf8'
            );
            return true;
          } catch {
            return false;
          }
        })
        .toBe(true);
      expect(exportedHtml).toContain(
        '<!-- Edited with htmlppt. Format: htmldeck/v1. -->'
      );
      expect(exportedHtml).toContain('Export UI');
      expect(await readFile(join(directory, 'fixture.html'), 'utf8')).toBe(
        DECK
      );
      await expect(page.getByTestId('export-result')).toContainText(
        'fixture.export.html'
      );

      const pdfResponse = await exportViaMenu(page, 'PDF');
      expect(pdfResponse.status()).toBe(200);
      await expect.poll(async () => {
        try {
          const bytes = await readFile(join(directory, 'fixture.pdf'));
          return bytes.subarray(0, 5).toString('latin1');
        } catch {
          return '';
        }
      }).toBe('%PDF-');

      const pngResponse = await exportViaMenu(page, 'PNG');
      expect(pngResponse.status()).toBe(200);
      const png = await readFile(join(directory, 'fixture-s1.png'));
      expect([...png.subarray(1, 4)].map((byte) => String.fromCharCode(byte))).toEqual([
        'P',
        'N',
        'G'
      ]);
      await stat(join(directory, 'fixture-s1.png'));

      // The documented export shortcut opens the same menu without a mouse.
      await page.keyboard.press('ControlOrMeta+Shift+E');
      await expect(page.getByTestId('export-menu')).toBeVisible();
      // The menu handles Escape on itself, so focus must have moved inside it;
      // waiting for visibility alone races the focus effect on slow runners.
      await expect(page.getByTestId('export-html')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('export-menu')).toHaveCount(0);
      await expect(page.getByTestId('export-open')).toBeFocused();
    } finally {
      await host?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
);
