import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expect,
  test,
  type FrameLocator,
  type Page
} from '@playwright/test';
import { startCliHost } from './helpers';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'packages/cli/dist/bin.js');
const fixturePath = join(repoRoot, 'test-utils', 'fixtures', 'wrapped.deck.html');
const FRAME_SELECTOR = 'iframe[title="投影片預覽"]';

// The enter affordance is a chevron whose accessible name is class-first
// ("Enter pad"), falling back to the lowercase tag when a row has no class.
// The suite runs under a zh-TW locale, so accept every catalog spelling.
const ENTER_PAD = /Enter pad|進入 pad|进入 pad/;
const ENTER_COVER = /Enter cover|進入 cover|进入 cover/;

interface Harness {
  directory: string;
  file: string;
  host: Awaited<ReturnType<typeof startCliHost>>;
  frame: FrameLocator;
}

async function openWrappedDeck(page: Page): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'htmlppt-drill-in-e2e-'));
  const file = 'wrapped.deck.html';
  let host: Harness['host'] | null = null;
  try {
    await copyFile(fixturePath, join(directory, file));
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

test('enters nested layout containers and pops one level per Escape', async ({
  page
}) => {
  const editor = await openWrappedDeck(page);
  try {
    const rows = page.getByTestId('object-row');
    const context = page.getByTestId('edit-context');

    // Slide level: the three authored top-level objects.
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toHaveAttribute('data-object-path', '0');
    await expect(rows.nth(1)).toHaveAttribute('data-object-path', '1');
    await expect(rows.nth(2)).toHaveAttribute('data-object-path', '2');

    await page.getByRole('button', { name: ENTER_PAD }).click();
    await expect(context).toContainText('.pad');
    await expect(rows).toHaveCount(2);
    // Row paths stay slide-rooted inside a context.
    await expect(rows.nth(0)).toHaveAttribute('data-object-path', '2.0');
    await expect(rows.nth(1)).toHaveAttribute('data-object-path', '2.1');
    await expect(page.getByRole('button', { name: ENTER_COVER })).toBeVisible();

    await page.getByRole('button', { name: ENTER_COVER }).click();
    await expect(context).toContainText('.cover');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute('data-object-path', '2.0.0');
    await expect(rows.nth(1)).toHaveAttribute('data-object-path', '2.0.1');

    await page.keyboard.press('Escape');
    await expect(context).toContainText('.pad');
    await expect(context).not.toContainText('.cover');
    await expect(rows).toHaveCount(2);

    await page.keyboard.press('Escape');
    await expect(context).toBeHidden();
    await expect(rows).toHaveCount(3);
  } finally {
    await close(editor);
  }
});

test('a text leaf still edits inline inside a context', async ({ page }) => {
  const editor = await openWrappedDeck(page);
  try {
    const context = page.getByTestId('edit-context');
    await page.getByRole('button', { name: ENTER_PAD }).click();
    await expect(context).toContainText('.pad');

    await editor.frame.locator('h1').dblclick();
    await expect(editor.frame.locator('h1[contenteditable="true"]')).toHaveCount(
      1
    );
    // The double-click consumed the gesture, so the context did not move.
    await expect(context).toContainText('.pad');
    await expect(context).not.toContainText('.cover');

    // End the text session so the editor settles before the host stops.
    await page.keyboard.press('Escape');
    await expect(editor.frame.locator('h1[contenteditable="true"]')).toHaveCount(
      0
    );
  } finally {
    await close(editor);
  }
});

test("enters from a container's own padding and leaves on an outside click", async ({
  page
}) => {
  const editor = await openWrappedDeck(page);
  try {
    const slide = editor.frame.locator('[data-slide-id]');
    const context = page.getByTestId('edit-context');
    const rows = page.getByTestId('object-row');

    // The preview iframe is scaled to fit the canvas, and Playwright positions
    // are screen pixels, so convert design coordinates with the rendered box.
    const box = await slide.boundingBox();
    expect(box).not.toBeNull();
    const scale = (box?.width ?? 0) / 1600;
    const at = (x: number, y: number) => ({ x: x * scale, y: y * scale });

    // (100, 100) design px is inside .pad's 48px padding, not on a child.
    await slide.dblclick({ position: at(100, 100) });
    await expect(context).toContainText('.pad');
    await expect(rows).toHaveCount(2);

    // (1450, 820) design px is outside .pad and inside the decorative .halo.
    await slide.click({ position: at(1450, 820) });
    await expect(context).toBeHidden();
    await expect(rows).toHaveCount(3);
  } finally {
    await close(editor);
  }
});
