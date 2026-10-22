import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expect,
  test,
  type FrameLocator,
  type Page,
  type Request,
  type Response
} from '@playwright/test';
import { execa } from 'execa';
import { startCliHost } from './helpers';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'packages/cli/dist/bin.js');
const FRAME_SELECTOR = 'iframe[title="投影片預覽"]';

interface EditorHarness {
  directory: string;
  file: string;
  host: Awaited<ReturnType<typeof startCliHost>>;
  frame: FrameLocator;
}

function isDeckSaveRequest(request: Request): boolean {
  return (
    request.method() === 'PUT' &&
    new URL(request.url()).pathname === '/api/deck'
  );
}

function isDeckSave(response: Response): boolean {
  return isDeckSaveRequest(response.request());
}

async function createObjectsFixture(
  directory: string,
  file: string
): Promise<void> {
  await execa('node', [cliPath, 'new', file, '--slides', '1'], {
    cwd: directory
  });
  const path = join(directory, file);
  const html = await readFile(path, 'utf8');
  const closing = html.indexOf('</section>');
  if (closing === -1) {
    throw new Error('Template slide closing tag was not found.');
  }
  const objects = [
    '    <p data-ppt-el="a" style="position:absolute;left:100px;top:100px;width:100px;height:60px;margin:0;background:#d8c08a">A</p>',
    '    <div data-ppt-el="b" style="position:absolute;left:300px;top:140px;width:120px;height:80px;background:#9ac0d8">B</div>',
    '    <div data-ppt-el="c" style="position:absolute;left:500px;top:100px;width:80px;height:80px;background:#c89ad8">C</div>',
    '    <div data-ppt-el="d" style="position:absolute;left:700px;top:100px;width:120px;height:60px;display:flex;align-items:center;justify-content:center;background:#9ad8b0">D</div>',
    '    <div data-ppt-el="e" style="position:absolute;left:140px;top:120px;width:80px;height:80px;background:#d89a9a;z-index:2">E</div>',
    '    <p data-ppt-el="f" style="position:absolute;left:900px;top:300px;width:160px;height:80px;margin:0;background:#e0d0a0">F</p>'
  ].join('\n');
  await writeFile(
    path,
    `${html.slice(0, closing)}${objects}\n${html.slice(closing)}`,
    'utf8'
  );
}

async function openDeck(page: Page): Promise<EditorHarness> {
  const directory = await mkdtemp(join(tmpdir(), 'htmlppt-features-e2e-'));
  const file = 'features.html';
  let host: EditorHarness['host'] | null = null;
  try {
    await createObjectsFixture(directory, file);
    host = await startCliHost(cliPath, directory, file);
    await page.goto(host.url);
    const frame = page.frameLocator(FRAME_SELECTOR);
    await expect(frame.locator('[data-ppt-el="a"]')).toBeVisible();
    await expect(page.getByTestId('save-status')).toHaveText('已同步');
    return { directory, file, host, frame };
  } catch (error) {
    if (host) await host.stop();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function closeEditor(editor: EditorHarness): Promise<void> {
  await editor.host.stop();
  await rm(editor.directory, { recursive: true, force: true });
}

function waitForDeckSave(page: Page) {
  return page.waitForResponse(isDeckSave);
}

interface StyledNode {
  style: {
    position: string;
    left: string;
    top: string;
    width: string;
    height: string;
    display: string;
    transform: string;
    zIndex: string;
  };
}

async function styleOf(
  frame: FrameLocator,
  id: string
): Promise<Record<string, string>> {
  return frame.locator(`[data-ppt-el="${id}"]`).evaluate((element) => {
    const style = (element as unknown as StyledNode).style;
    return {
      position: style.position,
      left: style.left,
      top: style.top,
      width: style.width,
      height: style.height,
      display: style.display,
      transform: style.transform,
      zIndex: style.zIndex
    };
  });
}

async function corners(
  frame: FrameLocator,
  ids: readonly string[]
): Promise<Record<string, { left: number; top: number; right: number; bottom: number }>> {
  const values: Record<string, { left: number; top: number; right: number; bottom: number }> = {};
  for (const id of ids) {
    const box = await frame.locator(`[data-ppt-el="${id}"]`).boundingBox();
    if (!box) continue;
    values[id] = {
      left: box.x,
      top: box.y,
      right: box.x + box.width,
      bottom: box.y + box.height
    };
  }
  return values;
}

function expectCornersClose(
  actual: Record<string, { left: number; top: number; right: number; bottom: number }>,
  expected: Record<string, { left: number; top: number; right: number; bottom: number }>
): void {
  for (const id of Object.keys(expected)) {
    for (const key of ['left', 'top', 'right', 'bottom'] as const) {
      expect(
        Math.abs((actual[id]?.[key] ?? Number.NaN) - (expected[id]?.[key] ?? Number.NaN)),
        `${id}.${key}`
      ).toBeLessThanOrEqual(1.5);
    }
  }
}

async function dragElement(
  page: Page,
  frame: FrameLocator,
  selector: string,
  dx: number,
  dy: number
): Promise<void> {
  const box = await frame.locator(selector).first().boundingBox();
  if (!box) throw new Error(`No bounding box for ${selector}.`);
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  const save = waitForDeckSave(page);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx, startY + dy, { steps: 6 });
  await page.mouse.up();
  expect((await save).ok()).toBeTruthy();
  await expect(page.getByTestId('save-status')).toHaveText('已儲存');
}

test.describe('@feature:objects-transform', () => {
  test('groups, moves, rotates, and ungroups without visual jumps', async ({ page }) => {
    const editor = await openDeck(page);
    try {
      const frame = editor.frame;
      await page.locator('[data-testid="object-row"][data-object-id="a"]').click();
      await frame.locator('[data-ppt-el="b"]').click({ modifiers: ['Shift'] });
      await expect(page.getByTestId('selection-outline')).toHaveCount(2);
      await expect(page.getByTestId('object-group')).toBeEnabled();

      const groupSave = waitForDeckSave(page);
      await page.keyboard.press('Control+g');
      expect((await groupSave).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      const group = frame.locator('[data-ppt-group]');
      await expect(group).toHaveCount(1);
      await expect(group.locator('[data-ppt-el="a"]')).toHaveCount(1);
      await expect(group.locator('[data-ppt-el="b"]')).toHaveCount(1);
      const groupId = await group.getAttribute('data-ppt-el');
      expect(groupId).toBeTruthy();
      await expect(page.getByTestId('selection-outline')).toHaveAttribute(
        'data-selected-id',
        groupId ?? ''
      );
      await expect(page.getByTestId('handle-n')).toHaveCount(0);
      await expect(page.getByTestId('rotate-handle')).toBeVisible();
      await expect(page.getByTestId('field-width')).toBeDisabled();
      await expect(page.getByTestId('field-height')).toBeDisabled();
      await expect(page.getByTestId('field-x')).toBeEnabled();

      await dragElement(page, frame, '[data-ppt-group]', 70, 40);

      // Rotate through the overlay handle, then compare the exact corners
      // before and after ungrouping.
      const rotate = page.getByTestId('rotate-handle');
      const groupBox = await group.boundingBox();
      const handleBox = await rotate.boundingBox();
      if (!groupBox || !handleBox) throw new Error('Rotation geometry is unavailable.');
      const center = {
        x: groupBox.x + groupBox.width / 2,
        y: groupBox.y + groupBox.height / 2
      };
      const rotationSave = waitForDeckSave(page);
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(center.x + 180, center.y - 120, { steps: 8 });
      await page.mouse.up();
      expect((await rotationSave).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      const before = await corners(frame, ['a', 'b']);
      const ungroupSave = waitForDeckSave(page);
      await page.keyboard.press('Control+Shift+g');
      expect((await ungroupSave).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
      await expect(frame.locator('[data-ppt-group]')).toHaveCount(0);
      await expect(page.getByTestId('selection-outline')).toHaveCount(2);
      expectCornersClose(await corners(frame, ['a', 'b']), before);

      const saved = await readFile(join(editor.directory, editor.file), 'utf8');
      expect(saved).not.toContain('data-ppt-group');
      expect(saved).not.toContain('contenteditable');
    } finally {
      await closeEditor(editor);
    }
  });

  test('locks selection against drag, nudge, and text editing until the panel unlocks it', async ({ page }) => {
    const editor = await openDeck(page);
    try {
      const frame = editor.frame;
      const object = frame.locator('[data-ppt-el="f"]');
      await page.locator('[data-testid="object-row"][data-object-id="f"]').click();
      const lockSave = waitForDeckSave(page);
      await page.getByTestId('object-lock').click();
      expect((await lockSave).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
      expect(await object.getAttribute('data-ppt-locked')).toBe('true');
      await expect(page.getByTestId('object-locked-badge')).toBeVisible();
      await expect(page.getByTestId('field-x')).toBeDisabled();
      await expect(page.getByTestId('handle-n')).toHaveCount(0);

      const box = await object.boundingBox();
      if (!box) throw new Error('Locked object has no bounding box.');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 60, { steps: 5 });
      await page.mouse.up();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(300);
      expect((await styleOf(frame, 'f')).left).toBe('900px');
      expect((await styleOf(frame, 'f')).top).toBe('300px');

      await object.dblclick();
      expect(await object.getAttribute('contenteditable')).toBeNull();

      const unlockSave = waitForDeckSave(page);
      await page.getByTestId('object-unlock').click();
      expect((await unlockSave).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
      expect(await object.getAttribute('data-ppt-locked')).toBeNull();
      await expect(page.getByTestId('handle-n')).toBeVisible();

      await dragElement(page, frame, '[data-ppt-el="f"]', 90, 50);
      expect((await styleOf(frame, 'f')).left).not.toBe('900px');
      await object.dblclick();
      await expect(object).toHaveAttribute('contenteditable', 'true');
      await page.keyboard.press('Escape');
      await expect(object).not.toHaveAttribute('contenteditable', 'true');
    } finally {
      await closeEditor(editor);
    }
  });

  test('hide persists across reload and panel unhide restores authored display', async ({ page }) => {
    const editor = await openDeck(page);
    try {
      const frame = editor.frame;
      await page.locator('[data-testid="object-row"][data-object-id="d"]').click();
      const hideSave = waitForDeckSave(page);
      await page.getByTestId('object-hide').click();
      expect((await hideSave).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
      await expect(frame.locator('[data-ppt-el="d"]')).toBeHidden();

      const saved = await readFile(join(editor.directory, editor.file), 'utf8');
      expect(saved).toContain('data-ppt-display="flex"');

      await page.reload();
      await expect(frame.locator('[data-ppt-el="a"]')).toBeVisible();
      await expect(frame.locator('[data-ppt-el="d"]')).toBeHidden();
      const hiddenRow = page.locator('[data-testid="object-row"][data-object-id="d"]');
      await hiddenRow.click();
      await expect(page.getByTestId('object-hidden-badge')).toBeVisible();
      await expect(page.getByTestId('object-state-message')).toContainText('已隱藏');

      const showSave = waitForDeckSave(page);
      await page.getByTestId('object-unhide').click();
      expect((await showSave).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
      await expect(frame.locator('[data-ppt-el="d"]')).toBeVisible();
      expect((await styleOf(frame, 'd')).display).toBe('flex');
    } finally {
      await closeEditor(editor);
    }
  });

  test('aligns and distributes exact persisted coordinates with single undo entries', async ({ page }) => {
    const editor = await openDeck(page);
    try {
      const frame = editor.frame;
      await page.locator('[data-testid="object-row"][data-object-id="a"]').click();
      await frame.locator('[data-ppt-el="b"]').click({ modifiers: ['Shift'] });
      await frame.locator('[data-ppt-el="c"]').click({ modifiers: ['Shift'] });
      await expect(page.getByTestId('selection-outline')).toHaveCount(3);

      const alignSave = waitForDeckSave(page);
      await page.getByTestId('align-top').click();
      expect((await alignSave).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
      for (const id of ['a', 'b', 'c']) {
        expect((await styleOf(frame, id)).top).toBe('100px');
      }

      const distributeSave = waitForDeckSave(page);
      await page.getByTestId('distribute-horizontal').click();
      expect((await distributeSave).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
      expect((await styleOf(frame, 'a')).left).toBe('100px');
      expect((await styleOf(frame, 'b')).left).toBe('290px');
      expect((await styleOf(frame, 'c')).left).toBe('500px');

      const undo = waitForDeckSave(page);
      await page.keyboard.press('Control+z');
      expect((await undo).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
      expect((await styleOf(frame, 'b')).left).toBe('300px');
      const redo = waitForDeckSave(page);
      await page.keyboard.press('Control+Shift+z');
      expect((await redo).ok()).toBeTruthy();
      expect((await styleOf(frame, 'b')).left).toBe('290px');

      await page.reload();
      await expect(frame.locator('[data-ppt-el="a"]')).toBeVisible();
      expect((await styleOf(frame, 'a')).top).toBe('100px');
      expect((await styleOf(frame, 'b')).left).toBe('290px');
    } finally {
      await closeEditor(editor);
    }
  });

  test('reorders overlapping objects with explicit z-index and persists paint order', async ({ page }) => {
    const editor = await openDeck(page);
    try {
      const frame = editor.frame;
      const paintAtOverlap = () =>
        frame.locator('body').evaluate((body) => {
          const view = body as unknown as {
            ownerDocument: {
              elementFromPoint(
                x: number,
                y: number
              ): {
                closest(selector: string): { getAttribute(name: string): string | null } | null;
              } | null;
            };
          };
          const element = view.ownerDocument.elementFromPoint(180, 130);
          return element?.closest('[data-ppt-el]')?.getAttribute('data-ppt-el') ?? null;
        });
      expect(await paintAtOverlap()).toBe('e');

      await page.locator('[data-testid="object-row"][data-object-id="a"]').click();
      const frontSave = waitForDeckSave(page);
      await page.getByTestId('object-order-front').click();
      expect((await frontSave).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
      expect(await paintAtOverlap()).toBe('a');
      expect((await styleOf(frame, 'a')).position).toBe('absolute');

      await page.reload();
      await expect(frame.locator('[data-ppt-el="a"]')).toBeVisible();
      expect(await paintAtOverlap()).toBe('a');

      await page.locator('[data-testid="object-row"][data-object-id="a"]').click();
      const backSave = waitForDeckSave(page);
      await page.getByTestId('object-order-back').click();
      expect((await backSave).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
      expect(await paintAtOverlap()).toBe('e');
    } finally {
      await closeEditor(editor);
    }
  });
});
