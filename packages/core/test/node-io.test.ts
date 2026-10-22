import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DeckFileConflictError,
  hashHtml,
  readDeckFile,
  writeDeckFileAtomic
} from '../src/node.js';

describe('node deck I/O', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'htmlppt-io-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('hashes deterministically and reads snapshots', async () => {
    const file = join(dir, 'deck.html');
    await writeFile(file, '<h1>One</h1>', 'utf8');

    const snapshot = await readDeckFile(file);

    expect(snapshot.html).toBe('<h1>One</h1>');
    expect(snapshot.hash).toBe(hashHtml('<h1>One</h1>'));
    expect(snapshot.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.mtimeMs).toBe((await stat(file)).mtimeMs);
  });

  it('writes atomically and returns the new hash', async () => {
    const file = join(dir, 'deck.html');
    await writeFile(file, '<h1>One</h1>', 'utf8');
    const before = await readDeckFile(file);

    const result = await writeDeckFileAtomic(file, '<h1>Two</h1>', before.hash);

    expect(await readFile(file, 'utf8')).toBe('<h1>Two</h1>');
    expect(result.hash).toBe(hashHtml('<h1>Two</h1>'));
    expect(result.mtimeMs).toBe((await stat(file)).mtimeMs);
    expect(await readdir(dir)).toEqual(['deck.html']);
  });

  it('rejects a stale expected hash without touching the file', async () => {
    const file = join(dir, 'deck.html');
    await writeFile(file, '<h1>External</h1>', 'utf8');

    const error = await writeDeckFileAtomic(
      file,
      '<h1>Mine</h1>',
      hashHtml('<h1>Old</h1>')
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(DeckFileConflictError);
    expect(error).toMatchObject({ code: 'conflict' });
    expect(await readFile(file, 'utf8')).toBe('<h1>External</h1>');
    expect(await readdir(dir)).toEqual(['deck.html']);
  });

  it('treats a missing file as a conflict when a hash is expected', async () => {
    const file = join(dir, 'deck.html');

    await expect(
      writeDeckFileAtomic(file, '<h1>Mine</h1>', hashHtml('<h1>Old</h1>'))
    ).rejects.toBeInstanceOf(DeckFileConflictError);
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(dir)).toEqual([]);
  });

  it('writes without an expected hash', async () => {
    const file = join(dir, 'deck.html');
    await writeFile(file, '<h1>One</h1>', 'utf8');

    const result = await writeDeckFileAtomic(file, '<h1>Two</h1>');

    expect(await readFile(file, 'utf8')).toBe('<h1>Two</h1>');
    expect(result.hash).toBe(hashHtml('<h1>Two</h1>'));
  });

  it('cleans up the temporary file when the rename fails', async () => {
    const file = join(dir, 'deck.html');
    await mkdir(file);

    await expect(writeDeckFileAtomic(file, '<h1>Mine</h1>')).rejects.toThrow();
    expect(await readdir(dir)).toEqual(['deck.html']);
  });
});
