import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expect,
  test,
  type APIResponse,
  type FrameLocator,
  type Locator,
  type Page,
  type Request,
  type Response
} from '@playwright/test';
import { execa } from 'execa';
import { parseDeckHtml } from '@htmlppt/core/node';
import { startCliHost } from './helpers';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'packages/cli/dist/bin.js');
const FRAME_SELECTOR = 'iframe[title="投影片預覽"]';
const PLAY_FRAME_SELECTOR = 'iframe[data-testid="play-frame"]';
const CANVAS_WIDTH = 1600;
const NO_SAVE_TIMEOUT_MS = 500;

interface EditorHarness {
  directory: string;
  file: string;
  host: Awaited<ReturnType<typeof startCliHost>>;
  frame: FrameLocator;
  friendlyPath: string;
}

function isDeckSaveRequest(request: Request): boolean {
  return (
    request.method() === 'PUT' &&
    new URL(request.url()).pathname === '/api/deck'
  );
}

function isDeckSave(response: Response): boolean {
  return isDeckSaveRequest(response.request());
}

async function createTemplate(
  directory: string,
  file: string,
  slideCount = 2
): Promise<void> {
  await execa('node', [cliPath, 'new', file, '--slides', String(slideCount)], {
    cwd: directory
  });
}

async function createNudgeFixture(
  directory: string,
  file: string
): Promise<void> {
  await createTemplate(directory, file);
  const path = join(directory, file);
  const html = await readFile(path, 'utf8');
  const closing = html.indexOf('</section>');
  if (closing === -1) {
    throw new Error('Template slide closing tag was not found.');
  }
  const object =
    '    <div data-ppt-el="box1" style="position:absolute;left:120px;top:160px;width:240px;height:120px;background:#d8c08a">Nudge me</div>\n';
  await writeFile(
    path,
    `${html.slice(0, closing)}${object}${html.slice(closing)}`,
    'utf8'
  );
}

async function createFractionalFlowFixture(
  directory: string,
  file: string
): Promise<void> {
  await createTemplate(directory, file, 1);
  const path = join(directory, file);
  const html = await readFile(path, 'utf8');
  const closing = html.indexOf('</section>');
  if (closing === -1) {
    throw new Error('Template slide closing tag was not found.');
  }
  const object =
    '    <div data-ppt-el="frac" style="margin-left:10.333px;margin-top:20.667px;width:240.333px;height:120px">Fractional flow</div>\n';
  await writeFile(
    path,
    `${html.slice(0, closing)}${object}${html.slice(closing)}`,
    'utf8'
  );
}

async function createNotesFirstFixture(
  directory: string,
  file: string
): Promise<void> {
  await createTemplate(directory, file);
  const path = join(directory, file);
  const html = await readFile(path, 'utf8');
  const sectionStart = html.indexOf('<section');
  const sectionOpenEnd = html.indexOf('>', sectionStart);
  if (sectionStart === -1 || sectionOpenEnd === -1) {
    throw new Error('Template slide opening tag was not found.');
  }
  const children =
    '\n      <aside data-ppt-notes hidden>Legacy notes</aside>\n' +
    '      <div data-ppt-el="box-a" style="position:absolute;left:120px;top:160px;width:100px;height:60px">A</div>\n' +
    '      <div data-ppt-el="box-b" style="position:absolute;left:400px;top:160px;width:100px;height:60px">B</div>\n';
  await writeFile(
    path,
    `${html.slice(0, sectionOpenEnd + 1)}${children}${html.slice(sectionOpenEnd + 1)}`,
    'utf8'
  );
}

async function createTwoBoxFixture(
  directory: string,
  file: string
): Promise<void> {
  await createTemplate(directory, file);
  const path = join(directory, file);
  const html = await readFile(path, 'utf8');
  const closing = html.indexOf('</section>');
  if (closing === -1) {
    throw new Error('Template slide closing tag was not found.');
  }
  const objects =
    '    <div data-ppt-el="box-a" style="position:absolute;left:120px;top:160px;width:100px;height:60px;background:#d8c08a">A</div>\n' +
    '    <div data-ppt-el="box-b" style="position:absolute;left:400px;top:160px;width:100px;height:60px;background:#9ac0d8">B</div>\n';
  await writeFile(
    path,
    `${html.slice(0, closing)}${objects}${html.slice(closing)}`,
    'utf8'
  );
}

async function createNestedGeometryFixture(
  directory: string,
  file: string
): Promise<void> {
  await createTemplate(directory, file);
  const path = join(directory, file);
  const html = await readFile(path, 'utf8');
  const closing = html.indexOf('</section>');
  if (closing === -1) {
    throw new Error('Template slide closing tag was not found.');
  }
  // The template nests the heading inside .slide-inner. Top-level siblings
  // provide a multi-selection target and a group wrapper, while the locked
  // child inside the wrapper gives the Inspector a nested target whose
  // geometry must stay disabled.
  const lockedChild =
    '<p data-ppt-el="locked-nested" data-ppt-locked="true" style="margin:8px 0 0;font-size:28px">Locked nested</p>';
  const headingEnd = html.indexOf('</h1>');
  if (headingEnd === -1) {
    throw new Error('Template heading closing tag was not found.');
  }
  const withLockedChild = `${html.slice(0, headingEnd + 5)}${lockedChild}${html.slice(headingEnd + 5)}`;
  const objectClosing = withLockedChild.indexOf('</section>');
  if (objectClosing === -1) {
    throw new Error('Template slide closing tag was not found.');
  }
  const object =
    '    <div data-ppt-el="sibling" style="position:absolute;left:1180px;top:760px;width:200px;height:60px;background:#9ac0d8">Sibling</div>\n' +
    '    <div data-ppt-el="grouped" data-ppt-group="1" style="position:absolute;left:900px;top:620px;width:300px;height:90px;background:#e8dfc9">\n' +
    '      <p style="margin:16px;font-size:28px">Grouped child</p>\n' +
    '    </div>\n';
  await writeFile(
    path,
    `${withLockedChild.slice(0, objectClosing)}${object}${withLockedChild.slice(objectClosing)}`,
    'utf8'
  );
}

async function createPlacedFixture(
  directory: string,
  file: string
): Promise<void> {
  await createTemplate(directory, file);
  const path = join(directory, file);
  const html = await readFile(path, 'utf8');
  const head = html.indexOf('</head>');
  if (head === -1) throw new Error('Template head closing tag was not found.');
  const withStyle = `${html.slice(
    0,
    head
  )}<style>.placed-object{position:absolute;left:300px;top:220px;width:160px;height:80px;background:#d8c08a}</style>${html.slice(
    head
  )}`;
  const closing = withStyle.indexOf('</section>');
  if (closing === -1) {
    throw new Error('Template slide closing tag was not found.');
  }
  const object =
    '    <div data-ppt-el="placed" class="placed-object">Placed</div>\n';
  await writeFile(
    path,
    `${withStyle.slice(0, closing)}${object}${withStyle.slice(closing)}`,
    'utf8'
  );
}

async function openDeck(
  page: Page,
  prepare: (directory: string, file: string) => Promise<void>,
  ready: (frame: FrameLocator) => Promise<void>
): Promise<EditorHarness> {
  const directory = await mkdtemp(join(tmpdir(), 'htmlppt-editor-e2e-'));
  const file = 'template.html';
  let host: EditorHarness['host'] | null = null;
  try {
    await prepare(directory, file);
    host = await startCliHost(cliPath, directory, file);
    await page.goto(host.url);
    const friendlyPath = `/d/${encodeURIComponent(file)}`;
    await expect
      .poll(() => page.url())
      .toBe(new URL(friendlyPath, host.url).href);
    const frame = page.frameLocator(FRAME_SELECTOR);
    await ready(frame);
    await expect(page.getByTestId('save-status')).toHaveText('已同步');
    return { directory, file, host, frame, friendlyPath };
  } catch (error) {
    if (host) await host.stop();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function openTemplateDeck(
  page: Page,
  slideCount = 2
): Promise<EditorHarness> {
  return openDeck(
    page,
    (directory, file) => createTemplate(directory, file, slideCount),
    async (frame) => {
      await expect(frame.locator('h1')).toContainText('Untitled deck');
    }
  );
}

function openSingleSlideDeck(page: Page): Promise<EditorHarness> {
  return openDeck(
    page,
    (directory, file) => createTemplate(directory, file, 1),
    async (frame) => {
      await expect(frame.locator('h1')).toContainText('Untitled deck');
    }
  );
}

function openNudgeDeck(page: Page): Promise<EditorHarness> {
  return openDeck(
    page,
    createNudgeFixture,
    async (frame) => {
      await expect(frame.locator('[data-ppt-el="box1"]')).toBeVisible();
    }
  );
}

function openFractionalFlowDeck(page: Page): Promise<EditorHarness> {
  return openDeck(page, createFractionalFlowFixture, async (frame) => {
    await expect(frame.locator('[data-ppt-el="frac"]')).toBeVisible();
  });
}

function openNotesFirstDeck(page: Page): Promise<EditorHarness> {
  return openDeck(page, createNotesFirstFixture, async (frame) => {
    await expect(frame.locator('[data-ppt-el="box-a"]')).toBeVisible();
    await expect(frame.locator('[data-ppt-el="box-b"]')).toBeVisible();
  });
}

function openTwoBoxDeck(page: Page): Promise<EditorHarness> {
  return openDeck(page, createTwoBoxFixture, async (frame) => {
    await expect(frame.locator('[data-ppt-el="box-a"]')).toBeVisible();
    await expect(frame.locator('[data-ppt-el="box-b"]')).toBeVisible();
  });
}

function openNestedGeometryDeck(page: Page): Promise<EditorHarness> {
  return openDeck(page, createNestedGeometryFixture, async (frame) => {
    await expect(frame.locator('h1')).toContainText('Untitled deck');
    await expect(frame.locator('[data-ppt-el="sibling"]')).toBeVisible();
  });
}

function openPlacedDeck(page: Page): Promise<EditorHarness> {
  return openDeck(page, createPlacedFixture, async (frame) => {
    await expect(frame.locator('[data-ppt-el="placed"]')).toBeVisible();
  });
}

async function closeEditor(editor: EditorHarness): Promise<void> {
  await editor.host.stop();
  await rm(editor.directory, { recursive: true, force: true });
}

function waitForDeckSave(page: Page) {
  return page.waitForResponse(isDeckSave);
}

async function expectNoDeckSave(
  page: Page,
  action: () => Promise<void>,
  timeout = NO_SAVE_TIMEOUT_MS
): Promise<void> {
  // Attach the waiter before the action so a save that completes during it
  // cannot slip past. The waiter's own timeout is the bounded no-save window.
  const saved = page.waitForResponse(isDeckSave, { timeout }).then(
    () => true,
    () => false
  );
  await action();
  expect(await saved, 'a deck save was issued unexpectedly').toBe(false);
}

interface HeldDeckSave {
  release: () => void;
  request: Promise<Request>;
  response: Promise<Response>;
}

/**
 * Holds the next deck PUT at the network layer so a test can act while the
 * controller is awaiting a slow save. The request and response waiters are
 * attached before any action is triggered.
 */
async function holdNextDeckSave(page: Page): Promise<HeldDeckSave> {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/deck', async (route) => {
    if (route.request().method() === 'PUT') await gate;
    await route.continue();
  });
  return {
    release,
    request: page.waitForRequest(isDeckSaveRequest),
    response: page.waitForResponse(isDeckSave)
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function holdDeckResponses(page: Page, count = 1, method = 'PUT') {
  const holds = Array.from({ length: count }, () => ({
    gate: deferred<void>(),
    forwarded: deferred<APIResponse>(),
    delivered: deferred<void>()
  }));
  let index = 0;
  await page.route('**/api/deck', async (route) => {
    const hold = route.request().method() === method ? holds[index++] : undefined;
    if (!hold) {
      await route.continue();
      return;
    }
    const response = await route.fetch({ maxRetries: 0 });
    hold.forwarded.resolve(response);
    await hold.gate.promise;
    await route.fulfill({ response });
    hold.delivered.resolve();
  });
  return holds;
}

async function observeLiveSync(page: Page) {
  const session = await page.context().newCDPSession(page);
  const events: { revision: string; source?: string }[] = [];
  const errors: string[] = [];
  const saves: Request[] = [];
  await session.send('Network.enable');
  session.on('Network.eventSourceMessageReceived', (event) => {
    if (event.eventName === 'hello' || event.eventName === 'revision') {
      events.push(JSON.parse(event.data) as { revision: string; source?: string });
    }
  });
  page.on('pageerror', (error) => errors.push(error.toString()));
  page.on('request', (request) => {
    if (isDeckSaveRequest(request)) saves.push(request);
  });
  await page.addInitScript(() => {
    const rejections: string[] = [];
    const browser = globalThis as unknown as {
      addEventListener(type: string, listener: (event: { reason: unknown }) => void): void;
    };
    Object.assign(globalThis, { liveSyncRejections: rejections });
    browser.addEventListener('unhandledrejection', (event) => {
      rejections.push(String(event.reason));
    });
  });
  return {
    events,
    saves,
    async healthy() {
      expect(errors, 'pageerror (including RangeError)').toEqual([]);
      expect(await page.evaluate(() => Reflect.get(globalThis, 'liveSyncRejections')),
        'unhandledrejection').toEqual([]);
    }
  };
}

async function hostDeck(page: Page, editor: EditorHarness) {
  const url = new URL(editor.host.url);
  const response = await page.request.get(new URL('/api/deck', url).href, {
    headers: { authorization: `Bearer ${url.searchParams.get('token')}` }
  });
  expect(response.status()).toBe(200);
  return await response.json() as {
    html: string;
    revision: string;
    filePath: string;
  };
}

async function createRealSaveConflict(page: Page, editor: EditorHarness) {
  const held = await holdNextDeckSave(page);
  try {
    await editor.frame.locator('[data-ppt-el="box1"]').click();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Control+s');
    const request = await held.request;
    await writeExternalHeading(editor, 'External conflict');
    const external = await hostDeck(page, editor);
    expect((request.postDataJSON() as { baseRevision: string }).baseRevision)
      .not.toBe(external.revision);
    held.release();
    const response = await held.response;
    expect(response.status()).toBe(409);
    expect(await response.json()).toEqual({
      error: 'conflict',
      revision: external.revision,
      filePath: external.filePath
    });
    await expect(page.getByTestId('conflict-banner')).toBeVisible();
    await expect(page.getByTestId('save-status')).toHaveText('衝突');
    expect((await inlineGeometryOf(editor.frame.locator('[data-ppt-el="box1"]'))).left).toBe(121);
    expect((await savedNudgeBoxStyle(editor.directory, editor.file)).left).toBe('120px');
    expect(await savedDocument(editor)).toContain('External conflict');
    return external;
  } finally {
    held.release();
    await page.unroute('**/api/deck');
  }
}

function playFrameFor(page: Page): FrameLocator {
  return page.frameLocator(PLAY_FRAME_SELECTOR);
}

function slideIds(page: Page): Promise<string[]> {
  return page.getByTestId('thumbnail').evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-slide-id') ?? '')
  );
}

function slideTitles(page: Page): Promise<string[]> {
  return page.getByTestId('thumbnail').evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-slide-title') ?? '')
  );
}

function sorterSlideIds(page: Page): Promise<string[]> {
  return page.getByTestId('sorter-slide').evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-slide-id') ?? '')
  );
}

function savedSlideOrder(html: string): string[] {
  return [...html.matchAll(/data-slide-id="([^"]+)"/g)].map(
    (match) => match[1] ?? ''
  );
}

async function savedDocument(editor: EditorHarness): Promise<string> {
  return readFile(join(editor.directory, editor.file), 'utf8');
}

/**
 * Checks real attributes in the saved document. Raw substring checks would
 * also match the bundled runtime source, whose selectors mention these names.
 */
async function savedHas(
  editor: EditorHarness,
  selector: string
): Promise<boolean> {
  return parseDeckHtml(await savedDocument(editor)).querySelector(selector) !== null;
}

/**
 * Replaces the first slide heading in the deck file behind the host's back.
 * The host watcher turns that write into an external revision.
 */
async function writeExternalHeading(
  editor: EditorHarness,
  heading: string
): Promise<void> {
  const path = join(editor.directory, editor.file);
  const html = await readFile(path, 'utf8');
  const replaced = html.replace(
    /(<h1\b[^>]*>)[^<]*(<\/h1>)/,
    `$1${heading}$2`
  );
  if (replaced === html) {
    throw new Error('Could not find a heading to replace.');
  }
  await writeFile(path, replaced, 'utf8');
}

async function dragSorterTile(
  page: Page,
  fromIndex: number,
  toIndex: number
): Promise<void> {
  const tiles = page.getByTestId('sorter-slide');
  const source = await tiles.nth(fromIndex).boundingBox();
  const target = await tiles.nth(toIndex).boundingBox();
  if (!source || !target) throw new Error('Sorter tiles have no bounding box.');
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    target.x + target.width / 2,
    target.y + target.height / 2,
    { steps: 10 }
  );
  await page.mouse.up();
}

interface InlineGeometry {
  position: string;
  left: number | null;
  top: number | null;
  width: number | null;
  height: number | null;
}

async function inlineGeometryOf(locator: Locator): Promise<InlineGeometry> {
  return locator.evaluate((element) => {
    const style = (
      element as unknown as {
        style: {
          position: string;
          left: string;
          top: string;
          width: string;
          height: string;
        };
      }
    ).style;
    const toNumber = (value: string) => {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    return {
      position: style.position,
      left: style.left === '' ? null : toNumber(style.left),
      top: style.top === '' ? null : toNumber(style.top),
      width: style.width === '' ? null : toNumber(style.width),
      height: style.height === '' ? null : toNumber(style.height)
    };
  });
}

async function slideInnerGeometry(frame: FrameLocator): Promise<InlineGeometry> {
  return inlineGeometryOf(frame.locator('.slide-inner'));
}

async function headingGeometry(frame: FrameLocator): Promise<InlineGeometry> {
  return inlineGeometryOf(frame.locator('h1'));
}

async function frameScale(page: Page): Promise<number> {
  return page.locator(FRAME_SELECTOR).evaluate((iframe) => {
    return iframe.getBoundingClientRect().width / 1600;
  });
}

/**
 * Slide-level clicks select the innermost component, so these tests select the
 * template's top-level wrapper from its own padding instead of the nested
 * heading that resolved to the wrapper under the superseded rule.
 */
async function selectSlideInner(
  page: Page,
  frame: FrameLocator
): Promise<void> {
  await frame.locator('.slide-inner').click({ position: { x: 4, y: 4 } });
  await expect(page.getByTestId('selection-outline')).toHaveAttribute(
    'data-selected-path',
    '0'
  );
}

/**
 * A screen point in the wrapper's own padding, clear of the selection handles
 * that straddle its corners. A gesture from here moves the wrapper itself.
 */
async function slideInnerDragStart(
  frame: FrameLocator
): Promise<{ x: number; y: number }> {
  const box = await frame.locator('.slide-inner').boundingBox();
  if (!box) throw new Error('Slide inner has no bounding box.');
  return { x: box.x + 20, y: box.y + 20 };
}

function styleDeclaration(style: string, property: string): string | null {
  for (const part of style.split(';')) {
    const separator = part.indexOf(':');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === property) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

async function savedStyle(
  directory: string,
  file: string,
  tagPattern: RegExp
): Promise<Record<string, string | null>> {
  const html = await readFile(join(directory, file), 'utf8');
  const style = /style="([^"]*)"/.exec(tagPattern.exec(html)?.[0] ?? '')?.[1] ?? '';
  // The serializer escapes quotes inside attribute values; decode them before
  // splitting declarations so url("...") values stay intact.
  const decoded = style
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
  return {
    position: styleDeclaration(decoded, 'position'),
    left: styleDeclaration(decoded, 'left'),
    top: styleDeclaration(decoded, 'top'),
    width: styleDeclaration(decoded, 'width'),
    height: styleDeclaration(decoded, 'height'),
    transform: styleDeclaration(decoded, 'transform'),
    background: styleDeclaration(decoded, 'background'),
    'background-image': styleDeclaration(decoded, 'background-image'),
    'background-color': styleDeclaration(decoded, 'background-color')
  };
}

async function savedSlideInnerStyle(
  directory: string,
  file: string
): Promise<Record<string, string | null>> {
  return savedStyle(
    directory,
    file,
    /<div[^>]*class="slide-inner"[^>]*>/
  );
}

async function savedSlideStyle(
  directory: string,
  file: string
): Promise<Record<string, string | null>> {
  return savedStyle(
    directory,
    file,
    /<section[^>]*data-slide-id="s1"[^>]*>/
  );
}

async function savedNudgeBoxStyle(
  directory: string,
  file: string
): Promise<Record<string, string | null>> {
  return savedStyle(
    directory,
    file,
    /<div[^>]*data-ppt-el="box1"[^>]*>/
  );
}

interface ScreenBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ScreenPoint {
  x: number;
  y: number;
}

interface FrameDomWindow {
  __pptPointerId?: number;
  PointerEvent: new (
    type: string,
    init?: Record<string, unknown>
  ) => object;
  document: {
    dispatchEvent(event: object): boolean;
    addEventListener(
      type: string,
      listener: (event: { pointerId: number }) => void,
      options?: { once?: boolean; capture?: boolean }
    ): void;
  };
}

function centerOfBox(box: ScreenBox): ScreenPoint {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function normalizeAngle(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

function pointerAngle(center: ScreenPoint, point: ScreenPoint): number {
  const radians = Math.atan2(point.y - center.y, point.x - center.x);
  return normalizeAngle((radians * 180) / Math.PI + 90);
}

function angleDelta(from: number, to: number): number {
  const delta = normalizeAngle(to - from);
  return delta > 180 ? delta - 360 : delta;
}

function pointAt(
  center: ScreenPoint,
  radius: number,
  degrees: number
): ScreenPoint {
  const radians = (degrees * Math.PI) / 180;
  return {
    x: center.x + Math.cos(radians) * radius,
    y: center.y + Math.sin(radians) * radius
  };
}

function rotationDegrees(transform: string): number {
  const match = /rotate\(\s*(-?(?:\d+|\d*\.\d+))deg\s*\)/.exec(transform);
  return match?.[1] === undefined ? Number.NaN : Number(match[1]);
}

function distanceToAngleStep(degrees: number, step: number): number {
  const remainder = normalizeAngle(degrees) % step;
  return Math.min(remainder, step - remainder);
}

async function transformOf(
  frame: FrameLocator,
  selector: string
): Promise<string> {
  return frame.locator(selector).evaluate((element) => {
    return (
      element as unknown as { style: { transform: string } }
    ).style.transform;
  });
}

async function transformOriginOf(
  frame: FrameLocator,
  selector: string
): Promise<string> {
  return frame.locator(selector).evaluate((element) => {
    return (
      element as unknown as { style: { transformOrigin: string } }
    ).style.transformOrigin;
  });
}

test(
  'clicking inside the heading selects the heading with eight handles',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      await editor.frame.locator('h1').click();

      const outline = page.getByTestId('selection-outline');
      await expect(outline).toBeVisible();
      await expect(outline).toHaveAttribute('data-selected-path', '0.1');
      await expect(outline).toHaveAttribute('data-selected-id', 'e1');
      await expect(outline).not.toHaveAttribute('data-readonly', 'true');
      await expect(page.locator('[data-testid^="handle-"]')).toHaveCount(8);
      await expect(page.getByTestId('handle-e')).toBeVisible();
      await expect(page.getByTestId('rotate-handle')).toBeVisible();

      // Editor chrome is rendered in the parent document, never in the deck.
      const overlayInsideFrame = await page
        .locator(FRAME_SELECTOR)
        .evaluate((iframe) => {
          const document = (
            iframe as unknown as {
              contentDocument: {
                querySelector(selector: string): unknown;
              } | null;
            }
          ).contentDocument;
          return document?.querySelector('[data-testid="selection-outline"]') !== null;
        });
      expect(overlayInsideFrame).toBe(false);
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'nested single selection is editable while multi-selection stays read-only',
  {
    tag: [
      '@feature:editor-core',
      '@feature:drill-in-selection',
      '@feature:nested-geometry'
    ]
  },
  async ({ page }) => {
    const editor = await openNestedGeometryDeck(page);
    try {
      const heading = editor.frame.locator('h1');
      const outline = page.getByTestId('selection-outline');

      // Two top-level objects: the outer wrapper and the sibling box. A
      // multi-selection keeps the read-only contract: outlines only, no
      // handles, and disabled numeric geometry.
      await editor.frame.locator('[data-ppt-el="sibling"]').click();
      await heading.click({ modifiers: ['Shift'] });
      await expect(outline).toHaveCount(2);
      expect(
        await outline.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute('data-readonly'))
        )
      ).toEqual(['true', 'true']);
      await expect(page.locator('[data-testid^="handle-"]')).toHaveCount(0);
      await expect(page.getByTestId('rotate-handle')).toHaveCount(0);
      await expect(page.getByTestId('field-x')).toBeDisabled();
      await expect(page.getByTestId('field-rotation')).toBeDisabled();

      // Enter the wrapper from its own padding: a child click now produces a
      // single nested selection instead of the top-level wrapper.
      const innerBox = await editor.frame.locator('.slide-inner').boundingBox();
      if (!innerBox) throw new Error('Slide inner has no bounding box.');
      await page.mouse.dblclick(innerBox.x + 8, innerBox.y + 8);
      await expect(page.getByTestId('edit-context')).toBeVisible();

      await heading.click();
      await expect(outline).toHaveCount(1);
      await expect(outline).toHaveAttribute('data-selected-id', 'e1');
      await expect(outline).toHaveAttribute('data-selected-path', '0.1');
      await expect(outline).not.toHaveAttribute('data-readonly', 'true');
      await expect(page.getByTestId('handle-e')).toBeVisible();
      await expect(page.getByTestId('rotate-handle')).toBeVisible();
      await expect(page.getByTestId('field-x')).toBeEnabled();
      await expect(page.getByTestId('field-rotation')).toBeEnabled();

      // Drag the nested heading: the live gesture pins the flow child to
      // absolute geometry at its measured origin plus the pointer delta.
      const scale = await frameScale(page);
      const start = await heading.evaluate((element) => {
        const slide = element.closest('[data-ppt-frame-slide]');
        if (!slide) throw new Error('Frame slide is missing.');
        const rect = element.getBoundingClientRect();
        const base = slide.getBoundingClientRect();
        return { x: rect.left - base.left, y: rect.top - base.top };
      });
      const box = await heading.boundingBox();
      if (!box) throw new Error('Heading has no bounding box.');
      const startX = box.x + box.width / 2;
      const startY = box.y + box.height / 2;

      const save = waitForDeckSave(page);
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + 100, startY + 50, { steps: 5 });
      await page.mouse.up();
      expect((await save).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      const dragged = await headingGeometry(editor.frame);
      expect(dragged.position).toBe('absolute');
      expect(dragged.left).toBeCloseTo(start.x + 100 / scale, 0);
      expect(dragged.top).toBeCloseTo(start.y + 50 / scale, 0);
      // Only the nested child is pinned; the wrapper stays in flow.
      expect((await slideInnerGeometry(editor.frame)).position).toBe('');

      const savedHeading = () =>
        savedStyle(editor.directory, editor.file, /<h1[^>]*>/);
      await expect.poll(async () => (await savedHeading()).position).toBe(
        'absolute'
      );
      const savedAfterDrag = await savedHeading();
      expect(Number.parseFloat(savedAfterDrag.left ?? '')).toBeCloseTo(
        dragged.left ?? 0,
        1
      );
      expect(Number.parseFloat(savedAfterDrag.top ?? '')).toBeCloseTo(
        dragged.top ?? 0,
        1
      );

      // Arrow keys nudge the nested selection instead of changing slides.
      const nudgeSave = waitForDeckSave(page);
      await page.keyboard.press('ArrowRight');
      expect((await nudgeSave).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
      const nudged = await headingGeometry(editor.frame);
      expect(nudged.left).toBeCloseTo((dragged.left ?? 0) + 1, 0);
      expect(nudged.top).toBeCloseTo(dragged.top ?? 0, 0);
      await expect(heading).toHaveText('Untitled deck');
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'nested locked and group-blocked targets keep inspector geometry disabled',
  { tag: ['@feature:editor-core', '@feature:nested-geometry'] },
  async ({ page }) => {
    const editor = await openNestedGeometryDeck(page);
    try {
      const outline = page.getByTestId('selection-outline');
      const nestedFields = [
        'field-x',
        'field-y',
        'field-width',
        'field-height',
        'field-rotation'
      ];

      // A locked child of an unlocked top-level wrapper: the canvas already
      // refuses transforms, and the Inspector must agree instead of accepting
      // a numeric edit that would move a locked object.
      await editor.frame
        .locator('[data-ppt-el="locked-nested"]')
        .click({ modifiers: ['Alt'] });
      await expect(outline).toHaveAttribute('data-selected-path', '0.2');
      await expect(outline).toHaveAttribute('data-readonly', 'true');
      for (const field of nestedFields) {
        await expect(page.getByTestId(field)).toBeDisabled();
      }

      // A child of a top-level group wrapper: the group ancestor blocks every
      // geometry field, including the position and rotation that a top-level
      // group itself may still change.
      await editor.frame
        .locator('[data-ppt-el="grouped"] p')
        .click({ modifiers: ['Alt'] });
      await expect(outline).toHaveAttribute('data-selected-path', '2.0');
      await expect(outline).toHaveAttribute('data-readonly', 'true');
      for (const field of nestedFields) {
        await expect(page.getByTestId(field)).toBeDisabled();
      }
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'nested single selection resizes and rotates from the overlay handles',
  {
    tag: [
      '@feature:editor-core',
      '@feature:drill-in-selection',
      '@feature:nested-geometry'
    ]
  },
  async ({ page }) => {
    const editor = await openNestedGeometryDeck(page);
    try {
      const heading = editor.frame.locator('h1');
      const outline = page.getByTestId('selection-outline');
      const innerBox = await editor.frame.locator('.slide-inner').boundingBox();
      if (!innerBox) throw new Error('Slide inner has no bounding box.');
      await page.mouse.dblclick(innerBox.x + 8, innerBox.y + 8);
      await expect(page.getByTestId('edit-context')).toBeVisible();
      await heading.click();
      await expect(outline).toHaveAttribute('data-selected-path', '0.1');

      const scale = await frameScale(page);
      const startBox = await heading.boundingBox();
      if (!startBox) throw new Error('Heading has no bounding box.');
      const startWidth = startBox.width / scale;
      const startHeight = startBox.height / scale;

      const east = page.getByTestId('handle-e');
      const eastBox = await east.boundingBox();
      if (!eastBox) throw new Error('East handle has no bounding box.');
      const eastX = eastBox.x + eastBox.width / 2;
      const eastY = eastBox.y + eastBox.height / 2;

      const resizeSave = waitForDeckSave(page);
      await page.mouse.move(eastX, eastY);
      await page.mouse.down();
      // Shrink so the inline width stays below the template's 1200px
      // max-width; otherwise the rendered box and the inline geometry that
      // the rotation centre uses would disagree.
      await page.mouse.move(eastX - 80, eastY, { steps: 5 });
      await page.mouse.up();
      expect((await resizeSave).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      const resized = await headingGeometry(editor.frame);
      expect(resized.width).not.toBeNull();
      expect(resized.height).not.toBeNull();
      expect(resized.width!).toBeCloseTo(startWidth - 80 / scale, 0);
      expect(resized.height!).toBeCloseTo(startHeight, 0);
      const savedHeading = () =>
        savedStyle(editor.directory, editor.file, /<h1[^>]*>/);
      await expect
        .poll(async () => (await savedHeading()).width)
        .not.toBeNull();
      const savedAfterResize = await savedHeading();
      expect(Number.parseFloat(savedAfterResize.width ?? '')).toBeCloseTo(
        resized.width!,
        1
      );
      expect(Number.parseFloat(savedAfterResize.height ?? '')).toBeCloseTo(
        resized.height!,
        1
      );

      const rotatedBox = await heading.boundingBox();
      const rotate = page.getByTestId('rotate-handle');
      const rotateBox = await rotate.boundingBox();
      if (!rotatedBox || !rotateBox) {
        throw new Error('Rotation geometry is unavailable.');
      }
      const center = centerOfBox(rotatedBox);
      const handleCenter = {
        x: rotateBox.x + rotateBox.width / 2,
        y: rotateBox.y + rotateBox.height / 2
      };
      // Keep the pointer far from the centre so integer client coordinates
      // cannot shift the measured angle by more than the tolerance below.
      const radius = 240;
      const target = pointAt(center, radius, -33);
      const expectedRotation = normalizeAngle(
        angleDelta(
          pointerAngle(center, handleCenter),
          pointerAngle(center, target)
        )
      );

      const rotateSave = waitForDeckSave(page);
      await page.mouse.move(handleCenter.x, handleCenter.y);
      await page.mouse.down();
      await page.mouse.move(target.x, target.y, { steps: 8 });
      await page.mouse.up();
      expect((await rotateSave).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      const inlineTransform = await transformOf(editor.frame, 'h1');
      expect(inlineTransform).toContain('rotate(');
      expect(
        Math.abs(rotationDegrees(inlineTransform) - expectedRotation)
      ).toBeLessThanOrEqual(2);
      await expect
        .poll(async () => (await savedHeading()).transform ?? null)
        .toBe(inlineTransform);
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'dragging the selected top-level object pins absolute geometry and saves',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      const scale = await frameScale(page);
      await selectSlideInner(page, editor.frame);
      const start = await slideInnerDragStart(editor.frame);

      const save = waitForDeckSave(page);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      // A small move stays inside the snap threshold and renders a guide.
      await page.mouse.move(start.x + 3, start.y + 1);
      await expect(page.getByTestId('guide-x')).toBeVisible();
      await page.mouse.move(start.x + 100, start.y + 50, { steps: 5 });
      await page.mouse.up();
      await expect(page.getByTestId('guide-x')).toHaveCount(0);
      expect((await save).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      const geometry = await slideInnerGeometry(editor.frame);
      expect(geometry.position).toBe('absolute');
      expect(geometry.left).toBeCloseTo(100 / scale, 0);
      expect(geometry.top).toBeCloseTo(50 / scale, 0);

      await expect
        .poll(async () => (await savedSlideInnerStyle(editor.directory, editor.file)).position)
        .toBe('absolute');
      const saved = await savedSlideInnerStyle(editor.directory, editor.file);
      expect(Number.parseFloat(saved.left ?? '')).toBeCloseTo(100 / scale, 0);
      expect(Number.parseFloat(saved.top ?? '')).toBeCloseTo(50 / scale, 0);

      const html = await readFile(join(editor.directory, editor.file), 'utf8');
      const savedDoc = parseDeckHtml(html);
      expect(savedDoc.querySelector('[data-testid]')).toBeNull();
      expect(savedDoc.querySelector('[data-ppt-frame-slide]')).toBeNull();
      expect(savedDoc.querySelector('[contenteditable]')).toBeNull();
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'arrow keys are ignored during a pointer gesture',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      const scale = await frameScale(page);
      await selectSlideInner(page, editor.frame);
      const start = await slideInnerDragStart(editor.frame);

      const saveRequests: Request[] = [];
      const countSave = (request: Request) => {
        if (isDeckSaveRequest(request)) saveRequests.push(request);
      };
      page.on('request', countSave);
      try {
        const save = waitForDeckSave(page);
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(start.x + 100, start.y + 50, { steps: 5 });
        // A live keyboard handler would nudge and commit mid-gesture, adding a
        // second save and another design pixel of offset.
        await page.keyboard.press('ArrowRight');
        await page.mouse.up();
        expect((await save).ok()).toBeTruthy();
        await expect(page.getByTestId('save-status')).toHaveText('已儲存');

        expect(saveRequests).toHaveLength(1);
        const geometry = await slideInnerGeometry(editor.frame);
        expect(geometry.position).toBe('absolute');
        expect(geometry.left).toBeCloseTo(100 / scale, 0);
        expect(geometry.top).toBeCloseTo(50 / scale, 0);
      } finally {
        page.off('request', countSave);
      }
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'resizing from the east handle changes width but not height',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      await selectSlideInner(page, editor.frame);
      const east = page.getByTestId('handle-e');
      await expect(east).toBeVisible();

      const before = await slideInnerGeometry(editor.frame);
      expect(before.height).toBeNull();
      const scale = await frameScale(page);
      const handleBox = await east.boundingBox();
      if (!handleBox) throw new Error('East handle has no bounding box.');

      const save = waitForDeckSave(page);
      await page.mouse.move(
        handleBox.x + handleBox.width / 2,
        handleBox.y + handleBox.height / 2
      );
      await page.mouse.down();
      await page.mouse.move(
        handleBox.x + handleBox.width / 2 - 80,
        handleBox.y + handleBox.height / 2,
        { steps: 5 }
      );
      await page.mouse.up();
      expect((await save).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      const after = await slideInnerGeometry(editor.frame);
      expect(after.height).toBe(900);
      expect(after.width).not.toBeNull();
      expect(after.width!).toBeCloseTo(CANVAS_WIDTH - 80 / scale, 0);

      await expect
        .poll(async () => (await savedSlideInnerStyle(editor.directory, editor.file)).width)
        .not.toBeNull();
      const saved = await savedSlideInnerStyle(editor.directory, editor.file);
      expect(Number.parseFloat(saved.height ?? '')).toBe(900);
      expect(Number.parseFloat(saved.width ?? '')).toBeCloseTo(
        CANVAS_WIDTH - 80 / scale,
        0
      );
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'rotation stays raw without shift and snaps to 15 degree steps with shift',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      await selectSlideInner(page, editor.frame);
      const rotate = page.getByTestId('rotate-handle');
      await expect(rotate).toBeVisible();
      const elementBox = await editor.frame.locator('.slide-inner').boundingBox();
      const handleBox = await rotate.boundingBox();
      if (!elementBox || !handleBox) {
        throw new Error('Rotation geometry is unavailable.');
      }
      const center = centerOfBox(elementBox);
      const radius = 240;
      const targetPoint = pointAt(center, radius, -33);

      const firstSave = waitForDeckSave(page);
      await page.mouse.move(
        handleBox.x + handleBox.width / 2,
        handleBox.y + handleBox.height / 2
      );
      await page.mouse.down();
      await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 8 });
      await page.mouse.up();
      expect((await firstSave).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      const expectedRaw = normalizeAngle(
        angleDelta(
          pointerAngle(center, {
            x: handleBox.x + handleBox.width / 2,
            y: handleBox.y + handleBox.height / 2
          }),
          pointerAngle(center, targetPoint)
        )
      );
      const raw = rotationDegrees(
        await transformOf(editor.frame, '.slide-inner')
      );
      expect(Math.abs(raw - expectedRaw)).toBeLessThanOrEqual(2);
      expect(raw % 15).toBeGreaterThan(1);
      expect(await transformOriginOf(editor.frame, '.slide-inner')).toBe(
        '50% 50%'
      );

      const handleBoxAfter = await rotate.boundingBox();
      if (!handleBoxAfter) {
        throw new Error('Rotation handle has no bounding box after the gesture.');
      }
      const shiftTarget = pointAt(center, radius, -3);
      const expectedSnapped = normalizeAngle(
        Math.round(
          normalizeAngle(
            raw +
              angleDelta(
                pointerAngle(center, {
                  x: handleBoxAfter.x + handleBoxAfter.width / 2,
                  y: handleBoxAfter.y + handleBoxAfter.height / 2
                }),
                pointerAngle(center, shiftTarget)
              )
          ) / 15
        ) * 15
      );

      const secondSave = waitForDeckSave(page);
      await page.keyboard.down('Shift');
      await page.mouse.move(
        handleBoxAfter.x + handleBoxAfter.width / 2,
        handleBoxAfter.y + handleBoxAfter.height / 2
      );
      await page.mouse.down();
      await page.mouse.move(shiftTarget.x, shiftTarget.y, { steps: 8 });
      await page.mouse.up();
      await page.keyboard.up('Shift');
      expect((await secondSave).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      const snapped = rotationDegrees(
        await transformOf(editor.frame, '.slide-inner')
      );
      expect(snapped % 15).toBe(0);
      expect(Math.abs(snapped - expectedSnapped)).toBeLessThanOrEqual(1);
      expect(Math.abs(snapped - raw)).toBeGreaterThan(5);

      // Alt disables the 15 degree snap even while Shift is held.
      const handleBoxAlt = await rotate.boundingBox();
      if (!handleBoxAlt) {
        throw new Error('Rotation handle has no bounding box for alt drag.');
      }
      const altTarget = pointAt(center, radius, 37);
      const expectedAltRaw = normalizeAngle(
        snapped +
          angleDelta(
            pointerAngle(center, {
              x: handleBoxAlt.x + handleBoxAlt.width / 2,
              y: handleBoxAlt.y + handleBoxAlt.height / 2
            }),
            pointerAngle(center, altTarget)
          )
      );

      const thirdSave = waitForDeckSave(page);
      await page.mouse.move(
        handleBoxAlt.x + handleBoxAlt.width / 2,
        handleBoxAlt.y + handleBoxAlt.height / 2
      );
      await page.mouse.down();
      await page.keyboard.down('Alt');
      await page.keyboard.down('Shift');
      await page.mouse.move(altTarget.x, altTarget.y, { steps: 8 });
      await page.mouse.up();
      await page.keyboard.up('Shift');
      await page.keyboard.up('Alt');
      expect((await thirdSave).ok()).toBeTruthy();

      const altRaw = rotationDegrees(
        await transformOf(editor.frame, '.slide-inner')
      );
      expect(Math.abs(altRaw - expectedAltRaw)).toBeLessThanOrEqual(2);
      // 127 degrees sits in the middle of a 15 degree bucket, so layout or
      // rounding shifts cannot turn this into a snapped-looking angle.
      expect(distanceToAngleStep(altRaw, 15)).toBeGreaterThanOrEqual(5);

      const finalTransform = await transformOf(
        editor.frame,
        '.slide-inner'
      );
      await expect
        .poll(
          async () =>
            (
              await savedSlideInnerStyle(editor.directory, editor.file)
            ).transform ?? null
        )
        .toBe(finalTransform);
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'alt disables snapping during a drag',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      const scale = await frameScale(page);
      await selectSlideInner(page, editor.frame);
      const start = await slideInnerDragStart(editor.frame);

      const save = waitForDeckSave(page);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      // Alt is held during the move, which must bypass snapping.
      await page.keyboard.down('Alt');
      await page.mouse.move(start.x + 3, start.y + 3, { steps: 2 });
      await expect(page.getByTestId('guide-x')).toHaveCount(0);
      await expect(page.getByTestId('guide-y')).toHaveCount(0);
      await page.mouse.up();
      await page.keyboard.up('Alt');
      expect((await save).ok()).toBeTruthy();

      const geometry = await slideInnerGeometry(editor.frame);
      expect(geometry.position).toBe('absolute');
      expect(geometry.left).toBeCloseTo(3 / scale, 0);
      expect(geometry.top).toBeCloseTo(3 / scale, 0);
      expect(geometry.left).toBeGreaterThan(0);
      expect(geometry.top).toBeGreaterThan(0);
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'arrow keys nudge a movable top-level object by 1 px and 10 px with shift',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openNudgeDeck(page);
    try {
      const object = editor.frame.locator('[data-ppt-el="box1"]');
      await object.click();

      const outline = page.getByTestId('selection-outline');
      await expect(outline).toBeVisible();
      await expect(outline).toHaveAttribute('data-selected-id', 'box1');
      await expect(outline).toHaveAttribute('data-selected-path', '1');
      await expect(outline).not.toHaveAttribute('data-readonly', 'true');

      const iframeBox = await page.locator(FRAME_SELECTOR).boundingBox();
      const scale = await frameScale(page);
      const designRect = await object.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        };
      });
      const outlineBox = await outline.boundingBox();
      if (!iframeBox || !outlineBox) {
        throw new Error('Overlay alignment geometry is unavailable.');
      }
      const expected = {
        x: iframeBox.x + designRect.x * scale,
        y: iframeBox.y + designRect.y * scale,
        width: designRect.width * scale,
        height: designRect.height * scale
      };
      expect(Math.abs(outlineBox.x - expected.x)).toBeLessThanOrEqual(2);
      expect(Math.abs(outlineBox.y - expected.y)).toBeLessThanOrEqual(2);
      expect(Math.abs(outlineBox.width - expected.width)).toBeLessThanOrEqual(2);
      expect(Math.abs(outlineBox.height - expected.height)).toBeLessThanOrEqual(2);

      const before = await inlineGeometryOf(object);
      expect(before.left).toBe(120);
      expect(before.top).toBe(160);

      const firstSave = waitForDeckSave(page);
      await page.keyboard.press('ArrowRight');
      expect((await firstSave).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      let geometry = await inlineGeometryOf(object);
      expect(geometry.position).toBe('absolute');
      expect(geometry.left).toBeCloseTo(121, 2);
      expect(geometry.top).toBeCloseTo(160, 2);

      const secondSave = waitForDeckSave(page);
      await page.keyboard.press('Shift+ArrowRight');
      expect((await secondSave).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      geometry = await inlineGeometryOf(object);
      expect(geometry.left).toBeCloseTo(131, 2);
      await expect
        .poll(async () => (await savedNudgeBoxStyle(editor.directory, editor.file)).left)
        .not.toBeNull();
      const saved = await savedNudgeBoxStyle(editor.directory, editor.file);
      expect(Number.parseFloat(saved.left ?? '')).toBeCloseTo(131, 2);
      expect(Number.parseFloat(saved.top ?? '')).toBeCloseTo(160, 2);
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'reloading the editor preserves the saved transform',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      const start = await slideInnerDragStart(editor.frame);

      const save = waitForDeckSave(page);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x + 60, start.y + 30, { steps: 4 });
      await page.mouse.up();
      expect((await save).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
      const beforeReload = await slideInnerGeometry(editor.frame);

      await page.reload();
      const reloadedFrame = page.frameLocator(FRAME_SELECTOR);
      await expect(reloadedFrame.locator('h1')).toContainText('Untitled deck');
      await expect(page.getByTestId('save-status')).toHaveText('已同步');

      const afterReload = await slideInnerGeometry(reloadedFrame);
      expect(afterReload.position).toBe('absolute');
      expect(afterReload.left).toBeCloseTo(beforeReload.left!, 1);
      expect(afterReload.top).toBeCloseTo(beforeReload.top!, 1);
      expect(afterReload.left!).toBeGreaterThan(0);
      expect(afterReload.top!).toBeGreaterThan(0);
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'arrow keys do nothing while editing text',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      const heading = editor.frame.locator('h1');
      await heading.dblclick();
      await expect(heading).toHaveAttribute('contenteditable', 'true');
      const headingBefore = await headingGeometry(editor.frame);
      const wrapperBefore = await slideInnerGeometry(editor.frame);

      await expectNoDeckSave(page, () => page.keyboard.press('ArrowRight'));

      expect(await headingGeometry(editor.frame)).toEqual(headingBefore);
      expect(await slideInnerGeometry(editor.frame)).toEqual(wrapperBefore);
      await expect(heading).toHaveText('Untitled deck');
      await expect(page.getByTestId('save-status')).toHaveText('已同步');
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'keyboard focus in the text toolbar keeps editing and applies bold',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      const heading = editor.frame.locator('h1');
      await heading.dblclick();
      await expect(heading).toHaveAttribute('contenteditable', 'true');
      await expect(page.getByTestId('text-toolbar')).toBeVisible();
      await page.keyboard.press('Control+a');
      await page.keyboard.type('Toolbar focus bold');
      await page.keyboard.press('Control+Shift+ArrowLeft');

      // Simulates keyboard focus leaving the iframe for a toolbar button.
      await page.getByTestId('text-bold').focus();
      await expect(page.getByTestId('text-toolbar')).toBeVisible();
      await page.keyboard.press('Enter');

      await expect(heading.locator('span[style*="font-weight"]')).toHaveCSS(
        'font-weight',
        '700'
      );
      await expect(heading).toHaveAttribute('contenteditable', 'true');

      const save = waitForDeckSave(page);
      await page.getByTestId('canvas-preview').click({ position: { x: 4, y: 4 } });
      expect((await save).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
      const saved = await savedDocument(editor);
      expect(saved).toMatch(/font-weight:\s*bold/);
      expect(saved).not.toContain('contenteditable');
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'escape and pointercancel cancel a drag without saving',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      const outline = page.getByTestId('selection-outline');
      const frameHandle = page.locator(FRAME_SELECTOR);
      const heading = editor.frame.locator('h1');
      const start = await slideInnerDragStart(editor.frame);

      // Escape cancels: live inline styles are replaced from the master.
      await selectSlideInner(page, editor.frame);
      await expectNoDeckSave(page, async () => {
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(start.x + 100, start.y + 50, { steps: 4 });
        await expect
          .poll(async () => (await slideInnerGeometry(editor.frame)).position)
          .toBe('absolute');

        await page.keyboard.press('Escape');
        await expect
          .poll(async () => (await slideInnerGeometry(editor.frame)).position)
          .toBe('');
        await page.mouse.up();
      });
      await expect(outline).toHaveCount(0);
      await expect(heading).toHaveText('Untitled deck');
      await expect(page.getByTestId('save-status')).toHaveText('已同步');

      // pointercancel uses the same cancellation path.
      await selectSlideInner(page, editor.frame);
      await frameHandle.evaluate((iframe) => {
        const view = (
          iframe as unknown as {
            contentDocument: { defaultView: FrameDomWindow | null } | null;
          }
        ).contentDocument?.defaultView;
        if (!view) return;
        view.document.addEventListener(
          'pointerdown',
          (event) => {
            view.__pptPointerId = event.pointerId;
          },
          { once: true, capture: true }
        );
      });

      await expectNoDeckSave(page, async () => {
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        const pointerId = await frameHandle.evaluate((iframe) => {
          const view = (
            iframe as unknown as {
              contentDocument: { defaultView: FrameDomWindow | null } | null;
            }
          ).contentDocument?.defaultView;
          return view?.__pptPointerId ?? -1;
        });
        expect(pointerId).toBeGreaterThan(0);
        await page.mouse.move(start.x + 100, start.y + 50, { steps: 4 });
        await expect
          .poll(async () => (await slideInnerGeometry(editor.frame)).position)
          .toBe('absolute');

        await frameHandle.evaluate((iframe, id) => {
          const view = (
            iframe as unknown as {
              contentDocument: { defaultView: FrameDomWindow | null } | null;
            }
          ).contentDocument?.defaultView;
          if (!view) throw new Error('Frame view is unavailable.');
          view.document.dispatchEvent(
            new view.PointerEvent('pointercancel', {
              pointerId: id,
              bubbles: true
            })
          );
        }, pointerId);

        await expect
          .poll(async () => (await slideInnerGeometry(editor.frame)).position)
          .toBe('');
        await page.mouse.up();
      });
      await expect(outline).toHaveCount(0);
      await expect(page.getByTestId('save-status')).toHaveText('已同步');
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'arrow keys change slides when no object is selected',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      await expect(page.getByTestId('selection-outline')).toHaveCount(0);

      await page.keyboard.press('ArrowRight');
      await expect(editor.frame.locator('h1')).toHaveText('Untitled deck — 2');

      await page.keyboard.press('ArrowLeft');
      await expect(editor.frame.locator('h1')).toHaveText('Untitled deck');
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'thumbnail rail previews every slide in sandboxed frames and navigates',
  { tag: '@feature:slides' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      const thumbnails = page.getByTestId('thumbnail');
      await expect(thumbnails).toHaveCount(2);
      await expect(thumbnails.nth(0)).toHaveAttribute('data-slide-id', 's1');
      await expect(thumbnails.nth(1)).toHaveAttribute('data-slide-id', 's2');
      await expect(thumbnails.nth(0)).toHaveAttribute('aria-current', 'page');
      await expect(thumbnails.nth(1)).not.toHaveAttribute(
        'aria-current',
        'page'
      );

      const frames = thumbnails.locator('iframe');
      await expect(frames).toHaveCount(2);
      await expect(frames.nth(0)).toHaveAttribute(
        'sandbox',
        'allow-same-origin'
      );
      await expect(frames.nth(1)).toHaveAttribute(
        'sandbox',
        'allow-same-origin'
      );
      await expect(
        frames.nth(1).contentFrame().locator('h1')
      ).toHaveText('Untitled deck — 2');

      await thumbnails.nth(1).click();
      await expect(editor.frame.locator('h1')).toHaveText('Untitled deck — 2');
      await expect(thumbnails.nth(1)).toHaveAttribute('aria-current', 'page');
      await expect(thumbnails.nth(0)).not.toHaveAttribute(
        'aria-current',
        'page'
      );

      await expect(page.getByTestId('toolbar')).toBeVisible();
      await expect(page.getByTestId('play')).toBeEnabled();
      await expect(page.getByTestId('export-open')).toBeEnabled();
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'adding a slide inserts after the active slide and survives reload',
  { tag: '@feature:slides' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      const thumbnails = page.getByTestId('thumbnail');
      const initialIds = await slideIds(page);
      expect(initialIds).toEqual(['s1', 's2']);

      const save = waitForDeckSave(page);
      await page.getByTestId('add-slide').click();
      expect((await save).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      await expect(thumbnails).toHaveCount(3);
      const addedIds = await slideIds(page);
      expect(addedIds).toHaveLength(3);
      expect(addedIds[0]).toBe(initialIds[0]);
      expect(addedIds[2]).toBe(initialIds[1]);
      expect(addedIds[1]).not.toBe(initialIds[0]);
      await expect(thumbnails.nth(1)).toHaveAttribute(
        'aria-current',
        'page'
      );
      await expect(editor.frame.locator('h1')).toHaveText('新投影片');
      await expect.poll(() => slideTitles(page)).toEqual([
        'Untitled deck',
        '新投影片',
        'Untitled deck — 2'
      ]);
      await expect
        .poll(async () =>
          (await savedDocument(editor)).includes(
            `data-slide-id="${addedIds[1]}"`
          )
        )
        .toBe(true);

      await page.reload();
      const frame = page.frameLocator(FRAME_SELECTOR);
      await expect(frame.locator('h1')).toContainText('Untitled deck');
      await expect(page.getByTestId('save-status')).toHaveText('已同步');
      await expect(page.getByTestId('thumbnail')).toHaveCount(3);
      expect(await slideIds(page)).toEqual(addedIds);
      await expect.poll(() => slideTitles(page)).toEqual([
        'Untitled deck',
        '新投影片',
        'Untitled deck — 2'
      ]);
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'duplicating copies content under a new id and deleting removes it',
  { tag: '@feature:slides' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      const thumbnails = page.getByTestId('thumbnail');
      const initialIds = await slideIds(page);

      const duplicateSave = waitForDeckSave(page);
      await page.getByTestId('duplicate-slide').click();
      expect((await duplicateSave).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      await expect(thumbnails).toHaveCount(3);
      const duplicatedIds = await slideIds(page);
      expect(duplicatedIds).toHaveLength(3);
      expect(duplicatedIds[0]).toBe(initialIds[0]);
      expect(duplicatedIds[2]).toBe(initialIds[1]);
      expect(duplicatedIds[1]).not.toBe(initialIds[0]);
      await expect(thumbnails.nth(1)).toHaveAttribute(
        'aria-current',
        'page'
      );
      await expect(editor.frame.locator('h1')).toHaveText('Untitled deck');
      await expect.poll(() => slideTitles(page)).toEqual([
        'Untitled deck',
        'Untitled deck',
        'Untitled deck — 2'
      ]);
      await expect
        .poll(async () => {
          const html = await savedDocument(editor);
          return html.split(`data-slide-id="${duplicatedIds[1]}"`).length - 1;
        })
        .toBe(1);

      const deleteSave = waitForDeckSave(page);
      await page.getByTestId('delete-slide').click();
      expect((await deleteSave).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      await expect(thumbnails).toHaveCount(2);
      expect(await slideIds(page)).toEqual(initialIds);
      await expect
        .poll(async () =>
          (await savedDocument(editor)).includes(
            `data-slide-id="${duplicatedIds[1]}"`
          )
        )
        .toBe(false);
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'delete is disabled for the last remaining slide',
  { tag: '@feature:slides' },
  async ({ page }) => {
    const editor = await openSingleSlideDeck(page);
    try {
      await expect(page.getByTestId('thumbnail')).toHaveCount(1);
      await expect(page.getByTestId('delete-slide')).toBeDisabled();

      await page.getByTestId('view-sorter').click();
      await expect(page.getByTestId('sorter-slide')).toHaveCount(1);
      await expect(page.getByTestId('sorter-delete')).toBeDisabled();
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'sorter tiles select slides and duplicate or delete from their own actions',
  { tag: '@feature:slides' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      const initialIds = await slideIds(page);
      await page.getByTestId('view-sorter').click();
      const tiles = page.getByTestId('sorter-slide');
      await expect(tiles).toHaveCount(2);
      await expect(tiles.nth(0)).toHaveAttribute('aria-current', 'page');

      await tiles.nth(1).click();
      await expect(tiles.nth(1)).toHaveAttribute('aria-current', 'page');
      await expect(tiles.nth(0)).not.toHaveAttribute('aria-current', 'page');

      const duplicateSave = waitForDeckSave(page);
      await page.getByTestId('sorter-duplicate').nth(1).click();
      expect((await duplicateSave).ok()).toBeTruthy();
      await expect(tiles).toHaveCount(3);
      const duplicatedIds = await sorterSlideIds(page);
      expect(duplicatedIds[0]).toBe(initialIds[0]);
      expect(duplicatedIds[1]).toBe(initialIds[1]);
      expect(duplicatedIds[2]).not.toBe(initialIds[1]);
      await expect(tiles.nth(2)).toHaveAttribute('aria-current', 'page');

      const deleteSave = waitForDeckSave(page);
      await page.getByTestId('sorter-delete').nth(2).click();
      expect((await deleteSave).ok()).toBeTruthy();
      await expect(tiles).toHaveCount(2);
      expect(await sorterSlideIds(page)).toEqual(initialIds);
      await expect(tiles.nth(1)).toHaveAttribute('aria-current', 'page');
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'sorter drag reorders slides and the order survives reload',
  { tag: '@feature:slides' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      const initialIds = await slideIds(page);
      await page.getByTestId('view-sorter').click();
      const tiles = page.getByTestId('sorter-slide');
      await expect(tiles).toHaveCount(2);
      await expect(page.getByTestId('sorter-view')).toBeVisible();
      await expect(page.getByTestId('canvas-preview')).toHaveCount(0);

      const save = waitForDeckSave(page);
      await dragSorterTile(page, 0, 1);
      expect((await save).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      const reorderedIds = [initialIds[1], initialIds[0]];
      expect(await sorterSlideIds(page)).toEqual(reorderedIds);
      await expect
        .poll(async () => savedSlideOrder(await savedDocument(editor)))
        .toEqual(reorderedIds);

      await page.reload();
      const frame = page.frameLocator(FRAME_SELECTOR);
      await expect(frame.locator('h1')).toHaveText('Untitled deck — 2');
      await expect(page.getByTestId('save-status')).toHaveText('已同步');
      expect(await slideIds(page)).toEqual(reorderedIds);
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'undo and redo restore add, delete, and reorder exactly',
  { tag: '@feature:slides' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      const thumbnails = page.getByTestId('thumbnail');
      const initialIds = await slideIds(page);
      const initialTitles = ['Untitled deck', 'Untitled deck — 2'];

      const addSave = waitForDeckSave(page);
      await page.getByTestId('add-slide').click();
      expect((await addSave).ok()).toBeTruthy();
      await expect(thumbnails).toHaveCount(3);
      const addedIds = await slideIds(page);
      const addedTitles = ['Untitled deck', '新投影片', 'Untitled deck — 2'];
      await expect.poll(() => slideTitles(page)).toEqual(addedTitles);

      // Undo restores the two original slides; redo restores the insertion.
      await page.getByTestId('undo').click();
      await expect(thumbnails).toHaveCount(2);
      await expect.poll(() => slideIds(page)).toEqual(initialIds);
      await expect.poll(() => slideTitles(page)).toEqual(initialTitles);

      await page.getByTestId('redo').click();
      await expect(thumbnails).toHaveCount(3);
      await expect.poll(() => slideIds(page)).toEqual(addedIds);
      await expect.poll(() => slideTitles(page)).toEqual(addedTitles);
      await expect(thumbnails.nth(1)).toHaveAttribute(
        'aria-current',
        'page'
      );

      const deleteSave = waitForDeckSave(page);
      await page.getByTestId('delete-slide').click();
      expect((await deleteSave).ok()).toBeTruthy();
      await expect(thumbnails).toHaveCount(2);
      await expect.poll(() => slideIds(page)).toEqual(initialIds);

      // Undo restores the deleted slide exactly; redo removes it again.
      await page.getByTestId('undo').click();
      await expect(thumbnails).toHaveCount(3);
      await expect.poll(() => slideIds(page)).toEqual(addedIds);
      await expect.poll(() => slideTitles(page)).toEqual(addedTitles);

      await page.getByTestId('redo').click();
      await expect(thumbnails).toHaveCount(2);
      await expect.poll(() => slideIds(page)).toEqual(initialIds);
      await expect.poll(() => slideTitles(page)).toEqual(initialTitles);

      // Reorder in the sorter.
      await page.getByTestId('view-sorter').click();
      const reorderedIds = [initialIds[1], initialIds[0]];
      const reorderSave = waitForDeckSave(page);
      await dragSorterTile(page, 0, 1);
      expect((await reorderSave).ok()).toBeTruthy();
      await expect.poll(() => sorterSlideIds(page)).toEqual(reorderedIds);

      await page.getByTestId('undo').click();
      await expect.poll(() => sorterSlideIds(page)).toEqual(initialIds);

      await page.getByTestId('redo').click();
      await expect.poll(() => sorterSlideIds(page)).toEqual(reorderedIds);
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'rapid double-click delete removes exactly one slide',
  { tag: '@feature:slides' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page, 3);
    try {
      const thumbnails = page.getByTestId('thumbnail');
      await expect(thumbnails).toHaveCount(3);

      const saveRequests: Request[] = [];
      const countSave = (request: Request) => {
        if (isDeckSaveRequest(request)) saveRequests.push(request);
      };
      page.on('request', countSave);
      try {
        const save = waitForDeckSave(page);
        await page.getByTestId('delete-slide').dblclick();
        expect((await save).ok()).toBeTruthy();
        await expect(page.getByTestId('save-status')).toHaveText('已儲存');

        await expect(thumbnails).toHaveCount(2);
        expect(await slideIds(page)).toEqual(['s2', 's3']);
        expect(saveRequests).toHaveLength(1);
      } finally {
        page.off('request', countSave);
      }
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'clicking the last thumbnail scrolls the rail to keep it in view',
  { tag: '@feature:slides' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page, 10);
    try {
      const thumbnails = page.getByTestId('thumbnail');
      await expect(thumbnails).toHaveCount(10);
      const last = thumbnails.last();
      const inRailView = () =>
        last.evaluate((element) => {
          const rail = element.closest('[data-testid="thumbnail-rail"]');
          if (!rail) return false;
          const tile = element.getBoundingClientRect();
          const bounds = rail.getBoundingClientRect();
          return tile.top >= bounds.top - 1 && tile.bottom <= bounds.bottom + 1;
        });

      // The rail starts at the top, so the tenth tile overflows below it.
      await expect.poll(inRailView).toBe(false);

      // Activate through the DOM: a Playwright click auto-scrolls the target
      // into view and would mask the rail's own scroll-into-view behaviour.
      await last
        .getByRole('button', { name: '第 10 頁：Untitled deck — 10' })
        .evaluate((button) =>
          (button as unknown as { click(): void }).click()
        );

      await expect(editor.frame.locator('h1')).toHaveText(
        'Untitled deck — 10'
      );
      await expect(last).toHaveAttribute('aria-current', 'page');
      await expect.poll(inRailView).toBe(true);
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'sorter drag handles backward and non-adjacent drops',
  { tag: '@feature:slides' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page, 4);
    try {
      await page.getByTestId('view-sorter').click();
      const tiles = page.getByTestId('sorter-slide');
      await expect(tiles).toHaveCount(4);
      expect(await sorterSlideIds(page)).toEqual(['s1', 's2', 's3', 's4']);

      const backwardSave = waitForDeckSave(page);
      await dragSorterTile(page, 3, 1);
      expect((await backwardSave).ok()).toBeTruthy();
      await expect
        .poll(() => sorterSlideIds(page))
        .toEqual(['s1', 's4', 's2', 's3']);

      const nonAdjacentSave = waitForDeckSave(page);
      await dragSorterTile(page, 0, 2);
      expect((await nonAdjacentSave).ok()).toBeTruthy();
      await expect
        .poll(() => sorterSlideIds(page))
        .toEqual(['s4', 's2', 's1', 's3']);
      await expect
        .poll(async () => savedSlideOrder(await savedDocument(editor)))
        .toEqual(['s4', 's2', 's1', 's3']);
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'inspector shows slide settings without a selection and geometry with one',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openNudgeDeck(page);
    try {
      const settings = page.getByTestId('slide-settings');
      await expect(settings).toBeVisible();
      await expect(page.getByTestId('transition-select')).toHaveValue('none');
      await expect(page.getByTestId('inspector-geometry')).toHaveCount(0);
      await expect(page.getByTestId('object-row')).toHaveCount(2);

      const boxRow = page.locator(
        '[data-testid="object-row"][data-object-id="box1"]'
      );
      await expect(boxRow).toHaveCount(1);
      await expect(boxRow).toContainText('div');
      await expect(boxRow).toContainText('Nudge me');
      const innerRow = page.locator(
        '[data-testid="object-row"][data-object-path="0"]'
      );
      await expect(innerRow).toContainText('div');
      await expect(innerRow).toContainText('htmlppt');
      await expect(innerRow).toContainText('Untitled deck');
      await boxRow.click();

      const outline = page.getByTestId('selection-outline');
      await expect(outline).toHaveAttribute('data-selected-id', 'box1');
      await expect(outline).toHaveAttribute('data-selected-path', '1');
      await expect(outline).not.toHaveAttribute('data-readonly', 'true');
      await expect(page.getByTestId('inspector-geometry')).toBeVisible();
      await expect(page.getByTestId('field-x')).toHaveValue('120');
      await expect(page.getByTestId('field-y')).toHaveValue('160');
      await expect(page.getByTestId('field-width')).toHaveValue('240');
      await expect(page.getByTestId('field-height')).toHaveValue('120');
      await expect(page.getByTestId('field-rotation')).toHaveValue('0');
      await expect(settings).toHaveCount(0);
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'editing X in the inspector moves the object and persists after reload',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openNudgeDeck(page);
    try {
      const object = editor.frame.locator('[data-ppt-el="box1"]');
      await page
        .locator('[data-testid="object-row"][data-object-id="box1"]')
        .click();
      const field = page.getByTestId('field-x');
      await expect(field).toHaveValue('120');

      const save = waitForDeckSave(page);
      await field.fill('200');
      await field.press('Enter');
      expect((await save).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      await expect
        .poll(async () => (await inlineGeometryOf(object)).left)
        .toBe(200);
      await expect(field).toHaveValue('200');
      await expect
        .poll(async () => {
          const saved = await savedNudgeBoxStyle(
            editor.directory,
            editor.file
          );
          return Number.parseFloat(saved.left ?? '');
        })
        .toBe(200);

      await page.reload();
      const frame = page.frameLocator(FRAME_SELECTOR);
      await expect(frame.locator('[data-ppt-el="box1"]')).toBeVisible();
      await expect(page.getByTestId('save-status')).toHaveText('已同步');
      expect(
        (await inlineGeometryOf(frame.locator('[data-ppt-el="box1"]'))).left
      ).toBe(200);

      await page
        .locator('[data-testid="object-row"][data-object-id="box1"]')
        .click();
      await expect(page.getByTestId('field-x')).toHaveValue('200');
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'inspector tabs switch and notes persist as a hidden aside',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openNudgeDeck(page);
    try {
      await page.getByTestId('inspector-tab-text').click();
      await expect(page.getByTestId('inspector-tab-text')).toHaveAttribute(
        'aria-selected',
        'true'
      );
      await expect(page.getByTestId('inspector-text-idle')).toBeVisible();

      await page.getByTestId('inspector-tab-notes').click();
      const notes = page.getByTestId('notes-input');
      await expect(notes).toBeVisible();

      const save = waitForDeckSave(page);
      await notes.fill('講者備註：先問候觀眾');
      await page.getByTestId('inspector-tab-design').click();
      expect((await save).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
      await expect
        .poll(async () => savedHas(editor, '[data-ppt-notes]'))
        .toBe(true);
      const savedWithNotes = await savedDocument(editor);
      expect(savedWithNotes).toMatch(
        /<aside[^>]*data-ppt-notes[^>]*>講者備註：先問候觀眾<\/aside>/
      );

      await page.getByTestId('inspector-tab-notes').click();
      await expect(notes).toHaveValue('講者備註：先問候觀眾');
      const removeSave = waitForDeckSave(page);
      await notes.fill('');
      await page.getByTestId('inspector-tab-design').click();
      expect((await removeSave).ok()).toBeTruthy();
      await expect
        .poll(async () => savedHas(editor, '[data-ppt-notes]'))
        .toBe(false);
      expect(await savedDocument(editor)).not.toMatch(
        /<aside[^>]*data-ppt-notes/
      );
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'slide transition selection is written and survives reload',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openNudgeDeck(page);
    try {
      const select = page.getByTestId('transition-select');
      await expect(select).toBeVisible();
      await expect(select).toHaveValue('none');

      // Choosing a transition only stages it; the deck changes on confirmation.
      await select.selectOption('fade');
      await expect(page.getByTestId('save-status')).toHaveText('已同步');
      expect(
        await savedHas(editor, '[data-ppt-transition="fade"]')
      ).toBe(false);

      const save = waitForDeckSave(page);
      await page.getByTestId('transition-apply').click();
      expect((await save).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
      await expect
        .poll(async () => savedHas(editor, '[data-ppt-transition="fade"]'))
        .toBe(true);

      await page.reload();
      await expect(page.getByTestId('save-status')).toHaveText('已同步');
      await expect(page.getByTestId('transition-select')).toHaveValue('fade');
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'transition preview and cancel never mutate the deck',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openNudgeDeck(page);
    try {
      const select = page.getByTestId('transition-select');
      await expect(select).toHaveValue('none');
      await expect(page.getByTestId('transition-preview')).toBeDisabled();

      const saveRequests: Request[] = [];
      const countSave = (request: Request) => {
        if (isDeckSaveRequest(request)) saveRequests.push(request);
      };
      page.on('request', countSave);
      try {
        await select.selectOption('slide');
        await expect(page.getByTestId('transition-preview')).toBeEnabled();
        await page.getByTestId('transition-preview').click();

        const overlay = page.getByTestId('transition-preview-overlay');
        await expect(overlay).toBeVisible();
        await expect(overlay).toHaveAttribute('data-transition', 'slide');
        await expect(overlay).toHaveCount(0, { timeout: 3_000 });

        await page.getByTestId('transition-cancel').click();
        await expect(select).toHaveValue('none');
        await expect(page.getByTestId('transition-preview')).toBeDisabled();
        expect(saveRequests).toHaveLength(0);
        expect(await savedHas(editor, '[data-ppt-transition]')).toBe(false);
      } finally {
        page.off('request', countSave);
      }

      await select.selectOption('fade');
      const save = waitForDeckSave(page);
      await page.getByTestId('transition-apply').click();
      expect((await save).ok()).toBeTruthy();
      await expect
        .poll(async () => savedHas(editor, '[data-ppt-transition="fade"]'))
        .toBe(true);
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'a no-op blur on fractional flow geometry neither pins nor saves',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openFractionalFlowDeck(page);
    try {
      const object = editor.frame.locator('[data-ppt-el="frac"]');
      await page
        .locator('[data-testid="object-row"][data-object-id="frac"]')
        .click();

      const outline = page.getByTestId('selection-outline');
      await expect(outline).toHaveAttribute('data-selected-id', 'frac');
      await expect(outline).toHaveAttribute('data-selected-path', '1');
      const fieldX = page.getByTestId('field-x');
      await expect(fieldX).toHaveValue('10.33');
      expect((await inlineGeometryOf(object)).position).toBe('');

      const saveRequests: Request[] = [];
      const countSave = (request: Request) => {
        if (isDeckSaveRequest(request)) saveRequests.push(request);
      };
      page.on('request', countSave);
      try {
        await expectNoDeckSave(page, async () => {
          await fieldX.focus();
          await page.getByTestId('field-y').focus();
        });

        const untouched = await inlineGeometryOf(object);
        expect(untouched.position).toBe('');
        expect(untouched.left).toBeNull();
        expect(untouched.top).toBeNull();

        // Undo with no recorded entry is a no-op; a stale commit would clear
        // the selection and restore the unpinned snapshot instead.
        await page.getByTestId('undo').click();
        await expect(outline).toBeVisible();
        expect(saveRequests).toHaveLength(0);
      } finally {
        page.off('request', countSave);
      }

      const commitRequests: Request[] = [];
      const countCommit = (request: Request) => {
        if (isDeckSaveRequest(request)) commitRequests.push(request);
      };
      page.on('request', countCommit);
      try {
        const save = waitForDeckSave(page);
        await fieldX.fill('50');
        await fieldX.press('Enter');
        expect((await save).ok()).toBeTruthy();
        await expect(page.getByTestId('save-status')).toHaveText('已儲存');

        const pinned = await inlineGeometryOf(object);
        expect(pinned.position).toBe('absolute');
        expect(pinned.left).toBeCloseTo(50, 2);
        expect(commitRequests).toHaveLength(1);
        await expect(fieldX).toHaveValue('50');
      } finally {
        page.off('request', countCommit);
      }
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'removing notes that shift sibling indices clears the object selection',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openNotesFirstDeck(page);
    try {
      const boxA = editor.frame.locator('[data-ppt-el="box-a"]');
      const boxB = editor.frame.locator('[data-ppt-el="box-b"]');
      await page
        .locator('[data-testid="object-row"][data-object-id="box-a"]')
        .click();

      const outline = page.getByTestId('selection-outline');
      await expect(outline).toHaveAttribute('data-selected-id', 'box-a');
      await expect(outline).toHaveAttribute('data-selected-path', '1');
      await expect(page.getByTestId('inspector-geometry')).toBeVisible();

      await page.getByTestId('inspector-tab-notes').click();
      const notes = page.getByTestId('notes-input');
      await expect(notes).toHaveValue('Legacy notes');
      const save = waitForDeckSave(page);
      await notes.fill('');
      await page.getByTestId('inspector-tab-design').click();
      expect((await save).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
      await expect
        .poll(async () => savedHas(editor, '[data-ppt-notes]'))
        .toBe(false);

      // The notes aside was the first child, so the old path 1 now resolves to
      // box-b. The selection must be dropped instead of remapped.
      await expect(page.getByTestId('selection-outline')).toHaveCount(0);
      await expect(page.getByTestId('inspector-geometry')).toHaveCount(0);
      await expect(page.getByTestId('slide-settings')).toBeVisible();

      // Leave the tablist so ArrowRight is handled by the canvas, not by the
      // inspector's roving tab navigation.
      await page.getByTestId('canvas-preview').click({ position: { x: 4, y: 4 } });
      await expectNoDeckSave(page, () => page.keyboard.press('ArrowRight'));
      await expect(editor.frame.locator('h1')).toHaveText('Untitled deck — 2');

      await page.getByTestId('thumbnail').nth(0).click();
      await expect(editor.frame.locator('h1')).toHaveText('Untitled deck');
      expect((await inlineGeometryOf(boxA)).left).toBe(120);
      expect((await inlineGeometryOf(boxB)).left).toBe(400);
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'slide background applies and clears from the inspector',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openSingleSlideDeck(page);
    try {
      const value = page.getByTestId('background-value');
      await expect(value).toHaveValue('');
      await value.fill('#112233');

      const save = waitForDeckSave(page);
      await page.getByTestId('apply-background').click();
      expect((await save).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
      await expect
        .poll(
          async () =>
            (await savedSlideStyle(editor.directory, editor.file)).background
        )
        .toBe('rgb(17, 34, 51)');

      const clear = page.getByTestId('clear-background');
      await expect(clear).toBeEnabled();
      const clearSave = waitForDeckSave(page);
      await clear.click();
      expect((await clearSave).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
      await expect
        .poll(
          async () =>
            (await savedSlideStyle(editor.directory, editor.file)).background
        )
        .toBeNull();
      const cleared = await savedSlideStyle(editor.directory, editor.file);
      expect(cleared['background-image']).toBeNull();
      expect(cleared['background-color']).toBeNull();
      await expect(value).toHaveValue('');

      // Each background form replaces the others instead of mixing.
      const kind = page.getByTestId('background-kind');
      await kind.selectOption('gradient');
      await value.fill('linear-gradient(90deg, #112233, #445566)');
      const gradientSave = waitForDeckSave(page);
      await page.getByTestId('apply-background').click();
      expect((await gradientSave).ok()).toBeTruthy();
      await expect
        .poll(
          async () =>
            (await savedSlideStyle(editor.directory, editor.file)).background
        )
        .toContain('linear-gradient');
      const gradient = await savedSlideStyle(editor.directory, editor.file);
      expect(gradient['background-image']).toBeNull();

      await kind.selectOption('image');
      await value.fill('https://example.com/bg.png');
      const imageSave = waitForDeckSave(page);
      await page.getByTestId('apply-background').click();
      expect((await imageSave).ok()).toBeTruthy();
      await expect
        .poll(
          async () =>
            (await savedSlideStyle(editor.directory, editor.file))[
              'background-image'
            ]
        )
        .toContain('example.com');
      const image = await savedSlideStyle(editor.directory, editor.file);
      expect(image.background).toBeNull();
      expect(image['background-image']).not.toContain('linear-gradient');

      const imageClearSave = waitForDeckSave(page);
      await clear.click();
      expect((await imageClearSave).ok()).toBeTruthy();
      await expect
        .poll(
          async () =>
            (await savedSlideStyle(editor.directory, editor.file))[
              'background-image'
            ]
        )
        .toBeNull();
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'rejected background values neither save nor record history',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openNudgeDeck(page);
    try {
      const value = page.getByTestId('background-value');
      const saveRequests: Request[] = [];
      const countSave = (request: Request) => {
        if (isDeckSaveRequest(request)) saveRequests.push(request);
      };
      page.on('request', countSave);
      try {
        await value.fill('not-a-color');
        await expectNoDeckSave(page, () =>
          page.getByTestId('apply-background').click()
        );
        await expect(page.getByTestId('background-error')).toBeVisible();
        expect(saveRequests).toHaveLength(0);
        // A rejected value must not touch the deck or flip the save state.
        await expect(page.getByTestId('save-status')).toHaveText('已同步');
        expect(
          (await savedSlideStyle(editor.directory, editor.file)).background
        ).toBeNull();

        // Editing the value clears the stale alert so the correction can be
        // applied without a lingering error.
        await value.fill('#112233');
        await expect(page.getByTestId('background-error')).toHaveCount(0);
        await value.press('Escape');
        await expect(value).toHaveValue('');

        // With no history entry from the rejected edit, Undo is a no-op and
        // must not restore a snapshot that drops the unrelated selection.
        await page
          .locator('[data-testid="object-row"][data-object-id="box1"]')
          .click();
        const outline = page.getByTestId('selection-outline');
        await expect(outline).toBeVisible();
        await expectNoDeckSave(page, () => page.getByTestId('undo').click());
        await expect(outline).toBeVisible();
        expect(saveRequests).toHaveLength(0);
      } finally {
        page.off('request', countSave);
      }
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'inspector tabs support roving arrow-key navigation',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openNudgeDeck(page);
    try {
      const design = page.getByTestId('inspector-tab-design');
      const text = page.getByTestId('inspector-tab-text');
      const notes = page.getByTestId('inspector-tab-notes');

      await design.focus();
      await expect(design).toHaveAttribute('tabindex', '0');
      await expect(text).toHaveAttribute('tabindex', '-1');
      await expect(notes).toHaveAttribute('tabindex', '-1');

      await page.keyboard.press('ArrowRight');
      await expect(text).toBeFocused();
      await expect(text).toHaveAttribute('aria-selected', 'true');
      await expect(design).toHaveAttribute('aria-selected', 'false');
      await expect(text).toHaveAttribute('tabindex', '0');
      await expect(design).toHaveAttribute('tabindex', '-1');
      await expect(page.getByTestId('inspector-text-idle')).toBeVisible();

      await page.keyboard.press('End');
      await expect(notes).toBeFocused();
      await expect(notes).toHaveAttribute('aria-selected', 'true');

      await page.keyboard.press('ArrowRight');
      await expect(design).toBeFocused();
      await expect(design).toHaveAttribute('aria-selected', 'true');

      await page.keyboard.press('ArrowLeft');
      await expect(notes).toBeFocused();
      await expect(notes).toHaveAttribute('aria-selected', 'true');

      await page.keyboard.press('Home');
      await expect(design).toBeFocused();
      await expect(design).toHaveAttribute('aria-selected', 'true');

      // Clicking still selects a tab outside the keyboard path.
      await text.click();
      await expect(text).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('inspector-text-idle')).toBeVisible();
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'keyboard undo and redo restore text edits and transforms',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      const heading = editor.frame.locator('h1');
      await heading.dblclick();
      await expect(heading).toHaveAttribute('contenteditable', 'true');
      await page.keyboard.press('Control+a');
      await page.keyboard.type('Changed heading');

      const textSave = waitForDeckSave(page);
      await page.getByTestId('canvas-preview').click({ position: { x: 4, y: 4 } });
      expect((await textSave).ok()).toBeTruthy();
      await expect(editor.frame.locator('h1')).toHaveText('Changed heading');

      // A second click keeps focus in the editor document before shortcuts.
      await page.getByTestId('canvas-preview').click({ position: { x: 4, y: 4 } });
      const undoTextSave = waitForDeckSave(page);
      await page.keyboard.press('Control+z');
      expect((await undoTextSave).ok()).toBeTruthy();
      await expect(editor.frame.locator('h1')).toHaveText('Untitled deck');

      const redoTextSave = waitForDeckSave(page);
      await page.keyboard.press('Control+Shift+z');
      expect((await redoTextSave).ok()).toBeTruthy();
      await expect(editor.frame.locator('h1')).toHaveText('Changed heading');

      const start = await slideInnerDragStart(editor.frame);

      const dragSave = waitForDeckSave(page);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x + 100, start.y + 50, { steps: 5 });
      await page.mouse.up();
      expect((await dragSave).ok()).toBeTruthy();
      await expect
        .poll(async () => (await slideInnerGeometry(editor.frame)).position)
        .toBe('absolute');
      const moved = await slideInnerGeometry(editor.frame);
      expect(moved.left!).toBeGreaterThan(0);
      expect(moved.top!).toBeGreaterThan(0);

      const undoDragSave = waitForDeckSave(page);
      await page.keyboard.press('Control+z');
      expect((await undoDragSave).ok()).toBeTruthy();
      await expect
        .poll(async () => (await slideInnerGeometry(editor.frame)).position)
        .toBe('');
      await expect(editor.frame.locator('h1')).toHaveText('Changed heading');
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'one Ctrl+Z after a drag restores the original position',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openNudgeDeck(page);
    try {
      const object = editor.frame.locator('[data-ppt-el="box1"]');
      await object.click();
      await expect(page.getByTestId('selection-outline')).toHaveAttribute(
        'data-selected-id',
        'box1'
      );
      const box = await object.boundingBox();
      if (!box) throw new Error('Nudge object has no bounding box.');
      const startX = box.x + box.width / 2;
      const startY = box.y + box.height / 2;
      const before = await inlineGeometryOf(object);
      expect(before.left).toBe(120);
      expect(before.top).toBe(160);

      const dragSave = waitForDeckSave(page);
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      // Alt disables snapping so the assertion is about the gesture offset.
      await page.keyboard.down('Alt');
      await page.mouse.move(startX + 100, startY + 50, { steps: 5 });
      await page.mouse.up();
      await page.keyboard.up('Alt');
      expect((await dragSave).ok()).toBeTruthy();
      const moved = await inlineGeometryOf(object);
      expect(moved.left).toBeGreaterThan(before.left!);
      expect(moved.top).toBeGreaterThan(before.top!);

      const undoSave = waitForDeckSave(page);
      await page.keyboard.press('Control+z');
      expect((await undoSave).ok()).toBeTruthy();
      await expect.poll(async () => (await inlineGeometryOf(object)).left).toBe(
        before.left
      );
      await expect.poll(async () => (await inlineGeometryOf(object)).top).toBe(
        before.top
      );
      const undone = await inlineGeometryOf(object);
      expect(undone.position).toBe('absolute');
      // A single undo was enough: no second entry holds a mid-gesture state.
      await expectNoDeckSave(page, () => page.keyboard.press('Control+z'));
      expect((await inlineGeometryOf(object)).left).toBe(before.left);
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'copy and paste duplicates an object with fresh ids and survives reload',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openNudgeDeck(page);
    try {
      const copies = editor.frame
        .locator('[data-ppt-el]')
        .filter({ hasText: 'Nudge me' });
      await editor.frame.locator('[data-ppt-el="box1"]').click();
      await expect(page.getByTestId('selection-outline')).toHaveAttribute(
        'data-selected-id',
        'box1'
      );

      await page.keyboard.press('Control+c');
      const pasteSave = waitForDeckSave(page);
      await page.keyboard.press('Control+v');
      expect((await pasteSave).ok()).toBeTruthy();
      await expect(copies).toHaveCount(2);

      const pasted = copies.nth(1);
      const pastedId = await pasted.getAttribute('data-ppt-el');
      expect(pastedId).not.toBe('box1');
      expect(pastedId).not.toBeNull();
      const geometry = await inlineGeometryOf(pasted);
      expect(geometry.position).toBe('absolute');
      expect(geometry.left).toBe(140);
      expect(geometry.top).toBe(180);
      await expect(pasted).toHaveText('Nudge me');
      await expect
        .poll(async () => (await savedDocument(editor)).split('Nudge me').length - 1)
        .toBe(2);

      await page.reload();
      const frame = page.frameLocator(FRAME_SELECTOR);
      await expect(page.getByTestId('save-status')).toHaveText('已同步');
      const reloadedCopies = frame
        .locator('[data-ppt-el]')
        .filter({ hasText: 'Nudge me' });
      await expect(reloadedCopies).toHaveCount(2);
      expect(await reloadedCopies.nth(0).getAttribute('data-ppt-el')).toBe(
        'box1'
      );
      expect(await reloadedCopies.nth(1).getAttribute('data-ppt-el')).toBe(
        pastedId
      );
      const reloadedGeometry = await inlineGeometryOf(reloadedCopies.nth(1));
      expect(reloadedGeometry.left).toBe(140);
      expect(reloadedGeometry.top).toBe(180);
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'Shift multi-select toggles and Delete removes every selected object',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openTwoBoxDeck(page);
    try {
      await editor.frame.locator('[data-ppt-el="box-a"]').click();
      await editor.frame
        .locator('[data-ppt-el="box-b"]')
        .click({ modifiers: ['Shift'] });

      const outlines = page.getByTestId('selection-outline');
      await expect(outlines).toHaveCount(2);
      await expect(page.locator('[data-testid^="handle-"]')).toHaveCount(0);
      await expect(page.getByTestId('rotate-handle')).toHaveCount(0);
      expect(
        await outlines.evaluateAll((elements) =>
          elements.map((element) =>
            element.getAttribute('data-selected-id')
          )
        )
      ).toEqual(['box-a', 'box-b']);

      const boxA = editor.frame.locator('[data-ppt-el="box-a"]');
      const boxB = editor.frame.locator('[data-ppt-el="box-b"]');
      const nudgeSave = waitForDeckSave(page);
      await page.keyboard.press('ArrowRight');
      expect((await nudgeSave).ok()).toBeTruthy();
      await expect.poll(async () => (await inlineGeometryOf(boxA)).left).toBe(
        121
      );
      await expect.poll(async () => (await inlineGeometryOf(boxB)).left).toBe(
        401
      );
      await expect(outlines).toHaveCount(2);

      // One undo reverts both nudged objects and clears the selection.
      const undoNudgeSave = waitForDeckSave(page);
      await page.keyboard.press('Control+z');
      expect((await undoNudgeSave).ok()).toBeTruthy();
      await expect.poll(async () => (await inlineGeometryOf(boxA)).left).toBe(
        120
      );
      await expect.poll(async () => (await inlineGeometryOf(boxB)).left).toBe(
        400
      );
      await expect(outlines).toHaveCount(0);

      await boxA.click();
      await boxB.click({ modifiers: ['Shift'] });
      await expect(outlines).toHaveCount(2);

      const deleteSave = waitForDeckSave(page);
      await page.keyboard.press('Delete');
      expect((await deleteSave).ok()).toBeTruthy();
      await expect(
        editor.frame.locator('[data-ppt-el="box-a"]')
      ).toHaveCount(0);
      await expect(
        editor.frame.locator('[data-ppt-el="box-b"]')
      ).toHaveCount(0);
      await expect
        .poll(async () => (await savedDocument(editor)).includes('box-a'))
        .toBe(false);

      const undoDeleteSave = waitForDeckSave(page);
      await page.keyboard.press('Control+z');
      expect((await undoDeleteSave).ok()).toBeTruthy();
      await expect(
        editor.frame.locator('[data-ppt-el="box-a"]')
      ).toBeVisible();
      await expect(
        editor.frame.locator('[data-ppt-el="box-b"]')
      ).toBeVisible();
      await expect
        .poll(async () => {
          const html = await savedDocument(editor);
          return html.includes('box-a') && html.includes('box-b');
        })
        .toBe(true);
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'keyboard undo restores the pre-add active slide and redo restores the add',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      const thumbnails = page.getByTestId('thumbnail');
      await expect(thumbnails).toHaveCount(2);
      await expect(thumbnails.nth(0)).toHaveAttribute('aria-current', 'page');

      const addSave = waitForDeckSave(page);
      await page.getByTestId('add-slide').click();
      expect((await addSave).ok()).toBeTruthy();
      await expect(thumbnails).toHaveCount(3);
      await expect(thumbnails.nth(1)).toHaveAttribute('aria-current', 'page');

      const undoAddSave = waitForDeckSave(page);
      await page.keyboard.press('Control+z');
      expect((await undoAddSave).ok()).toBeTruthy();
      await expect(thumbnails).toHaveCount(2);
      await expect(thumbnails.nth(0)).toHaveAttribute('aria-current', 'page');
      await expect(editor.frame.locator('h1')).toHaveText('Untitled deck');

      const redoAddSave = waitForDeckSave(page);
      await page.keyboard.press('Control+Shift+z');
      expect((await redoAddSave).ok()).toBeTruthy();
      await expect(thumbnails).toHaveCount(3);
      await expect(thumbnails.nth(1)).toHaveAttribute('aria-current', 'page');
      await expect(editor.frame.locator('h1')).toHaveText('新投影片');
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'shortcuts are ignored while inspector form fields have focus',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openNudgeDeck(page);
    try {
      const object = editor.frame.locator('[data-ppt-el="box1"]');
      await page
        .locator('[data-testid="object-row"][data-object-id="box1"]')
        .click();
      const fieldX = page.getByTestId('field-x');
      await expect(fieldX).toHaveValue('120');
      await fieldX.focus();

      const saveRequests: Request[] = [];
      const countSave = (request: Request) => {
        if (isDeckSaveRequest(request)) saveRequests.push(request);
      };
      page.on('request', countSave);
      try {
        await expectNoDeckSave(page, () => page.keyboard.press('Delete'));
        await expectNoDeckSave(page, () => page.keyboard.press('Control+z'));
        await expectNoDeckSave(page, () => page.keyboard.press('ArrowRight'));
        expect(saveRequests).toHaveLength(0);
        expect((await inlineGeometryOf(object)).left).toBe(120);
        await expect(fieldX).toBeVisible();
        await expect(
          page.locator('[data-testid="object-row"][data-object-id="box1"]')
        ).toHaveCount(1);
      } finally {
        page.off('request', countSave);
      }
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'F5 enters a chrome-free play mode at slide 1 and Escape returns to the active slide',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page, 3);
    try {
      await page.getByTestId('thumbnail').nth(1).click();
      await expect(editor.frame.locator('h1')).toHaveText('Untitled deck — 2');

      const saveRequests: Request[] = [];
      const countSave = (request: Request) => {
        if (isDeckSaveRequest(request)) saveRequests.push(request);
      };
      page.on('request', countSave);
      try {
        await page.keyboard.press('F5');
        const playView = page.getByTestId('play-view');
        const play = playFrameFor(page);
        await expect(playView).toBeVisible();
        await expect(play.locator('h1')).toHaveText('Untitled deck');
        await expect(play.locator('section')).toHaveCount(1);
        await expect(play.locator('[data-ppt-frame-slide]')).toHaveCount(0);
        await expect(play.locator('[data-testid]')).toHaveCount(0);
        await expect(
          play.locator('[data-ppt-editing], [contenteditable]')
        ).toHaveCount(0);

        // Play hides every editor region, overlay, and handle.
        await expect(page.getByTestId('toolbar')).toHaveCount(0);
        await expect(page.getByTestId('thumbnail-rail')).toHaveCount(0);
        await expect(page.getByTestId('inspector')).toHaveCount(0);
        await expect(page.getByTestId('canvas-preview')).toHaveCount(0);
        await expect(page.getByTestId('canvas-overlay')).toHaveCount(0);
        await expect(page.getByTestId('selection-outline')).toHaveCount(0);
        await expect(page.locator(FRAME_SELECTOR)).toHaveCount(0);

        const playFrame = page.getByTestId('play-frame');
        await expect(playFrame).toHaveAttribute('sandbox', 'allow-same-origin');
        await expect(playFrame).toHaveAttribute('title', '播放投影片');

        // The play shell fills the viewport and the slide is letterboxed to it.
        const viewport = page.viewportSize();
        if (!viewport) throw new Error('Playwright viewport is unavailable.');
        const playScale = Math.min(
          viewport.width / CANVAS_WIDTH,
          viewport.height / 900
        );
        const viewBox = await playView.boundingBox();
        const frameBox = await playFrame.boundingBox();
        if (!viewBox || !frameBox) {
          throw new Error('Play geometry is unavailable.');
        }
        expect(viewBox.x).toBe(0);
        expect(viewBox.y).toBe(0);
        expect(viewBox.width).toBeCloseTo(viewport.width, 0);
        expect(viewBox.height).toBeCloseTo(viewport.height, 0);
        expect(frameBox.width).toBeCloseTo(CANVAS_WIDTH * playScale, 0);
        expect(frameBox.height).toBeCloseTo(900 * playScale, 0);
        expect(frameBox.x).toBeCloseTo(
          (viewport.width - CANVAS_WIDTH * playScale) / 2,
          0
        );

        await page.keyboard.press('ArrowRight');
        await expect(play.locator('h1')).toHaveText('Untitled deck — 2');
        await page.keyboard.press('Space');
        await expect(play.locator('h1')).toHaveText('Untitled deck — 3');
        await page.keyboard.press('PageDown');
        await expect(play.locator('h1')).toHaveText('Untitled deck — 3');
        await page.keyboard.press('PageUp');
        await expect(play.locator('h1')).toHaveText('Untitled deck — 2');
        await page.keyboard.press('ArrowLeft');
        await expect(play.locator('h1')).toHaveText('Untitled deck');
        await page.keyboard.press('End');
        await expect(play.locator('h1')).toHaveText('Untitled deck — 3');
        await page.keyboard.press('Home');
        await expect(play.locator('h1')).toHaveText('Untitled deck');

        // Modifier chords never navigate while presenting.
        await page.keyboard.press('Shift+ArrowRight');
        await page.keyboard.press('Control+ArrowRight');
        await expect(play.locator('h1')).toHaveText('Untitled deck');

        // Keys work while the deck iframe owns focus. Focus without a click,
        // because a noninteractive click now advances the presentation.
        await play.locator('body').evaluate((body) => {
          body.tabIndex = 0;
          body.focus();
        });
        await expect(play.locator('body')).toBeFocused();
        await page.keyboard.press('ArrowRight');
        await expect(play.locator('h1')).toHaveText('Untitled deck — 2');

        await page.keyboard.press('Escape');
        await expect(page.getByTestId('play-view')).toHaveCount(0);
        await expect(page.getByTestId('toolbar')).toBeVisible();
        await expect(page.getByTestId('thumbnail').nth(1)).toHaveAttribute(
          'aria-current',
          'page'
        );
        await expect(editor.frame.locator('h1')).toHaveText(
          'Untitled deck — 2'
        );

        // Shift+F5 starts at the active slide; F5 always restarts at slide 1.
        await page.keyboard.press('Shift+F5');
        await expect(page.getByTestId('play-view')).toBeVisible();
        await expect(playFrameFor(page).locator('h1')).toHaveText(
          'Untitled deck — 2'
        );
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('toolbar')).toBeVisible();

        await page.keyboard.press('F5');
        await expect(page.getByTestId('play-view')).toBeVisible();
        await expect(playFrameFor(page).locator('h1')).toHaveText(
          'Untitled deck'
        );
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('toolbar')).toBeVisible();

        // The toolbar Play button routes to the same play-from-first action.
        await page.getByTestId('play').click();
        await expect(page.getByTestId('play-view')).toBeVisible();
        await expect(playFrameFor(page).locator('h1')).toHaveText(
          'Untitled deck'
        );
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('toolbar')).toBeVisible();

        // Presenting never writes the deck.
        expect(saveRequests).toHaveLength(0);
        const saved = parseDeckHtml(await savedDocument(editor));
        expect(saved.querySelector('[data-testid]')).toBeNull();
        expect(saved.querySelector('[contenteditable]')).toBeNull();
        expect(saved.querySelector('[data-ppt-frame-slide]')).toBeNull();
      } finally {
        page.off('request', countSave);
      }
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'paste selection applies before a slow save and is not retargeted by a slide switch',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    let held: HeldDeckSave | null = null;
    try {
      await selectSlideInner(page, editor.frame);

      held = await holdNextDeckSave(page);
      await page.keyboard.press('Control+d');
      await held.request;

      // Switch slides while the duplicate save is still pending.
      await page.getByTestId('thumbnail').nth(1).click();
      await expect(editor.frame.locator('h1')).toHaveText(
        'Untitled deck — 2'
      );

      held.release();
      expect((await held.response).ok()).toBe(true);
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
      await expect(page.getByTestId('selection-outline')).toHaveCount(0);

      // A leaked slide-1 selection would consume the nudge branch and leave
      // the active slide unchanged.
      await page.keyboard.press('ArrowLeft');
      await expect(page.getByTestId('thumbnail').nth(0)).toHaveAttribute(
        'aria-current',
        'page'
      );
      await expect(editor.frame.locator('h1').first()).toHaveText(
        'Untitled deck'
      );
    } finally {
      held?.release();
      await page.unroute('**/api/deck');
      await closeEditor(editor);
    }
  }
);

test(
  'delete clears its selection before a slow save and keeps a newer selection',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    let held: HeldDeckSave | null = null;
    try {
      await selectSlideInner(page, editor.frame);

      held = await holdNextDeckSave(page);
      await page.keyboard.press('Delete');
      await held.request;

      await page.getByTestId('thumbnail').nth(1).click();
      await expect(editor.frame.locator('h1')).toHaveText(
        'Untitled deck — 2'
      );
      await selectSlideInner(page, editor.frame);

      held.release();
      expect((await held.response).ok()).toBe(true);
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      // The slow delete must not clear the selection made after it ran.
      await expect(page.getByTestId('selection-outline')).toHaveCount(1);
      await expect(page.getByTestId('selection-outline')).toHaveAttribute(
        'data-selected-path',
        '0'
      );
      await expect(page.getByTestId('inspector-geometry')).toBeVisible();
    } finally {
      held?.release();
      await page.unroute('**/api/deck');
      await closeEditor(editor);
    }
  }
);

test(
  'dragging a multi-selection moves every object by one delta and one undo restores them',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openTwoBoxDeck(page);
    try {
      const boxA = editor.frame.locator('[data-ppt-el="box-a"]');
      const boxB = editor.frame.locator('[data-ppt-el="box-b"]');
      await boxA.click();
      await boxB.click({ modifiers: ['Shift'] });
      await expect(page.getByTestId('selection-outline')).toHaveCount(2);

      const beforeA = await inlineGeometryOf(boxA);
      const beforeB = await inlineGeometryOf(boxB);
      const scale = await frameScale(page);
      const start = await boxA.boundingBox();
      if (!start) throw new Error('Multi-drag object has no bounding box.');

      const saveRequests: Request[] = [];
      const countSave = (request: Request) => {
        if (isDeckSaveRequest(request)) saveRequests.push(request);
      };
      page.on('request', countSave);
      try {
        const save = waitForDeckSave(page);
        await page.mouse.move(
          start.x + start.width / 2,
          start.y + start.height / 2
        );
        await page.mouse.down();
        await page.keyboard.down('Alt');
        await page.mouse.move(
          start.x + start.width / 2 + 100,
          start.y + start.height / 2 + 50,
          { steps: 5 }
        );
        await page.mouse.up();
        await page.keyboard.up('Alt');
        expect((await save).ok()).toBe(true);
        await expect(page.getByTestId('save-status')).toHaveText('已儲存');
        expect(saveRequests).toHaveLength(1);

        const movedA = await inlineGeometryOf(boxA);
        const movedB = await inlineGeometryOf(boxB);
        const deltaAX = movedA.left! - beforeA.left!;
        const deltaBX = movedB.left! - beforeB.left!;
        const deltaATop = movedA.top! - beforeA.top!;
        const deltaBTop = movedB.top! - beforeB.top!;
        expect(deltaAX).toBeCloseTo(100 / scale, 0);
        expect(deltaBX).toBeCloseTo(deltaAX, 5);
        expect(deltaATop).toBeCloseTo(50 / scale, 0);
        expect(deltaBTop).toBeCloseTo(deltaATop, 5);

        // One undo restores both objects.
        const undo = waitForDeckSave(page);
        await page.keyboard.press('Control+z');
        expect((await undo).ok()).toBe(true);
        await expect(page.getByTestId('save-status')).toHaveText('已儲存');
        await expect.poll(async () => (await inlineGeometryOf(boxA)).left).toBe(
          beforeA.left
        );
        await expect.poll(async () => (await inlineGeometryOf(boxB)).left).toBe(
          beforeB.left
        );
        expect((await inlineGeometryOf(boxA)).top).toBe(beforeA.top);
        expect((await inlineGeometryOf(boxB)).top).toBe(beforeB.top);
        expect(saveRequests).toHaveLength(2);

        // A second undo has no entry to restore and issues no save.
        await expectNoDeckSave(page, () =>
          page.keyboard.press('Control+z')
        );
        expect((await inlineGeometryOf(boxA)).left).toBe(beforeA.left);
      } finally {
        page.off('request', countSave);
      }
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'Ctrl+A selects every top-level object on the active slide',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openTwoBoxDeck(page);
    try {
      await page
        .getByTestId('canvas-preview')
        .click({ position: { x: 4, y: 4 } });
      await page.keyboard.press('Control+a');

      const outlines = page.getByTestId('selection-outline');
      await expect(outlines).toHaveCount(3);
      const ids = await outlines.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-selected-id'))
      );
      expect(ids).toHaveLength(3);
      expect(ids.slice(1)).toEqual(['box-a', 'box-b']);
      expect(ids[0]).not.toBeNull();
      expect(
        await outlines.evaluateAll((elements) =>
          elements.map(
            (element) =>
              element.getAttribute('data-readonly') === 'true'
          )
        )
      ).toEqual([true, true, true]);
      await expect(page.locator('[data-testid^="handle-"]')).toHaveCount(0);
      await expect(page.getByTestId('rotate-handle')).toHaveCount(0);
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'Ctrl+D duplicates the selection with a fresh id and one undo removes it',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openNudgeDeck(page);
    try {
      const copies = editor.frame
        .locator('[data-ppt-el]')
        .filter({ hasText: 'Nudge me' });
      await editor.frame.locator('[data-ppt-el="box1"]').click();
      await expect(page.getByTestId('selection-outline')).toHaveAttribute(
        'data-selected-id',
        'box1'
      );

      const save = waitForDeckSave(page);
      await page.keyboard.press('Control+d');
      expect((await save).ok()).toBe(true);
      await expect(copies).toHaveCount(2);

      const pasted = copies.nth(1);
      const pastedId = await pasted.getAttribute('data-ppt-el');
      expect(pastedId).not.toBe('box1');
      expect(pastedId).not.toBeNull();
      expect(await inlineGeometryOf(pasted)).toMatchObject({
        position: 'absolute',
        left: 140,
        top: 180
      });
      await expect(page.getByTestId('selection-outline')).toHaveAttribute(
        'data-selected-id',
        pastedId ?? ''
      );

      const undo = waitForDeckSave(page);
      await page.keyboard.press('Control+z');
      expect((await undo).ok()).toBe(true);
      await expect(copies).toHaveCount(1);
      expect(
        await inlineGeometryOf(
          editor.frame.locator('[data-ppt-el="box1"]')
        )
      ).toMatchObject({ left: 120, top: 160 });
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'Ctrl+S saves the deck and an M4-only export shortcut does not',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openNudgeDeck(page);
    try {
      const saveRequests: Request[] = [];
      const countSave = (request: Request) => {
        if (isDeckSaveRequest(request)) saveRequests.push(request);
      };
      page.on('request', countSave);
      try {
        await expectNoDeckSave(page, () =>
          page.keyboard.press('Control+Shift+E')
        );
        await expect(page.getByTestId('save-status')).toHaveText('已同步');
        expect(
          (
            await inlineGeometryOf(
              editor.frame.locator('[data-ppt-el="box1"]')
            )
          ).left
        ).toBe(120);

        const save = waitForDeckSave(page);
        await page.keyboard.press('Control+s');
        expect((await save).ok()).toBe(true);
        await expect(page.getByTestId('save-status')).toHaveText('已儲存');
        expect(saveRequests).toHaveLength(1);
      } finally {
        page.off('request', countSave);
      }
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'Backspace without a selection is inert and with one deletes the object',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openNudgeDeck(page);
    try {
      const url = page.url();
      await expectNoDeckSave(page, () =>
        page.keyboard.press('Backspace')
      );
      expect(page.url()).toBe(url);
      await expect(page.getByTestId('save-status')).toHaveText('已同步');
      expect(
        (
          await inlineGeometryOf(
            editor.frame.locator('[data-ppt-el="box1"]')
          )
        ).left
      ).toBe(120);
      await expect(editor.frame.locator('h1')).toHaveText(
        'Untitled deck'
      );

      await editor.frame.locator('[data-ppt-el="box1"]').click();
      const save = waitForDeckSave(page);
      await page.keyboard.press('Backspace');
      expect((await save).ok()).toBe(true);
      await expect(
        editor.frame.locator('[data-ppt-el="box1"]')
      ).toHaveCount(0);

      const undo = waitForDeckSave(page);
      await page.keyboard.press('Control+z');
      expect((await undo).ok()).toBe(true);
      await expect(
        editor.frame.locator('[data-ppt-el="box1"]')
      ).toBeVisible();
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'zoom in, out, and fit survive commits until reset explicitly',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openNudgeDeck(page);
    try {
      const initial = await frameScale(page);
      expect(initial).toBeGreaterThan(0);

      await page.keyboard.press('Control+=');
      await expect
        .poll(async () =>
          Math.round(((await frameScale(page)) / initial) * 100)
        )
        .toBe(120);

      await editor.frame.locator('[data-ppt-el="box1"]').click();
      const zoomedSave = waitForDeckSave(page);
      await page.keyboard.press('ArrowRight');
      expect((await zoomedSave).ok()).toBe(true);
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
      expect(
        Math.round(((await frameScale(page)) / initial) * 100)
      ).toBe(120);

      await page.keyboard.press('Control+-');
      await expect
        .poll(async () =>
          Math.round(((await frameScale(page)) / initial) * 100)
        )
        .toBe(100);

      const outSave = waitForDeckSave(page);
      await page.keyboard.press('ArrowRight');
      expect((await outSave).ok()).toBe(true);
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
      expect(
        Math.round(((await frameScale(page)) / initial) * 100)
      ).toBe(100);

      await page.keyboard.press('Control+=');
      await expect
        .poll(async () =>
          Math.round(((await frameScale(page)) / initial) * 100)
        )
        .toBe(120);
      await page.keyboard.press('Control+0');
      await expect
        .poll(async () =>
          Math.round(((await frameScale(page)) / initial) * 100)
        )
        .toBe(100);

      const fitSave = waitForDeckSave(page);
      await page.keyboard.press('ArrowRight');
      expect((await fitSave).ok()).toBe(true);
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
      expect(
        Math.round(((await frameScale(page)) / initial) * 100)
      ).toBe(100);
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'a stale selection rejects a geometry edit without history or a save',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openNudgeDeck(page);
    try {
      await page
        .locator('[data-testid="object-row"][data-object-id="box1"]')
        .click();
      const fieldX = page.getByTestId('field-x');
      await expect(fieldX).toHaveValue('120');

      // Simulate a stale live frame: the master still holds the object, but
      // the selection path no longer resolves in the rendered slide.
      await editor.frame
        .locator('[data-ppt-el="box1"]')
        .evaluate((element) => element.remove());

      await expectNoDeckSave(
        page,
        async () => {
          await fieldX.fill('200');
          await fieldX.press('Enter');
          await expect(fieldX).toHaveValue('120');
        },
        1000
      );
      await expect(page.getByTestId('save-status')).toHaveText('已同步');

      // No history entry was recorded either, so undo is a quiet no-op.
      await expectNoDeckSave(
        page,
        () => page.getByTestId('undo').click(),
        1000
      );
      await expect(page.getByTestId('selection-outline')).toBeVisible();

      const saved = await savedNudgeBoxStyle(editor.directory, editor.file);
      expect(Number.parseFloat(saved.left ?? '')).toBe(120);

      await page.reload();
      const frame = page.frameLocator(FRAME_SELECTOR);
      await expect(frame.locator('[data-ppt-el="box1"]')).toBeVisible();
      await expect(page.getByTestId('save-status')).toHaveText('已同步');
      expect(
        (
          await inlineGeometryOf(
            frame.locator('[data-ppt-el="box1"]')
          )
        ).left
      ).toBe(120);
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'Ctrl+D measures a class-positioned absolute object before offsetting it',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    const editor = await openPlacedDeck(page);
    try {
      await editor.frame.locator('[data-ppt-el="placed"]').click();
      await expect(page.getByTestId('selection-outline')).toHaveAttribute(
        'data-selected-id',
        'placed'
      );

      const save = waitForDeckSave(page);
      await page.keyboard.press('Control+d');
      expect((await save).ok()).toBe(true);

      const copies = editor.frame.locator('.placed-object');
      await expect(copies).toHaveCount(2);
      const copy = copies.nth(1);
      await expect(copy).toHaveText('Placed');
      // The source is positioned only by its class, so the paste offset must
      // come from the rendered box (300, 220) rather than defaulting to 20 px.
      expect(await inlineGeometryOf(copy)).toMatchObject({
        position: 'absolute',
        left: 320,
        top: 240
      });
      await expect(page.getByTestId('selection-outline')).toHaveAttribute(
        'data-selected-id',
        (await copy.getAttribute('data-ppt-el')) ?? ''
      );
    } finally {
      await closeEditor(editor);
    }
  }
);

for (const kind of ['text', 'notes', 'numeric', 'background'] as const) {
  test(`pending ${kind} survives external SSE and explicit reload discards only that draft`,
    { tag: '@feature:live-sync' }, async ({ page }) => {
      const observed = await observeLiveSync(page);
      const editor = await openNudgeDeck(page);
      try {
        let draft: Locator;
        const value = kind === 'numeric' ? 'invalid-number' : kind === 'background' ? 'invalid-color' : 'Unapplied local draft';
        if (kind === 'text') {
          draft = editor.frame.locator('h1');
          await draft.dblclick();
        } else if (kind === 'notes') {
          await page.getByTestId('inspector-tab-notes').click();
          draft = page.getByTestId('notes-input');
        } else if (kind === 'numeric') {
          await editor.frame.locator('[data-ppt-el="box1"]').click();
          draft = page.getByTestId('field-x');
        } else {
          draft = page.getByTestId('background-value');
        }
        await draft.fill(value);
        await writeExternalHeading(editor, 'External replaces old draft');
        await expect(page.getByTestId('conflict-banner')).toBeVisible();
        if (kind === 'text') await expect(draft).toHaveText(value);
        else await expect(draft).toHaveValue(value);
        await expect(page.getByTestId('conflict-overwrite')).toBeDisabled();
        await expect(page.getByTestId('pending-edit-instruction')).toBeVisible();
        await expectNoDeckSave(page, async () => {
          if (kind === 'numeric') await draft.press('Enter');
          if (kind === 'background') await page.getByTestId('apply-background').click();
        }, 1000);
        if (kind === 'numeric' || kind === 'background') {
          await expect(draft).toHaveValue(value);
          await expect(page.getByTestId('conflict-overwrite')).toBeDisabled();
        }
        await page.getByTestId('conflict-reload').click();
        await expect(editor.frame.locator('h1')).toHaveText('External replaces old draft');
        await expect(page.getByTestId('conflict-banner')).toHaveCount(0);
        await expect(page.getByTestId('save-status')).toHaveText('已同步');
        expect(observed.saves).toHaveLength(0);
        expect(await savedDocument(editor)).not.toContain(value);
        if (kind === 'notes') await expect(page.getByTestId('notes-input')).toHaveValue('');
        if (kind === 'numeric') await expect(page.getByTestId('field-x')).toHaveValue('120');
        if (kind === 'background') await expect(page.getByTestId('background-value')).toHaveValue('');
        await observed.healthy();
      } finally {
        await closeEditor(editor);
      }
    });
}

for (const kind of ['drag', 'resize', 'rotate'] as const) {
  test(`pending ${kind} keeps its live geometry through external SSE and cancels without saving`,
    { tag: '@feature:live-sync' }, async ({ page }) => {
      const observed = await observeLiveSync(page);
      const editor = await openNudgeDeck(page);
      try {
        const box = editor.frame.locator('[data-ppt-el="box1"]');
        await box.click();
        const target = kind === 'drag' ? box : page.getByTestId(kind === 'resize' ? 'handle-se' : 'rotate-handle');
        const bounds = await target.boundingBox();
        if (!bounds) throw new Error('Missing gesture target');
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await page.mouse.down();
        await page.mouse.move(bounds.x + bounds.width / 2 + 35, bounds.y + bounds.height / 2 + 30);
        const preview = await box.getAttribute('style');
        await writeExternalHeading(editor, 'External during gesture');
        await expect(page.getByTestId('conflict-banner')).toBeVisible();
        await expect(box).toHaveAttribute('style', preview ?? '');
        await expect(page.getByTestId('conflict-overwrite')).toBeDisabled();
        if (kind === 'resize') {
          await page.getByTestId('handle-se').dispatchEvent('pointercancel', { pointerId: 1 });
        } else {
          await page.keyboard.press('Escape');
        }
        await page.mouse.up();
        await expect(page.getByTestId('conflict-overwrite')).toBeEnabled();
        await expect.poll(async () => (await inlineGeometryOf(box)).left).toBe(120);
        await expectNoDeckSave(page, async () => {}, 1000);
        expect(observed.saves).toHaveLength(0);
        await page.getByTestId('conflict-reload').click();
        await expect(editor.frame.locator('h1')).toHaveText('External during gesture');
        await observed.healthy();
      } finally {
        await page.mouse.up();
        await closeEditor(editor);
      }
    });
}

test('pending input during a delayed external GET fences clean replacement',
  { tag: '@feature:live-sync' }, async ({ page }) => {
    const observed = await observeLiveSync(page);
    const editor = await openNudgeDeck(page);
    const [held] = await holdDeckResponses(page, 1, 'GET');
    if (!held) throw new Error('Missing GET gate');
    try {
      await writeExternalHeading(editor, 'Held external snapshot');
      expect((await held.forwarded.promise).status()).toBe(200);
      const heading = editor.frame.locator('h1');
      await heading.dblclick();
      await heading.fill('Typed after GET started');
      held.gate.resolve();
      await held.delivered.promise;
      await expect(page.getByTestId('conflict-banner')).toBeVisible();
      await expect(heading).toHaveText('Typed after GET started');
      expect(observed.saves).toHaveLength(0);
      await observed.healthy();
    } finally {
      held.gate.resolve();
      await page.unroute('**/api/deck');
      await closeEditor(editor);
    }
  });

for (const commit of [false, true]) {
  test(`pending reload fence retains newer ${commit ? 'commit' : 'input'} and blocks repeated recovery`,
    { tag: '@feature:live-sync' }, async ({ page }) => {
      const observed = await observeLiveSync(page);
      const editor = await openNudgeDeck(page);
      let held: Awaited<ReturnType<typeof holdDeckResponses>>[number] | undefined;
      try {
        await createRealSaveConflict(page, editor);
        const field = page.getByTestId('field-x');
        await field.fill('200');
        [held] = await holdDeckResponses(page, 1, 'GET');
        if (!held) throw new Error('Missing GET gate');
        const gets: Request[] = [];
        page.on('request', (request) => {
          if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/deck') gets.push(request);
        });
        await page.getByTestId('conflict-reload').click();
        expect((await held.forwarded.promise).status()).toBe(200);
        await expect(page.getByTestId('conflict-reload')).toBeDisabled();
        await expect(page.getByTestId('conflict-overwrite')).toBeDisabled();
        await page.getByTestId('conflict-reload').click({ force: true });
        await page.getByTestId('conflict-overwrite').click({ force: true });
        expect(gets).toHaveLength(1);
        expect(observed.saves).toHaveLength(1);
        await field.fill('250');
        if (commit) await field.press('Enter');
        held.gate.resolve();
        await held.delivered.promise;
        await expect(field).toHaveValue('250');
        await expect(page.getByTestId('conflict-banner')).toBeVisible();
        await expect(page.getByTestId('save-status')).toHaveText('衝突');
        expect((await savedNudgeBoxStyle(editor.directory, editor.file)).left).toBe('120px');
        if (!commit) await field.press('Enter');
        await page.getByTestId('conflict-overwrite').click();
        await expect(page.getByTestId('save-status')).toHaveText('已儲存');
        expect((await savedNudgeBoxStyle(editor.directory, editor.file)).left).toBe('250px');
        await observed.healthy();
      } finally {
        held?.gate.resolve();
        await page.unroute('**/api/deck');
        await closeEditor(editor);
      }
    });
}

for (const kind of ['pending', 'dirty'] as const) {
  test(`${kind} unload warning cancels real navigation and retains local work`,
    { tag: '@feature:live-sync' }, async ({ page }) => {
      const observed = await observeLiveSync(page);
      const editor = await openNudgeDeck(page);
      try {
        if (kind === 'pending') {
          await page.getByTestId('background-value').fill('Unapplied unload draft');
        } else {
          await createRealSaveConflict(page, editor);
        }
        const dialogs: string[] = [];
        page.on('dialog', async (dialog) => {
          dialogs.push(dialog.type());
          await dialog.dismiss();
        });
        await page.goto('about:blank').catch((cause: unknown) => {
          expect(String(cause)).toContain('ERR_ABORTED');
        });
        expect(dialogs).toEqual(['beforeunload']);
        expect(page.url()).toBe(new URL(editor.friendlyPath, editor.host.url).href);
        if (kind === 'pending') {
          await expect(page.getByTestId('background-value')).toHaveValue('Unapplied unload draft');
          expect(observed.saves).toHaveLength(0);
        } else {
          expect((await inlineGeometryOf(editor.frame.locator('[data-ppt-el="box1"]'))).left).toBe(121);
          await expect(page.getByTestId('conflict-banner')).toBeVisible();
        }
        await observed.healthy();
      } finally {
        await closeEditor(editor);
      }
    });
}

test('pending recovery generation rejects an older clean GET after a newer reload',
  { tag: '@feature:live-sync' }, async ({ page }) => {
    const observed = await observeLiveSync(page);
    const editor = await openNudgeDeck(page);
    const holds = await holdDeckResponses(page, 2, 'GET');
    const [old, reload] = holds;
    if (!old || !reload) throw new Error('Missing GET gates');
    try {
      await writeExternalHeading(editor, 'Old clean GET');
      expect((await old.forwarded.promise).status()).toBe(200);
      await editor.frame.locator('[data-ppt-el="box1"]').click();
      await page.keyboard.press('ArrowRight');
      const rejected = waitForDeckSave(page);
      await page.keyboard.press('Control+s');
      expect((await rejected).status()).toBe(409);
      await expect(page.getByTestId('conflict-banner')).toBeVisible();
      await writeExternalHeading(editor, 'New reload snapshot');
      const external = await hostDeck(page, editor);
      await expect.poll(() => observed.events).toContainEqual({
        revision: external.revision,
        source: 'external',
        filePath: external.filePath
      });
      await page.getByTestId('conflict-reload').click();
      const response = await reload.forwarded.promise;
      expect(response.status()).toBe(200);
      expect(await response.json()).toMatchObject({ revision: external.revision });
      reload.gate.resolve();
      await reload.delivered.promise;
      await expect(editor.frame.locator('h1')).toHaveText('New reload snapshot');
      old.gate.resolve();
      await old.delivered.promise;
      await expectNoDeckSave(page, async () => {}, 1000);
      await expect(editor.frame.locator('h1')).toHaveText('New reload snapshot');
      await expect(page.getByTestId('save-status')).toHaveText('已同步');
      await expect(page.getByTestId('conflict-banner')).toHaveCount(0);
      expect(await savedDocument(editor)).toBe(external.html);
      await observed.healthy();
    } finally {
      for (const held of holds) held.gate.resolve();
      await page.unroute('**/api/deck');
      await closeEditor(editor);
    }
  });

test('pending input during overwrite is not a saved snapshot and recovery stays busy',
  { tag: '@feature:live-sync' }, async ({ page }) => {
    const observed = await observeLiveSync(page);
    const editor = await openNudgeDeck(page);
    let held: Awaited<ReturnType<typeof holdDeckResponses>>[number] | undefined;
    try {
      await createRealSaveConflict(page, editor);
      [held] = await holdDeckResponses(page);
      if (!held) throw new Error('Missing PUT gate');
      await page.getByTestId('conflict-overwrite').click();
      const response = await held.forwarded.promise;
      expect(response.status()).toBe(200);
      const saved = await response.json() as { revision: string };
      await expect(page.getByTestId('conflict-overwrite')).toBeDisabled();
      await expect(page.getByTestId('conflict-reload')).toBeDisabled();
      await page.getByTestId('conflict-overwrite').click({ force: true });
      await page.getByTestId('conflict-reload').click({ force: true });
      expect(observed.saves).toHaveLength(2);
      const field = page.getByTestId('field-x');
      await field.fill('777');
      held.gate.resolve();
      await held.delivered.promise;
      await expect(page.getByTestId('conflict-banner')).toHaveCount(0);
      await expect(field).toHaveValue('777');
      await expectNoDeckSave(page, async () => {}, 1000);
      expect(observed.saves).toHaveLength(2);
      expect((await savedNudgeBoxStyle(editor.directory, editor.file)).left).toBe('121px');
      await field.press('Enter');
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
      expect((await savedNudgeBoxStyle(editor.directory, editor.file)).left).toBe('777px');
      expect(observed.saves).toHaveLength(3);
      expect(observed.saves[2]?.postDataJSON()).toMatchObject({ baseRevision: saved.revision });
      expect(observed.saves[2]?.postDataJSON()).not.toHaveProperty('force');
      await observed.healthy();
    } finally {
      held?.gate.resolve();
      await page.unroute('**/api/deck');
      await closeEditor(editor);
    }
  });

test('pending invalid drafts block slide selection and view replacement until cancelled',
  { tag: '@feature:live-sync' }, async ({ page }) => {
    const observed = await observeLiveSync(page);
    const editor = await openNudgeDeck(page);
    try {
      const background = page.getByTestId('background-value');
      await background.fill('invalid-color');
      await page.getByTestId('thumbnail').nth(1).click();
      await expect(background).toHaveValue('invalid-color');
      await expect(editor.frame.locator('h1')).toHaveText('Untitled deck');
      await page.getByTestId('view-sorter').click();
      await expect(background).toBeVisible();
      await page.locator('[data-testid="object-row"][data-object-id="box1"]').click();
      await expect(background).toBeVisible();
      await background.press('Escape');
      await page.locator('[data-testid="object-row"][data-object-id="box1"]').click();
      const field = page.getByTestId('field-x');
      await field.fill('not-a-number');
      await page.getByTestId('thumbnail').nth(1).click();
      await expect(field).toHaveValue('not-a-number');
      await expect(field).toHaveAttribute('aria-invalid', 'true');
      await field.press('Escape');
      await page.getByTestId('thumbnail').nth(1).click();
      await expect(editor.frame.locator('h1')).toHaveText('Untitled deck — 2');
      await expectNoDeckSave(page, async () => {}, 1000);
      expect(observed.saves).toHaveLength(0);
      await observed.healthy();
    } finally {
      await closeEditor(editor);
    }
  });

test('pending valid drafts settle before slide and view replacement without retargeting',
  { tag: '@feature:live-sync' }, async ({ page }) => {
    const observed = await observeLiveSync(page);
    const editor = await openNudgeDeck(page);
    try {
      const heading = editor.frame.locator('h1');
      await heading.dblclick();
      await heading.fill('Local first slide');
      await page.getByTestId('thumbnail').nth(1).click();
      await expect(editor.frame.locator('h1')).toHaveText('Untitled deck — 2');
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
      expect(await savedDocument(editor)).toContain('Local first slide');
      await page.getByTestId('background-value').fill('#112233');
      await page.getByTestId('view-sorter').click();
      await expect(page.getByTestId('sorter-slide')).toHaveCount(2);
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
      await page.getByTestId('view-normal').click();
      await expect(page.getByTestId('background-value')).toHaveValue('rgb(17, 34, 51)');
      await page.getByTestId('thumbnail').nth(0).click();
      await expect(editor.frame.locator('h1')).toHaveText('Local first slide');
      await expect(page.getByTestId('background-value')).toHaveValue('');
      await observed.healthy();
    } finally {
      await closeEditor(editor);
    }
  });

test('pending ownership ignores focus and no-op text and numeric edits',
  { tag: '@feature:live-sync' }, async ({ page }) => {
    const observed = await observeLiveSync(page);
    const editor = await openNudgeDeck(page);
    try {
      const heading = editor.frame.locator('h1');
      await heading.dblclick();
      await page.keyboard.press('Escape');
      await heading.dblclick();
      await heading.fill('Temporary text');
      await heading.fill('Untitled deck');
      await page.keyboard.press('Escape');
      await editor.frame.locator('[data-ppt-el="box1"]').click();
      const field = page.getByTestId('field-x');
      await field.fill('300');
      await field.fill('120');
      await field.press('Enter');
      await page.getByTestId('undo').click();
      await expectNoDeckSave(page, async () => {}, 1000);
      expect(observed.saves).toHaveLength(0);
      await expect(page.getByTestId('selection-outline')).toBeVisible();
      await writeExternalHeading(editor, 'Clean after no-op');
      await expect(heading).toHaveText('Clean after no-op');
      await expect(page.getByTestId('conflict-banner')).toHaveCount(0);
      await observed.healthy();
    } finally {
      await closeEditor(editor);
    }
  });

test(
  'in-flight own SSE waits for the PUT response without recursive draining',
  { tag: '@feature:live-sync' },
  async ({ page }) => {
    const observed = await observeLiveSync(page);
    const editor = await openNudgeDeck(page);
    const [held] = await holdDeckResponses(page);
    if (!held) throw new Error('Missing response gate');
    try {
      await expect.poll(() => observed.events.length).toBe(1);
      const editorDeck = await hostDeck(page, editor);
      await editor.frame.locator('[data-ppt-el="box1"]').click();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Control+s');
      const response = await held.forwarded.promise;
      expect(response.status()).toBe(200);
      const { revision } = await response.json() as { revision: string };
      await expect.poll(() => observed.events).toContainEqual({
        revision,
        source: 'editor',
        filePath: editorDeck.filePath
      });
      await expect(page.getByTestId('save-status')).toHaveText('儲存中…');
      expect((await savedNudgeBoxStyle(editor.directory, editor.file)).left).toBe('121px');
      await observed.healthy();
      held.gate.resolve();
      await held.delivered.promise;
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
      await expect(page.getByTestId('conflict-banner')).toHaveCount(0);
      await observed.healthy();
    } finally {
      held.gate.resolve();
      await held.delivered.promise;
      await page.unroute('**/api/deck');
      await closeEditor(editor);
    }
  }
);

test(
  'queued saves use the latest revision and stale own SSE cannot conflict with a newer edit',
  { tag: '@feature:live-sync' },
  async ({ page }) => {
    const observed = await observeLiveSync(page);
    const editor = await openNudgeDeck(page);
    const holds = await holdDeckResponses(page, 2);
    const [first, second] = holds;
    if (!first || !second) throw new Error('Missing response gates');
    try {
      await expect.poll(() => observed.events.length).toBe(1);
      const initial = await hostDeck(page, editor);
      const box = editor.frame.locator('[data-ppt-el="box1"]');
      await box.click();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Control+s');
      const firstResponse = await first.forwarded.promise;
      expect(firstResponse.status()).toBe(200);
      const firstSaved = await firstResponse.json() as { revision: string };
      await expect.poll(() => observed.events).toContainEqual({
        revision: firstSaved.revision, source: 'editor', filePath: initial.filePath
      });
      await page.keyboard.press('Shift+ArrowRight');
      await page.keyboard.press('Control+s');
      expect(observed.saves).toHaveLength(1);
      first.gate.resolve();
      const secondResponse = await second.forwarded.promise;
      expect(secondResponse.status()).toBe(200);
      const secondSaved = await secondResponse.json() as { revision: string };
      expect(secondSaved.revision).not.toBe(firstSaved.revision);
      await expect.poll(() => observed.events).toContainEqual({
        revision: secondSaved.revision, source: 'editor', filePath: initial.filePath
      });
      expect(observed.saves).toHaveLength(2);
      expect(observed.saves[0]?.postDataJSON()).toMatchObject({ baseRevision: initial.revision });
      expect(observed.saves[1]?.postDataJSON()).toMatchObject({ baseRevision: firstSaved.revision });
      expect((await savedNudgeBoxStyle(editor.directory, editor.file)).left).toBe('131px');
      await page.keyboard.press('ArrowRight');
      expect((await inlineGeometryOf(box)).left).toBe(132);
      second.gate.resolve();
      await second.delivered.promise;
      await expect(page.getByTestId('conflict-banner')).toHaveCount(0);
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
      expect(observed.saves).toHaveLength(3);
      expect(observed.saves[2]?.postDataJSON()).toMatchObject({ baseRevision: secondSaved.revision });
      for (const request of observed.saves) {
        expect(request.postDataJSON()).not.toHaveProperty('force');
      }
      expect((await savedNudgeBoxStyle(editor.directory, editor.file)).left).toBe('132px');
      expect((await hostDeck(page, editor)).html).toBe(await savedDocument(editor));
      await observed.healthy();
    } finally {
      for (const held of holds) held.gate.resolve();
      await page.unroute('**/api/deck');
      await closeEditor(editor);
    }
  }
);

test(
  'a real 409 overwrite saves a newer in-flight edit with a later ordinary PUT',
  { tag: '@feature:live-sync' },
  async ({ page }) => {
    const observed = await observeLiveSync(page);
    const editor = await openNudgeDeck(page);
    let held: Awaited<ReturnType<typeof holdDeckResponses>>[number] | undefined;
    try {
      const savedDeck = await createRealSaveConflict(page, editor);
      [held] = await holdDeckResponses(page);
      if (!held) throw new Error('Missing response gate');
      await page.getByTestId('conflict-overwrite').click();
      const response = await held.forwarded.promise;
      expect(response.status()).toBe(200);
      const saved = await response.json() as { revision: string };
      await expect.poll(() => observed.events).toContainEqual({
        revision: saved.revision,
        source: 'editor',
        filePath: savedDeck.filePath
      });
      expect(observed.saves).toHaveLength(2);
      expect(observed.saves[1]?.postDataJSON()).toHaveProperty('force', true);
      expect((await savedNudgeBoxStyle(editor.directory, editor.file)).left).toBe('121px');
      const box = editor.frame.locator('[data-ppt-el="box1"]');
      await box.click();
      await page.keyboard.press('Shift+ArrowRight');
      expect((await inlineGeometryOf(box)).left).toBe(131);
      held.gate.resolve();
      await held.delivered.promise;
      await expect(page.getByTestId('conflict-banner')).toHaveCount(0);
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
      expect(observed.saves).toHaveLength(3);
      expect(observed.saves[2]?.postDataJSON()).toMatchObject({ baseRevision: saved.revision });
      expect(observed.saves[2]?.postDataJSON()).not.toHaveProperty('force');
      expect((await savedNudgeBoxStyle(editor.directory, editor.file)).left).toBe('131px');
      expect(await savedDocument(editor)).not.toContain('External conflict');
      expect((await hostDeck(page, editor)).html).toBe(await savedDocument(editor));
      const manual = waitForDeckSave(page);
      await page.keyboard.press('Control+s');
      expect((await manual).status()).toBe(200);
      expect(observed.saves).toHaveLength(4);
      expect(observed.saves[3]?.postDataJSON()).not.toHaveProperty('force');
      await observed.healthy();
    } finally {
      held?.gate.resolve();
      await page.unroute('**/api/deck');
      await closeEditor(editor);
    }
  }
);

test(
  'an external revision newer than an in-flight overwrite keeps its conflict',
  { tag: '@feature:live-sync' },
  async ({ page }) => {
    const observed = await observeLiveSync(page);
    const editor = await openNudgeDeck(page);
    let held: Awaited<ReturnType<typeof holdDeckResponses>>[number] | undefined;
    try {
      const conflictDeck = await createRealSaveConflict(page, editor);
      [held] = await holdDeckResponses(page);
      if (!held) throw new Error('Missing response gate');
      await page.getByTestId('conflict-overwrite').click();
      const response = await held.forwarded.promise;
      expect(response.status()).toBe(200);
      const saved = await response.json() as { revision: string };
      await expect.poll(() => observed.events).toContainEqual({
        revision: saved.revision,
        source: 'editor',
        filePath: conflictDeck.filePath
      });
      const box = editor.frame.locator('[data-ppt-el="box1"]');
      await box.click();
      await page.keyboard.press('Shift+ArrowRight');
      await writeExternalHeading(editor, 'Newer external conflict');
      const external = await hostDeck(page, editor);
      expect(external.revision).not.toBe(saved.revision);
      await expect.poll(() => observed.events).toContainEqual({
        revision: external.revision,
        source: 'external',
        filePath: external.filePath
      });
      held.gate.resolve();
      await held.delivered.promise;
      await expect(page.getByTestId('save-status')).toHaveText('衝突');
      await expect(page.getByTestId('conflict-banner')).toBeVisible();
      await expectNoDeckSave(page, () => page.keyboard.press('Control+s'), 1200);
      expect(observed.saves).toHaveLength(2);
      expect((await inlineGeometryOf(box)).left).toBe(131);
      expect((await savedNudgeBoxStyle(editor.directory, editor.file)).left).toBe('121px');
      expect(await savedDocument(editor)).toBe(external.html);
      await observed.healthy();
    } finally {
      held?.gate.resolve();
      await page.unroute('**/api/deck');
      await closeEditor(editor);
    }
  }
);

test(
  'a clean external write applies live within two seconds without reloading',
  { tag: '@feature:live-sync' },
  async ({ page }) => {
    const editor = await openTemplateDeck(page);
    try {
      await page.evaluate(() => {
        (
          globalThis as unknown as { __htmlpptNoReload?: string }
        ).__htmlpptNoReload = 'kept';
      });

      await writeExternalHeading(editor, '外部更新');

      await expect(editor.frame.locator('h1')).toHaveText('外部更新', {
        timeout: 2000
      });
      await expect(page.getByTestId('save-status')).toHaveText('已同步');
      await expect(page.getByTestId('conflict-banner')).toHaveCount(0);
      const marker = await page.evaluate(
        () =>
          (globalThis as unknown as { __htmlpptNoReload?: string })
            .__htmlpptNoReload
      );
      expect(marker).toBe('kept');
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'a dirty external write shows the conflict banner and reload discards local edits',
  { tag: '@feature:live-sync' },
  async ({ page }) => {
    const editor = await openNudgeDeck(page);
    try {
      await editor.frame.locator('[data-ppt-el="box1"]').click();
      await page.keyboard.press('ArrowRight');
      await writeExternalHeading(editor, '外部衝突');

      const banner = page.getByTestId('conflict-banner');
      await expect(banner).toBeVisible({ timeout: 5000 });
      await expect(page.getByTestId('save-status')).toHaveText('衝突');

      await page.getByTestId('conflict-reload').click();
      await expect(banner).toHaveCount(0);
      await expect(editor.frame.locator('h1')).toHaveText('外部衝突', {
        timeout: 5000
      });
      await expect(page.getByTestId('save-status')).toHaveText('已同步');
      const saved = await savedNudgeBoxStyle(editor.directory, editor.file);
      expect(Number.parseFloat(saved.left ?? '')).toBe(120);
      await expect
        .poll(async () => (await inlineGeometryOf(
          editor.frame.locator('[data-ppt-el="box1"]')
        )).left)
        .toBe(120);
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'overwrite resolves a conflict by writing the local deck with force',
  { tag: '@feature:live-sync' },
  async ({ page }) => {
    const editor = await openNudgeDeck(page);
    try {
      const box = editor.frame.locator('[data-ppt-el="box1"]');
      await box.click();
      await page.keyboard.press('ArrowRight');
      await writeExternalHeading(editor, '外部第一次');
      const banner = page.getByTestId('conflict-banner');
      await expect(banner).toBeVisible({ timeout: 5000 });
      await page.getByTestId('conflict-reload').click();
      await expect(banner).toHaveCount(0);
      await expect(editor.frame.locator('h1')).toHaveText('外部第一次', {
        timeout: 5000
      });

      await box.click();
      await page.keyboard.press('Shift+ArrowRight');
      await writeExternalHeading(editor, '外部第二次');
      await expect(banner).toBeVisible({ timeout: 5000 });

      const forced = page.waitForRequest((request) => {
        if (!isDeckSaveRequest(request)) return false;
        const body = request.postDataJSON() as { force?: boolean } | null;
        return body?.force === true;
      });
      await page.getByTestId('conflict-overwrite').click();
      const forcedRequest = await forced;
      expect(forcedRequest.method()).toBe('PUT');
      await expect(banner).toHaveCount(0);
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      const saved = await savedDocument(editor);
      expect(saved).toContain('外部第一次');
      expect(saved).not.toContain('外部第二次');
      await expect
        .poll(async () =>
          Number.parseFloat(
            (await savedNudgeBoxStyle(editor.directory, editor.file)).left ?? ''
          )
        )
        .toBeCloseTo(130, 1);
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'autosave persists an edit 800 ms after the last commit without a keystroke',
  { tag: '@feature:live-sync' },
  async ({ page }) => {
    const editor = await openNudgeDeck(page);
    try {
      const saves: Request[] = [];
      const countSave = (request: Request) => {
        if (isDeckSaveRequest(request)) saves.push(request);
      };
      page.on('request', countSave);
      try {
        await editor.frame.locator('[data-ppt-el="box1"]').click();
        const save = waitForDeckSave(page);
        // The debounce keeps the PUT out of the first half-second; the same
        // commit still saves without any explicit save action.
        await expectNoDeckSave(
          page,
          () => page.keyboard.press('ArrowRight'),
          400
        );
        expect((await save).ok()).toBe(true);
        await expect(page.getByTestId('save-status')).toHaveText('已儲存');
        expect(saves).toHaveLength(1);
        await expect
          .poll(async () =>
            Number.parseFloat(
              (await savedNudgeBoxStyle(editor.directory, editor.file)).left ??
                ''
            )
          )
          .toBeCloseTo(121, 1);
      } finally {
        page.off('request', countSave);
      }
    } finally {
      await closeEditor(editor);
    }
  }
);

test(
  'two tabs conflict on each other and both recovery paths work',
  { tag: '@feature:live-sync' },
  async ({ page, context }) => {
    const editor = await openNudgeDeck(page);
    const second = await context.newPage();
    try {
      await second.goto(editor.host.url);
      const secondFrame = second.frameLocator(FRAME_SELECTOR);
      const boxB = secondFrame.locator('[data-ppt-el="box1"]');
      await expect(boxB).toBeVisible();
      await expect(second.getByTestId('save-status')).toHaveText('已同步');

      // Tab B edits first and stays dirty.
      await boxB.click();
      await second.keyboard.press('ArrowRight');

      // Tab A saves immediately, so B sees the revision before its autosave.
      await editor.frame.locator('[data-ppt-el="box1"]').click();
      await page.keyboard.press('Shift+ArrowRight');
      const firstSave = waitForDeckSave(page);
      await page.keyboard.press('Control+s');
      expect((await firstSave).ok()).toBe(true);
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      const banner = second.getByTestId('conflict-banner');
      await expect(banner).toBeVisible({ timeout: 5000 });
      await expect(second.getByTestId('save-status')).toHaveText('衝突');

      // Reload discards B's nudge and adopts A's saved geometry.
      await second.getByTestId('conflict-reload').click();
      await expect(banner).toHaveCount(0);
      await expect(second.getByTestId('save-status')).toHaveText('已同步');
      const adoptedLeft = Number.parseFloat(
        (await savedNudgeBoxStyle(editor.directory, editor.file)).left ?? ''
      );
      expect(adoptedLeft).toBeCloseTo(130, 1);
      await expect
        .poll(async () => (await inlineGeometryOf(boxB)).left)
        .toBeCloseTo(adoptedLeft, 1);

      // B edits again, A saves again, and B overwrites with its local deck.
      await boxB.click();
      await second.keyboard.press('Shift+ArrowRight');
      const localLeft = (await inlineGeometryOf(boxB)).left;
      expect(localLeft).toBeCloseTo(140, 1);

      await editor.frame.locator('[data-ppt-el="box1"]').click();
      await page.keyboard.press('ArrowRight');
      const secondSave = waitForDeckSave(page);
      await page.keyboard.press('Control+s');
      expect((await secondSave).ok()).toBe(true);
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      await expect(banner).toBeVisible({ timeout: 5000 });
      await second.getByTestId('conflict-overwrite').click();
      await expect(banner).toHaveCount(0);
      await expect(second.getByTestId('save-status')).toHaveText('已儲存');
      await expect
        .poll(async () =>
          Number.parseFloat(
            (await savedNudgeBoxStyle(editor.directory, editor.file)).left ?? ''
          )
        )
        .toBeCloseTo(localLeft ?? 0, 1);
    } finally {
      await second.close();
      await closeEditor(editor);
    }
  }
);
