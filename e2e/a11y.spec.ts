import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { execa } from 'execa';
import { startCliHost } from './helpers';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'packages/cli/dist/bin.js');
const FRAME_SELECTOR = 'iframe[title="投影片預覽"]';
const PLAY_FRAME_SELECTOR = 'iframe[data-testid="play-frame"]';

interface Harness {
  directory: string;
  host: Awaited<ReturnType<typeof startCliHost>>;
  frame: FrameLocator;
}

async function createA11yFixture(
  directory: string,
  file: string
): Promise<void> {
  await execa('node', [cliPath, 'new', file, '--slides', '2'], {
    cwd: directory
  });
  const path = join(directory, file);
  const html = await readFile(path, 'utf8');
  const closing = html.indexOf('</section>');
  if (closing === -1) {
    throw new Error('Template slide closing tag was not found.');
  }
  const heading =
    '    <h1 data-ppt-el="a11y-title" style="position:absolute;left:120px;top:420px;margin:0;font-size:48px;z-index:5">Rich deck</h1>\n';
  await writeFile(
    path,
    `${html.slice(0, closing)}${heading}${html.slice(closing)}`,
    'utf8'
  );
}

async function openDeck(page: Page): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'htmlppt-a11y-e2e-'));
  const file = 'a11y.html';
  let host: Harness['host'] | null = null;
  try {
    await createA11yFixture(directory, file);
    host = await startCliHost(cliPath, directory, file);
    await page.goto(host.url);
    const frame = page.frameLocator(FRAME_SELECTOR);
    await expect(frame.locator('[data-ppt-el="a11y-title"]')).toBeVisible();
    await expect(page.getByTestId('save-status')).toHaveText('已同步');
    return { directory, host, frame };
  } catch (error) {
    if (host) await host.stop();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function closeDeck(harness: Harness): Promise<void> {
  await harness.host.stop();
  await rm(harness.directory, { recursive: true, force: true });
}

async function tabTo(page: Page, testId: string, limit = 25): Promise<void> {
  for (let index = 0; index < limit; index += 1) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate<string>(
      "document.activeElement?.getAttribute('data-testid') ?? ''"
    );
    if (focused === testId) return;
  }
  throw new Error(`Could not reach ${testId} with Tab.`);
}

function positiveTabindexCount(page: Page): Promise<number> {
  return page.locator('[tabindex]').evaluateAll(
    (nodes) =>
      nodes.filter((node) => Number(node.getAttribute('tabindex')) > 0).length
  );
}

function playFrame(page: Page): FrameLocator {
  return page.frameLocator(PLAY_FRAME_SELECTOR);
}

test.describe('accessibility @feature:accessibility', () => {
test('keyboard-only tabbing opens the insert menu and restores focus on Escape', async ({
  page
}) => {
  const harness = await openDeck(page);
  try {
    await tabTo(page, 'insert-shape');
    const trigger = page.getByTestId('insert-shape');
    await expect(trigger).toBeFocused();

    await page.keyboard.press('Enter');
    const menu = page.getByTestId('insert-menu-shape');
    await expect(menu).toBeVisible();

    await page.keyboard.press('Tab');
    await expect(page.getByTestId('insert-shape-rect')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();

    // Continue the keyboard-only flow into a dialog and back to its trigger.
    await tabTo(page, 'shortcuts-open');
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: '鍵盤快速鍵' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('shortcuts-open')).toBeFocused();
  } finally {
    await closeDeck(harness);
  }
});

test('shortcut help dialog traps focus, closes on Escape, and restores the trigger', async ({
  page
}) => {
  const harness = await openDeck(page);
  try {
    const opener = page.getByTestId('shortcuts-open');
    await tabTo(page, 'shortcuts-open');
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog', { name: '鍵盤快速鍵' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    const close = page.getByTestId('shortcuts-dialog-close');
    const done = page.getByTestId('shortcuts-dialog-done');
    await expect(close).toBeFocused();

    await done.focus();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();

    await page.keyboard.press('Shift+Tab');
    await expect(done).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();

    // The help shortcut opens the same dialog and stays keyboard operable.
    await page.keyboard.press('?');
    await expect(dialog).toBeVisible();
    await expect(close).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  } finally {
    await closeDeck(harness);
  }
});

test('dialogs stay operable after focus leaves a control', async ({ page }) => {
  const harness = await openDeck(page);
  try {
    const opener = page.getByTestId('shortcuts-open');
    await opener.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: '鍵盤快速鍵' });
    await expect(dialog).toBeVisible();

    // Simulate focus falling to the document (backdrop click or a heading).
    await page.evaluate(
      "document.activeElement instanceof HTMLElement && document.activeElement.blur()"
    );
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(
        "document.activeElement?.closest('[role=\"dialog\"]') !== null"
      )
    ).toBe(true);

    // F5 must not reload the editor while the dialog owns the screen.
    await page.keyboard.press('F5');
    await expect(dialog).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
  } finally {
    await closeDeck(harness);
  }
});

test('icon-only controls expose Traditional Chinese accessible names', async ({
  page
}) => {
  const harness = await openDeck(page);
  try {
    await expect(
      page.getByRole('button', { name: '第 1 頁：Untitled deck' })
    ).toBeVisible();

    await page.getByTestId('view-sorter').click();
    await expect(
      page.getByRole('button', { name: '複製第 1 頁' })
    ).toBeVisible();
    const firstOption = page.getByRole('option', { name: '第 1 頁：Untitled deck' });
    await expect(firstOption).toHaveAttribute('aria-selected', 'true');
    await expect(
      page.getByTestId('sorter-active-marker').first()
    ).toBeVisible();

    await page.getByTestId('view-normal').click();
    await harness.frame.locator('[data-ppt-el="a11y-title"]').click();
    await expect(page.getByTestId('text-toolbar')).toBeVisible();
    await expect(page.getByTestId('text-toolbar')).toHaveAttribute(
      'data-mode',
      'selection'
    );
    await expect(page.getByRole('button', { name: '粗體' })).toBeVisible();

    await harness.frame.locator('[data-ppt-el="a11y-title"]').dblclick();
    await expect(page.getByTestId('text-toolbar')).toHaveAttribute(
      'data-mode',
      'editing'
    );
    await expect(page.getByRole('button', { name: '粗體' })).toBeVisible();
    await expect(page.getByRole('button', { name: '文字顏色' })).toBeVisible();
    await expect(page.getByRole('button', { name: '粗體' })).toHaveAttribute(
      'aria-pressed',
      /^(true|false)$/
    );
  } finally {
    await closeDeck(harness);
  }
});

test('the polite live region announces selection and slide changes', async ({
  page
}) => {
  const harness = await openDeck(page);
  try {
    const status = page.getByTestId('a11y-status');
    await expect(status).toHaveAttribute('aria-live', 'polite');
    await expect(status).toHaveClass(/sr-only/);

    await harness.frame.locator('[data-ppt-el="a11y-title"]').click();
    await expect(status).toHaveText('已選取 h1：Rich deck');
    await expect(page.getByTestId('selection-marker')).toBeVisible();

    await page.getByTestId('thumbnail').nth(1).getByRole('button').click();
    await expect(status).toHaveText('第 2 頁，共 2 頁');
  } finally {
    await closeDeck(harness);
  }
});

test('editor chrome has no positive tabindex values', async ({ page }) => {
  const harness = await openDeck(page);
  try {
    expect(await positiveTabindexCount(page)).toBe(0);
    await page.getByTestId('shortcuts-open').click();
    await expect(page.getByTestId('shortcuts-dialog')).toBeVisible();
    expect(await positiveTabindexCount(page)).toBe(0);
    await page.keyboard.press('Escape');
  } finally {
    await closeDeck(harness);
  }
});

test('play mode responds to F5, arrows, Space, and Escape without a mouse', async ({
  page
}) => {
  const harness = await openDeck(page);
  try {
    await page.keyboard.press('F5');
    await expect(page.getByTestId('play-view')).toBeVisible();
    const frame = playFrame(page);
    await expect(frame.locator('[data-ppt-el="e1"]')).toHaveText(
      'Untitled deck'
    );

    await page.keyboard.press('ArrowRight');
    await expect(frame.locator('[data-ppt-el="e2"]')).toHaveText(
      'Untitled deck — 2'
    );
    await page.keyboard.press('ArrowLeft');
    await expect(frame.locator('[data-ppt-el="e1"]')).toHaveText(
      'Untitled deck'
    );
    await page.keyboard.press('Space');
    await expect(frame.locator('[data-ppt-el="e2"]')).toHaveText(
      'Untitled deck — 2'
    );
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('toolbar')).toBeVisible();

    // Shift+F5 starts from the current slide instead of the first one.
    await page.getByTestId('thumbnail').nth(1).getByRole('button').click();
    await page.keyboard.press('Shift+F5');
    await expect(page.getByTestId('play-view')).toBeVisible();
    await expect(frame.locator('[data-ppt-el="e2"]')).toHaveText(
      'Untitled deck — 2'
    );
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('toolbar')).toBeVisible();
  } finally {
    await closeDeck(harness);
  }
});

test('presenter popup can navigate the deck from the keyboard', async ({
  page
}) => {
  const harness = await openDeck(page);
  try {
    await page.keyboard.press('F5');
    await expect(page.getByTestId('play-view')).toBeVisible();

    const popupPromise = page.waitForEvent('popup');
    await page.keyboard.press('p');
    const presenter = await popupPromise;
    try {
      await expect(presenter.getByTestId('presenter-view')).toBeVisible();
      await expect(presenter.getByTestId('presenter-status')).toHaveText(
        '已連線'
      );
      await expect(
        presenter.getByTestId('presenter-announcement')
      ).toHaveText('第 1 頁，共 2 頁');

      await presenter.getByTestId('presenter-next').focus();
      await presenter.keyboard.press('Enter');
      await expect(
        playFrame(page).locator('[data-ppt-el="e2"]')
      ).toBeVisible();
      await expect(
        presenter.getByTestId('presenter-announcement')
      ).toHaveText('第 2 頁，共 2 頁');

      // The popup closes itself from the Escape keydown, which surfaces as a
      // closed-target error from Playwright's press helper.
      await presenter.keyboard.press('Escape').catch(() => undefined);
      await expect.poll(() => presenter.isClosed()).toBe(true);
    } finally {
      if (!presenter.isClosed()) await presenter.close();
    }

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('toolbar')).toBeVisible();
  } finally {
    await closeDeck(harness);
  }
});
});
