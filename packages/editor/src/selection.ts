export interface SelectionTarget {
  slideIndex: number;
  path: number[];
  elementId: string | null;
}

export interface SelectionFromEventOptions {
  slideIndex?: number;
  /** Alt-click drills into the deepest element instead of its top-level object. */
  altKey?: boolean;
  /** Entered container path; clicks select that container's direct children. */
  containerPath?: readonly number[];
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

function ancestorWithin(element: Element, container: Element): Element | null {
  let current: Element = element;
  let parent = current.parentElement;
  while (parent && parent !== container) {
    current = parent;
    parent = current.parentElement;
  }
  return parent === container ? current : null;
}

/**
 * Returns the context path entered by a double-click on a container inside the
 * current context, or null when the target is a leaf or not enterable.
 */
export function contextEntry(
  slide: Element,
  target: Element,
  containerPath: readonly number[]
): number[] | null {
  const container = elementAtPath(slide, containerPath);
  if (!container || !container.contains(target) || target === container) {
    return null;
  }
  if (!isObjectElement(target) || target.children.length === 0) return null;
  const relative = pathTo(target, container);
  return relative ? [...containerPath, ...relative] : null;
}

/** Names a breadcrumb segment by its first class, then by its tag. */
export function describeContextSegment(element: Element): string {
  const firstClass = element.getAttribute('class')?.trim().split(/\s+/)[0];
  return firstClass ? `.${firstClass}` : element.tagName.toLowerCase();
}

function pathTo(element: Element, root: Element): number[] | null {
  const path: number[] = [];
  let current: Element = element;
  while (current !== root) {
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
  const containerPath = options.containerPath ?? [];
  const container = elementAtPath(slide, containerPath);
  if (!container || !container.contains(element) || element === container) {
    return null;
  }

  // Paths are always raw child indices from the slide. Excluded siblings
  // (notes, scripts) still occupy an index, so filtered object indices would
  // disagree with pathTo. See the plan interface note.
  const contextChild = ancestorWithin(element, container);
  if (!contextChild || !isObjectElement(contextChild)) return null;
  const index = Array.from(container.children).indexOf(contextChild);
  if (index === -1) return null;

  if (options.altKey) {
    const relative = pathTo(element, container);
    if (!relative) return null;
    return {
      slideIndex,
      path: [...containerPath, ...relative],
      elementId: elementIdOf(element)
    };
  }

  return {
    slideIndex,
    path: [...containerPath, index],
    elementId: elementIdOf(contextChild)
  };
}
