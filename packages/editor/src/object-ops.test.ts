import { detectSlides } from '@htmlppt/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { elementAtPath } from './selection.js';
import { parseDeck } from './slide-doc.js';
import {
  collectObjectHtml,
  deleteObjectPaths,
  pasteObjectHtml,
  type PastedObjectGeometry
} from './object-ops.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * jsdom has no layout engine, so a pasted class-positioned object would
 * otherwise measure as a zero rect. The stub gives the pasted element a
 * measured box while every other element (including the slide) stays at zero.
 */
function stubMeasuredRect(
  text: string,
  measured: { x: number; y: number; width: number; height: number }
): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: Element): DOMRect {
      const zero = {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON: () => ({})
      } as DOMRect;
      if (this.textContent !== text) return zero;
      return {
        x: measured.x,
        y: measured.y,
        left: measured.x,
        top: measured.y,
        right: measured.x + measured.width,
        bottom: measured.y + measured.height,
        width: measured.width,
        height: measured.height,
        toJSON: () => ({})
      } as DOMRect;
    }
  );
}

const DECK_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Object ops fixture</title></head>
<body>
<main data-ppt-deck>
<section class="slide" data-slide-id="s1" data-width="1600" data-height="900">
  <h1 data-ppt-el="e1">First slide</h1>
  <div data-ppt-el="box1" style="position:absolute;left:120px;top:160px;width:240px;height:120px;background:#d8c08a">Nudge me <span data-ppt-el="inner1">nested</span></div>
  <p>Flow object</p>
</section>
</main>
</body>
</html>`;

function fixture() {
  const master = parseDeck(DECK_HTML);
  const slide = detectSlides(master)[0]?.element;
  if (!slide) throw new Error('Missing fixture slide.');
  return { master, slide };
}

function slideOf(master: Document): Element {
  const slide = detectSlides(master)[0]?.element;
  if (!slide) throw new Error('Missing slide.');
  return slide;
}

function styleOf(element: Element): CSSStyleDeclaration {
  return (element as HTMLElement).style;
}

describe('collectObjectHtml', () => {
  it('returns top-level outerHTML in document order and ignores nested paths', () => {
    const { slide } = fixture();

    const html = collectObjectHtml(slide, [[1], [0], [1, 0], [1]]);

    expect(html).toHaveLength(2);
    expect(html[0]).toContain('data-ppt-el="e1"');
    expect(html[0]).toContain('First slide');
    expect(html[1]).toContain('data-ppt-el="box1"');
    expect(html[1]).toContain('nested');
    expect(html[1]).toContain('position:absolute');
  });

  it('ignores paths that do not resolve to a top-level object', () => {
    const { slide } = fixture();

    expect(collectObjectHtml(slide, [[2], [3], [9]])).toEqual([
      slide.children[2]?.outerHTML
    ]);
  });
});

describe('pasteObjectHtml', () => {
  it('appends the same markup under a fresh id and offsets it by 20 px', () => {
    const { master, slide } = fixture();
    const html = collectObjectHtml(slide, [[1]]);

    const targets = pasteObjectHtml(master, 0, html);

    expect(targets).toHaveLength(1);
    const target = targets[0];
    if (!target) throw new Error('Missing pasted target.');
    const pasted = elementAtPath(slideOf(master), target.path);
    if (!pasted) throw new Error('Missing pasted element.');

    expect(target.slideIndex).toBe(0);
    expect(target.path).toEqual([3]);
    expect(target.elementId).toBe(pasted.getAttribute('data-ppt-el'));
    expect(target.elementId).not.toBe('box1');
    expect(pasted.textContent).toContain('Nudge me');
    expect(styleOf(pasted).position).toBe('absolute');
    expect(styleOf(pasted).left).toBe('140px');
    expect(styleOf(pasted).top).toBe('180px');
    expect(styleOf(pasted).width).toBe('240px');
    expect(styleOf(pasted).height).toBe('120px');

    // Nested ids are freshened too so the slide has no duplicates.
    const nested = pasted.querySelector('[data-ppt-el]');
    expect(nested?.getAttribute('data-ppt-el')).not.toBe('inner1');
    expect(nested?.getAttribute('data-ppt-el')).not.toBe(target.elementId);
  });

  it('offsets flow objects with relative positioning', () => {
    const { master, slide } = fixture();
    const html = collectObjectHtml(slide, [[2]]);

    const targets = pasteObjectHtml(master, 0, html);
    const pasted = elementAtPath(slideOf(master), targets[0]?.path ?? []);
    if (!pasted) throw new Error('Missing pasted flow element.');

    expect(styleOf(pasted).position).toBe('relative');
    expect(styleOf(pasted).left).toBe('20px');
    expect(styleOf(pasted).top).toBe('20px');
    expect(pasted.textContent).toBe('Flow object');
  });

  it('adds 20 px to an already relative object before pasting', () => {
    const { master } = fixture();

    const targets = pasteObjectHtml(master, 0, [
      '<p data-ppt-el="rel" style="position:relative;left:5px;top:7px">Relative</p>'
    ]);
    const pasted = elementAtPath(slideOf(master), targets[0]?.path ?? []);
    if (!pasted) throw new Error('Missing pasted relative element.');

    expect(styleOf(pasted).position).toBe('relative');
    expect(styleOf(pasted).left).toBe('25px');
    expect(styleOf(pasted).top).toBe('27px');
  });

  it('falls back to the measured rect for unitless absolute offsets', () => {
    const { master } = fixture();
    stubMeasuredRect('Unitless', { x: 120, y: 160, width: 100, height: 60 });

    const targets = pasteObjectHtml(master, 0, [
      '<div data-ppt-el="unitless" style="position:absolute;left:10;top:20;width:100px;height:60px">Unitless</div>'
    ]);
    const pasted = elementAtPath(slideOf(master), targets[0]?.path ?? []);
    if (!pasted) throw new Error('Missing pasted unitless element.');

    expect(styleOf(pasted).position).toBe('absolute');
    expect(styleOf(pasted).left).toBe('140px');
    expect(styleOf(pasted).top).toBe('180px');
  });

  it('falls back to the measured rect for class-positioned absolute objects', () => {
    const { master } = fixture();
    stubMeasuredRect('Placed', { x: 300, y: 200, width: 100, height: 80 });

    const targets = pasteObjectHtml(master, 0, [
      '<div data-ppt-el="placed" class="placed" style="position:absolute;width:100px;height:80px">Placed</div>'
    ]);
    const pasted = elementAtPath(slideOf(master), targets[0]?.path ?? []);
    if (!pasted) throw new Error('Missing pasted placed element.');

    // The class supplies left/top, so the authored position is only available
    // from layout: the paste lands 20 px down-right of the measured box.
    expect(styleOf(pasted).left).toBe('320px');
    expect(styleOf(pasted).top).toBe('220px');
  });

  it('replaces percentage offsets with a measured pixel fallback', () => {
    const { master } = fixture();
    stubMeasuredRect('Percent', { x: 240, y: 90, width: 50, height: 50 });

    const targets = pasteObjectHtml(master, 0, [
      '<div data-ppt-el="pct" style="position:absolute;left:25%;top:10%;width:50px;height:50px">Percent</div>'
    ]);
    const pasted = elementAtPath(slideOf(master), targets[0]?.path ?? []);
    if (!pasted) throw new Error('Missing pasted percentage element.');

    expect(styleOf(pasted).left).toBe('260px');
    expect(styleOf(pasted).top).toBe('110px');
    expect(styleOf(pasted).left).not.toContain('calc');
    expect(styleOf(pasted).top).not.toContain('calc');
  });

  it('uses the live measurement for class-positioned objects', () => {
    const { master } = fixture();
    const measure = vi.fn(
      (element: Element): PastedObjectGeometry | null =>
        element.textContent === 'Class placed'
          ? { x: 300, y: 200, position: 'absolute' }
          : null
    );

    const targets = pasteObjectHtml(
      master,
      0,
      ['<div data-ppt-el="classed" class="placed">Class placed</div>'],
      measure
    );
    const pasted = elementAtPath(slideOf(master), targets[0]?.path ?? []);
    if (!pasted) throw new Error('Missing class-positioned element.');

    expect(measure).toHaveBeenCalledTimes(1);
    expect(styleOf(pasted).position).toBe('absolute');
    expect(styleOf(pasted).left).toBe('320px');
    expect(styleOf(pasted).top).toBe('220px');
  });

  it('allocates unique fresh ids across every pasted object', () => {
    const { master, slide } = fixture();
    const html = collectObjectHtml(slide, [[0], [1]]);

    const first = pasteObjectHtml(master, 0, html);
    const second = pasteObjectHtml(master, 0, html);

    const ids = [...first, ...second].map((target) => target.elementId ?? '');
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    expect(ids).not.toContain('e1');
    expect(ids).not.toContain('box1');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('returns no targets for missing slides or empty html', () => {
    const { master, slide } = fixture();

    expect(pasteObjectHtml(master, 9, collectObjectHtml(slide, [[1]]))).toEqual(
      []
    );
    expect(pasteObjectHtml(master, 0, [])).toEqual([]);
  });
});

describe('deleteObjectPaths', () => {
  it('removes every selected top-level object in one mutation', () => {
    const { master, slide } = fixture();

    expect(deleteObjectPaths(master, 0, [[0], [1]])).toBe(2);

    expect(slide.querySelector('[data-ppt-el="e1"]')).toBeNull();
    expect(slide.querySelector('[data-ppt-el="box1"]')).toBeNull();
    expect(slide.querySelector('p')?.textContent).toBe('Flow object');
  });

  it('ignores nested paths and out-of-range indices', () => {
    const { master, slide } = fixture();

    expect(deleteObjectPaths(master, 0, [[1, 0], [99]])).toBe(0);
    expect(slide.querySelector('[data-ppt-el="box1"]')).not.toBeNull();
  });
});
