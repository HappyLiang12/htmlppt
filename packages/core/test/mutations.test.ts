import { describe, expect, it } from 'vitest';
import {
  DeckMutationError,
  addElement,
  mutateDeck,
  removeElement,
  resolveTarget,
  setElementHtml,
  setStyle,
  setText
} from '../src/mutations.js';
import { parseDeckHtml } from '../src/node.js';

const source = `<!doctype html><html><head><title>Deck</title></head><body><section data-slide-id="s1"><h1 data-ppt-el="e1" class="title">Hello</h1><p data-ppt-el="e2">Body</p></section><section data-slide-id="s2"><h2>Other</h2></section></body></html>`;

const slide = (doc: Document, id = 's1') =>
  doc.querySelector(`[data-slide-id="${id}"]`) as Element;

describe('resolveTarget', () => {
  it('resolves by element id, selector, and path', () => {
    const doc = parseDeckHtml(source);
    const root = slide(doc);
    expect(resolveTarget(root, { elementId: 'e2' }).getAttribute('data-ppt-el')).toBe('e2');
    expect(resolveTarget(root, { selector: 'h1.title' }).tagName).toBe('H1');
    expect(resolveTarget(root, { path: [1] }).getAttribute('data-ppt-el')).toBe('e2');
  });

  it('rejects missing, ambiguous, and invalid targets', () => {
    const root = slide(parseDeckHtml(source));
    expect(() => resolveTarget(root, { elementId: 'nope' })).toThrow(
      expect.objectContaining({ code: 'target-not-found' })
    );
    expect(() => resolveTarget(root, { selector: 'p, h1' })).toThrow(
      expect.objectContaining({ code: 'target-ambiguous' })
    );
    expect(() => resolveTarget(root, { selector: '<<<' })).toThrow(
      expect.objectContaining({ code: 'target-invalid' })
    );
    expect(() => resolveTarget(root, { path: [9] })).toThrow(
      expect.objectContaining({ code: 'target-not-found' })
    );
  });
});

describe('element mutations', () => {
  it('sets text as text, not markup', () => {
    const doc = parseDeckHtml(source);
    const target = resolveTarget(slide(doc), { elementId: 'e1' });
    setText(target, '<b>Escaped</b>');
    expect(target.textContent).toBe('<b>Escaped</b>');
    expect(target.querySelector('b')).toBeNull();
  });

  it('applies and removes inline styles with validation', () => {
    const doc = parseDeckHtml(source);
    const target = resolveTarget(slide(doc), { elementId: 'e1' }) as HTMLElement;
    setStyle(target, { color: 'red', 'font-size': '48px' });
    expect(target.style.color).toBe('red');
    expect(target.style.fontSize).toBe('48px');
    setStyle(target, { color: null });
    expect(target.style.color).toBe('');
    expect(() => setStyle(target, { 'bad property': 'x' })).toThrow(
      expect.objectContaining({ code: 'invalid-style-property' })
    );
  });

  it('replaces element html and adds/removes top-level elements', () => {
    const doc = parseDeckHtml(source);
    const root = slide(doc);
    setElementHtml(resolveTarget(root, { elementId: 'e1' }), '<em>New</em>');
    expect(root.querySelector('h1 em')?.textContent).toBe('New');

    addElement(root, '<div class="badge">New</div>', { elementId: 'e2' });
    const added = resolveTarget(root, { selector: 'div.badge' });
    expect(added.getAttribute('data-ppt-el')).not.toBeNull();

    removeElement(added);
    expect(root.querySelector('div.badge')).toBeNull();
  });

  it('rejects fragments with zero or multiple roots', () => {
    const root = slide(parseDeckHtml(source));
    expect(() => addElement(root, '<b>one</b><b>two</b>')).toThrow(
      expect.objectContaining({ code: 'invalid-fragment' })
    );
    expect(() => addElement(root, 'text only')).toThrow(
      expect.objectContaining({ code: 'invalid-fragment' })
    );
  });

  it('rejects insertion anchors nested below the slide', () => {
    const doc = parseDeckHtml(
      `<!doctype html><html><head><title>Deck</title></head><body><section data-slide-id="s1"><div data-ppt-el="e1"><span data-ppt-el="e2">Nested</span></div></section></body></html>`
    );

    expect(() =>
      addElement(slide(doc), '<b>new</b>', { elementId: 'e2' })
    ).toThrow(expect.objectContaining({ code: 'target-invalid' }));
  });

  it('does not remove the slide itself', () => {
    const root = slide(parseDeckHtml(source));
    expect(() => removeElement(root)).toThrow(
      expect.objectContaining({ code: 'cannot-remove-slide' })
    );
  });
});

describe('mutateDeck', () => {
  it('clones, normalizes, and returns a new valid document', () => {
    const before = parseDeckHtml(source);
    const beforeHtml = before.documentElement.outerHTML;

    const { document, result } = mutateDeck(before, (draft) => {
      const root = slide(draft);
      return addElement(root, '<section class="note"><span>Added</span></section>');
    });

    expect(before.documentElement.outerHTML).toBe(beforeHtml);
    expect(result.getAttribute('data-ppt-el')).toBe('e3');
    // Normalization tags all slides, including the previously untagged h2 in s2.
    expect(document.querySelectorAll('[data-ppt-el]')).toHaveLength(4);
    expect(document.querySelector('section.note')).not.toBeNull();
  });

  it('rejects a mutation that produces an invalid deck without touching the source', () => {
    const doc = parseDeckHtml(source);
    const beforeHtml = doc.documentElement.outerHTML;
    let caught: unknown;

    try {
      mutateDeck(doc, (draft) => {
        setElementHtml(
          resolveTarget(slide(draft), { elementId: 'e1' }),
          '<figure data-ppt-chart="{bad}"></figure>'
        );
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DeckMutationError);
    expect(caught).toMatchObject({ code: 'invalid-result' });
    expect(doc.documentElement.outerHTML).toBe(beforeHtml);
  });
});
