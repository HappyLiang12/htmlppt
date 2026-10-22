import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

async function createRichTextFixture(
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
  const heading =
    '    <h1 data-ppt-el="title" style="position:absolute;left:100px;top:100px;width:800px;height:120px;margin:0;font-size:48px">Rich text heading</h1>\n';
  await writeFile(
    path,
    `${html.slice(0, closing)}${heading}${html.slice(closing)}`,
    'utf8'
  );
}

async function openDeck(page: Page): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'htmlppt-rich-text-e2e-'));
  const file = 'rich.html';
  let host: Harness['host'] | null = null;
  try {
    await createRichTextFixture(directory, file);
    host = await startCliHost(cliPath, directory, file);
    await page.goto(host.url);
    const frame = page.frameLocator(FRAME_SELECTOR);
    await expect(frame.locator('[data-ppt-el="title"]')).toBeVisible();
    await expect(page.getByTestId('save-status')).toHaveText('已同步');
    return { directory, file, host, frame };
  } catch (error) {
    if (host) await host.stop();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function startEditing(
  page: Page,
  frame: FrameLocator
): Promise<void> {
  await frame.locator('[data-ppt-el="title"]').dblclick();
  await expect(page.getByTestId('text-toolbar')).toBeVisible();
}

async function selectText(
  frame: FrameLocator,
  start: number,
  end: number
): Promise<void> {
  await frame.locator('[data-ppt-el="title"]').evaluate(
    (element, bounds) => {
      const text = element.firstChild;
      if (!text || text.nodeType !== 3) {
        throw new Error('The heading has no direct text node.');
      }
      const range = element.ownerDocument.createRange();
      range.setStart(text, bounds.start);
      range.setEnd(text, bounds.end);
      const selection = element.ownerDocument.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    },
    { start, end }
  );
}

async function selectAll(frame: FrameLocator): Promise<void> {
  await frame.locator('[data-ppt-el="title"]').evaluate((element) => {
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    const selection = element.ownerDocument.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

async function commitByBlur(page: Page, frame: FrameLocator): Promise<void> {
  await frame.locator('body').click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId('save-status')).toHaveText('已儲存', {
    timeout: 10_000
  });
}

async function deckHtml(harness: Harness): Promise<string> {
  return readFile(join(harness.directory, harness.file), 'utf8');
}

function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

test.describe('rich text @feature:rich-text', () => {
  test('applies bold and color to a partial selection and persists spans', async ({
    page
  }) => {
    const harness = await openDeck(page);
    try {
      await startEditing(page, harness.frame);
      await selectText(harness.frame, 5, 9);
      await page.getByTestId('text-bold').click();
      await page.getByTestId('text-color').click();
      await page.getByTestId('text-color-dc2626').click();
      await commitByBlur(page, harness.frame);

      const html = await deckHtml(harness);
      expect(html).not.toContain('contenteditable');
      expect(html).toMatch(
        /<span style="[^"]*font-weight:\s*bold[^"]*"><span style="[^"]*color:\s*rgb\(220,\s*38,\s*38\)[^"]*">text<\/span><\/span>/
      );
      expect(visibleText(html)).toContain('Rich text heading');

      await expect(harness.frame.locator('[data-ppt-el="title"]')).toHaveText(
        'Rich text heading'
      );
    } finally {
      await harness.host.stop();
      await rm(harness.directory, { recursive: true, force: true });
    }
  });

  test('clears formatting back to plain text', async ({ page }) => {
    const harness = await openDeck(page);
    try {
      await startEditing(page, harness.frame);
      await selectText(harness.frame, 5, 9);
      await page.getByTestId('text-bold').click();
      await page.getByTestId('text-italic').click();
      await commitByBlur(page, harness.frame);
      expect(await deckHtml(harness)).toContain('font-weight: bold');

      await startEditing(page, harness.frame);
      await selectAll(harness.frame);
      await page.getByTestId('text-clear').click();
      await commitByBlur(page, harness.frame);

      const html = await deckHtml(harness);
      expect(html).not.toContain('font-weight');
      expect(html).not.toContain('font-style');
      expect(visibleText(html)).toContain('Rich text heading');
    } finally {
      await harness.host.stop();
      await rm(harness.directory, { recursive: true, force: true });
    }
  });

  test('links a selection and rejects script URLs', async ({ page }) => {
    const harness = await openDeck(page);
    try {
      await startEditing(page, harness.frame);
      await selectText(harness.frame, 10, 17);
      page.once('dialog', (dialog) => dialog.accept('javascript:alert(1)'));
      await page.getByTestId('text-link').click();
      await expect(page.getByTestId('text-error')).toContainText(
        'Links must use http:, https:, mailto:, or a #fragment.'
      );
      expect(await deckHtml(harness)).not.toContain('javascript:');

      page.once('dialog', (dialog) =>
        dialog.accept('https://example.com/rich')
      );
      await page.getByTestId('text-link').click();
      await expect(page.getByTestId('text-error')).toHaveCount(0);
      await commitByBlur(page, harness.frame);

      const html = await deckHtml(harness);
      expect(html).toMatch(
        /<a href="https:\/\/example\.com\/rich">heading<\/a>/
      );
      expect(visibleText(html)).toContain('Rich text heading');
    } finally {
      await harness.host.stop();
      await rm(harness.directory, { recursive: true, force: true });
    }
  });
});
