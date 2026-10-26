import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type Response
} from '@playwright/test';
import { execa } from 'execa';
import { startCliHost } from './helpers';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'packages/cli/dist/bin.js');

const DECK_FILE = 'deck.html';
/** The address a browser keeps after the token leaves the address bar. */
const BOOKMARK_PATH = `/d/${encodeURIComponent(DECK_FILE)}`;
const DECK_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Bookmark deck</title>
<style>.slide { width: 800px; height: 600px; background: #ffffff; }</style>
</head>
<body>
<main data-ppt-deck>
<section class="slide" data-slide-id="s1" data-width="800" data-height="600" style="width:800px;height:600px">
<h1 data-ppt-el="e1">Bookmark deck</h1>
</section>
</main>
</body>
</html>
`;

type StartedHost = Awaited<ReturnType<typeof startCliHost>>;

async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Reads the pid the CLI registered for this deck. A crash leaves this entry
 * and the credential on disk; only the token rotation in `htmlppt stop` makes
 * a saved cookie stale.
 */
async function registeredPid(home: string, deckPath: string): Promise<number> {
  const directory = join(home, 'sessions');
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.json')) continue;
    const value = JSON.parse(await readFile(join(directory, name), 'utf8')) as {
      path?: unknown;
      pid?: unknown;
    };
    if (
      typeof value.path === 'string' &&
      resolve(value.path) === resolve(deckPath) &&
      typeof value.pid === 'number'
    ) {
      return value.pid;
    }
  }
  throw new Error(`No registered editor session for ${deckPath}.`);
}

async function navigate(page: Page, url: string): Promise<Response> {
  const response = await page.goto(url);
  if (!response) {
    throw new Error(`The navigation to ${url} produced no response.`);
  }
  return response;
}

/** The editor shell, the path it serves, and the deck rendered into it. */
async function expectEditor(page: Page): Promise<void> {
  await expect(page.locator('#root')).toBeVisible();
  await expect(page.getByTestId('toolbar')).toBeVisible();
  await expect(page.getByTestId('deck-path')).toHaveValue(/deck\.html$/);
  await expect(
    page.frameLocator('iframe[title="投影片預覽"]').locator('h1')
  ).toHaveText('Bookmark deck');
}

/** The unauthorized page names the deck and the recovery command. */
async function expectRecoveryPage(
  response: Response,
  body: string,
  token: string
): Promise<void> {
  expect(response.status()).toBe(401);
  expect(response.headers()['content-type']).toContain('text/html');
  expect(body).toContain(DECK_FILE);
  expect(body).toContain('htmlppt open');
  // The page must never echo the capability secret it is asking for.
  expect(body).not.toContain(token);
}

test(
  'a bookmarked deck URL survives a browser restart and a host crash',
  { tag: '@feature:live-sync' },
  async ({ browser }) => {
    test.setTimeout(180_000);
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-auto-login-'));
    const home = join(directory, 'home');
    const deckPath = join(directory, DECK_FILE);
    const env = { ...process.env, HTMLPPT_HOME: home };
    const open = () => startCliHost(cliPath, directory, deckPath, { home });
    const contexts: BrowserContext[] = [];
    const hosts: StartedHost[] = [];
    try {
      await writeFile(deckPath, DECK_HTML, 'utf8');

      const first = await open();
      hosts.push(first);
      const origin = new URL(first.url).origin;
      const token = new URL(first.url).searchParams.get('token');
      if (!token) throw new Error(`Host URL has no token: ${first.url}`);

      // The tokenized visit signs the browser in: the token leaves the address
      // bar and the HttpOnly cookie remains the bookmarkable state.
      const context = await browser.newContext();
      contexts.push(context);
      const page = await context.newPage();
      await page.goto(first.url);
      await expect(page).toHaveURL(`${origin}${BOOKMARK_PATH}`);
      expect(new URL(page.url()).searchParams.has('token')).toBe(false);
      await expectEditor(page);
      const savedState = await context.storageState();
      const sessionCookie = savedState.cookies.find(
        (cookie) => cookie.name === 'htmlppt_token' && cookie.httpOnly
      );
      expect(
        sessionCookie,
        'the token exchange left an HttpOnly session cookie'
      ).toBeTruthy();
      expect(sessionCookie?.domain).toBe('127.0.0.1');
      const cookieSeconds = (sessionCookie?.expires ?? 0) - Date.now() / 1000;
      expect(cookieSeconds).toBeGreaterThan(29 * 24 * 60 * 60);
      expect(cookieSeconds).toBeLessThanOrEqual(31 * 24 * 60 * 60);
      await context.close();

      // Simulate a crash or reboot: kill the host without `htmlppt stop`, so
      // its graceful shutdown and token rotation never run. The registry entry
      // and the credential survive on disk, and the registry still names a
      // dead pid.
      const crashedPid = await registeredPid(home, deckPath);
      expect(await isProcessAlive(crashedPid)).toBe(true);
      process.kill(crashedPid, 'SIGKILL');
      await expect
        .poll(() => isProcessAlive(crashedPid), {
          message: 'the host process is gone after the simulated crash'
        })
        .toBe(false);

      // The next open reuses the recorded port and token, so the bookmark and
      // its cookie still resolve to the same host identity.
      const restarted = await open();
      hosts.push(restarted);
      const restartedUrl = new URL(restarted.url);
      expect(restartedUrl.port).toBe(new URL(first.url).port);
      expect(restartedUrl.searchParams.get('token')).toBe(token);

      // A fresh browser with only the saved storage state, no token in the URL.
      const restored = await browser.newContext({ storageState: savedState });
      contexts.push(restored);
      const bookmarked = await restored.newPage();
      const loaded = await navigate(bookmarked, `${origin}${BOOKMARK_PATH}`);
      expect(loaded.status()).toBe(200);
      await expectEditor(bookmarked);
      await bookmarked.close();

      // A real stop rotates the token and keeps the port.
      const stopped = await execa('node', [cliPath, 'stop', deckPath], {
        cwd: directory,
        env
      });
      expect(stopped.exitCode).toBe(0);
      expect(stopped.stdout).toContain('Stopped editor');
      await restarted.stop();

      // The recovery the 401 page tells the user to perform: one more open.
      // It starts a fresh host on the recorded port with the rotated token.
      const reopened = await open();
      hosts.push(reopened);
      const reopenedUrl = new URL(reopened.url);
      expect(reopenedUrl.port).toBe(new URL(first.url).port);
      const rotatedToken = reopenedUrl.searchParams.get('token');
      if (!rotatedToken) throw new Error(`Host URL has no token: ${reopened.url}`);
      expect(rotatedToken).not.toBe(token);

      // Positive control: the rotated token signs in, so the 401 below is the
      // rotation rejecting the saved cookie, not a dead or broken host.
      const fresh = await browser.newContext();
      contexts.push(fresh);
      const freshPage = await fresh.newPage();
      await freshPage.goto(reopened.url);
      await expectEditor(freshPage);
      await fresh.close();

      const stale = await restored.newPage();
      const denied = await navigate(stale, `${origin}${BOOKMARK_PATH}`);
      await expectRecoveryPage(denied, await denied.text(), rotatedToken);
    } finally {
      for (const context of contexts) {
        await context.close().catch(() => undefined);
      }
      for (const host of hosts) {
        await host.stop().catch(() => undefined);
      }
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  'an unauthenticated document request gets the recovery page, not JSON',
  { tag: '@feature:live-sync' },
  async ({ browser }) => {
    test.setTimeout(120_000);
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-auto-login-401-'));
    const deckPath = join(directory, DECK_FILE);
    let host: StartedHost | undefined;
    let context: BrowserContext | undefined;
    try {
      await writeFile(deckPath, DECK_HTML, 'utf8');
      host = await startCliHost(cliPath, directory, deckPath);
      const origin = new URL(host.url).origin;
      const token = new URL(host.url).searchParams.get('token');
      if (!token) throw new Error(`Host URL has no token: ${host.url}`);

      // A browser with no cookies and no query token reaches the bare origin.
      context = await browser.newContext();
      const page = await context.newPage();
      const response = await navigate(page, `${origin}/`);
      const body = await response.text();
      await expectRecoveryPage(response, body, token);
      expect(response.headers()['content-type']).not.toContain(
        'application/json'
      );
      expect(body.trimStart().startsWith('<!doctype html>')).toBe(true);
      expect(body).toContain('<h1>');
    } finally {
      await context?.close().catch(() => undefined);
      await host?.stop().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  }
);
