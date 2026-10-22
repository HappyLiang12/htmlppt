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
  const directory = await mkdtemp(join(tmpdir(), 'htmlppt-chart-e2e-'));
  const file = 'chart.html';
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

async function insertChart(page: Page, frame: FrameLocator): Promise<void> {
  await page.getByTestId('insert-chart').click();
  await waitForSaved(page);
  await expect(frame.locator('figure[data-ppt-chart]')).toBeVisible();
  await expect(frame.locator('figure[data-ppt-chart] svg')).toBeVisible();
}

test.describe('chart editing @feature:charts', () => {
  test('inserts a chart, rejects invalid JSON, applies new data, and reloads', async ({
    page
  }) => {
    const harness = await openDeck(page);
    try {
      await insertChart(page, harness.frame);
      await expect(page.getByTestId('chart-object')).toBeVisible();
      await expect(page.getByTestId('chart-summary')).toHaveText('bar · Chart');

      await page.getByTestId('chart-edit').click();
      const json = page.getByTestId('chart-json');
      await expect(json).toHaveValue(/"type": "bar"/);

      await json.fill('{ not json');
      await page.getByTestId('chart-apply').click();
      await expect(page.getByTestId('chart-error')).toContainText(
        'not valid JSON'
      );
      await expect(page.getByTestId('chart-dialog')).toBeVisible();

      const pie = {
        type: 'pie',
        title: 'Share',
        labels: ['A', 'B', 'C'],
        series: [{ name: 'share', values: [50, 30, 20] }],
        colors: ['#112233', '#445566', '#778899'],
        legend: true,
        valueLabels: true
      };
      await json.fill(JSON.stringify(pie, null, 2));
      await page.getByTestId('chart-apply').click();
      await expect(page.getByTestId('chart-dialog')).toHaveCount(0);

      await expect(page.getByTestId('chart-summary')).toHaveText('pie · Share');
      await expect(harness.frame.locator('figure[data-ppt-chart] path')).toHaveCount(3);
      await expect(harness.frame.locator('figure[data-ppt-chart]')).toContainText(
        '50%'
      );
      await expect
        .poll(async () => /data-ppt-chart="[^"]*pie/.test(await deckHtml(harness)))
        .toBe(true);

      const html = await deckHtml(harness);
      expect(html).toContain('<title>Share</title>');

      await page.reload();
      const reloaded = page.frameLocator(FRAME_SELECTOR);
      await expect(reloaded.locator('figure[data-ppt-chart] path')).toHaveCount(3);
      await expect(reloaded.locator('figure[data-ppt-chart]')).toContainText(
        'Share'
      );
    } finally {
      await close(harness);
    }
  });

  test('re-renders the svg when resized from the inspector and the canvas', async ({
    page
  }) => {
    const harness = await openDeck(page);
    try {
      await insertChart(page, harness.frame);

      const width = page.getByTestId('field-width');
      await width.fill('1000');
      await width.press('Enter');
      const height = page.getByTestId('field-height');
      await height.fill('500');
      await height.press('Enter');

      await expect(harness.frame.locator('figure[data-ppt-chart] svg')).toHaveAttribute(
        'viewBox',
        '0 0 1000 500'
      );
      await expect
        .poll(async () => (await deckHtml(harness)).includes('viewBox="0 0 1000 500"'))
        .toBe(true);
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      await harness.frame.locator('figure[data-ppt-chart]').click();
      const east = page.getByTestId('handle-e');
      await expect(east).toBeVisible();
      const box = await east.boundingBox();
      if (!box) throw new Error('Chart east handle has no bounding box.');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2, {
        steps: 6
      });
      await page.mouse.up();
      await expect
        .poll(async () => {
          const viewBox = await harness.frame
            .locator('figure[data-ppt-chart] svg')
            .getAttribute('viewBox');
          return viewBox;
        })
        .not.toBe('0 0 1000 500');
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      const sizes = await harness.frame
        .locator('figure[data-ppt-chart]')
        .evaluate((element) => {
          const html = element as unknown as { style: { width: string; height: string } };
          return {
            width: Number.parseFloat(html.style.width),
            height: Number.parseFloat(html.style.height),
            viewBox: element.querySelector('svg')?.getAttribute('viewBox') ?? ''
          };
        });
      expect(sizes.width).toBeLessThan(1000);
      expect(sizes.viewBox).toBe(
        `0 0 ${Math.round(sizes.width)} ${Math.round(sizes.height)}`
      );
      expect((await deckHtml(harness)).match(/viewBox="0 0 \d+ \d+"/g)?.length).toBe(1);
    } finally {
      await close(harness);
    }
  });
});
