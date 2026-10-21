import { describe, expect, it } from 'vitest';
import { parseDeckHtml } from '../src/node.js';
import { validateDeck } from '../src/validate.js';

const deck = (body: string, title = 'Deck') =>
  parseDeckHtml(
    `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`
  );

describe('validateDeck', () => {
  it('accepts a deck with unique slide ids', () => {
    const result = validateDeck(
      deck(`<section data-slide-id="s1"></section><section data-slide-id="s2"></section>`)
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('reports duplicate slide ids', () => {
    const result = validateDeck(
      deck(`<section data-slide-id="same"></section><section data-slide-id="same"></section>`)
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'duplicate-slide-id', slideId: 'same' })
    );
  });

  it('warns when a slide has no id', () => {
    const result = validateDeck(deck(`<section class="slide"></section>`));

    expect(result.valid).toBe(true);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'missing-slide-id' })
    );
  });

  it('warns when the document has no title', () => {
    const doc = parseDeckHtml(
      '<!doctype html><html><head></head><body><section data-slide-id="s1"></section></body></html>'
    );

    const result = validateDeck(doc);

    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'missing-title' })
    );
  });

  it('rejects invalid chart JSON', () => {
    const result = validateDeck(
      deck(`<section data-slide-id="s1"><figure data-ppt-chart="{oops}"></figure></section>`)
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'invalid-chart-json', slideId: 's1' })
    );
  });

  it('rejects an empty document', () => {
    const result = validateDeck(
      parseDeckHtml(
        '<!doctype html><html><head><title>Empty</title></head><body></body></html>'
      )
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'empty-document' })
    );
  });
});
