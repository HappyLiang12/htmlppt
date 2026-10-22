import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDeck } from '@htmlppt/core';
import { parseDeckHtml } from '@htmlppt/core/node';
import { RUNTIME_SOURCE } from '@htmlppt/runtime';
import { describe, expect, it } from 'vitest';

const examplesDir = fileURLToPath(
  new URL('../../../skills/htmlppt/examples', import.meta.url)
);

describe('htmlppt skill examples', () => {
  it('ships only valid examples with the real runtime script', async () => {
    const names = (await readdir(examplesDir))
      .filter((name) => name.endsWith('.html'))
      .sort();
    expect(names.length).toBeGreaterThan(0);

    for (const name of names) {
      const html = await readFile(path.join(examplesDir, name), 'utf8');
      const validation = validateDeck(parseDeckHtml(html));
      expect(validation.errors, name).toEqual([]);
      expect(validation.valid, name).toBe(true);
      expect(html, name).toContain('data-ppt-runtime="1"');
      // Windows checkouts may use CRLF; compare the runtime body normalized.
      expect(html.replace(/\r\n/g, '\n'), name).toContain(
        RUNTIME_SOURCE.trim()
      );
    }
  });
});
