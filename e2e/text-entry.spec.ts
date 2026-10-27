import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { startCliHost } from './helpers';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'packages/cli/dist/bin.js');
const FRAME_SELECTOR = 'iframe[title="投影片預覽"]';

const DECK = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Text entry</title>
<style>
  html, body { margin: 0; padding: 0; }
  .slide { width: 1600px; height: 900px; position: relative; background: #f7f5ef; color: #17181c; font-family: system-ui, sans-serif; }
  h1 { position: absolute; left: 120px; top: 160px; margin: 0; font-size: 72px; font-weight: 400; }
  .box { position: absolute; left: 120px; top: 360px; font-size: 32px; }
  .locked { position: absolute; left: 120px; top: 520px; font-size: 32px; }
</style></head>
<body>
<main data-ppt-deck>
  <section class="slide" data-slide-id="s1" data-width="1600" data-height="900">
    <h1 data-ppt-el="title">Heading</h1>
    <div class="box" data-ppt-el="box">Box text</div>
    <h2 class="locked" data-ppt-el="locked" data-ppt-locked="true">Locked text</h2>
    <div class="box" data-ppt-el="empty-box" style="top:680px"></div>
    <div data-ppt-el="wrapper" style="position:absolute;left:120px;top:760px;font-size:32px"><span>First</span><span>Second</span></div>
  </section>
</main>
</body></html>`;

async function openDeck(page: Page) {
  const directory = await mkdtemp(join(tmpdir(), 'htmlppt-text-entry-'));
  const file = 'text.html';
  await writeFile(join(directory, file), DECK, 'utf8');
  const host = await startCliHost(cliPath, directory, file);
  await page.goto(host.url);
  const frame = page.frameLocator(FRAME_SELECTOR);
  await expect(frame.getByRole('heading', { name: 'Heading' })).toBeVisible();
  await expect(page.getByTestId('save-status')).toHaveText('已同步');
  return {
    directory,
    file,
    host,
    path: join(directory, file),
    frame,
    async close() {
      await host.stop();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

function waitForDeckSave(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === '/api/deck'
  );
}

test.describe('text entry @feature:text-entry', () => {
  test('single click exposes formatting and Bold persists', async ({ page }) => {
    const deck = await openDeck(page);
    try {
      await deck.frame.locator('[data-ppt-el="title"]').click();
      const toolbar = page.getByTestId('text-toolbar');
      await expect(toolbar).toBeVisible();
      await expect(toolbar).toHaveAttribute('data-mode', 'selection');

      const bold = page.getByTestId('text-bold');
      await expect(bold).toHaveAttribute('aria-pressed', 'false');
      const save = waitForDeckSave(page);
      await bold.click();
      expect((await save).ok()).toBeTruthy();
      await expect
        .poll(() => readFile(deck.path, 'utf8'))
        .toMatch(/font-weight:\s*(bold|700)/i);
      await expect.poll(async () => bold.getAttribute('aria-pressed')).toBe(
        'true'
      );
    } finally {
      await deck.close();
    }
  });
});
