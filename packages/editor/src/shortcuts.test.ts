import { describe, expect, it } from 'vitest';
import {
  mapShortcut,
  mapTextShortcut,
  type ShortcutEventLike
} from './shortcuts.js';

function press(
  key: string,
  init: Partial<ShortcutEventLike> = {}
): ShortcutEventLike {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    target: null,
    ...init
  };
}

function elementTarget(html: string): Element {
  const container = document.createElement('div');
  container.innerHTML = html;
  const element = container.firstElementChild;
  if (!element) throw new Error('Missing fixture element.');
  return element;
}

describe('mapShortcut primary modifier shortcuts', () => {
  it('maps undo and redo with either Ctrl or Cmd', () => {
    expect(mapShortcut(press('z', { ctrlKey: true }))).toEqual({
      type: 'undo'
    });
    expect(mapShortcut(press('z', { metaKey: true }))).toEqual({
      type: 'undo'
    });
    expect(mapShortcut(press('z', { ctrlKey: true, shiftKey: true }))).toEqual(
      { type: 'redo' }
    );
    expect(mapShortcut(press('Z', { ctrlKey: true, shiftKey: true }))).toEqual(
      { type: 'redo' }
    );
    expect(mapShortcut(press('z', { metaKey: true, shiftKey: true }))).toEqual(
      { type: 'redo' }
    );
    expect(mapShortcut(press('y', { ctrlKey: true }))).toEqual({
      type: 'redo'
    });
    expect(mapShortcut(press('y', { metaKey: true }))).toEqual({
      type: 'redo'
    });
  });

  it('maps save, export, duplicate, group, and ungroup', () => {
    expect(mapShortcut(press('s', { ctrlKey: true }))).toEqual({
      type: 'save'
    });
    expect(mapShortcut(press('e', { ctrlKey: true, shiftKey: true }))).toEqual(
      { type: 'export' }
    );
    expect(mapShortcut(press('d', { ctrlKey: true }))).toEqual({
      type: 'duplicate'
    });
    expect(mapShortcut(press('g', { ctrlKey: true }))).toEqual({
      type: 'group'
    });
    expect(mapShortcut(press('g', { ctrlKey: true, shiftKey: true }))).toEqual(
      { type: 'ungroup' }
    );
  });

  it('maps select all, copy, and paste', () => {
    expect(mapShortcut(press('a', { ctrlKey: true }))).toEqual({
      type: 'select-all'
    });
    expect(mapShortcut(press('c', { ctrlKey: true }))).toEqual({
      type: 'copy'
    });
    expect(mapShortcut(press('v', { ctrlKey: true }))).toEqual({
      type: 'paste'
    });
  });

  it('maps zoom in, zoom out, and fit', () => {
    expect(mapShortcut(press('=', { ctrlKey: true }))).toEqual({
      type: 'zoom-in'
    });
    expect(mapShortcut(press('+', { ctrlKey: true }))).toEqual({
      type: 'zoom-in'
    });
    expect(mapShortcut(press('-', { ctrlKey: true }))).toEqual({
      type: 'zoom-out'
    });
    expect(mapShortcut(press('0', { ctrlKey: true }))).toEqual({
      type: 'zoom-fit'
    });
    // US layouts need Shift to produce "+", so the shifted chord also zooms.
    expect(mapShortcut(press('=', { ctrlKey: true, shiftKey: true }))).toEqual(
      { type: 'zoom-in' }
    );
  });
});

describe('mapShortcut unmodified shortcuts', () => {
  it('maps delete and backspace', () => {
    expect(mapShortcut(press('Delete'))).toEqual({ type: 'delete' });
    expect(mapShortcut(press('Backspace'))).toEqual({ type: 'delete' });
  });

  it('keeps Backspace as delete for the dispatcher to gate on a selection', () => {
    // Backspace deleting a selected object is intentional; the dispatcher
    // must only consume it when a selection exists, leaving browser
    // navigation untouched otherwise.
    expect(mapShortcut(press('Backspace'))).toEqual({ type: 'delete' });
    expect(mapShortcut(press('Backspace', { target: elementTarget('<p>x</p>') }))).toEqual({
      type: 'delete'
    });
  });

  it('maps escape, enter, play, and help', () => {
    expect(mapShortcut(press('Escape'))).toEqual({ type: 'escape' });
    expect(mapShortcut(press('Enter'))).toEqual({ type: 'edit' });
    expect(mapShortcut(press('F5'))).toEqual({ type: 'play' });
    expect(mapShortcut(press('F5', { shiftKey: true }))).toEqual({
      type: 'play-from-current'
    });
    expect(mapShortcut(press('?', { shiftKey: true }))).toEqual({
      type: 'help'
    });
  });

  it('maps arrows to 1 px and shift+arrows to 10 px nudges', () => {
    expect(mapShortcut(press('ArrowLeft'))).toEqual({
      type: 'nudge',
      dx: -1,
      dy: 0
    });
    expect(mapShortcut(press('ArrowRight'))).toEqual({
      type: 'nudge',
      dx: 1,
      dy: 0
    });
    expect(mapShortcut(press('ArrowUp'))).toEqual({
      type: 'nudge',
      dx: 0,
      dy: -1
    });
    expect(mapShortcut(press('ArrowDown'))).toEqual({
      type: 'nudge',
      dx: 0,
      dy: 1
    });
    expect(mapShortcut(press('ArrowRight', { shiftKey: true }))).toEqual({
      type: 'nudge',
      dx: 10,
      dy: 0
    });
    expect(mapShortcut(press('ArrowUp', { shiftKey: true }))).toEqual({
      type: 'nudge',
      dx: 0,
      dy: -10
    });
  });
});

describe('mapShortcut modifier and key guards', () => {
  it('returns no action for unknown keys', () => {
    expect(mapShortcut(press('F1'))).toBeNull();
    expect(mapShortcut(press('Tab'))).toBeNull();
    expect(mapShortcut(press('PageDown'))).toBeNull();
    expect(mapShortcut(press('x'))).toBeNull();
    expect(mapShortcut(press('x', { ctrlKey: true }))).toBeNull();
  });

  it('does not map plain letters to primary actions', () => {
    for (const key of ['z', 's', 'e', 'd', 'g', 'a', 'c', 'v']) {
      expect(mapShortcut(press(key))).toBeNull();
    }
  });

  it('does not map unsupported modifier combinations', () => {
    expect(mapShortcut(press('z', { ctrlKey: true, altKey: true }))).toBeNull();
    expect(
      mapShortcut(press('z', { ctrlKey: true, shiftKey: true, altKey: true }))
    ).toBeNull();
    expect(mapShortcut(press('a', { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(mapShortcut(press('s', { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(mapShortcut(press('c', { ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it('ignores every shortcut while an editable target handles the key', () => {
    const targets = [
      elementTarget('<input>'),
      elementTarget('<textarea></textarea>'),
      elementTarget('<select><option>a</option></select>'),
      elementTarget('<div contenteditable="true"></div>'),
      elementTarget(
        '<div contenteditable="true"><span id="nested">text</span></div>'
      )
    ];
    const nested = targets[4]?.querySelector('#nested') ?? null;

    for (const target of [...targets, nested]) {
      expect(
        mapShortcut(press('z', { ctrlKey: true, target }))
      ).toBeNull();
      expect(mapShortcut(press('Delete', { target }))).toBeNull();
    }
  });

  it('ignores shortcuts inside the active text-edit marker', () => {
    const editing = elementTarget(
      '<h1 data-ppt-editing="true" contenteditable="true">Title</h1>'
    );
    const child = editing.firstChild;

    expect(mapShortcut(press('z', { ctrlKey: true, target: editing }))).toBeNull();
    expect(mapShortcut(press('Escape', { target: child }))).toBeNull();
  });

  it('maps shortcuts for non-editable document targets', () => {
    const bodyElement = elementTarget('<div class="slide"></div>');
    expect(
      mapShortcut(press('z', { ctrlKey: true, target: bodyElement }))
    ).toEqual({ type: 'undo' });
    expect(mapShortcut(press('Delete', { target: bodyElement }))).toEqual({
      type: 'delete'
    });
  });
});

describe('mapTextShortcut', () => {
  it('maps B/I/U with Ctrl or Cmd and is case-insensitive', () => {
    expect(mapTextShortcut(press('b', { ctrlKey: true }))).toEqual({
      type: 'bold'
    });
    expect(mapTextShortcut(press('I', { metaKey: true }))).toEqual({
      type: 'italic'
    });
    expect(mapTextShortcut(press('u', { ctrlKey: true }))).toEqual({
      type: 'underline'
    });
  });

  it('rejects modifiers, repeats, composition, and bare keys', () => {
    expect(mapTextShortcut(press('b', { ctrlKey: true, shiftKey: true })))
      .toBeNull();
    expect(mapTextShortcut(press('b', { ctrlKey: true, altKey: true })))
      .toBeNull();
    expect(mapTextShortcut(press('b', { ctrlKey: true, repeat: true })))
      .toBeNull();
    expect(mapTextShortcut(press('b', { ctrlKey: true, isComposing: true })))
      .toBeNull();
    expect(mapTextShortcut(press('b'))).toBeNull();
  });
});
