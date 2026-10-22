import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expect,
  test,
  type FrameLocator,
  type Locator,
  type Page
} from '@playwright/test';
import { execa } from 'execa';
import { startCliHost } from './helpers';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'packages/cli/dist/bin.js');
const FRAME_SELECTOR = 'iframe[title="投影片預覽"]';
const CANVAS_WIDTH = 1600;

interface EditorHarness {
  directory: string;
  file: string;
  host: Awaited<ReturnType<typeof startCliHost>>;
  frame: FrameLocator;
}

async function openTemplateDeck(page: Page): Promise<EditorHarness> {
  const directory = await mkdtemp(join(tmpdir(), 'htmlppt-editor-e2e-'));
  const file = 'template.html';
  await execa('node', [cliPath, 'new', file, '--slides', '2'], {
    cwd: directory
  });
  const host = await startCliHost(cliPath, directory, file);
  await page.goto(host.url);
  const frame = page.frameLocator(FRAME_SELECTOR);
  await expect(frame.locator('h1')).toContainText('Untitled deck');
  await expect(page.getByTestId('save-status')).toHaveText('已載入');
  return { directory, file, host, frame };
}

async function closeEditor(editor: EditorHarness): Promise<void> {
  await editor.host.stop();
  await rm(editor.directory, { recursive: true, force: true });
}

function waitForDeckSave(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === '/api/deck' &&
      response.ok()
  );
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

async function savedHeadingStyle(
  directory: string,
  file: string
): Promise<Record<string, string | null>> {
  return savedStyle(directory, file, /<h1[^>]*>/);
}

test(
  'clicking a slide object shows the eight-handle selection overlay',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      await editor.frame.locator('h1').click();

      await expect(page.getByTestId('selection-outline')).toBeVisible();
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
  'dragging the selected object pins absolute geometry and saves the position',
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
  'rotating with shift snaps to 15 degree steps and saves the transform',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      await editor.frame.locator('h1').click();
      const rotate = page.getByTestId('rotate-handle');
      await expect(rotate).toBeVisible();
      const handleBox = await rotate.boundingBox();
      const frameBox = await page
        .locator(FRAME_SELECTOR)
        .boundingBox();
      if (!handleBox || !frameBox) {
        throw new Error('Rotation handle has no bounding box.');
      }

      const save = waitForDeckSave(page);
      await page.keyboard.down('Shift');
      await page.mouse.move(
        handleBox.x + handleBox.width / 2,
        handleBox.y + handleBox.height / 2
      );
      await page.mouse.down();
      await page.mouse.move(
        frameBox.x + frameBox.width * 0.8,
        frameBox.y + frameBox.height / 2,
        { steps: 8 }
      );
      await page.mouse.up();
      await page.keyboard.up('Shift');
      expect((await save).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      const transform = await editor.frame
        .locator('.slide-inner')
        .evaluate((element) => {
          const style = (
            element as unknown as {
              style: { transform: string; transformOrigin: string };
            }
          ).style;
          return {
            transform: style.transform,
            transformOrigin: style.transformOrigin
          };
        });
      expect(transform.transform).toBe('rotate(90deg)');
      expect(transform.transformOrigin).toBe('50% 50%');

      await expect
        .poll(
          async () =>
            (
              await savedSlideInnerStyle(editor.directory, editor.file)
            ).transform ?? null
        )
        .toBe('rotate(90deg)');
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'arrow keys nudge the selection by 1 px and 10 px with shift',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      // The template wraps the heading in a full-bleed layout div, so drill to
      // the heading itself; a slide-sized object cannot move inside the bounds.
      await editor.frame.locator('h1').click({ modifiers: ['Alt'] });
      await expect(page.getByTestId('selection-outline')).toBeVisible();
      const before = await editor.frame.locator('h1').evaluate((element) => {
        const slide = element.closest('.slide');
        if (!slide) throw new Error('Heading is not inside a slide.');
        const heading = element.getBoundingClientRect();
        const bounds = slide.getBoundingClientRect();
        return {
          x: heading.left - bounds.left,
          y: heading.top - bounds.top
        };
      });

      const firstSave = waitForDeckSave(page);
      await page.keyboard.press('ArrowRight');
      expect((await firstSave).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      let geometry = await headingGeometry(editor.frame);
      expect(geometry.position).toBe('absolute');
      expect(geometry.left).toBeCloseTo(before.x + 1, 2);
      await expect(editor.frame.locator('h1')).toHaveText('Untitled deck');

      const secondSave = waitForDeckSave(page);
      await page.keyboard.press('Shift+ArrowRight');
      expect((await secondSave).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      geometry = await headingGeometry(editor.frame);
      expect(geometry.left).toBeCloseTo(before.x + 11, 2);
      await expect
        .poll(async () => (await savedHeadingStyle(editor.directory, editor.file)).left)
        .not.toBeNull();
      const saved = await savedHeadingStyle(editor.directory, editor.file);
      expect(Number.parseFloat(saved.left ?? '')).toBeCloseTo(
        before.x + 11,
        2
      );
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
