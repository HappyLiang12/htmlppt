import { describe, expect, it } from 'vitest';
import {
  DeckMutationError,
  addElement,
  addSlide,
  deleteSlide,
  duplicateSlide,
  moveSlide,
  mutateDeck,
  removeElement,
  resolveTarget,
  setElementHtml,
  setNotes,
  setSlideOrder,
  setStyle,
  setText,
  setTransition,
  updateSlideHtml
} from '../src/mutations.js';
import { parseDeckHtml } from '../src/node.js';
import { detectSlides } from '../src/detect.js';
import { createDeckHtml } from '../src/template.js';

const source = `<!doctype html><html><head><title>Deck</title></head><body><section data-slide-id="s1"><h1 data-ppt-el="e1" class="title">Hello</h1><p data-ppt-el="e2">Body</p></section><section data-slide-id="s2"><h2>Other</h2></section></body></html>`;

const classOnlySource = `<!doctype html><html><head><title>Class only</title></head><body><main data-ppt-deck><section class="slide"><h1>One</h1></section><section class="slide"><h2>Two</h2></section></main></body></html>`;

const detectedIds = (doc: Document): string[] =>
  detectSlides(doc).map((detected) => detected.id);

const slide = (doc: Document, id = 's1') =>
  doc.querySelector(`[data-slide-id="${id}"]`) as Element;

describe('resolveTarget', () => {
  it('resolves by element id, selector, and path', () => {
    const doc = parseDeckHtml(source);
    const root = slide(doc);
    expect(resolveTarget(root, { elementId: 'e2' }).getAttribute('data-ppt-el')).toBe('e2');
    expect(resolveTarget(root, { selector: 'h1.title' }).tagName).toBe('H1');
    expect(resolveTarget(root, { path: [1] }).getAttribute('data-ppt-el')).toBe('e2');
  });

  it('rejects missing, ambiguous, and invalid targets', () => {
    const root = slide(parseDeckHtml(source));
    expect(() => resolveTarget(root, { elementId: 'nope' })).toThrow(
      expect.objectContaining({ code: 'target-not-found' })
    );
    expect(() => resolveTarget(root, { selector: 'p, h1' })).toThrow(
      expect.objectContaining({ code: 'target-ambiguous' })
    );
    expect(() => resolveTarget(root, { selector: '<<<' })).toThrow(
      expect.objectContaining({ code: 'target-invalid' })
    );
    expect(() => resolveTarget(root, { path: [9] })).toThrow(
      expect.objectContaining({ code: 'target-not-found' })
    );
  });

  it('resolves nested paths and rejects invalid path entries', () => {
    const nested = parseDeckHtml(
      `<!doctype html><html><head><title>Deck</title></head><body><section data-slide-id="s1"><div data-ppt-el="e1"><span data-ppt-el="e2">Nested</span><em data-ppt-el="e3">Second</em></div></section></body></html>`
    );
    const root = slide(nested);
    expect(resolveTarget(root, { path: [0, 1] }).getAttribute('data-ppt-el')).toBe('e3');
    expect(() => resolveTarget(root, { path: [-1] })).toThrow(
      expect.objectContaining({ code: 'target-invalid' })
    );
    expect(() => resolveTarget(root, { path: [0, 1.5] })).toThrow(
      expect.objectContaining({ code: 'target-invalid' })
    );
  });

  it('rejects an element id that is duplicated inside one slide', () => {
    const duplicate = parseDeckHtml(
      `<!doctype html><html><head><title>Deck</title></head><body><section data-slide-id="s1"><p data-ppt-el="e1">First</p><p data-ppt-el="e1">Second</p></section></body></html>`
    );
    expect(() => resolveTarget(slide(duplicate), { elementId: 'e1' })).toThrow(
      expect.objectContaining({ code: 'target-ambiguous' })
    );
  });
});

describe('element mutations', () => {
  it('sets text as text, not markup', () => {
    const doc = parseDeckHtml(source);
    const target = resolveTarget(slide(doc), { elementId: 'e1' });
    setText(target, '<b>Escaped</b>');
    expect(target.textContent).toBe('<b>Escaped</b>');
    expect(target.querySelector('b')).toBeNull();
  });

  it('applies and removes inline styles with validation', () => {
    const doc = parseDeckHtml(source);
    const target = resolveTarget(slide(doc), { elementId: 'e1' }) as HTMLElement;
    setStyle(target, { color: 'red', 'font-size': '48px' });
    expect(target.style.color).toBe('red');
    expect(target.style.fontSize).toBe('48px');
    setStyle(target, { color: null });
    expect(target.style.color).toBe('');
    expect(() => setStyle(target, { 'bad property': 'x' })).toThrow(
      expect.objectContaining({ code: 'invalid-style-property' })
    );
  });

  it('validates every style key before applying any of them', () => {
    const target = resolveTarget(slide(parseDeckHtml(source)), {
      elementId: 'e1'
    }) as HTMLElement;
    expect(() => setStyle(target, { color: 'red', 'bad property': 'x' })).toThrow(
      expect.objectContaining({ code: 'invalid-style-property' })
    );
    expect(target.style.color).toBe('');
    expect(target.getAttribute('style')).toBeNull();
  });

  it('applies and removes CSS custom properties', () => {
    const target = resolveTarget(slide(parseDeckHtml(source)), {
      elementId: 'e1'
    }) as HTMLElement;
    setStyle(target, { '--brand': '#123' });
    expect(target.style.getPropertyValue('--brand')).toBe('#123');
    setStyle(target, { '--brand': null });
    expect(target.style.getPropertyValue('--brand')).toBe('');
    expect(target.getAttribute('style')).toBeNull();
  });

  it('replaces element html and adds/removes top-level elements', () => {
    const doc = parseDeckHtml(source);
    const root = slide(doc);
    setElementHtml(resolveTarget(root, { elementId: 'e1' }), '<em>New</em>');
    expect(root.querySelector('h1 em')?.textContent).toBe('New');

    addElement(root, '<div class="badge">New</div>', { elementId: 'e2' });
    const added = resolveTarget(root, { selector: 'div.badge' });
    expect(added.getAttribute('data-ppt-el')).not.toBeNull();

    removeElement(added);
    expect(root.querySelector('div.badge')).toBeNull();
  });

  it('rejects fragments with zero or multiple roots', () => {
    const root = slide(parseDeckHtml(source));
    expect(() => addElement(root, '<b>one</b><b>two</b>')).toThrow(
      expect.objectContaining({ code: 'invalid-fragment' })
    );
    expect(() => addElement(root, 'text only')).toThrow(
      expect.objectContaining({ code: 'invalid-fragment' })
    );
  });

  it('rejects a single-root fragment with adjacent non-whitespace text', () => {
    const root = slide(parseDeckHtml(source));
    expect(() => addElement(root, '<b>one</b> trailing')).toThrow(
      expect.objectContaining({ code: 'invalid-fragment' })
    );
    expect(root.querySelector('b')).toBeNull();
  });

  it('allows whitespace around a single root element', () => {
    const root = slide(parseDeckHtml(source));
    const added = addElement(root, '  <b>one</b>\n');
    expect(added.tagName).toBe('B');
    expect(added.getAttribute('data-ppt-el')).toBe('e3');
  });

  it('rejects insertion anchors nested below the slide', () => {
    const doc = parseDeckHtml(
      `<!doctype html><html><head><title>Deck</title></head><body><section data-slide-id="s1"><div data-ppt-el="e1"><span data-ppt-el="e2">Nested</span></div></section></body></html>`
    );

    expect(() =>
      addElement(slide(doc), '<b>new</b>', { elementId: 'e2' })
    ).toThrow(expect.objectContaining({ code: 'target-invalid' }));
  });

  it('does not remove the slide itself', () => {
    const root = slide(parseDeckHtml(source));
    expect(() => removeElement(root)).toThrow(
      expect.objectContaining({ code: 'cannot-remove-slide' })
    );
  });
});

describe('mutateDeck', () => {
  it('clones, normalizes, and returns a new valid document', () => {
    const before = parseDeckHtml(source);
    const beforeHtml = before.documentElement.outerHTML;

    const { document, result } = mutateDeck(before, (draft) => {
      const root = slide(draft);
      return addElement(root, '<section class="note"><span>Added</span></section>');
    });

    expect(before.documentElement.outerHTML).toBe(beforeHtml);
    expect(result.getAttribute('data-ppt-el')).toBe('e3');
    // Normalization tags all slides, including the previously untagged h2 in s2.
    expect(document.querySelectorAll('[data-ppt-el]')).toHaveLength(4);
    expect(document.querySelector('section.note')).not.toBeNull();
  });

  it('rejects a mutation that produces an invalid deck without touching the source', () => {
    const doc = parseDeckHtml(source);
    const beforeHtml = doc.documentElement.outerHTML;
    let caught: unknown;

    try {
      mutateDeck(doc, (draft) => {
        setElementHtml(
          resolveTarget(slide(draft), { elementId: 'e1' }),
          '<figure data-ppt-chart="{bad}"></figure>'
        );
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DeckMutationError);
    expect(caught).toMatchObject({ code: 'invalid-result' });
    expect((caught as DeckMutationError).details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'error', code: 'invalid-chart-json' })
      ])
    );
    expect(doc.documentElement.outerHTML).toBe(beforeHtml);
  });

  it('normalizes slide content through the mutation gate', () => {
    const doc = parseDeckHtml(source);
    const beforeHtml = doc.documentElement.outerHTML;

    const { document } = mutateDeck(doc, (draft) => {
      updateSlideHtml(draft, 's2', '<h2>Gate</h2><p>Text</p>');
    });

    const updated = document.querySelector('[data-slide-id="s2"]') as Element;
    expect(updated.querySelector('h2')?.getAttribute('data-ppt-el')).toBe('e1');
    expect(updated.querySelector('p')?.getAttribute('data-ppt-el')).toBe('e2');
    expect(doc.documentElement.outerHTML).toBe(beforeHtml);
  });

  it('normalizes class-only slides before the mutation callback runs', () => {
    const doc = parseDeckHtml(classOnlySource);
    const beforeHtml = doc.documentElement.outerHTML;

    const { document } = mutateDeck(doc, (draft) => addSlide(draft));

    expect(detectedIds(document)).toEqual(['s1', 's2', 's3']);
    expect(document.querySelectorAll('[data-slide-id]')).toHaveLength(3);
    expect(doc.documentElement.outerHTML).toBe(beforeHtml);
  });

  it('returns a normalized class-only document that notes and html mutations can address', () => {
    const { document } = mutateDeck(parseDeckHtml(classOnlySource), (draft) =>
      addSlide(draft)
    );

    setNotes(document, 's1', 'note');
    expect(
      document.querySelector('[data-slide-id="s1"] > aside[data-ppt-notes]')?.textContent
    ).toBe('note');

    updateSlideHtml(document, 's1', '<h1>Replaced</h1><p>Text</p>');
    const updated = document.querySelector('[data-slide-id="s1"]') as Element;
    expect(updated.querySelector('h1')?.textContent).toBe('Replaced');
    expect(updated.querySelector('p')?.textContent).toBe('Text');
    expect(detectedIds(document)).toEqual(['s1', 's2', 's3']);
  });

  it('duplicates class-only slides without dropping them from detection', () => {
    const { document } = mutateDeck(parseDeckHtml(classOnlySource), (draft) =>
      duplicateSlide(draft, 's2')
    );

    expect(detectedIds(document)).toEqual(['s1', 's2', 's3']);
  });

  it('moves and reorders class-only slides after pre-normalization', () => {
    const moved = mutateDeck(parseDeckHtml(classOnlySource), (draft) => {
      moveSlide(draft, 's1', 1);
    }).document;
    expect(detectedIds(moved)).toEqual(['s2', 's1']);

    const reordered = mutateDeck(parseDeckHtml(classOnlySource), (draft) => {
      setSlideOrder(draft, ['s2', 's1']);
    }).document;
    expect(detectedIds(reordered)).toEqual(['s2', 's1']);
  });
});

describe('slide mutations', () => {
  const ids = (doc: Document) =>
    Array.from(doc.querySelectorAll('[data-slide-id]')).map((slide) =>
      slide.getAttribute('data-slide-id')
    );

  it('adds a slide after a slide id with canvas and metadata', () => {
    const doc = parseDeckHtml(source);
    const id = addSlide(doc, {
      html: '<h1>Inserted</h1>',
      afterSlideId: 's1',
      notes: 'Talk track',
      transition: 'slide'
    });

    expect(id).toBe('s3');
    expect(ids(doc)).toEqual(['s1', 's3', 's2']);
    const added = doc.querySelector(`[data-slide-id="${id}"]`) as Element;
    expect(added.hasAttribute('class')).toBe(false);
    expect(added.getAttribute('data-width')).toBe('1600');
    expect(added.getAttribute('data-height')).toBe('900');
    expect(added.querySelector('h1')?.getAttribute('data-ppt-el')).toBe('e1');
    expect(added.querySelector('aside[data-ppt-notes]')?.textContent).toBe('Talk track');
    expect(added.getAttribute('data-ppt-transition')).toBe('slide');
  });

  it('inherits the reference canvas and class onto the new slide', () => {
    const canvasDeck = parseDeckHtml(`<!doctype html><html><head><title>Deck</title></head><body>
<section class="slide hero" data-slide-id="s1" data-width="1280" data-height="720"></section>
<section class="slide hero" data-slide-id="s2" data-width="1280" data-height="720"></section>
</body></html>`);

    const { document } = mutateDeck(canvasDeck, (draft) => addSlide(draft));
    const added = document.querySelector('[data-slide-id="s3"]') as Element;

    expect(added.tagName).toBe('SECTION');
    expect(added.getAttribute('class')).toBe('slide hero');
    expect(added.getAttribute('data-width')).toBe('1280');
    expect(added.getAttribute('data-height')).toBe('720');
  });

  it('inherits the reference tag and omits a missing class for plain section decks', () => {
    const plain = parseDeckHtml(`<!doctype html><html><head><title>Deck</title></head><body>
<section><h1>One</h1></section>
<section><h2>Two</h2></section>
</body></html>`);

    const { document } = mutateDeck(plain, (draft) => addSlide(draft));
    const added = document.querySelector('[data-slide-id="s3"]') as Element;

    expect(detectedIds(document)).toEqual(['s1', 's2', 's3']);
    expect(added.tagName).toBe('SECTION');
    expect(added.hasAttribute('class')).toBe(false);
    expect(added.getAttribute('data-width')).toBe('1600');
    expect(added.getAttribute('data-height')).toBe('900');
  });

  it('keeps the template walkthrough on the 1600x900 canvas', () => {
    const { document } = mutateDeck(parseDeckHtml(createDeckHtml({ slides: 2 })), (draft) =>
      addSlide(draft)
    );
    const added = document.querySelector('[data-slide-id="s3"]') as Element;

    expect(detectedIds(document)).toEqual(['s1', 's2', 's3']);
    expect(added.getAttribute('class')).toBe('slide');
    expect(added.getAttribute('data-width')).toBe('1600');
    expect(added.getAttribute('data-height')).toBe('900');
  });

  it('appends a slide by default without moving existing slides', () => {
    const doc = parseDeckHtml(source);
    const id = addSlide(doc, { html: '<h1>Appended</h1>' });

    expect(id).toBe('s3');
    expect(ids(doc)).toEqual(['s1', 's2', 's3']);
  });

  it('copies supplied canvas dimensions onto the new slide', () => {
    const doc = parseDeckHtml(source);
    const id = addSlide(doc, { html: '<h1>Canvas</h1>', width: 1024, height: 768 });
    const added = doc.querySelector(`[data-slide-id="${id}"]`) as Element;

    expect(added.getAttribute('data-width')).toBe('1024');
    expect(added.getAttribute('data-height')).toBe('768');
  });

  it('uses the injected id factory for the new slide id', () => {
    const doc = parseDeckHtml(source);
    const id = addSlide(doc, {
      html: '<h1>Custom id</h1>',
      ids: { slideId: () => 'custom', elementId: () => 'unused' }
    });

    expect(id).toBe('custom');
    expect(doc.querySelector('[data-slide-id="custom"]')).not.toBeNull();
  });

  it('picks the next free id when slide ids are not contiguous', () => {
    const sparse = parseDeckHtml(
      `<!doctype html><html><head><title>Deck</title></head><body><section data-slide-id="s1"></section><section data-slide-id="s3"></section></body></html>`
    );

    expect(addSlide(sparse, { html: '<p>Sparse</p>' })).toBe('s2');
  });

  it('throws slide-not-found for a missing insertion anchor', () => {
    const doc = parseDeckHtml(source);
    expect(() =>
      addSlide(doc, { html: '<h1>Missing anchor</h1>', afterSlideId: 'nope' })
    ).toThrow(expect.objectContaining({ code: 'slide-not-found' }));
    expect(ids(doc)).toEqual(['s1', 's2']);
  });

  it('duplicates a slide with a new id and deep content', () => {
    const doc = parseDeckHtml(source);
    const id = duplicateSlide(doc, 's1');
    expect(id).toBe('s3');
    expect(ids(doc)).toEqual(['s1', 's3', 's2']);
    const clone = doc.querySelector(`[data-slide-id="${id}"]`) as Element;
    expect(clone.querySelector('h1')?.textContent).toBe('Hello');
    // Element ids are scoped per slide, so the clone keeps its source ids.
    expect(clone.querySelector('h1')?.getAttribute('data-ppt-el')).toBe('e1');
    expect(clone.querySelector('p')?.getAttribute('data-ppt-el')).toBe('e2');
  });

  it('refuses to delete the last slide and slide operations on the body fallback', () => {
    const single = parseDeckHtml(
      '<!doctype html><html><head><title>T</title></head><body><section data-slide-id="s1"></section></body></html>'
    );
    expect(() => deleteSlide(single, 's1')).toThrow(
      expect.objectContaining({ code: 'last-slide' })
    );

    const body = parseDeckHtml(
      '<!doctype html><html><head><title>T</title></head><body><h1>Body</h1></body></html>'
    );
    expect(() => addSlide(body)).toThrow(
      expect.objectContaining({ code: 'slide-operations-unavailable' })
    );
  });

  it('deletes and moves slides', () => {
    const doc = parseDeckHtml(source);
    deleteSlide(doc, 's1');
    expect(ids(doc)).toEqual(['s2']);

    const three = parseDeckHtml(source);
    addSlide(three, { html: '<h1>Third</h1>' });
    moveSlide(three, 's3', 0);
    expect(ids(three)).toEqual(['s3', 's1', 's2']);
    expect(() => moveSlide(three, 's1', 9)).toThrow(
      expect.objectContaining({ code: 'index-out-of-range' })
    );

    const ending = parseDeckHtml(source);
    addSlide(ending, { html: '<h1>Third</h1>' });
    moveSlide(ending, 's1', 2);
    expect(ids(ending)).toEqual(['s2', 's3', 's1']);
  });

  it('sets a full slide order and rejects partial permutations', () => {
    const doc = parseDeckHtml(source);
    setSlideOrder(doc, ['s2', 's1']);
    expect(ids(doc)).toEqual(['s2', 's1']);
    expect(() => setSlideOrder(doc, ['s1'])).toThrow(
      expect.objectContaining({ code: 'invalid-order' })
    );
    expect(() => setSlideOrder(doc, ['s1', 's1'])).toThrow(
      expect.objectContaining({ code: 'invalid-order' })
    );
  });

  it('replaces slide html while preserving all slide attributes', () => {
    const doc = parseDeckHtml(`<!doctype html><html><head><title>Deck</title></head><body>
<section class="slide hero" data-slide-id="s1" data-width="1024" data-height="768" data-ppt-transition="fade" data-custom="keep">
  <h1>Old</h1>
</section>
</body></html>`);
    updateSlideHtml(doc, 's1', '<h2>Replaced</h2><p>Text</p>');
    const updated = doc.querySelector('[data-slide-id="s1"]') as Element;
    expect(updated.getAttribute('data-slide-id')).toBe('s1');
    expect(updated.getAttribute('data-width')).toBe('1024');
    expect(updated.getAttribute('data-height')).toBe('768');
    expect(updated.getAttribute('data-ppt-transition')).toBe('fade');
    expect(updated.getAttribute('class')).toBe('slide hero');
    expect(updated.getAttribute('data-custom')).toBe('keep');
    expect(updated.querySelector('h2')?.textContent).toBe('Replaced');
    expect(updated.querySelectorAll('[data-ppt-el]')).toHaveLength(0);
  });

  it('sets, updates, and removes notes as a direct child', () => {
    const doc = parseDeckHtml(source);
    setNotes(doc, 's2', 'First note');
    expect(doc.querySelector('[data-slide-id="s2"] > aside[data-ppt-notes]')?.textContent).toBe(
      'First note'
    );
    setNotes(doc, 's2', 'Updated');
    expect(doc.querySelectorAll('[data-slide-id="s2"] > aside[data-ppt-notes]')).toHaveLength(1);
    setNotes(doc, 's2', '');
    expect(doc.querySelector('[data-slide-id="s2"] aside[data-ppt-notes]')).toBeNull();
  });

  it('collapses duplicate direct notes asides when setting notes', () => {
    const doc = parseDeckHtml(`<!doctype html><html><head><title>Deck</title></head><body>
<section data-slide-id="s1">
  <aside data-ppt-notes>First</aside>
  <aside data-ppt-notes>Duplicate</aside>
</section>
<section data-slide-id="s2"></section>
</body></html>`);

    setNotes(doc, 's1', 'Updated');
    const asides = Array.from(doc.querySelector('[data-slide-id="s1"]')?.children ?? []).filter(
      (child) => child.hasAttribute('data-ppt-notes')
    );
    expect(asides).toHaveLength(1);
    expect(asides[0].textContent).toBe('Updated');

    setNotes(doc, 's1', '');
    expect(
      doc.querySelector('[data-slide-id="s1"] aside[data-ppt-notes]')
    ).toBeNull();
  });

  it('collapses notes supplied in html and options when adding a slide', () => {
    const doc = parseDeckHtml(source);
    const id = addSlide(doc, {
      html: '<h1>Notes</h1><aside data-ppt-notes>From html</aside><aside data-ppt-notes>Duplicate</aside>',
      notes: 'Talk track'
    });
    const added = doc.querySelector(`[data-slide-id="${id}"]`) as Element;
    const asides = Array.from(added.children).filter((child) =>
      child.hasAttribute('data-ppt-notes')
    );

    expect(asides).toHaveLength(1);
    expect(asides[0].textContent).toBe('Talk track');
  });

  it('validates transitions before setting them', () => {
    const doc = parseDeckHtml(source);
    setTransition(doc, 's1', 'fade');
    expect(doc.querySelector('[data-slide-id="s1"]')?.getAttribute('data-ppt-transition')).toBe(
      'fade'
    );
    expect(() => setTransition(doc, 's1', 'zoom' as never)).toThrow(
      expect.objectContaining({ code: 'invalid-transition' })
    );
  });

  it('rejects gate-only failures with invalid-result and inner diagnostics', () => {
    const doc = parseDeckHtml(source);
    const beforeHtml = doc.documentElement.outerHTML;
    let caught: unknown;

    try {
      mutateDeck(doc, (draft) => {
        addElement(slide(draft), '<section data-slide-id="s9">Nested</section>');
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DeckMutationError);
    expect(caught).toMatchObject({ code: 'invalid-result' });
    expect((caught as DeckMutationError).message).toContain('nested-slide');
    expect((caught as DeckMutationError).details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'nested-slide',
          slideId: 's9'
        })
      ])
    );
    expect(doc.documentElement.outerHTML).toBe(beforeHtml);
  });

  it('rejects invalid slide results through the gate', () => {
    const doc = parseDeckHtml(source);
    const beforeHtml = doc.documentElement.outerHTML;
    expect(() =>
      mutateDeck(doc, (draft) => {
        updateSlideHtml(draft, 's2', '<figure data-ppt-chart="{bad}"></figure>');
      })
    ).toThrow(expect.objectContaining({ code: 'invalid-result' }));
    expect(doc.documentElement.outerHTML).toBe(beforeHtml);
  });
});
