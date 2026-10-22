import { detectSlides } from '@htmlppt/core';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeckResponse } from './api.js';
import {
  applyBackground,
  applyGeometryEdit,
  applyInspectorEdit,
  applyNotes,
  applyTransition,
  backgroundOf,
  clearBackground,
  formatGeometryValue,
  geometryCommitValue,
  notesOf,
  parseGeometryValue,
  readGeometry,
  snapshotGeometry,
  summarizeObjects,
  transitionOf
} from './inspector-state.js';
import { parseDeck } from './slide-doc.js';
import { useDeckController, type DeckController } from './use-deck-controller.js';

const DECK_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Inspector fixture</title></head>
<body>
<main data-ppt-deck>
<section class="slide" data-slide-id="s1" data-width="1600" data-height="900">
  <div data-ppt-el="box" style="position:absolute;left:120px;top:160px;width:240px;height:120px;transform:rotate(30deg)">Nudge me</div>
  <h1 data-ppt-el="title">Slide title</h1>
</section>
</main>
</body>
</html>`;

const FLOW_DECK_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Flow fixture</title></head>
<body>
<main data-ppt-deck>
<section class="slide" data-slide-id="s1" data-width="1600" data-height="900">
  <div data-ppt-el="flow">Flow object</div>
</section>
</main>
</body>
</html>`;

const DECK: DeckResponse = {
  revision: 'revision-1',
  filePath: 'inspector.html',
  html: DECK_HTML
};

const SELECTION = { slideIndex: 0, path: [0], elementId: 'box' };

let container: HTMLDivElement;
let root: Root;
let controller!: DeckController;

function Probe() {
  controller = useDeckController({ token: '' });
  return null;
}

beforeEach(async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(Probe));
  });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

function slideOf(master: Document, index = 0): Element {
  const slide = detectSlides(master)[index]?.element;
  if (!slide) throw new Error(`Missing slide ${index}.`);
  return slide;
}

function boxOf(master: Document): HTMLElement {
  const box = slideOf(master).querySelector('[data-ppt-el="box"]');
  if (!(box instanceof HTMLElement)) throw new Error('Missing fixture box.');
  return box;
}

describe('inspector geometry state', () => {
  it('derives numeric fields and rotation from the selected element', () => {
    const master = parseDeck(DECK_HTML);
    const slide = slideOf(master);
    const box = boxOf(master);

    expect(readGeometry(box, slide)).toEqual({
      x: 120,
      y: 160,
      width: 240,
      height: 120,
      rotation: 30
    });
    expect(snapshotGeometry(box, slide)).toEqual({
      rect: { x: 120, y: 160, width: 240, height: 120 },
      rotation: 30,
      offset: { x: 0, y: 0 }
    });
  });

  it('formats and validates numeric input', () => {
    expect(formatGeometryValue(12.345)).toBe('12.35');
    expect(formatGeometryValue(-0)).toBe('0');
    expect(parseGeometryValue('x', ' 42.5 ')).toBe(42.5);
    expect(parseGeometryValue('y', '-18')).toBe(-18);
    expect(parseGeometryValue('rotation', '370')).toBe(10);
    expect(parseGeometryValue('x', 'abc')).toBeNull();
    expect(parseGeometryValue('x', '')).toBeNull();
    expect(parseGeometryValue('width', '0')).toBeNull();
    expect(parseGeometryValue('height', '-3')).toBeNull();
  });

  it('treats the rounded display value as a no-op draft', () => {
    // Focus/blur on a fractional flow object must not count as an edit.
    expect(geometryCommitValue('x', '120.33', 120.333)).toBeNull();
    expect(geometryCommitValue('x', '120.333', 120.333)).toBeNull();
    expect(geometryCommitValue('rotation', '10', 10)).toBeNull();
    expect(geometryCommitValue('x', 'abc', 120.333)).toBeNull();
    expect(geometryCommitValue('x', '120.34', 120.333)).toBe(120.34);
    expect(geometryCommitValue('rotation', '370', 10)).toBeNull();
    expect(geometryCommitValue('rotation', '25', 10)).toBe(25);
    // A null baseline (no selection) never commits.
    expect(geometryCommitValue('x', '42', null)).toBeNull();
  });

  it('pins a flow object on the first numeric edit and keeps slide coordinates', () => {
    const master = parseDeck(FLOW_DECK_HTML);
    const box = master.querySelector('[data-ppt-el="flow"]');
    if (!(box instanceof HTMLElement)) throw new Error('Missing flow box.');
    const snapshot = {
      rect: { x: 10, y: 20, width: 100, height: 50 },
      rotation: 0,
      offset: { x: 4, y: 8 }
    };

    expect(
      applyGeometryEdit(
        master,
        { slideIndex: 0, path: [0], elementId: 'flow' },
        snapshot,
        'width',
        140
      )
    ).toBe(true);

    expect(box.style.position).toBe('absolute');
    expect(box.style.left).toBe('6px');
    expect(box.style.top).toBe('12px');
    expect(box.style.width).toBe('140px');
    expect(box.style.height).toBe('50px');
  });

  it('rejects invalid numbers without mutating the element', () => {
    const master = parseDeck(DECK_HTML);
    const box = boxOf(master);
    const snapshot = snapshotGeometry(box, slideOf(master));

    expect(
      applyGeometryEdit(master, SELECTION, snapshot, 'x', Number.NaN)
    ).toBe(false);
    expect(
      applyGeometryEdit(master, SELECTION, snapshot, 'width', 0)
    ).toBe(false);
    expect(box.style.left).toBe('120px');
    expect(box.style.width).toBe('240px');
  });

  it('applies rotation through the normalized transform', () => {
    const master = parseDeck(DECK_HTML);
    const box = boxOf(master);

    expect(
      applyGeometryEdit(
        master,
        SELECTION,
        snapshotGeometry(box, slideOf(master)),
        'rotation',
        370
      )
    ).toBe(true);
    expect(box.style.transform).toBe('rotate(10deg)');
  });

  it('commits one history entry when X is edited through the controller', async () => {
    const master = parseDeck(DECK_HTML);
    const box = boxOf(master);
    const snapshot = snapshotGeometry(box, slideOf(master));

    await act(async () => {
      await controller.actions.load(DECK);
    });

    let pending!: Promise<void>;
    act(() => {
      pending = controller.actions.commitMaster((draft) => {
        applyGeometryEdit(draft, SELECTION, snapshot, 'x', 250);
      });
    });

    const edited = controller.state.master;
    if (!edited) throw new Error('Master was not loaded.');
    expect(boxOf(edited).style.left).toBe('250px');
    expect(controller.state.dirty).toBe(true);
    expect(controller.state.srcDoc).toContain('250px');

    act(() => {
      controller.actions.undo();
    });
    const restored = controller.state.master;
    if (!restored) throw new Error('Master was not restored.');
    expect(boxOf(restored).style.left).toBe('120px');

    await act(async () => {
      await pending.catch(() => undefined);
    });
  });
});

describe('inspector object summaries', () => {
  it('lists top-level objects with tag, id, text, and raw path', () => {
    const master = parseDeck(DECK_HTML);
    expect(summarizeObjects(slideOf(master))).toEqual([
      {
        path: [0],
        tag: 'div',
        elementId: 'box',
        text: 'Nudge me',
        locked: false,
        hidden: false,
        group: false,
        canUnhide: false
      },
      {
        path: [1],
        tag: 'h1',
        elementId: 'title',
        text: 'Slide title',
        locked: false,
        hidden: false,
        group: false,
        canUnhide: false
      }
    ]);
  });
});

describe('inspector slide settings', () => {
  it('writes and removes notes in the hidden aside', () => {
    const master = parseDeck(DECK_HTML);
    const slide = slideOf(master);

    expect(notesOf(slide)).toBe('');
    expect(applyNotes(master, 0, 'Speaker notes')).toBe(true);
    expect(notesOf(slideOf(master))).toBe('Speaker notes');
    const aside = slideOf(master).querySelector('[data-ppt-notes]');
    expect(aside?.hasAttribute('hidden')).toBe(true);

    expect(applyNotes(master, 0, '')).toBe(true);
    expect(slideOf(master).querySelector('[data-ppt-notes]')).toBeNull();
  });

  it('keeps exactly one background kind inline', () => {
    const master = parseDeck(DECK_HTML);
    const slide = slideOf(master);
    const style = (slide as HTMLElement).style;

    expect(
      applyBackground(master, 0, { kind: 'color', value: '#112233' })
    ).toBe(true);
    expect(style.getPropertyValue('background')).toBe('rgb(17, 34, 51)');
    expect(style.getPropertyValue('background-image')).toBe('');

    expect(
      applyBackground(master, 0, {
        kind: 'gradient',
        value: 'linear-gradient(120deg, #111, #222)'
      })
    ).toBe(true);
    expect(style.getPropertyValue('background')).toBe(
      'linear-gradient(120deg, #111, #222)'
    );
    expect(style.getPropertyValue('background-color')).toBe('');

    expect(
      applyBackground(master, 0, {
        kind: 'image',
        value: 'https://example.com/bg.png'
      })
    ).toBe(true);
    expect(style.getPropertyValue('background-image')).toBe(
      'url("https://example.com/bg.png")'
    );
    expect(style.getPropertyValue('background')).toBe('');
    expect(style.getPropertyValue('background-color')).toBe('');

    expect(
      applyBackground(master, 0, { kind: 'color', value: '#445566' })
    ).toBe(true);
    expect(style.getPropertyValue('background')).toBe('rgb(68, 85, 102)');
    expect(style.getPropertyValue('background-image')).toBe('');
  });

  it('reads the current background kind and clears empty values', () => {
    const master = parseDeck(DECK_HTML);
    const slide = slideOf(master);

    expect(backgroundOf(slide)).toBeNull();
    applyBackground(master, 0, { kind: 'color', value: '#112233' });
    expect(backgroundOf(slide)).toEqual({
      kind: 'color',
      value: 'rgb(17, 34, 51)'
    });
    applyBackground(master, 0, {
      kind: 'image',
      value: 'https://example.com/bg.png'
    });
    expect(backgroundOf(slide)).toEqual({
      kind: 'image',
      value: 'https://example.com/bg.png'
    });
    expect(
      applyBackground(master, 0, { kind: 'color', value: '  ' })
    ).toBe(false);
  });

  it('clears both background longhands and the shorthand', () => {
    const master = parseDeck(DECK_HTML);
    const slide = slideOf(master);
    const style = (slide as HTMLElement).style;

    expect(
      applyBackground(master, 0, { kind: 'color', value: '#112233' })
    ).toBe(true);
    expect(clearBackground(master, 0)).toBe(true);
    expect(style.getPropertyValue('background')).toBe('');
    expect(style.getPropertyValue('background-color')).toBe('');
    expect(style.getPropertyValue('background-image')).toBe('');
    expect(backgroundOf(slide)).toBeNull();

    expect(
      applyBackground(master, 0, {
        kind: 'image',
        value: 'https://example.com/bg.png'
      })
    ).toBe(true);
    expect(clearBackground(master, 0)).toBe(true);
    expect(style.getPropertyValue('background-image')).toBe('');
    expect(backgroundOf(slide)).toBeNull();
  });

  it('rejects invalid color and gradient values without mutating the slide', () => {
    const master = parseDeck(DECK_HTML);
    const slide = slideOf(master);
    const style = (slide as HTMLElement).style;

    expect(
      applyBackground(master, 0, { kind: 'color', value: '#112233' })
    ).toBe(true);
    const before = (slide as HTMLElement).getAttribute('style');

    expect(
      applyBackground(master, 0, { kind: 'color', value: 'not-a-color' })
    ).toBe(false);
    expect((slide as HTMLElement).getAttribute('style')).toBe(before);

    expect(
      applyBackground(master, 0, {
        kind: 'gradient',
        value: 'linear-gradient(broken'
      })
    ).toBe(false);
    expect((slide as HTMLElement).getAttribute('style')).toBe(before);
    expect(style.getPropertyValue('background')).toBe('rgb(17, 34, 51)');
    expect(backgroundOf(slide)).toEqual({
      kind: 'color',
      value: 'rgb(17, 34, 51)'
    });
  });

  it('writes the slide transition attribute', () => {
    const master = parseDeck(DECK_HTML);
    const slide = slideOf(master);

    expect(transitionOf(slide)).toBe('none');
    expect(applyTransition(master, 0, 'fade')).toBe(true);
    expect(slideOf(master).getAttribute('data-ppt-transition')).toBe('fade');
    expect(transitionOf(slideOf(master))).toBe('fade');
    expect(applyTransition(master, 0, 'none')).toBe(true);
    expect(slideOf(master).getAttribute('data-ppt-transition')).toBe('none');
  });
});

describe('inspector edit commits', () => {
  it('does not commit a rejected background edit', () => {
    const master = parseDeck(DECK_HTML);
    const slide = slideOf(master) as HTMLElement;
    const before = slide.getAttribute('style');
    const commit = vi.fn();

    const applied = applyInspectorEdit(
      master,
      (draft) =>
        applyBackground(draft, 0, { kind: 'color', value: 'not-a-color' }),
      commit
    );

    expect(applied).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(slide.getAttribute('style')).toBe(before);
  });

  it('commits once after a successful background edit', () => {
    const master = parseDeck(DECK_HTML);
    let backgroundAtCommit: ReturnType<typeof backgroundOf> = null;
    const commit = vi.fn(() => {
      backgroundAtCommit = backgroundOf(slideOf(master));
    });

    const applied = applyInspectorEdit(
      master,
      (draft) =>
        applyBackground(draft, 0, { kind: 'color', value: '#112233' }),
      commit
    );

    expect(applied).toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);
    // The edit is written before the commit callback records the snapshot.
    expect(backgroundAtCommit).toEqual({
      kind: 'color',
      value: 'rgb(17, 34, 51)'
    });
  });

  it('does not commit without a loaded master', () => {
    const commit = vi.fn();
    expect(applyInspectorEdit(null, () => true, commit)).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });
});
