import { describe, expect, it } from 'vitest';
import { DeckMutationError, getElement } from '../src/index.js';
import { parseDeckHtml } from '../src/node.js';

const source = `<!doctype html><html><head><title>Read model deck</title></head><body>
<section data-slide-id="s1" data-width="1280" data-height="720">
  <h1 data-ppt-el="e1" style="color: red; font-size: 48px">Title</h1>
  <p data-ppt-el="e2">Body</p>
  <div data-ppt-el="e3"><span data-ppt-el="e4" style="font-weight: 700">Nested</span></div>
</section>
<section data-slide-id="s2"><h2 data-ppt-el="e5">Other</h2></section>
</body></html>`;

function mutationError(action: () => unknown): DeckMutationError {
  try {
    action();
  } catch (error) {
    if (error instanceof DeckMutationError) return error;
    throw error;
  }
  throw new Error('Expected a DeckMutationError.');
}

describe('getElement', () => {
  it('returns the outerHTML and raw style by element id', () => {
    const doc = parseDeckHtml(source);

    const element = getElement(doc, 's1', { elementId: 'e1' });

    expect(element.html).toBe(
      '<h1 data-ppt-el="e1" style="color: red; font-size: 48px">Title</h1>'
    );
    expect(element.style).toBe('color: red; font-size: 48px');
  });

  it('returns null style when the element has no inline style', () => {
    const element = getElement(parseDeckHtml(source), 's1', { elementId: 'e2' });

    expect(element.html).toBe('<p data-ppt-el="e2">Body</p>');
    expect(element.style).toBeNull();
  });

  it('resolves by selector and by child path, including nested elements', () => {
    const doc = parseDeckHtml(source);

    const bySelector = getElement(doc, 's1', { selector: 'h1' });
    expect(bySelector.style).toBe('color: red; font-size: 48px');

    const byPath = getElement(doc, 's1', { path: [2, 0] });
    expect(byPath).toEqual({
      html: '<span data-ppt-el="e4" style="font-weight: 700">Nested</span>',
      style: 'font-weight: 700'
    });
  });

  it('resolves elements on the body fallback slide', () => {
    const doc = parseDeckHtml(
      '<!doctype html><html><head><title>T</title></head><body><h1 data-ppt-el="e1">Body</h1></body></html>'
    );

    expect(getElement(doc, 'body', { elementId: 'e1' }).html).toBe(
      '<h1 data-ppt-el="e1">Body</h1>'
    );
  });

  it('does not modify the document', () => {
    const doc = parseDeckHtml(source);
    const before = doc.documentElement.outerHTML;

    getElement(doc, 's1', { elementId: 'e1' });

    expect(doc.documentElement.outerHTML).toBe(before);
  });

  it('throws stable codes for missing slides, missing targets, and ambiguous selectors', () => {
    const doc = parseDeckHtml(source);

    expect(mutationError(() => getElement(doc, 'missing', { elementId: 'e1' })).code).toBe(
      'slide-not-found'
    );
    expect(mutationError(() => getElement(doc, 's1', { elementId: 'missing' })).code).toBe(
      'target-not-found'
    );
    expect(mutationError(() => getElement(doc, 's1', { selector: 'p, h1' })).code).toBe(
      'target-ambiguous'
    );
    expect(mutationError(() => getElement(doc, 's1', { selector: '<<<' })).code).toBe(
      'target-invalid'
    );
    expect(mutationError(() => getElement(doc, 's1', { path: [] })).code).toBe(
      'target-invalid'
    );
  });
});
