import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveExportDirectory,
  verifyExportDirectory
} from '../src/export-path.js';

let directory: string | undefined;

afterEach(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

describe('export directory confinement', () => {
  it('keeps the deck spelling after the canonical containment check', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'htmlppt-export-path-'));
    const deckPath = path.join(directory, 'deck.html');
    await writeFile(deckPath, '<!doctype html>', 'utf8');

    const resolved = await resolveExportDirectory(deckPath, 'exports');

    expect(resolved).toBe(path.join(directory, 'exports'));
    await mkdir(resolved!, { recursive: true });
    await expect(verifyExportDirectory(deckPath, resolved!)).resolves.toBeTruthy();
  });

  it('rejects a directory outside the deck directory', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'htmlppt-export-path-'));
    const deckPath = path.join(directory, 'deck.html');
    await writeFile(deckPath, '<!doctype html>', 'utf8');

    await expect(resolveExportDirectory(deckPath, '..')).resolves.toBeNull();
  });
});
