import { describe, expect, it } from 'vitest';
import {
  isPositioned,
  shouldDismissPinNotice,
  shouldNotifyPin,
  willAnyPinToAbsolute,
  willPinToAbsolute
} from './geometry-guards';

function element(style: string): Element {
  const doc = new DOMParser().parseFromString(
    `<div style="${style}"></div>`,
    'text/html'
  );
  return doc.body.firstElementChild as Element;
}

/** XML elements have no CSSStyleDeclaration, like non-HTML deck objects. */
function withoutStyle(): Element {
  const doc = new DOMParser().parseFromString('<foo/>', 'application/xml');
  return doc.documentElement;
}

describe('isPositioned', () => {
  it('is true only for absolute and fixed inline positions', () => {
    expect(isPositioned(element('position:absolute'))).toBe(true);
    expect(isPositioned(element('position:fixed'))).toBe(true);
  });

  it('is false for flow positions and an absent position', () => {
    expect(isPositioned(element('position:relative;left:10px'))).toBe(false);
    expect(isPositioned(element('position:sticky;top:0'))).toBe(false);
    expect(isPositioned(element('position:static'))).toBe(false);
    expect(isPositioned(element('display:grid'))).toBe(false);
  });

  it('is false when the element has no inline style', () => {
    expect(isPositioned(withoutStyle())).toBe(false);
  });
});

describe('willPinToAbsolute', () => {
  it('is true for a flow element', () => {
    expect(willPinToAbsolute(element('display:grid'))).toBe(true);
  });

  it('is false for an absolute or fixed element', () => {
    expect(willPinToAbsolute(element('position:absolute;left:0'))).toBe(false);
    expect(willPinToAbsolute(element('position:fixed;top:0'))).toBe(false);
  });

  it('is false without an inline style', () => {
    expect(willPinToAbsolute(withoutStyle())).toBe(false);
  });
});

describe('willAnyPinToAbsolute', () => {
  it('is true when any gesture target is still in flow', () => {
    expect(
      willAnyPinToAbsolute([
        element('position:absolute'),
        element('display:grid')
      ])
    ).toBe(true);
  });

  it('is false when every target is positioned or the gesture has none', () => {
    expect(
      willAnyPinToAbsolute([
        element('position:absolute'),
        element('position:fixed')
      ])
    ).toBe(false);
    expect(willAnyPinToAbsolute([])).toBe(false);
  });
});

describe('shouldNotifyPin', () => {
  it('notifies only for the first pin of the session', () => {
    expect(shouldNotifyPin(true, false)).toBe(true);
    expect(shouldNotifyPin(true, true)).toBe(false);
    expect(shouldNotifyPin(false, false)).toBe(false);
  });
});

describe('shouldDismissPinNotice', () => {
  it('dismisses a visible notice when a pending edit exists', () => {
    expect(shouldDismissPinNotice(true, true, false)).toBe(true);
  });

  it('dismisses a visible notice when a text session starts', () => {
    expect(shouldDismissPinNotice(true, false, true)).toBe(true);
  });

  it('keeps a visible notice while neither hazard applies', () => {
    expect(shouldDismissPinNotice(true, false, false)).toBe(false);
  });

  it('reports no dismissal when the notice is hidden', () => {
    expect(shouldDismissPinNotice(false, true, true)).toBe(false);
  });
});
