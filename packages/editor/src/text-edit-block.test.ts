import { describe, expect, it } from 'vitest';
import { textEditBlockFor } from './text-edit-block';

function pick(html: string, selector: string): Element {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.querySelector(selector) as Element;
}

describe('textEditBlockFor', () => {
  it('rejects elements outside the text tag contract', () => {
    expect(textEditBlockFor(pick('<button>Go</button>', 'button'))).toBe('not-text');
    expect(textEditBlockFor(pick('<a href="#">Go</a>', 'a'))).toBe('not-text');
    expect(textEditBlockFor(pick('<svg><text>x</text></svg>', 'text'))).toBe('not-text');
  });

  it('rejects a layout div that has element children', () => {
    expect(textEditBlockFor(pick('<div><span>a</span></div>', 'div'))).toBe('has-children');
  });

  it('rejects an empty semantic element', () => {
    expect(textEditBlockFor(pick('<h1></h1>', 'h1'))).toBe('empty');
  });

  it('accepts a text leaf and an empty div', () => {
    expect(textEditBlockFor(pick('<h1>Title</h1>', 'h1'))).toBeNull();
    expect(textEditBlockFor(pick('<div></div>', 'div'))).toBeNull();
  });

  it('keeps a text tag nested in a layout div editable', () => {
    // The nearest text tag wins: drill-in must not block inline spans.
    expect(textEditBlockFor(pick('<div><span>a</span></div>', 'span'))).toBeNull();
  });

  it('accepts a div with only line breaks and an empty table cell', () => {
    expect(textEditBlockFor(pick('<div><br></div>', 'div'))).toBeNull();
    expect(
      textEditBlockFor(pick('<table><tbody><tr><td></td></tr></tbody></table>', 'td'))
    ).toBeNull();
  });

  it('resolves targets from the preview iframe realm', () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    try {
      const doc = frame.contentDocument as Document;
      doc.body.innerHTML = '<h1>Title</h1><button>Go</button>';
      const heading = doc.querySelector('h1') as Element;
      // The preview document lives in its own realm, where the parent
      // window's constructors do not describe its nodes.
      expect(heading instanceof HTMLElement).toBe(false);
      expect(textEditBlockFor(heading)).toBeNull();
      expect(textEditBlockFor(doc.querySelector('button') as Element)).toBe(
        'not-text'
      );
    } finally {
      frame.remove();
    }
  });
});
