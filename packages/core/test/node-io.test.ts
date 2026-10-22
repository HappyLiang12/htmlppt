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

  it('keeps each snapshot internally consistent while writes race', async () => {
    const file = join(dir, 'racing.html');
    const initial = '<h1>0</h1>';
    await writeFile(file, initial, 'utf8');
    const mtimes = new Map<string, number>([[initial, (await stat(file)).mtimeMs]]);

    let writing = true;
    const mismatches: string[] = [];
    const reader = async (): Promise<void> => {
      let reads = 0;
      while (writing && reads < 2000) {
        const snapshot = await readDeckFile(file);
        reads += 1;
        if (snapshot.hash !== hashHtml(snapshot.html)) {
          mismatches.push('hash mismatch');
        }
        const expectedMtime = mtimes.get(snapshot.html);
        if (expectedMtime !== undefined && expectedMtime !== snapshot.mtimeMs) {
          mismatches.push('mtime mismatch');
        }
      }
    };
    const readers = [reader(), reader()];

    try {
      for (let index = 1; index <= 40; index += 1) {
        const html = `<h1>${index}</h1>${' '.repeat(16 * 1024)}`;
        const result = await writeDeckFileAtomic(file, html);
        mtimes.set(html, result.mtimeMs);
      }
    } finally {
      writing = false;
    }
    await Promise.all(readers);

    expect(mismatches).toEqual([]);
  });

  it('serializes compare-and-swap writers so exactly one wins', async () => {
    for (let round = 0; round < 5; round += 1) {
      const file = join(dir, `cas-${round}.html`);
      await writeFile(file, '<h1>base</h1>', 'utf8');
      const base = await readDeckFile(file);
      const htmlA = `<h1>A${round}</h1>${'a'.repeat(128 * 1024)}`;
      const htmlB = `<h1>B${round}</h1>${'b'.repeat(128 * 1024)}`;

      const results = await Promise.allSettled([
        writeDeckFileAtomic(file, htmlA, base.hash),
        writeDeckFileAtomic(file, htmlB, base.hash)
      ]);

      const fulfilled = results.flatMap((result, index) =>
        result.status === 'fulfilled' ? [index] : []
      );
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(DeckFileConflictError);
      expect(await readFile(file, 'utf8')).toBe(
        fulfilled[0] === 0 ? htmlA : htmlB
      );
    }
    expect(await readdir(dir)).toHaveLength(5);
  });

  it('cleans up the temporary file when the rename fails', async () => {
    const file = join(dir, 'deck.html');
    await mkdir(file);

    await expect(writeDeckFileAtomic(file, '<h1>Mine</h1>')).rejects.toThrow();
    expect(await readdir(dir)).toEqual(['deck.html']);
  });
});
