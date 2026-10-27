import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { execa } from 'execa';
import { startCliHost, startStaticEditor } from './helpers';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'packages/cli/dist/bin.js');
const editorDir = join(repoRoot, 'packages/editor/dist');
const FRAME_SELECTOR = 'main[data-testid="canvas-preview"] iframe';

const DARK_DECK = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Dark and light slides</title>
<style>
  html, body { margin: 0; padding: 0; }
  .slide { width: 960px; height: 540px; position: relative; overflow: hidden; }
  .slide.dark { background: #0b0b0f; color: #f4f4f5; }
  .slide.light { background: #ffffff; color: #18181b; }
</style>
</head>
<body>
<main data-ppt-deck>
  <section class="slide dark" data-slide-id="dark" data-width="960" data-height="540">
    <h1 data-ppt-el="dark-title" style="position:absolute;left:120px;top:160px;margin:0;font-size:48px">Dark slide</h1>
  </section>
  <section class="slide light" data-slide-id="light" data-width="960" data-height="540">
    <h1 data-ppt-el="light-title" style="position:absolute;left:120px;top:160px;margin:0;font-size:48px">Light slide</h1>
  </section>
</main>
</body>
</html>`;

const STATUS_DECK = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Status deck</title>
<style>
  html, body { margin: 0; padding: 0; }
  .slide { width: 960px; height: 540px; background: #ffffff; position: relative; }
  h1 { position: absolute; left: 120px; top: 120px; font-size: 48px; }
</style>
</head>
<body>
<main data-ppt-deck>
  <section class="slide" data-slide-id="s1" data-width="960" data-height="540">
    <h1 data-ppt-el="title" style="position:absolute;left:120px;top:120px;margin:0;font-size:48px">Status deck</h1>
    <div data-ppt-el="box" style="position:absolute;left:120px;top:240px;width:200px;height:100px;background:#d8c08a">Box</div>
  </section>
</main>
</body>
</html>`;

interface ThemeHarness {
  directory: string;
  file: string;
  deckPath: string;
  host: Awaited<ReturnType<typeof startCliHost>>;
}

async function openThemeDeck(
  page: Page,
  deck?: string
): Promise<ThemeHarness> {
  const directory = await mkdtemp(join(tmpdir(), 'htmlppt-theme-'));
  const file = 'deck.html';
  const deckPath = join(directory, file);
  let host: ThemeHarness['host'] | null = null;
  try {
    if (deck) {
      await writeFile(deckPath, deck, 'utf8');
    } else {
      await execa('node', [cliPath, 'new', file], { cwd: directory });
    }
    host = await startCliHost(cliPath, directory, file);
    await page.goto(host.url);
    await expect(page.getByTestId('theme-select')).toBeVisible();
    return { directory, file, deckPath, host };
  } catch (error) {
    if (host) await host.stop();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function closeThemeDeck(harness: ThemeHarness): Promise<void> {
  await harness.host.stop();
  await rm(harness.directory, { recursive: true, force: true });
}

interface PaletteSample {
  foreground: string;
  background: string;
  ratio: number;
}

interface ContrastSample {
  foreground: string;
  background: string;
  ratio: number;
  /** The nearest element that paints the measured background. */
  paintedBy: { tag: string; testId: string | null };
}

interface BorderSample {
  border: string;
  background: string;
  ratio: number;
  width: number;
  style: string;
}

type BorderSide = 'top' | 'right' | 'bottom' | 'left';

/**
 * WCAG 2.x contrast for the opaque `rgb(...)` strings reported by
 * `getComputedStyle`. Alpha is ignored because every value measured here is
 * already composited onto its background.
 */
function contrastRatio(foreground: string, background: string): number {
  const parse = (value: string): number[] => {
    const match = value.match(/rgba?\(\s*([^)]+)\)/);
    if (!match?.[1]) throw new Error(`Unsupported color: ${value}`);
    return match[1]
      .split(/[,\s/]+/)
      .filter(Boolean)
      .slice(0, 3)
      .map(Number);
  };
  const luminance = (rgb: number[]): number => {
    const channels = rgb.map((value) => {
      const channel = value / 255;
      return channel <= 0.03928
        ? channel / 12.92
        : Math.pow((channel + 0.055) / 1.055, 2.4);
    });
    return (
      0.2126 * (channels[0] ?? 0) +
      0.7152 * (channels[1] ?? 0) +
      0.0722 * (channels[2] ?? 0)
    );
  };
  const first = luminance(parse(foreground));
  const second = luminance(parse(background));
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/**
 * Measures the rendered text color of an element against its background
 * stack. Each translucent layer is composited bottom-up, so a control that
 * paints `bg-accent-soft` above the toolbar's own `bg-accent-soft` is measured
 * against both layers over the shell, not against white. The toolbar is
 * deliberately transparent over the shell, so sampling the toolbar's own
 * computed background would pass for the wrong reason.
 */
function measureContrast(page: Page, testId: string): Promise<ContrastSample> {
  return page.getByTestId(testId).first().evaluate((node) => {
    const parse = (value: string): { rgb: number[]; alpha: number } => {
      const match = value.match(/rgba?\(\s*([^)]+)\)/);
      if (!match || !match[1]) {
        throw new Error(`Unsupported computed color: ${value}`);
      }
      const parts = match[1]
        .split(/[,\s/]+/)
        .filter(Boolean)
        .map(Number);
      return {
        rgb: parts.slice(0, 3),
        alpha: parts.length > 3 ? (parts[3] ?? 1) : 1
      };
    };
    const composite = (
      top: readonly number[],
      alpha: number,
      bottom: readonly number[]
    ): number[] =>
      top.map(
        (channel, index) => channel * alpha + (bottom[index] ?? 0) * (1 - alpha)
      );
    const luminance = (rgb: readonly number[]): number => {
      const channels = rgb.map((value) => {
        const channel = value / 255;
        return channel <= 0.03928
          ? channel / 12.92
          : Math.pow((channel + 0.055) / 1.055, 2.4);
      });
      return (
        0.2126 * (channels[0] ?? 0) +
        0.7152 * (channels[1] ?? 0) +
        0.0722 * (channels[2] ?? 0)
      );
    };

    const layers: { rgb: number[]; alpha: number }[] = [];
    let paintedBy: { tag: string; testId: string | null } | null = null;
    for (
      let element: Element | null = node;
      element;
      element = element.parentElement
    ) {
      const { rgb, alpha } = parse(getComputedStyle(element).backgroundColor);
      if (alpha > 0) {
        layers.push({ rgb, alpha });
        if (!paintedBy) {
          paintedBy = {
            tag: element.tagName.toLowerCase(),
            testId: element.getAttribute('data-testid')
          };
        }
      }
      // A fully opaque ancestor hides every color below it.
      if (alpha === 1) break;
    }

    // Paint order is bottom-up: start at the page and composite each collected
    // layer on top of the one below it.
    let background = [255, 255, 255];
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      const layer = layers[index];
      if (!layer) continue;
      background = composite(layer.rgb, layer.alpha, background);
    }

    const foreground = parse(getComputedStyle(node).color);
    const paintedForeground = composite(
      foreground.rgb,
      foreground.alpha,
      background
    );
    const first = luminance(paintedForeground);
    const second = luminance(background);
    return {
      foreground: `rgb(${paintedForeground.map(Math.round).join(', ')})`,
      background: `rgb(${background.map(Math.round).join(', ')})`,
      ratio:
        (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05),
      paintedBy: paintedBy ?? { tag: 'body', testId: null }
    };
  });
}

/**
 * Measures one border edge of a control against the background it is painted
 * on. Borders are translucent tokens, so the border color is composited over
 * the same bottom-up background stack as the text measurement.
 */
function measureBorderContrast(
  page: Page,
  testId: string,
  side: BorderSide = 'top'
): Promise<BorderSample> {
  return page
    .getByTestId(testId)
    .first()
    .evaluate((node, edge) => {
      const parse = (value: string): { rgb: number[]; alpha: number } => {
        const match = value.match(/rgba?\(\s*([^)]+)\)/);
        if (!match || !match[1]) {
          throw new Error(`Unsupported computed color: ${value}`);
        }
        const parts = match[1]
          .split(/[,\s/]+/)
          .filter(Boolean)
          .map(Number);
        return {
          rgb: parts.slice(0, 3),
          alpha: parts.length > 3 ? (parts[3] ?? 1) : 1
        };
      };
      const composite = (
        top: readonly number[],
        alpha: number,
        bottom: readonly number[]
      ): number[] =>
        top.map(
          (channel, index) =>
            channel * alpha + (bottom[index] ?? 0) * (1 - alpha)
        );
      const luminance = (rgb: readonly number[]): number => {
        const channels = rgb.map((value) => {
          const channel = value / 255;
          return channel <= 0.03928
            ? channel / 12.92
            : Math.pow((channel + 0.055) / 1.055, 2.4);
        });
        return (
          0.2126 * (channels[0] ?? 0) +
          0.7152 * (channels[1] ?? 0) +
          0.0722 * (channels[2] ?? 0)
        );
      };

      const layers: { rgb: number[]; alpha: number }[] = [];
      for (
        let element: Element | null = node;
        element;
        element = element.parentElement
      ) {
        const { rgb, alpha } = parse(getComputedStyle(element).backgroundColor);
        if (alpha > 0) layers.push({ rgb, alpha });
        if (alpha === 1) break;
      }
      let background = [255, 255, 255];
      for (let index = layers.length - 1; index >= 0; index -= 1) {
        const layer = layers[index];
        if (!layer) continue;
        background = composite(layer.rgb, layer.alpha, background);
      }

      const style = getComputedStyle(node);
      const border = parse(style.getPropertyValue(`border-${edge}-color`));
      const paintedBorder = composite(border.rgb, border.alpha, background);
      const first = luminance(paintedBorder);
      const second = luminance(background);
      return {
        border: `rgb(${paintedBorder.map(Math.round).join(', ')})`,
        background: `rgb(${background.map(Math.round).join(', ')})`,
        ratio:
          (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05),
        width: Number.parseFloat(
          style.getPropertyValue(`border-${edge}-width`)
        ),
        style: style.getPropertyValue(`border-${edge}-style`)
      };
    }, side);
}

/**
 * Secondary palette probe: resolve the semantic ink/surface pair directly.
 * The real chrome contrast is measured through `measureContrast`.
 */
function samplePrimaryPalette(page: Page): Promise<PaletteSample> {
  return page.evaluate(() => {
    const parse = (value: string): number[] =>
      value.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number);
    const luminance = (rgb: number[]): number => {
      const channels = rgb.map((value) => {
        const channel = value / 255;
        return channel <= 0.03928
          ? channel / 12.92
          : Math.pow((channel + 0.055) / 1.055, 2.4);
      });
      return (
        0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
      );
    };
    const probe = document.createElement('div');
    probe.style.color = 'var(--editor-ink)';
    probe.style.backgroundColor = 'var(--editor-surface)';
    document.body.appendChild(probe);
    const style = getComputedStyle(probe);
    const foreground = style.color;
    const background = style.backgroundColor;
    probe.remove();
    const first = luminance(parse(foreground));
    const second = luminance(parse(background));
    return {
      foreground,
      background,
      ratio:
        (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
    };
  });
}

function resolvedTokenColor(page: Page, variable: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement('div');
    probe.style.color = `var(${name})`;
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, variable);
}

/** Seeds the standalone launcher's IndexedDB so it renders a draft row. */
async function seedStandaloneDraft(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('htmlppt-editor', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('drafts')) {
          db.createObjectStore('drafts', { keyPath: 'key' });
        }
      };
      request.onerror = () =>
        reject(request.error ?? new Error('IndexedDB open failed'));
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('drafts', 'readwrite');
        transaction.objectStore('drafts').put({
          key: 'recovery.html',
          filePath: 'recovery.html',
          html: '<!doctype html><html><body><main data-ppt-deck></main></body></html>',
          savedAt: Date.now() - 60_000
        });
        transaction.oncomplete = () => {
          db.close();
          resolve();
        };
        transaction.onerror = () => {
          db.close();
          reject(transaction.error ?? new Error('IndexedDB write failed'));
        };
      };
    });
  });
}

test.describe('theme', () => {
  test.use({ colorScheme: 'light' });

  test('defaults to system, overrides, and persists', async ({ page }) => {
    const harness = await openThemeDeck(page);
    try {
      const html = page.locator('html');
      const group = page.getByTestId('theme-select');

      await expect(html).toHaveAttribute('data-theme', 'light');
      await expect(html).toHaveAttribute('data-theme-mode', 'system');
      await expect(group).toHaveAttribute('role', 'group');
      await expect(group).toHaveAttribute('aria-label', '主題');
      await expect(page.getByTestId('theme-system')).toHaveAttribute(
        'aria-pressed',
        'true'
      );

      await page.getByTestId('theme-dark').click();
      await expect(html).toHaveAttribute('data-theme', 'dark');
      await expect(html).toHaveAttribute('data-theme-mode', 'dark');
      await expect(page.getByTestId('theme-dark')).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      await expect(page.getByTestId('theme-light')).toHaveAttribute(
        'aria-pressed',
        'false'
      );
      await expect(page.getByTestId('theme-system')).toHaveAttribute(
        'aria-pressed',
        'false'
      );

      await page.reload();
      await expect(page.getByTestId('theme-select')).toBeVisible();
      await expect(html).toHaveAttribute('data-theme', 'dark');
      await expect(html).toHaveAttribute('data-theme-mode', 'dark');
      await expect(page.getByTestId('theme-dark')).toHaveAttribute(
        'aria-pressed',
        'true'
      );

      await page.getByTestId('theme-system').click();
      await expect(html).toHaveAttribute('data-theme', 'light');
      await expect(html).toHaveAttribute('data-theme-mode', 'system');
      await expect(page.getByTestId('theme-system')).toHaveAttribute(
        'aria-pressed',
        'true'
      );
    } finally {
      await closeThemeDeck(harness);
    }
  });

  test('system mode follows OS color-scheme changes', async ({ page }) => {
    const harness = await openThemeDeck(page);
    try {
      const html = page.locator('html');
      await page.getByTestId('theme-system').click();
      await expect(html).toHaveAttribute('data-theme-mode', 'system');
      await expect(html).toHaveAttribute('data-theme', 'light');

      await page.emulateMedia({ colorScheme: 'dark' });
      await expect(html).toHaveAttribute('data-theme', 'dark');
      await expect(html).toHaveAttribute('data-theme-mode', 'system');

      await page.emulateMedia({ colorScheme: 'light' });
      await expect(html).toHaveAttribute('data-theme', 'light');
      await expect(html).toHaveAttribute('data-theme-mode', 'system');

      // An explicit mode ignores later OS changes until System is chosen again.
      // The OS is light here, so switching it to dark after choosing Light
      // proves the resolved theme did not follow the new preference.
      await page.getByTestId('theme-light').click();
      await expect(html).toHaveAttribute('data-theme', 'light');
      await page.emulateMedia({ colorScheme: 'dark' });
      await expect(html).toHaveAttribute('data-theme', 'light');
      await expect(html).toHaveAttribute('data-theme-mode', 'light');
    } finally {
      await closeThemeDeck(harness);
    }
  });

  test('labels the theme control in the active language', async ({ page }) => {
    const harness = await openThemeDeck(page);
    try {
      const light = page.getByTestId('theme-light');
      await expect(light).toHaveText('淺色');
      await expect(page.getByTestId('theme-dark')).toHaveText('深色');
      await expect(page.getByTestId('theme-system')).toHaveText('跟隨系統');
      await expect(page.getByTestId('theme-select')).toHaveAttribute(
        'aria-label',
        '主題'
      );

      await page.getByTestId('locale-select').selectOption('en');
      await expect(light).toHaveText('Light');
      await expect(page.getByTestId('theme-dark')).toHaveText('Dark');
      await expect(page.getByTestId('theme-system')).toHaveText('System');
      await expect(page.getByTestId('theme-select')).toHaveAttribute(
        'aria-label',
        'Theme'
      );
    } finally {
      await closeThemeDeck(harness);
    }
  });

  test('save-status text keeps 4.5:1 contrast in both palettes', async ({
    page
  }) => {
    const harness = await openThemeDeck(page);
    try {
      await page.getByTestId('theme-light').click();
      await expect(page.locator('html')).toHaveAttribute(
        'data-theme',
        'light'
      );
      const light = await measureContrast(page, 'save-status');
      const lightControl = await measureContrast(page, 'theme-dark');
      const lightActiveControl = await measureContrast(page, 'theme-light');
      const lightBorder = await measureBorderContrast(page, 'theme-dark');
      const lightPalette = await samplePrimaryPalette(page);
      const lightCanvas = await resolvedTokenColor(page, '--editor-canvas');
      const lightAccent = await resolvedTokenColor(page, '--editor-accent');
      await expect(page.getByTestId('theme-light')).toHaveCSS(
        'color',
        lightAccent
      );

      await page.getByTestId('theme-dark').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      const dark = await measureContrast(page, 'save-status');
      const darkControl = await measureContrast(page, 'theme-light');
      const darkActiveControl = await measureContrast(page, 'theme-dark');
      const darkBorder = await measureBorderContrast(page, 'theme-light');
      const darkPalette = await samplePrimaryPalette(page);
      const darkCanvas = await resolvedTokenColor(page, '--editor-canvas');
      const darkAccent = await resolvedTokenColor(page, '--editor-accent');
      await expect(page.getByTestId('theme-dark')).toHaveCSS(
        'color',
        darkAccent
      );

      // The toolbar is transparent: the shell must be the painted ancestor.
      expect(light.paintedBy.testId).not.toBe('toolbar');
      expect(dark.paintedBy.testId).not.toBe('toolbar');
      expect(
        light.background,
        'light save-status paints the shell canvas'
      ).toBe(lightCanvas);
      expect(dark.background, 'dark save-status paints the shell canvas').toBe(
        darkCanvas
      );

      // An active control paints its own soft accent over the shell, so the
      // measurement must include that layer instead of falling through to the
      // canvas. The old 3.5:1 light pair was invisible to a canvas-only probe.
      expect(lightActiveControl.paintedBy.testId).toBe('theme-light');
      expect(darkActiveControl.paintedBy.testId).toBe('theme-dark');
      expect(
        lightActiveControl.background,
        'light active control composites accent-soft over the canvas'
      ).not.toBe(lightCanvas);
      expect(
        darkActiveControl.background,
        'dark active control composites accent-soft over the canvas'
      ).not.toBe(darkCanvas);

      for (const [label, sample] of [
        ['light save-status', light],
        ['light inactive theme control', lightControl],
        ['light active theme control', lightActiveControl],
        ['dark save-status', dark],
        ['dark inactive theme control', darkControl],
        ['dark active theme control', darkActiveControl]
      ] as const) {
        expect(
          sample.ratio,
          `${label}: ${sample.foreground} on ${sample.background}`
        ).toBeGreaterThanOrEqual(4.5);
      }

      // Inactive theme controls carry border-line-strong; their border is a
      // non-text component and must stay at least 3:1 against the shell.
      for (const [label, sample] of [
        ['light inactive theme border', lightBorder],
        ['dark inactive theme border', darkBorder]
      ] as const) {
        expect(sample.width, `${label} is a real border`).toBeGreaterThan(0);
        expect(sample.style, `${label} is solid`).toBe('solid');
        expect(
          sample.ratio,
          `${label}: ${sample.border} on ${sample.background}`
        ).toBeGreaterThanOrEqual(3);
      }
      expect(lightBorder.background).toBe(lightCanvas);
      expect(darkBorder.background).toBe(darkCanvas);

      // Secondary palette assertion: the semantic tokens themselves still
      // meet the text/surface contract in both themes.
      expect(
        lightPalette.ratio,
        `light palette: ${lightPalette.foreground} on ${lightPalette.background}`
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        darkPalette.ratio,
        `dark palette: ${darkPalette.foreground} on ${darkPalette.background}`
      ).toBeGreaterThanOrEqual(4.5);
      expect(lightPalette.background).not.toBe(darkPalette.background);
    } finally {
      await closeThemeDeck(harness);
    }
  });

  test('sorter badge and current marker keep contrast in both palettes', async ({
    page
  }) => {
    const harness = await openThemeDeck(page);
    try {
      await page.getByTestId('theme-light').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await page.getByTestId('view-sorter').click();
      await expect(page.getByTestId('sorter-view')).toBeVisible();

      const overlaySolid = await resolvedTokenColor(
        page,
        '--editor-overlay-solid'
      );
      const onOverlay = await resolvedTokenColor(page, '--editor-on-overlay');
      const lightBadge = await measureContrast(page, 'sorter-slide-number');
      const lightMarker = await measureContrast(page, 'sorter-active-marker');

      await page.getByTestId('theme-dark').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      const darkBadge = await measureContrast(page, 'sorter-slide-number');
      const darkMarker = await measureContrast(page, 'sorter-active-marker');

      // The badge paints its own opaque overlay pair, independent of the
      // theme's translucent `bg-overlay`.
      expect(lightBadge.paintedBy.testId).toBe('sorter-slide-number');
      expect(darkBadge.paintedBy.testId).toBe('sorter-slide-number');
      expect(lightBadge.background).toBe(overlaySolid);
      expect(darkBadge.background).toBe(overlaySolid);
      expect(lightBadge.foreground).toBe(onOverlay);
      expect(darkBadge.foreground).toBe(onOverlay);
      expect(lightBadge.background).toBe(darkBadge.background);

      for (const [label, sample] of [
        ['light sorter slide number', lightBadge],
        ['light sorter current marker', lightMarker],
        ['dark sorter slide number', darkBadge],
        ['dark sorter current marker', darkMarker]
      ] as const) {
        expect(
          sample.ratio,
          `${label}: ${sample.foreground} on ${sample.background}`
        ).toBeGreaterThanOrEqual(4.5);
      }
    } finally {
      await closeThemeDeck(harness);
    }
  });

  test('active text toolbar control keeps contrast in both palettes', async ({
    page
  }) => {
    const harness = await openThemeDeck(page);
    try {
      const frame = page.frameLocator(FRAME_SELECTOR);
      const heading = frame.locator('h1').first();
      await expect(heading).toBeVisible();

      await page.getByTestId('theme-light').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await heading.dblclick();
      await expect(page.getByTestId('text-toolbar')).toBeVisible();
      await page.keyboard.press('Control+a');
      await page.getByTestId('text-bold').click();
      await expect(page.getByTestId('text-bold')).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      const lightActive = await measureContrast(page, 'text-bold');
      expect(lightActive.paintedBy.testId).toBe('text-bold');

      await page.keyboard.press('Escape');
      await expect(page.getByTestId('text-toolbar')).toHaveCount(0);

      // Bold is already applied, so the dark session activates a different
      // toggle instead of turning it back off.
      await page.getByTestId('theme-dark').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await heading.dblclick();
      await expect(page.getByTestId('text-toolbar')).toBeVisible();
      await page.keyboard.press('Control+a');
      await page.getByTestId('text-italic').click();
      await expect(page.getByTestId('text-italic')).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      const darkActive = await measureContrast(page, 'text-italic');
      expect(darkActive.paintedBy.testId).toBe('text-italic');

      for (const [label, sample] of [
        ['light active text control', lightActive],
        ['dark active text control', darkActive]
      ] as const) {
        expect(
          sample.ratio,
          `${label}: ${sample.foreground} on ${sample.background}`
        ).toBeGreaterThanOrEqual(4.5);
      }
    } finally {
      await closeThemeDeck(harness);
    }
  });

  test('slide content colors do not change with the theme', async ({
    page
  }) => {
    const harness = await openThemeDeck(page);
    try {
      const frame = page.frameLocator(FRAME_SELECTOR);
      const heading = frame.locator('h1').first();
      await expect(heading).toBeVisible();

      const colors = () =>
        heading.evaluate((node) => {
          const slide = node.closest('section.slide');
          if (!slide) throw new Error('Slide section not found');
          const headingStyle = getComputedStyle(node);
          const slideStyle = getComputedStyle(slide);
          return {
            headingText: headingStyle.color,
            headingBackground: headingStyle.backgroundColor,
            slideText: slideStyle.color,
            slideBackground: slideStyle.backgroundColor
          };
        });

      const before = await colors();
      await page.getByTestId('theme-dark').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      const after = await colors();

      expect(after).toEqual(before);
    } finally {
      await closeThemeDeck(harness);
    }
  });

  test('status banners and actions keep 3:1 borders in both palettes', async ({
    page
  }) => {
    const harness = await openThemeDeck(page, STATUS_DECK);
    try {
      const html = page.locator('html');
      await page.getByTestId('theme-light').click();
      await expect(html).toHaveAttribute('data-theme', 'light');

      await page.getByTestId('export-open').click();
      await page.getByTestId('export-html').click();
      await expect(page.getByTestId('export-result')).toBeVisible();

      const lightSuccessToken = await resolvedTokenColor(
        page,
        '--editor-success'
      );
      const lightSuccessBorder = await measureBorderContrast(
        page,
        'export-result',
        'bottom'
      );
      const lightSuccessAction = await measureBorderContrast(
        page,
        'export-dismiss'
      );
      const lightSuccessText = await measureContrast(page, 'export-result');
      expect(lightSuccessBorder.border).toBe(lightSuccessToken);

      await page.getByTestId('theme-dark').click();
      await expect(html).toHaveAttribute('data-theme', 'dark');
      const darkSuccessToken = await resolvedTokenColor(
        page,
        '--editor-success'
      );
      const darkSuccessBorder = await measureBorderContrast(
        page,
        'export-result',
        'bottom'
      );
      const darkSuccessAction = await measureBorderContrast(
        page,
        'export-dismiss'
      );
      const darkSuccessText = await measureContrast(page, 'export-result');
      expect(darkSuccessBorder.border).toBe(darkSuccessToken);

      // A forced export failure paints the danger banner without touching the
      // real host.
      await page.route('**/api/export', (route) =>
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'forced export failure' })
        })
      );
      await page.getByTestId('export-open').click();
      await page.getByTestId('export-html').click();
      await expect(page.getByTestId('editor-error')).toBeVisible();
      const darkDangerToken = await resolvedTokenColor(
        page,
        '--editor-danger'
      );
      const darkDangerBorder = await measureBorderContrast(
        page,
        'editor-error',
        'bottom'
      );
      const darkDangerText = await measureContrast(page, 'editor-error');
      expect(darkDangerBorder.border).toBe(darkDangerToken);
      await page.unroute('**/api/export');

      await page.getByTestId('theme-light').click();
      await expect(html).toHaveAttribute('data-theme', 'light');
      const lightDangerToken = await resolvedTokenColor(
        page,
        '--editor-danger'
      );
      const lightDangerBorder = await measureBorderContrast(
        page,
        'editor-error',
        'bottom'
      );
      const lightDangerText = await measureContrast(page, 'editor-error');
      expect(lightDangerBorder.border).toBe(lightDangerToken);

      for (const [label, sample] of [
        ['light success banner border', lightSuccessBorder],
        ['light success action border', lightSuccessAction],
        ['dark success banner border', darkSuccessBorder],
        ['dark success action border', darkSuccessAction],
        ['light danger banner border', lightDangerBorder],
        ['dark danger banner border', darkDangerBorder]
      ] as const) {
        expect(sample.width, `${label} is a real border`).toBeGreaterThan(0);
        expect(sample.style, `${label} is solid`).toBe('solid');
        expect(
          sample.ratio,
          `${label}: ${sample.border} on ${sample.background}`
        ).toBeGreaterThanOrEqual(3);
      }

      for (const [label, sample] of [
        ['light success text', lightSuccessText],
        ['dark success text', darkSuccessText],
        ['light danger text', lightDangerText],
        ['dark danger text', darkDangerText]
      ] as const) {
        expect(
          sample.ratio,
          `${label}: ${sample.foreground} on ${sample.background}`
        ).toBeGreaterThanOrEqual(4.5);
      }
    } finally {
      await closeThemeDeck(harness);
    }
  });

  test('conflict warning banner and actions keep 3:1 borders', async ({
    page
  }) => {
    const harness = await openThemeDeck(page, STATUS_DECK);
    try {
      // getComputedStyle returns the animated colour mid-transition, so a theme
      // switch right before a measurement samples a blended palette. Freeze
      // transitions here; the assertions still compare the final token values.
      await page.addStyleTag({
        content:
          '*, *::before, *::after { transition-duration: 0s !important; transition-delay: 0s !important; }'
      });
      // Block the autosave so the external write lands while the editor is
      // still dirty and must show the conflict warning.
      await page.route('**/api/deck', (route) =>
        route.request().method() === 'PUT' ? route.abort() : route.continue()
      );
      const frame = page.frameLocator(FRAME_SELECTOR);
      await frame.locator('[data-ppt-el="box"]').click();
      await page.keyboard.press('ArrowRight');
      await writeFile(
        harness.deckPath,
        STATUS_DECK.replace('Status deck', 'External status deck'),
        'utf8'
      );

      const banner = page.getByTestId('conflict-banner');
      await expect(banner).toBeVisible({ timeout: 5_000 });
      await expect(banner).toContainText('外部');

      await page.getByTestId('theme-light').click();
      await expect(page.locator('html')).toHaveAttribute(
        'data-theme',
        'light'
      );
      const lightWarningToken = await resolvedTokenColor(
        page,
        '--editor-warning'
      );
      const lightWarningBorder = await measureBorderContrast(
        page,
        'conflict-banner',
        'bottom'
      );
      const lightWarningAction = await measureBorderContrast(
        page,
        'conflict-reload'
      );
      const lightWarningText = await measureContrast(page, 'conflict-banner');
      expect(lightWarningBorder.border).toBe(lightWarningToken);

      await page.getByTestId('theme-dark').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      const darkWarningToken = await resolvedTokenColor(
        page,
        '--editor-warning'
      );
      const darkWarningBorder = await measureBorderContrast(
        page,
        'conflict-banner',
        'bottom'
      );
      const darkWarningAction = await measureBorderContrast(
        page,
        'conflict-reload'
      );
      const darkWarningText = await measureContrast(page, 'conflict-banner');
      expect(darkWarningBorder.border).toBe(darkWarningToken);

      for (const [label, sample] of [
        ['light warning banner border', lightWarningBorder],
        ['light warning action border', lightWarningAction],
        ['dark warning banner border', darkWarningBorder],
        ['dark warning action border', darkWarningAction]
      ] as const) {
        expect(sample.width, `${label} is a real border`).toBeGreaterThan(0);
        expect(sample.style, `${label} is solid`).toBe('solid');
        expect(
          sample.ratio,
          `${label}: ${sample.border} on ${sample.background}`
        ).toBeGreaterThanOrEqual(3);
      }

      for (const [label, sample] of [
        ['light warning text', lightWarningText],
        ['dark warning text', darkWarningText]
      ] as const) {
        expect(
          sample.ratio,
          `${label}: ${sample.foreground} on ${sample.background}`
        ).toBeGreaterThanOrEqual(4.5);
      }
    } finally {
      await page.unroute('**/api/deck');
      await closeThemeDeck(harness);
    }
  });

  test('standalone draft time and error banner keep contrast', async ({
    page
  }) => {
    const editor = await startStaticEditor(editorDir);
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-theme-draft-'));
    try {
      await page.goto(editor.url);
      await expect(page.getByTestId('standalone-drop')).toBeVisible();
      await seedStandaloneDraft(page);
      await page.reload();

      const draft = page.getByTestId('recovery-draft');
      await expect(draft).toHaveCount(1);
      const html = page.locator('html');
      await expect(html).toHaveAttribute('data-theme', 'light');
      const lightWarningToken = await resolvedTokenColor(
        page,
        '--editor-warning'
      );
      const lightDraftBorder = await measureBorderContrast(page, 'recovery-draft');
      const lightTime = await measureContrast(page, 'recovery-time');
      expect(lightDraftBorder.border).toBe(lightWarningToken);

      await writeFile(join(directory, 'notes.txt'), 'not html', 'utf8');
      await page
        .getByTestId('standalone-file')
        .setInputFiles(join(directory, 'notes.txt'));
      await expect(page.getByTestId('standalone-error')).toBeVisible();
      const lightErrorToken = await resolvedTokenColor(
        page,
        '--editor-danger'
      );
      const lightErrorBorder = await measureBorderContrast(
        page,
        'standalone-error'
      );
      const lightErrorText = await measureContrast(page, 'standalone-error');
      expect(lightErrorBorder.border).toBe(lightErrorToken);

      await page.evaluate(() => localStorage.setItem('htmlppt.theme', 'dark'));
      await page.reload();
      await expect(html).toHaveAttribute('data-theme', 'dark');
      await expect(page.getByTestId('recovery-draft')).toHaveCount(1);
      const darkWarningToken = await resolvedTokenColor(
        page,
        '--editor-warning'
      );
      const darkDraftBorder = await measureBorderContrast(page, 'recovery-draft');
      const darkTime = await measureContrast(page, 'recovery-time');
      expect(darkDraftBorder.border).toBe(darkWarningToken);

      await page
        .getByTestId('standalone-file')
        .setInputFiles(join(directory, 'notes.txt'));
      await expect(page.getByTestId('standalone-error')).toBeVisible();
      const darkErrorToken = await resolvedTokenColor(page, '--editor-danger');
      const darkErrorBorder = await measureBorderContrast(
        page,
        'standalone-error'
      );
      const darkErrorText = await measureContrast(page, 'standalone-error');
      expect(darkErrorBorder.border).toBe(darkErrorToken);

      for (const [label, sample] of [
        ['light draft border', lightDraftBorder],
        ['dark draft border', darkDraftBorder],
        ['light error border', lightErrorBorder],
        ['dark error border', darkErrorBorder]
      ] as const) {
        expect(sample.width, `${label} is a real border`).toBeGreaterThan(0);
        expect(sample.style, `${label} is solid`).toBe('solid');
        expect(
          sample.ratio,
          `${label}: ${sample.border} on ${sample.background}`
        ).toBeGreaterThanOrEqual(3);
      }

      for (const [label, sample] of [
        ['light draft time', lightTime],
        ['dark draft time', darkTime],
        ['light error text', lightErrorText],
        ['dark error text', darkErrorText]
      ] as const) {
        expect(
          sample.ratio,
          `${label}: ${sample.foreground} on ${sample.background}`
        ).toBeGreaterThanOrEqual(4.5);
      }
    } finally {
      await editor.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('selection stays visible on dark and light slide content', async ({
    page
  }) => {
    const harness = await openThemeDeck(page, DARK_DECK);
    try {
      const html = page.locator('html');
      const frame = page.frameLocator(FRAME_SELECTOR);
      await expect(frame.locator('[data-ppt-el="dark-title"]')).toBeVisible();
      await page.getByTestId('theme-light').click();
      await expect(html).toHaveAttribute('data-theme', 'light');
      await frame.locator('[data-ppt-el="dark-title"]').click();

      const outline = page.getByTestId('selection-outline');
      await expect(outline).toHaveAttribute('data-selected-id', 'dark-title');
      const selection = await resolvedTokenColor(page, '--editor-selection');
      const contrast = await resolvedTokenColor(
        page,
        '--editor-selection-contrast'
      );
      expect(selection, 'selection is invariant amber').toBe(
        'rgb(251, 191, 36)'
      );
      expect(contrast, 'selection halo is invariant dark').toBe(
        'rgb(24, 24, 27)'
      );

      const inspectSelection = async () => {
        const outlineStyle = await outline.evaluate((node) => {
          const style = getComputedStyle(node);
          return {
            border: style.borderTopColor,
            shadow: style.boxShadow,
            width: Number.parseFloat(style.borderTopWidth)
          };
        });
        const handle = await page.getByTestId('handle-nw').evaluate((node) => {
          const style = getComputedStyle(node);
          return {
            background: style.backgroundColor,
            border: style.borderTopColor
          };
        });
        const marker = await page
          .getByTestId('selection-marker')
          .evaluate((node) => {
            const style = getComputedStyle(node);
            return {
              background: style.backgroundColor,
              color: style.color
            };
          });
        return { outlineStyle, handle, marker };
      };

      const checkSelection = async (label: string, background: string) => {
        const snapshot = await inspectSelection();
        expect(snapshot.outlineStyle.border, `${label} outline`).toBe(
          selection
        );
        expect(snapshot.outlineStyle.width, `${label} outline width`).toBeGreaterThanOrEqual(2);
        expect(snapshot.outlineStyle.shadow, `${label} contrast halo`).toContain(
          contrast
        );
        expect(snapshot.handle.background, `${label} handle fill`).toBe(
          selection
        );
        expect(snapshot.handle.border, `${label} handle ring`).toBe(contrast);
        expect(snapshot.marker.background, `${label} marker fill`).toBe(
          selection
        );
        expect(snapshot.marker.color, `${label} marker text`).toBe(contrast);
        return {
          borderRatio: contrastRatio(selection, background),
          haloRatio: contrastRatio(contrast, background)
        };
      };

      const darkSlide = await frame
        .locator('section.slide')
        .nth(0)
        .evaluate((node) => getComputedStyle(node).backgroundColor);
      expect(darkSlide).toBe('rgb(11, 11, 15)');
      const lightThemeDarkSlide = await checkSelection(
        'light theme, dark slide',
        darkSlide
      );
      expect(
        lightThemeDarkSlide.borderRatio,
        `amber selection on ${darkSlide}`
      ).toBeGreaterThanOrEqual(3);

      await page.getByTestId('theme-dark').click();
      await expect(html).toHaveAttribute('data-theme', 'dark');
      expect(await resolvedTokenColor(page, '--editor-selection')).toBe(
        selection
      );
      const darkThemeDarkSlide = await checkSelection(
        'dark theme, dark slide',
        darkSlide
      );
      expect(
        darkThemeDarkSlide.borderRatio,
        `amber selection on ${darkSlide}`
      ).toBeGreaterThanOrEqual(3);

      await page.getByTestId('theme-light').click();
      await expect(html).toHaveAttribute('data-theme', 'light');
      await page.getByTestId('thumbnail').nth(1).click();
      await frame.locator('[data-ppt-el="light-title"]').click();
      await expect(outline).toHaveAttribute('data-selected-id', 'light-title');
      const lightSlide = await frame
        .locator('section.slide')
        .first()
        .evaluate((node) => getComputedStyle(node).backgroundColor);
      const lightSlideSelection = await checkSelection(
        'light theme, light slide',
        lightSlide
      );
      expect(
        lightSlideSelection.haloRatio,
        `dark halo on ${lightSlide}`
      ).toBeGreaterThanOrEqual(3);
    } finally {
      await closeThemeDeck(harness);
    }
  });

  test('play mode keeps the invariant focus ring and an unthemed presenter', async ({
    page
  }) => {
    const harness = await openThemeDeck(page);
    try {
      await page.getByTestId('theme-light').click();
      await expect(page.locator('html')).toHaveAttribute(
        'data-theme',
        'light'
      );
      await page.keyboard.press('F5');
      await expect(page.getByTestId('play-view')).toBeVisible();

      // PlayView focuses the stage on entry; the first Tab reaches its only
      // control, which must not inherit the light-theme chrome accent.
      await page.keyboard.press('Tab');
      const trigger = page.getByTestId('presenter-open');
      await expect(trigger).toBeFocused();
      const selection = await resolvedTokenColor(page, '--editor-selection');
      const accent = await resolvedTokenColor(page, '--editor-accent');
      // `transition-colors` also animates outline-color, so wait for the ring
      // to settle before measuring it.
      await expect
        .poll(() =>
          trigger.evaluate((node) => getComputedStyle(node).outlineColor)
        )
        .toBe(selection);
      const focus = await trigger.evaluate((node) => {
        const style = getComputedStyle(node);
        return {
          color: style.outlineColor,
          width: style.outlineWidth,
          line: style.outlineStyle,
          offset: style.outlineOffset,
          visible: node.matches(':focus-visible')
        };
      });
      expect(focus.visible, 'control matches :focus-visible').toBe(true);
      expect(focus.color, 'play focus uses invariant amber').toBe(selection);
      expect(focus.color, 'play focus does not use the light accent').not.toBe(
        accent
      );
      expect(focus.width).toBe('2px');
      expect(focus.line).toBe('solid');
      expect(focus.offset).toBe('2px');

      const popupPromise = page.waitForEvent('popup');
      await trigger.click();
      const presenter = await popupPromise;
      try {
        await expect(presenter.getByTestId('presenter-view')).toBeVisible();
        const snapshot = await presenter.locator('html').evaluate((node) => {
          const view = document.querySelector('[data-testid="presenter-view"]');
          return {
            theme: node.getAttribute('data-theme'),
            mode: node.getAttribute('data-theme-mode'),
            colorScheme: node.style.colorScheme,
            background: view ? getComputedStyle(view).backgroundColor : null
          };
        });
        expect(snapshot.theme, 'presenter has no editor theme').toBeNull();
        expect(snapshot.mode, 'presenter has no editor theme mode').toBeNull();
        expect(snapshot.colorScheme, 'presenter keeps the browser default').toBe(
          ''
        );
        expect(snapshot.background, 'presenter stays dark').toBe(
          'rgb(11, 13, 18)'
        );
      } finally {
        await presenter.close();
      }
    } finally {
      await closeThemeDeck(harness);
    }
  });
});

test.describe('theme with a dark OS', () => {
  test.use({ colorScheme: 'dark' });

  test('a first visit defaults to System and resolves dark', async ({
    page
  }) => {
    const harness = await openThemeDeck(page);
    try {
      const html = page.locator('html');
      await expect(html).toHaveAttribute('data-theme', 'dark');
      await expect(html).toHaveAttribute('data-theme-mode', 'system');
      await expect(page.getByTestId('theme-system')).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      expect(await resolvedTokenColor(page, '--editor-canvas')).toBe(
        'rgb(15, 17, 21)'
      );
    } finally {
      await closeThemeDeck(harness);
    }
  });
});
