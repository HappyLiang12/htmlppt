import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Request } from '@playwright/test';
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

    // The shape must actually follow the pointer, not merely save a matrix.
    const afterDrag = await deck.frame.locator('#dot').boundingBox();
    if (!afterDrag) throw new Error('No box for #dot after the drag');
    expect(Math.abs(afterDrag.x - box.x - 40)).toBeLessThanOrEqual(2);
    expect(Math.abs(afterDrag.y - box.y - 20)).toBeLessThanOrEqual(2);
    // The overlay stores the design rect it moved, so the outline must land on
    // the shape's measured box after the gesture, not only when selected.
    expect(
      deviation(await boxOfLocator(outline), fromBoundingBox(afterDrag))
    ).toBeLessThanOrEqual(1);

    // A nudge is a second gesture on the same shape: it must append another
    // translate and save, never fall back to absolute geometry.
    const saveAfterNudge = waitForDeckSave(page);
    await page.keyboard.press('Shift+ArrowRight');
    await saveAfterNudge;
    await expect(page.getByTestId('save-status')).toHaveText('已儲存');
    const nudged = await deck.frame.locator('#dot').boundingBox();
    const slideBox = await deck.frame.locator('[data-slide-id]').boundingBox();
    const scale = slideBox!.width / 1600;
    expect(nudged!.x - afterDrag!.x).toBeGreaterThan(10 * scale - 2);
    expect(nudged!.x - afterDrag!.x).toBeLessThan(10 * scale + 2);
    const htmlAfterNudge = await readFile(deck.path, 'utf8');
    expect(htmlAfterNudge).toMatch(/id="dot"[^>]*transform="[^"]*translate\(/);
    expect(htmlAfterNudge).not.toMatch(/id="dot"[^>]*position: absolute/);
    expect(htmlAfterNudge).not.toMatch(/id="dot"[^>]*style="[^"]*(left|top):/);

    // Escape leaves the svg context for the chart figure, so the svg root is a
    // direct child and a width commit targets the svg itself.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('edit-context')).toContainText('chart-card');
    await deck.frame.locator('#chart-svg').click({ position: { x: 40, y: 40 } });
    const widthField = page.getByTestId('field-width');
    await expect(widthField).toBeEnabled();
    const saveAfterWidth = waitForDeckSave(page);
    await widthField.fill('480');
    await widthField.press('Enter');
    await saveAfterWidth;
    await expect(page.getByTestId('save-status')).toHaveText('已儲存');
    // A width commit on the svg must not re-render the owning figure: that
    // would replace the svg and drop the shape's dragged transform.
    const htmlAfterWidth = await readFile(deck.path, 'utf8');
    expect(htmlAfterWidth).toMatch(/id="dot"[^>]*transform="[^"]*translate\(/);
  } finally {
    await deck.close();
  }
});

test('reselects the chart figure after applying chart data', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    // The chart figure is atomic: the first double-click enters the figure,
    // the second enters its svg, and then the circle is a direct child.
    await deck.frame.locator('#chart-svg').dblclick({ position: { x: 40, y: 40 } });
    await expect(page.getByTestId('edit-context')).toContainText('chart-card');
    await deck.frame.locator('#chart-svg').dblclick({ position: { x: 40, y: 40 } });
    await expect(page.getByTestId('edit-context')).toContainText('svg');
    await deck.frame.locator('#dot').click();
    await expect(page.getByTestId('selection-outline')).toHaveAttribute(
      'data-selected-path',
      await pathOf(deck, '#dot')
    );
    await expect(deck.frame.locator('#dot')).toHaveCount(1);

    await page.getByTestId('chart-edit').click();
    const json = page.getByTestId('chart-json');
    await expect(json).toHaveValue(/"type": "bar"/);
    const data = {
      type: 'bar',
      title: 'Edited',
      labels: ['Q1', 'Q2'],
      series: [{ name: 'S', values: [5, 15] }],
      colors: ['#4f7cff'],
      legend: false,
      valueLabels: true
    };
    await json.fill(JSON.stringify(data, null, 2));
    const save = waitForDeckSave(page);
    await page.getByTestId('chart-apply').click();
    await save;
    await expect(page.getByTestId('save-status')).toHaveText('已儲存');

    // The apply regenerates the figure's innerHTML, so a path to the old svg
    // or its circle no longer identifies a chart node. The selection must move
    // to the owning figure instead of leaving a stale descendant path.
    const outline = page.getByTestId('selection-outline');
    await expect(outline).toHaveAttribute('data-selected-id', 'chart');
    await expect(outline).toHaveAttribute(
      'data-selected-path',
      await pathOf(deck, '#chart')
    );
    // The generated chart owns the figure content; the authored #dot fixture
    // circle is regenerated away, while the chart itself stays rendered.
    await expect(deck.frame.locator('#chart svg')).toHaveCount(1);
    await expect(deck.frame.locator('#chart')).toContainText('Edited');

    // Undo restores the authored chart card, including the fixture circle.
    const undoSave = waitForDeckSave(page);
    await page.keyboard.press('Control+z');
    await undoSave;
    await expect(deck.frame.locator('#dot')).toHaveCount(1);
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

    // The keyboard path has the same contract as the pointer path: a shape
    // whose rendering is owned by CSS cannot be nudged through the attribute.
    await page.keyboard.press('Shift+ArrowRight');
    await page.waitForTimeout(250);
    const afterNudge = await dot.boundingBox();
    if (!afterNudge) throw new Error('No box for #css-dot after the nudge');
    expect(
      deviation(fromBoundingBox(afterNudge), fromBoundingBox(before))
    ).toBeLessThanOrEqual(1);
    expect(await dot.getAttribute('transform')).toBeNull();
    await expect(page.getByTestId('save-status')).toHaveText('已同步');
  } finally {
    await deck.close();
  }
});

test('keeps a stylesheet-transformed SVG shape inert', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    // The stylesheet rule outranks the authored attribute: the computed matrix
    // is the rotation while the attribute stays in the markup, so CSS owns the
    // rendering even though an attribute is present.
    await deck.frame.locator('#css-shape-b').dblclick();
    await expect(page.getByTestId('edit-context')).toContainText('.css-shape-b');

    const dot = deck.frame.locator('#css-dot-b');
    // The shape stays selectable, but the preview must not promise a move.
    await dot.hover();
    await expect
      .poll(() => dot.evaluate((element) => getComputedStyle(element).cursor))
      .toBe('default');

    await dot.click();
    await expect(page.getByTestId('selection-outline')).toHaveAttribute(
      'data-selected-path',
      await pathOf(deck, '#css-dot-b')
    );

    const before = await dot.boundingBox();
    if (!before) throw new Error('No box for #css-dot-b');
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 + 40, before.y + before.height / 2 + 20, { steps: 5 });
    await page.mouse.up();
    // A guarded gesture never writes; give a wrong background save time to
    // surface before asserting the untouched status.
    await page.waitForTimeout(250);

    const after = await dot.boundingBox();
    if (!after) throw new Error('No box for #css-dot-b after the drag');
    expect(
      deviation(fromBoundingBox(after), fromBoundingBox(before))
    ).toBeLessThanOrEqual(1);
    // The inert attribute must survive the rejected gesture verbatim.
    expect(await dot.getAttribute('transform')).toBe('translate(2 2)');
    await expect(page.getByTestId('save-status')).toHaveText('已同步');
    const html = await readFile(deck.path, 'utf8');
    expect(html).not.toMatch(/id="css-dot-b"[^>]*position: absolute/);
    expect(html).not.toMatch(/id="css-dot-b"[^>]*style="[^"]*(left|top):/);
    expect(html.match(/id="css-dot-b"[^>]*transform="translate\(2 2\)"/g)).toHaveLength(1);
  } finally {
    await deck.close();
  }
});

test('duplicates a stylesheet-owned svg shape without an inert offset', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    // The stylesheet transform outranks the authored attribute, so the copy
    // must stay inert: a translate appended in the master document cannot see
    // the stylesheet and would silently offset a shape CSS still owns.
    await deck.frame.locator('#css-shape-b').dblclick();
    await expect(page.getByTestId('edit-context')).toContainText('.css-shape-b');
    await deck.frame.locator('#css-dot-b').click();
    await expect(page.getByTestId('selection-outline')).toHaveAttribute(
      'data-selected-path',
      await pathOf(deck, '#css-dot-b')
    );

    const save = waitForDeckSave(page);
    await page.keyboard.press('Control+d');
    await save;
    await expect(page.getByTestId('save-status')).toHaveText('已儲存');

    const circles = deck.frame.locator('#css-shape-b circle');
    await expect(circles).toHaveCount(2);
    expect(
      await circles.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('transform'))
      )
    ).toEqual(['translate(2 2)', 'translate(2 2)']);
    const html = await readFile(deck.path, 'utf8');
    expect(html).not.toContain('translate(2 2) translate(20 20)');

    const undoSave = waitForDeckSave(page);
    await page.keyboard.press('Control+z');
    await undoSave;
    await expect(circles).toHaveCount(1);
  } finally {
    await deck.close();
  }
});

test('selects a table cell but refuses to drag or nudge it', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    const cell = deck.frame.locator('#cell-a');
    await cell.click();
    await expect(page.getByTestId('table-toolbar')).toBeVisible();
    const hint = page.getByTestId('edit-hint');
    // Selecting the cell is not a refused gesture: the probe stays quiet until
    // the pointer actually travels.
    await expect(hint).toHaveCount(0);
    const cellBox = await cell.boundingBox();
    if (!cellBox) throw new Error('No box for #cell-a');
    const cellStart = fromBoundingBox(cellBox);

    // A pointer drag inside the cell keeps the native text selection, but the
    // cell owns no movable geometry: nothing may be pinned or saved.
    // Chromium does not acknowledge synthetic mouse moves while a native text
    // selection drag is active inside a sandboxed frame, so the touch start
    // only installs the probe. Every distance sample below is a mouse move,
    // and the above-threshold one must reach that probe, so a future
    // pointer-type filter would fail this test.
    const startX = cellBox.x + 10;
    const startY = cellBox.y + 10;
    const cdp = await page.context().newCDPSession(page);
    // Chromium swallows touch moves below its slop (~3 page px), which is
    // already past the 2 screen px probe threshold, so a touch sample alone
    // cannot prove the gate. Count pointer moves on the frame and take the
    // sub-threshold sample as a bare mouse move at the same point: the probe
    // compares coordinates only, and the counter proves the frame saw it.
    await page.evaluate(() => {
      const frame = document.querySelector(
        'iframe[title="投影片預覽"]'
      ) as HTMLIFrameElement | null;
      const doc = frame?.contentDocument;
      const win = doc?.defaultView as
        | (Window & { __moves?: number })
        | null;
      if (win) win.__moves = 0;
      doc?.addEventListener('pointermove', () => {
        if (win) win.__moves = (win.__moves ?? 0) + 1;
      });
    });
    const framePointerMoves = () =>
      page.evaluate(() => {
        const frame = document.querySelector(
          'iframe[title="投影片預覽"]'
        ) as HTMLIFrameElement | null;
        const win = frame?.contentDocument?.defaultView as
          | (Window & { __moves?: number })
          | null;
        return win?.__moves ?? -1;
      });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ id: 0, x: startX, y: startY }]
    });
    // A move below the drag threshold must not surface the refusal, so the
    // hint below can only be the probe's own threshold signal.
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ id: 0, x: startX + 1, y: startY }]
    });
    await expect(hint).toHaveCount(0);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: startX + 1,
      y: startY,
      button: 'none',
      buttons: 0
    });
    await expect.poll(framePointerMoves).toBeGreaterThan(0);
    await expect(hint).toHaveCount(0);
    // The mouse move crosses the threshold, so the probe installed by the
    // touch start must surface the refusal.
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: startX + 40,
      y: startY + 30,
      button: 'none',
      buttons: 0
    });
    await page.waitForTimeout(250);
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('表格');
    // The touch point is still live, so end it; the probe is already detached.
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: []
    });
    await page.waitForTimeout(250);
    const afterDrag = await cell.boundingBox();
    if (!afterDrag) throw new Error('No box for #cell-a after the drag');
    expect(deviation(cellStart, fromBoundingBox(afterDrag))).toBeLessThanOrEqual(1);
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('表格');
    await expect(page.getByTestId('save-status')).toHaveText('已同步');

    // The keyboard path explains itself instead of silently doing nothing.
    await page.getByTestId('edit-hint-dismiss').click();
    await expect(hint).toHaveCount(0);
    await page.keyboard.press('ArrowRight');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('表格');
    const afterNudge = await cell.boundingBox();
    if (!afterNudge) throw new Error('No box for #cell-a after the nudge');
    expect(deviation(cellStart, fromBoundingBox(afterNudge))).toBeLessThanOrEqual(1);
    await expect(page.getByTestId('save-status')).toHaveText('已同步');
    // Delete must not inherit this hint, so dismiss it while it is guaranteed
    // visible; the leg below re-checks the count right before Delete.
    await page.getByTestId('edit-hint-dismiss').click();
    await expect(hint).toHaveCount(0);

    // A mixed selection drags its HTML targets and leaves the cell untouched.
    await deck.frame.locator('#decor').click({ modifiers: ['Shift'] });
    // The table toolbar belongs to exactly one cell; a multi-selection whose
    // primary target happens to be a cell must not keep offering it. The chart
    // editor likewise never describes a multi-selection.
    await expect(page.getByTestId('table-toolbar')).toHaveCount(0);
    await expect(page.getByTestId('chart-edit')).toHaveCount(0);
    const decorBefore = await deck.frame.locator('#decor').boundingBox();
    if (!decorBefore) throw new Error('No box for #decor');
    const cellBeforeMixed = await cell.boundingBox();
    if (!cellBeforeMixed) throw new Error('No box for #cell-a before the mixed drag');
    const save = waitForDeckSave(page);
    await page.mouse.move(decorBefore.x + decorBefore.width / 2, decorBefore.y + decorBefore.height / 2);
    await page.mouse.down();
    await page.mouse.move(decorBefore.x + decorBefore.width / 2 + 40, decorBefore.y + decorBefore.height / 2, { steps: 5 });
    await page.mouse.up();
    await save;
    const decorAfter = await deck.frame.locator('#decor').boundingBox();
    if (!decorAfter) throw new Error('No box for #decor after the drag');
    expect(Math.abs(decorAfter.x - decorBefore.x - 40)).toBeLessThanOrEqual(2);
    const afterMixed = await cell.boundingBox();
    if (!afterMixed) throw new Error('No box for #cell-a after the mixed drag');
    expect(deviation(fromBoundingBox(cellBeforeMixed), fromBoundingBox(afterMixed))).toBeLessThanOrEqual(1);
    const html = await readFile(deck.path, 'utf8');
    expect(html).not.toMatch(/id="cell-a"[^>]*(position: absolute|left:|top:)/);

    // The drag left the decor past the slide's right edge. The first nudge
    // clamps it back to the bound; the next one cannot move it at all. That
    // clamped HTML target is the obstacle, so the selected cell must not take
    // the blame for the no-op.
    await page.keyboard.press('Shift+ArrowRight');
    await expect(page.getByTestId('save-status')).toHaveText('已儲存');
    // A mixed nudge that moves its HTML target writes and saves without blaming
    // the cell either.
    await expect(hint).toHaveCount(0);
    const clampedDecor = await deck.frame.locator('#decor').boundingBox();
    const clampedCell = await cell.boundingBox();
    if (!clampedDecor || !clampedCell) throw new Error('No box after the clamp nudge');
    expect(clampedDecor.x).toBeLessThan(decorAfter.x);
    await page.keyboard.press('Shift+ArrowRight');
    await page.waitForTimeout(250);
    await expect(hint).toHaveCount(0);
    const noopDecor = await deck.frame.locator('#decor').boundingBox();
    const noopCell = await cell.boundingBox();
    if (!noopDecor || !noopCell) throw new Error('No box after the no-op nudge');
    expect(
      deviation(fromBoundingBox(clampedDecor), fromBoundingBox(noopDecor))
    ).toBeLessThanOrEqual(1);
    expect(
      deviation(fromBoundingBox(clampedCell), fromBoundingBox(noopCell))
    ).toBeLessThanOrEqual(1);
    await expect(page.getByTestId('save-status')).toHaveText('已儲存');

    // Delete refuses the cell and keeps every selected object, so the table
    // itself stays the only thing that can remove a row or column. No stale
    // hint is on screen, so the hint below can only come from Delete.
    await expect(hint).toHaveCount(0);
    const deckPuts: string[] = [];
    const recordDeckPut = (request: Request) => {
      if (
        request.method() === 'PUT' &&
        new URL(request.url()).pathname === '/api/deck'
      ) {
        deckPuts.push(request.url());
      }
    };
    page.on('request', recordDeckPut);
    const bytesBeforeDelete = await readFile(deck.path, 'utf8');
    try {
      await page.keyboard.press('Delete');
      await expect(hint).toBeVisible();
      await expect(hint).toContainText('表格');
      await expect(cell).toBeVisible();
      await expect(deck.frame.locator('#decor')).toBeVisible();
      // The autosave debounce is 800 ms, so wait past it before trusting the
      // absence of a deck PUT.
      await page.waitForTimeout(1_000);
      expect(deckPuts).toEqual([]);
      expect(await readFile(deck.path, 'utf8')).toBe(bytesBeforeDelete);
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
    } finally {
      page.off('request', recordDeckPut);
    }

    // A guarded target is the blocker here: the clamped decor cannot move
    // right, the cell must not move, and the locked wrapper explains the rest.
    // This mixed no-op contains more than the cell, so the hint must stay
    // away. The dismissal leaves no stale hint behind for the assertions.
    await page.getByTestId('edit-hint-dismiss').click();
    await expect(hint).toHaveCount(0);
    // The guarded subtree resolves to its locked wrapper and joins the cell
    // and decor, so three outlines prove the selection really is mixed.
    await deck.frame.locator('#locked-child').click({ modifiers: ['Shift'] });
    await expect(page.getByTestId('selection-outline')).toHaveCount(3);
    await expect(
      page.locator(
        '[data-testid="selection-outline"][data-selected-id="locked"]'
      )
    ).toHaveCount(1);
    const decorBeforeGuarded = await deck.frame.locator('#decor').boundingBox();
    const cellBeforeGuarded = await cell.boundingBox();
    if (!decorBeforeGuarded || !cellBeforeGuarded) {
      throw new Error('No box before the guarded nudge');
    }
    await page.keyboard.press('Shift+ArrowRight');
    await page.waitForTimeout(250);
    await expect(hint).toHaveCount(0);
    const decorAfterGuarded = await deck.frame.locator('#decor').boundingBox();
    const cellAfterGuarded = await cell.boundingBox();
    if (!decorAfterGuarded || !cellAfterGuarded) {
      throw new Error('No box after the guarded nudge');
    }
    expect(
      deviation(
        fromBoundingBox(decorBeforeGuarded),
        fromBoundingBox(decorAfterGuarded)
      )
    ).toBeLessThanOrEqual(1);
    expect(
      deviation(
        fromBoundingBox(cellBeforeGuarded),
        fromBoundingBox(cellAfterGuarded)
      )
    ).toBeLessThanOrEqual(1);
    // Nothing moved and nothing was written.
    await expect(page.getByTestId('save-status')).toHaveText('已儲存');

    // The mixed selection above has a cell as its primary target, so its
    // missing chart panel proves nothing about the gate: the ungated panel
    // never described a cell either. A chart primary target does offer the
    // data editor, and adding a second target must hide it again. This is the
    // leg the multi-selection gate fails: ungated, chart-edit stays visible.
    await deck.frame.locator('#chart').click();
    await expect(page.getByTestId('selection-outline')).toHaveCount(1);
    await expect(
      page.locator('[data-testid="selection-outline"][data-selected-id="chart"]')
    ).toHaveCount(1);
    await expect(page.getByTestId('chart-edit')).toHaveCount(1);
    // No drag and no command here: the second target only changes what the
    // Inspector may offer, so the chart itself must stay untouched.
    await deck.frame.locator('#decor').click({ modifiers: ['Shift'] });
    await expect(page.getByTestId('selection-outline')).toHaveCount(2);
    await expect(page.getByTestId('chart-edit')).toHaveCount(0);
    await expect(page.getByTestId('chart-object')).toHaveCount(0);
  } finally {
    await deck.close();
  }
});

test('drags a nested svg root with a transform', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    // The outer svg root is atomic at the slide level, so one double-click
    // enters it; the nested svg then is a direct child. Its centre sits on the
    // circle's right edge in the new non-1:1 viewport, and corner handles own
    // the margins after the first click, so enter through a bare viewport point.
    const slideBox = await deck.frame.locator('[data-slide-id]').boundingBox();
    const scale = slideBox!.width / 1600;
    const nestBox = await deck.frame.locator('#nest-wrap').boundingBox();
    if (!nestBox) throw new Error('No box for #nest-wrap');
    await page.mouse.dblclick(
      nestBox.x + 30 * scale,
      nestBox.y + 70 * scale
    );
    await expect(page.getByTestId('edit-context')).toContainText('.nest-wrap');

    // A CSS individual transform (`scale` here) composes outside the
    // presentation attribute, so the root computes `transform: none` and the
    // editor cannot append a translate without changing the authored styling.
    // The root stays selectable but is drag-inert.
    const outline = page.getByTestId('selection-outline');
    const scaledDot = deck.frame.locator('#scaled-dot');
    await scaledDot.hover();
    await expect
      .poll(() => scaledDot.evaluate((element) => getComputedStyle(element).cursor))
      .toBe('default');

    await scaledDot.click();
    await expect(outline).toHaveAttribute(
      'data-selected-path',
      await pathOf(deck, '#inner-scaled')
    );

    const scaledRoot = deck.frame.locator('#inner-scaled');
    const scaledBefore = await scaledRoot.boundingBox();
    if (!scaledBefore) throw new Error('No box for #inner-scaled');
    await page.mouse.move(
      scaledBefore.x + scaledBefore.width / 2,
      scaledBefore.y + scaledBefore.height / 2
    );
    await page.mouse.down();
    await page.mouse.move(
      scaledBefore.x + scaledBefore.width / 2 + 40,
      scaledBefore.y + scaledBefore.height / 2 + 20,
      { steps: 5 }
    );
    await page.mouse.up();
    // A guarded gesture never writes; give a wrong background save time to
    // surface before asserting the untouched status.
    await page.waitForTimeout(250);
    const scaledAfter = await scaledRoot.boundingBox();
    if (!scaledAfter) throw new Error('No box for #inner-scaled after the drag');
    expect(
      deviation(fromBoundingBox(scaledAfter), fromBoundingBox(scaledBefore))
    ).toBeLessThanOrEqual(1);
    expect(await scaledRoot.getAttribute('transform')).toBeNull();
    await expect(page.getByTestId('save-status')).toHaveText('已同步');

    await deck.frame.locator('#inner-svg').click();

    await expect(outline).toHaveAttribute(
      'data-selected-path',
      await pathOf(deck, '#inner-svg')
    );
    // A nested svg root is SVG content too: absolute geometry styles would be
    // ignored by the renderer.
    await expect(page.locator('[data-testid^="handle-"]')).toHaveCount(0);
    await expect(page.getByTestId('rotate-handle')).toHaveCount(0);
    await expect(page.getByTestId('field-x')).toBeDisabled();

    const box = await deck.frame.locator('#inner-svg').boundingBox();
    if (!box) throw new Error('No box for #inner-svg');
    const save = waitForDeckSave(page);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 10, { steps: 5 });
    await page.mouse.up();
    await save;
    await expect(page.getByTestId('save-status')).toHaveText('已儲存');

    const after = await deck.frame.locator('#inner-svg').boundingBox();
    if (!after) throw new Error('No box for #inner-svg after the drag');
    expect(Math.abs(after.x - box.x - 30)).toBeLessThanOrEqual(2);
    expect(Math.abs(after.y - box.y - 10)).toBeLessThanOrEqual(2);
    // The viewport root's own matrix includes its viewBox scale; the overlay
    // must still land on the moved element, not only on the pointer path.
    expect(
      deviation(await boxOfLocator(outline), fromBoundingBox(after))
    ).toBeLessThanOrEqual(1);
    const html = await readFile(deck.path, 'utf8');
    expect(html).toMatch(/id="inner-svg"[^>]*transform="translate\([^)]*\)"/);
    expect(html).not.toMatch(/id="inner-svg"[^>]*position: absolute/);

    // A nudge is a second gesture on the same nested root: it must move by the
    // design nudge distance in screen pixels and never pin absolute geometry.
    const saveAfterNudge = waitForDeckSave(page);
    await page.keyboard.press('Shift+ArrowRight');
    await saveAfterNudge;
    await expect(page.getByTestId('save-status')).toHaveText('已儲存');
    const nudged = await deck.frame.locator('#inner-svg').boundingBox();
    if (!nudged) throw new Error('No box for #inner-svg after the nudge');
    expect(nudged.x - after.x).toBeGreaterThan(10 * scale - 2);
    expect(nudged.x - after.x).toBeLessThan(10 * scale + 2);
    // The overlay follows the nudged root, not only the pointer path.
    expect(
      deviation(await boxOfLocator(outline), fromBoundingBox(nudged))
    ).toBeLessThanOrEqual(1);
    const htmlAfterNudge = await readFile(deck.path, 'utf8');
    expect(htmlAfterNudge).toMatch(/id="inner-svg"[^>]*transform="[^"]*translate\(/);
    expect(htmlAfterNudge).not.toMatch(/id="inner-svg"[^>]*position: absolute/);
  } finally {
    await deck.close();
  }
});

test('duplicates and deletes a nested component inside its parent', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    const heading = deck.frame.locator('#headline');
    await heading.click();
    const sourceBox = await heading.boundingBox();
    if (!sourceBox) throw new Error('No box for #headline');

    const duplicateSave = waitForDeckSave(page);
    await page.keyboard.press('Control+d');
    await duplicateSave;

    // The copy lands inside #pad, right after its source.
    await expect(deck.frame.locator('#pad h1')).toHaveCount(2);
    const clone = deck.frame.locator('#pad h1').nth(1);
    expect(await clone.evaluate((element) => element.previousElementSibling?.id)).toBe('headline');
    const cloneBox = await clone.boundingBox();
    if (!cloneBox) throw new Error('No box for the duplicate');
    const slideBox = await deck.frame.locator('[data-slide-id]').boundingBox();
    if (!slideBox) throw new Error('No box for the slide');
    // The copy offset is 20 design px; the canvas scales the 1600 px slide.
    const scale = slideBox.width / 1600;
    expect((cloneBox.x - sourceBox.x) / scale).toBeCloseTo(20, 0);
    expect((cloneBox.y - sourceBox.y) / scale).toBeCloseTo(20, 0);
    await expect(page.getByTestId('save-status')).toHaveText('已儲存');

    // Undo removes the copy and clears the selection.
    const undoSave = waitForDeckSave(page);
    await page.keyboard.press('Control+z');
    await undoSave;
    await expect(deck.frame.locator('#pad h1')).toHaveCount(1);

    // Select the source again (undo clears selections), then delete it.
    await heading.click();
    const deleteSave = waitForDeckSave(page);
    await page.keyboard.press('Delete');
    await deleteSave;
    await expect(deck.frame.locator('#headline')).toHaveCount(0);
    await expect(page.getByTestId('save-status')).toHaveText('已儲存');
  } finally {
    await deck.close();
  }
});

test('shows the nested structural hint and refuses a nested multi-selection', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    // A single nested selection explains why structural commands are off.
    await deck.frame.locator('#headline').click();
    await expect(page.getByTestId('inspector-nested-structural')).toBeVisible();

    // A nested multi-selection renders only the nested-multi structural hint,
    // then refuses duplicate without writing.
    await deck.frame.locator('#chip-one').click({ modifiers: ['Shift'] });
    await expect(page.getByTestId('selection-outline')).toHaveCount(2);
    await expect(page.getByTestId('inspector-nested-structural')).toBeVisible();
    const deckPuts: string[] = [];
    const recordDeckPut = (request: Request) => {
      if (
        request.method() === 'PUT' &&
        new URL(request.url()).pathname === '/api/deck'
      ) {
        deckPuts.push(request.url());
      }
    };
    page.on('request', recordDeckPut);
    try {
      await page.keyboard.press('Control+d');
      // The autosave debounce is 800 ms, so wait past it before trusting the
      // absence of a deck PUT.
      await page.waitForTimeout(1_000);
      expect(deckPuts).toEqual([]);
      await expect(deck.frame.locator('#pad h1')).toHaveCount(1);
    } finally {
      page.off('request', recordDeckPut);
    }

    // A mixed-depth selection must be refused as a whole too. #arrow is a
    // genuine slide child while #headline sits inside #pad, so the paths
    // differ in depth; if the guard used every instead of some, only the
    // top-level #arrow would duplicate and the deck would be written.
    await deck.frame.locator('#arrow').click();
    await deck.frame.locator('#headline').click({ modifiers: ['Shift'] });
    await expect(page.getByTestId('selection-outline')).toHaveCount(2);
    const mixedPuts: string[] = [];
    const recordMixedPut = (request: Request) => {
      if (
        request.method() === 'PUT' &&
        new URL(request.url()).pathname === '/api/deck'
      ) {
        mixedPuts.push(request.url());
      }
    };
    page.on('request', recordMixedPut);
    try {
      await page.keyboard.press('Control+d');
      // The autosave debounce is 800 ms, so wait past it before trusting the
      // absence of a deck PUT.
      await page.waitForTimeout(1_000);
      expect(mixedPuts).toEqual([]);
      await expect(deck.frame.locator('#pad h1')).toHaveCount(1);
      await expect(deck.frame.locator('#arrow')).toHaveCount(1);
    } finally {
      page.off('request', recordMixedPut);
    }
  } finally {
    await deck.close();
  }
});

test('copies and pastes a nested component as its sibling', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    const heading = deck.frame.locator('#headline');
    await heading.click();
    await page.keyboard.press('Control+c');
    const sourceBox = await heading.boundingBox();
    if (!sourceBox) throw new Error('No box for #headline');

    await deck.frame.locator('#lead').click();
    const pasteSave = waitForDeckSave(page);
    await page.keyboard.press('Control+v');
    await pasteSave;

    // The paste is a sibling of the anchor inside #pad, immediately after it,
    // and keeps the source geometry plus the 20 px copy offset. (#lead sits at
    // y=180, so an absolute y comparison against it cannot prove nesting.)
    await expect(deck.frame.locator('#pad h1')).toHaveCount(2);
    const clone = deck.frame.locator('#pad h1').nth(1);
    expect(await clone.evaluate((element) => element.previousElementSibling?.id)).toBe('lead');
    expect(await clone.evaluate((element) => element.parentElement?.id)).toBe('pad');
    const cloneBox = await clone.boundingBox();
    if (!cloneBox) throw new Error('No box for the pasted copy');
    const slideBox = await deck.frame.locator('[data-slide-id]').boundingBox();
    if (!slideBox) throw new Error('No box for the slide');
    // The copy offset is 20 design px; the canvas scales the 1600 px slide.
    const scale = slideBox.width / 1600;
    expect((cloneBox.x - sourceBox.x) / scale).toBeCloseTo(20, 0);
    expect((cloneBox.y - sourceBox.y) / scale).toBeCloseTo(20, 0);
    expect(await clone.getAttribute('data-ppt-el')).not.toBe('headline');
    await expect(page.getByTestId('save-status')).toHaveText('已儲存');

    // The copy is a real sibling in the saved deck, not only an in-memory
    // preview: it survives a reload (CD-AC7 persistence).
    await page.reload();
    await expect(page.getByTestId('save-status')).toHaveText('已同步');
    await expect(deck.frame.locator('#pad h1')).toHaveCount(2);
    expect(
      await deck.frame
        .locator('#pad h1')
        .nth(1)
        .evaluate((element) => element.previousElementSibling?.id)
    ).toBe('lead');
  } finally {
    await deck.close();
  }
});

test('pastes a top-level svg root at slide level', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    // #arrow is a genuine slide child (the fixture puts it outside #pad), so a
    // paste with no nested anchor proves the slide-level destination branch. A
    // nested svg root would take the mismatch fallback instead and pass this
    // test without ever exercising the slide-level rule.
    await deck.frame.locator('#arrow').click();
    await expect(page.getByTestId('selection-outline')).toHaveAttribute(
      'data-selected-id',
      'arrow'
    );
    await page.keyboard.press('Control+c');
    const save = waitForDeckSave(page);
    await page.keyboard.press('Control+v');
    await save;
    await expect(deck.frame.locator('#arrow')).toHaveCount(2);
    const clone = deck.frame.locator('#arrow').nth(1);
    expect(
      await clone.evaluate((element) =>
        element.parentElement?.getAttribute('data-slide-id')
      )
    ).toBe('s1');
    await expect(page.getByTestId('save-status')).toHaveText('已儲存');
  } finally {
    await deck.close();
  }
});

test('shows the paste-kind hint for an svg internal with no svg destination', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    // The chart figure is atomic: the first double-click enters the figure,
    // the second enters its svg, and then the circle is a direct child.
    await deck.frame.locator('#chart-svg').dblclick({ position: { x: 40, y: 40 } });
    await expect(page.getByTestId('edit-context')).toContainText('chart-card');
    await deck.frame.locator('#chart-svg').dblclick({ position: { x: 40, y: 40 } });
    await expect(page.getByTestId('edit-context')).toContainText('svg');
    await deck.frame.locator('#dot').click();
    await page.keyboard.press('Control+c');

    // Escape unwinds the drill-in one level at a time: svg -> chart figure ->
    // .pad -> slide. The chart figure is nested inside .pad in this fixture,
    // so the slide is three steps up.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('edit-context')).toContainText('chart-card');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('edit-context')).toContainText('.pad');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('edit-context')).toHaveCount(0);
    await deck.frame.locator('#lead').click();

    const svgCount = await deck.frame.locator('#pad svg').count();
    const deckPuts: string[] = [];
    const recordDeckPut = (request: Request) => {
      if (
        request.method() === 'PUT' &&
        new URL(request.url()).pathname === '/api/deck'
      ) {
        deckPuts.push(request.url());
      }
    };
    page.on('request', recordDeckPut);
    try {
      await page.keyboard.press('Control+v');
      const hint = page.getByTestId('edit-hint');
      await expect(hint).toBeVisible();
      await expect(hint).toContainText('SVG');
      // The autosave debounce is 800 ms, so wait past it before trusting the
      // absence of a deck PUT.
      await page.waitForTimeout(1_000);
      expect(deckPuts).toEqual([]);
      await expect(deck.frame.locator('#pad svg')).toHaveCount(svgCount);
    } finally {
      page.off('request', recordDeckPut);
    }
  } finally {
    await deck.close();
  }
});

test('refuses to paste inside a guarded subtree', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    await deck.frame.locator('#headline').click();
    await page.keyboard.press('Control+c');
    // Alt reaches the child inside the locked wrapper; a plain click would
    // resolve to the wrapper itself.
    await deck.frame.locator('#locked-child').click({ modifiers: ['Alt'] });
    await expect(page.getByTestId('selection-outline')).toBeVisible();

    const deckPuts: string[] = [];
    const recordDeckPut = (request: Request) => {
      if (
        request.method() === 'PUT' &&
        new URL(request.url()).pathname === '/api/deck'
      ) {
        deckPuts.push(request.url());
      }
    };
    page.on('request', recordDeckPut);
    try {
      await page.keyboard.press('Control+v');
      // The autosave debounce is 800 ms, so wait past it before trusting the
      // absence of a deck PUT.
      await page.waitForTimeout(1_000);
      expect(deckPuts).toEqual([]);
      await expect(deck.frame.locator('#locked p')).toHaveCount(1);
    } finally {
      page.off('request', recordDeckPut);
    }

    // The clipboard was populated, so the refused no-op above was the guard,
    // not an empty clipboard: the same paste succeeds. #arrow is a genuine
    // slide child, so the paste lands at slide level instead of inside #pad.
    await deck.frame.locator('#arrow').click();
    const pasteSave = waitForDeckSave(page);
    await page.keyboard.press('Control+v');
    await pasteSave;
    await expect(deck.frame.locator('h1')).toHaveCount(2);
  } finally {
    await deck.close();
  }
});

test('refuses to paste into a table cell', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    await deck.frame.locator('#headline').click();
    await page.keyboard.press('Control+c');
    await deck.frame.locator('#cell-a').click();
    await expect(page.getByTestId('selection-outline')).toBeVisible();

    const hint = page.getByTestId('edit-hint');
    const deckPuts: string[] = [];
    const recordDeckPut = (request: Request) => {
      if (
        request.method() === 'PUT' &&
        new URL(request.url()).pathname === '/api/deck'
      ) {
        deckPuts.push(request.url());
      }
    };
    page.on('request', recordDeckPut);
    try {
      await page.keyboard.press('Control+v');
      await expect(hint).toBeVisible();
      await expect(hint).toContainText('表格');
      // The autosave debounce is 800 ms, so wait past it before trusting the
      // absence of a deck PUT.
      await page.waitForTimeout(1_000);
      expect(deckPuts).toEqual([]);
      // Neither the heading nor any other component may land inside the table.
      await expect(deck.frame.locator('#table h1')).toHaveCount(0);
      await expect(page.getByTestId('save-status')).toHaveText('已同步');
    } finally {
      page.off('request', recordDeckPut);
    }
  } finally {
    await deck.close();
  }
});
