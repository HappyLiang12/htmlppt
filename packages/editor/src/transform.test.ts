import { describe, expect, it, vi } from 'vitest';
import type { Rect } from './geometry.js';
import {
  angleDelta,
  applyRotation,
  applySvgTranslate,
  centerOf,
  moveTargets,
  pinToAbsolute,
  rectOf,
  resizeTarget,
  rotationFromPointer,
  rotationOf,
  snapAngle,
  svgCssTransformOverride,
  svgUserDelta,
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

/**
 * The plain coefficient shape Chromium's `getScreenCTM().inverse()` really
 * returns; it has no `transformPoint`.
 */
interface ScreenMatrixCoefficients {
  a: number;
  b: number;
  c: number;
  d: number;
  e?: number;
  f?: number;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgShape(tag = 'circle'): { svg: SVGSVGElement; shape: Element } {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const shape = document.createElementNS(SVG_NS, tag);
  svg.appendChild(shape);
  document.body.appendChild(svg);
  return { svg, shape };
}

function stubScreenCtm(
  element: Element,
  inverse: ScreenMatrixCoefficients
): void {
  (element as unknown as { getScreenCTM: () => { inverse(): unknown } })
    .getScreenCTM = () => ({ inverse: () => inverse });
}

/**
 * A screen matrix stub that exposes the raw coefficients Chromium's
 * `DOMMatrix` reports and a separate `inverse()`. A nested svg root maps
 * through its parent's raw matrix, while shapes read the inverse.
 */
function stubRawScreenCtm(
  element: Element,
  matrix: ScreenMatrixCoefficients,
  inverse: ScreenMatrixCoefficients = matrix
): void {
  (
    element as unknown as {
      getScreenCTM: () => ScreenMatrixCoefficients & { inverse(): unknown };
    }
  ).getScreenCTM = () => ({ ...matrix, inverse: () => inverse });
}

/** The consolidated authored attribute matrix, or null when absent. */
function stubAttributeMatrix(
  element: Element,
  matrix: ScreenMatrixCoefficients | null
): void {
  Object.defineProperty(element, 'transform', {
    configurable: true,
    value: {
      baseVal: { consolidate: () => (matrix ? { matrix } : null) }
    }
  });
}

function nestedSvgPair(): { outer: SVGSVGElement; inner: SVGSVGElement } {
  const outer = document.createElementNS(SVG_NS, 'svg');
  const inner = document.createElementNS(SVG_NS, 'svg');
  outer.appendChild(inner);
  document.body.appendChild(outer);
  return { outer, inner };
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

describe('svgUserDelta', () => {
  it('converts a design delta through the inverse matrix coefficients', () => {
    const { svg, shape } = svgShape();
    stubScreenCtm(shape, { a: 0.5, b: 0, c: 0, d: 0.5, e: 10, f: 20 });

    expect(svgUserDelta(shape, { x: 40, y: 20 })).toEqual({ x: 20, y: 10 });

    svg.remove();
  });

  it('composes rotation and scale through the inverse matrix', () => {
    const { svg, shape } = svgShape();
    stubScreenCtm(shape, { a: 0, b: -1, c: 1, d: 0, e: 0, f: 0 });

    expect(svgUserDelta(shape, { x: 10, y: 0 })).toEqual({ x: 0, y: -10 });

    svg.remove();
  });

  it('composes an anisotropic rotation and scale', () => {
    const { svg, shape } = svgShape();
    stubScreenCtm(shape, { a: 0.5, b: -0.5, c: 0.5, d: 0.5 });

    expect(svgUserDelta(shape, { x: 10, y: 20 })).toEqual({ x: 15, y: 5 });

    svg.remove();
  });

  it('keeps a zero delta at zero', () => {
    const { svg, shape } = svgShape();
    stubScreenCtm(shape, { a: 0.5, b: -0.5, c: 0.5, d: 0.5 });

    expect(svgUserDelta(shape, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });

    svg.remove();
  });

  it('maps a nested svg root through its parent space, not its own viewport', () => {
    const { outer, inner } = nestedSvgPair();
    // The inner viewport maps 100 px onto 50 user units, so using its own CTM
    // would halve the delta. The attribute applies in the parent space.
    stubRawScreenCtm(
      inner,
      { a: 2, b: 0, c: 0, d: 2 },
      { a: 0.5, b: 0, c: 0, d: 0.5 }
    );
    stubRawScreenCtm(outer, { a: 1, b: 0, c: 0, d: 1 });
    stubAttributeMatrix(inner, { a: 1, b: 0, c: 0, d: 1 });

    expect(svgUserDelta(inner, { x: 10, y: 20 })).toEqual({ x: 10, y: 20 });

    outer.remove();
  });

  it('applies the authored rotation before the parent space for a nested svg', () => {
    const { outer, inner } = nestedSvgPair();
    stubRawScreenCtm(inner, { a: 2, b: 0, c: 0, d: 2 });
    stubRawScreenCtm(outer, { a: 1, b: 0, c: 0, d: 1 });
    stubAttributeMatrix(inner, { a: 0, b: 1, c: -1, d: 0 });

    // P * A = rotate(90), whose inverse maps (10, 0) to (0, -10).
    expect(svgUserDelta(inner, { x: 10, y: 0 })).toEqual({ x: 0, y: -10 });

    outer.remove();
  });

  it('keeps the design delta when a nested svg authored matrix is singular', () => {
    const { outer, inner } = nestedSvgPair();
    stubRawScreenCtm(outer, { a: 1, b: 0, c: 0, d: 1 });
    stubAttributeMatrix(inner, { a: 0, b: 0, c: 0, d: 0 });
    (inner as unknown as { getScreenCTM: () => null }).getScreenCTM = () => null;

    expect(svgUserDelta(inner, { x: 10, y: 20 })).toEqual({ x: 10, y: 20 });

    outer.remove();
  });

  it('keeps the element CTM fallback for a top-level svg in HTML', () => {
    const host = document.createElement('div');
    const svg = document.createElementNS(SVG_NS, 'svg');
    host.appendChild(svg);
    document.body.appendChild(host);
    stubScreenCtm(svg, { a: 0.5, b: 0, c: 0, d: 0.5 });

    expect(svgUserDelta(svg, { x: 10, y: 20 })).toEqual({ x: 5, y: 10 });

    host.remove();
  });

  it('falls back to the design delta when the CTM cannot be inverted', () => {
    const { svg, shape } = svgShape();
    (shape as unknown as { getScreenCTM: () => unknown }).getScreenCTM = () => ({
      inverse: () => {
        throw new DOMException('singular', 'InvalidStateError');
      }
    });

    expect(svgUserDelta(shape, { x: 40, y: 20 })).toEqual({ x: 40, y: 20 });

    svg.remove();
  });

  it('falls back to the design delta when the screen CTM is missing', () => {
    const { svg, shape } = svgShape();

    expect(svgUserDelta(shape, { x: 40, y: 20 })).toEqual({ x: 40, y: 20 });

    svg.remove();
  });

  it('falls back to the design delta when the screen CTM is null', () => {
    const { svg, shape } = svgShape();
    (shape as unknown as { getScreenCTM: () => null }).getScreenCTM = () => null;

    expect(svgUserDelta(shape, { x: 40, y: 20 })).toEqual({ x: 40, y: 20 });

    svg.remove();
  });

  it('rounds converted deltas to three decimals', () => {
    const { svg, shape } = svgShape();
    stubScreenCtm(shape, { a: 1 / 3, b: 0, c: 0, d: 1 / 3 });

    expect(svgUserDelta(shape, { x: 10, y: 20 })).toEqual({
      x: 3.333,
      y: 6.667
    });

    svg.remove();
  });

  it('rounds negative converted deltas to three decimals', () => {
    const { svg, shape } = svgShape();
    stubScreenCtm(shape, { a: 1 / 3, b: 0, c: 0, d: 1 / 3 });

    expect(svgUserDelta(shape, { x: -10, y: -20 })).toEqual({
      x: -3.333,
      y: -6.667
    });

    svg.remove();
  });
});

describe('applySvgTranslate', () => {
  it('writes only a translate when no transform is authored', () => {
    const shape = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'circle'
    );

    applySvgTranslate(shape, '', { x: 20, y: 10 });

    expect(shape.getAttribute('transform')).toBe('translate(20 10)');
  });

  it('treats a whitespace authored transform as empty', () => {
    const shape = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'circle'
    );

    applySvgTranslate(shape, '   ', { x: 20, y: 10 });

    expect(shape.getAttribute('transform')).toBe('translate(20 10)');
  });

  it('treats an authored none as empty', () => {
    const shape = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'circle'
    );

    applySvgTranslate(shape, 'none', { x: 20, y: 10 });

    expect(shape.getAttribute('transform')).toBe('translate(20 10)');
  });

  it('treats a padded, differently cased none as empty', () => {
    const shape = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'circle'
    );

    applySvgTranslate(shape, '  NONE  ', { x: 20, y: 10 });

    expect(shape.getAttribute('transform')).toBe('translate(20 10)');
  });

  it('post-multiplies the translate so the authored transform is preserved', () => {
    const shape = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'circle'
    );

    applySvgTranslate(shape, 'rotate(45 12 12)', { x: 20, y: 10 });

    expect(shape.getAttribute('transform')).toBe(
      'rotate(45 12 12) translate(20 10)'
    );
  });

  it('keeps exactly one translate across repeated writes', () => {
    const shape = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'circle'
    );
    const authored = 'rotate(45 12 12)';

    applySvgTranslate(shape, authored, { x: 5, y: 5 });
    applySvgTranslate(shape, authored, { x: 10, y: 8 });

    const written = shape.getAttribute('transform') ?? '';
    expect(written).toBe('rotate(45 12 12) translate(10 8)');
    expect(written.match(/translate\(/g)?.length).toBe(1);
  });
});

describe('svgCssTransformOverride', () => {
  it('reports an inline style transform as an override', () => {
    const { svg, shape } = svgShape();
    (shape as SVGElement).setAttribute('style', 'transform: rotate(45deg)');

    expect(svgCssTransformOverride(shape)).toBe(true);

    svg.remove();
  });

  it('keeps the presentation attribute authoritative when unopposed', () => {
    const { svg, shape } = svgShape();
    shape.setAttribute('transform', 'translate(10 10)');

    expect(svgCssTransformOverride(shape)).toBe(false);

    svg.remove();
  });

  it('reports no override when neither source declares a transform', () => {
    const { svg, shape } = svgShape();

    expect(svgCssTransformOverride(shape)).toBe(false);

    svg.remove();
  });

  it('reports an inline style even when the attribute says none', () => {
    const { svg, shape } = svgShape();
    shape.setAttribute('transform', 'none');
    (shape as SVGElement).setAttribute('style', 'transform: rotate(45deg)');

    expect(svgCssTransformOverride(shape)).toBe(true);

    svg.remove();
  });

  it('treats a stylesheet transform:none over an authored attribute as attribute-owned', () => {
    const { svg, shape } = svgShape();
    shape.setAttribute('transform', 'translate(10 10)');
    stubAttributeMatrix(shape, { a: 1, b: 0, c: 0, d: 1, e: 10, f: 10 });
    const computed = vi
      .spyOn(window, 'getComputedStyle')
      .mockReturnValue({
        transform: 'none'
      } as CSSStyleDeclaration);

    // A stylesheet `none` really outranks the attribute, but the computed value
    // cannot be told apart from "no CSS transform"; documented residual.
    expect(svgCssTransformOverride(shape)).toBe(false);

    computed.mockRestore();
    svg.remove();
  });

  it('reports a matrix3d computed transform as an override', () => {
    const { svg, shape } = svgShape();
    shape.setAttribute('transform', 'translate(10 10)');
    stubAttributeMatrix(shape, { a: 1, b: 0, c: 0, d: 1, e: 10, f: 10 });
    const computed = vi
      .spyOn(window, 'getComputedStyle')
      .mockReturnValue({
        transform:
          'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)'
      } as CSSStyleDeclaration);

    expect(svgCssTransformOverride(shape)).toBe(true);

    computed.mockRestore();
    svg.remove();
  });

  it('tolerates six-significant-digit rounding against an exact authored matrix', () => {
    const { svg, shape } = svgShape();
    shape.setAttribute('transform', 'rotate(20)');
    const radians = (20 * Math.PI) / 180;
    stubAttributeMatrix(shape, {
      a: Math.cos(radians),
      b: Math.sin(radians),
      c: -Math.sin(radians),
      d: Math.cos(radians),
      e: 0,
      f: 0
    });
    const computed = vi
      .spyOn(window, 'getComputedStyle')
      .mockReturnValue({
        transform: 'matrix(0.939693, 0.34202, -0.34202, 0.939693, 0, 0)'
      } as CSSStyleDeclaration);

    // Chromium serializes to about six significant digits; exact equality
    // would report a false override.
    expect(svgCssTransformOverride(shape)).toBe(false);

    computed.mockRestore();
    svg.remove();
  });

  it('reports a stylesheet rule that outranks the presentation attribute', () => {
    const style = document.createElement('style');
    style.textContent = '.svg-css-override-probe { transform: rotate(20deg); }';
    document.head.appendChild(style);
    const { svg, shape } = svgShape();
    shape.setAttribute('class', 'svg-css-override-probe');
    shape.setAttribute('transform', 'translate(2 2)');

    expect(svgCssTransformOverride(shape)).toBe(true);

    svg.remove();
    style.remove();
  });

  it('keeps the attribute authoritative when the computed matrix is its own', () => {
    const { svg, shape } = svgShape();
    shape.setAttribute('transform', 'translate(10 10)');
    Object.defineProperty(shape, 'transform', {
      configurable: true,
      value: {
        baseVal: {
          consolidate: () => ({
            matrix: { a: 1, b: 0, c: 0, d: 1, e: 10, f: 10 }
          })
        }
      }
    });
    const computed = vi
      .spyOn(window, 'getComputedStyle')
      .mockReturnValue({
        transform: 'matrix(1, 0, 0, 1, 10, 10)'
      } as CSSStyleDeclaration);

    // Chromium surfaces the presentation attribute in the computed style, so
    // an equal matrix is not a CSS override.
    expect(svgCssTransformOverride(shape)).toBe(false);

    computed.mockRestore();
    svg.remove();
  });

  it('reports a computed matrix that differs from the attribute', () => {
    const { svg, shape } = svgShape();
    shape.setAttribute('transform', 'translate(10 10)');
    Object.defineProperty(shape, 'transform', {
      configurable: true,
      value: {
        baseVal: {
          consolidate: () => ({
            matrix: { a: 1, b: 0, c: 0, d: 1, e: 10, f: 10 }
          })
        }
      }
    });
    const computed = vi
      .spyOn(window, 'getComputedStyle')
      .mockReturnValue({
        transform: 'matrix(0.939693, 0.34202, -0.34202, 0.939693, 0, 0)'
      } as CSSStyleDeclaration);

    expect(svgCssTransformOverride(shape)).toBe(true);

    computed.mockRestore();
    svg.remove();
  });
});
