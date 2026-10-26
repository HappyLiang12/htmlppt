import { describe, expect, it } from 'vitest';
import { appearanceKindFor } from './appearance-kind';

function element(html: string): Element {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body.firstElementChild as Element;
}

describe('appearanceKindFor', () => {
  it('keeps images on the image controls', () => {
    expect(appearanceKindFor(element('<img alt="">'))).toBe('image');
  });

  it('treats every other element as a shape', () => {
    for (const html of [
      '<p></p>',
      '<h1></h1>',
      '<article></article>',
      '<div></div>',
      '<svg></svg>'
    ]) {
      expect(appearanceKindFor(element(html))).toBe('shape');
    }
  });
});
