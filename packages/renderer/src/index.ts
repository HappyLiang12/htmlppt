import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page, type Request } from 'playwright-core';
import { findChromium } from './chromium.js';
import { isolateSlide, preparePrint, prepareSlides, type SlideCanvas } from './layout.js';
import { exactPdfPageSize } from './pdf.js';
import { createSandboxOrigin } from './sandbox.js';

export { findChromium } from './chromium.js';
export type { ChromiumLocation } from './chromium.js';

const DEADLINE_MS = 12000;

export class RendererUnavailableError extends Error {
  constructor() {
    super('Chromium is unavailable. Install Google Chrome, Microsoft Edge or Chromium, or set HTMLPPT_CHROMIUM to its executable path.');
    this.name = 'RendererUnavailableError';
  }
}

export class RenderError extends Error {
  constructor(message: string, readonly slide?: number, options?: ErrorOptions) {
    super(slide === undefined ? message : `Slide ${slide}: ${message}`, options);
    this.name = 'RenderError';
  }
}

export interface RenderOptions {
  html: string;
  width: number;
  height: number;
}

export interface PdfOptions extends RenderOptions {
  outPath: string;
}

export interface PngOptions extends RenderOptions {
  outDir: string;
  basename: string;
}

async function deadline<T>(task: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RenderError('Rendering timed out waiting for layout, stylesheets, fonts or image assets. Check HTTP asset URLs and network availability.')), DEADLINE_MS);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function writeAtomic(file: string, data: Uint8Array): Promise<void> {
  const staging = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(staging, 'wx');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(staging, file);
  } finally {
    await rm(staging, { force: true });
  }
}

function renderError(error: unknown, slide?: number): RenderError {
  if (error instanceof RenderError && (slide === undefined || error.slide !== undefined)) return error;
  return new RenderError(error instanceof Error ? error.message : String(error), slide, { cause: error });
}

async function withPage<T>(options: RenderOptions, format: 'pdf' | 'png', action: (page: Page, slides: SlideCanvas[], ready: () => Promise<void>) => Promise<T>): Promise<T> {
  if (![options.width, options.height].every(value => Number.isFinite(value) && value > 0)) {
    throw new RenderError('Canvas width and height must be finite positive numbers.');
  }
  const found = await findChromium();
  if (!found) throw new RendererUnavailableError();
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let origin: Awaited<ReturnType<typeof createSandboxOrigin>> | undefined;
  try {
    browser = await chromium.launch({ executablePath: found.executablePath, headless: true, chromiumSandbox: true, timeout: DEADLINE_MS });
    context = await browser.newContext({
      javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false,
      viewport: { width: Math.ceil(options.width), height: Math.ceil(options.height) },
      deviceScaleFactor: format === 'png' ? 2 : 1
    });
    const allowed = new Set<Request>();
    const failures: string[] = [];
    origin = await createSandboxOrigin();
    const bootstrapUrl = origin.url;
    let bootstrapped = false;
    await context.route('**/*', async route => {
      const request = route.request();
      if (!bootstrapped && request.url() === bootstrapUrl && request.isNavigationRequest() && request.frame() === page?.mainFrame()) {
        bootstrapped = true;
        await route.continue();
        return;
      }
      if (!/^https?:\/\//i.test(request.url()) || request.isNavigationRequest()
        || !['image', 'font', 'stylesheet'].includes(request.resourceType()) || request.frame() !== page?.mainFrame()) {
        await route.abort('blockedbyclient');
        return;
      }
      allowed.add(request);
      await route.continue();
    });
    await context.routeWebSocket('**/*', socket => socket.close());
    page = await context.newPage();
    page.setDefaultTimeout(DEADLINE_MS);
    page.on('requestfailed', request => {
      if (allowed.has(request)) failures.push(`${request.url()}: ${request.failure()?.errorText}`);
    });
    page.on('response', response => {
      if (allowed.has(response.request()) && response.status() >= 400) failures.push(`${response.url()}: HTTP ${response.status()}`);
    });
    await page.emulateMedia({ media: format === 'pdf' ? 'print' : 'screen', reducedMotion: 'reduce' });
    const ready = async () => {
      await page!.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(Array.from(document.images)
          .filter(image => /^https?:/i.test(image.currentSrc || image.src))
          .map(image => image.decode()));
      });
      await page!.waitForLoadState('networkidle');
      if (failures.length) throw new RenderError(`Could not load HTTP assets: ${failures.join('; ')}. Check asset URLs and network availability.`);
    };
    const slides = await deadline(async () => {
      await page!.goto(bootstrapUrl, { waitUntil: 'domcontentloaded' });
      await page!.setContent(options.html, { waitUntil: 'load' });
      if (failures.length) throw new RenderError(`Could not load HTTP assets: ${failures.join('; ')}. Check asset URLs and network availability.`);
      const canvases = await prepareSlides(page!, options);
      if (!canvases.length) throw new RenderError('No slide canvas was detected.');
      if (format === 'pdf') await preparePrint(page!, canvases);
      await ready();
      return canvases;
    });
    return await action(page, slides, ready);
  } catch (error) {
    throw renderError(error);
  } finally {
    await page?.close().catch(() => undefined);
    await context?.close().catch(() => undefined);
    try {
      await browser?.close();
    } finally {
      await origin?.close();
    }
  }
}

export async function renderPdf(options: PdfOptions): Promise<void> {
  return withPage(options, 'pdf', async (page, slides) => {
    const first = slides[0];
    const data = await deadline(() => page.pdf({
      width: `${first.width}px`, height: `${first.height}px`, preferCSSPageSize: true,
      printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 }, displayHeaderFooter: false
    }));
    await writeAtomic(options.outPath, await exactPdfPageSize(data, first.width, first.height, slides.length));
  });
}

export async function renderPngs(options: PngOptions): Promise<string[]> {
  const name = options.basename;
  const windowsReserved = process.platform === 'win32'
    && (/[<>:"|?*]|[. ]$/.test(name)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name));
  if (!name || name === '.' || name === '..' || /[/\\]/.test(name)
    || [...name].some(char => char.charCodeAt(0) < 32)
    || windowsReserved) {
    throw new RenderError('Invalid basename: use a filename, not a path or reserved filename.');
  }
  return withPage(options, 'png', async (page, slides, ready) => {
    const files: string[] = [];
    for (let index = 0; index < slides.length; index++) {
      try {
        const data = await deadline(async () => {
          await isolateSlide(page, slides, index);
          await ready();
          const clip = await page.evaluate(selector => {
            const rect = document.querySelector(selector)!.getBoundingClientRect();
            return { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height };
          }, slides[index].selector);
          return page.screenshot({ type: 'png', clip, animations: 'disabled', scale: 'device' });
        });
        const file = path.join(options.outDir, `${name}-s${index + 1}.png`);
        await writeAtomic(file, data);
        files.push(file);
      } catch (error) {
        throw renderError(error, index + 1);
      }
    }
    return files;
  });
}
