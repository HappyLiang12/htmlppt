import { describe, expect, it } from 'vitest';
import { parseDeckHtml } from '../src/node.js';
import { serializeDeck, serializeExport } from '../src/serialize.js';

const source = `<!doctype html><html><head><title>Deck</title><style>.slide{color:red}</style></head><body><section data-slide-id="s1"><h1>Hello</h1></section><script>window.deck = 1;</script></body></html>`;

describe('serialization', () => {
  it('adds a doctype and preserves head, styles, and scripts', () => {
    const html = serializeDeck(parseDeckHtml(source));

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<style>.slide{color:red}</style>');
    expect(html).toContain('<script>window.deck = 1;</script>');
  });

  it('is idempotent', () => {
    const once = serializeDeck(parseDeckHtml(source));
    const twice = serializeDeck(parseDeckHtml(once));

    expect(twice).toBe(once);
  });

  it('adds a generator comment for exports', () => {
    const html = serializeExport(parseDeckHtml(source));

    expect(html).toContain('<!-- Edited with htmlppt. Format: htmldeck/v1. -->');
  });
});
