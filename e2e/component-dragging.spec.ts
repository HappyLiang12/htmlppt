import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { startCliHost } from './helpers';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'packages/cli/dist/bin.js');
const fixturePath = join(repoRoot, 'test-utils/fixtures/component.deck.html');
const FRAME_SELECTOR = 'iframe[title="投影片預覽"]';

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

function deviation(a: Box, b: Box): number {
  return Math.max(
    Math.abs(a.left - b.left),
    Math.abs(a.top - b.top),
    Math.abs(a.width - b.width),
    Math.abs(a.height - b.height)
  );
}

function fromBoundingBox(box: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Box {
  return { left: box.x, top: box.y, width: box.width, height: box.height };
}

async function boxOfLocator(
  locator: ReturnType<Page['locator']>
): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('No box for locator');
  return fromBoundingBox(box);
}

function waitForDeckSave(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === '/api/deck'
  );
}

async function openDeck(page: Page) {
  const directory = await mkdtemp(join(tmpdir(), 'htmlppt-component-'));
  const file = 'component.deck.html';
  await writeFile(join(directory, file), await readFile(fixturePath, 'utf8'), 'utf8');
  const host = await startCliHost(cliPath, directory, file);
  await page.goto(host.url);
  await expect(page.getByTestId('save-status')).toHaveText('已同步');
  return {
    path: join(directory, file),
    frame: page.frameLocator(FRAME_SELECTOR),
    async close() {
      await host.stop();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

/**
 * Reads the raw child-index path the editor uses for a selection. Hardcoding
 * the fixture path would silently break whenever an unrelated sibling is
 * inserted ahead of the target.
 */
async function pathOf(
  deck: { frame: ReturnType<Page['frameLocator']> },
  selector: string
): Promise<string> {
  return deck.frame.locator(selector).evaluate((element) => {
    const path: number[] = [];
    let current: Element | null = element;
    const slide = element.closest('[data-slide-id]');
    while (current && slide && current !== slide) {
      const parent: Element | null = current.parentElement;
      if (!parent) break;
      path.unshift(Array.from(parent.children).indexOf(current));
      current = parent;
    }
    return path.join('.');
  });
}

test('selects and drags the heading, not the wrapper', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    const heading = deck.frame.locator('#headline');
    const padBoxBefore = await deck.frame.locator('#pad').boundingBox();
    await heading.click();
    const outline = page.getByTestId('selection-outline');
    await expect(outline).toHaveAttribute('data-selected-id', 'headline');
    const headingBox = await heading.boundingBox();
    const outlineBox = await boxOfLocator(outline);
    expect(deviation(outlineBox, fromBoundingBox(headingBox!))).toBeLessThanOrEqual(1);

    const before = headingBox!;
    const save = waitForDeckSave(page);
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 + 60, before.y + before.height / 2 + 30, { steps: 6 });
    await page.mouse.up();
    await save;

    const after = await heading.boundingBox();
    expect(Math.abs(after!.x - before.x - 60)).toBeLessThanOrEqual(2);
    expect(Math.abs(after!.y - before.y - 30)).toBeLessThanOrEqual(2);
    const padBoxAfter = await deck.frame.locator('#pad').boundingBox();
    expect(
      deviation(
        fromBoundingBox(padBoxAfter ?? before),
        fromBoundingBox(padBoxBefore!)
      )
    ).toBeLessThanOrEqual(1);
    await expect(page.getByTestId('save-status')).toHaveText('已儲存');
    const html = await readFile(deck.path, 'utf8');
    expect(html).toContain('id="headline"');
    expect(html).toMatch(/<h1[^>]*style="[^"]*position:\s*absolute/);
    expect(html).not.toMatch(/id="pad"[^>]*style="[^"]*(left|top):/);
    expect(html).not.toContain('data-ppt-hover');
    expect(html).not.toContain('data-ppt-editor-style');
    expect(html).not.toContain('data-ppt-preview-slide');
  } finally {
    await deck.close();
  }
});

test('selects chips, steps, icons, cards, chart figures and the outer arrow', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    const outline = page.getByTestId('selection-outline');
    // Resize handles straddle the corners of the previous selection. The icon
    // svg is centered inside a 48 px box, so its handles would cover the icon's
    // own padding point; the icon comes before its svg for that reason.
    const cases: Array<[string, string, string, { x: number; y: number }?]> = [
      ['#chip-one', 'chip-one', '#chip-one'],
      ['#step-two', 'step-two', '#step-two'],
      ['#icon', 'icon', '#icon', { x: 4, y: 4 }],
      ['#icon-svg', 'icon-svg', '#icon-svg'],
      ['#card-title', 'card-title', '#card-title'],
      ['#card', 'card', '#card', { x: 4, y: 4 }],
      ['#chart-svg', 'chart', '#chart'],
      ['#arrow-path', 'arrow', '#arrow'],
      ['#dot', 'chart', '#chart']
    ];
    for (const [selector, id, expectedSelector, position] of cases) {
      const target = deck.frame.locator(selector);
      if (selector === '#arrow-path') {
        // The authored arrow is a zero-area line, so Playwright's visibility
        // check refuses a locator click. Clicking the svg's endpoint area still
        // exercises the slide-level rule: the svg root resolves to the arrow.
        const pathBox = await target.boundingBox();
        if (!pathBox) throw new Error('Arrow path has no box');
        await page.mouse.click(pathBox.x + pathBox.width, pathBox.y);
      } else {
        await target.click(position ? { position } : undefined);
      }
      await expect(outline).toHaveAttribute('data-selected-id', id);
      const expected = await deck.frame.locator(expectedSelector).boundingBox();
      expect(
        deviation(await boxOfLocator(outline), fromBoundingBox(expected!))
      ).toBeLessThanOrEqual(1);
    }
  } finally {
    await deck.close();
  }
});

test('folds inline spans into the text box and skips display:contents wrappers', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    const outline = page.getByTestId('selection-outline');
    await deck.frame.locator('#inline-word').click();
    await expect(outline).toHaveAttribute('data-selected-id', 'headline');
    // The contents paragraph is a full-width block whose center sits under the
    // heading, so click its own text instead of the occluded center.
    await deck.frame
      .locator('#contents-child')
      .click({ position: { x: 6, y: 8 } });
    await expect(outline).toHaveAttribute('data-selected-id', 'contents-child');
  } finally {
    await deck.close();
  }
});

test('guarded subtrees resolve to their wrapper', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    const outline = page.getByTestId('selection-outline');
    await deck.frame.locator('#group-child').click();
    await expect(outline).toHaveAttribute('data-selected-id', 'group');
    await deck.frame.locator('#locked-child').click();
    await expect(outline).toHaveAttribute('data-selected-id', 'locked');
    await expect(page.locator('[data-testid^="handle-"]')).toHaveCount(0);
  } finally {
    await deck.close();
  }
});

test('double-click enters a card and Enter enters a deep selected card', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    // The card's padding clears the selection handles that straddle its
    // corners, so the second click reaches the card instead of a handle.
    await deck.frame.locator('#card').dblclick({ position: { x: 100, y: 12 } });
    await expect(page.getByTestId('edit-context')).toContainText('card');
    const rows = page.getByTestId('object-row');
    await expect(rows.filter({ hasText: 'icon' })).toBeVisible();
    await expect(rows.filter({ hasText: 'h3' })).toBeVisible();
    // The card is nested in .pad, so one Escape pops to the pad level and a
    // second one returns to the slide.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('edit-context')).toContainText('.pad');
    await expect(page.getByTestId('edit-context')).not.toContainText('.card');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('edit-context')).toHaveCount(0);

    await deck.frame.locator('#card').click({ position: { x: 100, y: 12 } });
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('edit-context')).toContainText('card');
  } finally {
    await deck.close();
  }
});

test('offers a visible Enter action for a deep selected container', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    await deck.frame.locator('#card').click({ position: { x: 4, y: 4 } });
    const enterButton = page.getByTestId('inspector-enter-component');
    await expect(enterButton).toHaveAttribute('aria-label', /card/);
    await enterButton.click();
    await expect(page.getByTestId('edit-context')).toContainText('card');
    await expect(page.getByTestId('object-row').filter({ hasText: 'icon' })).toBeVisible();
    // The action unmounts with the old context; focus lands on the new list.
    await expect(page.getByTestId('object-list')).toBeFocused();
  } finally {
    await deck.close();
  }
});

test('selects the chart figure and keeps chart controls', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    await deck.frame.locator('#chart-svg').click();
    await expect(page.getByTestId('selection-outline')).toHaveAttribute('data-selected-id', 'chart');
    await expect(page.getByTestId('chart-object')).toBeVisible();
    await expect(page.getByTestId('chart-summary')).toContainText('bar');
  } finally {
    await deck.close();
  }
});

test('shift-click builds a multi-selection across depths', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    await deck.frame.locator('#headline').click();
    await deck.frame.locator('#chip-one').click({ modifiers: ['Shift'] });
    await expect(page.getByTestId('selection-outline')).toHaveCount(2);
    const headline = await deck.frame.locator('#headline').boundingBox();
    const chip = await deck.frame.locator('#chip-one').boundingBox();
    const save = waitForDeckSave(page);
    await page.mouse.move(headline!.x + headline!.width / 2, headline!.y + headline!.height / 2);
    await page.mouse.down();
    await page.mouse.move(headline!.x + headline!.width / 2 + 40, headline!.y + headline!.height / 2, { steps: 5 });
    await page.mouse.up();
    await save;
    const movedHeadline = await deck.frame.locator('#headline').boundingBox();
    const movedChip = await deck.frame.locator('#chip-one').boundingBox();
    expect(Math.abs(movedHeadline!.x - headline!.x - 40)).toBeLessThanOrEqual(2);
    expect(Math.abs(movedChip!.x - chip!.x - 40)).toBeLessThanOrEqual(2);
  } finally {
    await deck.close();
  }
});

test('hover previews the component a click will select', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    await deck.frame.locator('#headline').hover();
    const outline = page.getByTestId('hover-outline');
    await expect(outline).toBeVisible();
    await expect(page.getByTestId('hover-label')).toHaveText('h1.headline');
    const headingBox = await deck.frame.locator('#headline').boundingBox();
    expect(deviation(await boxOfLocator(outline), fromBoundingBox(headingBox!))).toBeLessThanOrEqual(1);
    expect(await deck.frame.locator('#headline').evaluate((el) => getComputedStyle(el).cursor)).toBe('move');

    // The attribute and the cursor sheet live on the frame boundary; the slide
    // subtree never learns about hover, so nothing can be serialized.
    const boundary = await deck.frame.locator('#headline').evaluate((element) => {
      const doc = element.ownerDocument;
      const slide = doc.querySelector('[data-slide-id]')!;
      return {
        attribute: doc.documentElement.getAttribute('data-ppt-hover'),
        headStyle: Boolean(doc.head.querySelector('style[data-ppt-editor-style]')),
        slideStyle: Boolean(slide.querySelector('style[data-ppt-editor-style]')),
        slideHover:
          slide.hasAttribute('data-ppt-hover') ||
          slide.querySelector('[data-ppt-hover]') !== null
      };
    });
    expect(boundary).toEqual({
      attribute: 'move',
      headStyle: true,
      slideStyle: false,
      slideHover: false
    });

    // Playwright applies `position` before the canvas scale transform, so the
    // design-pixel offset is multiplied by the frame scale to land on the
    // pad's own padding instead of past the slide edge.
    const slideBox = await deck.frame.locator('[data-slide-id]').boundingBox();
    const scale = slideBox!.width / 1600;
    await deck.frame
      .locator('#pad')
      .hover({ position: { x: 12 * scale, y: 500 * scale } });
    await expect(outline).toBeVisible();
    await expect(page.getByTestId('hover-label')).toHaveText('div.pad');

    await deck.frame.locator('#cell-a').hover();
    await expect(page.getByTestId('hover-label')).toHaveText('td');
    expect(await deck.frame.locator('#cell-a').evaluate((el) => getComputedStyle(el).cursor)).toBe('default');

    // A guarded subtree previews its wrapper and cannot promise a move.
    await deck.frame.locator('#locked-child').hover();
    await expect(page.getByTestId('hover-label')).toHaveText('div.locked');
    expect(await deck.frame.locator('#locked-child').evaluate((el) => getComputedStyle(el).cursor)).toBe('default');

    // An authored editable keeps its own caret: a click neither selects nor
    // drags it, so hover shows nothing.
    await deck.frame.locator('#editable').hover();
    await expect(outline).toHaveCount(0);

    // Leaving the frame drops the preview and the attribute.
    await deck.frame.locator('#headline').hover();
    await expect(outline).toBeVisible();
    await page.mouse.move(5, 5);
    await expect(outline).toHaveCount(0);
    expect(
      await deck.frame
        .locator('#headline')
        .evaluate((el) =>
          el.ownerDocument.documentElement.hasAttribute('data-ppt-hover')
        )
    ).toBe(false);

    // Alt deepens the click target, so the preview follows it without the
    // pointer moving; the parent document owns focus in this flow.
    await deck.frame.locator('#icon-svg').hover();
    await expect(page.getByTestId('hover-label')).toHaveText('svg');
    await page.keyboard.down('Alt');
    await expect(page.getByTestId('hover-label')).toHaveText('path');
    await page.keyboard.up('Alt');
    await expect(page.getByTestId('hover-label')).toHaveText('svg');
  } finally {
    await deck.close();
  }
});

test('enters an SVG and drags a circle with a transform', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    // The chart figure is atomic: the first double-click enters the figure,
    // the second enters its svg, and then the circle is a direct child.
    await deck.frame.locator('#chart-svg').dblclick({ position: { x: 40, y: 40 } });
    await expect(page.getByTestId('edit-context')).toContainText('chart-card');
    await deck.frame.locator('#chart-svg').dblclick({ position: { x: 40, y: 40 } });
    await expect(page.getByTestId('edit-context')).toContainText('svg');
    await deck.frame.locator('#dot').click();

    const outline = page.getByTestId('selection-outline');
    await expect(outline).toHaveAttribute(
      'data-selected-path',
      await pathOf(deck, '#dot')
    );
    // SVG internals move through their transform, so absolute geometry
    // handles would lie about what the gesture writes.
    await expect(page.locator('[data-testid^="handle-"]')).toHaveCount(0);
    await expect(page.getByTestId('rotate-handle')).toHaveCount(0);
    await expect(page.getByTestId('field-x')).toBeDisabled();

    const box = await deck.frame.locator('#dot').boundingBox();
    if (!box) throw new Error('No box for #dot');
    const save = waitForDeckSave(page);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 20, { steps: 5 });
    await page.mouse.up();
    await save;
    await expect(page.getByTestId('save-status')).toHaveText('已儲存');
    const html = await readFile(deck.path, 'utf8');
    expect(html).toMatch(/id="dot"[^>]*transform="translate\([^)]*\)"/);
    expect(html).not.toMatch(/id="dot"[^>]*position: absolute/);
  } finally {
    await deck.close();
  }
});

test('keeps a CSS-transformed SVG shape inert', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    // The svg root carries a class, and the breadcrumb prefers that class over
    // the tag, so the entered context is named .css-shape.
    await deck.frame.locator('#css-shape').dblclick();
    await expect(page.getByTestId('edit-context')).toContainText('.css-shape');

    const dot = deck.frame.locator('#css-dot');
    // CSS owns the transform, so the attribute is inert: the hover preview
    // must not promise a move even though the shape stays selectable.
    await dot.hover();
    await expect
      .poll(() => dot.evaluate((element) => getComputedStyle(element).cursor))
      .toBe('default');

    await dot.click();
    await expect(page.getByTestId('selection-outline')).toHaveAttribute(
      'data-selected-path',
      await pathOf(deck, '#css-dot')
    );

    const before = await dot.boundingBox();
    if (!before) throw new Error('No box for #css-dot');
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 + 40, before.y + before.height / 2 + 20, { steps: 5 });
    await page.mouse.up();
    // A guarded gesture never writes; give a wrong background save time to
    // surface before asserting the untouched status.
    await page.waitForTimeout(250);

    const after = await dot.boundingBox();
    if (!after) throw new Error('No box for #css-dot after the drag');
    expect(
      deviation(fromBoundingBox(after), fromBoundingBox(before))
    ).toBeLessThanOrEqual(1);
    expect(await dot.getAttribute('transform')).toBeNull();
    await expect(page.getByTestId('save-status')).toHaveText('已同步');
    const html = await readFile(deck.path, 'utf8');
    expect(html).not.toMatch(/id="css-dot"[^>]*transform=/);
    expect(html).not.toMatch(/id="css-dot"[^>]*position: absolute/);
  } finally {
    await deck.close();
  }
});
