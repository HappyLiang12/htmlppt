import { detectSlides, type SlideInfo } from './detect.js';
import { defaultIdFactory, type IdFactory } from './ids.js';
import { normalizeDeck } from './normalize.js';
import { DeckMutationError, resolveTarget, type ElementTarget } from './target.js';
import type { Diagnostic } from './types.js';
import { validateDeck } from './validate.js';

export { DeckMutationError, resolveTarget };
export type { ElementTarget };

export type Transition = 'none' | 'fade' | 'slide';

const STYLE_PROPERTY = /^-?[a-zA-Z][a-zA-Z0-9-]*$/;
const CUSTOM_STYLE_PROPERTY = /^--[a-zA-Z0-9_-]+$/;
const TRANSITIONS = new Set<string>(['none', 'fade', 'slide']);
const NON_OBJECT_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META']);
const TEXT_NODE = 3;

function fail(code: string, message: string): never {
  throw new DeckMutationError(code, message);
}

function isStyleProperty(property: string): boolean {
  return STYLE_PROPERTY.test(property) || CUSTOM_STYLE_PROPERTY.test(property);
}

function hasNonWhitespaceText(container: Element): boolean {
  return Array.from(container.childNodes).some(
    (node) => node.nodeType === TEXT_NODE && Boolean(node.textContent?.trim())
  );
}

function assignElementId(slide: Element, element: Element): void {
  if (element.getAttribute('data-ppt-el')?.trim()) return;
  const used = new Set<string>();
  const slideRootId = slide.getAttribute('data-ppt-el')?.trim();
  if (slideRootId) used.add(slideRootId);
  for (const candidate of Array.from(slide.querySelectorAll('[data-ppt-el]'))) {
    const id = candidate.getAttribute('data-ppt-el')?.trim();
    if (id) used.add(id);
  }
  element.setAttribute('data-ppt-el', defaultIdFactory.elementId(used, 0));
}

export function setText(target: Element, text: string): void {
  target.textContent = text;
}

export function setStyle(
  target: Element,
  styles: Record<string, string | null>
): void {
  const entries = Object.entries(styles);
  for (const [property] of entries) {
    if (!isStyleProperty(property)) {
      fail('invalid-style-property', `"${property}" is not a valid CSS property name.`);
    }
  }
  const htmlTarget = target as HTMLElement;
  for (const [property, value] of entries) {
    if (value === null || value === '') htmlTarget.style.removeProperty(property);
    else htmlTarget.style.setProperty(property, value);
  }
  if (htmlTarget.getAttribute('style')?.trim() === '') {
    htmlTarget.removeAttribute('style');
  }
}

export function setElementHtml(target: Element, html: string): void {
  target.innerHTML = html;
}

export function addElement(
  slide: Element,
  html: string,
  after?: ElementTarget
): Element {
  const container = slide.ownerDocument.createElement('div');
  container.innerHTML = html;
  if (container.children.length !== 1 || hasNonWhitespaceText(container)) {
    fail(
      'invalid-fragment',
      'Element HTML must contain exactly one root element and no non-whitespace text.'
    );
  }
  const element = container.firstElementChild as Element;
  container.removeChild(element);
  const reference = after ? resolveTarget(slide, after) : null;
  if (reference === null) {
    slide.appendChild(element);
  } else {
    if (reference.parentElement !== slide) {
      fail('target-invalid', 'The insertion anchor must be a direct child of the slide.');
    }
    slide.insertBefore(element, reference.nextElementSibling);
  }
  if (!NON_OBJECT_TAGS.has(element.tagName)) assignElementId(slide, element);
  return element;
}

export function removeElement(target: Element): void {
  if (
    target === target.ownerDocument.body ||
    target.hasAttribute('data-slide-id') ||
    target.hasAttribute('data-ppt-deck')
  ) {
    fail('cannot-remove-slide', 'The slide itself cannot be removed.');
  }
  const parent = target.parentElement;
  if (!parent) fail('cannot-remove-slide', 'The slide itself cannot be removed.');
  parent.removeChild(target);
}

export function mutateDeck<T>(
  source: Document,
  mutation: (draft: Document) => T
): { document: Document; result: T } {
  const document = source.cloneNode(true) as Document;
  const result = mutation(document);
  normalizeDeck(document);
  const validation = validateDeck(document);
  if (!validation.valid) {
    throw new DeckMutationError(
      'invalid-result',
      `The mutation produced an invalid deck: ${validation.errors
        .map((error: Diagnostic) => error.code)
        .join(', ')}`,
      validation.errors
    );
  }
  return { document, result };
}

export function findSlide(doc: Document, slideId: string): SlideInfo {
  const slides = detectSlides(doc);
  const slide =
    slides.find((candidate) => candidate.id === slideId && candidate.hasId) ??
    (slideId === 'body'
      ? slides.find((candidate) => candidate.element === doc.body)
      : undefined);
  if (!slide) fail('slide-not-found', `Slide "${slideId}" was not found.`);
  return slide;
}

export interface AddSlideOptions {
  html?: string;
  afterSlideId?: string;
  notes?: string;
  transition?: Transition;
  width?: number;
  height?: number;
  ids?: IdFactory;
}

function explicitSlides(doc: Document): SlideInfo[] {
  const slides = detectSlides(doc);
  if (slides.length === 0 || (slides.length === 1 && slides[0].element === doc.body)) {
    fail('slide-operations-unavailable', 'Slide operations are unavailable on the body fallback.');
  }
  return slides;
}

function occupiedSlideIds(slides: SlideInfo[]): Set<string> {
  const existing = new Set<string>();
  for (const slide of slides) {
    existing.add(slide.id);
    const attribute = slide.element.getAttribute('data-slide-id')?.trim();
    if (attribute) existing.add(attribute);
  }
  return existing;
}

function appendNotes(slide: Element, notes: string, doc: Document): void {
  const aside = doc.createElement('aside');
  aside.setAttribute('data-ppt-notes', '');
  aside.setAttribute('hidden', '');
  aside.textContent = notes;
  slide.appendChild(aside);
}

export function addSlide(doc: Document, options: AddSlideOptions = {}): string {
  const slides = explicitSlides(doc);
  const ids = options.ids ?? defaultIdFactory;
  const id = ids.slideId(occupiedSlideIds(slides));
  const first = slides[0];
  const section = doc.createElement('section');
  section.setAttribute('class', 'slide');
  section.setAttribute('data-slide-id', id);
  if (options.width !== undefined || options.height !== undefined) {
    section.setAttribute('data-width', String(options.width ?? first.width));
    section.setAttribute('data-height', String(options.height ?? first.height));
  }
  if (options.transition) section.setAttribute('data-ppt-transition', options.transition);
  section.innerHTML = options.html ?? '<h1>New slide</h1>';
  for (const child of Array.from(section.children)) {
    if (!child.hasAttribute('data-ppt-notes') && !NON_OBJECT_TAGS.has(child.tagName)) {
      assignElementId(section, child);
    }
  }
  if (options.notes !== undefined && options.notes !== '') {
    appendNotes(section, options.notes, doc);
  }

  const reference = options.afterSlideId
    ? slides.find((slide) => slide.id === options.afterSlideId)?.element
    : slides[slides.length - 1].element;
  if (!reference) fail('slide-not-found', `Slide "${options.afterSlideId}" was not found.`);
  const parent = reference.parentElement;
  if (!parent) fail('slide-operations-unavailable', 'Slides must have a parent element.');
  parent.insertBefore(section, reference.nextElementSibling);
  return id;
}

export function duplicateSlide(doc: Document, slideId: string): string {
  const slides = explicitSlides(doc);
  const source = slides.find((slide) => slide.id === slideId);
  if (!source) fail('slide-not-found', `Slide "${slideId}" was not found.`);
  const id = defaultIdFactory.slideId(occupiedSlideIds(slides));
  const clone = source.element.cloneNode(true) as Element;
  clone.setAttribute('data-slide-id', id);
  const parent = source.element.parentElement;
  if (!parent) fail('slide-operations-unavailable', 'Slides must have a parent element.');
  parent.insertBefore(clone, source.element.nextElementSibling);
  return id;
}

export function deleteSlide(doc: Document, slideId: string): void {
  const slides = explicitSlides(doc);
  if (slides.length === 1) fail('last-slide', 'The last slide cannot be deleted.');
  const slide = slides.find((candidate) => candidate.id === slideId);
  if (!slide) fail('slide-not-found', `Slide "${slideId}" was not found.`);
  slide.element.parentElement?.removeChild(slide.element);
}

function reorder(doc: Document, ordered: Element[]): void {
  const current = explicitSlides(doc);
  const lastCurrent = current[current.length - 1].element;
  const parent = lastCurrent.parentElement;
  if (!parent) fail('slide-operations-unavailable', 'Slides must have a parent element.');
  // Anchor after every current slide, so no slide in `ordered` can move the
  // reference while the loop inserts.
  const anchor = lastCurrent.nextElementSibling;
  for (const element of ordered) {
    parent.insertBefore(element, anchor);
  }
}

export function moveSlide(doc: Document, slideId: string, toIndex: number): void {
  const slides = explicitSlides(doc);
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= slides.length) {
    fail('index-out-of-range', `Index ${toIndex} is outside 0..${slides.length - 1}.`);
  }
  const source = slides.find((slide) => slide.id === slideId);
  if (!source) fail('slide-not-found', `Slide "${slideId}" was not found.`);
  const ordered = slides
    .map((slide) => slide.element)
    .filter((element) => element !== source.element);
  ordered.splice(toIndex, 0, source.element);
  reorder(doc, ordered);
}

export function setSlideOrder(doc: Document, slideIds: string[]): void {
  const slides = explicitSlides(doc);
  const current = slides.map((slide) => slide.id);
  if (
    slideIds.length !== current.length ||
    new Set(slideIds).size !== current.length ||
    slideIds.some((id) => !current.includes(id))
  ) {
    fail('invalid-order', 'The new order must list every slide id exactly once.');
  }
  const ordered: Element[] = [];
  for (const id of slideIds) {
    const slide = slides.find((candidate) => candidate.id === id);
    if (!slide) fail('invalid-order', 'The new order must list every slide id exactly once.');
    ordered.push(slide.element);
  }
  reorder(doc, ordered);
}

export function updateSlideHtml(doc: Document, slideId: string, html: string): void {
  const slides = explicitSlides(doc);
  const slide = slides.find((candidate) => candidate.id === slideId);
  if (!slide) fail('slide-not-found', `Slide "${slideId}" was not found.`);
  slide.element.innerHTML = html;
}

export function setNotes(doc: Document, slideId: string, notes: string): void {
  const slide = findSlide(doc, slideId);
  let aside: Element | null = null;
  for (const child of Array.from(slide.element.children)) {
    if (child.hasAttribute('data-ppt-notes')) {
      aside = child;
      break;
    }
  }
  if (!notes) {
    if (aside) aside.parentElement?.removeChild(aside);
    return;
  }
  if (!aside) {
    aside = doc.createElement('aside');
    aside.setAttribute('data-ppt-notes', '');
    aside.setAttribute('hidden', '');
    slide.element.appendChild(aside);
  }
  aside.textContent = notes;
}

export function setTransition(doc: Document, slideId: string, transition: Transition): void {
  if (!TRANSITIONS.has(transition)) {
    fail('invalid-transition', `Transition "${transition}" is not one of none, fade, slide.`);
  }
  findSlide(doc, slideId).element.setAttribute('data-ppt-transition', transition);
}
