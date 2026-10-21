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
      deck(
        `<section data-slide-id="s1"></section><section data-slide-id="s2"></section><script data-ppt-runtime="1"></script>`
      )
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
    expect(duplicate.errors.map((error) => error.code)).toEqual(['duplicate-element-id']);
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

  it('does not count nested slides objects as duplicates of the outer slide', () => {
    const result = run(
      '<section data-slide-id="outer"><h1 data-ppt-el="e1">A</h1><section data-slide-id="inner"><p data-ppt-el="e1">B</p><p data-ppt-el="e1">C</p></section></section>'
    );

    expect(result.errors).toEqual([
      {
        severity: 'error',
        code: 'duplicate-element-id',
        message: 'Element id "e1" is used 2 times in slide "inner".',
        slideId: 'inner',
        location: 'inner > p'
      }
    ]);
  });

  it('includes a nested slide root in its own object id scan', () => {
    const result = run(
      '<section data-slide-id="outer"><section data-slide-id="inner" data-ppt-el="e1"><p data-ppt-el="e1">B</p></section></section>'
    );

    expect(result.errors).toEqual([
      {
        severity: 'error',
        code: 'duplicate-element-id',
        message: 'Element id "e1" is used 2 times in slide "inner".',
        slideId: 'inner',
        location: 'inner > section'
      }
    ]);
  });

  it('rejects invalid canvas attributes', () => {
    const result = run(
      '<section data-slide-id="s1" data-width="wide" data-height="0"></section>'
    );
    expect(result.errors.map((error) => error.code)).toEqual([
      'invalid-canvas-size',
      'invalid-canvas-size'
    ]);
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
    expect(invalid.errors.map((error) => error.code)).toEqual(['invalid-transition']);
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
    const nonScript = run(
      '<section data-slide-id="s1"><div data-ppt-runtime="1"></div></section>'
    );
    expect(nonScript.errors.map((error) => error.code)).toEqual(['invalid-runtime-marker']);
    expect(nonScript.errors).toContainEqual(
      expect.objectContaining({
        code: 'invalid-runtime-marker',
        slideId: 's1',
        location: 's1 > div'
      })
    );

    const wrongValue = run(
      '<section data-slide-id="s1"></section><script data-ppt-runtime="0"></script>'
    );
    expect(wrongValue.errors.map((error) => error.code)).toEqual(['invalid-runtime-marker']);
    expect(wrongValue.errors).toEqual([
      {
        severity: 'error',
        code: 'invalid-runtime-marker',
        message: 'Runtime marker must be data-ppt-runtime="1" on a script element.',
        location: 'script'
      }
    ]);

    const duplicate = run(
      '<section data-slide-id="s1"><script id="first" data-ppt-runtime="1"></script><script id="second" data-ppt-runtime="1"></script></section>'
    );
    expect(duplicate.errors.map((error) => error.code)).toEqual(['duplicate-runtime']);
    expect(duplicate.errors).toContainEqual(
      expect.objectContaining({
        code: 'duplicate-runtime',
        slideId: 's1',
        location: 's1 > script#second'
      })
    );
  });

  it('rejects notes that are not a direct child of a slide', () => {
    const nested = run(
      '<section data-slide-id="s1"><div><aside data-ppt-notes hidden>Nested</aside></div></section>'
    );
    expect(nested.errors.map((error) => error.code)).toEqual(['notes-nested-incorrectly']);
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

  it('accepts notes directly under the body fallback', () => {
    const result = run(
      '<aside data-ppt-notes hidden>Body notes</aside><h1>Only page</h1>'
    );

    expect(result.errors).toEqual([]);
  });

  it('rejects editor artifacts', () => {
    const result = run(
      '<section data-slide-id="s1"><h1 data-ppt-editing="true">A</h1><p data-ppt-frame-slide="abc">B</p></section>'
    );
    expect(result.errors.map((error) => error.code)).toEqual([
      'editor-artifacts',
      'editor-artifacts'
    ]);
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

describe('validateDeck warning rules', () => {
  const run = (body: string, head = '') =>
    validateDeck(
      parseDeckHtml(
        `<!doctype html><html><head><title>Deck</title>${head}</head><body>${body}</body></html>`
      )
    );

  it('warns about the single-body fallback without a missing-slide-id warning', () => {
    const result = run('<h1>Whole body</h1>');
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'single-body-fallback' })
    );
    expect(result.warnings).not.toContainEqual(
      expect.objectContaining({ code: 'missing-slide-id' })
    );
  });

  it('warns when multiple slides have no runtime', () => {
    const result = run(
      '<section data-slide-id="s1"></section><section data-slide-id="s2"></section>'
    );
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'missing-runtime' })
    );
  });

  it('does not warn about a missing runtime when one is present', () => {
    const result = run(
      '<section data-slide-id="s1"></section><section data-slide-id="s2"></section><script data-ppt-runtime="1"></script>'
    );
    expect(result.warnings).not.toContainEqual(
      expect.objectContaining({ code: 'missing-runtime' })
    );
  });

  it('warns about non-runtime scripts but allows JSON data', () => {
    const scripts = run(
      '<section data-slide-id="s1"></section><script>window.x = 1;</script>'
    );
    expect(scripts.warnings).toContainEqual(
      expect.objectContaining({ code: 'script-present' })
    );

    const json = run(
      '<section data-slide-id="s1"></section><script type="application/json">{"a":1}</script>'
    );
    expect(json.warnings).not.toContainEqual(
      expect.objectContaining({ code: 'script-present' })
    );
  });

  it('warns about relative assets in attributes and CSS', () => {
    const result = run(
      '<section data-slide-id="s1"><img src="assets/photo.png"><div style="background:url(../bg.png)"></div></section>',
      '<style>.slide { background: url("local.png"); }</style>'
    );
    const codes = result.warnings
      .filter((warning) => warning.code === 'relative-asset')
      .map((warning) => warning.message);
    expect(codes).toEqual([
      'Relative asset "assets/photo.png" is not supported; use a data: or absolute URL.',
      'Relative asset "../bg.png" is not supported; use a data: or absolute URL.',
      'Relative asset "local.png" is not supported; use a data: or absolute URL.'
    ]);
    expect(
      result.warnings.some((warning) =>
        warning.message.includes('Relative asset "data:')
      )
    ).toBe(false);
  });

  it('does not warn about data, absolute, hash, or scheme URLs', () => {
    const result = run(
      '<section data-slide-id="s1"><img src="data:image/png;base64,AA"><img src="https://example.com/a.png"><a href="#/2">x</a><a href="mailto:a@b.c">m</a></section>'
    );
    expect(result.warnings).not.toContainEqual(
      expect.objectContaining({ code: 'relative-asset' })
    );
  });

  it('warns about fixed and viewport-sized layout', () => {
    const result = run(
      '<section data-slide-id="s1"><div style="position:fixed;height:100vh"></div></section>',
      '<style>.slide { min-height: 100dvh; }</style>'
    );
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'fixed-layout', slideId: 's1' })
    );
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'fixed-layout', location: 'style' })
    );
  });

  it('warns about mixed canvas sizes', () => {
    const result = run(
      '<section data-slide-id="s1" data-width="1600" data-height="900"></section><section data-slide-id="s2" data-width="1920" data-height="1080"></section>'
    );
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'mixed-canvas-sizes' })
    );
  });

  it('warns about canvas elements and nested groups', () => {
    const result = run(
      '<section data-slide-id="s1"><canvas></canvas><div data-ppt-group><div data-ppt-group></div></div></section>'
    );
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'canvas-content', slideId: 's1' })
    );
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'unsupported-group-nesting' })
    );
  });
});
