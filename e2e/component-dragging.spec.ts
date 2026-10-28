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
