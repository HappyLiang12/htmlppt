import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { execa } from 'execa';
import { startCliHost } from './helpers';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'packages/cli/dist/bin.js');
const FRAME_SELECTOR = 'main[data-testid="canvas-preview"] iframe';

interface ThemeHarness {
  directory: string;
  host: Awaited<ReturnType<typeof startCliHost>>;
}

async function openThemeDeck(page: Page): Promise<ThemeHarness> {
  const directory = await mkdtemp(join(tmpdir(), 'htmlppt-theme-'));
  let host: ThemeHarness['host'] | null = null;
  try {
    await execa('node', [cliPath, 'new', 'deck.html'], { cwd: directory });
    host = await startCliHost(cliPath, directory, 'deck.html');
    await page.goto(host.url);
    await expect(page.getByTestId('theme-select')).toBeVisible();
    return { directory, host };
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

/**
 * Measures the rendered text color of an element against the first ancestor
 * that actually paints a background. The toolbar is deliberately transparent
 * over the shell, so sampling the toolbar's own computed background would
 * measure `rgba(0, 0, 0, 0)` and pass for the wrong reason.
 */
function measureContrast(page: Page, testId: string): Promise<ContrastSample> {
  return page.getByTestId(testId).evaluate((node) => {
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

    let background = [255, 255, 255];
    let paintedBy: { tag: string; testId: string | null } | null = null;
    for (
      let element: Element | null = node;
      element;
      element = element.parentElement
    ) {
      const { rgb, alpha } = parse(getComputedStyle(element).backgroundColor);
      if (alpha > 0) {
        background = composite(rgb, alpha, background);
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

      for (const [label, sample] of [
        ['light save-status', light],
        ['light inactive theme control', lightControl],
        ['dark save-status', dark],
        ['dark inactive theme control', darkControl]
      ] as const) {
        expect(
          sample.ratio,
          `${label}: ${sample.foreground} on ${sample.background}`
        ).toBeGreaterThanOrEqual(4.5);
      }

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
});
