import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expect,
  test,
  type FrameLocator,
  type Locator,
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

async function openDeckHtml(
  page: Page,
  html: string,
  file: string
): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'htmlppt-drill-in-e2e-'));
  let host: Harness['host'] | null = null;
  try {
    await writeFile(join(directory, file), html);
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

async function openWrappedDeck(page: Page): Promise<Harness> {
  return openDeckHtml(
    page,
    await readFile(fixturePath, 'utf8'),
    'wrapped.deck.html'
  );
}

// One deck carries every wrapper that owns its subtree: a locked wrapper with
// an image child, a top-level group, and an unlocked image for a positive
// control. The shared wrapped fixture has no image under a locked wrapper.
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const GUARDED_DECK_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Guarded wrappers</title>
  <style>
    .slide { width: 1600px; height: 900px; position: relative; overflow: hidden; background: #fff; }
    .locked { position: absolute; left: 80px; top: 80px; width: 600px; }
    .locked img { display: block; width: 320px; height: 180px; }
    .group { position: absolute; left: 80px; top: 400px; width: 600px; }
    .free { position: absolute; left: 800px; top: 80px; width: 320px; height: 180px; }
  </style>
</head>
<body>
  <main data-ppt-deck>
    <section class="slide" data-slide-id="g1" data-width="1600" data-height="900">
      <div class="locked" data-ppt-el="e1" data-ppt-locked="true">
        <img alt="Locked pixel" src="${TINY_PNG}">
      </div>
      <div class="group" data-ppt-el="e2" data-ppt-group>
        <p>Grouped text</p>
      </div>
      <img class="free" data-ppt-el="e3" alt="Free pixel" src="${TINY_PNG}">
    </section>
  </main>
</body>
</html>`;

async function openGuardedDeck(page: Page): Promise<Harness> {
  return openDeckHtml(page, GUARDED_DECK_HTML, 'guarded.deck.html');
}

async function close(harness: Harness): Promise<void> {
  await harness.host.stop();
  await rm(harness.directory, { recursive: true, force: true });
}

// Playwright mouse coordinates are screen pixels, so gestures start from the
// element's rendered box in the parent page rather than its design rect.
async function boxOf(
  locator: Locator,
  label: string
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${label} has no bounding box.`);
  return box;
}

async function dragFrom(
  page: Page,
  start: { x: number; y: number },
  delta: { x: number; y: number }
): Promise<void> {
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + delta.x, start.y + delta.y, { steps: 8 });
  await page.mouse.up();
}

async function enterPad(page: Page): Promise<void> {
  await page.getByRole('button', { name: ENTER_PAD }).click();
  await expect(page.getByTestId('edit-context')).toContainText('.pad');
}

test('enters nested layout containers and pops one level per Escape', { tag: '@feature:drill-in-selection' }, async ({
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

test('a text leaf still edits inline inside a context', { tag: '@feature:drill-in-selection' }, async ({ page }) => {
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

test("enters from a container's own padding and leaves on an outside click", { tag: '@feature:drill-in-selection' }, async ({
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

test('enters the selected container with Enter', { tag: '@feature:drill-in-selection' }, async ({ page }) => {
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

test('jumps to an ancestor from the breadcrumb', { tag: '@feature:drill-in-selection' }, async ({ page }) => {
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

test('pops one level when Escape is pressed inside the preview frame', { tag: '@feature:drill-in-selection' }, async ({
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

test('clears the context when the active slide is deleted', { tag: '@feature:drill-in-selection' }, async ({ page }) => {
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

test('locked containers offer no chevron and cannot be entered with Enter', { tag: '@feature:drill-in-selection' }, async ({
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

test('a locked wrapper keeps an alt-drilled child uneditable', { tag: '@feature:nested-geometry' }, async ({
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

test('a mixed selection cannot move a locked wrapper child', { tag: '@feature:nested-geometry' }, async ({
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
    const padHeading = editor.frame.locator('[data-slide-id="s2"] .pad h1');

    // Base: a nested selection inside the locked top-level wrapper.
    await lockedChild.click({ modifiers: ['Alt'] });
    await expect(outline).toHaveAttribute('data-selected-path', '3.0');
    await expect(outline).toHaveAttribute('data-readonly', 'true');

    // Shift-clicking the top-level pad used to append it to the nested base,
    // and dragging that mixed selection moved the locked wrapper's child.
    await padHeading.click({ modifiers: ['Shift'] });

    const box = await padHeading.boundingBox();
    if (!box) throw new Error('Pad heading has no bounding box.');
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    const save = page.waitForResponse(isDeckSaveResponse);
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 100, startY + 50, { steps: 5 });
    await page.mouse.up();
    expect((await save).ok()).toBe(true);
    await expect(page.getByTestId('save-status')).toHaveText('已儲存');

    // The locked child stays inert; the top-level pad is the object that moved.
    expect(await lockedChild.getAttribute('style')).toBeNull();
    const saved = await readFile(join(editor.directory, editor.file), 'utf8');
    expect(saved).toContain('<p>Locked heading</p>');

    // The new multi-select contract: a nested base collapses to the incoming
    // top-level target instead of forming a mixed selection.
    await expect(outline).toHaveCount(1);
    await expect(outline).toHaveAttribute('data-selected-path', '2');
  } finally {
    await close(editor);
  }
});

test('Enter during a drag does not enter the dragged container', { tag: '@feature:drill-in-selection' }, async ({
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

test('Escape during a drag cancels the drag, not the context', { tag: '@feature:drill-in-selection' }, async ({
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

test('drags a nested flow child, pins it, and the geometry survives reload', { tag: '@feature:nested-geometry' }, async ({
  page
}) => {
  const editor = await openWrappedDeck(page);
  try {
    await enterPad(page);
    const foot = editor.frame.locator('.pad .foot');
    await foot.click();
    await expect(page.getByTestId('selection-outline')).toHaveAttribute(
      'data-selected-path',
      '2.1'
    );

    const box = await boxOf(foot, 'Footer');
    const save = page.waitForResponse(isDeckSaveResponse);
    await dragFrom(
      page,
      { x: box.x + 12, y: box.y + box.height / 2 },
      { x: 60, y: 40 }
    );

    // The first position edit pins the flow child and explains the change.
    await expect(page.getByTestId('pin-notice')).toBeVisible();
    await expect(foot).toHaveCSS('position', 'absolute');
    const pinned = (await foot.getAttribute('style')) ?? '';
    expect(pinned).toContain('position: absolute');
    expect(pinned).toMatch(/left: -?[\d.]+px/);
    expect(pinned).toMatch(/top: -?[\d.]+px/);
    expect((await save).ok()).toBeTruthy();
    await expect(page.getByTestId('save-status')).toHaveText('已儲存');

    const before = await foot.evaluate((element) => {
      const styled = element as HTMLElement;
      return { left: styled.style.left, top: styled.style.top };
    });

    await page.reload();
    const reloadedFrame = page.frameLocator(FRAME_SELECTOR);
    await expect(reloadedFrame.locator('[data-slide-id]')).toBeVisible();
    await expect(page.getByTestId('save-status')).toHaveText('已同步');
    const reloaded = reloadedFrame.locator('.pad .foot');
    await expect(reloaded).toHaveCSS('position', 'absolute');
    const after = await reloaded.evaluate((element) => {
      const styled = element as HTMLElement;
      return { left: styled.style.left, top: styled.style.top };
    });
    // The saved deck carries the pinned geometry, not only a reload render.
    expect(after).toEqual(before);
  } finally {
    await close(editor);
  }
});

test('Undo restores the pre-pin inline style and the notice stays gone', { tag: '@feature:nested-geometry' }, async ({
  page
}) => {
  const editor = await openWrappedDeck(page);
  try {
    await enterPad(page);
    const foot = editor.frame.locator('.pad .foot');
    await foot.click();
    const originalStyle = await foot.getAttribute('style');
    expect(originalStyle).toBeNull();
    await expect(foot).toHaveCSS('position', 'static');

    const firstSave = page.waitForResponse(isDeckSaveResponse);
    const box = await boxOf(foot, 'Footer');
    await dragFrom(
      page,
      { x: box.x + 12, y: box.y + box.height / 2 },
      { x: 60, y: 40 }
    );
    await expect(page.getByTestId('pin-notice')).toBeVisible();
    await expect(foot).toHaveCSS('position', 'absolute');
    expect((await firstSave).ok()).toBeTruthy();

    const undoSave = page.waitForResponse(isDeckSaveResponse);
    await page.getByTestId('pin-notice-undo').click();
    await expect(page.getByTestId('pin-notice')).toHaveCount(0);
    // Undo restores the whole history entry: the authored flow style is back.
    await expect.poll(() => foot.getAttribute('style')).toBe(originalStyle);
    await expect(foot).toHaveCSS('position', 'static');
    expect((await undoSave).ok()).toBeTruthy();

    // A second pin is still a pin, but the session already explained it.
    // Escape is a no-op at the slide level, so it lands there either way.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await enterPad(page);
    const again = editor.frame.locator('.pad .foot');
    await again.click();
    const secondSave = page.waitForResponse(isDeckSaveResponse);
    const secondBox = await boxOf(again, 'Footer');
    await dragFrom(
      page,
      { x: secondBox.x + 12, y: secondBox.y + secondBox.height / 2 },
      { x: 50, y: 30 }
    );
    // Positive control: the second drag really pinned the flow child again.
    await expect(again).toHaveCSS('position', 'absolute');
    expect((await secondSave).ok()).toBeTruthy();
    await expect(page.getByTestId('save-status')).toHaveText('已儲存');
    await expect(page.getByTestId('pin-notice')).toHaveCount(0);
  } finally {
    await close(editor);
  }
});

test('rotating a flow child pins the box without showing the notice', { tag: '@feature:nested-geometry' }, async ({
  page
}) => {
  const editor = await openWrappedDeck(page);
  try {
    await enterPad(page);
    const foot = editor.frame.locator('.pad .foot');
    await foot.click();
    await expect(foot).toHaveCSS('position', 'static');

    const handle = page.getByTestId('rotate-handle');
    await expect(handle).toBeVisible();
    const box = await boxOf(handle, 'Rotate handle');
    const save = page.waitForResponse(isDeckSaveResponse);
    await dragFrom(
      page,
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      { x: 70, y: 30 }
    );

    // Rotation materializes the box, but only a position or size edit is the
    // pin the notice explains.
    await expect(foot).toHaveCSS('position', 'absolute');
    await expect
      .poll(async () => (await foot.getAttribute('style')) ?? '')
      .toContain('transform: rotate(');
    expect((await save).ok()).toBeTruthy();
    await expect(page.getByTestId('save-status')).toHaveText('已儲存');
    await expect(page.getByTestId('pin-notice')).toHaveCount(0);
  } finally {
    await close(editor);
  }
});

test('a text edit dismisses the pin notice instead of undoing the text', { tag: '@feature:nested-geometry' }, async ({
  page
}) => {
  const editor = await openWrappedDeck(page);
  try {
    await enterPad(page);
    const foot = editor.frame.locator('.pad .foot');
    await foot.click();

    // A nudge is a position edit: it pins the flow child and shows the notice.
    const nudgeSave = page.waitForResponse(isDeckSaveResponse);
    await page.keyboard.press('ArrowRight');
    expect((await nudgeSave).ok()).toBeTruthy();
    await expect(page.getByTestId('pin-notice')).toBeVisible();
    await expect(foot).toHaveCSS('position', 'absolute');

    const heading = editor.frame.locator('.pad .cover h1');
    await heading.dblclick();
    await expect(heading).toHaveAttribute('contenteditable', 'true');
    // The notice's Undo would settle and revert the text edit, so the notice
    // steps aside; its Undo is not available to touch the text.
    await expect(page.getByTestId('pin-notice')).toHaveCount(0);
    await expect(page.getByTestId('pin-notice-undo')).toHaveCount(0);

    await page.keyboard.press('End');
    await page.keyboard.type('ZZ-text-edit');
    await expect(heading).toContainText('ZZ-text-edit');
    const textSave = page.waitForResponse(isDeckSaveResponse);
    await page.keyboard.press('Escape');
    await expect(heading).not.toHaveAttribute('contenteditable', 'true');
    expect((await textSave).ok()).toBeTruthy();
    await expect(page.getByTestId('save-status')).toHaveText('已儲存');
    // Ending the session commits the typed text; no undo reverted it.
    await expect(heading).toContainText('ZZ-text-edit');
    const saved = await readFile(join(editor.directory, editor.file), 'utf8');
    expect(saved).toContain('ZZ-text-edit');
    await expect(page.getByTestId('pin-notice')).toHaveCount(0);
  } finally {
    await close(editor);
  }
});

test('drags a grid child without changing the grid parent', { tag: '@feature:nested-geometry' }, async ({
  page
}) => {
  const editor = await openWrappedDeck(page);
  try {
    await enterPad(page);
    await page.getByRole('button', { name: ENTER_COVER }).click();
    await expect(page.getByTestId('edit-context')).toContainText('.cover');

    const cover = editor.frame.locator('.pad .cover');
    const title = cover.locator('h1');
    await title.click();
    await expect(page.getByTestId('selection-outline')).toHaveAttribute(
      'data-selected-path',
      '2.0.0'
    );
    await expect(cover).toHaveCSS('display', 'grid');
    expect(await cover.getAttribute('style')).toBeNull();

    const box = await boxOf(title, 'Cover heading');
    const save = page.waitForResponse(isDeckSaveResponse);
    await dragFrom(
      page,
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      { x: 40, y: 30 }
    );
    await expect(title).toHaveCSS('position', 'absolute');
    expect((await save).ok()).toBeTruthy();
    await expect(page.getByTestId('save-status')).toHaveText('已儲存');

    // The child is pinned; the grid container's own layout is untouched.
    await expect(cover).toHaveCSS('display', 'grid');
    expect(await cover.getAttribute('style')).toBeNull();
    await expect(cover.locator('p')).toContainText('Body copy');
  } finally {
    await close(editor);
  }
});

// The wrapped fixture has no SVG descendant, so the "no panel for an SVG
// child" case lives in the appearance-kind unit tests instead of this spec.
test('styles a nested paragraph through the appearance panel and persists it', { tag: '@feature:nested-appearance' }, async ({
  page
}) => {
  const editor = await openWrappedDeck(page);
  try {
    await enterPad(page);
    const pad = editor.frame.locator('.pad');
    const foot = editor.frame.locator('.pad .foot');
    await foot.click();
    await expect(page.getByTestId('selection-outline')).toHaveAttribute(
      'data-selected-path',
      '2.1'
    );

    // Positive control: a paragraph two levels down gets the shape panel, not
    // the read-only hint that nested selections showed before DE3.
    await expect(page.getByTestId('object-style')).toBeVisible();
    await expect(page.getByTestId('image-alt')).toHaveCount(0);

    const fill = page.getByTestId('style-fill');
    // The suite runs under the zh-TW pin, so this is the real field label.
    await expect(fill).toHaveAttribute('aria-label', '填色');
    await fill.fill('#ffeeaa');
    await fill.press('Enter');

    await expect
      .poll(async () => (await foot.getAttribute('style')) ?? '')
      .toContain('background-color');
    await expect(foot).toHaveCSS('background-color', 'rgb(255, 238, 170)');
    await expect(page.getByTestId('save-status')).toHaveText('已儲存');
    // The edit lands on the selected child, not on its container.
    expect(await pad.getAttribute('style')).toBeNull();

    // The saved deck carries the style, not only a live iframe change.
    const saved = await readFile(join(editor.directory, editor.file), 'utf8');
    expect(saved).toMatch(
      /<p class="foot" style="[^"]*background-color: rgb\(255, 238, 170\)/
    );

    await page.reload();
    const reloadedFrame = page.frameLocator(FRAME_SELECTOR);
    await expect(reloadedFrame.locator('[data-slide-id]')).toBeVisible();
    await expect(page.getByTestId('save-status')).toHaveText('已同步');
    const reloadedFoot = reloadedFrame.locator('.pad .foot');
    await expect(reloadedFoot).toHaveAttribute(
      'style',
      /background-color: rgb\(255, 238, 170\)/
    );
    await expect(reloadedFoot).toHaveCSS(
      'background-color',
      'rgb(255, 238, 170)'
    );
  } finally {
    await close(editor);
  }
});

test('keeps the appearance panel disabled for a child inside a locked wrapper', { tag: '@feature:nested-appearance' }, async ({
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

    // Alt-click drills through the locked wrapper. The panel renders for the
    // child, but the wrapper owns its subtree, so every field must be inert
    // instead of accepting an edit that the handler then rejects.
    await lockedChild.click({ modifiers: ['Alt'] });
    await expect(outline).toHaveAttribute('data-selected-path', '3.0');
    await expect(outline).toHaveAttribute('data-readonly', 'true');
    await expect(page.getByTestId('object-style')).toBeVisible();
    await expect(page.getByTestId('style-fill')).toBeDisabled();
    await expect(page.getByTestId('style-stroke')).toBeDisabled();
    await expect(page.getByTestId('style-opacity')).toBeDisabled();

    // Positive control: the same panel is editable for a nested shape whose
    // top-level wrapper is unlocked, so the fields are not always disabled.
    const unlockedHeading = editor.frame.locator(
      '[data-slide-id="s2"] .pad h1'
    );
    await unlockedHeading.click({ modifiers: ['Alt'] });
    await expect(outline).toHaveAttribute('data-selected-path', '2.0.0');
    await expect(page.getByTestId('object-style')).toBeVisible();
    await expect(page.getByTestId('style-fill')).toBeEnabled();
  } finally {
    await close(editor);
  }
});

test('keeps the appearance panel disabled for a selected group wrapper', { tag: '@feature:nested-appearance' }, async ({
  page
}) => {
  const editor = await openGuardedDeck(page);
  try {
    const groupRow = page.locator(
      '[data-testid="object-row"][data-object-id="e2"]'
    );
    await groupRow.click();
    await expect(groupRow).toHaveAttribute('aria-current', 'true');
    // The group is the selection and the panel renders; only the fields are
    // inert because a group wrapper owns its subtree.
    await expect(page.getByTestId('object-style')).toBeVisible();
    await expect(page.getByTestId('style-fill')).toBeDisabled();
    await expect(page.getByTestId('style-opacity')).toBeDisabled();

    // Positive control: another object in this deck keeps its controls.
    const freeRow = page.locator(
      '[data-testid="object-row"][data-object-id="e3"]'
    );
    await freeRow.click();
    await expect(freeRow).toHaveAttribute('aria-current', 'true');
    await expect(page.getByTestId('image-alt')).toBeEnabled();
  } finally {
    await close(editor);
  }
});

test('rejects an image upload into a locked wrapper child', { tag: '@feature:nested-appearance' }, async ({
  page
}) => {
  const editor = await openGuardedDeck(page);
  try {
    const outline = page.getByTestId('selection-outline');
    const lockedImage = editor.frame.locator(
      '[data-slide-id="g1"] .locked img'
    );
    const originalSrc = await lockedImage.getAttribute('src');
    if (!originalSrc) throw new Error('Locked image has no src.');

    await lockedImage.click({ modifiers: ['Alt'] });
    await expect(outline).toHaveAttribute('data-selected-path', '0.0');
    await expect(outline).toHaveAttribute('data-readonly', 'true');
    await expect(page.getByTestId('object-style')).toBeVisible();

    // The upload reads the file asynchronously before it applies, so the
    // top-level guard must be re-checked at apply time. The hidden file input
    // stays enabled while the panel is disabled, which is the bypass here.
    const replacement = {
      name: 'replacement.png',
      mimeType: 'image/png',
      buffer: Buffer.from('replacement-image-bytes')
    };
    await page.getByTestId('image-replace-input').setInputFiles(replacement);
    await expect(page.getByTestId('editor-error')).toContainText(
      '無法更換圖片'
    );
    await expect(lockedImage).toHaveAttribute('src', originalSrc);
    await expect(page.getByTestId('save-status')).toHaveText('已同步');

    // Positive control: the same input path rewrites an unlocked image, so the
    // assertions above cannot pass on a dead upload handler.
    const freeImage = editor.frame.locator('[data-slide-id="g1"] .free');
    const freeSrc = await freeImage.getAttribute('src');
    await freeImage.click();
    await expect(outline).toHaveAttribute('data-selected-path', '2');
    await page.getByTestId('image-replace-input').setInputFiles(replacement);
    await expect.poll(() => freeImage.getAttribute('src')).not.toBe(freeSrc);
    await expect(page.getByTestId('save-status')).toHaveText('已儲存');
  } finally {
    await close(editor);
  }
});

test('Escape during a nested drag cancels the drag and keeps the context', { tag: '@feature:nested-geometry' }, async ({
  page
}) => {
  const editor = await openWrappedDeck(page);
  try {
    await enterPad(page);
    const context = page.getByTestId('edit-context');
    const outline = page.getByTestId('selection-outline');
    const rows = page.getByTestId('object-row');
    const foot = editor.frame.locator('.pad .foot');
    const box = await boxOf(foot, 'Footer');
    const start = { x: box.x + 12, y: box.y + box.height / 2 };

    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 40, start.y + 20, { steps: 5 });
    // Positive control: the gesture reached the nested child and pinned it
    // live, so the Escape below cancels a real transform.
    await expect(outline).toHaveAttribute('data-selected-path', '2.1');
    await expect(foot).toHaveCSS('position', 'absolute');

    await page.keyboard.press('Escape');
    await expect(outline).toHaveCount(0);
    // DE1 deferred this case: the drag owns Escape, not the breadcrumb.
    await expect(context).toContainText('.pad');
    // The context stayed at .pad. A cancel that also entered .cover would
    // show its name and its children's slide-rooted paths below.
    await expect(context).not.toContainText('.cover');
    await page.mouse.up();
    await expect(page.getByTestId('pin-notice')).toHaveCount(0);
    await expect(page.getByTestId('save-status')).toHaveText('已同步');
    // The cancelled gesture never reached the deck: the flow child is back.
    await expect(foot).toHaveCSS('position', 'static');
    expect(await foot.getAttribute('style')).toBeNull();
    await expect(context).toContainText('.pad');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute('data-object-path', '2.0');
    await expect(rows.nth(1)).toHaveAttribute('data-object-path', '2.1');
  } finally {
    await close(editor);
  }
});
