import { createHash } from 'node:crypto';
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
import { expect, test, type Locator, type Page } from '@playwright/test';
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

function waitForDeckSave(page: Page) {
  return page.waitForResponse(
    (response) =>
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
async function createSecondDeck(directory: string): Promise<string> {
  const path = await createDeck(directory, 'second.html', 1);
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

      // Persist the editor's initial normalization before measuring: the open
      // flow must not touch the first deck after this snapshot.
      const initialSave = waitForDeckSave(page);
      await page.keyboard.press('Control+s');
      expect((await initialSave).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
      const firstBefore = await readFile(firstPath, 'utf8');

      let openRequests = 0;
      page.on('request', (request) => {
        if (
          request.method() === 'POST' &&
          new URL(request.url()).pathname === '/api/open'
        ) {
          openRequests += 1;
        }
      });

      await pathInput(page).fill(secondPath);
      await pathInput(page).press('Enter');
      await expect(frameHeading(page)).toContainText('Second deck');
      await expect(page).toHaveURL(/\/d\/second\.html$/);
      expect(new URL(page.url()).pathname).toBe('/d/second.html');
      await expect(pathInput(page)).toHaveValue(/second\.html$/);

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
      await expect(frameHeading(page)).toContainText('Untitled deck');
      await expect(page).toHaveURL(/\/d\/first\.html$/);
      const current = await pathInput(page).inputValue();
      const requestsBefore = openRequests;
      await pathInput(page).fill(current);
      await page.getByTestId('canvas-preview').click({ position: { x: 4, y: 4 } });
      await expect(frameHeading(page)).toContainText('Untitled deck');
      await expect(page).toHaveURL(/\/d\/first\.html$/);
      expect(openRequests).toBe(requestsBefore);
    } finally {
      await host?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  'accepts a file URL and keeps the current deck on failure',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    test.setTimeout(120_000);
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-open-url-'));
    let host: StartedHost | undefined;
    try {
      await createDeck(directory, 'first.html', 2);
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

      // Escape discards the draft and restores the loaded deck path.
      await pathInput(page).fill(join(directory, 'discarded.html'));
      await pathInput(page).press('Escape');
      await expect(pathInput(page)).toHaveValue(/second\.html$/);
    } finally {
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
  'moves the CLI registry so open and stop find the new deck',
  { tag: '@feature:skeleton' },
  async () => {
    test.setTimeout(120_000);
    const root = await mkdtemp(join(tmpdir(), 'htmlppt-open-registry-'));
    const home = join(root, 'home');
    let host: StartedHost | undefined;
    try {
      await mkdir(home, { recursive: true });
      const firstPath = await createDeck(root, 'first.html', 2);
      const secondPath = await createSecondDeck(root);
      host = await startIsolatedHost(root, 'first.html', home);

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
      expect(opened.filePath).toBe(await realpath(secondPath));

      const firstReal = await realpath(firstPath);
      const secondReal = await realpath(secondPath);
      expect(await exists(registryFile(home, firstReal))).toBe(false);
      expect(await exists(registryFile(home, secondReal))).toBe(true);

      const reopened = await execa(
        'node',
        [cliPath, 'open', 'second.html', '--no-browser'],
        { cwd: root, env: { ...process.env, HTMLPPT_HOME: home } }
      );
      const urls = reopened.stdout.match(/HTMLPPT_URL=(\S+)/g) ?? [];
      expect(urls).toHaveLength(1);
      const nextUrl = new URL(/HTMLPPT_URL=(\S+)/.exec(reopened.stdout)?.[1] ?? '');
      expect(nextUrl.port).toBe(new URL(host.url).port);

      const stopped = await execa('node', [cliPath, 'stop', 'second.html'], {
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
