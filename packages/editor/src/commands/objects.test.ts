import { detectSlides } from '@htmlppt/core';
import { describe, expect, it } from 'vitest';
import { parseDeck } from '../slide-doc.js';
import type { SelectionTarget } from '../selection.js';
import {
  applyObjectCommand,
  isHiddenElement,
  isLockedElement
} from './objects.js';

const BOX = 'position:absolute;left:100px;top:100px;width:100px;height:60px';

function deck(children: string): Document {
  return parseDeck(
    `<!doctype html><html><body><main data-ppt-deck><section class="slide" data-slide-id="s1" data-width="1600" data-height="900" style="position:relative">${children}</section></main></body></html>`
  );
}

function slideOf(doc: Document): Element {
  return detectSlides(doc)[0]!.element;
}

function element(doc: Document, id: string): HTMLElement {
  const found = slideOf(doc).querySelector<HTMLElement>(`[data-ppt-el="${id}"]`);
  if (!found) throw new Error(`Missing ${id}`);
  return found;
}

function target(doc: Document, id: string): SelectionTarget {
  const found = element(doc, id);
  const slide = slideOf(doc);
  return {
    slideIndex: 0,
    path: [Array.from(slide.children).indexOf(found)],
    elementId: id
  };
}

function ids(targets: readonly SelectionTarget[]): string[] {
  return targets.map((entry) => entry.elementId ?? '');
}

describe('editor object commands', () => {
  it('groups measured objects and selects the created group', () => {
    const doc = deck(
      `<div data-ppt-el="a" style="${BOX}">A</div><div data-ppt-el="b" style="position:absolute;left:300px;top:140px;width:120px;height:80px">B</div>`
    );
    const a = target(doc, 'a');
    const b = target(doc, 'b');
    const result = applyObjectCommand(doc, 0, { type: 'group' }, [a, b], [
      { target: a, rect: { x: 100, y: 100, width: 100, height: 60 }, offset: { x: 0, y: 0 } },
      { target: b, rect: { x: 300, y: 140, width: 120, height: 80 }, offset: { x: 0, y: 0 } }
    ]);
    expect(result.changed).toBe(true);
    expect(result.targets).toHaveLength(1);
    const group = element(doc, result.targets[0]!.elementId!);
    expect(group.hasAttribute('data-ppt-group')).toBe(true);
    expect(group.style.left).toBe('100px');
    expect(group.style.top).toBe('100px');
    expect(group.style.width).toBe('320px');
    expect(group.style.height).toBe('120px');
    expect(element(doc, 'a').style.left).toBe('0px');
    expect(element(doc, 'a').style.top).toBe('0px');
    expect(element(doc, 'b').style.left).toBe('200px');
    expect(element(doc, 'b').style.top).toBe('40px');
  });

  it('selects every restored child after ungrouping', () => {
    const doc = deck(
      `<div data-ppt-group data-ppt-el="g" style="position:absolute;left:100px;top:100px;width:200px;height:100px"><div data-ppt-el="a" style="position:absolute;left:0px;top:0px;width:100px;height:60px">A</div><div data-ppt-el="b" style="position:absolute;left:100px;top:20px;width:100px;height:60px">B</div></div>`
    );
    const result = applyObjectCommand(doc, 0, { type: 'ungroup' }, [target(doc, 'g')]);
    expect(result.changed).toBe(true);
    expect(ids(result.targets)).toEqual(['a', 'b']);
    expect(slideOf(doc).querySelector('[data-ppt-group]')).toBeNull();
    expect(element(doc, 'a').style.left).toBe('100px');
    expect(element(doc, 'b').style.left).toBe('200px');
  });

  it('pins flow objects before aligning and reports exact geometry', () => {
    const doc = deck(
      `<div data-ppt-el="a" style="margin-left:10px;margin-top:20px;width:100px;height:60px">A</div><div data-ppt-el="b" style="position:absolute;left:300px;top:140px;width:120px;height:80px">B</div>`
    );
    const a = target(doc, 'a');
    const b = target(doc, 'b');
    const result = applyObjectCommand(doc, 0, { type: 'align', mode: 'left' }, [a, b], [
      { target: a, rect: { x: 50, y: 80, width: 100, height: 60 }, offset: { x: 0, y: 0 } },
      { target: b, rect: { x: 300, y: 140, width: 120, height: 80 }, offset: { x: 0, y: 0 } }
    ]);
    expect(result.changed).toBe(true);
    expect(element(doc, 'a').style.position).toBe('absolute');
    expect(element(doc, 'a').style.left).toBe('50px');
    expect(element(doc, 'b').style.left).toBe('50px');
  });

  it('distributes equal gaps using outer edges', () => {
    const doc = deck(
      `<div data-ppt-el="a" style="${BOX}">A</div><div data-ppt-el="b" style="position:absolute;left:260px;top:100px;width:60px;height:60px">B</div><div data-ppt-el="c" style="position:absolute;left:500px;top:100px;width:80px;height:60px">C</div>`
    );
    const targets = ['a', 'b', 'c'].map((id) => target(doc, id));
    const measurements = [
      { target: targets[0]!, rect: { x: 100, y: 100, width: 100, height: 60 }, offset: { x: 0, y: 0 } },
      { target: targets[1]!, rect: { x: 260, y: 100, width: 60, height: 60 }, offset: { x: 0, y: 0 } },
      { target: targets[2]!, rect: { x: 500, y: 100, width: 80, height: 60 }, offset: { x: 0, y: 0 } }
    ];
    const result = applyObjectCommand(doc, 0, { type: 'distribute', axis: 'horizontal' }, targets, measurements);
    expect(result.changed).toBe(true);
    // Outer edges stay at 100 and 580; 480 px of span minus 240 px of width leaves 120 px gaps.
    expect(element(doc, 'a').style.left).toBe('100px');
    expect(element(doc, 'b').style.left).toBe('320px');
    expect(element(doc, 'c').style.left).toBe('500px');
  });

  it('locks, hides, and skips no-op commands without writing', () => {
    const doc = deck(`<div data-ppt-el="a" style="${BOX}">A</div>`);
    const a = target(doc, 'a');
    const hidden = applyObjectCommand(doc, 0, { type: 'hide', hidden: true }, [a]);
    expect(hidden.changed).toBe(true);
    expect(isHiddenElement(element(doc, 'a'))).toBe(true);
    expect(element(doc, 'a').getAttribute('data-ppt-display')).toBe('');
    expect(applyObjectCommand(doc, 0, { type: 'hide', hidden: true }, [a]).changed).toBe(false);
    const shown = applyObjectCommand(doc, 0, { type: 'hide', hidden: false }, [a]);
    expect(shown.changed).toBe(true);
    expect(isHiddenElement(element(doc, 'a'))).toBe(false);

    const locked = applyObjectCommand(doc, 0, { type: 'lock', locked: true }, [a]);
    expect(locked.changed).toBe(true);
    expect(isLockedElement(element(doc, 'a'))).toBe(true);
    expect(applyObjectCommand(doc, 0, { type: 'lock', locked: true }, [a]).changed).toBe(false);
    expect(applyObjectCommand(doc, 0, { type: 'lock', locked: false }, [a]).targets[0]?.elementId).toBe('a');
  });

  it('rejects locked transform commands before touching geometry', () => {
    const doc = deck(
      `<div data-ppt-el="a" style="${BOX}" data-ppt-locked="true">A</div><div data-ppt-el="b" style="position:absolute;left:300px;top:100px;width:100px;height:60px">B</div>`
    );
    const a = target(doc, 'a');
    const b = target(doc, 'b');
    expect(() =>
      applyObjectCommand(doc, 0, { type: 'align', mode: 'left' }, [a, b], [
        { target: a, rect: { x: 100, y: 100, width: 100, height: 60 }, offset: { x: 0, y: 0 } },
        { target: b, rect: { x: 300, y: 100, width: 100, height: 60 }, offset: { x: 0, y: 0 } }
      ])
    ).toThrow(/Unlock/);
    expect(element(doc, 'b').style.left).toBe('300px');
  });

  it('rejects unsupported transforms atomically, leaving pins unwritten', () => {
    const doc = deck(
      `<div data-ppt-el="a" style="${BOX}">A</div><div data-ppt-el="b" style="position:absolute;left:300px;top:100px;width:100px;height:60px;transform:scale(2)">B</div>`
    );
    const a = target(doc, 'a');
    const b = target(doc, 'b');
    expect(() =>
      applyObjectCommand(doc, 0, { type: 'group' }, [a, b], [
        { target: a, rect: { x: 100, y: 100, width: 100, height: 60 }, offset: { x: 0, y: 0 } },
        { target: b, rect: { x: 300, y: 100, width: 100, height: 60 }, offset: { x: 0, y: 0 } }
      ])
    ).toThrow(/transform/i);
    expect(slideOf(doc).querySelector('[data-ppt-group]')).toBeNull();
    expect(element(doc, 'a').getAttribute('style')).toBe(BOX);
  });

  it('rejects measurements from a transformed containing block before writes', () => {
    const doc = deck(
      `<div data-ppt-el="a" style="${BOX}">A</div><div data-ppt-el="b" style="position:absolute;left:300px;top:100px;width:100px;height:60px">B</div>`
    );
    const a = target(doc, 'a');
    const b = target(doc, 'b');
    expect(() =>
      applyObjectCommand(doc, 0, { type: 'align', mode: 'left' }, [a, b], [
        { target: a, rect: { x: 100, y: 100, width: 100, height: 60 }, offset: { x: 10, y: 0 } },
        { target: b, rect: { x: 300, y: 100, width: 100, height: 60 }, offset: { x: 0, y: 0 } }
      ])
    ).toThrow(/transformed wrapper/);
    expect(element(doc, 'a').getAttribute('style')).toBe(BOX);
    expect(element(doc, 'b').style.left).toBe('300px');
  });

  it('rejects duplicate targets before writes', () => {
    const doc = deck(`<div data-ppt-el="a" style="${BOX}">A</div>`);
    const a = target(doc, 'a');
    expect(() =>
      applyObjectCommand(doc, 0, { type: 'group' }, [a, a], [
        { target: a, rect: { x: 100, y: 100, width: 100, height: 60 }, offset: { x: 0, y: 0 } },
        { target: a, rect: { x: 100, y: 100, width: 100, height: 60 }, offset: { x: 0, y: 0 } }
      ])
    ).toThrow(/only once/);
    expect(slideOf(doc).querySelector('[data-ppt-group]')).toBeNull();
  });
});
