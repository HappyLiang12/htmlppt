import { detectSlides } from '@htmlppt/core';
import { describe, expect, it } from 'vitest';
import { elementAtPath } from './selection.js';
import { parseDeck } from './slide-doc.js';
import {
  collectObjectHtml,
  deleteObjectPaths,
  pasteObjectHtml
} from './object-ops.js';

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
