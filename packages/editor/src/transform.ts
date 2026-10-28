import {
  normalizeAngle,
  resizeRect,
  type Handle,
  type Point,
  type Rect
} from './geometry.js';

export interface TransformTarget {
  element: Element;
  /** Design-pixel rect captured when the gesture started. */
  start: Rect;
}

const PIXEL_VALUE = /^(-?(?:\d+|\d*\.\d+))px$/;

function pixels(value: number): string {
  return `${value}px`;
}

function parsePixels(value: string): number | null {
  const match = PIXEL_VALUE.exec(value.trim());
  return match?.[1] === undefined ? null : Number(match[1]);
}

function styleOf(element: Element): CSSStyleDeclaration | null {
  return (element as HTMLElement).style ?? null;
}

function inlineRect(element: Element, slide?: Element): Rect | null {
  const style = styleOf(element);
  if (!style) return null;
  if (style.position !== 'absolute' && style.position !== 'fixed') return null;

  const x = parsePixels(style.left);
  const y = parsePixels(style.top);
  const width = parsePixels(style.width);
  const height = parsePixels(style.height);
  if (x === null || y === null || width === null || height === null) {
    return null;
  }
  const offset = slide ? containingBlockOffset(element, slide) : { x: 0, y: 0 };
  return { x: x + offset.x, y: y + offset.y, width, height };
}

/**
 * Distance from the slide origin to the element's absolute containing block.
 * Authored slides are not always positioned, so `left`/`top` may be relative
 * to an ancestor of the slide; the editor stores geometry in slide pixels.
 */
export function containingBlockOffset(element: Element, slide: Element): Point {
  const parent = (element as HTMLElement).offsetParent;
  if (!parent || parent === slide) return { x: 0, y: 0 };
  const parentRect = parent.getBoundingClientRect();
  const slideRect = slide.getBoundingClientRect();
  return {
    x: parentRect.left - slideRect.left,
    y: parentRect.top - slideRect.top
  };
}

/**
 * Pins a flow element to absolute geometry. The rect is in design pixels
 * relative to the slide. Width/height are captured so later resize gestures
 * do not reflow against the authored layout.
 */
export function pinToAbsolute(
  element: Element,
  rect: Rect,
  slide?: Element
): void {
  const style = styleOf(element);
  if (!style) return;
  const offset = slide ? containingBlockOffset(element, slide) : { x: 0, y: 0 };
  style.position = 'absolute';
  style.left = pixels(rect.x - offset.x);
  style.top = pixels(rect.y - offset.y);
  style.width = pixels(rect.width);
  style.height = pixels(rect.height);
  style.margin = '0';
  style.boxSizing = 'border-box';
}

/** Updates the absolute geometry without touching the pinning styles. */
export function applyRect(
  element: Element,
  rect: Rect,
  slide?: Element
): void {
  const style = styleOf(element);
  if (!style) return;
  const offset = slide ? containingBlockOffset(element, slide) : { x: 0, y: 0 };
  style.left = pixels(rect.x - offset.x);
  style.top = pixels(rect.y - offset.y);
  style.width = pixels(rect.width);
  style.height = pixels(rect.height);
}

/**
 * Reads an element's design-pixel rect relative to its slide. Pinned elements
 * answer from their inline geometry; authored flow elements answer from their
 * measured box. Both measurements happen inside the iframe, whose CSS pixels
 * already are design pixels, so no scale division is needed here.
 */
export function rectOf(element: Element, slide: Element): Rect {
  const inline = inlineRect(element, slide);
  if (inline) return inline;

  const elementRect = element.getBoundingClientRect();
  const slideRect = slide.getBoundingClientRect();
  return {
    x: elementRect.left - slideRect.left,
    y: elementRect.top - slideRect.top,
    width: elementRect.width,
    height: elementRect.height
  };
}

/**
 * The affine coefficients Chromium's `SVGMatrix` exposes after
 * `getScreenCTM()?.inverse()`; unlike `DOMMatrix` it has no `transformPoint`.
 * `e`/`f` are declared for shape parity but never affect a delta.
 */
interface MatrixLike {
  a: number;
  b: number;
  c: number;
  d: number;
  e?: number;
  f?: number;
}

function svgInverseMatrix(element: Element): MatrixLike | null {
  const graphics = element as SVGGraphicsElement;
  const ctm = graphics.getScreenCTM?.();
  if (!ctm) return null;
  try {
    return ctm.inverse() as unknown as MatrixLike;
  } catch {
    // A singular CTM (for example scale(0)) has no inverse; keep the design
    // delta rather than breaking the pointer stream.
    return null;
  }
}

/**
 * Converts a design-pixel delta to the element's local SVG user units. The
 * inverse screen CTM's coefficients carry the local-to-screen scale and
 * rotation; its translation cancels for a delta, so only `a`/`b`/`c`/`d` matter. The local
 * delta is the space a post-multiplied translate acts in. A missing matrix
 * keeps the design delta so authored geometry still moves by the pointer
 * distance. Each axis is rounded to 3 decimals.
 */
export function svgUserDelta(element: Element, delta: Point): Point {
  const inverse = svgInverseMatrix(element);
  if (!inverse) return { x: delta.x, y: delta.y };
  return {
    x: Math.round((inverse.a * delta.x + inverse.c * delta.y) * 1000) / 1000,
    y: Math.round((inverse.b * delta.x + inverse.d * delta.y) * 1000) / 1000
  };
}

const MATRIX_2D = /^matrix\(\s*([^)]+)\)$/;

/**
 * Splits Chromium's serialized 2D matrix. The computed value is serialized
 * with about six significant digits, so comparisons need a tolerance.
 */
function matrixValues(value: string): number[] | null {
  const match = MATRIX_2D.exec(value);
  if (!match?.[1]) return null;
  const parts = match[1].split(',').map((part) => Number(part.trim()));
  return parts.length === 6 && parts.every(Number.isFinite) ? parts : null;
}

/**
 * The matrix the `transform` presentation attribute alone produces. Chromium's
 * `SVGGraphicsElement.transform` reflects the attribute, never a CSS
 * declaration, and jsdom does not implement it at all.
 */
function attributeMatrix(element: Element): number[] | null {
  const transform = (element as SVGGraphicsElement).transform?.baseVal;
  const matrix = transform?.consolidate()?.matrix;
  if (!matrix) return null;
  return [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f];
}

function sameMatrix(applied: readonly number[], authored: readonly number[]): boolean {
  return applied.every((value, index) => {
    const reference = authored[index] ?? 0;
    return Math.abs(value - reference) <= Math.max(1e-3, Math.abs(reference) * 1e-4);
  });
}

/**
 * True when CSS owns the element's transform, so the presentation attribute is
 * inert. An inline style always wins and is detected cheaply. A stylesheet
 * rule can also outrank the attribute while the attribute stays in the markup:
 * Chromium surfaces the winning transform in the computed value, and it
 * surfaces the attribute there too when no rule matches. CSS therefore owns
 * the transform only when the computed matrix differs from the matrix the
 * attribute alone produces. Any CSS transform on a shape without an attribute
 * is an override by definition; jsdom reports the declared rule here and an
 * empty computed value for an unstyled element (the same thing as `none`).
 */
export function svgCssTransformOverride(element: Element): boolean {
  const inline = styleOf(element)?.transform?.trim() ?? '';
  if (inline !== '') return true;
  const computed =
    element.ownerDocument.defaultView?.getComputedStyle(element).transform ?? '';
  if (computed.trim() === '' || computed === 'none') return false;
  const authored = attributeMatrix(element);
  if (!authored) return true;
  const applied = matrixValues(computed.trim());
  return applied === null || !sameMatrix(applied, authored);
}

/**
 * Post-multiplies a translate onto the authored transform captured at gesture
 * start. The delta arrives in the element's local user units (`svgUserDelta`),
 * and a trailing translate is applied in that same local space, so a rotated
 * or scaled shape follows the pointer. The authored transform is written back
 * verbatim, so repeated writes with the same capture keep exactly one
 * translate. An empty or `none` authored transform becomes just the translate.
 */
export function applySvgTranslate(
  element: Element,
  authoredTransform: string,
  delta: Point
): void {
  const translate = `translate(${delta.x} ${delta.y})`;
  const authored = authoredTransform.trim();
  const keepsAuthored = authored !== '' && authored.toLowerCase() !== 'none';
  element.setAttribute(
    'transform',
    keepsAuthored ? `${authored} ${translate}` : translate
  );
}

/**
 * Offsets all targets by the same delta, preserving relative offsets. Styling
 * is left to the caller so a gesture can snap first and pin once.
 */
export function moveTargets(
  targets: readonly TransformTarget[],
  delta: Point
): Rect[] {
  return targets.map((target) => ({
    ...target.start,
    x: target.start.x + delta.x,
    y: target.start.y + delta.y
  }));
}

/** Resizes from one handle using the shared geometry contract. */
export function resizeTarget(
  target: TransformTarget,
  handle: Handle,
  delta: Point,
  minSize: number
): Rect {
  return resizeRect(target.start, handle, { dx: delta.x, dy: delta.y }, minSize);
}

export function centerOf(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

const ROTATE = /rotate\(\s*(-?(?:\d+|\d*\.\d+))deg\s*\)/;

/** Reads the inline rotation in degrees; absent or foreign transforms are 0. */
export function rotationOf(element: Element): number {
  const transform = styleOf(element)?.transform ?? '';
  const match = ROTATE.exec(transform);
  return match?.[1] === undefined ? 0 : normalizeAngle(Number(match[1]));
}

/**
 * Writes `transform: rotate(Xdeg)` around the element center. Left/top/width/
 * height are untouched, so the measured center stays fixed.
 */
export function applyRotation(element: Element, degrees: number): void {
  const style = styleOf(element);
  if (!style) return;
  style.transformOrigin = '50% 50%';
  style.transform = `rotate(${normalizeAngle(degrees)}deg)`;
}

/**
 * Converts a pointer position around a center into a rotation where the top
 * of the element is 0 degrees (screen coordinates, y grows downward).
 */
export function rotationFromPointer(center: Point, point: Point): number {
  const radians = Math.atan2(point.y - center.y, point.x - center.x);
  return normalizeAngle((radians * 180) / Math.PI + 90);
}

/** Shortest signed delta in degrees, accounting for the 0/360 wrap. */
export function angleDelta(from: number, to: number): number {
  const delta = normalizeAngle(to - from);
  return delta > 180 ? delta - 360 : delta;
}

/** Snaps an angle to the nearest step (15 degrees by default). */
export function snapAngle(degrees: number, step = 15): number {
  return normalizeAngle(Math.round(degrees / step) * step);
}
