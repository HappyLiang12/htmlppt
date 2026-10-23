import { realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenPathError, resolveDeckPath } from './open-path.js';

const directories: string[] = [];

async function makeDirectory(): Promise<string> {
  const directory = await import('node:fs/promises').then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), 'htmlppt-open-path-'))
  );
  directories.push(directory);
  return directory;
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
    const deck = join(directory, 'deck.html');
    await writeFile(deck, '<main data-ppt-deck></main>', 'utf8');

    await expect(resolveDeckPath('deck.html', directory, directory)).resolves.toBe(
      await realpath(deck)
    );
  });

  it('accepts a file URL, quotes, whitespace, tilde, and htm', async () => {
    const directory = await makeDirectory();
    const deck = join(directory, 'deck.htm');
    await writeFile(deck, '<main data-ppt-deck></main>', 'utf8');
    const canonical = await realpath(deck);

    await expect(
      resolveDeckPath(`  "${pathToFileURL(deck).href}"  `, directory, directory)
    ).resolves.toBe(canonical);
    await expect(
      resolveDeckPath("'deck.htm'", directory, directory)
    ).resolves.toBe(canonical);
    await expect(
      resolveDeckPath('~/deck.htm', directory, directory)
    ).resolves.toBe(canonical);
  });

  it('rejects a missing file, an unsupported extension, and an empty value', async () => {
    const directory = await makeDirectory();
    await writeFile(join(directory, 'notes.txt'), 'nope', 'utf8');

    await expect(resolveDeckPath('missing.html', directory, directory)).rejects.toMatchObject({
      code: 'not-found'
    });
    await expect(resolveDeckPath('notes.txt', directory, directory)).rejects.toMatchObject({
      code: 'unsupported-extension'
    });
    await expect(resolveDeckPath('   ', directory, directory)).rejects.toMatchObject({
      code: 'invalid-path'
    });
    expect(new OpenPathError('not-found')).toBeInstanceOf(Error);
  });
});
