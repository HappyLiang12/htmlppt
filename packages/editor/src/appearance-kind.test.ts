import { describe, expect, it } from 'vitest';
import { appearanceKindFor } from './appearance-kind';

function element(html: string): Element {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body.firstElementChild as Element;
}

function descendant(html: string, selector: string): Element {
  return element(html).querySelector(selector) as Element;
}

describe('appearanceKindFor', () => {
  it('keeps images on the image controls', () => {
    expect(appearanceKindFor(element('<img alt="">'))).toBe('image');
  });

  it('maps HTML elements to shape styles', () => {
    for (const html of [
      '<p></p>',
      '<h1></h1>',
      '<article></article>',
      '<div></div>'
    ]) {
      expect(appearanceKindFor(element(html))).toBe('shape');
    }
  });

  it('maps only the outermost svg to shape styles', () => {
    expect(appearanceKindFor(element('<svg></svg>'))).toBe('shape');
    expect(appearanceKindFor(descendant('<svg><svg></svg></svg>', 'svg svg'))).toBeNull();
  });

  it('returns no kind for SVG descendants', () => {
    expect(appearanceKindFor(descendant('<svg><path></path></svg>', 'path'))).toBeNull();
    expect(
      appearanceKindFor(descendant('<svg><g><text></text></g></svg>', 'text'))
    ).toBeNull();
  });

  it('returns no kind for elements without a style object', () => {
    const math = element('<math><mi>x</mi></math>');
    Object.defineProperty(math, 'style', { configurable: true, value: undefined });
    expect(appearanceKindFor(math)).toBeNull();

    const bare = {
      namespaceURI: 'http://www.w3.org/1998/Math/MathML',
      tagName: 'math',
      parentElement: null
    } as unknown as Element;
    expect(appearanceKindFor(bare)).toBeNull();
  });
});
