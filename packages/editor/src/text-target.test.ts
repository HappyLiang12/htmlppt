import { describe, expect, it } from 'vitest';
import { resolveSelectedTextTarget } from './text-target';

const SLIDE = `<!doctype html><html><body>
<section data-slide-id="s1">
  <div data-ppt-el="wrapper"><h1>Title</h1><p>Body</p></div>
  <div data-ppt-el="box">Box text</div>
  <h1 data-ppt-el="empty-heading"></h1>
  <div data-ppt-el="empty-box"></div>
  <div data-ppt-el="locked" data-ppt-locked="true"><h1>Locked</h1></div>
  <div data-ppt-el="grouped" data-ppt-group=""><h1>Grouped</h1></div>
  <div data-ppt-el="partial"><div data-ppt-locked="true"><h2>Locked inner</h2></div><h2>Open inner</h2></div>
  <div data-ppt-el="skip-empty"><h1></h1><p>Later</p></div>
  <div data-ppt-el="hidden" style="display:none"><h1>Hidden</h1></div>
  <div data-ppt-el="layout"><img src="x"></div>
  <img data-ppt-el="image" src="x">
</section>
</body></html>`;

function slideElement(): Element {
  const doc = new DOMParser().parseFromString(SLIDE, 'text/html');
  return doc.querySelector('section') as Element;
}

describe('resolveSelectedTextTarget', () => {
  it('resolves a primary leaf inside a wrapper object', () => {
    const result = resolveSelectedTextTarget(slideElement(), [0]);
    expect(result.status).toBe('editable');
    if (result.status === 'editable') {
      expect(result.leaf.tagName).toBe('H1');
      expect(result.empty).toBe(false);
    }
  });

  it('uses a box div itself as the leaf', () => {
    const result = resolveSelectedTextTarget(slideElement(), [1]);
    expect(result.status).toBe('editable');
    if (result.status === 'editable') {
      expect(result.leaf.tagName).toBe('DIV');
    }
  });

  it('blocks an empty semantic element but allows an empty div', () => {
    expect(resolveSelectedTextTarget(slideElement(), [2])).toEqual({
      status: 'blocked',
      reason: 'empty'
    });
    const emptyBox = resolveSelectedTextTarget(slideElement(), [3]);
    expect(emptyBox.status).toBe('editable');
    if (emptyBox.status === 'editable') expect(emptyBox.empty).toBe(true);
  });

  it('reports top-level guards', () => {
    expect(resolveSelectedTextTarget(slideElement(), [4])).toEqual({
      status: 'blocked',
      reason: 'locked'
    });
    expect(resolveSelectedTextTarget(slideElement(), [5])).toEqual({
      status: 'blocked',
      reason: 'group'
    });
    expect(resolveSelectedTextTarget(slideElement(), [8])).toEqual({
      status: 'blocked',
      reason: 'hidden'
    });
  });

  it('skips guarded and empty candidates inside a wrapper', () => {
    const partial = resolveSelectedTextTarget(slideElement(), [6]);
    expect(partial.status).toBe('editable');
    if (partial.status === 'editable') {
      expect(partial.leaf.textContent).toBe('Open inner');
    }

    const skipEmpty = resolveSelectedTextTarget(slideElement(), [7]);
    expect(skipEmpty.status).toBe('editable');
    if (skipEmpty.status === 'editable') {
      expect(skipEmpty.leaf.textContent).toBe('Later');
    }
  });

  it('blocks a nested guarded leaf and non-text objects', () => {
    expect(resolveSelectedTextTarget(slideElement(), [6, 0])).toEqual({
      status: 'blocked',
      reason: 'locked'
    });
    expect(resolveSelectedTextTarget(slideElement(), [9])).toEqual({
      status: 'blocked',
      reason: 'has-children'
    });
    expect(resolveSelectedTextTarget(slideElement(), [10])).toEqual({
      status: 'blocked',
      reason: 'not-text'
    });
  });
});
