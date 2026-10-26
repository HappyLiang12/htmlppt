import { describe, expect, it } from 'vitest';
import { en } from './i18n/messages/en';
import { zhHant } from './i18n/messages/zh-Hant';
import { zhHans } from './i18n/messages/zh-Hans';
import {
  EDIT_HINT_KEYS,
  textEditBlockFor,
  topLevelBlockFor
} from './text-edit-block';

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

  it('names a non-text descendant of a layout div as not text', () => {
    // The nearest text tag is the container, but the gesture landed on a
    // button, image, or link inside it. Entering the container the user is
    // already in cannot start an edit, so has-children would mislead.
    expect(
      textEditBlockFor(pick('<div><button>Go</button></div>', 'button'))
    ).toBe('not-text');
    expect(textEditBlockFor(pick('<div><img alt=""></div>', 'img'))).toBe(
      'not-text'
    );
    expect(textEditBlockFor(pick('<div><a href="#">Go</a></div>', 'a'))).toBe(
      'not-text'
    );
  });

  it('keeps the container itself on the has-children reason', () => {
    expect(
      textEditBlockFor(pick('<div><button>Go</button></div>', 'div'))
    ).toBe('has-children');
  });

  it('keeps a strong inside a paragraph editable', () => {
    expect(
      textEditBlockFor(pick('<p><strong>Bold</strong></p>', 'strong'))
    ).toBeNull();
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

describe('topLevelBlockFor', () => {
  it('names the guard that refuses both edit paths', () => {
    expect(
      topLevelBlockFor(pick('<div data-ppt-locked="true">x</div>', 'div'))
    ).toBe('locked');
    expect(
      topLevelBlockFor(pick('<div style="display:none">x</div>', 'div'))
    ).toBe('hidden');
    expect(
      topLevelBlockFor(pick('<div data-ppt-group="1"><p>x</p></div>', 'div'))
    ).toBe('group');
    expect(topLevelBlockFor(pick('<div>x</div>', 'div'))).toBeNull();
    expect(topLevelBlockFor(null)).toBeNull();
  });

  it('keeps the guard precedence locked, hidden, then group', () => {
    expect(
      topLevelBlockFor(
        pick(
          '<div data-ppt-locked="true" data-ppt-group="1" style="display:none">x</div>',
          'div'
        )
      )
    ).toBe('locked');
    expect(
      topLevelBlockFor(
        pick('<div data-ppt-group="1" style="display:none">x</div>', 'div')
      )
    ).toBe('hidden');
  });

  it('resolves a guarded wrapper from the preview iframe realm', () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    try {
      const doc = frame.contentDocument as Document;
      doc.body.innerHTML =
        '<div data-ppt-locked="true" style="display:none" data-ppt-group="1">x</div>';
      const wrapper = doc.querySelector('div') as Element;
      expect(wrapper instanceof HTMLElement).toBe(false);
      expect(topLevelBlockFor(wrapper)).toBe('locked');
    } finally {
      frame.remove();
    }
  });
});

describe('EDIT_HINT_KEYS', () => {
  it('maps every hint reason to localized copy in all catalogs', () => {
    expect(Object.keys(EDIT_HINT_KEYS).sort()).toEqual([
      'empty',
      'group',
      'has-children',
      'hidden',
      'locked',
      'not-text'
    ]);
    for (const key of Object.values(EDIT_HINT_KEYS)) {
      expect(en[key]).toBeTruthy();
      expect(zhHant[key]).toBeTruthy();
      expect(zhHans[key]).toBeTruthy();
    }
  });

  it('uses the dedicated catalog keys for the guard reasons', () => {
    expect(EDIT_HINT_KEYS.locked).toBe('editor.hint.locked');
    expect(EDIT_HINT_KEYS.hidden).toBe('editor.hint.hidden');
    expect(EDIT_HINT_KEYS.group).toBe('editor.hint.group');
  });

  it('pins the required English copy for the guard reasons', () => {
    expect(en[EDIT_HINT_KEYS.locked]).toBe(
      'This object is locked. Unlock it before editing its content.'
    );
    expect(en[EDIT_HINT_KEYS.hidden]).toBe(
      'This object is hidden. Unhide it before editing its content.'
    );
    expect(en[EDIT_HINT_KEYS.group]).toBe(
      'Groups edit as one object. Ungroup it to edit the parts.'
    );
  });
});
