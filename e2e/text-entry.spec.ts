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
    <div class="box" data-ppt-el="empty-box" style="top:680px;width:320px;height:60px"></div>
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

  test('Edit text enters inline editing and saves', async ({ page }) => {
    const deck = await openDeck(page);
    try {
      await deck.frame.locator('[data-ppt-el="title"]').click();
      await page.getByTestId('inspector-tab-text').click();
      const edit = page.getByTestId('inspector-edit-text');
      await expect(edit).toBeVisible();
      await edit.click();
      await expect(page.getByTestId('text-toolbar')).toHaveAttribute(
        'data-mode',
        'editing'
      );
      const editable = deck.frame.locator('h1[contenteditable="true"]');
      await expect(editable).toBeVisible();
      await page.keyboard.press('End');
      await page.keyboard.type(' edited');
      const save = waitForDeckSave(page);
      await deck.frame.locator('body').click({ position: { x: 5, y: 5 } });
      expect((await save).ok()).toBeTruthy();
      await expect
        .poll(() => readFile(deck.path, 'utf8'))
        .toContain('Heading edited');
    } finally {
      await deck.close();
    }
  });

  test('keyboard-only selection opens Edit text and commits', async ({ page }) => {
    const deck = await openDeck(page);
    try {
      const row = page.locator(
        '[data-testid="object-row"][data-object-id="title"]'
      );
      await row.focus();
      await page.keyboard.press('Enter');
      await expect(row).toHaveAttribute('aria-current', 'true');

      const tab = page.getByTestId('inspector-tab-text');
      await tab.focus();
      await page.keyboard.press('Enter');

      const edit = page.getByTestId('inspector-edit-text');
      await expect(edit).toBeVisible();
      await edit.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('text-toolbar')).toHaveAttribute(
        'data-mode',
        'editing'
      );

      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.type('Keyboard heading');
      const save = waitForDeckSave(page);
      await page.keyboard.press('Escape');
      expect((await save).ok()).toBeTruthy();
      await expect
        .poll(() => readFile(deck.path, 'utf8'))
        .toContain('Keyboard heading');
    } finally {
      await deck.close();
    }
  });

  test('wrapper objects resolve their first editable leaf', async ({ page }) => {
    const deck = await openDeck(page);
    try {
      await deck.frame.locator('[data-ppt-el="wrapper"]').click();
      await expect(page.getByTestId('text-toolbar')).toBeVisible();
      await page.getByTestId('inspector-tab-text').click();
      await expect(page.getByTestId('inspector-text-hint')).toContainText(
        'First'
      );

      const save = waitForDeckSave(page);
      await page.getByTestId('text-bold').click();
      expect((await save).ok()).toBeTruthy();
      const html = await readFile(deck.path, 'utf8');
      expect(html).toMatch(
        /<span style="[^"]*font-weight:\s*bold[^"]*">First<\/span>/
      );
      expect(html).not.toMatch(
        /<span style="[^"]*font-weight[^"]*">Second<\/span>/
      );
    } finally {
      await deck.close();
    }
  });

  test('Ctrl/Cmd+B/I/U format the selection or the whole leaf', async ({ page }) => {
    const deck = await openDeck(page);
    try {
      await deck.frame.locator('[data-ppt-el="title"]').click();
      const boldSave = waitForDeckSave(page);
      await page.keyboard.press('ControlOrMeta+b');
      expect((await boldSave).ok()).toBeTruthy();
      await expect
        .poll(() => readFile(deck.path, 'utf8'))
        .toMatch(/font-weight:\s*(bold|700)/i);

      await deck.frame.locator('[data-ppt-el="title"]').dblclick();
      await expect(page.getByTestId('text-toolbar')).toHaveAttribute(
        'data-mode',
        'editing'
      );
      await deck.frame.locator('[data-ppt-el="title"]').evaluate((element) => {
        const walker = element.ownerDocument.createTreeWalker(
          element,
          NodeFilter.SHOW_TEXT
        );
        const text = walker.nextNode();
        if (!text) throw new Error('The heading has no text node.');
        const range = element.ownerDocument.createRange();
        range.setStart(text, 0);
        range.setEnd(text, 4);
        const selection = element.ownerDocument.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      });
      const italicSave = waitForDeckSave(page);
      await page.keyboard.press('ControlOrMeta+i');
      await page.keyboard.press('Escape');
      expect((await italicSave).ok()).toBeTruthy();
      await expect
        .poll(() => readFile(deck.path, 'utf8'))
        .toMatch(
          /<span style="[^"]*font-style:\s*italic[^"]*">Head<\/span>ing/
        );
    } finally {
      await deck.close();
    }
  });

  test('guarded, empty, and multi selections expose the right Text tab state', async ({ page }) => {
    const deck = await openDeck(page);
    try {
      await deck.frame.locator('[data-ppt-el="locked"]').click({ force: true });
      await page
        .locator('[data-testid="object-row"][data-object-id="locked"]')
        .click();
      await page.getByTestId('inspector-tab-text').click();
      await expect(page.getByTestId('inspector-text-blocked')).toBeVisible();
      await expect(page.getByTestId('inspector-text-blocked')).toContainText(
        '已鎖定'
      );
      await expect(page.getByTestId('inspector-edit-text')).toHaveCount(0);
      await expect(page.getByTestId('text-toolbar')).toHaveCount(0);

      await deck.frame.locator('[data-ppt-el="empty-box"]').click();
      await page.getByTestId('inspector-tab-text').click();
      await expect(page.getByTestId('inspector-edit-text')).toBeVisible();
      await expect(page.getByTestId('text-toolbar')).toHaveCount(0);
      await page.getByTestId('inspector-edit-text').click();
      await page.keyboard.type('New text');
      const save = waitForDeckSave(page);
      await deck.frame.locator('body').click({ position: { x: 5, y: 5 } });
      expect((await save).ok()).toBeTruthy();
      await expect
        .poll(() => readFile(deck.path, 'utf8'))
        .toContain('New text');
      await deck.frame.locator('[data-ppt-el="empty-box"]').click();
      await expect(page.getByTestId('text-toolbar')).toBeVisible();

      await deck.frame.locator('[data-ppt-el="title"]').click();
      await deck.frame
        .locator('[data-ppt-el="box"]')
        .click({ modifiers: ['Shift'] });
      await expect(page.getByTestId('text-toolbar')).toHaveCount(0);
      await page.getByTestId('inspector-tab-text').click();
      await expect(page.getByTestId('inspector-text-multi')).toBeVisible();
    } finally {
      await deck.close();
    }
  });
});
