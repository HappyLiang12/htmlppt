import { detectSlides } from './detect.js';
import { defaultIdFactory, type IdFactory } from './ids.js';

export interface NormalizeOptions {
  ids?: IdFactory;
  /** Injected by a browser host; core itself cannot compute styles. */
  isStaticPosition?: (element: Element) => boolean;
}

export interface NormalizedSlide {
  id: string;
  elementIds: string[];
}

export interface NormalizeResult {
  changed: boolean;
  slides: NormalizedSlide[];
}

interface SlideRoot {
  element: Element;
  index: number;
  hasId: boolean;
}

const NON_OBJECT_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META']);
const EDITOR_ATTRIBUTES = ['data-ppt-editing', 'data-ppt-frame-slide'];
const POSITION_PATTERN = /(?:^|;)\s*position\s*:/i;
const SLIDE_MARKER_SELECTOR = '.slide, .page, .slide-page';

function hasSlideId(element: Element): boolean {
  return Boolean(element.getAttribute('data-slide-id')?.trim());
}

/**
 * detectSlides prefers id-bearing roots whenever any exist, which would skip
 * unlabelled classed siblings in a partially annotated deck. Normalization has
 * to cover every slide root, so id-driven results are widened to classed
 * siblings of the detected roots. Document order is restored from the DOM.
 */
function slideRoots(doc: Document): SlideRoot[] {
  const detected = detectSlides(doc);
  if (detected.length === 0) return [];
  if (detected.some((slide) => slide.element === doc.body)) {
    return detected.map((slide, index) => ({
      element: slide.element,
      index,
      hasId: slide.hasId
    }));
  }

  const elements = new Set(detected.map((slide) => slide.element));
  if (detected.some((slide) => slide.element.hasAttribute('data-slide-id'))) {
    const parents = new Set<Element>();
    for (const slide of detected) {
      const parent = slide.element.parentElement;
      if (parent) parents.add(parent);
    }
    for (const parent of parents) {
      for (const child of Array.from(parent.children)) {
        if (child.matches(SLIDE_MARKER_SELECTOR)) elements.add(child);
      }
    }
  }

  return Array.from(doc.querySelectorAll('*'))
    .filter((element) => elements.has(element))
    .map((element, index) => ({
      element,
      index,
      hasId: hasSlideId(element)
    }));
}

function isObject(element: Element): boolean {
  return (
    !NON_OBJECT_TAGS.has(element.tagName.toUpperCase()) &&
    !element.hasAttribute('data-ppt-notes')
  );
}

function topLevelObjects(slide: Element): Element[] {
  return Array.from(slide.children).filter(isObject);
}

function objectId(element: Element): string | null {
  const value = element.getAttribute('data-ppt-el')?.trim();
  return value ? value : null;
}

function ensureRelativePosition(element: Element): boolean {
  const style = element.getAttribute('style');
  if (style && POSITION_PATTERN.test(style)) return false;
  const trimmed = style?.trim() ?? '';
  element.setAttribute(
    'style',
    trimmed ? `${trimmed.replace(/;?$/, ';')} position: relative;` : 'position: relative;'
  );
  return true;
}

export function normalizeDeck(
  doc: Document,
  options: NormalizeOptions = {}
): NormalizeResult {
  const ids = options.ids ?? defaultIdFactory;
  const roots = slideRoots(doc);
  const usedSlideIds = new Set(
    roots
      .map((root) => root.element.getAttribute('data-slide-id')?.trim())
      .filter((id): id is string => Boolean(id))
  );
  let changed = false;
  const normalized: NormalizedSlide[] = [];

  for (const root of roots) {
    if (root.element !== doc.body && !root.hasId) {
      const id = ids.slideId(usedSlideIds);
      root.element.setAttribute('data-slide-id', id);
      usedSlideIds.add(id);
      changed = true;
    }

    const objects = topLevelObjects(root.element);
    const usedElementIds = new Set(
      objects.map(objectId).filter((id): id is string => id !== null)
    );
    const elementIds: string[] = [];
    for (const element of objects) {
      let id = objectId(element);
      if (!id) {
        id = ids.elementId(usedElementIds, root.index);
        element.setAttribute('data-ppt-el', id);
        usedElementIds.add(id);
        changed = true;
      }
      elementIds.push(id);
    }

    if (
      root.element !== doc.body &&
      options.isStaticPosition?.(root.element)
    ) {
      changed = ensureRelativePosition(root.element) || changed;
    }

    normalized.push({
      id: root.element.getAttribute('data-slide-id')?.trim() || 'body',
      elementIds
    });
  }

  for (const attribute of EDITOR_ATTRIBUTES) {
    for (const element of Array.from(doc.querySelectorAll(`[${attribute}]`))) {
      element.removeAttribute(attribute);
      changed = true;
    }
  }

  return { changed, slides: normalized };
}
