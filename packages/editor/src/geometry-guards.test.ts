import { describe, expect, it } from 'vitest';
import { willPinToAbsolute } from './geometry-guards';

function element(style: string): Element {
  const doc = new DOMParser().parseFromString(
    `<div style="${style}"></div>`,
    'text/html'
  );
  return doc.body.firstElementChild as Element;
}

describe('willPinToAbsolute', () => {
  it('is true for a flow element', () => {
    expect(willPinToAbsolute(element('display:grid'))).toBe(true);
  });

  it('is false for an absolute or fixed element', () => {
    expect(willPinToAbsolute(element('position:absolute;left:0'))).toBe(false);
    expect(willPinToAbsolute(element('position:fixed;top:0'))).toBe(false);
  });
});
