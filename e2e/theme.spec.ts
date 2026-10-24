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

/**
 * Samples the primary text and surface colors. The editor chrome itself is
 * not on semantic tokens until Task 3, so resolve the palette variables
 * directly instead of measuring a still-hardcoded chrome element.
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
      await page.getByTestId('theme-dark').click();
      await page.emulateMedia({ colorScheme: 'light' });
      await expect(html).toHaveAttribute('data-theme', 'dark');
      await expect(html).toHaveAttribute('data-theme-mode', 'dark');
    } finally {
      await closeThemeDeck(harness);
    }
  });

  test('primary text keeps 4.5:1 contrast in both palettes', async ({
    page
  }) => {
    const harness = await openThemeDeck(page);
    try {
      await page.getByTestId('theme-light').click();
      await expect(page.locator('html')).toHaveAttribute(
        'data-theme',
        'light'
      );
      const light = await samplePrimaryPalette(page);
      const lightAccent = await resolvedTokenColor(page, '--editor-accent');
      await expect(page.getByTestId('theme-light')).toHaveCSS(
        'color',
        lightAccent
      );

      await page.getByTestId('theme-dark').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      const dark = await samplePrimaryPalette(page);
      const darkAccent = await resolvedTokenColor(page, '--editor-accent');
      await expect(page.getByTestId('theme-dark')).toHaveCSS(
        'color',
        darkAccent
      );

      expect(
        light.ratio,
        `light palette: ${light.foreground} on ${light.background}`
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        dark.ratio,
        `dark palette: ${dark.foreground} on ${dark.background}`
      ).toBeGreaterThanOrEqual(4.5);
      expect(light.background).not.toBe(dark.background);
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
