export interface SelectionTarget {
  slideIndex: number;
  path: number[];
  elementId: string | null;
}

export interface SelectionFromEventOptions {
  slideIndex?: number;
  /** Alt-click drills into the deepest element instead of its top-level object. */
  altKey?: boolean;
}

const NON_OBJECT_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META']);

function isObjectElement(element: Element): boolean {
  return (
    !NON_OBJECT_TAGS.has(element.tagName.toUpperCase()) &&
    !element.hasAttribute('data-ppt-notes')
  );
}

export function topLevelObjects(slide: Element): Element[] {
  return Array.from(slide.children).filter(isObjectElement);
}

/** Resolves a raw child-index path from the slide to its element. */
export function elementAtPath(
  root: Element,
  path: readonly number[]
): Element | null {
  let current: Element | null = root;
  for (const index of path) {
    if (!current) return null;
    current = current.children[index] ?? null;
  }
  return current;
}

function asElement(eventTarget: EventTarget | null): Element | null {
  if (!eventTarget) return null;
  const node = eventTarget as Node;
  return node.nodeType === 1 ? (node as Element) : null;
}

function elementIdOf(element: Element): string | null {
  const value = element.getAttribute('data-ppt-el')?.trim();
  return value ? value : null;
}

function topLevelAncestor(element: Element, slide: Element): Element | null {
  let current: Element = element;
  let parent = current.parentElement;
  while (parent && parent !== slide) {
    current = parent;
    parent = current.parentElement;
  }
  return parent === slide ? current : null;
}

function pathTo(element: Element, slide: Element): number[] | null {
  const path: number[] = [];
  let current: Element = element;
  while (current !== slide) {
    const parent = current.parentElement;
    if (!parent) return null;
    path.unshift(Array.from(parent.children).indexOf(current));
    current = parent;
  }
  return path;
}

export function selectionFromEvent(
  eventTarget: EventTarget | null,
  /** The iframe-rendered slide, in the same realm as the event target. */
  slide: Element,
  options: SelectionFromEventOptions = {}
): SelectionTarget | null {
  const element = asElement(eventTarget);
  if (!element || element === slide || !slide.contains(element)) return null;

  const slideIndex = options.slideIndex ?? 0;
  const top = topLevelAncestor(element, slide);
  if (!top || !isObjectElement(top)) return null;

  // Paths are always raw child indices from the slide. Excluded siblings
  // (notes, scripts) still occupy an index, so filtered object indices would
  // disagree with pathTo. See the plan interface note.
  const topIndex = Array.from(slide.children).indexOf(top);
  if (topIndex === -1) return null;

  if (options.altKey) {
    const path = pathTo(element, slide);
    if (!path || path[0] !== topIndex) return null;
    return { slideIndex, path, elementId: elementIdOf(element) };
  }

  return { slideIndex, path: [topIndex], elementId: elementIdOf(top) };
}
