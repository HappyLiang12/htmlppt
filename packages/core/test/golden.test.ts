import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeDeck } from '../src/normalize.js';
import { parseDeckHtml } from '../src/node.js';
import { getOutline } from '../src/outline.js';
import { serializeDeck } from '../src/serialize.js';
import { validateDeck } from '../src/validate.js';

const fixtures = fileURLToPath(new URL('../../../test-utils/fixtures/', import.meta.url));
const read = (name: string) => readFileSync(`${fixtures}${name}`, 'utf8');
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
