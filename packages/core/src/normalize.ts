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

const NON_OBJECT_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META']);
const EDITOR_ATTRIBUTES = ['data-ppt-editing', 'data-ppt-frame-slide'];
const POSITION_PATTERN = /(?:^|;)\s*position\s*:/i;

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
  const slides = detectSlides(doc);
  const usedSlideIds = new Set(
    slides
      .map((slide) => slide.element.getAttribute('data-slide-id')?.trim())
      .filter((id): id is string => Boolean(id))
  );
  let changed = false;
  const normalized: NormalizedSlide[] = [];

  for (const slide of slides) {
    if (slide.element !== doc.body && !slide.hasId) {
      const id = ids.slideId(usedSlideIds);
      slide.element.setAttribute('data-slide-id', id);
      usedSlideIds.add(id);
      changed = true;
    }

    const objects = topLevelObjects(slide.element);
    const usedElementIds = new Set(
      Array.from(slide.element.querySelectorAll('[data-ppt-el]'))
        .map(objectId)
        .filter((id): id is string => id !== null)
    );
    const elementIds: string[] = [];
    for (const element of objects) {
      let id = objectId(element);
      if (!id) {
        id = ids.elementId(usedElementIds, slide.index);
        element.setAttribute('data-ppt-el', id);
        usedElementIds.add(id);
        changed = true;
      }
      elementIds.push(id);
    }

    if (
      slide.element !== doc.body &&
      options.isStaticPosition?.(slide.element)
    ) {
      changed = ensureRelativePosition(slide.element) || changed;
    }

    normalized.push({
      id:
        slide.element === doc.body
          ? 'body'
          : (slide.element.getAttribute('data-slide-id')?.trim() ?? ''),
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
