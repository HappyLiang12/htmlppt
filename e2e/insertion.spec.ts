import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expect,
  test,
  type FrameLocator,
  type Page
} from '@playwright/test';
import { execa } from 'execa';
import { startCliHost } from './helpers';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'packages/cli/dist/bin.js');
const FRAME_SELECTOR = 'iframe[title="投影片預覽"]';
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TINY_GIF = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const PNG_URL = `data:image/png;base64,${TINY_PNG}`;
const GIF_URL = `data:image/gif;base64,${TINY_GIF}`;

interface Harness {
  directory: string;
  file: string;
  host: Awaited<ReturnType<typeof startCliHost>>;
  frame: FrameLocator;
}

async function openDeck(page: Page): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'htmlppt-insert-e2e-'));
  const file = 'insert.html';
  let host: Harness['host'] | null = null;
  try {
    await execa('node', [cliPath, 'new', file, '--slides', '1'], {
      cwd: directory
    });
    host = await startCliHost(cliPath, directory, file);
    await page.goto(host.url);
    const frame = page.frameLocator(FRAME_SELECTOR);
    await expect(frame.locator('[data-slide-id]')).toBeVisible();
    await expect(page.getByTestId('save-status')).toHaveText('已同步');
    return { directory, file, host, frame };
  } catch (error) {
    if (host) await host.stop();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function close(harness: Harness): Promise<void> {
  await harness.host.stop();
  await rm(harness.directory, { recursive: true, force: true });
}

function deckHtml(harness: Harness): Promise<string> {
  return readFile(join(harness.directory, harness.file), 'utf8');
}

async function waitForSaved(page: Page): Promise<void> {
  await expect(page.getByTestId('save-status')).toHaveText('已儲存', {
    timeout: 10_000
  });
}

async function commitField(page: Page, testId: string, value: string): Promise<void> {
  const field = page.getByTestId(testId);
  await field.fill(value);
  await field.blur();
  await waitForSaved(page);
}

async function selectShape(page: Page, frame: FrameLocator, testId: string): Promise<void> {
  await page.getByTestId('insert-shape').click();
  await page.getByTestId(testId).click();
  await waitForSaved(page);
  await expect(page.getByTestId('object-style')).toBeVisible();
}

async function replaceSelectionText(
  target: ReturnType<FrameLocator['locator']>,
  text: string,
  page: Page
): Promise<void> {
  await target.dblclick();
  await expect(target).toHaveAttribute('contenteditable', 'true');
  await target.evaluate((element) => {
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    const selection = element.ownerDocument.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.keyboard.type(text);
  await page.keyboard.press('Escape');
  // Ending the session is deferred so keyboard focus can reach the toolbar;
  // wait for the commit to start before watching the save status.
  await expect(target).not.toHaveAttribute('contenteditable', 'true');
  await waitForSaved(page);
}

test.describe('object insertion @feature:shapes-images', () => {
  test('inserts a text box, edits it in place, and persists without editor artifacts', async ({
    page
  }) => {
    const harness = await openDeck(page);
    try {
      await page.getByTestId('insert-text').click();
      await waitForSaved(page);

      const inserted = harness.frame.locator('div[data-ppt-el]').last();
      await expect(inserted).toHaveText('新文字方塊');

      await replaceSelectionText(inserted, 'Quarterly plan', page);

      const html = await deckHtml(harness);
      expect(html).toContain('Quarterly plan');
      expect(html).not.toContain('contenteditable');
      expect(html).not.toContain('data-editing');

      await page.reload();
      const reloaded = page.frameLocator(FRAME_SELECTOR);
      await expect(
        reloaded.locator('div[data-ppt-el]').filter({ hasText: 'Quarterly plan' })
      ).toHaveCount(1);
    } finally {
      await close(harness);
    }
  });

  test('inserts every shape kind and keeps appearance and labels after reload', async ({
    page
  }) => {
    const harness = await openDeck(page);
    try {
      const initialObjects = await harness.frame.locator('[data-ppt-el]').count();
      await selectShape(page, harness.frame, 'insert-shape-rounded-rect');
      await expect(harness.frame.locator('div[data-ppt-el]').last()).toHaveCSS(
        'border-radius',
        '24px'
      );

      await selectShape(page, harness.frame, 'insert-shape-triangle');
      await expect(harness.frame.locator('svg[data-ppt-el] polygon')).toHaveCount(1);
      await commitField(page, 'style-fill', '#00aa00');
      await commitField(page, 'style-opacity', '0.5');
      await commitField(page, 'style-shape-text', 'Triangle label');

      await selectShape(page, harness.frame, 'insert-shape-arrow');
      await expect(harness.frame.locator('svg[data-ppt-el] line')).toHaveCount(1);
      await selectShape(page, harness.frame, 'insert-shape-line');
      await selectShape(page, harness.frame, 'insert-shape-ellipse');
      await selectShape(page, harness.frame, 'insert-shape-rect');

      const html = await deckHtml(harness);
      expect(html).toContain('border-radius: 24px');
      expect(html).toContain('fill="#00aa00"');
      expect(html).toContain('<text');
      expect(html).toContain('Triangle label');
      expect(html).not.toContain('contenteditable');

      await page.reload();
      const reloaded = page.frameLocator(FRAME_SELECTOR);
      await expect(reloaded.locator('svg[data-ppt-el]')).toHaveCount(3);
      await expect(reloaded.locator('text')).toHaveText('Triangle label');
      await expect(reloaded.locator('[data-ppt-el]')).toHaveCount(
        initialObjects + 6
      );
    } finally {
      await close(harness);
    }
  });

  test('inserts, edits, and replaces an image through URLs', async ({ page }) => {
    const harness = await openDeck(page);
    try {
      page.once('dialog', (dialog) => dialog.accept(PNG_URL));
      await page.getByTestId('insert-image').click();
      await page.getByTestId('insert-image-url').click();
      await waitForSaved(page);

      const image = harness.frame.locator('img[data-ppt-el]');
      await expect(image).toHaveAttribute('src', PNG_URL);
      await expect(page.getByTestId('object-style')).toBeVisible();

      await commitField(page, 'image-alt', 'Quarterly chart');
      await commitField(page, 'image-radius', '12');
      await commitField(page, 'image-opacity', '0.8');
      await commitField(page, 'image-crop-top', '10');

      let html = await deckHtml(harness);
      expect(html).toContain('alt="Quarterly chart"');
      expect(html).toContain('border-radius: 12px');
      expect(html).toContain('opacity: 0.8');
      expect(html).toContain('data-ppt-crop="10 0 0 0"');

      // A script URL is rejected inside the replace command, which the editor
      // reports only by leaving the image and the saved deck untouched.
      let replacePrompt = '';
      const rejectedReplace = new Promise<void>((resolve) => {
        page.once('dialog', (dialog) => {
          replacePrompt = dialog.message();
          void dialog.accept('javascript:alert(1)').then(() => resolve());
        });
      });
      await page.getByTestId('image-replace-url').click();
      await rejectedReplace;
      expect(replacePrompt).toBe('圖片網址（https:// 或 data:image/...）');
      await expect(image).toHaveAttribute('src', PNG_URL);
      html = await deckHtml(harness);
      expect(html).not.toContain('javascript:');

      page.once('dialog', (dialog) => dialog.accept(GIF_URL));
      await page.getByTestId('image-replace-url').click();
      await waitForSaved(page);
      await expect(image).toHaveAttribute('src', GIF_URL);

      html = await deckHtml(harness);
      expect(html).toContain(GIF_URL);
      expect(html).not.toContain('javascript:');

      // The insertion prompt is a separate path and surfaces the rejection in
      // the editor error banner without adding a second image.
      page.once('dialog', (dialog) => dialog.accept('javascript:alert(1)'));
      await page.getByTestId('insert-image').click();
      await page.getByTestId('insert-image-url').click();
      await expect(page.getByTestId('editor-error')).toContainText(
        'Image URLs must use http: or https:.'
      );
      await expect(harness.frame.locator('img[data-ppt-el]')).toHaveCount(1);
      await expect(image).toHaveAttribute('src', GIF_URL);
      expect(await deckHtml(harness)).not.toContain('javascript:');

      await page.reload();
      const reloaded = page.frameLocator(FRAME_SELECTOR);
      await expect(reloaded.locator('img[data-ppt-el]')).toHaveAttribute('src', GIF_URL);
      await expect(reloaded.locator('img[data-ppt-el]')).toHaveAttribute(
        'alt',
        'Quarterly chart'
      );
    } finally {
      await close(harness);
    }
  });

  test('accepts dropped and pasted image files', async ({ page }) => {
    const harness = await openDeck(page);
    try {
      await harness.frame.locator('body').evaluate(
        (body, base64) => {
          const bytes = Uint8Array.from(atob(base64), (char) =>
            char.charCodeAt(0)
          );
          const file = new File([bytes], 'dropped.png', { type: 'image/png' });
          const Transfer = Reflect.get(globalThis, 'DataTransfer') as new () => {
            items: { add(item: File): void };
          };
          const DropEvent = Reflect.get(globalThis, 'DragEvent') as new (
            type: string,
            init: { bubbles: boolean; dataTransfer: unknown }
          ) => Event;
          const data = new Transfer();
          data.items.add(file);
          body.dispatchEvent(
            new DropEvent('drop', { bubbles: true, dataTransfer: data })
          );
        },
        TINY_PNG
      );
      await waitForSaved(page);
      await expect(harness.frame.locator('img[data-ppt-el]')).toHaveCount(1);

      await harness.frame.locator('body').evaluate(
        (body, base64) => {
          const bytes = Uint8Array.from(atob(base64), (char) =>
            char.charCodeAt(0)
          );
          const file = new File([bytes], 'pasted.png', { type: 'image/png' });
          const Transfer = Reflect.get(globalThis, 'DataTransfer') as new () => {
            items: { add(item: File): void };
          };
          const PasteEvent = Reflect.get(globalThis, 'ClipboardEvent') as new (
            type: string,
            init: { bubbles: boolean; clipboardData: unknown }
          ) => Event;
          const data = new Transfer();
          data.items.add(file);
          body.dispatchEvent(
            new PasteEvent('paste', { bubbles: true, clipboardData: data })
          );
        },
        TINY_PNG
      );
      await waitForSaved(page);
      await expect(harness.frame.locator('img[data-ppt-el]')).toHaveCount(2);

      const html = await deckHtml(harness);
      expect(html.match(/data:image\/png;base64/g)).toHaveLength(2);
      expect(html).not.toContain('contenteditable');
    } finally {
      await close(harness);
    }
  });
});
