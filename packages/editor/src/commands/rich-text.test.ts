import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyTextCommand,
  readTextToolbarState,
  textBlockOf
} from './rich-text';

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  const root = document.body.firstElementChild;
  if (!(root instanceof HTMLElement)) {
    throw new Error('The fixture has no root element.');
  }
  return root;
}

function selectText(node: Node, start: number, end = start): Range {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return range;
}

function selectAll(element: HTMLElement): Range {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return range;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.getSelection()?.removeAllRanges();
});

describe('rich-text editor commands', () => {
  it('bolds exactly the selected characters and reports the state', () => {
    const heading = mount('<h1>Hello world</h1>');
    selectText(heading.firstChild!, 1, 4);

    applyTextCommand(document, heading, { type: 'bold' });

    expect(heading.textContent).toBe('Hello world');
    const span = heading.querySelector('span')!;
    expect(span.textContent).toBe('ell');
    expect(span.style.fontWeight).toBe('bold');
    expect(readTextToolbarState(document, heading).bold).toBe(true);
  });

  it('toggles bold off with an explicit normal weight', () => {
    const heading = mount('<h1>Hello</h1>');
    selectText(heading.firstChild!, 0, 5);
    applyTextCommand(document, heading, { type: 'bold' });
    selectAll(heading);

    applyTextCommand(document, heading, { type: 'bold' });

    expect(heading.textContent).toBe('Hello');
    expect(heading.innerHTML).toContain('font-weight: normal');
    expect(readTextToolbarState(document, heading).bold).toBe(false);
  });

  it('applies a collapsed caret style to the whole block', () => {
    const paragraph = mount('<p>Entire line</p>');
    selectText(paragraph.firstChild!, 4, 4);

    applyTextCommand(document, paragraph, { type: 'italic' });

    const span = paragraph.querySelector('span')!;
    expect(span.textContent).toBe('Entire line');
    expect(span.style.fontStyle).toBe('italic');
    expect(paragraph.textContent).toBe('Entire line');
  });

  it('puts the caret inside the new span when styling an empty block', () => {
    const paragraph = mount('<p></p>');
    selectText(paragraph, 0, 0);

    applyTextCommand(document, paragraph, { type: 'bold' });

    const span = paragraph.querySelector('span')!;
    expect(span.style.fontWeight).toBe('bold');
    const selection = document.getSelection()!;
    expect(selection.rangeCount).toBe(1);
    const range = selection.getRangeAt(0);
    expect(range.collapsed).toBe(true);
    expect(range.startContainer === span || span.contains(range.startContainer))
      .toBe(true);
    expect(range.startOffset).toBe(0);
  });

  it('puts the caret inside the new span in an empty table cell', () => {
    const cell = mount('<table><tbody><tr><td></td></tr></tbody></table>').querySelector('td')!;
    selectText(cell, 0, 0);

    applyTextCommand(document, cell, { type: 'color', value: 'red' });

    const span = cell.querySelector('span')!;
    expect(span.style.color).toBe('red');
    const range = document.getSelection()!.getRangeAt(0);
    expect(range.collapsed).toBe(true);
    expect(range.startContainer === span || span.contains(range.startContainer))
      .toBe(true);
  });

  it('applies color, size, and line height', () => {
    const paragraph = mount('<p>Styled</p>');
    selectText(paragraph.firstChild!, 0, 6);

    applyTextCommand(document, paragraph, { type: 'color', value: 'red' });
    applyTextCommand(document, paragraph, {
      type: 'fontSize',
      value: '24px'
    });
    applyTextCommand(document, paragraph, {
      type: 'lineHeight',
      value: '1.5'
    });

    expect(paragraph.textContent).toBe('Styled');
    const spans = paragraph.querySelectorAll('span');
    expect(spans[0]?.style.color).toBe('red');
    expect(spans[1]?.style.fontSize).toBe('24px');
    expect(paragraph.style.lineHeight).toBe('1.5');
    expect(readTextToolbarState(document, paragraph).fontSize).toBe(24);
  });

  it('aligns the containing block even when editing a nested span', () => {
    const paragraph = mount('<p>Align <span>me</span></p>');
    const nested = paragraph.querySelector('span')!;
    selectText(nested.firstChild!, 0, 2);

    applyTextCommand(document, nested, { type: 'align', value: 'center' });

    expect(paragraph.style.textAlign).toBe('center');
    expect(textBlockOf(nested)).toBe(paragraph);
  });

  it('converts the block into a list and back', () => {
    const paragraph = mount('<p>Item</p>');
    selectText(paragraph.firstChild!, 0, 4);

    applyTextCommand(document, paragraph, { type: 'list', value: 'ul' });

    const list = document.querySelector('ul')!;
    const item = list.querySelector('li')!;
    expect(item.textContent).toBe('Item');
    expect(readTextToolbarState(document, item).list).toBe('ul');

    applyTextCommand(document, item, { type: 'list', value: 'ul' });

    expect(document.querySelector('ul')).toBeNull();
    expect(document.querySelector('p')?.textContent).toBe('Item');
  });

  it('wraps a selection in a link and rejects script URLs', () => {
    const paragraph = mount('<p>Visit example</p>');
    selectText(paragraph.firstChild!, 6, 13);

    expect(() =>
      applyTextCommand(document, paragraph, {
        type: 'link',
        value: 'javascript:alert(1)'
      })
    ).toThrow(/http:/);
    expect(paragraph.innerHTML).toBe('Visit example');

    applyTextCommand(document, paragraph, {
      type: 'link',
      value: 'https://example.com'
    });
    const anchor = paragraph.querySelector('a')!;
    expect(anchor.getAttribute('href')).toBe('https://example.com');
    expect(anchor.textContent).toBe('example');
    expect(readTextToolbarState(document, paragraph).link).toBe(
      'https://example.com'
    );
  });

  it('clears formatting while keeping the text', () => {
    const paragraph = mount(
      '<p><span style="font-weight: bold; color: red">Formatted</span></p>'
    );
    selectAll(paragraph);

    applyTextCommand(document, paragraph, { type: 'clear' });

    expect(paragraph.querySelector('span')).toBeNull();
    expect(paragraph.textContent).toBe('Formatted');
  });

  it('reads nested computed styles for the toolbar', () => {
    const heading = mount(
      '<h1><span style="font-weight: 700; color: rgb(255, 0, 0)">X</span></h1>'
    );
    const span = heading.querySelector('span')!;
    selectText(span.firstChild!, 0, 1);

    const state = readTextToolbarState(document, heading);

    expect(state.bold).toBe(true);
    expect(state.color).toBe('#ff0000');
  });
});
