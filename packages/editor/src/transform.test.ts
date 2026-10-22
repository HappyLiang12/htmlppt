import { describe, expect, it } from 'vitest';
import type { Rect } from './geometry.js';
import {
  angleDelta,
  applyRotation,
  centerOf,
  moveTargets,
  pinToAbsolute,
  rectOf,
  resizeTarget,
  rotationFromPointer,
  rotationOf,
  snapAngle,
  type TransformTarget
} from './transform.js';

const rect = (x: number, y: number, width: number, height: number): Rect => ({
  x,
  y,
  width,
  height
});

function measuredRect(
  left: number,
  top: number,
  width: number,
  height: number
): DOMRect {
  return {
    x: left,
    y: top,
    width,
    height,
    left,
    top,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({})
  } as DOMRect;
}

function target(element: Element, start: Rect): TransformTarget {
  return { element, start };
}

describe('pinToAbsolute', () => {
  it('writes the exact absolute geometry styles', () => {
    const element = document.createElement('div');

    pinToAbsolute(element, rect(120, 40, 300, 90));

    expect(element.style.position).toBe('absolute');
    expect(element.style.left).toBe('120px');
    expect(element.style.top).toBe('40px');
    expect(element.style.width).toBe('300px');
    expect(element.style.height).toBe('90px');
    expect(element.style.margin).toBe('0px');
    expect(element.style.boxSizing).toBe('border-box');
  });

  it('keeps fractional design coordinates', () => {
    const element = document.createElement('div');

    pinToAbsolute(element, rect(12.5, 7.25, 100.125, 50.0625));

    expect(element.style.left).toBe('12.5px');
    expect(element.style.top).toBe('7.25px');
    expect(element.style.width).toBe('100.125px');
    expect(element.style.height).toBe('50.0625px');
  });

  it('pins through a containing block that is offset from the slide', () => {
    const parent = document.createElement('div');
    const slide = document.createElement('section');
    parent.append(slide);
    const element = document.createElement('h1');
    slide.append(element);
    Object.defineProperty(element, 'offsetParent', {
      configurable: true,
      value: parent
    });
    parent.getBoundingClientRect = () => measuredRect(0, 20, 1600, 900);
    slide.getBoundingClientRect = () => measuredRect(0, 60, 1600, 900);

    pinToAbsolute(element, rect(100, 30, 200, 50), slide);

    // The slide sits 40 px above its offset parent, so the inline top adds 40.
    expect(element.style.left).toBe('100px');
    expect(element.style.top).toBe('70px');
    expect(rectOf(element, slide)).toEqual(rect(100, 30, 200, 50));
  });
});

describe('rectOf', () => {
  it('prefers inline absolute geometry', () => {
    const slide = document.createElement('section');
    const element = document.createElement('div');
    element.style.position = 'absolute';
    element.style.left = '120px';
    element.style.top = '64px';
    element.style.width = '300px';
    element.style.height = '80px';
    slide.append(element);

    expect(rectOf(element, slide)).toEqual(rect(120, 64, 300, 80));
  });

  it('falls back to the measured box relative to the slide', () => {
    const slide = document.createElement('section');
    const element = document.createElement('h1');
    slide.append(element);
    element.getBoundingClientRect = () => measuredRect(140, 90, 200, 50);
    slide.getBoundingClientRect = () => measuredRect(40, 60, 1600, 900);

    expect(rectOf(element, slide)).toEqual(rect(100, 30, 200, 50));
  });

  it('ignores partial inline geometry and uses the measured box', () => {
    const slide = document.createElement('section');
    const element = document.createElement('div');
    element.style.position = 'absolute';
    element.style.left = '12px';
    element.style.top = '7px';
    slide.append(element);
    element.getBoundingClientRect = () => measuredRect(60, 80, 30, 40);
    slide.getBoundingClientRect = () => measuredRect(10, 20, 1600, 900);

    expect(rectOf(element, slide)).toEqual(rect(50, 60, 30, 40));
  });

  it('keeps fractional inline geometry', () => {
    const slide = document.createElement('section');
    const element = document.createElement('div');
    element.style.position = 'absolute';
    element.style.left = '136.986px';
    element.style.top = '68.493px';
    element.style.width = '1600px';
    element.style.height = '900px';
    slide.append(element);

    expect(rectOf(element, slide)).toEqual(
      rect(136.986, 68.493, 1600, 900)
    );
  });
});

describe('moveTargets', () => {
  it('offsets every target while preserving relative positions', () => {
    const first = document.createElement('div');
    const second = document.createElement('div');
    const targets = [
      target(first, rect(10, 20, 100, 50)),
      target(second, rect(200, 300, 40, 60))
    ];

    const moved = moveTargets(targets, { x: 30, y: -15 });

    expect(moved).toEqual([rect(40, 5, 100, 50), rect(230, 285, 40, 60)]);
    expect(moved[1]!.x - moved[0]!.x).toBe(190);
    expect(moved[1]!.y - moved[0]!.y).toBe(280);
    expect(first.style.left).toBe('');
    expect(second.style.left).toBe('');
  });

  it('supports negative deltas without clamping', () => {
    const element = document.createElement('div');
    const moved = moveTargets([target(element, rect(10, 10, 50, 50))], {
      x: -40,
      y: -25
    });

    expect(moved).toEqual([rect(-30, -15, 50, 50)]);
  });
});

describe('resizeTarget', () => {
  it('grows east without changing height', () => {
    const element = document.createElement('div');
    const result = resizeTarget(
      target(element, rect(100, 100, 200, 100)),
      'e',
      { x: 40, y: 25 },
      20
    );

    expect(result).toEqual(rect(100, 100, 240, 100));
  });

  it('moves the origin when resizing from the north-west corner', () => {
    const element = document.createElement('div');
    const result = resizeTarget(
      target(element, rect(100, 100, 200, 100)),
      'nw',
      { x: -30, y: -20 },
      20
    );

    expect(result).toEqual(rect(70, 80, 230, 120));
  });

  it('clamps at the minimum size', () => {
    const element = document.createElement('div');
    const result = resizeTarget(
      target(element, rect(100, 100, 30, 100)),
      'e',
      { x: -80, y: 0 },
      20
    );

    expect(result).toEqual(rect(100, 100, 20, 100));
  });
});

describe('rotation', () => {
  const center = { x: 200, y: 100 };

  it('maps the pointer angle around the center to zero at the top', () => {
    expect(rotationFromPointer(center, { x: 200, y: 40 })).toBe(0);
    expect(rotationFromPointer(center, { x: 260, y: 100 })).toBe(90);
    expect(rotationFromPointer(center, { x: 200, y: 160 })).toBe(180);
    expect(rotationFromPointer(center, { x: 140, y: 100 })).toBe(270);
  });

  it('snaps angles to 15 degree steps', () => {
    expect(snapAngle(0)).toBe(0);
    expect(snapAngle(7)).toBe(0);
    expect(snapAngle(8)).toBe(15);
    expect(snapAngle(37)).toBe(30);
    expect(snapAngle(38)).toBe(45);
    expect(snapAngle(353)).toBe(0);
  });

  it('computes the shortest signed delta across the wrap point', () => {
    expect(angleDelta(350, 10)).toBe(20);
    expect(angleDelta(10, 350)).toBe(-20);
    expect(angleDelta(0, 90)).toBe(90);
    expect(angleDelta(90, 0)).toBe(-90);
  });

  it('writes a normalized rotate transform and keeps the center', () => {
    const element = document.createElement('div');
    pinToAbsolute(element, rect(100, 50, 200, 100));

    applyRotation(element, 390);

    expect(element.style.transform).toBe('rotate(30deg)');
    expect(element.style.transformOrigin).toBe('50% 50%');
    expect(element.style.left).toBe('100px');
    expect(element.style.top).toBe('50px');
    expect(element.style.width).toBe('200px');
    expect(element.style.height).toBe('100px');
    expect(centerOf(rectOf(element, document.createElement('section')))).toEqual(
      { x: 200, y: 100 }
    );
  });

  it('reads the rotation back from the inline transform', () => {
    const element = document.createElement('div');
    expect(rotationOf(element)).toBe(0);

    element.style.transform = 'rotate(45deg)';
    expect(rotationOf(element)).toBe(45);

    element.style.transform = 'rotate(-90deg)';
    expect(rotationOf(element)).toBe(270);

    element.style.transform = 'translateX(10px)';
    expect(rotationOf(element)).toBe(0);
  });
});
