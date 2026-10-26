import { describe, expect, it } from 'vitest';
import type { Translator } from './i18n';
import { en } from './i18n/messages/en';
import { zhHant } from './i18n/messages/zh-Hant';
import {
  describeContextLevel,
  describeSelection,
  describeSlide
} from './announcements.js';

function element(html: string): Element {
  const container = document.createElement('div');
  container.innerHTML = html;
  const found = container.firstElementChild;
  if (!found) throw new Error('Missing fixture element.');
  return found;
}

function translator(
  dictionary: Record<string, string>
): Translator {
  return (key, vars) =>
    (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) =>
      vars && Object.prototype.hasOwnProperty.call(vars, name)
        ? String(vars[name])
        : match
    );
}

const t = translator(zhHant);

describe('describeSelection', () => {
  it('names the selected tag and its trimmed text', () => {
    expect(describeSelection(element('<h1> Rich   deck </h1>'), 1, t)).toBe(
      '已選取 h1：Rich deck'
    );
  });

  it('truncates long text and keeps the announcement short', () => {
    const long = 'a'.repeat(80);
    const message = describeSelection(element(`<p>${long}</p>`), 1, t);
    expect(message).toBe(`已選取 p：${'a'.repeat(39)}…`);
  });

  it('reports groups by count and clears without a selection', () => {
    expect(describeSelection(element('<div>x</div>'), 3, t)).toBe(
      '已選取 3 個物件'
    );
    expect(describeSelection(null, 0, t)).toBe('已取消選取');
    expect(describeSelection(element('<div></div>'), 1, t)).toBe('已選取 div');
  });

  it('uses the supplied translator for English announcements', () => {
    const english = translator(en);
    expect(describeSelection(element('<h1>Rich deck</h1>'), 1, english)).toBe(
      'Selected h1: Rich deck'
    );
    expect(describeSelection(element('<div>x</div>'), 2, english)).toBe(
      'Selected 2 objects'
    );
  });
});

describe('describeSlide', () => {
  it('formats one-based slide positions', () => {
    expect(describeSlide(0, 5, t)).toBe('第 1 頁，共 5 頁');
    expect(describeSlide(1, 5, t)).toBe('第 2 頁，共 5 頁');
  });

  it('localizes the slide announcement', () => {
    expect(describeSlide(0, 5, translator(en))).toBe('Slide 1 of 5');
  });
});

describe('describeContextLevel', () => {
  it('names the entered container by its class-first segment', () => {
    expect(describeContextLevel(element('<div class="pad cover"></div>'), t)).toBe(
      '正在編輯 .pad'
    );
  });

  it('falls back to the tag and announces the slide level', () => {
    expect(describeContextLevel(element('<section></section>'), t)).toBe(
      '正在編輯 section'
    );
    expect(describeContextLevel(null, t)).toBe('正在編輯投影片');
  });

  it('localizes in English', () => {
    const english = translator(en);
    expect(
      describeContextLevel(element('<div class="pad"></div>'), english)
    ).toBe('Editing inside .pad');
    expect(describeContextLevel(null, english)).toBe('Editing the slide');
  });
});
