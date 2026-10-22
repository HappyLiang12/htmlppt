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
  slide: Element,
  options: SelectionFromEventOptions = {}
): SelectionTarget | null {
  const element = asElement(eventTarget);
  if (!element || element === slide || !slide.contains(element)) return null;

  const slideIndex = options.slideIndex ?? 0;
  const top = topLevelAncestor(element, slide);
  if (!top) return null;

  const index = topLevelObjects(slide).indexOf(top);
  if (index === -1) return null;

  if (options.altKey) {
    const path = pathTo(element, slide);
    if (!path || path[0] !== index) return null;
    return { slideIndex, path, elementId: elementIdOf(element) };
  }

  return { slideIndex, path: [index], elementId: elementIdOf(top) };
}
