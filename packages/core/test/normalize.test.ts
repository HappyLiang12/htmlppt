import { describe, expect, it } from 'vitest';
import { normalizeDeck } from '../src/normalize.js';
import { parseDeckHtml } from '../src/node.js';
import { serializeDeck } from '../src/serialize.js';

const deck = (body: string) =>
  parseDeckHtml(
    `<!doctype html><html><head><title>Deck</title><style>.slide{color:red}</style></head><body>${body}</body></html>`
  );

describe('normalizeDeck', () => {
  it('assigns missing slide ids in order', () => {
    const doc = deck(
      '<section class="slide"></section><section class="slide"></section><section class="slide"></section>'
    );

    const result = normalizeDeck(doc);

    expect(result.changed).toBe(true);
    expect(
      Array.from(doc.querySelectorAll('[data-slide-id]')).map((slide) =>
        slide.getAttribute('data-slide-id')
      )
    ).toEqual(['s1', 's2', 's3']);
  });

  it('follows detection precedence for partially annotated decks', () => {
    // Detection lets [data-slide-id] shadow classed siblings. Normalization
    // must not silently promote those siblings into slides.
    const doc = deck(
      '<section class="slide" data-slide-id="s2"></section><section class="slide">Ignored by detection</section>'
    );

    const result = normalizeDeck(doc);

    expect(result.slides.map((slide) => slide.id)).toEqual(['s2']);
    expect(doc.querySelectorAll('[data-slide-id]')).toHaveLength(1);
    expect(doc.querySelectorAll('.slide')[1].hasAttribute('data-ppt-el')).toBe(false);
  });

  it('avoids collisions with existing ids', () => {
    const doc = deck(
      '<section class="slide"><h1 data-ppt-el="e3">A</h1><p>B</p></section><section class="slide"><h2>C</h2></section>'
    );

    const result = normalizeDeck(doc);

    expect(result.slides[0].elementIds).toEqual(['e3', 'e1']);
    expect(result.slides[1].elementIds).toEqual(['e1']);
  });

  it('assigns top-level object ids per slide and skips notes and scripts', () => {
    const doc = deck(
      '<section class="slide" data-slide-id="s1"><h1 data-ppt-el="e2">A</h1><p>B</p><aside data-ppt-notes hidden>N</aside><script>x</script><style>.a{}</style><div data-ppt-group><span>C</span></div></section><section class="slide" data-slide-id="s2"><h1>A</h1><p>B</p></section>'
    );

    const result = normalizeDeck(doc);

    expect(result.slides).toEqual([
      { id: 's1', elementIds: ['e2', 'e1', 'e3'] },
      { id: 's2', elementIds: ['e1', 'e2'] }
    ]);
    const group = doc.querySelector('[data-ppt-group]');
    expect(group?.getAttribute('data-ppt-el')).toBe('e3');
    expect(group?.querySelector('span')?.hasAttribute('data-ppt-el')).toBe(false);
    expect(doc.querySelector('aside')?.hasAttribute('data-ppt-el')).toBe(false);
    expect(doc.querySelector('script')?.hasAttribute('data-ppt-el')).toBe(false);
  });

  it('avoids ids used by nested objects', () => {
    const doc = deck(
      '<section class="slide" data-slide-id="s1"><div data-ppt-group><span data-ppt-el="e2">Nested</span></div></section>'
    );

    const result = normalizeDeck(doc);

    expect(result.slides).toEqual([{ id: 's1', elementIds: ['e1'] }]);
    expect(doc.querySelector('div')?.getAttribute('data-ppt-el')).toBe('e1');
    expect(doc.querySelector('span')?.getAttribute('data-ppt-el')).toBe('e2');
  });

  it('is idempotent and preserves unrelated markup', () => {
    const doc = deck(
      '<section class="slide" data-slide-id="s1"><h1>A</h1></section>'
    );
    normalizeDeck(doc);
    const once = serializeDeck(doc);
    const second = normalizeDeck(doc);

    expect(second.changed).toBe(false);
    expect(serializeDeck(doc)).toBe(once);
    expect(once).toContain('<style>.slide{color:red}</style>');
  });

  it('assigns element ids on the body fallback without adding a slide id', () => {
    const doc = deck('<h1>Body slide</h1><p>Text</p>');

    const result = normalizeDeck(doc);

    expect(result.slides).toEqual([{ id: 'body', elementIds: ['e1', 'e2'] }]);
    expect(doc.body.hasAttribute('data-slide-id')).toBe(false);
    expect(doc.querySelector('h1')?.getAttribute('data-ppt-el')).toBe('e1');
  });

  it('assigns slide ids to section-group slides without marker classes', () => {
    const doc = deck('<section><h1>A</h1></section><section><h1>B</h1></section>');

    const result = normalizeDeck(doc);

    expect(result.slides).toEqual([
      { id: 's1', elementIds: ['e1'] },
      { id: 's2', elementIds: ['e1'] }
    ]);
    expect(
      Array.from(doc.querySelectorAll('body > section')).map((slide) =>
        slide.getAttribute('data-slide-id')
      )
    ).toEqual(['s1', 's2']);
  });

  it('adds position relative only when the predicate says the slide is static', () => {
    const doc = deck(
      '<section class="slide" data-slide-id="s1"></section><section class="slide" data-slide-id="s2" style="position: absolute"></section>'
    );

    normalizeDeck(doc, { isStaticPosition: () => true });

    expect(doc.querySelector('[data-slide-id="s1"]')?.getAttribute('style')).toBe(
      'position: relative;'
    );
    expect(doc.querySelector('[data-slide-id="s2"]')?.getAttribute('style')).toBe(
      'position: absolute'
    );
  });

  it('appends position without disturbing existing declarations', () => {
    const doc = deck(
      '<section class="slide" data-slide-id="s1" style="color: red"></section>'
    );

    normalizeDeck(doc, { isStaticPosition: () => true });

    expect(doc.querySelector('[data-slide-id="s1"]')?.getAttribute('style')).toBe(
      'color: red; position: relative;'
    );
  });

  it('is idempotent when positioning is injected', () => {
    const doc = deck(
      '<section class="slide" data-slide-id="s1" style="color: red"></section>'
    );
    const isStaticPosition = () => true;

    normalizeDeck(doc, { isStaticPosition });
    const once = serializeDeck(doc);
    const second = normalizeDeck(doc, { isStaticPosition });

    expect(second.changed).toBe(false);
    expect(serializeDeck(doc)).toBe(once);
    expect(doc.querySelector('[data-slide-id="s1"]')?.getAttribute('style')).toBe(
      'color: red; position: relative;'
    );
  });

  it('does not touch positioning without the predicate', () => {
    const doc = deck('<section class="slide" data-slide-id="s1"></section>');

    normalizeDeck(doc);

    expect(doc.querySelector('.slide')?.hasAttribute('style')).toBe(false);
  });

  it('removes editor-only attributes and reports a change', () => {
    const doc = deck(
      '<section class="slide" data-slide-id="s1"><h1 data-ppt-editing="true" data-ppt-frame-slide="x">A</h1></section>'
    );

    const result = normalizeDeck(doc);

    expect(result.changed).toBe(true);
    const heading = doc.querySelector('h1');
    expect(heading?.hasAttribute('data-ppt-editing')).toBe(false);
    expect(heading?.hasAttribute('data-ppt-frame-slide')).toBe(false);
  });

  it('uses an injected id factory', () => {
    const doc = deck('<section class="slide"></section>');

    normalizeDeck(doc, {
      ids: {
        slideId: () => 'custom-slide',
        elementId: (_existing, index) => `custom-${index}`
      }
    });

    expect(doc.querySelector('.slide')?.getAttribute('data-slide-id')).toBe(
      'custom-slide'
    );
  });

  it('reports the assigned id instead of the body fallback label', () => {
    const doc = deck('<section class="slide"></section>');

    const result = normalizeDeck(doc, {
      ids: {
        slideId: () => '  ',
        elementId: () => 'e1'
      }
    });

    expect(result.slides[0].id).not.toBe('body');
    expect(result.slides[0].id).toBe('');
  });
});
