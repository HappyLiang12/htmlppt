import { describe, expect, it } from 'vitest';
import { focusableWithin, wrapFocusIndex } from './focus.js';

describe('focusableWithin', () => {
  it('keeps enabled, sequentially focusable controls in DOM order', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <button id="a">A</button>
      <button id="b" disabled>B</button>
      <input id="c" />
      <a id="d">No href</a>
      <a id="e" href="#target">Link</a>
      <div id="f" tabindex="-1"></div>
      <div id="g" tabindex="0"></div>
      <button id="h" aria-hidden="true">Hidden</button>
    `;

    expect(focusableWithin(root).map((element) => element.id)).toEqual([
      'a',
      'c',
      'e',
      'g'
    ]);
  });
});

describe('wrapFocusIndex', () => {
  it('moves forward and wraps from the last control', () => {
    expect(wrapFocusIndex(0, 3, false)).toBe(1);
    expect(wrapFocusIndex(2, 3, false)).toBe(0);
  });

  it('moves backward and wraps from the first control', () => {
    expect(wrapFocusIndex(1, 3, true)).toBe(0);
    expect(wrapFocusIndex(0, 3, true)).toBe(2);
  });

  it('returns -1 for an empty focus ring', () => {
    expect(wrapFocusIndex(0, 0, false)).toBe(-1);
  });
});
