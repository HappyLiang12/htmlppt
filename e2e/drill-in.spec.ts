import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expect,
  test,
  type FrameLocator,
  type Page,
  type Response
} from '@playwright/test';
import { startCliHost } from './helpers';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'packages/cli/dist/bin.js');
const fixturePath = join(repoRoot, 'test-utils', 'fixtures', 'wrapped.deck.html');
const FRAME_SELECTOR = 'iframe[title="投影片預覽"]';

function isDeckSaveResponse(response: Response): boolean {
  return (
    response.request().method() === 'PUT' &&
    new URL(response.url()).pathname === '/api/deck'
  );
}

// The enter affordance is a chevron whose accessible name is class-first
// ("Enter pad"), falling back to the lowercase tag when a row has no class.
// The suite runs under a zh-TW locale, so accept every catalog spelling.
const ENTER_PAD = /Enter pad|進入 pad|进入 pad/;
const ENTER_COVER = /Enter cover|進入 cover|进入 cover/;
// Any chevron, in every catalog spelling; used to prove an absent affordance
// while the unlock button (a different label) stays visible.
const ENTER_ANY = /Enter |進入 |进入 /;
const SLIDE_SEGMENT = /^(Slide|投影片|幻灯片)$/;

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
    // The rows are .pad's direct children again, not the level just popped.
    await expect(rows.nth(0)).toHaveAttribute('data-object-path', '2.0');
    await expect(rows.nth(1)).toHaveAttribute('data-object-path', '2.1');
    await expect(rows.nth(0)).toContainText('Wrapped title Body copy');
    await expect(rows.nth(1)).toContainText('Footer');

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
    // .cover is also enterable and holds two rows, so the context and the
    // slide-rooted paths are what distinguish the two levels.
    await expect(context).not.toContainText('.cover');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute('data-object-path', '2.0');
    await expect(rows.nth(1)).toHaveAttribute('data-object-path', '2.1');

    // (1450, 820) design px is outside .pad and inside the decorative .halo.
    await slide.click({ position: at(1450, 820) });
    await expect(context).toBeHidden();
    await expect(rows).toHaveCount(3);

    // The canvas background outside the slide is outside every context too.
    await page.getByRole('button', { name: ENTER_PAD }).click();
    await expect(context).toContainText('.pad');
    await page.getByTestId('canvas-preview').click({ position: { x: 8, y: 8 } });
    await expect(context).toBeHidden();
    await expect(rows).toHaveCount(3);
  } finally {
    await close(editor);
  }
});

test('enters the selected container with Enter', async ({ page }) => {
  const editor = await openWrappedDeck(page);
  try {
    const context = page.getByTestId('edit-context');
    const rows = page.getByTestId('object-row');

    await page
      .locator('[data-testid="object-row"][data-object-id="e3"]')
      .click();
    await expect(rows.nth(2)).toHaveAttribute('aria-current', 'true');
    // The row keeps keyboard focus, and Enter on a focused control belongs to
    // that control. Move focus to the document first, as it is when the object
    // was selected from the canvas, then Enter is the context gesture.
    await page.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
    });
    await page.keyboard.press('Enter');

    await expect(context).toContainText('.pad');
    await expect(rows).toHaveCount(2);
  } finally {
    await close(editor);
  }
});

test('jumps to an ancestor from the breadcrumb', async ({ page }) => {
  const editor = await openWrappedDeck(page);
  try {
    const context = page.getByTestId('edit-context');
    const rows = page.getByTestId('object-row');

    await page.getByRole('button', { name: ENTER_PAD }).click();
    await page.getByRole('button', { name: ENTER_COVER }).click();
    await expect(context).toContainText('.cover');
    await expect(rows).toHaveCount(2);

    await context.getByRole('button', { name: SLIDE_SEGMENT }).click();
    await expect(context).toBeHidden();
    await expect(rows).toHaveCount(3);
  } finally {
    await close(editor);
  }
});

test('pops one level when Escape is pressed inside the preview frame', async ({
  page
}) => {
  const editor = await openWrappedDeck(page);
  try {
    const context = page.getByTestId('edit-context');
    const rows = page.getByTestId('object-row');

    await page.getByRole('button', { name: ENTER_PAD }).click();
    await page.getByRole('button', { name: ENTER_COVER }).click();
    await expect(context).toContainText('.cover');

    // Focus starts inside the iframe, whose document has its own keydown
    // registration; the parent window never sees this Escape.
    await editor.frame.locator('h1').click();
    await page.keyboard.press('Escape');

    await expect(context).toContainText('.pad');
    await expect(context).not.toContainText('.cover');
    await expect(rows).toHaveCount(2);
  } finally {
    await close(editor);
  }
});

test('clears the context when the active slide is deleted', async ({ page }) => {
  const editor = await openWrappedDeck(page);
  try {
    const context = page.getByTestId('edit-context');
    const rows = page.getByTestId('object-row');

    await page.getByRole('button', { name: ENTER_PAD }).click();
    await expect(context).toContainText('.pad');

    // The second slide has the same shape at the same path, so the context
    // would still resolve after the delete; only the slide identity reset can
    // clear it.
    await page.getByTestId('delete-slide').click();
    await expect(editor.frame.locator('[data-slide-id="s2"]')).toBeVisible();
    await expect(page.getByTestId('save-status')).toHaveText('已儲存');

    await expect(context).toBeHidden();
    await expect(rows).toHaveCount(4);
  } finally {
    await close(editor);
  }
});

test('locked containers offer no chevron and cannot be entered with Enter', async ({
  page
}) => {
  const editor = await openWrappedDeck(page);
  try {
    const context = page.getByTestId('edit-context');
    const rows = page.getByTestId('object-row');

    await page.getByTestId('thumbnail').nth(1).click();
    await expect(editor.frame.locator('[data-slide-id="s2"]')).toBeVisible();
    await expect(rows).toHaveCount(4);

    const lockedRow = page.locator(
      '[data-testid="object-row"][data-object-id="e7"]'
    );
    const lockedItem = page.locator('li').filter({ has: lockedRow });
    await expect(lockedItem.getByTestId('object-locked-badge')).toBeVisible();
    // The pad row keeps its chevron, so the absence below is about the lock.
    await expect(page.getByRole('button', { name: ENTER_PAD })).toBeVisible();
    await expect(lockedItem.getByRole('button', { name: ENTER_ANY })).toHaveCount(
      0
    );

    await lockedRow.click();
    // Positive control: the locked row really is the selection, so a silent
    // no-selection below cannot make the Enter assertion vacuous.
    await expect(lockedRow).toHaveAttribute('aria-current', 'true');
    await page.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
    });
    await page.keyboard.press('Enter');
    await expect(context).toBeHidden();
    await expect(rows).toHaveCount(4);
  } finally {
    await close(editor);
  }
});

test('a locked wrapper keeps an alt-drilled child uneditable', async ({
  page
}) => {
  const editor = await openWrappedDeck(page);
  try {
    await page.getByTestId('thumbnail').nth(1).click();
    await expect(editor.frame.locator('[data-slide-id="s2"]')).toBeVisible();
    await expect(page.getByTestId('save-status')).toHaveText('已同步');

    const outline = page.getByTestId('selection-outline');
    const lockedChild = editor.frame
      .locator('[data-slide-id="s2"] .locked p')
      .first();

    // Positive control: the same Alt-click on an unlocked subtree produces a
    // nested selection with handles, so the absence below is the wrapper lock.
    await editor.frame
      .locator('[data-slide-id="s2"] .pad h1')
      .click({ modifiers: ['Alt'] });
    await expect(outline).toHaveAttribute('data-selected-path', '2.0.0');
    await expect(outline).not.toHaveAttribute('data-readonly', 'true');
    await expect(page.locator('[data-testid^="handle-"]')).toHaveCount(8);

    // Alt-click drills through the locked top-level wrapper to its first
    // paragraph: the selection lands, but the wrapper keeps the subtree inert.
    await lockedChild.click({ modifiers: ['Alt'] });
    await expect(outline).toHaveCount(1);
    await expect(outline).toHaveAttribute('data-selected-path', '3.0');
    await expect(outline).toHaveAttribute('data-readonly', 'true');
    await expect(page.locator('[data-testid^="handle-"]')).toHaveCount(0);
    await expect(page.getByTestId('rotate-handle')).toHaveCount(0);

    // ArrowRight must not nudge the child; a nudge pins it to absolute.
    expect(await lockedChild.getAttribute('style')).toBeNull();
    await page.keyboard.press('ArrowRight');
    expect(await lockedChild.getAttribute('style')).toBeNull();
    await expect(outline).toHaveAttribute('data-selected-path', '3.0');
    await expect(page.getByTestId('save-status')).toHaveText('已同步');

    // Alt-dragging keeps the drilled selection and must not start a transform
    // session or save the deck.
    const box = await lockedChild.boundingBox();
    if (!box) throw new Error('Locked child has no bounding box.');
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await page.keyboard.down('Alt');
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 100, startY + 50, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up('Alt');
    expect(await lockedChild.getAttribute('style')).toBeNull();
    await expect(outline).toHaveAttribute('data-selected-path', '3.0');
    await expect(page.getByTestId('save-status')).toHaveText('已同步');

    // Positive control: the same key and pointer gestures reach nested
    // geometry when the top-level wrapper is unlocked, so the checks above
    // are not asserting a dead handler.
    const unlockedHeading = editor.frame.locator(
      '[data-slide-id="s2"] .pad h1'
    );
    await unlockedHeading.click({ modifiers: ['Alt'] });
    await expect(outline).toHaveAttribute('data-selected-path', '2.0.0');
    const nudgeSave = page.waitForResponse(isDeckSaveResponse);
    await page.keyboard.press('ArrowRight');
    expect((await nudgeSave).ok()).toBe(true);
    await expect
      .poll(() => unlockedHeading.getAttribute('style'))
      .toContain('position: absolute');

    const controlBox = await unlockedHeading.boundingBox();
    if (!controlBox) throw new Error('Unlocked heading has no bounding box.');
    const beforeControlDrag = await unlockedHeading.getAttribute('style');
    const controlSave = page.waitForResponse(isDeckSaveResponse);
    await page.keyboard.down('Alt');
    await page.mouse.move(
      controlBox.x + controlBox.width / 2,
      controlBox.y + controlBox.height / 2
    );
    await page.mouse.down();
    await page.mouse.move(
      controlBox.x + controlBox.width / 2 + 100,
      controlBox.y + controlBox.height / 2 + 50,
      { steps: 5 }
    );
    await page.mouse.up();
    await page.keyboard.up('Alt');
    expect((await controlSave).ok()).toBe(true);
    await expect
      .poll(() => unlockedHeading.getAttribute('style'))
      .not.toBe(beforeControlDrag);
  } finally {
    await close(editor);
  }
});

test('Enter during a drag does not enter the dragged container', async ({
  page
}) => {
  const editor = await openWrappedDeck(page);
  try {
    const slide = editor.frame.locator('[data-slide-id]');
    const context = page.getByTestId('edit-context');

    const box = await slide.boundingBox();
    expect(box).not.toBeNull();
    const scale = (box?.width ?? 0) / 1600;
    // Pressing (100, 100) design px selects .pad and starts its drag session.
    await slide.hover({ position: { x: 100 * scale, y: 100 * scale } });
    await page.mouse.down();
    await expect(page.getByTestId('selection-outline')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(context).toBeHidden();
    await page.mouse.up();
    await expect(context).toBeHidden();
  } finally {
    await close(editor);
  }
});

test('Escape during a drag cancels the drag, not the context', async ({
  page
}) => {
  const editor = await openWrappedDeck(page);
  try {
    const slide = editor.frame.locator('[data-slide-id]');
    const context = page.getByTestId('edit-context');

    const box = await slide.boundingBox();
    expect(box).not.toBeNull();
    const scale = (box?.width ?? 0) / 1600;
    await slide.hover({ position: { x: 100 * scale, y: 100 * scale } });
    await page.mouse.down();
    await expect(page.getByTestId('selection-outline')).toHaveCount(1);
    // The shortcut layer cancels the gesture: the selection drops and the
    // frame reloads from the master instead of the context moving.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('selection-outline')).toHaveCount(0);
    await expect(context).toBeHidden();
    await page.mouse.up();
  } finally {
    await close(editor);
  }
});
