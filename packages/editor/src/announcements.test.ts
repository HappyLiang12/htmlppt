import { describe, expect, it } from 'vitest';
import { describeSelection, describeSlide } from './announcements.js';

function element(html: string): Element {
  const container = document.createElement('div');
  container.innerHTML = html;
  const found = container.firstElementChild;
  if (!found) throw new Error('Missing fixture element.');
  return found;
}

describe('describeSelection', () => {
  it('names the selected tag and its trimmed text', () => {
    expect(describeSelection(element('<h1> Rich   deck </h1>'), 1)).toBe(
      '已選取 h1：Rich deck'
    );
  });

  it('truncates long text and keeps the announcement short', () => {
    const long = 'a'.repeat(80);
    const message = describeSelection(element(`<p>${long}</p>`), 1);
    expect(message).toBe(`已選取 p：${'a'.repeat(39)}…`);
  });

  it('reports groups by count and clears without a selection', () => {
    expect(describeSelection(element('<div>x</div>'), 3)).toBe('已選取 3 個物件');
    expect(describeSelection(null, 0)).toBe('已取消選取');
    expect(describeSelection(element('<div></div>'), 1)).toBe('已選取 div');
  });
});

describe('describeSlide', () => {
  it('formats one-based slide positions', () => {
    expect(describeSlide(0, 5)).toBe('第 1 頁，共 5 頁');
    expect(describeSlide(1, 5)).toBe('第 2 頁，共 5 頁');
  });
});
