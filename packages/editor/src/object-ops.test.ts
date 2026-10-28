import { detectSlides } from '@htmlppt/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { elementAtPath } from './selection.js';
import { parseDeck } from './slide-doc.js';
import {
  cloneComponent,
  collectObjectHtml,
  deleteComponentPaths,
  deleteObjectPaths,
  pasteComponentNode,
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

function componentMaster(inner: string): {
  master: Document;
  slide: Element;
} {
  const master = new DOMParser().parseFromString(
    `<main data-ppt-deck><section data-slide-id="s1">${inner}</section></main>`,
    'text/html'
  );
  const slide = detectSlides(master)[0]?.element;
  if (!slide) throw new Error('Missing component fixture slide.');
  return { master, slide };
}

describe('cloneComponent', () => {
  it('clones a nested element with fresh editor ids and the authored id', () => {
    const { master } = componentMaster(
      '<div id="pad"><h1 id="head" data-ppt-el="e1"><span data-ppt-el="e2">x</span></h1></div>'
    );
    const source = master.querySelector('#head');
    if (!source) throw new Error('Missing source element.');
    let next = 10;

    const clone = cloneComponent(source, master, () => `e${next++}`);

    expect(clone.id).toBe('head');
    expect(clone.getAttribute('data-ppt-el')).toBe('e10');
    expect(clone.querySelector('span')?.getAttribute('data-ppt-el')).toBe('e11');
  });

  it('does not mint editor ids where the source has none', () => {
    const { master } = componentMaster('<div id="pad"><h1 id="plain">T</h1></div>');
    const source = master.querySelector('#plain');
    if (!source) throw new Error('Missing source element.');
    const nextId = vi.fn(() => 'e1');

    const clone = cloneComponent(source, master, nextId);

    expect(clone.hasAttribute('data-ppt-el')).toBe(false);
    expect(nextId).not.toHaveBeenCalled();
  });

  it('refreshes only a descendant id when the clone root has none', () => {
    const { master } = componentMaster(
      '<div id="wrap"><span data-ppt-el="e2">x</span></div>'
    );
    const source = master.querySelector('#wrap');
    if (!source) throw new Error('Missing source element.');
    const nextId = vi.fn(() => 'e10');

    const clone = cloneComponent(source, master, nextId);

    expect(clone.hasAttribute('data-ppt-el')).toBe(false);
    expect(clone.querySelector('span')?.getAttribute('data-ppt-el')).toBe(
      'e10'
    );
    expect(nextId).toHaveBeenCalledTimes(1);
  });
});

describe('deleteComponentPaths', () => {
  it('deletes a nested element by path', () => {
    const { master } = componentMaster(
      '<div id="pad"><h1 id="head">T</h1><p id="lead">L</p></div>'
    );

    expect(deleteComponentPaths(master, 0, [[0, 0]])).toBe(1);

    expect(master.querySelector('#head')).toBeNull();
    expect(master.querySelector('#lead')).not.toBeNull();
  });

  it('resolves same-parent siblings before removing any element', () => {
    const { master } = componentMaster(
      '<div id="pad"><h1 id="a">A</h1><h2 id="b">B</h2><p id="c">C</p></div>'
    );

    expect(deleteComponentPaths(master, 0, [[0, 0], [0, 1]])).toBe(2);

    expect(master.querySelector('#a')).toBeNull();
    expect(master.querySelector('#b')).toBeNull();
    expect(master.querySelector('#c')).not.toBeNull();
  });

  it('removes only the topmost selected node when an ancestor and its child are selected', () => {
    const { master, slide } = componentMaster(
      '<div id="pad"><h1 id="head">T</h1><p id="lead">L</p></div>'
    );
    const pad = master.querySelector('#pad');
    if (!pad) throw new Error('Missing selected ancestor.');

    expect(deleteComponentPaths(master, 0, [[0], [0, 0]])).toBe(1);

    expect(slide.children).toHaveLength(0);
    expect(master.querySelector('#pad')).toBeNull();
    // The descendant left the document with its detached ancestor; it was not
    // removed a second time from the detached subtree.
    expect(pad.querySelector('#head')).not.toBeNull();
  });

  it('removes only the topmost node when the child path comes first', () => {
    const { master, slide } = componentMaster(
      '<div id="pad"><h1 id="head">T</h1><p id="lead">L</p></div>'
    );
    const pad = master.querySelector('#pad');
    if (!pad) throw new Error('Missing selected ancestor.');

    expect(deleteComponentPaths(master, 0, [[0, 0], [0]])).toBe(1);

    expect(slide.children).toHaveLength(0);
    expect(master.querySelector('#pad')).toBeNull();
    // A connectivity-only check would remove the detached #head as well and
    // count it twice; the detached subtree must stay intact.
    expect(pad.querySelector('#head')).not.toBeNull();
  });

  it('counts duplicate paths once', () => {
    const { master } = componentMaster(
      '<div id="pad"><h1 id="head">T</h1><p id="lead">L</p></div>'
    );

    expect(deleteComponentPaths(master, 0, [[0, 0], [0, 0]])).toBe(1);

    expect(master.querySelector('#head')).toBeNull();
    expect(master.querySelector('#lead')).not.toBeNull();
  });

  it('removes the valid path when another path is missing', () => {
    const { master } = componentMaster(
      '<div id="pad"><h1 id="head">T</h1><p id="lead">L</p></div>'
    );

    expect(deleteComponentPaths(master, 0, [[0, 9], [0, 0]])).toBe(1);

    expect(master.querySelector('#head')).toBeNull();
    expect(master.querySelector('#lead')).not.toBeNull();
  });

  it('ignores a path that resolves to the slide itself', () => {
    const { master, slide } = componentMaster(
      '<div id="pad"><h1 id="head">T</h1></div>'
    );

    expect(deleteComponentPaths(master, 0, [[]])).toBe(0);

    expect(slide.parentElement).not.toBeNull();
    expect(master.querySelector('#head')).not.toBeNull();
  });
});

describe('pasteComponentNode', () => {
  it('pastes an svg circle into its svg parent without HTML parsing', () => {
    const { master, slide } = componentMaster(
      '<svg id="plot"><circle id="dot" cx="5" cy="5" r="2"/></svg>'
    );
    const dot = master.querySelector('#dot');
    if (!dot) throw new Error('Missing source circle.');

    const target = pasteComponentNode(master, 0, dot, [0], null);

    expect(target?.path).toEqual([0, 1]);
    expect(master.querySelectorAll('circle')).toHaveLength(2);
    const clone = elementAtPath(slide, target?.path ?? []);
    if (!clone) throw new Error('Missing pasted circle.');
    expect(clone.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(clone.getAttribute('transform')).toBe('translate(20 20)');
    expect(clone.hasAttribute('style')).toBe(false);
  });

  it('post-multiplies the offset onto an authored svg transform', () => {
    const { master, slide } = componentMaster(
      '<svg id="plot"><rect id="bar" width="10" height="10" transform="scale(2)"/></svg>'
    );
    const bar = master.querySelector('#bar');
    if (!bar) throw new Error('Missing source rect.');

    const target = pasteComponentNode(master, 0, bar, [0], null);

    const clone = elementAtPath(slide, target?.path ?? []);
    if (!clone) throw new Error('Missing pasted rect.');
    expect(clone.getAttribute('transform')).toBe('scale(2) translate(20 20)');
    expect(clone.getAttribute('transform')?.match(/translate\(/g)).toHaveLength(
      1
    );
  });

  it('leaves a css-owned svg transform untouched when pasting', () => {
    const { master, slide } = componentMaster(
      '<svg id="plot"><circle id="dot" cx="5" cy="5" r="2" style="transform: rotate(20deg)"/></svg>'
    );
    const dot = master.querySelector('#dot');
    if (!dot) throw new Error('Missing source circle.');

    const target = pasteComponentNode(master, 0, dot, [0], null);

    const clone = elementAtPath(slide, target?.path ?? []);
    if (!clone) throw new Error('Missing pasted circle.');
    // CSS owns the rendering, so the copy stays on the source and the editor
    // does not write an inert presentation attribute.
    expect(clone.hasAttribute('transform')).toBe(false);
    expect(clone.getAttribute('style')).toContain('transform: rotate(20deg)');
    expect(clone.getAttribute('data-ppt-el')).toBeNull();
    expect(master.querySelectorAll('circle')).toHaveLength(2);
  });

  it('offsets a duplicated nested svg root inside its svg parent', () => {
    const { master, slide } = componentMaster(
      '<svg id="outer"><svg id="inner"><circle cx="3" cy="3" r="2"/></svg></svg>'
    );
    const source = master.querySelector('#inner');
    if (!source) throw new Error('Missing nested svg root.');

    const target = pasteComponentNode(master, 0, source, [0], null);

    const clone = elementAtPath(slide, target?.path ?? []);
    if (!clone) throw new Error('Missing pasted svg root.');
    // Inserting before offsetting is what makes the copy svg-internal, so the
    // 20 px moves through a transform rather than ignored inline styles.
    expect(target?.path).toEqual([0, 1]);
    expect(clone.getAttribute('transform')).toBe('translate(20 20)');
    expect(clone.hasAttribute('style')).toBe(false);
  });

  it('offsets a top-level svg root with html positioning', () => {
    const { master, slide } = componentMaster(
      '<svg id="plot"><circle cx="1" cy="1" r="1"/></svg>'
    );
    const source = master.querySelector('#plot');
    if (!source) throw new Error('Missing svg root.');

    const target = pasteComponentNode(master, 0, source, [], null);

    const clone = elementAtPath(slide, target?.path ?? []);
    if (!clone) throw new Error('Missing pasted svg root.');
    expect(target?.path).toEqual([1]);
    expect(clone.hasAttribute('transform')).toBe(false);
    expect(styleOf(clone).position).toBe('relative');
    expect(styleOf(clone).left).toBe('20px');
    expect(styleOf(clone).top).toBe('20px');
  });

  it('inserts after a slide-rooted anchor that lives inside the parent', () => {
    const { master, slide } = componentMaster(
      '<div id="stack"><p id="a" data-ppt-el="e1">A</p><p id="b">B</p><p id="c">C</p></div>'
    );
    const source = master.querySelector('#a');
    if (!source) throw new Error('Missing source anchor.');

    const target = pasteComponentNode(master, 0, source, [0], [0, 0]);

    expect(target?.path).toEqual([0, 1]);
    const parent = elementAtPath(slide, [0]);
    if (!parent) throw new Error('Missing paste parent.');
    expect(
      Array.from(parent.children, (child) => child.textContent)
    ).toEqual(['A', 'A', 'B', 'C']);
    expect(parent.children[1]?.getAttribute('data-ppt-el')).toBe(
      target?.elementId
    );
    expect(parent.children[1]?.getAttribute('data-ppt-el')).not.toBe('e1');
    expect(parent.children[2]?.textContent).toBe('B');
  });

  it('appends when the anchor is the destination parent itself', () => {
    // The trailing slide-level sibling is what exposes a missing direct-parent
    // guard: without the guard the parent would insert before #after, which is
    // not one of its children.
    const { master, slide } = componentMaster(
      '<div id="pad"><p id="a">A</p><p id="b">B</p></div><p id="after">After</p>'
    );
    const source = master.querySelector('#a');
    if (!source) throw new Error('Missing source element.');

    const target = pasteComponentNode(master, 0, source, [0], [0]);

    expect(target?.path).toEqual([0, 2]);
    const parent = elementAtPath(slide, [0]);
    expect(
      Array.from(parent?.children ?? [], (child) => child.textContent)
    ).toEqual(['A', 'B', 'A']);
  });

  it('appends when the anchor is outside the parent or null', () => {
    // #tail follows the foreign anchor so a guardless insert after
    // anchor.nextSibling targets a slide child and throws instead of
    // accidentally appending.
    const { master, slide } = componentMaster(
      '<div id="pad"><p id="a">A</p><p id="b">B</p><p id="c">C</p></div><p id="outside">Outside</p><p id="tail">Tail</p>'
    );
    const source = master.querySelector('#outside');
    if (!source) throw new Error('Missing source element.');

    // A slide-rooted anchor outside the parent must not be indexed into the
    // parent's children: the buggy parent.children[1] would land after B.
    const foreign = pasteComponentNode(master, 0, source, [0], [1]);
    expect(foreign?.path).toEqual([0, 3]);

    const parent = elementAtPath(slide, [0]);
    if (!parent) throw new Error('Missing paste parent.');
    expect(Array.from(parent.children, (child) => child.textContent)).toEqual([
      'A',
      'B',
      'C',
      'Outside'
    ]);

    const missing = pasteComponentNode(master, 0, source, [0], null);
    expect(missing?.path).toEqual([0, 4]);
    expect(Array.from(parent.children, (child) => child.textContent)).toEqual([
      'A',
      'B',
      'C',
      'Outside',
      'Outside'
    ]);
  });

  it('offsets a flow component with relative positioning inside its parent', () => {
    const { master, slide } = componentMaster(
      '<div id="pad"><p id="lead">L</p></div>'
    );
    const source = master.createElement('p');
    source.textContent = 'Flow';

    const target = pasteComponentNode(master, 0, source, [0], null);

    const clone = elementAtPath(slide, target?.path ?? []);
    if (!clone) throw new Error('Missing pasted flow element.');
    expect(target?.path).toEqual([0, 1]);
    expect(styleOf(clone).position).toBe('relative');
    expect(styleOf(clone).left).toBe('20px');
    expect(styleOf(clone).top).toBe('20px');
  });

  it('gives repeated pastes of the same source distinct fresh ids', () => {
    const { master } = componentMaster(
      '<div id="pad"><p id="a" data-ppt-el="e1">A</p></div>'
    );
    const source = master.querySelector('#a');
    if (!source) throw new Error('Missing source element.');

    const first = pasteComponentNode(master, 0, source, [0], null);
    const second = pasteComponentNode(master, 0, source, [0], null);

    // The second factory rescans the slide, so it sees the first clone.
    expect(first?.elementId).toBe('e2');
    expect(second?.elementId).toBe('e3');
    expect(first?.elementId).not.toBe(second?.elementId);
    expect(first?.elementId).not.toBe('e1');
  });

  it('measures an html paste inside its real parent with the parent path', () => {
    const { master, slide } = componentMaster(
      '<div id="pad"><p id="lead">L</p></div>'
    );
    const parent = elementAtPath(slide, [0]);
    if (!parent) throw new Error('Missing paste parent.');
    const seen: Element[] = [];
    const measure = vi.fn(
      (element: Element, parentPath?: readonly number[]) => {
        seen.push(element);
        expect(element.parentElement).toBe(parent);
        expect(parentPath).toEqual([0]);
        return { x: 300, y: 200, position: 'absolute' };
      }
    );
    const source = master.createElement('div');
    source.className = 'placed';
    source.textContent = 'Placed';

    const target = pasteComponentNode(master, 0, source, [0], null, measure);

    expect(measure).toHaveBeenCalledTimes(1);
    const clone = elementAtPath(slide, target?.path ?? []);
    if (!clone) throw new Error('Missing pasted placed element.');
    expect(seen[0]).toBe(clone);
    expect(styleOf(clone).position).toBe('absolute');
    expect(styleOf(clone).left).toBe('320px');
    expect(styleOf(clone).top).toBe('220px');
  });

  it('returns null for an unknown slide or parent path', () => {
    const { master } = componentMaster('<div id="pad"></div>');
    const source = master.querySelector('#pad');
    if (!source) throw new Error('Missing source element.');

    expect(pasteComponentNode(master, 9, source, [], null)).toBeNull();
    expect(pasteComponentNode(master, 0, source, [5], null)).toBeNull();
    expect(pasteComponentNode(master, 0, source, [0, 3], null)).toBeNull();
  });
});
