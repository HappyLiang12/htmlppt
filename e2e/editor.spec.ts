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
import { execa } from 'execa';
import { startCliHost } from './helpers';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'packages/cli/dist/bin.js');
const FRAME_SELECTOR = 'iframe[title="投影片預覽"]';
const CANVAS_WIDTH = 1600;
const NO_SAVE_TIMEOUT_MS = 500;

interface EditorHarness {
  directory: string;
  file: string;
  host: Awaited<ReturnType<typeof startCliHost>>;
  frame: FrameLocator;
}

function isDeckSave(response: Response): boolean {
  return (
    response.request().method() === 'PUT' &&
    new URL(response.url()).pathname === '/api/deck'
  );
}

async function createTemplate(
  directory: string,
  file: string
): Promise<void> {
  await execa('node', [cliPath, 'new', file, '--slides', '2'], {
    cwd: directory
  });
}

async function createNudgeFixture(
  directory: string,
  file: string
): Promise<void> {
  await createTemplate(directory, file);
  const path = join(directory, file);
  const html = await readFile(path, 'utf8');
  const closing = html.indexOf('</section>');
  if (closing === -1) {
    throw new Error('Template slide closing tag was not found.');
  }
  const object =
    '    <div data-ppt-el="box1" style="position:absolute;left:120px;top:160px;width:240px;height:120px;background:#d8c08a">Nudge me</div>\n';
  await writeFile(
    path,
    `${html.slice(0, closing)}${object}${html.slice(closing)}`,
    'utf8'
  );
}

async function openDeck(
  page: Page,
  prepare: (directory: string, file: string) => Promise<void>,
  ready: (frame: FrameLocator) => Promise<void>
): Promise<EditorHarness> {
  const directory = await mkdtemp(join(tmpdir(), 'htmlppt-editor-e2e-'));
  const file = 'template.html';
  let host: EditorHarness['host'] | null = null;
  try {
    await prepare(directory, file);
    host = await startCliHost(cliPath, directory, file);
    await page.goto(host.url);
    const frame = page.frameLocator(FRAME_SELECTOR);
    await ready(frame);
    await expect(page.getByTestId('save-status')).toHaveText('已載入');
    return { directory, file, host, frame };
  } catch (error) {
    if (host) await host.stop();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function openTemplateDeck(page: Page): Promise<EditorHarness> {
  return openDeck(
    page,
    createTemplate,
    async (frame) => {
      await expect(frame.locator('h1')).toContainText('Untitled deck');
    }
  );
}

function openNudgeDeck(page: Page): Promise<EditorHarness> {
  return openDeck(
    page,
    createNudgeFixture,
    async (frame) => {
      await expect(frame.locator('[data-ppt-el="box1"]')).toBeVisible();
    }
  );
}

async function closeEditor(editor: EditorHarness): Promise<void> {
  await editor.host.stop();
  await rm(editor.directory, { recursive: true, force: true });
}

function waitForDeckSave(page: Page) {
  return page.waitForResponse(isDeckSave);
}

async function expectNoDeckSave(
  page: Page,
  timeout = NO_SAVE_TIMEOUT_MS
): Promise<void> {
  await expect(
    page.waitForResponse(isDeckSave, { timeout })
  ).rejects.toThrow();
}

interface InlineGeometry {
  position: string;
  left: number | null;
  top: number | null;
  width: number | null;
  height: number | null;
}

async function inlineGeometryOf(locator: Locator): Promise<InlineGeometry> {
  return locator.evaluate((element) => {
    const style = (
      element as unknown as {
        style: {
          position: string;
          left: string;
          top: string;
          width: string;
          height: string;
        };
      }
    ).style;
    const toNumber = (value: string) => {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    return {
      position: style.position,
      left: style.left === '' ? null : toNumber(style.left),
      top: style.top === '' ? null : toNumber(style.top),
      width: style.width === '' ? null : toNumber(style.width),
      height: style.height === '' ? null : toNumber(style.height)
    };
  });
}

async function slideInnerGeometry(frame: FrameLocator): Promise<InlineGeometry> {
  return inlineGeometryOf(frame.locator('.slide-inner'));
}

async function headingGeometry(frame: FrameLocator): Promise<InlineGeometry> {
  return inlineGeometryOf(frame.locator('h1'));
}

async function frameScale(page: Page): Promise<number> {
  return page.locator(FRAME_SELECTOR).evaluate((iframe) => {
    return iframe.getBoundingClientRect().width / 1600;
  });
}

function styleDeclaration(style: string, property: string): string | null {
  for (const part of style.split(';')) {
    const separator = part.indexOf(':');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === property) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

async function savedStyle(
  directory: string,
  file: string,
  tagPattern: RegExp
): Promise<Record<string, string | null>> {
  const html = await readFile(join(directory, file), 'utf8');
  const style = /style="([^"]*)"/.exec(tagPattern.exec(html)?.[0] ?? '')?.[1] ?? '';
  return {
    position: styleDeclaration(style, 'position'),
    left: styleDeclaration(style, 'left'),
    top: styleDeclaration(style, 'top'),
    width: styleDeclaration(style, 'width'),
    height: styleDeclaration(style, 'height'),
    transform: styleDeclaration(style, 'transform')
  };
}

async function savedSlideInnerStyle(
  directory: string,
  file: string
): Promise<Record<string, string | null>> {
  return savedStyle(
    directory,
    file,
    /<div[^>]*class="slide-inner"[^>]*>/
  );
}

async function savedNudgeBoxStyle(
  directory: string,
  file: string
): Promise<Record<string, string | null>> {
  return savedStyle(
    directory,
    file,
    /<div[^>]*data-ppt-el="box1"[^>]*>/
  );
}

interface ScreenBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ScreenPoint {
  x: number;
  y: number;
}

interface FrameDomWindow {
  __pptPointerId?: number;
  PointerEvent: new (
    type: string,
    init?: Record<string, unknown>
  ) => object;
  document: {
    dispatchEvent(event: object): boolean;
    addEventListener(
      type: string,
      listener: (event: { pointerId: number }) => void,
      options?: { once?: boolean; capture?: boolean }
    ): void;
  };
}

function centerOfBox(box: ScreenBox): ScreenPoint {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function normalizeAngle(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

function pointerAngle(center: ScreenPoint, point: ScreenPoint): number {
  const radians = Math.atan2(point.y - center.y, point.x - center.x);
  return normalizeAngle((radians * 180) / Math.PI + 90);
}

function angleDelta(from: number, to: number): number {
  const delta = normalizeAngle(to - from);
  return delta > 180 ? delta - 360 : delta;
}

function pointAt(
  center: ScreenPoint,
  radius: number,
  degrees: number
): ScreenPoint {
  const radians = (degrees * Math.PI) / 180;
  return {
    x: center.x + Math.cos(radians) * radius,
    y: center.y + Math.sin(radians) * radius
  };
}

function rotationDegrees(transform: string): number {
  const match = /rotate\(\s*(-?(?:\d+|\d*\.\d+))deg\s*\)/.exec(transform);
  return match?.[1] === undefined ? Number.NaN : Number(match[1]);
}

async function transformOf(
  frame: FrameLocator,
  selector: string
): Promise<string> {
  return frame.locator(selector).evaluate((element) => {
    return (
      element as unknown as { style: { transform: string } }
    ).style.transform;
  });
}

test(
  'clicking inside the heading selects its top-level object with eight handles',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      await editor.frame.locator('h1').click();

      const outline = page.getByTestId('selection-outline');
      await expect(outline).toBeVisible();
      await expect(outline).toHaveAttribute('data-selected-path', '0');
      expect(await outline.getAttribute('data-selected-id')).not.toBe('e1');
      await expect(outline).not.toHaveAttribute('data-readonly', 'true');
      await expect(page.locator('[data-testid^="handle-"]')).toHaveCount(8);
      await expect(page.getByTestId('handle-e')).toBeVisible();
      await expect(page.getByTestId('rotate-handle')).toBeVisible();

      // Editor chrome is rendered in the parent document, never in the deck.
      const overlayInsideFrame = await page
        .locator(FRAME_SELECTOR)
        .evaluate((iframe) => {
          const document = (
            iframe as unknown as {
              contentDocument: {
                querySelector(selector: string): unknown;
              } | null;
            }
          ).contentDocument;
          return document?.querySelector('[data-testid="selection-outline"]') !== null;
        });
      expect(overlayInsideFrame).toBe(false);
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'nested selections are read-only: outline only, no transforms',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      await editor.frame.locator('h1').click({ modifiers: ['Alt'] });

      const outline = page.getByTestId('selection-outline');
      await expect(outline).toBeVisible();
      await expect(outline).toHaveAttribute('data-readonly', 'true');
      await expect(outline).toHaveAttribute('data-selected-id', 'e1');
      await expect(outline).toHaveAttribute('data-selected-path', '0.1');
      await expect(page.locator('[data-testid^="handle-"]')).toHaveCount(0);
      await expect(page.getByTestId('rotate-handle')).toHaveCount(0);

      const headingBefore = await headingGeometry(editor.frame);
      const wrapperBefore = await slideInnerGeometry(editor.frame);
      expect(headingBefore.position).toBe('');

      // There is no east handle to grab. Dispatch the same pointer sequence a
      // handle drag would use at the heading's east edge; the nested
      // read-only selection must ignore it.
      await editor.frame.locator('h1').evaluate((heading) => {
        const rect = heading.getBoundingClientRect();
        type FrameEvent = Parameters<typeof heading.dispatchEvent>[0];
        const view = heading.ownerDocument.defaultView as unknown as {
          PointerEvent: new (
            type: string,
            init?: Record<string, unknown>
          ) => FrameEvent;
        } | null;
        if (!view) throw new Error('Frame window is unavailable.');
        const pointer = {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          button: 0,
          altKey: true,
          clientX: rect.right - 1,
          clientY: rect.top + rect.height / 2
        };
        heading.dispatchEvent(
          new view.PointerEvent('pointerdown', { ...pointer, buttons: 1 })
        );
        heading.dispatchEvent(
          new view.PointerEvent('pointermove', {
            ...pointer,
            buttons: 1,
            clientX: pointer.clientX - 40
          })
        );
        heading.dispatchEvent(
          new view.PointerEvent('pointerup', {
            ...pointer,
            buttons: 0,
            clientX: pointer.clientX - 40
          })
        );
      });

      expect(await headingGeometry(editor.frame)).toEqual(headingBefore);
      expect(await slideInnerGeometry(editor.frame)).toEqual(wrapperBefore);

      // Arrow keys neither nudge the nested element nor change slides.
      await page.keyboard.press('ArrowRight');
      await expectNoDeckSave(page);
      expect(await headingGeometry(editor.frame)).toEqual(headingBefore);
      await expect(editor.frame.locator('h1')).toHaveText('Untitled deck');
      await expect(page.getByTestId('save-status')).toHaveText('已載入');
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'dragging the selected top-level object pins absolute geometry and saves',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      const heading = editor.frame.locator('h1');
      const box = await heading.boundingBox();
      if (!box) throw new Error('Heading has no bounding box.');
      const scale = await frameScale(page);
      const startX = box.x + box.width / 2;
      const startY = box.y + box.height / 2;

      await heading.click();
      await expect(page.getByTestId('selection-outline')).toHaveAttribute(
        'data-selected-path',
        '0'
      );

      const save = waitForDeckSave(page);
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      // A small move stays inside the snap threshold and renders a guide.
      await page.mouse.move(startX + 3, startY + 1);
      await expect(page.getByTestId('guide-x')).toBeVisible();
      await page.mouse.move(startX + 100, startY + 50, { steps: 5 });
      await page.mouse.up();
      await expect(page.getByTestId('guide-x')).toHaveCount(0);
      expect((await save).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      const geometry = await slideInnerGeometry(editor.frame);
      expect(geometry.position).toBe('absolute');
      expect(geometry.left).toBeCloseTo(100 / scale, 0);
      expect(geometry.top).toBeCloseTo(50 / scale, 0);

      await expect
        .poll(async () => (await savedSlideInnerStyle(editor.directory, editor.file)).position)
        .toBe('absolute');
      const saved = await savedSlideInnerStyle(editor.directory, editor.file);
      expect(Number.parseFloat(saved.left ?? '')).toBeCloseTo(100 / scale, 0);
      expect(Number.parseFloat(saved.top ?? '')).toBeCloseTo(50 / scale, 0);

      const html = await readFile(join(editor.directory, editor.file), 'utf8');
      expect(html).not.toContain('data-testid');
      expect(html).not.toContain('data-ppt-frame-slide');
      expect(html).not.toContain('contenteditable');
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'resizing from the east handle changes width but not height',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      await editor.frame.locator('h1').click();
      const east = page.getByTestId('handle-e');
      await expect(east).toBeVisible();

      const before = await slideInnerGeometry(editor.frame);
      expect(before.height).toBeNull();
      const scale = await frameScale(page);
      const handleBox = await east.boundingBox();
      if (!handleBox) throw new Error('East handle has no bounding box.');

      const save = waitForDeckSave(page);
      await page.mouse.move(
        handleBox.x + handleBox.width / 2,
        handleBox.y + handleBox.height / 2
      );
      await page.mouse.down();
      await page.mouse.move(
        handleBox.x + handleBox.width / 2 - 80,
        handleBox.y + handleBox.height / 2,
        { steps: 5 }
      );
      await page.mouse.up();
      expect((await save).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      const after = await slideInnerGeometry(editor.frame);
      expect(after.height).toBe(900);
      expect(after.width).not.toBeNull();
      expect(after.width!).toBeCloseTo(CANVAS_WIDTH - 80 / scale, 0);

      await expect
        .poll(async () => (await savedSlideInnerStyle(editor.directory, editor.file)).width)
        .not.toBeNull();
      const saved = await savedSlideInnerStyle(editor.directory, editor.file);
      expect(Number.parseFloat(saved.height ?? '')).toBe(900);
      expect(Number.parseFloat(saved.width ?? '')).toBeCloseTo(
        CANVAS_WIDTH - 80 / scale,
        0
      );
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'rotation stays raw without shift and snaps to 15 degree steps with shift',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      await editor.frame.locator('h1').click();
      const rotate = page.getByTestId('rotate-handle');
      await expect(rotate).toBeVisible();
      const elementBox = await editor.frame.locator('.slide-inner').boundingBox();
      const handleBox = await rotate.boundingBox();
      if (!elementBox || !handleBox) {
        throw new Error('Rotation geometry is unavailable.');
      }
      const center = centerOfBox(elementBox);
      const radius = 240;
      const targetPoint = pointAt(center, radius, -33);

      const firstSave = waitForDeckSave(page);
      await page.mouse.move(
        handleBox.x + handleBox.width / 2,
        handleBox.y + handleBox.height / 2
      );
      await page.mouse.down();
      await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 8 });
      await page.mouse.up();
      expect((await firstSave).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      const expectedRaw = normalizeAngle(
        angleDelta(
          pointerAngle(center, {
            x: handleBox.x + handleBox.width / 2,
            y: handleBox.y + handleBox.height / 2
          }),
          pointerAngle(center, targetPoint)
        )
      );
      const raw = rotationDegrees(
        await transformOf(editor.frame, '.slide-inner')
      );
      expect(Math.abs(raw - expectedRaw)).toBeLessThanOrEqual(2);
      expect(raw % 15).toBeGreaterThan(1);

      const handleBoxAfter = await rotate.boundingBox();
      if (!handleBoxAfter) {
        throw new Error('Rotation handle has no bounding box after the gesture.');
      }
      const shiftTarget = pointAt(center, radius, -3);
      const expectedSnapped = normalizeAngle(
        Math.round(
          normalizeAngle(
            raw +
              angleDelta(
                pointerAngle(center, {
                  x: handleBoxAfter.x + handleBoxAfter.width / 2,
                  y: handleBoxAfter.y + handleBoxAfter.height / 2
                }),
                pointerAngle(center, shiftTarget)
              )
          ) / 15
        ) * 15
      );

      const secondSave = waitForDeckSave(page);
      await page.keyboard.down('Shift');
      await page.mouse.move(
        handleBoxAfter.x + handleBoxAfter.width / 2,
        handleBoxAfter.y + handleBoxAfter.height / 2
      );
      await page.mouse.down();
      await page.mouse.move(shiftTarget.x, shiftTarget.y, { steps: 8 });
      await page.mouse.up();
      await page.keyboard.up('Shift');
      expect((await secondSave).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      const snapped = rotationDegrees(
        await transformOf(editor.frame, '.slide-inner')
      );
      expect(snapped % 15).toBe(0);
      expect(Math.abs(snapped - expectedSnapped)).toBeLessThanOrEqual(1);
      expect(Math.abs(snapped - raw)).toBeGreaterThan(5);

      // Alt disables the 15 degree snap even while Shift is held.
      const handleBoxAlt = await rotate.boundingBox();
      if (!handleBoxAlt) {
        throw new Error('Rotation handle has no bounding box for alt drag.');
      }
      const altTarget = pointAt(center, radius, 47);
      const expectedAltRaw = normalizeAngle(
        snapped +
          angleDelta(
            pointerAngle(center, {
              x: handleBoxAlt.x + handleBoxAlt.width / 2,
              y: handleBoxAlt.y + handleBoxAlt.height / 2
            }),
            pointerAngle(center, altTarget)
          )
      );

      const thirdSave = waitForDeckSave(page);
      await page.mouse.move(
        handleBoxAlt.x + handleBoxAlt.width / 2,
        handleBoxAlt.y + handleBoxAlt.height / 2
      );
      await page.mouse.down();
      await page.keyboard.down('Alt');
      await page.keyboard.down('Shift');
      await page.mouse.move(altTarget.x, altTarget.y, { steps: 8 });
      await page.mouse.up();
      await page.keyboard.up('Shift');
      await page.keyboard.up('Alt');
      expect((await thirdSave).ok()).toBeTruthy();

      const altRaw = rotationDegrees(
        await transformOf(editor.frame, '.slide-inner')
      );
      expect(Math.abs(altRaw - expectedAltRaw)).toBeLessThanOrEqual(2);
      expect(altRaw % 15).toBeGreaterThan(1);

      const finalTransform = await transformOf(
        editor.frame,
        '.slide-inner'
      );
      await expect
        .poll(
          async () =>
            (
              await savedSlideInnerStyle(editor.directory, editor.file)
            ).transform ?? null
        )
        .toBe(finalTransform);
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'alt disables snapping during a drag',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      const heading = editor.frame.locator('h1');
      await heading.click();
      await expect(page.getByTestId('selection-outline')).toHaveAttribute(
        'data-selected-path',
        '0'
      );
      const box = await heading.boundingBox();
      if (!box) throw new Error('Heading has no bounding box.');
      const scale = await frameScale(page);
      const startX = box.x + box.width / 2;
      const startY = box.y + box.height / 2;

      const save = waitForDeckSave(page);
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      // Alt is held during the move, which must bypass snapping.
      await page.keyboard.down('Alt');
      await page.mouse.move(startX + 3, startY + 3, { steps: 2 });
      await expect(page.getByTestId('guide-x')).toHaveCount(0);
      await expect(page.getByTestId('guide-y')).toHaveCount(0);
      await page.mouse.up();
      await page.keyboard.up('Alt');
      expect((await save).ok()).toBeTruthy();

      const geometry = await slideInnerGeometry(editor.frame);
      expect(geometry.position).toBe('absolute');
      expect(geometry.left).toBeCloseTo(3 / scale, 0);
      expect(geometry.top).toBeCloseTo(3 / scale, 0);
      expect(geometry.left).toBeGreaterThan(0);
      expect(geometry.top).toBeGreaterThan(0);
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'arrow keys nudge a movable top-level object by 1 px and 10 px with shift',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openNudgeDeck(page);
    try {
      const object = editor.frame.locator('[data-ppt-el="box1"]');
      await object.click();

      const outline = page.getByTestId('selection-outline');
      await expect(outline).toBeVisible();
      await expect(outline).toHaveAttribute('data-selected-id', 'box1');
      await expect(outline).toHaveAttribute('data-selected-path', '1');
      await expect(outline).not.toHaveAttribute('data-readonly', 'true');

      const iframeBox = await page.locator(FRAME_SELECTOR).boundingBox();
      const scale = await frameScale(page);
      const designRect = await object.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        };
      });
      const outlineBox = await outline.boundingBox();
      if (!iframeBox || !outlineBox) {
        throw new Error('Overlay alignment geometry is unavailable.');
      }
      const expected = {
        x: iframeBox.x + designRect.x * scale,
        y: iframeBox.y + designRect.y * scale,
        width: designRect.width * scale,
        height: designRect.height * scale
      };
      expect(Math.abs(outlineBox.x - expected.x)).toBeLessThanOrEqual(2);
      expect(Math.abs(outlineBox.y - expected.y)).toBeLessThanOrEqual(2);
      expect(Math.abs(outlineBox.width - expected.width)).toBeLessThanOrEqual(2);
      expect(Math.abs(outlineBox.height - expected.height)).toBeLessThanOrEqual(2);

      const before = await inlineGeometryOf(object);
      expect(before.left).toBe(120);
      expect(before.top).toBe(160);

      const firstSave = waitForDeckSave(page);
      await page.keyboard.press('ArrowRight');
      expect((await firstSave).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      let geometry = await inlineGeometryOf(object);
      expect(geometry.position).toBe('absolute');
      expect(geometry.left).toBeCloseTo(121, 2);
      expect(geometry.top).toBeCloseTo(160, 2);

      const secondSave = waitForDeckSave(page);
      await page.keyboard.press('Shift+ArrowRight');
      expect((await secondSave).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      geometry = await inlineGeometryOf(object);
      expect(geometry.left).toBeCloseTo(131, 2);
      await expect
        .poll(async () => (await savedNudgeBoxStyle(editor.directory, editor.file)).left)
        .not.toBeNull();
      const saved = await savedNudgeBoxStyle(editor.directory, editor.file);
      expect(Number.parseFloat(saved.left ?? '')).toBeCloseTo(131, 2);
      expect(Number.parseFloat(saved.top ?? '')).toBeCloseTo(160, 2);
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'reloading the editor preserves the saved transform',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      const heading = editor.frame.locator('h1');
      const box = await heading.boundingBox();
      if (!box) throw new Error('Heading has no bounding box.');
      const startX = box.x + box.width / 2;
      const startY = box.y + box.height / 2;

      const save = waitForDeckSave(page);
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + 60, startY + 30, { steps: 4 });
      await page.mouse.up();
      expect((await save).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
      const beforeReload = await slideInnerGeometry(editor.frame);

      await page.reload();
      const reloadedFrame = page.frameLocator(FRAME_SELECTOR);
      await expect(reloadedFrame.locator('h1')).toContainText('Untitled deck');
      await expect(page.getByTestId('save-status')).toHaveText('已載入');

      const afterReload = await slideInnerGeometry(reloadedFrame);
      expect(afterReload.position).toBe('absolute');
      expect(afterReload.left).toBeCloseTo(beforeReload.left!, 1);
      expect(afterReload.top).toBeCloseTo(beforeReload.top!, 1);
      expect(afterReload.left!).toBeGreaterThan(0);
      expect(afterReload.top!).toBeGreaterThan(0);
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'arrow keys do nothing while editing text',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      const heading = editor.frame.locator('h1');
      await heading.dblclick();
      await expect(heading).toHaveAttribute('contenteditable', 'true');
      const headingBefore = await headingGeometry(editor.frame);
      const wrapperBefore = await slideInnerGeometry(editor.frame);

      await page.keyboard.press('ArrowRight');
      await expectNoDeckSave(page);

      expect(await headingGeometry(editor.frame)).toEqual(headingBefore);
      expect(await slideInnerGeometry(editor.frame)).toEqual(wrapperBefore);
      await expect(heading).toHaveText('Untitled deck');
      await expect(page.getByTestId('save-status')).toHaveText('已載入');
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'escape and pointercancel cancel a drag without saving',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      const outline = page.getByTestId('selection-outline');
      const frameHandle = page.locator(FRAME_SELECTOR);
      const heading = editor.frame.locator('h1');
      const box = await heading.boundingBox();
      if (!box) throw new Error('Heading has no bounding box.');
      const startX = box.x + box.width / 2;
      const startY = box.y + box.height / 2;

      // Escape cancels: live inline styles are replaced from the master.
      await heading.click();
      await expect(outline).toHaveAttribute('data-selected-path', '0');
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + 100, startY + 50, { steps: 4 });
      await expect
        .poll(async () => (await slideInnerGeometry(editor.frame)).position)
        .toBe('absolute');

      await page.keyboard.press('Escape');
      await expect
        .poll(async () => (await slideInnerGeometry(editor.frame)).position)
        .toBe('');
      await expect(outline).toHaveCount(0);
      await expect(heading).toHaveText('Untitled deck');
      await expectNoDeckSave(page);
      await page.mouse.up();
      await expect(page.getByTestId('save-status')).toHaveText('已載入');

      // pointercancel uses the same cancellation path.
      await heading.click();
      await expect(outline).toHaveAttribute('data-selected-path', '0');
      await frameHandle.evaluate((iframe) => {
        const view = (
          iframe as unknown as {
            contentDocument: { defaultView: FrameDomWindow | null } | null;
          }
        ).contentDocument?.defaultView;
        if (!view) return;
        view.document.addEventListener(
          'pointerdown',
          (event) => {
            view.__pptPointerId = event.pointerId;
          },
          { once: true, capture: true }
        );
      });

      await page.mouse.move(startX, startY);
      await page.mouse.down();
      const pointerId = await frameHandle.evaluate((iframe) => {
        const view = (
          iframe as unknown as {
            contentDocument: { defaultView: FrameDomWindow | null } | null;
          }
        ).contentDocument?.defaultView;
        return view?.__pptPointerId ?? -1;
      });
      expect(pointerId).toBeGreaterThan(0);
      await page.mouse.move(startX + 100, startY + 50, { steps: 4 });
      await expect
        .poll(async () => (await slideInnerGeometry(editor.frame)).position)
        .toBe('absolute');

      await frameHandle.evaluate((iframe, id) => {
        const view = (
          iframe as unknown as {
            contentDocument: { defaultView: FrameDomWindow | null } | null;
          }
        ).contentDocument?.defaultView;
        if (!view) throw new Error('Frame view is unavailable.');
        view.document.dispatchEvent(
          new view.PointerEvent('pointercancel', {
            pointerId: id,
            bubbles: true
          })
        );
      }, pointerId);

      await expect
        .poll(async () => (await slideInnerGeometry(editor.frame)).position)
        .toBe('');
      await expect(outline).toHaveCount(0);
      await expectNoDeckSave(page);
      await page.mouse.up();
      await expect(page.getByTestId('save-status')).toHaveText('已載入');
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'arrow keys change slides when no object is selected',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      await expect(page.getByTestId('selection-outline')).toHaveCount(0);

      await page.keyboard.press('ArrowRight');
      await expect(editor.frame.locator('h1')).toHaveText('Untitled deck — 2');

      await page.keyboard.press('ArrowLeft');
      await expect(editor.frame.locator('h1')).toHaveText('Untitled deck');
    } finally {
      await closeEditor(editor);
    }
  }
);
