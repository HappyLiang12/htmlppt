import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  expect,
  test,
  type Locator,
  type Page,
  type Response
} from '@playwright/test';
import { execa } from 'execa';
import { startCliHost } from './helpers';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'packages/cli/dist/bin.js');
const FRAME_SELECTOR = 'iframe[title="投影片預覽"]';

interface StartedHost {
  url: string;
  stop(): Promise<void>;
}

function frameHeading(page: Page): Locator {
  return page.frameLocator(FRAME_SELECTOR).locator('h1');
}

function pathInput(page: Page): Locator {
  return page.getByTestId('deck-path');
}

function isOpenRequest(request: {
  method(): string;
  url(): string;
}): boolean {
  return (
    request.method() === 'POST' &&
    new URL(request.url()).pathname === '/api/open'
  );
}

function waitForDeckSave(page: Page) {
  return page.waitForResponse(
    (response: Response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === '/api/deck'
  );
}

async function createDeck(
  directory: string,
  file: string,
  slides: number
): Promise<string> {
  await execa('node', [cliPath, 'new', file, '--slides', String(slides)], {
    cwd: directory
  });
  return join(directory, file);
}

/** A second deck with a heading that cannot be confused with the first. */
async function createSecondDeck(
  directory: string,
  file = 'second.html'
): Promise<string> {
  const path = await createDeck(directory, file, 1);
  const html = await readFile(path, 'utf8');
  const updated = html.replace(
    /(<h1[^>]*>)Untitled deck(<\/h1>)/,
    '$1Second deck$2'
  );
  expect(updated, 'second deck heading was replaced').not.toBe(html);
  await writeFile(path, updated, 'utf8');
  return path;
}

/**
 * Starts the real CLI host with an isolated registry. The child inherits the
 * override at spawn time; later CLI commands pass the same HOME explicitly.
 */
async function startIsolatedHost(
  directory: string,
  file: string,
  home: string
): Promise<StartedHost> {
  const previous = process.env.HTMLPPT_HOME;
  process.env.HTMLPPT_HOME = home;
  try {
    return await startCliHost(cliPath, directory, file);
  } finally {
    if (previous === undefined) delete process.env.HTMLPPT_HOME;
    else process.env.HTMLPPT_HOME = previous;
  }
}

/** The registry path the CLI uses: HTMLPPT_HOME/sessions/<sha256(path)>.json */
function registryFile(home: string, deckPath: string): string {
  const key = createHash('sha256').update(deckPath).digest('hex');
  return join(home, 'sessions', `${key}.json`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test(
  'opens another deck from the path input and saves into it',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    test.setTimeout(120_000);
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-open-path-'));
    let host: StartedHost | undefined;
    try {
      const firstPath = await createDeck(directory, 'first.html', 2);
      const secondPath = await createSecondDeck(directory);
      host = await startCliHost(cliPath, directory, 'first.html');

      await page.goto(host.url);
      await expect(page).toHaveURL(/\/d\/first\.html$/);
      await expect(pathInput(page)).toHaveValue(/first\.html$/);
      await expect(frameHeading(page)).toContainText('Untitled deck');
      await expect(page.getByTestId('save-status')).toHaveText('已同步');

      let openRequests = 0;
      page.on('request', (request) => {
        if (isOpenRequest(request)) openRequests += 1;
      });

      // Leave a text edit pending, then open the second deck immediately. The
      // open flow must settle and save it into the first deck first, while the
      // second deck's h1 still proves the new document loaded.
      const firstHeading = frameHeading(page);
      await firstHeading.dblclick();
      await expect(firstHeading).toHaveAttribute('contenteditable', 'true');
      await page.keyboard.press('Control+a');
      await page.keyboard.type('First deck edited');
      await pathInput(page).fill(secondPath);
      await pathInput(page).press('Enter');

      await expect(frameHeading(page)).toContainText('Second deck');
      await expect(page).toHaveURL(/\/d\/second\.html$/);
      expect(new URL(page.url()).pathname).toBe('/d/second.html');
      await expect(pathInput(page)).toHaveValue(/second\.html$/);
      expect(openRequests).toBe(1);

      // The pending first-deck edit is in the first file before the open; the
      // post-open snapshot is what the second-deck edit must leave untouched.
      await expect
        .poll(async () => readFile(firstPath, 'utf8'))
        .toContain('First deck edited');
      const firstBefore = await readFile(firstPath, 'utf8');

      const heading = frameHeading(page);
      await heading.dblclick();
      await expect(heading).toHaveAttribute('contenteditable', 'true');
      await page.keyboard.press('Control+a');
      await page.keyboard.type('Second deck edited');
      const save = waitForDeckSave(page);
      await page.getByTestId('canvas-preview').click({ position: { x: 4, y: 4 } });
      expect((await save).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      await expect
        .poll(async () => readFile(secondPath, 'utf8'))
        .toContain('Second deck edited');
      expect(await readFile(firstPath, 'utf8')).toBe(firstBefore);

      // Blur opens only when the draft changed: going back to the first deck
      // through the input must work, and blurring an unchanged value is inert.
      await pathInput(page).fill(firstPath);
      await page.getByTestId('canvas-preview').click({ position: { x: 4, y: 4 } });
      await expect(frameHeading(page)).toContainText('First deck edited');
      await expect(page).toHaveURL(/\/d\/first\.html$/);
      const current = await pathInput(page).inputValue();
      const requestsBefore = openRequests;
      await pathInput(page).fill(current);
      await page.getByTestId('canvas-preview').click({ position: { x: 4, y: 4 } });
      await expect(frameHeading(page)).toContainText('First deck edited');
      await expect(page).toHaveURL(/\/d\/first\.html$/);
      expect(openRequests).toBe(requestsBefore);
    } finally {
      await host?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  'accepts a file URL, keeps the current deck on failure, and cancels Escape',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    test.setTimeout(120_000);
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-open-url-'));
    let host: StartedHost | undefined;
    try {
      const firstPath = await createDeck(directory, 'first.html', 2);
      const secondPath = await createSecondDeck(directory);
      host = await startCliHost(cliPath, directory, 'first.html');

      await page.goto(host.url);
      await expect(pathInput(page)).toHaveValue(/first\.html$/);

      await pathInput(page).fill(pathToFileURL(secondPath).href);
      await pathInput(page).press('Enter');
      await expect(frameHeading(page)).toContainText('Second deck');
      await expect(page).toHaveURL(/\/d\/second\.html$/);

      await pathInput(page).fill(join(directory, 'missing.html'));
      await pathInput(page).press('Enter');
      await expect(page.locator('#deck-path-error')).toHaveText('找不到檔案。');
      await expect(page.locator('#deck-path-error')).toHaveAttribute(
        'role',
        'alert'
      );
      await expect(pathInput(page)).toHaveAttribute('aria-invalid', 'true');
      await expect(frameHeading(page)).toContainText('Second deck');
      expect(new URL(page.url()).pathname).toBe('/d/second.html');

      // Escape must cancel the draft, not submit it through the blur it
      // causes. The discarded path is a real deck, so a missing-file error
      // cannot hide a submitted open.
      let openRequests = 0;
      page.on('request', (request) => {
        if (isOpenRequest(request)) openRequests += 1;
      });
      await pathInput(page).fill(firstPath);
      await pathInput(page).press('Escape');
      await expect(pathInput(page)).not.toBeFocused();
      await expect(pathInput(page)).toHaveValue(/second\.html$/);
      await expect(frameHeading(page)).toContainText('Second deck');
      await expect(page).toHaveURL(/\/d\/second\.html$/);

      // A later request proves the browser already processed the blur task;
      // an open submitted by the blur would have been observed by then.
      const health = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/health' && response.ok()
      );
      await page.evaluate(() => fetch('/api/health'));
      await health;
      expect(openRequests).toBe(0);
    } finally {
      await host?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  'shows a 409 host origin without its token and never prints raw JSON',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    test.setTimeout(120_000);
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-open-errors-'));
    let host: StartedHost | undefined;
    try {
      await createDeck(directory, 'first.html', 2);
      const secondPath = await createSecondDeck(directory);
      host = await startCliHost(cliPath, directory, 'first.html');

      await page.goto(host.url);
      await expect(frameHeading(page)).toContainText('Untitled deck');
      await expect(page.getByTestId('save-status')).toHaveText('已同步');

      await page.route('**/api/open', (route) =>
        route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'deck-already-open',
            url: 'http://127.0.0.1:4567/editor?token=super-secret'
          })
        })
      );
      await pathInput(page).fill(secondPath);
      await pathInput(page).press('Enter');
      await expect(page.locator('#deck-path-error')).toHaveText(
        '已在另一個 host 開啟：http://127.0.0.1:4567'
      );
      await expect(page.locator('#deck-path-error')).not.toContainText(
        'super-secret'
      );
      await expect(frameHeading(page)).toContainText('Untitled deck');
      await expect(page).toHaveURL(/\/d\/first\.html$/);

      // An error payload without a message must not echo the JSON body.
      await page.unroute('**/api/open');
      await page.route('**/api/open', (route) =>
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'mystery' })
        })
      );
      await pathInput(page).fill(secondPath);
      await pathInput(page).press('Enter');
      await expect(page.locator('#deck-path-error')).toHaveText('開啟失敗。');
      await expect(page.locator('#deck-path-error')).not.toContainText(
        'mystery'
      );
      await expect(frameHeading(page)).toContainText('Untitled deck');
      await expect(page).toHaveURL(/\/d\/first\.html$/);
    } finally {
      await host?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  'a second tab follows the open and rebinds its URL',
  { tag: '@feature:live-sync' },
  async ({ page, context }) => {
    test.setTimeout(120_000);
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-open-rebind-'));
    let host: StartedHost | undefined;
    let other: Page | undefined;
    try {
      await createDeck(directory, 'first.html', 2);
      const secondPath = await createSecondDeck(directory);
      host = await startCliHost(cliPath, directory, 'first.html');

      await page.goto(host.url);
      await expect(frameHeading(page)).toContainText('Untitled deck');
      await expect(page.getByTestId('save-status')).toHaveText('已同步');

      other = await context.newPage();
      const liveStream = other.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/events' && response.ok()
      );
      await other.goto(host.url);
      await liveStream;
      await expect(other).toHaveURL(/\/d\/first\.html$/);
      await expect(pathInput(other)).toHaveValue(/first\.html$/);
      await expect(frameHeading(other)).toContainText('Untitled deck');
      await expect(other.getByTestId('save-status')).toHaveText('已同步');

      await pathInput(page).fill(secondPath);
      await pathInput(page).press('Enter');
      await expect(frameHeading(page)).toContainText('Second deck');
      await expect(page).toHaveURL(/\/d\/second\.html$/);

      // The host broadcast rebinds the untouched tab without a navigation.
      await expect(frameHeading(other)).toContainText('Second deck');
      await expect(other).toHaveURL(/\/d\/second\.html$/);
      await expect(pathInput(other)).toHaveValue(/second\.html$/);
      await expect(other.getByTestId('save-status')).toHaveText('已同步');
    } finally {
      await other?.close();
      await host?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  'picking a file switches to standalone mode without changing the URL',
  { tag: '@feature:standalone' },
  async ({ page }) => {
    test.setTimeout(120_000);
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-open-picker-'));
    let host: StartedHost | undefined;
    try {
      await createDeck(directory, 'first.html', 2);
      const secondPath = await createSecondDeck(directory);
      host = await startCliHost(cliPath, directory, 'first.html');

      // Force the hidden-input fallback so Playwright can drive the chooser.
      await page.addInitScript(() => {
        const scope = window as unknown as Record<string, unknown>;
        Object.defineProperty(scope, 'showOpenFilePicker', {
          configurable: true,
          value: undefined
        });
      });
      await page.goto(host.url);
      await expect(page).toHaveURL(/\/d\/first\.html$/);

      const chooser = page.waitForEvent('filechooser');
      await page.getByTestId('deck-picker').click();
      await (await chooser).setFiles(secondPath);

      await expect(page.getByTestId('standalone-badge')).toBeVisible();
      await expect(pathInput(page)).toHaveValue('second.html');
      await expect(pathInput(page)).not.toBeEditable();
      await expect(frameHeading(page)).toContainText('Second deck');
      expect(new URL(page.url()).pathname).toBe('/d/first.html');
    } finally {
      await host?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  'saves pending edits before opening and keeps the deck when the save fails',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    test.setTimeout(120_000);
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-open-save-gate-'));
    let host: StartedHost | undefined;
    let releaseSave: (() => void) | undefined;
    try {
      await createDeck(directory, 'first.html', 2);
      const secondPath = await createSecondDeck(directory);
      host = await startCliHost(cliPath, directory, 'first.html');

      await page.goto(host.url);
      await expect(frameHeading(page)).toContainText('Untitled deck');
      await expect(page.getByTestId('save-status')).toHaveText('已同步');
      const secondBefore = await readFile(secondPath);

      let openRequests = 0;
      page.on('request', (request) => {
        if (isOpenRequest(request)) openRequests += 1;
      });

      const saveGate = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      let markSaveStarted: (() => void) | undefined;
      const saveStarted = new Promise<void>((resolve) => {
        markSaveStarted = resolve;
      });
      await page.route('**/api/deck', async (route) => {
        if (route.request().method() !== 'PUT') {
          await route.continue();
          return;
        }
        markSaveStarted?.();
        await saveGate;
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'save-failed' })
        });
      });

      const heading = frameHeading(page);
      await heading.dblclick();
      await expect(heading).toHaveAttribute('contenteditable', 'true');
      await page.keyboard.press('Control+a');
      await page.keyboard.type('Unsaved local edit');

      await pathInput(page).fill(secondPath);
      await pathInput(page).press('Enter');
      await saveStarted;

      // The save is still held, so no open may have been attempted. A health
      // request proves the page had a chance to send one.
      const health = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/health' && response.ok()
      );
      await page.evaluate(() => fetch('/api/health'));
      await health;
      expect(openRequests).toBe(0);

      releaseSave?.();

      await expect(page.locator('#deck-path-error')).toContainText(
        'Save failed (500)'
      );
      expect(openRequests).toBe(0);
      await expect(frameHeading(page)).not.toContainText('Second deck');
      await expect(page).toHaveURL(/\/d\/first\.html$/);
      expect(await readFile(secondPath)).toEqual(secondBefore);
    } finally {
      releaseSave?.();
      await host?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  'a dirty tab cannot overwrite a deck another tab just opened',
  { tag: '@feature:live-sync' },
  async ({ page, context }) => {
    test.setTimeout(120_000);
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-open-dirty-'));
    let host: StartedHost | undefined;
    let other: Page | undefined;
    let releaseSave: (() => void) | undefined;
    try {
      await createDeck(directory, 'first.html', 2);
      const secondPath = await createSecondDeck(directory);
      host = await startCliHost(cliPath, directory, 'first.html');

      await page.goto(host.url);
      await expect(frameHeading(page)).toContainText('Untitled deck');
      await expect(page.getByTestId('save-status')).toHaveText('已同步');

      other = await context.newPage();
      const liveStream = other.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/events' && response.ok()
      );
      await other.goto(host.url);
      await liveStream;
      await expect(frameHeading(other)).toContainText('Untitled deck');
      await expect(other.getByTestId('save-status')).toHaveText('已同步');

      // Hold the dirty tab's autosave so the deck-switch broadcast arrives
      // while the tab still owns unsaved content, then fail that save.
      const saveGate = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      let markSaveStarted: (() => void) | undefined;
      const saveStarted = new Promise<void>((resolve) => {
        markSaveStarted = resolve;
      });
      await other.route('**/api/deck', async (route) => {
        if (route.request().method() !== 'PUT') {
          await route.continue();
          return;
        }
        markSaveStarted?.();
        await saveGate;
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'save-failed' })
        });
      });

      const heading = frameHeading(other);
      await heading.dblclick();
      await expect(heading).toHaveAttribute('contenteditable', 'true');
      await other.keyboard.press('Control+a');
      await other.keyboard.type('Dirty local edit');
      // Blur commits the text edit, which makes the tab dirty and schedules
      // the autosave that the route below holds open.
      await other
        .getByTestId('canvas-preview')
        .click({ position: { x: 4, y: 4 } });
      await saveStarted;

      await pathInput(page).fill(secondPath);
      await pathInput(page).press('Enter');
      await expect(frameHeading(page)).toContainText('Second deck');
      await expect(page).toHaveURL(/\/d\/second\.html$/);

      releaseSave?.();

      await expect(other.getByTestId('conflict-banner')).toBeVisible();
      await expect(other.getByTestId('conflict-banner')).toContainText(
        '主機已切換到另一個檔案；只能重新載入。'
      );
      await expect(other.getByTestId('conflict-overwrite')).toHaveCount(0);
      await expect(other.getByTestId('conflict-reload')).toBeVisible();

      // An ordinary revision of the newly opened deck must not clear the
      // switched-file marker and bring the overwrite button back.
      const updatedSecond = (await readFile(secondPath, 'utf8')).replace(
        'Second deck',
        'Second deck updated'
      );
      await writeFile(secondPath, updatedSecond, 'utf8');
      await expect(frameHeading(page)).toContainText('Second deck updated');

      await expect(other.getByTestId('conflict-banner')).toBeVisible();
      await expect(other.getByTestId('conflict-banner')).toContainText(
        '主機已切換到另一個檔案；只能重新載入。'
      );
      await expect(other.getByTestId('conflict-overwrite')).toHaveCount(0);
      const secondAfter = await readFile(secondPath);

      await other.getByTestId('conflict-reload').click();
      await expect(other).toHaveURL(/\/d\/second\.html$/);
      await expect(frameHeading(other)).toContainText('Second deck updated');
      await expect(other.getByTestId('conflict-banner')).toHaveCount(0);
      expect(await readFile(secondPath)).toEqual(secondAfter);
    } finally {
      releaseSave?.();
      await other?.close();
      await host?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  'moves the CLI registry so open and stop find the new deck',
  { tag: '@feature:skeleton' },
  async () => {
    test.setTimeout(120_000);
    const root = await mkdtemp(join(tmpdir(), 'htmlppt-open-registry-'));
    const home = join(root, 'home');
    // Unique deck names keep the registry assertions from colliding with any
    // other test or a developer's real session entries.
    const suffix = randomUUID();
    const firstName = `first-${suffix}.html`;
    const secondName = `second-${suffix}.html`;
    let host: StartedHost | undefined;
    try {
      await mkdir(home, { recursive: true });
      const firstPath = await createDeck(root, firstName, 2);
      const secondPath = await createSecondDeck(root, secondName);
      host = await startIsolatedHost(root, firstName, home);

      const firstReal = await realpath(firstPath);
      const secondReal = await realpath(secondPath);
      expect(
        await exists(registryFile(home, firstReal)),
        'the first deck is registered before the open'
      ).toBe(true);

      const token = new URL(host.url).searchParams.get('token');
      if (!token) throw new Error(`Host URL has no token: ${host.url}`);
      const response = await fetch(new URL('/api/open', host.url), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ path: secondPath })
      });
      expect(response.status).toBe(200);
      const opened = (await response.json()) as { filePath: string };
      expect(opened.filePath).toBe(secondReal);

      expect(await exists(registryFile(home, firstReal))).toBe(false);
      expect(await exists(registryFile(home, secondReal))).toBe(true);

      const reopened = await execa(
        'node',
        [cliPath, 'open', secondName, '--no-browser'],
        { cwd: root, env: { ...process.env, HTMLPPT_HOME: home } }
      );
      const urls = reopened.stdout.match(/HTMLPPT_URL=(\S+)/g) ?? [];
      expect(urls).toHaveLength(1);
      const nextUrl = new URL(/HTMLPPT_URL=(\S+)/.exec(reopened.stdout)?.[1] ?? '');
      expect(nextUrl.port).toBe(new URL(host.url).port);

      const stopped = await execa('node', [cliPath, 'stop', secondName], {
        cwd: root,
        env: { ...process.env, HTMLPPT_HOME: home }
      });
      expect(stopped.stdout).toContain('Stopped editor');
      await expect
        .poll(() => exists(registryFile(home, secondReal)))
        .toBe(false);
    } finally {
      await host?.stop();
      await rm(root, { recursive: true, force: true });
    }
  }
);
