import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenPathError, resolveDeckPath } from './open-path.js';

const directories: string[] = [];

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'htmlppt-open-path-'));
  directories.push(directory);
  return directory;
}

async function writeDeck(directory: string, name: string): Promise<string> {
  const deck = join(directory, name);
  await writeFile(deck, '<main data-ppt-deck></main>', 'utf8');
  return deck;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe('resolveDeckPath', () => {
  it('resolves a relative path against the supplied cwd', async () => {
    const directory = await makeDirectory();
    const deck = await writeDeck(directory, 'deck.html');

    await expect(resolveDeckPath('deck.html', directory, directory)).resolves.toBe(
      await realpath(deck)
    );
  });

  it('accepts a file URL wrapped in quotes and whitespace', async () => {
    const directory = await makeDirectory();
    const deck = await writeDeck(directory, 'deck.htm');

    await expect(
      resolveDeckPath(`  "${pathToFileURL(deck).href}"  `, directory, directory)
    ).resolves.toBe(await realpath(deck));
  });

  it('strips a matching single-quote pair', async () => {
    const directory = await makeDirectory();
    const deck = await writeDeck(directory, 'deck.htm');

    await expect(resolveDeckPath("'deck.htm'", directory, directory)).resolves.toBe(
      await realpath(deck)
    );
  });

  it('expands a leading tilde against the supplied home instead of cwd', async () => {
    const fixtureHome = await makeDirectory();
    const cwd = await makeDirectory();
    const deck = await writeDeck(fixtureHome, 'deck.htm');

    await expect(resolveDeckPath('~/deck.htm', cwd, fixtureHome)).resolves.toBe(
      await realpath(deck)
    );
  });

  it('accepts mixed-case .HTML and .HTM extensions', async () => {
    const directory = await makeDirectory();
    const htmlDeck = await writeDeck(directory, 'Deck.HTML');
    const htmDeck = await writeDeck(directory, 'Slides.HTM');

    await expect(resolveDeckPath('Deck.HTML', directory, directory)).resolves.toBe(
      await realpath(htmlDeck)
    );
    await expect(resolveDeckPath('Slides.HTM', directory, directory)).resolves.toBe(
      await realpath(htmDeck)
    );
  });

  it('rejects a missing file with not-found', async () => {
    const directory = await makeDirectory();

    await expect(resolveDeckPath('missing.html', directory, directory)).rejects.toMatchObject({
      code: 'not-found'
    });
  });

  it('rejects an empty or blank value with invalid-path', async () => {
    const directory = await makeDirectory();

    await expect(resolveDeckPath('', directory, directory)).rejects.toMatchObject({
      code: 'invalid-path'
    });
    await expect(resolveDeckPath('   ', directory, directory)).rejects.toMatchObject({
      code: 'invalid-path'
    });
  });

  it('rejects an unsupported extension with unsupported-extension', async () => {
    const directory = await makeDirectory();
    await writeFile(join(directory, 'notes.txt'), 'nope', 'utf8');

    await expect(resolveDeckPath('notes.txt', directory, directory)).rejects.toMatchObject({
      code: 'unsupported-extension'
    });
  });

  it('maps a path that traverses a regular file to the platform realpath error', async () => {
    const directory = await makeDirectory();
    const deck = await writeDeck(directory, 'deck.html');
    // libuv reports ENOENT on Windows (ERROR_PATH_NOT_FOUND) for a path
    // component that is a regular file, and ENOTDIR everywhere else.
    const expectedCode = process.platform === 'win32' ? 'not-found' : 'invalid-path';

    await expect(
      resolveDeckPath(join(deck, 'nested.html'), directory, directory)
    ).rejects.toHaveProperty('code', expectedCode);
  });

  it('decodes a file URL that contains spaces', async () => {
    const directory = await makeDirectory();
    const deck = await writeDeck(directory, 'deck with space.html');
    const url = pathToFileURL(deck).href;

    expect(url).toContain('%20');
    await expect(resolveDeckPath(url, directory, directory)).resolves.toBe(
      await realpath(deck)
    );
  });

  it('accepts a file URL with an upper-case scheme', async () => {
    const directory = await makeDirectory();
    const deck = await writeDeck(directory, 'deck.htm');
    const url = pathToFileURL(deck).href.replace(/^file:/, 'File:');

    expect(url.startsWith('File://')).toBe(true);
    await expect(resolveDeckPath(url, directory, directory)).resolves.toBe(
      await realpath(deck)
    );
  });

  it('does not strip a mismatched quote pair', async () => {
    const directory = await makeDirectory();
    await writeDeck(directory, 'deck.htm');

    await expect(resolveDeckPath(`"deck.htm'`, directory, directory)).rejects.toMatchObject({
      code: 'not-found'
    });
  });

  it('rejects with an OpenPathError carrying the exact code and name', async () => {
    const directory = await makeDirectory();

    const error = await resolveDeckPath('missing.html', directory, directory).then(
      () => {
        throw new Error('expected resolveDeckPath to reject');
      },
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(OpenPathError);
    expect(error).toBeInstanceOf(Error);
    const openPathError = error as OpenPathError;
    expect(openPathError.code).toBe('not-found');
    expect(openPathError.name).toBe('OpenPathError');
  });
});
