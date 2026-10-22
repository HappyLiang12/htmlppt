import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeDeck } from '../src/normalize.js';
import { parseDeckHtml } from '../src/node.js';
import { getOutline } from '../src/outline.js';
import { serializeDeck } from '../src/serialize.js';
import { validateDeck } from '../src/validate.js';

const fixtures = fileURLToPath(new URL('../../../test-utils/fixtures/', import.meta.url));

function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function readPath(path: string): string {
  return normalizeEol(readFileSync(path, 'utf8'));
}

const read = (name: string) => readPath(`${fixtures}${name}`);
const parse = (name: string) => parseDeckHtml(read(name));

describe('golden fixtures', () => {
  it.each(['basic.deck.html', 'rich.deck.html', 'messy.deck.html', 'animated.deck.html', 'external.deck.html', 'malicious.deck.html'])(
    'validation matches the golden for %s',
    (name) => {
      const result = validateDeck(parse(name));
      const expected = JSON.parse(read(name.replace('.deck.html', '.validate.expected.json')));
      expect(result).toEqual(expected);
    }
  );

  it('outline matches the golden for rich.deck.html', () => {
    expect(getOutline(parse('rich.deck.html'))).toEqual(
      JSON.parse(read('rich.outline.expected.json'))
    );
  });

  it('normalizes messy.deck.html deterministically and idempotently', () => {
    const doc = parse('messy.deck.html');
    normalizeDeck(doc);
    const once = serializeDeck(doc);
    expect(once).toBe(read('messy.normalized.expected.html'));

    const second = parseDeckHtml(once);
    const result = normalizeDeck(second);
    expect(result.changed).toBe(false);
    expect(serializeDeck(second)).toBe(once);
  });

  it('normalizes CRLF editor input to the same deck as the LF fixture', () => {
    const lf = read('messy.deck.html');
    const crlf = lf.replace(/\n/g, '\r\n');
    const serialize = (html: string) => {
      const doc = parseDeckHtml(html);
      normalizeDeck(doc);
      // Linkedom keeps CRLF in whitespace text nodes, so line endings survive
      // parsing and serialization; compare the documents modulo line endings.
      return serializeDeck(doc).replace(/\r\n?/g, '\n');
    };

    expect(serialize(crlf)).toBe(serialize(lf));
    expect(serialize(crlf)).toBe(read('messy.normalized.expected.html'));
  });

  it('normalizes CRLF fixture input through the read helper', () => {
    const directory = mkdtempSync(join(tmpdir(), 'htmlppt-golden-'));
    try {
      const file = join(directory, 'crlf.deck.html');
      writeFileSync(file, '<section>\r\n<p>CRLF</p>\r\n</section>\r\n', 'utf8');

      expect(readPath(file)).toBe('<section>\n<p>CRLF</p>\n</section>\n');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('infers the messy fixture canvas from inline styles and data attributes', () => {
    const outline = getOutline(parse('messy.deck.html'));
    expect(outline.slides[0]).toMatchObject({ width: 1280, height: 720 });
    expect(outline.slides[1]).toMatchObject({ width: 1920, height: 1080 });
    expect(outline).toMatchObject({ width: 1280, height: 720 });
  });

  it('keeps object counts and runtime presence for every fixture after normalize and serialize', () => {
    for (const name of ['basic.deck.html', 'rich.deck.html', 'messy.deck.html', 'animated.deck.html', 'external.deck.html']) {
      const doc = parse(name);
      const before = getOutline(doc);
      normalizeDeck(doc);
      const after = getOutline(parseDeckHtml(serializeDeck(doc)));
      expect(after.slideCount).toBe(before.slideCount);
      expect(after.slides.map((slide) => slide.elements.length)).toEqual(
        before.slides.map((slide) => slide.elements.length)
      );
      expect(after.runtime).toBe(before.runtime);
    }
  });

  it('handles a generated 100-slide deck without drift', () => {
    const slides = Array.from({ length: 100 }, (_, index) =>
      `<section class="slide"><h1>Slide ${index + 1}</h1></section>`
    ).join('');
    const doc = parseDeckHtml(
      `<!doctype html><html><head><title>Large</title></head><body><main data-ppt-deck>${slides}</main></body></html>`
    );
    const result = normalizeDeck(doc);
    expect(result.slides).toHaveLength(100);
    expect(result.slides[0].id).toBe('s1');
    expect(result.slides[99].id).toBe('s100');
    expect(getOutline(doc).slides[99].elements[0].text).toBe('Slide 100');
  });
});
