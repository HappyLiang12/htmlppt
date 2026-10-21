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

  it('reports the slide count as info', () => {
    const result = validateDeck(
      deck(`<section data-slide-id="s1"></section><section data-slide-id="s2"></section>`)
    );

    expect(result.info).toEqual([
      { severity: 'info', code: 'slide-count', message: '2 slide(s) detected.' }
    ]);
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

  it('warns when the title is only whitespace', () => {
    const doc = parseDeckHtml(
      '<!doctype html><html><head><title>   </title></head><body><section data-slide-id="s1"></section></body></html>'
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
    expect(result.warnings).toEqual([]);
    expect(result.info).toEqual([
      { severity: 'info', code: 'slide-count', message: '0 slide(s) detected.' }
    ]);
  });
});

describe('validateDeck error rules', () => {
  const run = (body: string) =>
    validateDeck(
      parseDeckHtml(
        `<!doctype html><html><head><title>Deck</title></head><body>${body}</body></html>`
      )
    );

  it('rejects duplicate element ids within a slide but allows them across slides', () => {
    const duplicate = run(
      '<section data-slide-id="s1"><h1 data-ppt-el="e1">A</h1><p data-ppt-el="e1">B</p></section>'
    );
    expect(duplicate.errors).toContainEqual(
      expect.objectContaining({
        code: 'duplicate-element-id',
        slideId: 's1',
        location: 's1 > h1'
      })
    );

    const across = run(
      '<section data-slide-id="s1"><h1 data-ppt-el="e1">A</h1></section><section data-slide-id="s2"><h1 data-ppt-el="e1">B</h1></section>'
    );
    expect(across.errors).toEqual([]);
  });

  it('rejects invalid canvas attributes', () => {
    const result = run(
      '<section data-slide-id="s1" data-width="wide" data-height="0"></section>'
    );
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'invalid-canvas-size',
        slideId: 's1',
        message: 'Slide canvas width "wide" is not a positive number.'
      })
    );
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'invalid-canvas-size',
        slideId: 's1',
        message: 'Slide canvas height "0" is not a positive number.'
      })
    );
  });

  it('rejects invalid transitions and accepts the contract values', () => {
    const invalid = run(
      '<section data-slide-id="s1" data-ppt-transition="zoom"></section>'
    );
    expect(invalid.errors).toContainEqual(
      expect.objectContaining({
        code: 'invalid-transition',
        slideId: 's1',
        location: 's1'
      })
    );

    for (const value of ['none', 'fade', 'slide']) {
      expect(
        run(`<section data-slide-id="s1" data-ppt-transition="${value}"></section>`).errors
      ).toEqual([]);
    }
  });

  it('rejects invalid and duplicate runtime markers', () => {
    const nonScript = run('<div data-ppt-runtime="1"></div><section data-slide-id="s1"></section>');
    expect(nonScript.errors).toContainEqual(
      expect.objectContaining({ code: 'invalid-runtime-marker' })
    );

    const wrongValue = run(
      '<section data-slide-id="s1"></section><script data-ppt-runtime="0"></script>'
    );
    expect(wrongValue.errors).toContainEqual(
      expect.objectContaining({ code: 'invalid-runtime-marker' })
    );

    const duplicate = run(
      '<section data-slide-id="s1"></section><script data-ppt-runtime="1"></script><script data-ppt-runtime="1"></script>'
    );
    expect(duplicate.errors).toContainEqual(
      expect.objectContaining({ code: 'duplicate-runtime' })
    );
  });

  it('rejects notes that are not a direct child of a slide', () => {
    const nested = run(
      '<section data-slide-id="s1"><div><aside data-ppt-notes hidden>Nested</aside></div></section>'
    );
    expect(nested.errors).toContainEqual(
      expect.objectContaining({
        code: 'notes-nested-incorrectly',
        slideId: 's1',
        location: 's1 > aside'
      })
    );

    const direct = run(
      '<section data-slide-id="s1"><aside data-ppt-notes hidden>Direct</aside></section>'
    );
    expect(direct.errors).toEqual([]);
  });

  it('rejects editor artifacts', () => {
    const result = run(
      '<section data-slide-id="s1"><h1 data-ppt-editing="true">A</h1><p data-ppt-frame-slide="abc">B</p></section>'
    );
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'editor-artifacts',
        message: 'Editor-only attribute "data-ppt-editing" is present.'
      })
    );
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'editor-artifacts',
        message: 'Editor-only attribute "data-ppt-frame-slide" is present.'
      })
    );
  });
});
