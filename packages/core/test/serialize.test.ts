import { RUNTIME_SOURCE } from '@htmlppt/runtime';
import { describe, expect, it } from 'vitest';
import { parseDeckHtml } from '../src/node.js';
import { serializeDeck, serializeExport } from '../src/serialize.js';

const source = `<!doctype html><html><head><title>Deck</title><style>.slide{color:red}</style></head><body><section data-slide-id="s1"><h1>Hello</h1></section><script>window.deck = 1;</script></body></html>`;

const twoSlide = `<!doctype html><html><head><title>Deck</title><style>.slide{color:red}</style></head><body><main data-ppt-deck><section data-slide-id="s1"><h1>One</h1></section><section data-slide-id="s2"><h1>Two</h1></section></main></body></html>`;

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
    expect(
      html.startsWith('<!doctype html>\n<!-- Edited with htmlppt. Format: htmldeck/v1. -->')
    ).toBe(true);
    expect(
      html.match(/<!-- Edited with htmlppt\. Format: htmldeck\/v1\. -->/g)
    ).toHaveLength(1);
  });

  it('injects the runtime once for a multi-slide export', () => {
    const doc = parseDeckHtml(twoSlide);
    const html = serializeExport(doc);

    expect(html.match(/data-ppt-runtime="1"/g)).toHaveLength(1);
    expect(html).toContain(RUNTIME_SOURCE);
    expect(html).toContain('<!-- Edited with htmlppt. Format: htmldeck/v1. -->');
    expect(html.indexOf('data-ppt-runtime="1"')).toBeLessThan(
      html.indexOf('</body>')
    );
    expect(doc.querySelector('[data-ppt-runtime="1"]')).toBeNull();
  });

  it('does not inject the runtime into a multi-slide deck with its own script', () => {
    const customScript = '<script>window.customNavigation = true;</script>';
    const deck = twoSlide.replace('</body>', `${customScript}</body>`);
    const html = serializeExport(parseDeckHtml(deck));

    expect(html.match(/data-ppt-runtime="1"/g)).toBeNull();
    expect(html).toContain(customScript);
    expect(html).not.toContain(RUNTIME_SOURCE);
  });

  it('does not duplicate an existing runtime', () => {
    const deck = twoSlide.replace(
      '</main>',
      '</main><script data-ppt-runtime="1">/* deck runtime */</script>'
    );
    const html = serializeExport(parseDeckHtml(deck));

    expect(html.match(/data-ppt-runtime="1"/g)).toHaveLength(1);
    expect(html).toContain('/* deck runtime */');
  });

  it('leaves a single-slide export without a runtime', () => {
    const html = serializeExport(parseDeckHtml(source));

    expect(html).not.toContain('data-ppt-runtime');
  });
});
