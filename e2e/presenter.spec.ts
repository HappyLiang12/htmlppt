import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { RUNTIME_SOURCE } from '../packages/runtime/dist/index.js';
import { serveHtml, startCliHost } from './helpers';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'packages/cli', 'dist', 'bin.js');
const PLAY_FRAME = 'iframe[data-testid="play-frame"]';

const readAnimationName = (element: unknown) => {
  const scope = element as {
    ownerDocument: {
      defaultView: {
        getComputedStyle(node: unknown): { animationName: string };
      } | null;
    };
  };
  const view = scope.ownerDocument.defaultView;
  if (!view) throw new Error('Slide has no window.');
  return view.getComputedStyle(element).animationName;
};

interface DeckHarness {
  directory: string;
  host: Awaited<ReturnType<typeof startCliHost>>;
}

const editorDeck = (label: string, notes: string[]): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${label}</title>
<style>
  html, body { margin: 0; padding: 0; }
  .slide {
    width: 1600px;
    height: 900px;
    position: relative;
    overflow: hidden;
    background: #f7f5ef;
    color: #17181c;
    font-family: Inter, sans-serif;
  }
  h1 { position: absolute; left: 120px; top: 200px; font-size: 96px; }
  button { position: absolute; left: 120px; top: 360px; font-size: 32px; }
  .role-control { position: absolute; left: 120px; top: 440px; font-size: 32px; }
</style>
</head>
<body>
<main data-ppt-deck>
  <section class="slide" data-slide-id="s1" data-width="1600" data-height="900">
    <h1>${label} one</h1>
    <button type="button">Deck control</button>
    <div class="role-control" role="button" tabindex="0">Role control</div>
    <aside data-ppt-notes>${notes[0]}</aside>
  </section>
  <section class="slide" data-slide-id="s2" data-width="1600" data-height="900" data-ppt-transition="fade">
    <h1>${label} two</h1>
    <button type="button">Deck control</button>
    <div class="role-control" role="button" tabindex="0">Role control</div>
    <aside data-ppt-notes>${notes[1]}</aside>
  </section>
  <section class="slide" data-slide-id="s3" data-width="1600" data-height="900" data-ppt-transition="slide">
    <h1>${label} three</h1>
    <button type="button">Deck control</button>
    <div class="role-control" role="button" tabindex="0">Role control</div>
    <aside data-ppt-notes>${notes[2]}</aside>
  </section>
</main>
</body>
</html>`;

const runtimeDeck = (label: string, notes: string[]): string =>
  editorDeck(label, notes).replace(
    '</main>',
    `</main>\n<script data-ppt-runtime="1">${RUNTIME_SOURCE}</script>`
  );

async function openEditorDeck(
  page: Page,
  options: { label?: string; notes?: string[] } = {}
): Promise<DeckHarness> {
  const directory = await mkdtemp(join(tmpdir(), 'htmlppt-presenter-'));
  const html = editorDeck(
    options.label ?? 'Presenter',
    options.notes ?? ['Notes one', 'Notes two', 'Notes three']
  );
  await writeFile(join(directory, 'presenter.deck.html'), html, 'utf8');
  const host = await startCliHost(cliPath, directory, 'presenter.deck.html');
  await page.goto(host.url);
  await expect(page.getByTestId('save-status')).toHaveText('已同步');
  return { directory, host };
}

async function closeEditor(harness: DeckHarness): Promise<void> {
  await harness.host.stop();
  await rm(harness.directory, { recursive: true, force: true });
}

function playFrame(page: Page) {
  return page.frameLocator(PLAY_FRAME);
}

test(
  'presenter popup mirrors notes, next slide, timer, and two-way navigation',
  { tag: '@feature:presenter' },
  async ({ page }) => {
    const harness = await openEditorDeck(page);
    try {
      await page.keyboard.press('F5');
      await expect(page.getByTestId('play-view')).toBeVisible();
      await expect(playFrame(page).locator('h1')).toHaveText('Presenter one');
      await expect(playFrame(page).locator('[data-ppt-notes]')).toBeHidden();

      const popupPromise = page.waitForEvent('popup');
      await page.getByTestId('presenter-open').click();
      const presenter = await popupPromise;
      try {
        await expect(presenter.getByTestId('presenter-view')).toBeVisible();
        await expect(presenter.getByTestId('presenter-status')).toHaveText(
          '已連線'
        );
        await expect(presenter.getByTestId('presenter-notes')).toHaveText(
          'Notes one'
        );
        await expect(
          presenter.getByTestId('presenter-next-preview')
        ).toContainText('Presenter two');

        const firstTimer = await presenter
          .getByTestId('presenter-timer')
          .textContent();
        await expect
          .poll(
            () => presenter.getByTestId('presenter-timer').textContent(),
            { timeout: 5_000 }
          )
          .not.toBe(firstTimer);

        await presenter.getByTestId('presenter-next').click();
        await expect(playFrame(page).locator('h1')).toHaveText('Presenter two');
        await expect(presenter.getByTestId('presenter-notes')).toHaveText(
          'Notes two'
        );

        await page.keyboard.press('ArrowRight');
        await expect(playFrame(page).locator('h1')).toHaveText(
          'Presenter three'
        );
        await expect(presenter.getByTestId('presenter-notes')).toHaveText(
          'Notes three'
        );
        await expect(presenter.getByTestId('presenter-next')).toBeDisabled();

        await presenter.getByTestId('presenter-prev').click();
        await expect(playFrame(page).locator('h1')).toHaveText('Presenter two');
      } finally {
        await presenter.close();
      }

      // Closing the presenter must not break the play surface.
      await expect(page.getByTestId('play-view')).toBeVisible();
      await page.keyboard.press('ArrowRight');
      await expect(playFrame(page).locator('h1')).toHaveText('Presenter three');

      await page.keyboard.press('Escape');
      await expect(page.getByTestId('toolbar')).toBeVisible();
      await expect(page.getByTestId('thumbnail').nth(2)).toHaveAttribute(
        'aria-current',
        'page'
      );
    } finally {
      await closeEditor(harness);
    }
  }
);

test(
  'blocked presenter popups and denied fullscreen keep play usable',
  { tag: '@feature:presenter' },
  async ({ page }) => {
    const harness = await openEditorDeck(page);
    try {
      // Deny fullscreen and popups before the presentation starts.
      await page.evaluate(
        "Object.defineProperty(document.documentElement, 'requestFullscreen', { configurable: true, value: () => Promise.reject(new Error('denied')) })"
      );
      await page.evaluate('window.open = () => null');

      await page.keyboard.press('F5');
      await expect(page.getByTestId('play-view')).toBeVisible();
      await expect(page.getByTestId('play-view')).toHaveAttribute(
        'data-fullscreen',
        'unavailable'
      );
      await expect(page.getByTestId('fullscreen-warning')).toBeVisible();
      await expect(page.getByTestId('fullscreen-warning')).toContainText(
        '全螢幕'
      );

      await page.getByTestId('presenter-open').click();
      await expect(page.getByTestId('presenter-error')).toBeVisible();
      await expect(page.getByTestId('presenter-error')).toContainText(
        '彈出視窗'
      );

      await page.keyboard.press('ArrowRight');
      await expect(playFrame(page).locator('h1')).toHaveText('Presenter two');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('toolbar')).toBeVisible();
    } finally {
      await closeEditor(harness);
    }
  }
);

test(
  'play honors authored fade and slide transitions and removes them for reduced motion',
  { tag: '@feature:presenter' },
  async ({ page }) => {
    const harness = await openEditorDeck(page);
    try {
      await page.keyboard.press('F5');
      await expect(page.getByTestId('play-view')).toHaveAttribute(
        'data-fullscreen',
        'active'
      );
      expect(await page.evaluate('document.fullscreenElement !== null')).toBe(
        true
      );
      const slide = page.getByTestId('play-slide');
      await expect(slide).toHaveAttribute('data-transition', 'none');

      await page.keyboard.press('ArrowRight');
      await expect(slide).toHaveAttribute('data-transition', 'fade');
      await expect(slide).toHaveClass(/play-slide--fade/);
      expect(await slide.evaluate(readAnimationName)).toBe(
        'htmlppt-play-fade'
      );

      await page.keyboard.press('ArrowRight');
      await expect(slide).toHaveAttribute('data-transition', 'slide');
      expect(await slide.evaluate(readAnimationName)).toBe(
        'htmlppt-play-slide'
      );

      await page.keyboard.press('Escape');
      await expect(page.getByTestId('toolbar')).toBeVisible();
      expect(await page.evaluate('document.fullscreenElement === null')).toBe(
        true
      );

      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.keyboard.press('F5');
      await page.keyboard.press('ArrowRight');
      await expect(page.getByTestId('play-slide')).toHaveAttribute(
        'data-transition',
        'fade'
      );
      expect(
        await page.getByTestId('play-slide').evaluate(readAnimationName)
      ).toBe('none');
    } finally {
      await closeEditor(harness);
    }
  }
);

test(
  'play advances on noninteractive clicks without hijacking deck controls',
  { tag: '@feature:presenter' },
  async ({ page }) => {
    const harness = await openEditorDeck(page);
    try {
      await page.keyboard.press('F5');
      const play = playFrame(page);
      await expect(play.locator('h1')).toHaveText('Presenter one');
      await play.locator('button').click();
      await expect(play.locator('h1')).toHaveText('Presenter one');
      await play.locator('.role-control').click();
      await expect(play.locator('h1')).toHaveText('Presenter one');
      await play.locator('button').focus();
      await expect(play.locator('button')).toBeFocused();
      await page.keyboard.press('Space');
      await expect(play.locator('h1')).toHaveText('Presenter one');
      await play.locator('h1').click();
      await expect(play.locator('h1')).toHaveText('Presenter two');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('toolbar')).toBeVisible();
    } finally {
      await closeEditor(harness);
    }
  }
);

test(
  'exported runtime presenter, transitions, and fullscreen fallback work without the editor',
  { tag: '@feature:presenter' },
  async ({ page }) => {
    const server = await serveHtml(
      runtimeDeck('Runtime', ['Runtime notes one', 'Runtime notes two', 'Runtime notes three'])
    );
    try {
      await page.goto(server.url);
      await expect(
        page.locator('[data-slide-id="s1"] [data-ppt-notes]')
      ).toBeHidden();
      await page.keyboard.press('ArrowRight');
      const second = page.locator('[data-slide-id="s2"]');
      await expect(second).toBeVisible();
      await expect(second).toHaveClass(/htmlppt-runtime-fade/);
      expect(await second.evaluate(readAnimationName)).toBe(
        'htmlppt-runtime-fade'
      );

      await page.keyboard.press('f');
      await expect
        .poll(() => page.evaluate('document.fullscreenElement !== null'))
        .toBe(true);
      await page.keyboard.press('f');
      await expect
        .poll(() => page.evaluate('document.fullscreenElement !== null'))
        .toBe(false);

      await page.locator('[data-slide-id="s2"] button').click();
      await expect(page.locator('[data-slide-id="s2"]')).toBeVisible();
      await page.locator('[data-slide-id="s2"] button').focus();
      await page.keyboard.press('Space');
      await expect(page.locator('[data-slide-id="s2"]')).toBeVisible();
      await page.locator('[data-slide-id="s2"] h1').click();
      await expect(page.locator('[data-slide-id="s3"]')).toBeVisible();
      expect(page.url()).toContain('#/3');
      await page.keyboard.press('ArrowLeft');
      await expect(page.locator('[data-slide-id="s2"]')).toBeVisible();

      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.keyboard.press('Home');
      await page.keyboard.press('ArrowRight');
      await expect(second).toBeVisible();
      await expect(second).not.toHaveClass(/htmlppt-runtime-fade/);
      expect(await second.evaluate(readAnimationName)).toBe('none');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.keyboard.press('Home');
      await page.keyboard.press('ArrowRight');
      await expect(second).toHaveClass(/htmlppt-runtime-fade/);

      const popupPromise = page.waitForEvent('popup');
      await page.keyboard.press('p');
      const presenter = await popupPromise;
      try {
        await expect(presenter.getByTestId('presenter-view')).toBeVisible();
        await expect(presenter.getByTestId('presenter-status')).toHaveText(
          '已連線'
        );
        await expect(presenter.getByTestId('presenter-notes')).toHaveText(
          'Runtime notes two'
        );
        await expect(
          presenter.getByTestId('presenter-next-preview')
        ).toContainText('Runtime three');

        await presenter.getByTestId('presenter-next').click();
        await expect(page.locator('[data-slide-id="s3"]')).toBeVisible();
        await expect(presenter.getByTestId('presenter-notes')).toHaveText(
          'Runtime notes three'
        );

        await page.keyboard.press('ArrowLeft');
        await expect(page.locator('[data-slide-id="s2"]')).toBeVisible();
        await expect(presenter.getByTestId('presenter-notes')).toHaveText(
          'Runtime notes two'
        );
      } finally {
        await presenter.close();
      }

      // The exported deck keeps navigating after the presenter closes.
      await page.keyboard.press('ArrowRight');
      await expect(page.locator('[data-slide-id="s3"]')).toBeVisible();

      await page.evaluate(
        "Object.defineProperty(document.documentElement, 'requestFullscreen', { configurable: true, value: () => Promise.reject(new Error('denied')) })"
      );
      await page.keyboard.press('f');
      await expect(page.getByTestId('runtime-notice')).toBeVisible();
      await expect(page.getByTestId('runtime-notice')).toContainText('全螢幕');
    } finally {
      await server.close();
    }
  }
);

test(
  'exported runtime previews the authored canvas size and keeps presenting when popups are blocked',
  { tag: '@feature:presenter' },
  async ({ page }) => {
    const deck = runtimeDeck('Sized', ['One', 'Two', 'Three']).replaceAll(
      'data-width="1600" data-height="900"',
      'data-width="800" data-height="600"'
    );
    const server = await serveHtml(deck);
    try {
      await page.goto(server.url);
      const popupPromise = page.waitForEvent('popup');
      await page.keyboard.press('p');
      const presenter = await popupPromise;
      try {
        const preview = presenter.getByTestId('presenter-next-preview');
        await expect(preview).toContainText('Sized two');
        await expect(preview.locator('iframe')).toHaveAttribute(
          'style',
          /width: 800px/
        );
        await expect(preview.locator('.preview-holder')).toHaveAttribute(
          'style',
          /height: 240px/
        );
      } finally {
        await presenter.close();
      }

      await page.evaluate('window.open = () => null');
      await page.keyboard.press('p');
      await expect(page.getByTestId('runtime-notice')).toContainText('簡報');
      await page.keyboard.press('ArrowRight');
      await expect(page.locator('[data-slide-id="s2"]')).toBeVisible();
    } finally {
      await server.close();
    }
  }
);

test(
  'two same-origin decks keep presenter sessions isolated',
  { tag: '@feature:presenter' },
  async ({ page, context }) => {
    const deckA = runtimeDeck('Alpha', [
      'Alpha notes one',
      'Alpha notes two',
      'Alpha notes three'
    ]);
    const deckB = runtimeDeck('Beta', [
      'Beta notes one',
      'Beta notes two',
      'Beta notes three'
    ]);
    const server = createServer((request, response) => {
      const html = request.url?.startsWith('/b') ? deckB : deckA;
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Missing server address.');
    }
    const base = `http://127.0.0.1:${address.port}`;
    const pageB = await context.newPage();
    try {
      await page.goto(`${base}/a`);
      await pageB.goto(`${base}/b`);

      const popupA = page.waitForEvent('popup');
      await page.keyboard.press('p');
      const presenterA = await popupA;
      const popupB = pageB.waitForEvent('popup');
      await pageB.keyboard.press('p');
      const presenterB = await popupB;
      try {
        await expect(presenterA.getByTestId('presenter-notes')).toHaveText(
          'Alpha notes one'
        );
        await expect(presenterB.getByTestId('presenter-notes')).toHaveText(
          'Beta notes one'
        );

        await page.keyboard.press('ArrowRight');
        await expect(page.locator('[data-slide-id="s2"]')).toBeVisible();
        await expect(presenterA.getByTestId('presenter-notes')).toHaveText(
          'Alpha notes two'
        );

        // The other same-origin deck must be untouched.
        await expect(pageB.locator('[data-slide-id="s1"]')).toBeVisible();
        await expect(presenterB.getByTestId('presenter-notes')).toHaveText(
          'Beta notes one'
        );
      } finally {
        await presenterA.close();
        await presenterB.close();
      }
    } finally {
      await pageB.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  }
);

test(
  'closing the editor closes the presenter window',
  { tag: '@feature:presenter' },
  async ({ page }) => {
    const harness = await openEditorDeck(page);
    try {
      await page.keyboard.press('F5');
      await expect(playFrame(page).locator('h1')).toHaveText('Presenter one');
      const popupPromise = page.waitForEvent('popup');
      await page.keyboard.press('p');
      const presenter = await popupPromise;
      await expect(presenter.getByTestId('presenter-status')).toHaveText(
        '已連線'
      );

      await page.close();
      await expect.poll(() => presenter.isClosed(), { timeout: 5_000 }).toBe(
        true
      );
    } finally {
      await closeEditor(harness);
    }
  }
);
