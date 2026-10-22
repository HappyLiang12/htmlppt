// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyInlineStyle,
  clearFormatting,
  normalizeLinkHref,
  sanitizePastedText,
  setBlockAlignment,
  setLink,
  toggleList
} from '../src/rich-text.js';

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  const root = document.body.firstElementChild;
  if (!(root instanceof HTMLElement)) {
    throw new Error('The fixture has no root element.');
  }
  return root;
}

function textRange(
  node: Node,
  start: number,
  end = start
): Range {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  return range;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.getSelection()?.removeAllRanges();
});

describe('applyInlineStyle', () => {
  it('wraps exactly the selected characters and leaves neighbours alone', () => {
    const paragraph = mount('<p>Hello world</p>');
    const text = paragraph.firstChild!;
    const range = textRange(text, 1, 4);

    const span = applyInlineStyle(range, { 'font-weight': 'bold' });

    expect(span.textContent).toBe('ell');
    expect(span.style.fontWeight).toBe('bold');
    expect(paragraph.textContent).toBe('Hello world');
    expect(paragraph.childNodes).toHaveLength(3);
    expect(paragraph.firstChild?.textContent).toBe('H');
    expect(paragraph.lastChild?.textContent).toBe('o world');
    expect(document.getSelection()?.toString()).toBe('ell');
  });

  it('nests a second style over the first and keeps inherited weight', () => {
    const paragraph = mount('<p>Hello</p>');
    const range = textRange(paragraph.firstChild!, 0, 5);
    applyInlineStyle(range, { 'font-weight': 'bold' });

    const bold = paragraph.querySelector('span')!;
    const nested = textRange(bold.firstChild!, 0, 5);
    applyInlineStyle(nested, { 'font-style': 'italic', color: 'red' });

    expect(paragraph.textContent).toBe('Hello');
    const outer = paragraph.querySelector('span')!;
    const inner = outer.querySelector('span')!;
    expect(outer.style.fontWeight).toBe('bold');
    expect(inner.style.fontStyle).toBe('italic');
    expect(inner.style.color).toBe('red');
    expect(document.getSelection()?.toString()).toBe('Hello');
  });

  it('inserts an empty styled span at a collapsed caret', () => {
    const paragraph = mount('<p>abc</p>');
    const range = textRange(paragraph.firstChild!, 3, 3);

    const span = applyInlineStyle(range, { color: 'rgb(0, 0, 255)' });

    expect(span.textContent).toBe('');
    expect(span.isConnected).toBe(true);
    expect(span.style.color).toBe('rgb(0, 0, 255)');
  });

  it('ignores invalid property names instead of writing them', () => {
    const paragraph = mount('<p>abc</p>');
    const span = applyInlineStyle(textRange(paragraph.firstChild!, 0, 3), {
      'font-weight': 'bold',
      'bad property': 'x'
    });

    expect(span.style.fontWeight).toBe('bold');
    expect(span.getAttribute('style')).not.toContain('bad property');
  });
});

describe('clearFormatting', () => {
  it('removes spans, emphasis, and inline styles while keeping text', () => {
    const paragraph = mount(
      '<p><strong>Bold</strong> plain <span style="color: red">red</span></p>'
    );
    const range = document.createRange();
    range.selectNodeContents(paragraph);

    clearFormatting(range);

    expect(paragraph.querySelector('span, strong, em, b, i, u')).toBeNull();
    expect(paragraph.textContent).toBe('Bold plain red');
  });

  it('clears the nearest element style for a collapsed caret', () => {
    const paragraph = mount('<p><span style="color: red">red</span></p>');
    const span = paragraph.querySelector('span')!;

    clearFormatting(textRange(span.firstChild!, 1, 1));

    expect(span.getAttribute('style')).toBeNull();
    expect(span.textContent).toBe('red');
  });
});

describe('links', () => {
  it('wraps a selection in an anchor with an allowed href', () => {
    const paragraph = mount('<p>Visit example</p>');
    const range = textRange(paragraph.firstChild!, 6, 13);

    const anchor = setLink(range, ' https://example.com ');

    expect(anchor?.tagName).toBe('A');
    expect(anchor?.getAttribute('href')).toBe('https://example.com');
    expect(anchor?.textContent).toBe('example');
    expect(paragraph.textContent).toBe('Visit example');
  });

  it('accepts mailto and fragment links', () => {
    const paragraph = mount('<p>Mail</p>');
    const anchor = setLink(textRange(paragraph.firstChild!, 0, 4), 'mailto:a@b.c');
    expect(anchor?.getAttribute('href')).toBe('mailto:a@b.c');
    expect(normalizeLinkHref('#slide-2')).toBe('#slide-2');
  });

  it('rejects script and data URLs without changing the document', () => {
    const paragraph = mount('<p>Hello</p>');

    for (const href of [
      'javascript:alert(1)',
      ' JaVaScRiPt:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)'
    ]) {
      expect(() =>
        setLink(textRange(paragraph.firstChild!, 0, 5), href)
      ).toThrow(/http:|fragment/);
    }
    expect(paragraph.innerHTML).toBe('Hello');
  });

  it('requires a selection for a fresh link', () => {
    const paragraph = mount('<p>Hello</p>');
    expect(() => setLink(textRange(paragraph.firstChild!, 2, 2), 'https://x.test'))
      .toThrow(/Select text/);
  });

  it('updates a link the selection is already inside', () => {
    const paragraph = mount('<p><a href="https://old.test">Hello</a></p>');
    const text = paragraph.querySelector('a')!.firstChild!;

    const anchor = setLink(textRange(text, 0, 5), 'https://new.test');

    expect(anchor?.getAttribute('href')).toBe('https://new.test');
    expect(paragraph.querySelectorAll('a')).toHaveLength(1);
    expect(paragraph.textContent).toBe('Hello');
  });

  it('removes a link when the href is empty', () => {
    const paragraph = mount('<p><a href="https://old.test">Hello</a></p>');
    const text = paragraph.querySelector('a')!.firstChild!;

    setLink(textRange(text, 0, 5), '');

    expect(paragraph.querySelector('a')).toBeNull();
    expect(paragraph.textContent).toBe('Hello');
  });

  it('rejects relative URLs without a scheme', () => {
    expect(() => normalizeLinkHref('docs/page.html')).toThrow(/absolute URL/);
  });
});

describe('toggleList', () => {
  it('converts a paragraph into a list item and back', () => {
    const paragraph = mount('<p>One</p>');

    const item = toggleList(document, paragraph, 'ul');
    const list = item.parentElement!;
    expect(list.tagName).toBe('UL');
    expect(item.tagName).toBe('LI');
    expect(item.textContent).toBe('One');
    expect(document.body.querySelector('p')).toBeNull();

    const back = toggleList(document, item, 'ul');
    expect(back.tagName).toBe('P');
    expect(back.textContent).toBe('One');
    expect(document.body.querySelector('ul')).toBeNull();
  });

  it('splits a multi-item list around a removed item', () => {
    mount('<ul><li>A</li><li>B</li><li>C</li></ul>');
    const middle = document.querySelectorAll('li')[1]!;

    toggleList(document, middle, 'ul');

    const children = Array.from(document.body.children);
    expect(children.map((child) => child.tagName)).toEqual(['UL', 'P', 'UL']);
    expect(children[0]?.textContent).toBe('A');
    expect(children[1]?.textContent).toBe('B');
    expect(children[2]?.textContent).toBe('C');
  });

  it('switches the list type without losing items', () => {
    mount('<ul><li>A</li><li>B</li></ul>');
    const item = document.querySelector('li')!;

    toggleList(document, item, 'ol');

    expect(document.querySelector('ul')).toBeNull();
    expect(document.querySelector('ol')?.children).toHaveLength(2);
    expect(document.body.textContent).toBe('AB');
  });

  it('preserves the block inline style on the list item', () => {
    mount('<p style="color: red">Styled</p>');
    const paragraph = document.querySelector('p')!;

    const item = toggleList(document, paragraph, 'ul');

    expect(item.getAttribute('style')).toBe('color: red');
  });

  it('keeps object identity and layout attributes on the list item', () => {
    mount(
      '<p class="layout object" data-ppt-el="obj-1" data-ppt-title="T" style="color: red" contenteditable="true" data-ppt-editing="true">One</p>'
    );
    const paragraph = document.querySelector('p')!;

    const item = toggleList(document, paragraph, 'ul');

    expect(item.getAttribute('class')).toBe('layout object');
    expect(item.getAttribute('data-ppt-el')).toBe('obj-1');
    expect(item.getAttribute('data-ppt-title')).toBe('T');
    expect(item.getAttribute('style')).toBe('color: red');
    expect(item.hasAttribute('contenteditable')).toBe(false);
    expect(item.hasAttribute('data-ppt-editing')).toBe(false);

    const back = toggleList(document, item, 'ul');

    expect(back.tagName).toBe('P');
    expect(back.getAttribute('class')).toBe('layout object');
    expect(back.getAttribute('data-ppt-el')).toBe('obj-1');
    expect(back.getAttribute('data-ppt-title')).toBe('T');
    expect(back.getAttribute('style')).toBe('color: red');
    expect(back.hasAttribute('contenteditable')).toBe(false);
    expect(back.hasAttribute('data-ppt-editing')).toBe(false);
  });

  it('restores object attributes when removing one item from a list', () => {
    mount(
      '<ul><li>A</li><li class="layout" data-ppt-el="obj-2" data-ppt-title="T">B</li><li>C</li></ul>'
    );
    const middle = document.querySelectorAll('li')[1]!;

    const paragraph = toggleList(document, middle, 'ul');

    expect(paragraph.tagName).toBe('P');
    expect(paragraph.getAttribute('class')).toBe('layout');
    expect(paragraph.getAttribute('data-ppt-el')).toBe('obj-2');
    expect(paragraph.getAttribute('data-ppt-title')).toBe('T');
    expect(paragraph.textContent).toBe('B');
  });

  it('keeps item attributes when switching the list type', () => {
    mount('<ul><li class="layout" data-ppt-el="obj-3">A</li></ul>');
    const item = document.querySelector('li')!;

    const result = toggleList(document, item, 'ol');

    expect(result).toBe(item);
    expect(result.parentElement?.tagName).toBe('OL');
    expect(result.getAttribute('class')).toBe('layout');
    expect(result.getAttribute('data-ppt-el')).toBe('obj-3');
  });
});

describe('setBlockAlignment', () => {
  it('sets and clears text-align', () => {
    const paragraph = mount('<p>Text</p>');

    setBlockAlignment(paragraph, 'center');
    expect(paragraph.style.textAlign).toBe('center');

    setBlockAlignment(paragraph, 'bogus');
    expect(paragraph.style.textAlign).toBe('');
  });
});

describe('sanitizePastedText', () => {
  it('strips markup, script bodies, control characters, and CRLF', () => {
    expect(
      sanitizePastedText(
        '<script>alert(1)</script><b>Bold</b>\r\nnext\u0000 <style>p{}</style>'
      )
    ).toBe('Bold\nnext ');

    expect(sanitizePastedText('5 < 10')).toBe('5 < 10');
  });
});
