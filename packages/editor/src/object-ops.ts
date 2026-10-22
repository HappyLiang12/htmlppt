import { detectSlides } from '@htmlppt/core';
import {
  topLevelObjects,
  type SelectionTarget
} from './selection.js';
import { containingBlockOffset, rectOf } from './transform.js';

const PIXEL_VALUE = /^(-?(?:\d+|\d*\.\d+))px$/;

function parsePixels(value: string): number | null {
  const match = PIXEL_VALUE.exec(value.trim());
  return match?.[1] === undefined ? null : Number(match[1]);
}

export interface PastedObjectGeometry {
  /** Inline-space coordinates relative to the object's containing block. */
  x: number;
  y: number;
  /** Computed position in the rendered preview, including class rules. */
  position: string;
}

/**
 * Reads the rendered geometry of a pasted object. The editor master document
 * is inert, so class-positioned objects only have real coordinates in the live
 * preview; callers pass a reader bridged to that iframe.
 */
export type PastedObjectMeasure = (
  element: Element
) => PastedObjectGeometry | null;

/**
 * Shifts a pasted object by 20 design pixels on both axes. Positioned objects
 * with finite inline pixel coordinates move those values; an axis without a
 * usable pixel value (unitless, percentage, auto, or a class-supplied
 * coordinate) falls back to the measured box so the copy lands 20 px
 * down-right of where it renders. Flow objects switch to relative positioning
 * so the offset applies without measuring the destination slide.
 */
function offsetPastedObject(
  element: Element,
  slide: Element,
  measured: PastedObjectGeometry | null
): void {
  const style = (element as HTMLElement).style;
  if (!style) return;
  const position = measured?.position || style.position;
  if (
    position !== 'absolute' &&
    position !== 'fixed' &&
    position !== 'relative'
  ) {
    style.position = 'relative';
    style.left = '20px';
    style.top = '20px';
    return;
  }
  if (style.position !== position) {
    // A class positions the object; materialize it inline so the saved copy
    // keeps its placement independent of the authored class.
    style.position = position;
  }

  const left = parsePixels(style.left);
  const top = parsePixels(style.top);
  if (position === 'relative') {
    // Relative left/top are offsets from the normal position, so the measured
    // rect is an absolute coordinate rather than an offset. A missing authored
    // offset starts at zero; the copy still shifts by 20 px.
    style.left = `${(left ?? 0) + 20}px`;
    style.top = `${(top ?? 0) + 20}px`;
    return;
  }

  if (left !== null && top !== null) {
    style.left = `${left + 20}px`;
    style.top = `${top + 20}px`;
    return;
  }

  let origin = measured;
  if (!origin) {
    const rect = rectOf(element, slide);
    const block = containingBlockOffset(element, slide);
    origin = { x: rect.x - block.x, y: rect.y - block.y, position };
  }
  style.left = `${(left ?? origin.x) + 20}px`;
  style.top = `${(top ?? origin.y) + 20}px`;
}

function elementIdOf(element: Element): string | null {
  const value = element.getAttribute('data-ppt-el')?.trim();
  return value ? value : null;
}

/**
 * Serializes the selected top-level objects in document order. Nested
 * selections are read-only and contribute nothing; duplicate paths collapse.
 */
export function collectObjectHtml(
  slide: Element,
  paths: readonly (readonly number[])[]
): string[] {
  const objects = new Set(topLevelObjects(slide));
  const selected = new Set<Element>();
  for (const path of paths) {
    if (path.length !== 1) continue;
    const element = slide.children[path[0] ?? -1];
    if (element && objects.has(element)) selected.add(element);
  }
  return Array.from(slide.children)
    .filter((element) => selected.has(element))
    .map((element) => element.outerHTML);
}

function nextIdFactory(slide: Element): () => string {
  const existing = new Set(
    Array.from(slide.querySelectorAll('[data-ppt-el]'), (element) =>
      element.getAttribute('data-ppt-el')?.trim() ?? ''
    )
  );
  let next = 1;
  for (const id of existing) {
    const match = /^e(\d+)$/.exec(id);
    if (match?.[1]) next = Math.max(next, Number(match[1]) + 1);
  }
  return () => {
    while (existing.has(`e${next}`)) next += 1;
    const id = `e${next}`;
    next += 1;
    existing.add(id);
    return id;
  };
}

/**
 * Appends copies of the buffered top-level markup to a slide. Every pasted
 * `data-ppt-el` (including nested ones) gets a fresh per-slide id, and each
 * top-level object is offset by 20 px. Returns the new selections in paste
 * order; an unknown slide or empty buffer is a no-op.
 */
export function pasteObjectHtml(
  master: Document,
  slideIndex: number,
  html: readonly string[],
  measure?: PastedObjectMeasure
): SelectionTarget[] {
  const slide = detectSlides(master)[slideIndex]?.element;
  if (!slide || html.length === 0) return [];

  const nextId = nextIdFactory(slide);
  const targets: SelectionTarget[] = [];
  for (const source of html) {
    if (!source.trim()) continue;
    const container = master.createElement('div');
    container.innerHTML = source;
    const element = container.firstElementChild;
    if (!element) continue;

    const nestedIds = Array.from(element.querySelectorAll('[data-ppt-el]'));
    element.setAttribute('data-ppt-el', nextId());
    for (const nested of nestedIds) {
      nested.setAttribute('data-ppt-el', nextId());
    }
    slide.appendChild(element);
    offsetPastedObject(element, slide, measure?.(element) ?? null);

    targets.push({
      slideIndex,
      path: [Array.from(slide.children).indexOf(element)],
      elementId: elementIdOf(element)
    });
  }
  return targets;
}

/**
 * Removes the selected top-level objects in one mutation. Child references
 * keep multiple deletions safe from index shifts; nested selections are
 * read-only and ignored.
 */
export function deleteObjectPaths(
  master: Document,
  slideIndex: number,
  paths: readonly (readonly number[])[]
): number {
  const slide = detectSlides(master)[slideIndex]?.element;
  if (!slide) return 0;

  const objects = new Set(topLevelObjects(slide));
  const selected = new Set<Element>();
  for (const path of paths) {
    if (path.length !== 1) continue;
    const element = slide.children[path[0] ?? -1];
    if (element && objects.has(element)) selected.add(element);
  }
  for (const element of selected) {
    slide.removeChild(element);
  }
  return selected.size;
}
