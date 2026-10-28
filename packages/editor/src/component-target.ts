import {
  isGuardedElement,
  isObjectElement,
  pathTo,
  SVG_NAMESPACE
} from './selection.js';

export interface ComputedComponentStyle {
  display: string;
  position: string;
}

export type ComponentStyleReader = (element: Element) => ComputedComponentStyle;

export interface ResolveComponentOptions {
  getStyle?: ComponentStyleReader;
}

const ATOMIC_TAGS = new Set(['SVG', 'IMG', 'CANVAS', 'VIDEO', 'IFRAME']);

function isChartFigure(element: Element): boolean {
  return (
    element.tagName.toUpperCase() === 'FIGURE' &&
    element.hasAttribute('data-ppt-chart')
  );
}

export function readComputedStyle(element: Element): ComputedComponentStyle {
  const view = element.ownerDocument.defaultView;
  const style = view?.getComputedStyle(element);
  return {
    display: style?.display ?? 'block',
    position: style?.position ?? 'static'
  };
}

/**
 * True for a shape inside an svg and for an svg nested inside another svg,
 * false for the top-level svg root an author places in HTML content and for
 * HTML content itself. A nested svg root is SVG content: absolute geometry
 * styles are ignored there, so it moves through its transform like a shape.
 */
export function isSvgInternal(element: Element): boolean {
  if (element.namespaceURI !== SVG_NAMESPACE) return false;
  if (element.closest('svg') !== element) return true;
  return element.parentElement?.namespaceURI === SVG_NAMESPACE;
}

/** True for a cell or row inside a table, false for the table itself. */
export function isTableInternal(element: Element): boolean {
  const table = element.closest('table');
  return table !== null && table !== element;
}

function guardedAncestor(slide: Element, target: Element): Element | null {
  for (
    let current: Element | null = target;
    current && current !== slide;
    current = current.parentElement
  ) {
    if (isGuardedElement(current)) return current;
  }
  return null;
}

/**
 * Finds the atomic scope above the target, if any. Walking for chart figures
 * first is what keeps a `figure[data-ppt-chart]` atomic: its svg sits closer to
 * the target, but the chart card owns the data contract and must win. An svg
 * root is atomic for a normal click even when an authored style makes an inner
 * shape block-level, so it is hoisted out of the display walk as well.
 */
function atomicScope(slide: Element, target: Element): Element | null {
  let svg: Element | null = null;
  for (
    let current: Element | null = target;
    current && current !== slide;
    current = current.parentElement
  ) {
    if (isChartFigure(current)) return current;
    if (
      !svg &&
      current.namespaceURI === SVG_NAMESPACE &&
      current.tagName.toUpperCase() === 'SVG'
    ) {
      svg = current;
    }
  }
  return svg;
}

export function resolveComponent(
  slide: Element,
  target: Element,
  options: ResolveComponentOptions = {}
): Element | null {
  if (target === slide || !slide.contains(target)) return null;
  if (!isObjectElement(target)) return null;
  const guard = guardedAncestor(slide, target);
  if (guard) return guard;
  const scope = atomicScope(slide, target);
  if (scope) return scope;
  const getStyle = options.getStyle ?? readComputedStyle;
  for (
    let current: Element | null = target;
    current && current !== slide;
    current = current.parentElement
  ) {
    const tag = current.tagName.toUpperCase();
    // svg and chart figures resolved into the scope above; the remaining
    // atomic widgets are leaves that the upward walk meets before any block
    // ancestor.
    if (ATOMIC_TAGS.has(tag)) return current;
    const style = getStyle(current);
    if (style.display !== 'inline' && style.display !== 'contents') {
      return current;
    }
    if (style.position === 'absolute' || style.position === 'fixed') {
      return current;
    }
  }
  return null;
}

export function componentPath(
  slide: Element,
  element: Element
): number[] | null {
  return pathTo(element, slide);
}

export function componentLabel(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const first = element.getAttribute('class')?.trim().split(/\s+/)[0];
  return first ? `${tag}.${first}` : tag;
}

function isPrefix(
  prefix: readonly number[],
  path: readonly number[]
): boolean {
  return (
    prefix.length < path.length &&
    prefix.every((value, index) => value === path[index])
  );
}

/**
 * Collapses a multi-selection to the highest selected node per subtree so a
 * drag never applies twice to the same element. Adding an ancestor replaces
 * its selected descendants; adding a descendant below a selected ancestor is
 * dropped. Unrelated paths keep their order and duplicates are ignored.
 */
export function normalizeSelectionPaths(
  paths: readonly (readonly number[])[]
): number[][] {
  const kept: number[][] = [];
  for (const path of paths) {
    const key = path.join('.');
    if (kept.some((candidate) => candidate.join('.') === key)) continue;
    for (let index = kept.length - 1; index >= 0; index -= 1) {
      const candidate = kept[index];
      if (candidate && isPrefix(path, candidate)) kept.splice(index, 1);
    }
    if (kept.some((candidate) => isPrefix(candidate, path))) continue;
    kept.push([...path]);
  }
  return kept;
}
