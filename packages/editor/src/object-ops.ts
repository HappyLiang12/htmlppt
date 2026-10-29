import { detectSlides } from '@htmlppt/core';
import { isSvgInternal } from './component-target.js';
import {
  elementAtPath,
  topLevelObjects,
  type SelectionTarget
} from './selection.js';
import {
  applySvgTranslate,
  containingBlockOffset,
  rectOf,
  svgCssTransformOverride
} from './transform.js';

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
  /**
   * True when CSS owns an SVG-internal element's rendered transform and that
   * ownership is only visible in the live preview. The inert master document
   * sees inline styles alone, so this bridge keeps a stylesheet-transformed
   * copy inert instead of appending a translate that CSS would ignore.
   */
  cssTransformOwned?: boolean;
}

/**
 * Reads the rendered geometry of a pasted object. The editor master document
 * is inert, so class-positioned objects only have real coordinates in the live
 * preview; callers pass a reader bridged to that iframe. Nested pastes also
 * pass the destination parent path so the reader can measure the copy inside
 * the parent it will actually render in.
 */
export type PastedObjectMeasure = (
  element: Element,
  parentPath?: readonly number[]
) => PastedObjectGeometry | null;

/**
 * Shifts a pasted object by 20 design pixels on both axes. SVG content moves
 * through a post-multiplied transform because absolute geometry styles are
 * ignored there, unless CSS owns the transform: a css-transformed copy lands
 * on the source and gains no inert presentation attribute. Positioned objects
 * with finite inline pixel coordinates move those values; an axis without a
 * usable pixel value (unitless, percentage, auto, or a class-supplied
 * coordinate) falls back to the measured box so the copy lands 20 px
 * down-right of where it renders. Flow objects switch to relative positioning
 * so the offset applies without measuring the destination slide. Callers
 * insert the copy first so an svg it lives inside is visible.
 */
function offsetPastedObject(
  element: Element,
  slide: Element,
  measured: PastedObjectGeometry | null
): void {
  if (isSvgInternal(element)) {
    if (svgCssTransformOverride(element) || measured?.cssTransformOwned) return;
    applySvgTranslate(element, element.getAttribute('transform') ?? '', {
      x: 20,
      y: 20
    });
    return;
  }
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

/**
 * Copies a component into the master document without parsing markup, so an
 * svg shape keeps its namespace. The authored `id` is part of the saved
 * contract and is kept; only editor-owned `data-ppt-el` markers are refreshed,
 * and a node without one does not gain it.
 */
export function cloneComponent(
  element: Element,
  master: Document,
  nextId: () => string
): Element {
  const clone = master.importNode(element, true) as Element;
  if (clone.hasAttribute('data-ppt-el')) {
    clone.setAttribute('data-ppt-el', nextId());
  }
  for (const nested of Array.from(clone.querySelectorAll('[data-ppt-el]'))) {
    nested.setAttribute('data-ppt-el', nextId());
  }
  return clone;
}

/**
 * Removes the selected nested nodes in one mutation. Every path resolves
 * before the first removal so same-parent sibling indices cannot shift. Only
 * the topmost selected nodes are removed: a selected node whose ancestor is
 * also selected leaves with that ancestor and is not counted twice, so
 * [[0], [0, 0]] removes one subtree. The slide itself, unresolvable paths, and
 * duplicate paths are ignored.
 */
export function deleteComponentPaths(
  master: Document,
  slideIndex: number,
  paths: readonly (readonly number[])[]
): number {
  const slide = detectSlides(master)[slideIndex]?.element;
  if (!slide) return 0;

  const selected = new Set<Element>();
  for (const path of paths) {
    if (path.length === 0) continue;
    const element = elementAtPath(slide, path);
    if (element && element !== slide) selected.add(element);
  }
  let removed = 0;
  for (const element of selected) {
    let topmost = true;
    for (
      let ancestor = element.parentElement;
      ancestor && ancestor !== slide;
      ancestor = ancestor.parentElement
    ) {
      if (selected.has(ancestor)) {
        topmost = false;
        break;
      }
    }
    if (!topmost) continue;
    if (!element.parentElement) continue;
    element.parentElement.removeChild(element);
    removed += 1;
  }
  return removed;
}

/**
 * Pastes a copied nested component into its destination parent. `afterPath`
 * is slide-rooted; it only anchors the insert when it resolves to a direct
 * child of the destination parent, and any other case appends. The copy is
 * inserted before offsetting so svg content sees the svg it lives in, and the
 * optional measurement runs with the same parent path.
 */
export function pasteComponentNode(
  master: Document,
  slideIndex: number,
  node: Element,
  parentPath: readonly number[],
  afterPath: readonly number[] | null,
  measure?: PastedObjectMeasure
): SelectionTarget | null {
  const slide = detectSlides(master)[slideIndex]?.element;
  const parent = slide ? elementAtPath(slide, parentPath) : null;
  if (!slide || !parent) return null;

  const clone = cloneComponent(node, master, nextIdFactory(slide));
  const anchor = afterPath ? elementAtPath(slide, afterPath) : null;
  if (anchor && anchor.parentElement === parent) {
    parent.insertBefore(clone, anchor.nextSibling);
  } else {
    parent.appendChild(clone);
  }
  offsetPastedObject(clone, slide, measure?.(clone, parentPath) ?? null);
  return {
    slideIndex,
    path: [...parentPath, Array.from(parent.children).indexOf(clone)],
    elementId: elementIdOf(clone)
  };
}
