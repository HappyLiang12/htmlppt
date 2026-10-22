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
