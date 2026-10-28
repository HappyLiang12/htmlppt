import { describe, expect, it } from 'vitest';
import {
  componentLabel,
  componentPath,
  isSvgInternal,
  isTableInternal,
  normalizeSelectionPaths,
  resolveComponent,
  type ComponentStyleReader
} from './component-target.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function styleOf(
  map: Record<string, { display?: string; position?: string }>
): ComponentStyleReader {
  return (element) => {
    const key =
      element.id ||
      element.tagName.toLowerCase();
    return {
      display: map[key]?.display ?? 'block',
      position: map[key]?.position ?? 'static'
    };
  };
}

function slideOf(html: string): Element {
  const slide = document.createElement('section');
  slide.innerHTML = html;
  return slide;
}

describe('resolveComponent', () => {
  it('folds an inline span into its block text box', () => {
    const slide = slideOf('<p id="lead">Hello <span id="word">world</span></p>');
    const target = slide.querySelector('#word')!;
    expect(resolveComponent(slide, target, { getStyle: styleOf({ word: { display: 'inline' } }) })).toBe(
      slide.querySelector('#lead')
    );
  });

  it('returns the block target itself', () => {
    const slide = slideOf('<h1 id="head">Title</h1>');
    expect(resolveComponent(slide, slide.querySelector('#head')!, { getStyle: styleOf({}) })).toBe(
      slide.querySelector('#head')
    );
  });

  it('skips display:contents wrappers', () => {
    const slide = slideOf(
      '<div id="contents"><p id="body">Body</p></div>'
    );
    expect(
      resolveComponent(slide, slide.querySelector('#body')!, {
        getStyle: styleOf({ contents: { display: 'contents' } })
      })
    ).toBe(slide.querySelector('#body'));
  });

  it('treats a positioned inline element as its own component', () => {
    const slide = slideOf('<p id="lead">a <span id="dot">b</span></p>');
    expect(
      resolveComponent(slide, slide.querySelector('#dot')!, {
        getStyle: styleOf({ dot: { display: 'inline', position: 'absolute' } })
      })
    ).toBe(slide.querySelector('#dot'));
  });

  it('stops at an atomic svg even when a path is the target', () => {
    const slide = slideOf('<svg id="chart"><path id="bar" d="M0 0h10"/></svg>');
    expect(
      resolveComponent(slide, slide.querySelector('#bar')!, {
        getStyle: styleOf({ bar: { display: 'inline' } })
      })
    ).toBe(slide.querySelector('#chart'));
  });

  it('stops at an atomic chart figure', () => {
    const slide = slideOf(
      '<figure id="chart" data-ppt-chart="{}"><svg id="plot"><rect id="bar"/></svg></figure>'
    );
    expect(
      resolveComponent(slide, slide.querySelector('#bar')!, {
        getStyle: styleOf({ bar: { display: 'inline' } })
      })
    ).toBe(slide.querySelector('#chart'));
  });

  it('stops at img, canvas, video and iframe', () => {
    const tags = ['img', 'canvas', 'video', 'iframe'];
    for (const tag of tags) {
      const slide = slideOf(`<div id="wrap"><${tag} id="atom"></${tag}></div>`);
      expect(
        resolveComponent(slide, slide.querySelector('#atom')!, {
          getStyle: styleOf({ atom: { display: 'inline' } })
        })
      ).toBe(slide.querySelector('#atom'));
    }
  });

  it('returns a guarded wrapper instead of a block descendant', () => {
    const slide = slideOf(
      '<div id="group" data-ppt-group="true"><div id="inner"><p id="body">x</p></div></div>'
    );
    expect(
      resolveComponent(slide, slide.querySelector('#body')!, { getStyle: styleOf({}) })
    ).toBe(slide.querySelector('#group'));
  });

  it('returns null for the slide root and foreign targets', () => {
    const slide = slideOf('<p id="body">x</p>');
    expect(resolveComponent(slide, slide, { getStyle: styleOf({}) })).toBeNull();
    const other = document.createElement('p');
    expect(resolveComponent(slide, other, { getStyle: styleOf({}) })).toBeNull();
  });

  it('excludes descendants of a notes aside', () => {
    const slide = slideOf('<aside data-ppt-notes="1"><p id="note">n</p></aside>');
    expect(
      resolveComponent(slide, slide.querySelector('#note')!, { getStyle: styleOf({}) })
    ).toBeNull();
  });
});

describe('componentPath', () => {
  it('returns the raw child-index path from the slide', () => {
    const slide = slideOf('<div id="pad"><h1 id="head">T</h1></div>');
    expect(componentPath(slide, slide.querySelector('#head')!)).toEqual([0, 0]);
  });
});

describe('componentLabel', () => {
  it('uses the lowercase tag and the first class', () => {
    const slide = slideOf('<h1 id="head" class="cover-title  big">T</h1>');
    expect(componentLabel(slide.querySelector('#head')!)).toBe('h1.cover-title');
    expect(componentLabel(slide.querySelector('#head')!.cloneNode() as Element)).toBe(
      'h1.cover-title'
    );
  });

  it('falls back to the tag alone', () => {
    const slide = slideOf('<svg id="arrow"></svg>');
    expect(componentLabel(slide.querySelector('#arrow')!)).toBe('svg');
  });
});

describe('isSvgInternal and isTableInternal', () => {
  it('separates the svg root from its shapes', () => {
    const svg = document.createElementNS(SVG_NS, 'svg');
    const group = document.createElementNS(SVG_NS, 'g');
    svg.appendChild(group);
    expect(isSvgInternal(svg)).toBe(false);
    expect(isSvgInternal(group)).toBe(true);
    const html = document.createElement('div');
    expect(isSvgInternal(html)).toBe(false);
  });

  it('treats a nested svg root as svg-internal', () => {
    const outer = document.createElementNS(SVG_NS, 'svg');
    const inner = document.createElementNS(SVG_NS, 'svg');
    outer.appendChild(inner);
    expect(isSvgInternal(inner)).toBe(true);
  });

  it('keeps a top-level svg root in HTML content outside svg content', () => {
    const host = document.createElement('div');
    const svg = document.createElementNS(SVG_NS, 'svg');
    host.appendChild(svg);
    expect(isSvgInternal(svg)).toBe(false);
  });

  it('keeps an svg inside an HTML parent inside foreignObject outside svg content', () => {
    const outer = document.createElementNS(SVG_NS, 'svg');
    const foreign = document.createElementNS(SVG_NS, 'foreignObject');
    const html = document.createElement('div');
    const inner = document.createElementNS(SVG_NS, 'svg');
    html.appendChild(inner);
    foreign.appendChild(html);
    outer.appendChild(foreign);
    expect(isSvgInternal(inner)).toBe(false);
  });

  it('separates a table from its cells', () => {
    const slide = slideOf('<table id="table"><tbody><tr><td id="cell">x</td></tr></tbody></table>');
    expect(isTableInternal(slide.querySelector('#table')!)).toBe(false);
    expect(isTableInternal(slide.querySelector('#cell')!)).toBe(true);
  });
});

describe('normalizeSelectionPaths', () => {
  it('drops a descendant when its ancestor is selected', () => {
    expect(normalizeSelectionPaths([[0], [0, 1], [2]])).toEqual([[0], [2]]);
  });

  it('replaces descendants when an ancestor is added later', () => {
    expect(normalizeSelectionPaths([[0, 1], [0]])).toEqual([[0]]);
  });

  it('keeps unrelated paths and drops duplicates', () => {
    expect(normalizeSelectionPaths([[0, 1], [0, 2], [0, 1]])).toEqual([
      [0, 1],
      [0, 2]
    ]);
  });
});
