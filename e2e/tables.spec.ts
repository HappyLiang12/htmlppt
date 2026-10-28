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

interface Harness {
  directory: string;
  file: string;
  host: Awaited<ReturnType<typeof startCliHost>>;
  frame: FrameLocator;
}

async function openDeck(page: Page): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'htmlppt-table-e2e-'));
  const file = 'table.html';
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

async function insertTable(
  page: Page,
  frame: FrameLocator,
  rows: string,
  columns: string
): Promise<void> {
  await page.getByTestId('insert-table').click();
  await page.getByTestId('table-rows').fill(rows);
  await page.getByTestId('table-columns').fill(columns);
  await page.getByTestId('table-insert').click();
  await waitForSaved(page);
  await expect(frame.locator('table[data-ppt-el]')).toBeVisible();
}

async function selectCell(
  page: Page,
  frame: FrameLocator,
  row: number,
  column: number
): Promise<void> {
  const cell = frame
    .locator('table[data-ppt-el] tr')
    .nth(row)
    .locator('td, th')
    .nth(column);
  await page.keyboard.down('Alt');
  try {
    await cell.click();
  } finally {
    await page.keyboard.up('Alt');
  }
}

async function editCell(
  page: Page,
  frame: FrameLocator,
  row: number,
  column: number,
  text: string
): Promise<void> {
  const cell = frame
    .locator('table[data-ppt-el] tr')
    .nth(row)
    .locator('td, th')
    .nth(column);
  // The first click selects the cell, so its resize handles straddle the cell
  // corners. Click inside the left padding, clear of the handles, so the second
  // click reaches the cell and starts the text edit.
  await cell.dblclick({ position: { x: 20, y: 7 } });
  await expect(cell).toHaveAttribute('contenteditable', 'true');
  await cell.evaluate((element) => {
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    const selection = element.ownerDocument.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.keyboard.type(text);
  await page.getByTestId('text-bold').click();
  await page.keyboard.press('Escape');
  await waitForSaved(page);
}

test.describe('table editing @feature:tables', () => {
  test('inserts, edits, restructures, and styles a table that survives reload', async ({
    page
  }) => {
    const harness = await openDeck(page);
    try {
      await insertTable(page, harness.frame, '3', '2');
      const table = harness.frame.locator('table[data-ppt-el]');
      await expect(table.locator('tr')).toHaveCount(3);
      await expect(table.locator('th')).toHaveCount(2);

      // A plain click selects the cell and opens the table toolbar.
      const plainCell = table.locator('tr').nth(1).locator('td, th').first();
      await plainCell.click({ position: { x: 20, y: 7 } });
      await expect(page.getByTestId('table-toolbar')).toBeVisible();
      await expect(page.getByTestId('selection-outline')).toHaveAttribute(
        'data-selected-path',
        '1.0.1.0'
      );

      await editCell(page, harness.frame, 1, 0, 'Revenue');
      await expect(
        harness.frame.locator('table[data-ppt-el] tr').nth(1).locator('td').first()
      ).toContainText('Revenue');

      await selectCell(page, harness.frame, 1, 0);
      await expect(page.getByTestId('table-toolbar')).toBeVisible();
      // A non-empty cell shows the text selection toolbar too; the table bar
      // must not paint over it.
      const tableBar = await page.getByTestId('table-toolbar').boundingBox();
      const textBar = await page.getByTestId('text-toolbar').boundingBox();
      if (!tableBar || !textBar) {
        throw new Error('Expected both the table and text toolbars.');
      }
      expect(tableBar.y + tableBar.height).toBeLessThanOrEqual(textBar.y);
      await page.getByTestId('table-row-below').click();
      await waitForSaved(page);
      await expect(table.locator('tr')).toHaveCount(4);

      await selectCell(page, harness.frame, 1, 0);
      await page.getByTestId('table-col-right').click();
      await waitForSaved(page);
      await expect(table.locator('tr').first().locator('td, th')).toHaveCount(3);

      await selectCell(page, harness.frame, 0, 0);
      await page.getByTestId('table-header-toggle').click();
      await waitForSaved(page);
      await expect(table.locator('th')).toHaveCount(0);
      await selectCell(page, harness.frame, 0, 0);
      await page.getByTestId('table-header-toggle').click();
      await waitForSaved(page);
      await expect(table.locator('th')).toHaveCount(3);

      await selectCell(page, harness.frame, 1, 1);
      const fillInput = page.getByTestId('table-cell-fill');
      await fillInput.fill('#ffeecc');
      await expect(fillInput).toHaveValue('#ffeecc');
      await page.waitForTimeout(50);
      await fillInput.blur();
      await waitForSaved(page);

      const borderInput = page.getByTestId('table-cell-border');
      await borderInput.fill('#334455');
      await expect(borderInput).toHaveValue('#334455');
      await page.waitForTimeout(50);
      await borderInput.blur();
      await waitForSaved(page);

      const html = await deckHtml(harness);
      expect(html).toContain('Revenue');
      expect(html).toContain('font-weight: bold');
      expect(html).toContain('background: rgb(255, 238, 204)');
      expect(html).toContain('1px solid rgb(51, 68, 85)');
      expect(html).not.toContain('contenteditable');

      await page.reload();
      const reloaded = page.frameLocator(FRAME_SELECTOR);
      await expect(reloaded.locator('table[data-ppt-el] tr')).toHaveCount(4);
      await expect(reloaded.locator('table[data-ppt-el] th')).toHaveCount(3);
      await expect(
        reloaded.locator('table[data-ppt-el] tr').nth(1).locator('td').first()
      ).toContainText('Revenue');
    } finally {
      await close(harness);
    }
  });

  test('disables deletion at one row or column and promotes a new header row', async ({
    page
  }) => {
    const harness = await openDeck(page);
    try {
      await insertTable(page, harness.frame, '1', '1');
      const table = harness.frame.locator('table[data-ppt-el]');
      await page.getByTestId('canvas-preview').click({ position: { x: 4, y: 4 } });
      await selectCell(page, harness.frame, 0, 0);
      await expect(page.getByTestId('table-row-delete')).toBeDisabled();
      await expect(page.getByTestId('table-col-delete')).toBeDisabled();
      await expect(page.getByTestId('table-row-above')).toBeEnabled();
      await expect(page.getByTestId('table-header-toggle')).toBeEnabled();

      await page.getByTestId('table-row-above').click();
      await waitForSaved(page);
      await expect(table.locator('tr')).toHaveCount(2);
      await expect(table.locator('tr').first().locator('th')).toHaveCount(1);
      await expect(table.locator('tr').nth(1).locator('td')).toHaveCount(1);

      await selectCell(page, harness.frame, 0, 0);
      await page.getByTestId('table-col-right').click();
      await waitForSaved(page);
      await expect(table.locator('tr').first().locator('th')).toHaveCount(2);

      await selectCell(page, harness.frame, 0, 0);
      await page.getByTestId('table-row-delete').click();
      await waitForSaved(page);
      await expect(table.locator('tr')).toHaveCount(1);
      await expect(table.locator('tr').first().locator('td')).toHaveCount(2);
      expect(await deckHtml(harness)).not.toContain('contenteditable');
    } finally {
      await close(harness);
    }
  });
});
