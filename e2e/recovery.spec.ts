import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { startCliHost } from './helpers';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'packages/cli/dist/bin.js');

const DECK = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Recovery deck</title>
<style>
  .slide { width: 960px; height: 540px; background: #ffffff; position: relative; }
</style>
</head>
<body>
<main data-ppt-deck>
<section class="slide" data-slide-id="s1" data-width="960" data-height="540">
  <h1 data-ppt-el="title" style="position:absolute;left:80px;top:120px">Recovery</h1>
</section>
</main>
</body>
</html>
`;

const DRAFT_EXISTS = `new Promise((resolve) => {
  const request = indexedDB.open('htmlppt-editor', 1);
  request.onerror = () => resolve(false);
  request.onsuccess = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains('drafts')) { db.close(); resolve(false); return; }
    const tx = db.transaction('drafts', 'readonly');
    const all = tx.objectStore('drafts').getAll();
    all.onsuccess = () => { db.close(); resolve(all.result.length > 0); };
    all.onerror = () => { db.close(); resolve(false); };
  };
})`;

test(
  'recovers an unsaved host edit after a crashed save',
  { tag: '@feature:recovery' },
  async ({ page, context }) => {
    test.setTimeout(120_000);
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-host-recovery-'));
    const deckPath = join(directory, 'recovery.html');
    let host: Awaited<ReturnType<typeof startCliHost>> | undefined;
    try {
      await writeFile(deckPath, DECK, 'utf8');
      host = await startCliHost(cliPath, directory, 'recovery.html');
      await page.goto(host.url);
      await expect(page.getByTestId('save-status')).toHaveText('已同步');

      // Simulate a crash before autosave reaches the host. The context route
      // also covers the reopened page until the draft is restored.
      await context.route('**/api/deck', (route) =>
        route.request().method() === 'PUT' ? route.abort() : route.continue()
      );
      const frame = page.frameLocator('iframe[title="投影片預覽"]');
      await frame.locator('[data-ppt-el="title"]').click();
      await page.keyboard.press('ArrowRight');
      await expect(frame.locator('[data-ppt-el="title"]')).toHaveCSS(
        'left',
        '81px'
      );
      await expect
        .poll(() => page.evaluate<boolean>(DRAFT_EXISTS), { timeout: 15_000 })
        .toBe(true);

      // Closing without unload is the crash: no keepalive flush runs.
      await page.close({ runBeforeUnload: false });
      const reopened = await context.newPage();
      await reopened.goto(host.url);

      const banner = reopened.getByTestId('recovery-banner');
      await expect(banner).toBeVisible();
      await expect(banner).toContainText('recovery.html');
      await context.unroute('**/api/deck');
      await reopened.getByTestId('recovery-restore').click();
      await expect(reopened.getByTestId('save-status')).toHaveText('已儲存', {
        timeout: 15_000
      });
      await expect
        .poll(async () => readFile(deckPath, 'utf8'))
        .toContain('left: 81px');

      // A successful save clears the draft.
      await expect
        .poll(async () => reopened.evaluate<boolean>(DRAFT_EXISTS))
        .toBe(false);
      await reopened.reload();
      await expect(reopened.getByTestId('recovery-banner')).toHaveCount(0);
    } finally {
      await host?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
);
