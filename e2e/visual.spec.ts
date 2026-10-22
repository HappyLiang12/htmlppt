import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { execa } from 'execa';
import { PDFDocument } from 'pdf-lib';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { startCliHost } from './helpers';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'packages/cli/dist/bin.js');
const fixturesDir = join(repoRoot, 'test-utils', 'fixtures');
const visualRoot = join(repoRoot, 'test-results', 'visual');
const FRAME_SELECTOR = 'iframe[title="投影片預覽"]';

/** A pixel counts as different when PIXEL_THRESHOLD says so. */
const PIXEL_THRESHOLD = 0.1;
/** The task contract is strictly less than 0.1% differing pixels. */
const MAX_MISMATCH_RATIO = 0.001;

const FIXTURES = [
  { id: 'basic', source: 'basic.deck.html', slides: 2 },
  { id: 'rich', source: 'rich.deck.html', slides: 2 },
  { id: 'animated', source: 'animated.deck.html', slides: 2 },
  { id: 'mixed', source: 'mixed.deck.html', slides: 2 }
] as const;

// The editor round-trip uses solid geometry rather than text so Chromium's
// subpixel text rasterization inside the transformed editor iframe cannot
// masquerade as an export fidelity difference. The scripted edit is a one
// pixel keyboard nudge, which is a supported M3 editor operation.
const EDITOR_DECK_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Editor round-trip</title>
<style>
  .slide { width: 1600px; height: 900px; position: relative; overflow: hidden; background: #fff; }
  .box { position: absolute; width: 240px; height: 120px; }
</style>
</head>
<body>
<main data-ppt-deck>
<section class="slide" data-slide-id="s1" data-width="1600" data-height="900">
  <div class="box" data-ppt-el="box1" style="left:120px;top:160px;background:#d8c08a"></div>
</section>
<section class="slide" data-slide-id="s2" data-width="1600" data-height="900">
  <div class="box" data-ppt-el="box2" style="left:400px;top:300px;background:#3b82f6"></div>
</section>
</main>
</body>
</html>
`;

interface RenderedImage {
  bytes: Buffer;
  png: PNG;
}

function safeName(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
}

async function runCli(
  cwd: string,
  args: readonly string[]
): Promise<{ stdout: string }> {
  const result = await execa('node', [cliPath, ...args], { cwd });
  return { stdout: result.stdout };
}

async function exportHtml(
  cwd: string,
  source: string,
  destination: string
): Promise<void> {
  await runCli(cwd, ['export', source, '--format', 'html', '--out', destination]);
}

async function exportPngs(
  cwd: string,
  source: string,
  outDir: string
): Promise<string[]> {
  const { stdout } = await runCli(cwd, [
    'export',
    source,
    '--format',
    'png',
    '--out',
    outDir
  ]);
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('Exported '))
    .map((line) => line.slice('Exported '.length));
}

async function readImage(file: string): Promise<RenderedImage> {
  const bytes = await readFile(file);
  return { bytes, png: PNG.sync.read(bytes) };
}

function pixelAt(image: PNG, x: number, y: number): number[] {
  const start = (y * image.width + x) * 4;
  return [...image.data.subarray(start, start + 4)];
}

function expectPixel(
  image: PNG,
  x: number,
  y: number,
  rgb: readonly [number, number, number],
  label: string
): void {
  expect(pixelAt(image, x, y), label).toEqual([...rgb, 255]);
}

async function writeVisualFailure(
  label: string,
  expected: RenderedImage,
  actual: RenderedImage,
  diff: Buffer | null,
  details: Record<string, unknown>
): Promise<void> {
  const directory = join(visualRoot, safeName(label));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'expected.png'), expected.bytes);
  await writeFile(join(directory, 'actual.png'), actual.bytes);
  if (diff) {
    await writeFile(join(directory, 'diff.png'), diff);
  }
  await writeFile(
    join(directory, 'result.json'),
    `${JSON.stringify(details, null, 2)}\n`,
    'utf8'
  );
}

async function expectVisuallyEqual(
  expectedPath: string,
  actualPath: string,
  label: string
): Promise<void> {
  const [expected, actual] = await Promise.all([
    readImage(expectedPath),
    readImage(actualPath)
  ]);
  const directory = join(visualRoot, safeName(label));

  if (
    expected.png.width !== actual.png.width ||
    expected.png.height !== actual.png.height
  ) {
    await writeVisualFailure(
      label,
      expected,
      actual,
      null,
      {
        label,
        expectedPath,
        actualPath,
        expected: { width: expected.png.width, height: expected.png.height },
        actual: { width: actual.png.width, height: actual.png.height },
        error: 'image dimensions differ'
      }
    );
    expect(
      { width: actual.png.width, height: actual.png.height },
      `${label}: rendered dimensions differ`
    ).toEqual({ width: expected.png.width, height: expected.png.height });
    return;
  }

  const width = expected.png.width;
  const height = expected.png.height;
  const total = width * height;
  const diff = new PNG({ width, height });
  const changed = pixelmatch(
    expected.png.data,
    actual.png.data,
    diff.data,
    width,
    height,
    { threshold: PIXEL_THRESHOLD, includeAA: true }
  );
  const ratio = changed / total;

  if (ratio >= MAX_MISMATCH_RATIO) {
    await writeVisualFailure(
      label,
      expected,
      actual,
      PNG.sync.write(diff),
      {
        label,
        expectedPath,
        actualPath,
        width,
        height,
        changed,
        total,
        ratio,
        maxRatio: MAX_MISMATCH_RATIO,
        pixelThreshold: PIXEL_THRESHOLD
      }
    );
    expect(
      ratio,
      `${label}: ${changed} of ${total} pixels differ (${(ratio * 100).toFixed(4)}%)`
    ).toBeLessThan(MAX_MISMATCH_RATIO);
    return;
  }

  // Do not leave stale failure evidence behind after a passing rerun.
  await rm(directory, { recursive: true, force: true });
}

async function waitForEditorPaint(page: Page): Promise<void> {
  await page.waitForFunction(
    `(() => {
      const iframe = document.querySelector(${JSON.stringify(FRAME_SELECTOR)});
      const doc = iframe && iframe.contentDocument;
      if (!doc || !doc.defaultView) return false;
      return doc.fonts.status === 'loaded' && Array.from(doc.images).every((image) => image.complete);
    })()`,
    undefined,
    { timeout: 15_000 }
  );
  await page.evaluate(
    `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`
  );
}

/**
 * Captures the editor canvas at the authored 1600x900 size and 2x device
 * scale. The iframe is positioned at a whole CSS pixel by the test viewport so
 * the crop is pixel aligned; a fractional offset changes Chromium's text and
 * edge rasterization and would make the comparison meaningless.
 */
async function captureEditorCanvas(
  page: Page,
  destination: string
): Promise<void> {
  const deviceScaleFactor = 2;
  const box = await page.locator(FRAME_SELECTOR).boundingBox();
  if (!box) throw new Error('Editor canvas has no bounding box.');
  expect(box.width).toBe(1600);
  expect(box.height).toBe(900);
  const pageImage = PNG.sync.read(await page.screenshot({ animations: 'disabled' }));
  const x = Math.round(box.x * deviceScaleFactor);
  const y = Math.round(box.y * deviceScaleFactor);
  const width = Math.round(box.width * deviceScaleFactor);
  const height = Math.round(box.height * deviceScaleFactor);
  expect([
    x - box.x * deviceScaleFactor,
    y - box.y * deviceScaleFactor
  ]).toEqual([0, 0]);
  const canvas = new PNG({ width, height });
  PNG.bitblt(pageImage, canvas, x, y, width, height, 0, 0);
  await writeFile(destination, PNG.sync.write(canvas));
}

async function startAssetServer(): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const css = `html, body { margin: 0; padding: 0; }
.slide { background: rgb(15, 23, 42) !important; }
.slide img { position: absolute; left: 120px; top: 120px; width: 480px; height: 270px; }
`;
  const hero = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"><rect width="480" height="270" fill="#1f6feb"/><circle cx="240" cy="135" r="64" fill="#f0b429"/></svg>`;
  const chart = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"><rect width="480" height="270" fill="#2f855a"/><rect x="64" y="150" width="80" height="80" fill="#ffffff"/></svg>`;
  const server = createServer((request, response) => {
    if (request.url === '/style.css') {
      response.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
      response.end(css);
      return;
    }
    if (request.url === '/hero.svg') {
      response.writeHead(200, { 'content-type': 'image/svg+xml' });
      response.end(hero);
      return;
    }
    if (request.url === '/chart.svg') {
      response.writeHead(200, { 'content-type': 'image/svg+xml' });
      response.end(chart);
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

test.describe('source and export render identically', () => {
  for (const fixture of FIXTURES) {
    test(
      `round-trips ${fixture.id} through HTML export`,
      { tag: '@feature:export-pdf-png' },
      async () => {
        test.setTimeout(90_000);
        const directory = await mkdtemp(
          join(tmpdir(), `htmlppt-visual-${fixture.id}-`)
        );
        try {
          const sourceName = `${fixture.id}.html`;
          await copyFile(
            join(fixturesDir, fixture.source),
            join(directory, sourceName)
          );
          await exportHtml(
            directory,
            sourceName,
            `${fixture.id}.export.html`
          );

          const sourceFiles = await exportPngs(
            directory,
            sourceName,
            'source-png'
          );
          const exportedFiles = await exportPngs(
            directory,
            `${fixture.id}.export.html`,
            'export-png'
          );
          expect(sourceFiles, `${fixture.id}: source slide count`).toHaveLength(
            fixture.slides
          );
          expect(
            exportedFiles,
            `${fixture.id}: exported slide count`
          ).toHaveLength(fixture.slides);

          if (fixture.id === 'mixed') {
            const sourceSizes = await Promise.all(
              sourceFiles.map(async (file) => {
                const image = (await readImage(file)).png;
                return [image.width, image.height];
              })
            );
            // 1600x900 and 1280x720 at the renderer's 2x device scale.
            expect(sourceSizes).toEqual([
              [3200, 1800],
              [2560, 1440]
            ]);
          }

          for (let index = 0; index < fixture.slides; index += 1) {
            await expectVisuallyEqual(
              sourceFiles[index],
              exportedFiles[index],
              `roundtrip-${fixture.id}-s${index + 1}`
            );
          }
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    );
  }
});

test(
  'round-trips the external fixture against loopback HTTP assets',
  { tag: '@feature:export-pdf-png' },
  async () => {
    test.setTimeout(120_000);
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-visual-external-'));
    const assets = await startAssetServer();
    try {
      const html = (
        await readFile(join(fixturesDir, 'external.deck.html'), 'utf8')
      )
        .replace(
          'https://fonts.googleapis.com/css2?family=Inter',
          `${assets.url}/style.css`
        )
        .replaceAll('https://example.com/hero.png', `${assets.url}/hero.svg`)
        .replaceAll('https://example.com/chart.png', `${assets.url}/chart.svg`);
      expect(html).not.toContain('example.com');
      expect(html).not.toContain('fonts.googleapis.com');
      await writeFile(join(directory, 'external.html'), html, 'utf8');

      await exportHtml(directory, 'external.html', 'external.export.html');
      const sourceFiles = await exportPngs(
        directory,
        'external.html',
        'source-png'
      );
      const exportedFiles = await exportPngs(
        directory,
        'external.export.html',
        'export-png'
      );
      expect(sourceFiles).toHaveLength(2);
      expect(exportedFiles).toHaveLength(2);

      const sourceHero = (await readImage(sourceFiles[0])).png;
      const sourceChart = (await readImage(sourceFiles[1])).png;
      const exportedHero = (await readImage(exportedFiles[0])).png;
      const exportedChart = (await readImage(exportedFiles[1])).png;

      // The served stylesheet must paint the slide background and move the
      // image away from the origin; both prove the external requests ran.
      for (const [image, label] of [
        [sourceHero, 'source hero'],
        [sourceChart, 'source chart'],
        [exportedHero, 'exported hero'],
        [exportedChart, 'exported chart']
      ] as const) {
        expectPixel(image, 20, 20, [15, 23, 42], `${label}: stylesheet`);
      }
      expectPixel(sourceHero, 280, 280, [31, 111, 235], 'source hero: image');
      expectPixel(
        exportedHero,
        280,
        280,
        [31, 111, 235],
        'exported hero: image'
      );
      expectPixel(
        sourceChart,
        280,
        280,
        [47, 133, 90],
        'source chart: image'
      );
      expectPixel(
        exportedChart,
        280,
        280,
        [47, 133, 90],
        'exported chart: image'
      );

      await expectVisuallyEqual(
        sourceFiles[0],
        exportedFiles[0],
        'roundtrip-external-s1'
      );
      await expectVisuallyEqual(
        sourceFiles[1],
        exportedFiles[1],
        'roundtrip-external-s2'
      );
    } finally {
      await assets.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  'mixed-size deck exports PDF pages at the first slide size and warns',
  { tag: '@feature:export-pdf-png' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-visual-mixed-pdf-'));
    try {
      await copyFile(
        join(fixturesDir, 'mixed.deck.html'),
        join(directory, 'mixed.html')
      );
      await runCli(directory, [
        'export',
        'mixed.html',
        '--format',
        'pdf',
        '--out',
        'mixed.pdf'
      ]);

      const pdf = await PDFDocument.load(
        await readFile(join(directory, 'mixed.pdf'))
      );
      expect(pdf.getPageCount()).toBe(2);
      for (const page of pdf.getPages()) {
        expect(page.getWidth()).toBeCloseTo((1600 * 72) / 96, 2);
        expect(page.getHeight()).toBeCloseTo((900 * 72) / 96, 2);
      }

      const { stdout } = await runCli(directory, [
        'validate',
        'mixed.html',
        '--json'
      ]);
      const result = JSON.parse(stdout) as {
        valid: boolean;
        warnings: { code: string }[];
      };
      expect(result.valid).toBe(true);
      expect(result.warnings.map((warning) => warning.code)).toContain(
        'mixed-canvas-sizes'
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test.describe('editor edit round-trip', () => {
  // A whole-pixel iframe origin keeps Chromium's rasterization aligned with
  // the standalone renderer at deviceScaleFactor 2.
  test.use({ viewport: { width: 2400, height: 1201 }, deviceScaleFactor: 2 });

  test(
    'edits an export in the editor and re-exports it at editor resolution',
    { tag: '@feature:export-pdf-png' },
    async ({ page, request }) => {
      test.setTimeout(180_000);
      const directory = await mkdtemp(
        join(tmpdir(), 'htmlppt-visual-editor-')
      );
      let host: Awaited<ReturnType<typeof startCliHost>> | undefined;
      try {
        await writeFile(
          join(directory, 'source.html'),
          EDITOR_DECK_HTML,
          'utf8'
        );
        await exportHtml(directory, 'source.html', 'deck.html');
        const originalSlides = await exportPngs(
          directory,
          'source.html',
          'original-png'
        );
        expect(originalSlides).toHaveLength(2);

        host = await startCliHost(cliPath, directory, 'deck.html');
        await page.goto(host.url);
        const frame = page.frameLocator(FRAME_SELECTOR);
        await expect(page.getByTestId('save-status')).toHaveText('已同步');
        await expect(frame.locator('[data-ppt-el="box1"]')).toBeVisible();

        const saved = page.waitForResponse(
          (response) =>
            response.request().method() === 'PUT' &&
            new URL(response.url()).pathname === '/api/deck'
        );
        await frame.locator('[data-ppt-el="box1"]').click();
        await page.keyboard.press('ArrowRight');
        expect((await saved).ok()).toBeTruthy();
        await expect(page.getByTestId('save-status')).toHaveText('已儲存');
        await expect(frame.locator('[data-ppt-el="box1"]')).toHaveCSS(
          'left',
          '121px'
        );

        // Clear the selection overlay before capturing the canvas.
        await page
          .getByTestId('canvas-preview')
          .click({ position: { x: 10, y: 10 } });
        await expect(page.getByTestId('selection-outline')).toHaveCount(0);
        await waitForEditorPaint(page);

        const editorScreenshot = join(directory, 'editor-s1.png');
        await captureEditorCanvas(page, editorScreenshot);
        const editorImage = (await readImage(editorScreenshot)).png;
        expect([editorImage.width, editorImage.height]).toEqual([3200, 1800]);

        const token = new URL(host.url).searchParams.get('token');
        if (!token) throw new Error('Host URL has no session token.');
        const exported = await request.post(
          `${new URL(host.url).origin}/api/export`,
          {
            headers: { authorization: `Bearer ${token}` },
            data: { format: 'png' }
          }
        );
        expect(exported.status()).toBe(200);
        const files = ((await exported.json()) as { files: string[] }).files;
        expect(files).toHaveLength(2);

        await expectVisuallyEqual(
          editorScreenshot,
          files[0],
          'editor-roundtrip-edited-s1'
        );
        await expectVisuallyEqual(
          originalSlides[1],
          files[1],
          'editor-roundtrip-unedited-s2'
        );

        const savedHtml = await readFile(join(directory, 'deck.html'), 'utf8');
        expect(savedHtml).toContain('left: 121px');
        expect(savedHtml).not.toContain('contenteditable');
      } finally {
        await host?.stop();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
});
